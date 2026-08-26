import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DatabaseService } from '../../database/database.service';
import { RideService } from '../sri/services/ride.service';
import { SriRepositoryService } from '../sri/services/sri-repository.service';
import { XmlStorageService } from '../sri/services/xml-storage.service';
import { EmailJobData } from './email.processor';

const TIPO_COMPROBANTE_DESCRIPCIONES: Record<string, string> = {
  '01': 'Factura',
  '04': 'Nota de Crédito',
  '05': 'Nota de Débito',
  '06': 'Guía de Remisión',
  '07': 'Comprobante de Retención',
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly configService: ConfigService,
    private readonly rideService: RideService,
    private readonly repository: SriRepositoryService,
    private readonly xmlStorage: XmlStorageService,
    @InjectQueue('email-dispatch') private readonly emailQueue: Queue,
  ) {}

  // ==========================================
  // EVENT LISTENER — Trigger automático
  // ==========================================

  @OnEvent('comprobante.autorizado')
  async handleComprobanteAutorizado(payload: {
    emisorId?: string;
    claveAcceso: string;
    tipoComprobante: string;
    secuencial: string;
    fechaAutorizacion?: string;
    numeroAutorizacion?: string;
  }) {
    const enabled = this.configService.get<boolean>('email.enabled');
    if (!enabled) {
      this.logger.debug(
        'Email automático deshabilitado (EMAIL_ENABLED=false). No se encola.',
      );
      return;
    }

    const apiKey = this.configService.get<string>('email.resendApiKey');
    if (!apiKey || apiKey === 're_xxxxxxxxxxxx') {
      this.logger.warn(
        'RESEND_API_KEY no configurada. No se encola el email automático.',
      );
      return;
    }

    this.logger.log(
      `Evento comprobante.autorizado recibido — encolando email para ${payload.claveAcceso}`,
    );

    const jobData: EmailJobData = {
      claveAcceso: payload.claveAcceso,
      emisorId: payload.emisorId,
      trigger: 'auto',
    };

    await this.emailQueue.add('send-ride', jobData);
  }

  // ==========================================
  // ENVÍO — Lógica principal (llamada por el processor)
  // ==========================================

  /**
   * Genera el RIDE PDF con barcode, construye el email HTML y lo envía
   * vía Resend API. Registra el resultado en email_logs.
   */
  async sendRideEmail(
    claveAcceso: string,
    overrideTo?: string,
    overrideSubject?: string,
  ): Promise<{ success: boolean; resendId?: string; error?: string }> {
    const startTime = Date.now();

    // 1. Obtener datos del comprobante desde la BD
    const comprobante = await this.db.queryOne<{
      receptor_email: string | null;
      receptor_razon_social: string | null;
      tipo_comprobante: string;
      secuencia: string;
      clave_acceso: string;
      numero_autorizacion: string | null;
      fecha_autorizacion: string | null;
      estado: string;
    }>(
      `SELECT c.receptor_email, c.receptor_razon_social, c.tipo_comprobante,
              c.secuencial, c.clave_acceso, c.numero_autorizacion,
              c.fecha_autorizacion, c.estado,
              e.razon_social as razon_social_emisor
       FROM comprobantes c
       LEFT JOIN emisores e ON c.emisor_id = e.id
       WHERE c.clave_acceso = $1`,
      [claveAcceso],
    );

    if (!comprobante) {
      throw new NotFoundException(
        `Comprobante con clave ${claveAcceso} no encontrado`,
      );
    }

    const to = overrideTo || comprobante.receptor_email;
    if (!to) {
      this.logger.warn(
        `No se puede enviar email: receptor_email vacío para ${claveAcceso}`,
      );
      return { success: false, error: 'No hay email de destinatario' };
    }

    // 2. Generar RIDE PDF (el barcode ya viene embebido en el HTML como
    // data:image/png;base64,{d.barcodeImage} — Carbone lo renderiza como <img>)
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = Buffer.from(
        await this.rideService.generarRide(claveAcceso),
      );
    } catch (err) {
      this.logger.error(
        `Error generando RIDE: ${(err as Error).message}`,
      );
      return { success: false, error: 'Error generando RIDE PDF' };
    }

    // 3. Construir el email
    const tipoDesc =
      TIPO_COMPROBANTE_DESCRIPCIONES[comprobante.tipo_comprobante] ||
      'Comprobante';
    const fromName =
      this.configService.get<string>('email.fromName') ||
      'Open API Facturación SRI';
    const fromEmail = this.configService.get<string>('email.from') || '';
    const emisorNombre = (comprobante as any).razon_social_emisor || fromName;

    const subject =
      overrideSubject ||
      `${tipoDesc} autorizada - ${claveAcceso.substring(0, 10)}...`;

    const html = this.buildEmailHtml({
      emisorNombre,
      receptorNombre: comprobante.receptor_razon_social || 'Cliente',
      tipoComprobante: tipoDesc,
      claveAcceso,
      numeroAutorizacion: comprobante.numero_autorizacion,
      fechaAutorizacion: comprobante.fecha_autorizacion,
      estado: comprobante.estado,
    });

    // 4. Enviar vía Resend API
    const apiKey = this.configService.get<string>('email.resendApiKey');
    if (!apiKey) {
      return { success: false, error: 'RESEND_API_KEY no configurada' };
    }

    try {
      const attachments: Array<{ filename: string; content: string }> = [
        {
          filename: `RIDE_${claveAcceso}.pdf`,
          content: pdfBuffer.toString('base64'),
        },
      ];

      const xmlAutorizadoAdjunto = await this.loadXmlAutorizadoAdjunto(claveAcceso);
      if (xmlAutorizadoAdjunto) {
        attachments.push(xmlAutorizadoAdjunto);
      }

      this.logger.log(
        `Email a ${to}: ${attachments.length} adjunto(s) — ${attachments.map((a) => a.filename).join(', ')}`,
      );

      const response = await axios.post(
        'https://api.resend.com/emails',
        {
          from: `${fromName} <${fromEmail}>`,
          to,
          subject,
          html,
          attachments,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );

      const resendId = response.data?.id;
      const tiempoMs = Date.now() - startTime;

      await this.logEmail(
        claveAcceso,
        to,
        subject,
        true,
        null,
        resendId,
        1,
        tiempoMs,
      );

      this.logger.log(
        `✅ Email enviado a ${to} (Resend ID: ${resendId}) en ${tiempoMs}ms`,
      );
      return { success: true, resendId };
    } catch (err) {
      const tiempoMs = Date.now() - startTime;
      const errorMsg = (err as Error).message;

      await this.logEmail(
        claveAcceso,
        to,
        subject,
        false,
        errorMsg,
        null,
        1,
        tiempoMs,
      );

      this.logger.error(
        `❌ Error enviando email a ${to}: ${errorMsg}`,
      );
      return { success: false, error: errorMsg };
    }
  }

  // ==========================================
  // LOGS — Consultas
  // ==========================================

  async getLogs(
    page = 1,
    limit = 50,
    claveAcceso?: string,
  ): Promise<{
    data: any[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    if (limit > 100) limit = 100;
    const offset = (page - 1) * limit;

    let where = '';
    const params: any[] = [];
    if (claveAcceso) {
      where = `WHERE clave_acceso = $1`;
      params.push(claveAcceso);
    }

    const [countResult, dataResult] = await Promise.all([
      this.db.query(`SELECT COUNT(*) FROM email_logs ${where}`, params),
      this.db.query(
        `SELECT id, clave_acceso, receptor_email, tipo_email, asunto,
                exitoso, error, resend_id, intento, tiempo_respuesta_ms, created_at
         FROM email_logs ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);
    const totalPages = Math.ceil(total / limit);

    return {
      data: dataResult.rows.map((r: any) => ({
        id: r.id,
        claveAcceso: r.clave_acceso,
        receptorEmail: r.receptor_email,
        tipoEmail: r.tipo_email,
        asunto: r.asunto,
        exitoso: r.exitoso,
        error: r.error,
        resendId: r.resend_id,
        intento: r.intento,
        tiempoRespuestaMs: r.tiempo_respuesta_ms,
        createdAt: r.created_at?.toISOString(),
      })),
      total,
      page,
      totalPages,
    };
  }

  // ==========================================
  // HELPERS
  // ==========================================

  /**
   * Carga el XML AUTORIZADO (con firma del SRI) desde disco y lo prepara como
   * adjunto base64. Retorna null si no existe (caso: comprobante no autorizado
   * o archivo eliminado manualmente). El envío del email NO falla si el XML
   * no se puede cargar — solo se omite el adjunto con un warning en logs.
   */
  private async loadXmlAutorizadoAdjunto(
    claveAcceso: string,
  ): Promise<{ filename: string; content: string } | null> {
    try {
      const comprobante =
        await this.repository.findComprobanteByClaveAcceso(claveAcceso);
      if (!comprobante?.id) {
        this.logger.warn(
          `No se encontró comprobante para claveAcceso=${claveAcceso} al cargar XML autorizado`,
        );
        return null;
      }

      const xmlAutorizadoPath =
        await this.repository.findXmlAutorizado(comprobante.id);
      if (!xmlAutorizadoPath) {
        this.logger.warn(
          `No se encontró xml_autorizado_path para comprobante=${comprobante.id}`,
        );
        return null;
      }

      const xmlContent = this.xmlStorage.readXml(xmlAutorizadoPath);
      if (!xmlContent) {
        this.logger.warn(
          `No se pudo leer XML autorizado en disco: ${xmlAutorizadoPath}`,
        );
        return null;
      }

      return {
        filename: `${claveAcceso}_autorizado.xml`,
        content: Buffer.from(xmlContent, 'utf-8').toString('base64'),
      };
    } catch (err) {
      this.logger.error(
        `Error cargando XML autorizado para ${claveAcceso}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private buildEmailHtml(data: {
    emisorNombre: string;
    receptorNombre: string;
    tipoComprobante: string;
    claveAcceso: string;
    numeroAutorizacion: string | null;
    fechaAutorizacion: string | null;
    estado: string;
  }): string {
    return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <div style="background: #1a3a5c; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
    <h1 style="color: #fff; margin: 0; font-size: 22px;">${data.emisorNombre}</h1>
    <p style="color: #aaccff; margin: 5px 0 0 0; font-size: 13px;">Facturación Electrónica SRI Ecuador</p>
  </div>

  <div style="border: 1px solid #ddd; border-top: none; border-radius: 0 0 8px 8px; padding: 25px;">
    <h2 style="color: #1a3a5c; margin-top: 0;">Su ${data.tipoComprobante} ha sido autorizada</h2>
    <p>Estimado(a) <strong>${data.receptorNombre}</strong>,</p>
    <p>Le informamos que su <strong>${data.tipoComprobante}</strong> ha sido autorizada por el Servicio de Rentas Internas (SRI).</p>

    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <tr style="background: #f8f9fa;">
        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; color: #1a3a5c;">Estado</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${data.estado}</td>
      </tr>
      <tr>
        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; color: #1a3a5c;">Clave de Acceso</td>
        <td style="padding: 10px; border: 1px solid #ddd; font-family: monospace; font-size: 12px;">${data.claveAcceso}</td>
      </tr>
      ${data.numeroAutorizacion ? `<tr style="background: #f8f9fa;">
        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; color: #1a3a5c;">Número Autorización</td>
        <td style="padding: 10px; border: 1px solid #ddd; font-family: monospace; font-size: 12px;">${data.numeroAutorizacion}</td>
      </tr>` : ''}
      ${data.fechaAutorizacion ? `<tr>
        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; color: #1a3a5c;">Fecha Autorización</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${data.fechaAutorizacion}</td>
      </tr>` : ''}
    </table>

    <p>Adjunto a este correo encontrará el <strong>RIDE (Representación Impresa del Documento Electrónico)</strong> en formato PDF.</p>

    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
      <p style="font-size: 12px; color: #888; margin: 0;">Saludos,<br>${data.emisorNombre}</p>
      <p style="font-size: 11px; color: #aaa; margin-top: 15px;">Este correo fue generado automáticamente. No responda a este mensaje.</p>
    </div>
  </div>
</body>
</html>`;
  }

  private async logEmail(
    claveAcceso: string,
    to: string,
    subject: string,
    exitoso: boolean,
    error: string | null,
    resendId: string | null,
    intento: number,
    tiempoMs: number,
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO email_logs
          (clave_acceso, receptor_email, tipo_email, asunto, exitoso, error, resend_id, intento, tiempo_respuesta_ms)
         VALUES ($1, $2, 'ride', $3, $4, $5, $6, $7, $8)`,
        [claveAcceso, to, subject, exitoso, error, resendId, intento, tiempoMs],
      );
    } catch (logErr) {
      this.logger.error(
        `Error al registrar email log: ${(logErr as Error).message}`,
      );
    }
  }
}