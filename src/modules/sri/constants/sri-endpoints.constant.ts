/**
 * Endpoints WSDL del SRI Ecuador para servicios de comprobantes electrónicos
 */
export const SRI_ENDPOINTS = {
  /**
   * Ambiente de pruebas (celcer)
   */
  PRUEBAS: {
    RECEPCION:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
    AUTORIZACION:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
  },
  /**
   * Ambiente de producción (cel)
   */
  PRODUCCION: {
    RECEPCION:
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
    AUTORIZACION:
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
  },
} as const;

/**
 * Versión del XML de comprobantes
 */
export const FACTURA_VERSION = '1.1.0';
export const NOTA_CREDITO_VERSION = '1.1.0';
export const NOTA_DEBITO_VERSION = '1.0.0';
export const RETENCION_VERSION = '2.0.0';
export const GUIA_REMISION_VERSION = '1.1.0';

/**
 * Versión de la Ficha Técnica de referencia (Esquema Off-line)
 * Actualizado: Julio 2026
 */
export const FICHA_TECNICA_VERSION = '2.33';

/**
 * Códigos auxiliares para transporte comercial (Anexo 25, Ficha Técnica v2.33)
 * Resolución NAC-DGERCGC26-00000024
 */
export const CODIGOS_TRANSPORTE_COMERCIAL = {
  /** Facturas emitidas por la operadora al cliente */
  H492001: 'H492001',
  /** Facturas emitidas por el socio o accionista a la operadora de transporte */
  H492002: 'H492002',
} as const;
