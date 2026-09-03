import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PdfService } from '../../pdf/pdf.service';
import { TemplateService } from '../../template/template.service';
import { SriRepositoryService } from './sri-repository.service';
import { BarcodeService } from '../../pdf/barcode.service';
import { TIPO_COMPROBANTE_DESCRIPCIONES } from '../constants';
import { Ambiente, TipoEmision, TipoIdentificacion } from '../constants/sri.enums';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

@Injectable()
export class RideService {
  private readonly logger = new Logger(RideService.name);
  private static readonly RIDE_TEMPLATES: Record<string, string> = {
    '01': 'factura',
    '04': 'nota-credito',
    '05': 'nota-debito',
    '06': 'guia-remision',
    '07': 'retencion',
  };
  private static readonly RIDE_TEMPLATE_DEFAULT = 'factura';

  constructor(
    private readonly pdfService: PdfService,
    private readonly templateService: TemplateService,
    private readonly repository: SriRepositoryService,
    private readonly barcodeService: BarcodeService,
  ) {}

  /**
   * Genera el RIDE (PDF) de un comprobante por su clave de acceso.
   * Selecciona el template HTML según el tipo de comprobante (factura, NC, ND, etc).
   */
  async generarRide(claveAcceso: string): Promise<Buffer> {
    this.logger.log(`Generando RIDE para clave: ${claveAcceso}`);

    const comprobante =
      await this.repository.findComprobanteConDetalles(claveAcceso);
    if (!comprobante) {
      throw new NotFoundException(
        `Comprobante ${claveAcceso} no encontrado`,
      );
    }

    const detalles =
      await this.repository.findDetallesByComprobanteId(comprobante.id);
    const totales =
      await this.repository.findTotalesByComprobanteId(comprobante.id);
    const impuestos =
      await this.repository.findImpuestosByComprobanteId(comprobante.id);
    const pagos =
      await this.repository.findPagosByComprobanteId(comprobante.id);
    const infoAdicional =
      await this.repository.findInfoAdicionalByComprobanteId(comprobante.id);
    const motivos =
      comprobante.tipo_comprobante === '05'
        ? await this.repository.findMotivosNotaDebito(comprobante.id)
        : [];

    // Cargar destinatarios y detalles solo para GR (tipo 06)
    // Pre-aplanar en una lista mixta de headers + detalles para evitar loops anidados en Carbone
    let destinatarios: any[] = [];
    let itemsGuia: any[] = [];
    if (comprobante.tipo_comprobante === '06') {
      destinatarios = await this.repository.findDestinatariosGuiaByComprobanteId(
        comprobante.id,
      );
      for (const dest of destinatarios) {
        // Línea de encabezado del destinatario
        const destId = dest.identificacion_destinatario || '';
        const destNombre = dest.razon_social_destinatario || '';
        const destMotivo = dest.motivo_traslado || '';
        const destDir = dest.dir_destinatario || '';
        itemsGuia.push({
          codigoInterno: `DESTINATARIO: ${destId}`,
          descripcion: destNombre,
          cantidad: `Motivo: ${destMotivo}`,
        });
        // Línea con dirección del destinatario
        itemsGuia.push({
          codigoInterno: `Dirección:`,
          descripcion: destDir,
          cantidad: dest.ruta || '',
        });
        // Líneas de detalles: productos del destinatario
        const detallesDest =
          await this.repository.findDetallesGuiaByDestinatarioId(dest.id);
        for (const det of detallesDest) {
          itemsGuia.push({
            codigoInterno: det.codigo_interno || '',
            descripcion: `   » ${det.descripcion || ''}`,
            cantidad: this.formatNumero(parseFloat(det.cantidad) || 0),
          });
        }
      }
    }

    // Cargar retenciones solo para Comprobante de Retención (tipo 07)
    let retenciones: any[] = [];
    if (comprobante.tipo_comprobante === '07') {
      retenciones = await this.repository.findRetencionesByComprobanteId(
        comprobante.id,
      );
    }

    const rideData = this.mapComprobanteToRideData(
      comprobante,
      detalles,
      totales,
      impuestos,
      pagos,
      infoAdicional,
      motivos,
      destinatarios,
      itemsGuia,
      retenciones,
    );

    // Generar barcode Code 128 como PNG y embeber como base64 data URI
    // para el tag <img src="{d.barcodeImage}"> en el template HTML
    try {
      const barcodePng = await this.barcodeService.generateCode128ForRide(
        claveAcceso,
      );
      rideData.barcodeImage = `data:image/png;base64,${barcodePng.toString('base64')}`;
    } catch (err) {
      this.logger.warn(
        `No se pudo generar barcode image: ${(err as Error).message}`,
      );
    }

    // Selección dinámica de template según tipo de comprobante
    const templateId =
      RideService.RIDE_TEMPLATES[comprobante.tipo_comprobante] ||
      RideService.RIDE_TEMPLATE_DEFAULT;
    const templatePath = this.templateService.findTemplate(templateId);

    return this.pdfService.generatePDF(
      rideData as AnyRecord,
      templatePath,
    );
  }

  /**
   * Mapea los datos del comprobante al formato requerido por el template RIDE
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapComprobanteToRideData(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    comprobante: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detalles: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    totales: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    impuestos: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pagos: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    infoAdicional: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    motivos: any[] = [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    destinatarios: any[] = [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    itemsGuia: any[] = [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    retenciones: any[] = [],
  ): AnyRecord {
    const ambienteDesc =
      comprobante.ambiente === Ambiente.PRODUCCION
        ? 'PRODUCCI\u00d3N'
        : 'PRUEBAS';

    const tipoEmisionDesc =
      comprobante.tipo_emision === TipoEmision.CONTINGENCIA
        ? 'CONTINGENCIA'
        : 'NORMAL';

    const tipoCompDesc =
      TIPO_COMPROBANTE_DESCRIPCIONES[comprobante.tipo_comprobante] ||
      comprobante.tipo_comprobante;

    const subtotal = parseFloat(comprobante.subtotal) || 0;
    const totalDescuento = parseFloat(comprobante.total_descuento) || 0;
    const totalImpuestos = parseFloat(comprobante.total_impuestos) || 0;
    const total = parseFloat(comprobante.total) || 0;
    const propina = parseFloat(comprobante.propina) || 0;
    const moneda = comprobante.moneda === 'DOLAR' ? 'USD' : (comprobante.moneda || 'USD');

    // Group impuestos by detalle_id for embedding in detalles
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const impuestosByDetalle: Record<string, any[]> = {};
    for (const imp of impuestos) {
      const key = imp.comprobante_detalle_id;
      if (!impuestosByDetalle[key]) impuestosByDetalle[key] = [];
      impuestosByDetalle[key].push({
        codigo: imp.codigo || '',
        codigoPorcentaje: imp.codigo_porcentaje || '',
        tarifa: parseFloat(imp.tarifa) || 0,
        baseImponibleFormato: this.formatMoneda(parseFloat(imp.base_imponible) || 0, moneda),
        valorFormato: this.formatMoneda(parseFloat(imp.valor) || 0, moneda),
      });
    }

    return {
      // ═══ Estructura anidada (template ODS: ride-factura-ods.ods) ═══
      emisor: {
        ruc: comprobante.ruc_emisor || '',
        razonSocial: comprobante.razon_social_emisor || '',
        dirMatriz: comprobante.direccion_matriz || '',
      },
      comprador: {
        direccion: comprobante.receptor_direccion || '',
        email: comprobante.receptor_email || '',
        identificacion: comprobante.identificacion_comprador || '',
        razonSocialComprador: comprobante.razon_social_comprador || '',
      },
      infoTributaria: {
        claveAcceso: comprobante.clave_acceso || '',
        estab: comprobante.establecimiento || '',
        ptoEmi: comprobante.punto_emision || '',
        secuencial: comprobante.secuencial || '',
      },
      fechaAutorizacion: this.formatFecha(comprobante.fecha_autorizacion),
      fechaEmision: this.formatFecha(comprobante.fecha_emision),

      // ═══ Estructura plana (template HTML: ride.html) ═══
      rucEmisor: comprobante.ruc_emisor || '',
      razonSocialEmisor: comprobante.razon_social_emisor || '',
      nombreComercial: comprobante.nombre_comercial || '',
      direccionMatriz: comprobante.direccion_matriz || '',
      direccionEstablecimiento: comprobante.direccion_establecimiento || comprobante.direccion_matriz || '',
      obligadoContabilidad: comprobante.obligado_contabilidad === true || comprobante.obligado_contabilidad === 'true' ? 'SI' : 'NO',
      contribuyenteEspecial: comprobante.contribuyente_especial || '',
      agenteRetencion: comprobante.agente_retencion === true || comprobante.agente_retencion === 'true' ? 'SI' : '',
      contribuyenteRimpe: comprobante.contribuyente_rimpe === true || comprobante.contribuyente_rimpe === 'true' ? 'SI' : '',

      tipoComprobanteDescripcion: tipoCompDesc,
      ambienteDescripcion: ambienteDesc,
      tipoEmisionDescripcion: tipoEmisionDesc,
      establecimiento: comprobante.establecimiento || '',
      puntoEmision: comprobante.punto_emision || '',
      secuencial: comprobante.secuencial || '',
      numeroComprobante: `${comprobante.establecimiento || ''}-${comprobante.punto_emision || ''}-${comprobante.secuencial || ''}`,
      fechaEmisionFormato: this.formatFecha(comprobante.fecha_emision),
      claveAcceso: comprobante.clave_acceso || '',
      estado: comprobante.estado || '',
      numAutorizacion: comprobante.num_autorizacion || '',
      fechaAutorizacionFormato: this.formatFecha(
        comprobante.fecha_autorizacion,
      ),

      razonSocialComprador: comprobante.razon_social_comprador || '',
      identificacionComprador: comprobante.identificacion_comprador || '',
      tipoIdentificacionComprador: this.getTipoIdentificacionDesc(comprobante.receptor_tipo_identificacion),
      receptorDireccion: comprobante.receptor_direccion || '',
      receptorEmail: comprobante.receptor_email || '',
      receptorTelefono: comprobante.receptor_telefono || '',

      subtotalFormato: this.formatMoneda(subtotal, moneda),
      totalDescuentoFormato: this.formatMoneda(totalDescuento, moneda),
      totalImpuestosFormato: this.formatMoneda(totalImpuestos, moneda),
      propinaFormato: this.formatMoneda(propina, moneda),
      totalFormato: this.formatMoneda(total, moneda),
      moneda,

      // Detalles (items) con impuestos embebidos
      // Incluye tanto campos "sin Formato" (para ODS) como "con Formato" (para HTML)
      detalles: detalles.map((d) => ({
        codigoPrincipal: d.codigo_principal || '',
        codigoAuxiliar: d.codigo_auxiliar || '',
        descripcion: d.descripcion || '',
        cantidad: this.formatNumero(parseFloat(d.cantidad) || 0),
        cantidadFormato: this.formatNumero(parseFloat(d.cantidad) || 0),
        precioUnitarioFormato: this.formatMoneda(
          parseFloat(d.precio_unitario) || 0,
          moneda,
        ),
        descuentoFormato: this.formatMoneda(
          parseFloat(d.descuento) || 0,
          moneda,
        ),
        subtotalFormato: this.formatMoneda(
          parseFloat(d.precio_total_sin_impuesto) || 0,
          moneda,
        ),
        impuestos: impuestosByDetalle[d.id] || [],
      })),

      totales: totales.map((t) => ({
        codigo: t.codigo || '',
        descripcion: this.getImpuestoDescripcionConTarifa(t.codigo, t.codigo_porcentaje),
        codigoPorcentaje: t.codigo_porcentaje || '',
        tarifa: parseFloat(t.tarifa) || 0,
        baseImponibleFormato: this.formatMoneda(
          parseFloat(t.base_imponible) || 0,
          moneda,
        ),
        valorFormato: this.formatMoneda(parseFloat(t.valor) || 0, moneda),
      })),

      pagos: pagos.map((p) => ({
        formaPago: p.forma_pago || '',
        formaPagoDescripcion: this.getFormaPagoDescripcion(p.forma_pago),
        totalFormato: this.formatMoneda(parseFloat(p.total) || 0, moneda),
        plazo: p.plazo ? String(p.plazo) : '',
        unidadTiempo: p.unidad_tiempo || '',
      })),

      infoAdicional: (infoAdicional || []).map((ia) => ({
        nombre: ia.nombre || '',
        valor: ia.valor || '',
      })),

      // ═══ Campos específicos de Nota de Crédito (tipo 04) ═══
      ...(comprobante.tipo_comprobante === '04' && {
        docModificadoTipo: comprobante.doc_modificado_tipo || '',
        docModificadoTipoDescripcion: this.getTipoComprobanteDesc(comprobante.doc_modificado_tipo),
        docModificadoNumero: comprobante.doc_modificado_numero || '',
        docModificadoFecha: this.formatFecha(comprobante.doc_modificado_fecha),
        motivo: comprobante.motivo || '',
        valorModificacionFormato: this.formatMoneda(
          parseFloat(comprobante.importe_total) || total,
          moneda,
        ),
      }),

      // ═══ Campos específicos de Nota de Débito (tipo 05) ═══
      ...(comprobante.tipo_comprobante === '05' && {
        docModificadoTipo: comprobante.doc_modificado_tipo || '',
        docModificadoTipoDescripcion: this.getTipoComprobanteDesc(comprobante.doc_modificado_tipo),
        docModificadoNumero: comprobante.doc_modificado_numero || '',
        docModificadoFecha: this.formatFecha(comprobante.doc_modificado_fecha),
        motivos: (motivos || []).map((m) => ({
          razon: m.razon || '',
          valorFormato: this.formatMoneda(parseFloat(m.valor) || 0, moneda),
        })),
        totalSinImpuestosFormato: this.formatMoneda(
          parseFloat(comprobante.total_sin_impuestos) || 0,
          moneda,
        ),
        valorTotalFormato: this.formatMoneda(
          parseFloat(comprobante.importe_total) || total,
          moneda,
        ),
      }),

      // ═══ Campos específicos de Guía de Remisión (tipo 06) ═══
      ...(comprobante.tipo_comprobante === '06' && {
        placa: comprobante.placa || '',
        dirPartida: comprobante.dir_partida || '',
        fechaIniTransporte: this.formatFecha(comprobante.fecha_ini_transporte),
        fechaFinTransporte: this.formatFecha(comprobante.fecha_fin_transporte),
        razonSocialTransportista: comprobante.razon_social_transportista || '',
        rucTransportista: comprobante.ruc_transportista || '',
        tipoIdentificacionTransportistaDesc: this.getTipoComprobanteDesc(comprobante.tipo_identificacion_transportista),
        destinatarios: (destinatarios || []).map((d) => ({
          identificacion: d.identificacion_destinatario || '',
          razonSocial: d.razon_social_destinatario || '',
          direccion: d.dir_destinatario || '',
          motivoTraslado: d.motivo_traslado || '',
          ruta: d.ruta || '',
          email: d.email_destinatario || '',
        })),
        // Pre-aplanado: cada item es {tipo:'header'|'detalle', ...}
        itemsGuia: itemsGuia || [],
      }),

      // ═══ Campos específicos de Comprobante de Retención (tipo 07) ═══
      ...(comprobante.tipo_comprobante === '07' && {
        periodoFiscal: comprobante.periodo_fiscal || '',
        identificacionSujetoRetenido: comprobante.receptor_identificacion || '',
        razonSocialSujetoRetenido: comprobante.receptor_razon_social || '',
        tipoIdentificacionSujetoRetenidoDesc: this.getTipoIdentificacionDesc(comprobante.receptor_tipo_identificacion),
        direccionSujetoRetenido: comprobante.receptor_direccion || '',
        emailSujetoRetenido: comprobante.receptor_email || '',
        retenciones: (retenciones || []).map((r) => ({
          codigo: r.codigo || '',
          tipoDesc: r.codigo === '1' ? 'RENTA' : (r.codigo === '2' ? 'IVA' : 'ISD'),
          codigoRetencion: r.codigo_retencion || '',
          numDocSustento: r.num_doc_sustento || '',
          fechaEmisionDocSustento: this.formatFecha(r.fecha_emision_doc_sustento),
          baseImponibleFormato: this.formatMoneda(parseFloat(r.base_imponible) || 0, moneda),
          porcentajeRetener: parseFloat(r.porcentaje_retener) || 0,
          valorRetenidoFormato: this.formatMoneda(parseFloat(r.valor_retenido) || 0, moneda),
        })),
        totalRetenidoFormato: this.formatMoneda(
          (retenciones || []).reduce((sum, r) => sum + (parseFloat(r.valor_retenido) || 0), 0),
          moneda,
        ),
      }),
    };
  }

  /**
   * Descripción legible del tipo de comprobante para NC
   */
  private getTipoComprobanteDesc(codigo: string): string {
    const map: Record<string, string> = {
      '01': 'Factura',
      '04': 'Nota de Crédito',
      '05': 'Nota de Débito',
      '06': 'Guía de Remisión',
      '07': 'Comprobante de Retención',
    };
    return map[codigo] || codigo;
  }

  /**
   * Formatea una fecha al formato DD/MM/YYYY HH:mm:ss
   */
  private formatFecha(fecha: string | null | undefined): string {
    if (!fecha) return '';
    try {
      const date = new Date(fecha);
      if (isNaN(date.getTime())) return fecha;
      const dd = String(date.getDate()).padStart(2, '0');
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const yyyy = date.getFullYear();
      const hh = String(date.getHours()).padStart(2, '0');
      const min = String(date.getMinutes()).padStart(2, '0');
      const ss = String(date.getSeconds()).padStart(2, '0');
      return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
    } catch {
      return fecha;
    }
  }

  /**
   * Formatea un valor monetario
   */
  private formatMoneda(valor: number, moneda: string = 'USD'): string {
    const simbolo = moneda === 'USD' ? '$' : '';
    return `${simbolo}${valor.toFixed(2)}`;
  }

  /**
   * Formatea un número (cantidad)
   */
  private formatNumero(valor: number): string {
    return valor.toFixed(2);
  }

  /**
   * Descripción del impuesto según código SRI
   */
  private getImpuestoDescripcion(codigo: string): string {
    const descripciones: Record<string, string> = {
      '2': 'IVA',
      '3': 'ICE',
      '5': 'IRB',
    };
    return descripciones[codigo] || 'IMP';
  }

  /**
   * Descripción del impuesto con tarifa según código y códigoPorcentaje
   */
  private getImpuestoDescripcionConTarifa(codigo: string, codigoPorcentaje: string): string {
    const baseDesc = this.getImpuestoDescripcion(codigo);
    if (codigo === '2') {
      const tarifas: Record<string, string> = {
        '0': 'IVA 0%',
        '2': 'IVA 12%',
        '3': 'IVA 14%',
        '4': 'IVA 15%',
        '5': 'IVA 5%',
        '6': 'No Objeto de Impuesto',
        '7': 'Exento de IVA',
        '8': 'IVA Diferenciado',
      };
      return tarifas[codigoPorcentaje] || baseDesc;
    }
    return baseDesc;
  }

  /**
   * Descripción del tipo de identificación según código SRI
   */
  private getTipoIdentificacionDesc(codigo: string | null | undefined): string {
    if (!codigo) return '';
    const descripciones: Record<string, string> = {
      [TipoIdentificacion.RUC]: 'RUC',
      [TipoIdentificacion.CEDULA]: 'CÉDULA',
      [TipoIdentificacion.PASAPORTE]: 'PASAPORTE',
      [TipoIdentificacion.CONSUMIDOR_FINAL]: 'CONSUMIDOR FINAL',
      [TipoIdentificacion.IDENTIFICACION_EXTERIOR]: 'IDENTIFICACIÓN EXTERIOR',
      [TipoIdentificacion.PLACA]: 'PLACA',
    };
    return descripciones[codigo] || codigo;
  }

  /**
   * Descripción de la forma de pago según código SRI
   */
  private getFormaPagoDescripcion(codigo: string | null | undefined): string {
    if (!codigo) return '';
    const descripciones: Record<string, string> = {
      '01': 'SIN UTILIZACIÓN DEL SISTEMA FINANCIERO',
      '15': 'COMPENSACIÓN DE DEUDAS',
      '16': 'TARJETA DE DÉBITO',
      '17': 'DINERO ELECTRÓNICO',
      '18': 'TARJETA PREPAGO',
      '19': 'TARJETA DE CRÉDITO',
      '20': 'OTROS CON UTILIZACIÓN DEL SISTEMA FINANCIERO',
      '21': 'ENDOSO DE TÍTULOS',
    };
    return descripciones[codigo] || codigo;
  }
}
