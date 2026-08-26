import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SriSoapFactoryService } from './sri-soap-factory.service';
import {
  SriRecepcionResponse,
  SriAutorizacionResponse,
  SriOperationResult,
  SriMensaje,
  SriAutorizacion,
} from '../interfaces';

/**
 * Rate limiting parametrizable y separado por tipo de operación.
 * Backoff exponencial real en vez de delay lineal.
 */
@Injectable()
export class SriSoapClient {
  private readonly logger = new Logger(SriSoapClient.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly soapFactory: SriSoapFactoryService,
  ) {}

  async validarComprobante(xmlFirmado: string, ambiente: '1' | '2'): Promise<SriRecepcionResponse> {
    this.logger.log(`Enviando comprobante al SRI para validación (Ambiente ${ambiente})`);
    const xmlBase64 = Buffer.from(xmlFirmado, 'utf-8').toString('base64');

    try {
      const client = await this.soapFactory.getRecepcionClient(ambiente);
      const [result] = await client.validarComprobanteAsync({
        xml: xmlBase64,
      });

      const response = result?.RespuestaRecepcionComprobante || result;
      this.logger.log(`Respuesta del SRI - Estado: ${response?.estado}`);

      return this.parseRecepcionResponse(response);
    } catch (error: unknown) {
      this.logger.error(
        `Error al validar comprobante: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  async autorizarComprobante(
    claveAcceso: string,
  ): Promise<SriAutorizacionResponse> {
    this.logger.log(
      `Consultando autorización para clave: ...${claveAcceso.slice(-8)}`,
    );

    if (claveAcceso.length !== 49) {
      throw new Error('La clave de acceso debe tener 49 dígitos');
    }

    try {
      const ambiente = claveAcceso.charAt(23) as '1' | '2';
      const client = await this.soapFactory.getAutorizacionClient(ambiente);
      const [result] =
        await client.autorizacionComprobanteAsync({
          claveAccesoComprobante: claveAcceso,
        });

      const response = result?.RespuestaAutorizacionComprobante || result;
      this.logger.log(
        `Respuesta del SRI - Autorizaciones: ${response?.numeroComprobantes || 0}`,
      );

      const parsed = this.parseAutorizacionResponse(response);

      // FIX: La librería soap@1.9.1 puede parsear el campo <comprobante>
      // (que viene en CDATA con <?xml) como objeto JS en vez de string.
      // Extraemos el XML crudo de la respuesta para preservar la firma del SRI.
      const rawXml =
        (client as any)?.lastResponse ||
        (client as any)?.lastRequest ||
        '';
      this.replaceComprobanteIfParsed(parsed, rawXml, 'autorizarComprobante');

      return parsed;
    } catch (error: unknown) {
      this.logger.error(
        `Error al consultar autorización: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Rate limiting separado por operación con backoff exponencial.
   * Recepción y autorización tienen parámetros independientes en la configuración.
   */
  async enviarYAutorizar(
    xmlFirmado: string,
    claveAcceso: string,
  ): Promise<SriOperationResult> {
    // Leer configuración separada por operación desde configuration.ts
    const recepcionRetries = this.configService.get<number>(
      'sri.rateLimiting.recepcion.retries', 3,
    );
    const autorizacionRetries = this.configService.get<number>(
      'sri.rateLimiting.autorizacion.retries', 5,
    );
    const autorizacionDelayMs = this.configService.get<number>(
      'sri.rateLimiting.autorizacion.delayMs', 2000,
    );
    const backoffMultiplier = this.configService.get<number>(
      'sri.rateLimiting.autorizacion.backoffMultiplier', 1.5,
    );

    const ambiente = claveAcceso.charAt(23) as '1' | '2';

    const recepcionDelayMs = this.configService.get<number>(
      'sri.rateLimiting.recepcion.delayMs', 2000,
    );

    let recepcion: SriRecepcionResponse | null = null;
    let ultimoError: unknown = null;

    this.logger.log(
      `Recepción: máx ${recepcionRetries} intentos para ...${claveAcceso.slice(-8)}`,
    );

    for (let intento = 1; intento <= recepcionRetries; intento++) {
      try {
        if (intento > 1) {
          await this.delayWithBackoff(recepcionDelayMs, intento, 1.5);
        }
        recepcion = await this.validarComprobante(xmlFirmado, ambiente);
        ultimoError = null;
        break;
      } catch (error: unknown) {
        ultimoError = error;
        this.logger.warn(
          `Intento ${intento}/${recepcionRetries} de recepción fallido por error de red: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }

    if (ultimoError) {
      throw ultimoError;
    }

    if (!recepcion || recepcion.estado === 'DEVUELTA') {
      const mensajes = recepcion ? this.extractMensajes(recepcion) : [];
      if (mensajes.length > 0) {
        this.logger.warn(
          `Comprobante DEVUELTA: ...${claveAcceso.slice(-8)} — Mensajes SRI: ${JSON.stringify(mensajes)}`,
        );
      }
      return {
        success: false,
        claveAcceso,
        estado: 'DEVUELTA',
        mensajes,
      };
    }

    // Paso 2: Consultar autorización con reintentos y backoff exponencial
    this.logger.log(
      `Autorización: máx ${autorizacionRetries} intentos con backoff ${autorizacionDelayMs}ms × ${backoffMultiplier}`,
    );

    for (let intento = 1; intento <= autorizacionRetries; intento++) {
      if (intento > 1) {
        await this.delayWithBackoff(autorizacionDelayMs, intento, backoffMultiplier);
      }

      const autorizacion = await this.autorizarComprobante(claveAcceso);

      if (
        autorizacion.autorizaciones &&
        autorizacion.autorizaciones.autorizacion
      ) {
        const auth = Array.isArray(autorizacion.autorizaciones.autorizacion)
          ? autorizacion.autorizaciones.autorizacion[0]
          : autorizacion.autorizaciones.autorizacion;

        if (auth.estado === 'AUTORIZADO') {
          return {
            success: true,
            claveAcceso,
            estado: 'AUTORIZADO',
            fechaAutorizacion: auth.fechaAutorizacion,
            numeroAutorizacion: auth.numeroAutorizacion,
            xmlAutorizado: auth.comprobante,
            mensajes: this.extractMensajesAutorizacion(auth),
          };
        }

        if (auth.estado === 'NO AUTORIZADO') {
          const mensajesNoAuth = this.extractMensajesAutorizacion(auth);
          this.logger.warn(
            `Comprobante NO AUTORIZADO: ...${claveAcceso.slice(-8)} — Mensajes SRI: ${JSON.stringify(mensajesNoAuth)}`,
          );
          return {
            success: false,
            claveAcceso,
            estado: 'NO AUTORIZADO',
            mensajes: mensajesNoAuth,
          };
        }
      }

      this.logger.log(
        `Intento ${intento}/${autorizacionRetries} — comprobante EN PROCESO ...${claveAcceso.slice(-8)}`,
      );
    }

    this.logger.warn(
      `Comprobante EN PROCESO después de ${autorizacionRetries} intentos: ...${claveAcceso.slice(-8)}`,
    );

    return {
      success: false,
      claveAcceso,
      estado: 'EN PROCESO',
      mensajes: [
        {
          identificador: 'TIMEOUT',
          mensaje: 'Se agotaron los reintentos de consulta de autorización',
          tipo: 'ADVERTENCIA',
        },
      ],
    };
  }

  /**
   * Backoff exponencial con cap de 30 segundos.
   * delay(ms) = min(baseMs × multiplier^(intento-1), 30000)
   */
  private async delayWithBackoff(
    baseMs: number,
    attempt: number,
    multiplier: number,
  ): Promise<void> {
    const ms = Math.min(baseMs * Math.pow(multiplier, attempt - 1), 30_000);
    this.logger.debug(`Backoff: esperando ${Math.round(ms)}ms antes del intento ${attempt}`);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseRecepcionResponse(response: Record<string, unknown>): SriRecepcionResponse {
    return {
      estado: (response?.estado as 'RECIBIDA' | 'DEVUELTA') || 'DEVUELTA',
      comprobantes: response?.comprobantes as SriRecepcionResponse['comprobantes'],
    };
  }

  private parseAutorizacionResponse(response: Record<string, unknown>): SriAutorizacionResponse {
    return {
      claveAccesoConsultada: (response?.claveAccesoConsultada as string) || '',
      numeroComprobantes: (response?.numeroComprobantes as string) || '0',
      autorizaciones: response?.autorizaciones as SriAutorizacionResponse['autorizaciones'],
    };
  }

  /**
   * Extrae el contenido CDATA del campo <comprobante> de la respuesta cruda XML
   * del SRI. Es necesario porque la librería soap@1.9.1 parsea CDATA cuyo
   * contenido arranca con `<?xml` como objeto JS en lugar de string (bug
   * conocido), perdiendo la firma autorizada del SRI.
   *
   * @param rawXml XML crudo de la respuesta SOAP del SRI
   * @returns Contenido del CDATA como string, o undefined si no se encuentra
   */
  private extractComprobanteFromRawResponse(rawXml: string): string | undefined {
    if (!rawXml || typeof rawXml !== 'string') return undefined;
    const match = rawXml.match(
      /<comprobante[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/comprobante>/i,
    );
    if (match && match[1]) {
      const content = match[1].trim();
      if (content.startsWith('<?xml') || content.startsWith('<')) {
        return content;
      }
    }
    return undefined;
  }

  /**
   * Reemplaza el campo `comprobante` de cada autorización por el string crudo
   * extraído del CDATA cuando la librería soap lo entregó como objeto en vez
   * de string. Logging defensivo para auditoría.
   */
  private replaceComprobanteIfParsed(
    parsed: SriAutorizacionResponse,
    rawXml: string,
    context: string,
  ): void {
    if (!parsed.autorizaciones?.autorizacion) return;

    const auths = Array.isArray(parsed.autorizaciones.autorizacion)
      ? parsed.autorizaciones.autorizacion
      : [parsed.autorizaciones.autorizacion];

    // Log siempre el tipo del campo para diagnóstico
    const rawComprobante = rawXml
      ? this.extractComprobanteFromRawResponse(rawXml)
      : undefined;

    let replacements = 0;
    for (const auth of auths) {
      if (!auth) continue;
      const tipo = typeof auth.comprobante;
      const tamano = auth.comprobante == null
        ? 'null'
        : tipo === 'string'
          ? (auth.comprobante as string).length + ' chars'
          : 'N/A';
      this.logger.log(
        `[${context}] auth.comprobante tipo=${tipo} tamaño=${tamano} rawXmlLen=${rawXml.length} rawComprobanteExtraido=${rawComprobante ? rawComprobante.length + ' chars' : 'NO'}`,
      );
      if (auth && typeof auth.comprobante !== 'string') {
        if (rawComprobante) {
          this.logger.log(
            `[${context}] auth.comprobante reemplazado por XML crudo del CDATA (${rawComprobante.length} chars)`,
          );
          (auth as any).comprobante = rawComprobante;
          replacements++;
        } else {
          this.logger.warn(
            `[${context}] auth.comprobante es ${tipo} pero no se pudo extraer CDATA del XML crudo`,
          );
        }
      }
    }
    if (replacements === 0 && rawComprobante) {
      this.logger.debug(
        `[${context}] sin reemplazos — auth.comprobante ya era string`,
      );
    }
  }

  private extractMensajes(response: SriRecepcionResponse): SriMensaje[] {
    if (!response.comprobantes || !response.comprobantes.comprobante) {
      return [];
    }

    const comprobantes = Array.isArray(response.comprobantes.comprobante)
      ? response.comprobantes.comprobante
      : [response.comprobantes.comprobante];

    const mensajes: SriMensaje[] = [];
    comprobantes.forEach((comp) => {
      if (comp.mensajes && comp.mensajes.mensaje) {
        const msgs = Array.isArray(comp.mensajes.mensaje)
          ? comp.mensajes.mensaje
          : [comp.mensajes.mensaje];
        mensajes.push(...msgs);
      }
    });

    return mensajes;
  }

  private extractMensajesAutorizacion(auth: SriAutorizacion): SriMensaje[] {
    const mensajes = auth.mensajes;
    if (!mensajes || !mensajes.mensaje) {
      return [];
    }

    return Array.isArray(mensajes.mensaje)
      ? mensajes.mensaje
      : [mensajes.mensaje];
  }
}
