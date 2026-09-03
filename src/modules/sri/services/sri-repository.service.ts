import { Injectable, Logger, Inject, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../database';
import {
  ComprobanteRecord,
  DetalleRecord,
  ImpuestoRecord,
  TotalRecord,
  PagoRecord,
  RetencionRecord,
  ImpuestoDocSustentoRecord,
  XmlRecord,
  InfoAdicionalRecord,
  DetalleAdicionalRecord,
  DestinatarioGuiaRecord,
  DetalleGuiaRecord,
  MotivoNotaDebitoRecord,
  EmisorRecord,
} from '../interfaces/repository.interface';

@Injectable()
export class SriRepositoryService {
  private readonly logger = new Logger(SriRepositoryService.name);

  // ==========================================
  // CACHE DE EMISOR — Redis distribuido
  // Migrado de Map in-memory para consistencia multi-instancia.
  // ==========================================
  private readonly CACHE_TTL_MS: number;

  // Whitelist de tablas permitidas para bulkInsert
  private static readonly ALLOWED_TABLES = new Set([
    'comprobantes',
    'comprobante_detalles',
    'comprobante_impuestos',
    'comprobante_totales',
    'comprobante_pagos',
    'comprobante_retenciones',
    'impuestos_doc_sustento',
    'comprobante_xmls',
    'info_adicional',
    'detalles_adicionales',
    'destinatarios_guia',
    'detalles_guia',
    'guia_destinatarios',
    'guia_detalles',
    'motivos_nota_debito',
  ]);

  // Regex para validar identificadores SQL
  private static readonly SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  /**
   * Helper: Bulk INSERT multi-row to reduce N+1 queries to 1 query.
   * Computes the union of all defined keys across all records to handle
   * optional fields that may only appear in some records.
   * Identifiers sanitized against SQL injection.
   */
  private async bulkInsert<T extends Record<string, any>>(
    table: string,
    records: T[],
    client?: PoolClient,
  ): Promise<T[]> {
    if (records.length === 0) return [];

    // Validar tabla contra whitelist
    if (!SriRepositoryService.ALLOWED_TABLES.has(table)) {
      throw new Error(
        `Tabla no permitida para bulkInsert: "${table}". Solo se permiten tablas del catálogo SRI.`,
      );
    }

    const queryFn = client
      ? client.query.bind(client)
      : this.db.query.bind(this.db);

    // Union of all defined keys across all records
    const allKeys = new Set<string>();
    for (const rec of records) {
      for (const k of Object.keys(rec)) {
        if (rec[k] !== undefined) allKeys.add(k);
      }
    }
    const keys = Array.from(allKeys);

    // Validar cada columna contra el regex
    for (const k of keys) {
      if (!SriRepositoryService.SAFE_IDENTIFIER.test(k)) {
        throw new Error(
          `Nombre de columna no válido: "${k}". Solo se permiten letras, números y guión bajo.`,
        );
      }
    }

    const columns = keys.join(', ');

    const MAX_PG_PARAMS = 65535;
    const MAX_ROWS = Math.max(1, Math.floor(MAX_PG_PARAMS / keys.length));
    const allResults: T[] = [];

    for (let i = 0; i < records.length; i += MAX_ROWS) {
      const batch = records.slice(i, i + MAX_ROWS);
      const values: any[] = [];
      const rowPlaceholders: string[] = [];

      for (let j = 0; j < batch.length; j++) {
        const rowValues = keys.map((k) => batch[j][k] ?? null);
        const base = j * keys.length;
        const placeholders = keys
          .map((_, kIndex) => `$${base + kIndex + 1}`)
          .join(', ');
        rowPlaceholders.push(`(${placeholders})`);
        values.push(...rowValues);
      }

      const result = await queryFn(
        `INSERT INTO ${table} (${columns}) VALUES ${rowPlaceholders.join(', ')} RETURNING *`,
        values,
      );
      allResults.push(...result.rows);
    }

    return allResults;
  }

  constructor(
    private readonly db: DatabaseService,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {
    this.CACHE_TTL_MS = this.configService.get<number>(
      'cache.emisorTtlMs',
      300000,
    ); // 5 min default (ms)
  }

  // ==========================================
  // EMISOR METHODS
  // ==========================================

  async findEmisorByRuc(ruc: string): Promise<EmisorRecord | null> {
    // Verificar cache Redis distribuido
    const cacheKey = `emisor:ruc:${ruc}`;
    const cached = await this.cacheManager.get<EmisorRecord>(cacheKey);
    if (cached) {
      return cached;
    }

    // Query database
    const emisor = await this.db.queryOne<EmisorRecord>(
      'SELECT * FROM emisores WHERE ruc = $1 AND estado = $2',
      [ruc, 'ACTIVO'],
    );

    // Guardar en cache Redis si fue encontrado
    if (emisor) {
      // cache-manager acepta TTL en ms
      await this.cacheManager.set(cacheKey, emisor, this.CACHE_TTL_MS);
    }

    return emisor;
  }

  /**
   * Invalida el cache Redis del emisor (clave `emisor:ruc:${ruc}`).
   * Debe invocarse cuando los datos del emisor cambian en BD, por ejemplo
   * al vincular o desvincular un certificado digital. Sin esto, los servicios
   * que usan findEmisorByRuc verían datos stale durante el TTL (5 min).
   */
  async invalidateEmisorCache(ruc: string): Promise<void> {
    const cacheKey = `emisor:ruc:${ruc}`;
    await this.cacheManager.del(cacheKey);
    this.logger.debug(`Cache de emisor invalidada para RUC: ${ruc}`);
  }

  async findPuntoEmision(
    emisorId: string,
    establecimiento: string,
    puntoEmision: string,
  ): Promise<{ punto_emision_id: string; establecimiento_id: string } | null> {
    // Verificar cache Redis distribuido
    const cacheKey = `punto-emision:${emisorId}:${establecimiento}:${puntoEmision}`;
    const cached = await this.cacheManager.get<{ punto_emision_id: string; establecimiento_id: string }>(cacheKey);
    if (cached) {
      return cached;
    }

    // Query database
    const result = await this.db.queryOne<{ punto_emision_id: string; establecimiento_id: string }>(
      `SELECT pe.id as punto_emision_id, e.id as establecimiento_id
       FROM puntos_emision pe
       JOIN establecimientos e ON pe.establecimiento_id = e.id
       WHERE e.emisor_id = $1 AND e.codigo = $2 AND pe.codigo = $3
       AND e.estado = 'ACTIVO' AND pe.estado = 'ACTIVO'`,
       [emisorId, establecimiento, puntoEmision],
    );

    // Guardar en cache Redis si fue encontrado
    if (result) {
      await this.cacheManager.set(cacheKey, result, this.CACHE_TTL_MS);
    }

    return result;
  }

  // ==========================================
  // SECUENCIAL METHODS
  // ==========================================

  async getNextSecuencial(
    puntoEmisionId: string,
    tipoComprobante: string,
    client?: PoolClient,
  ): Promise<string> {
    const queryFn = client
      ? client.query.bind(client)
      : this.db.query.bind(this.db);

    // Atomic upsert: INSERT or UPDATE in a single query to prevent race conditions
    const result = await queryFn(
      `INSERT INTO secuenciales (punto_emision_id, tipo_comprobante, ultimo_secuencial)
       VALUES ($1, $2, 1)
       ON CONFLICT (punto_emision_id, tipo_comprobante) 
       DO UPDATE SET ultimo_secuencial = secuenciales.ultimo_secuencial + 1, updated_at = NOW()
       RETURNING ultimo_secuencial`,
      [puntoEmisionId, tipoComprobante],
    );

    return String(result.rows[0].ultimo_secuencial).padStart(9, '0');
  }

  // ==========================================
  // COMPROBANTE METHODS
  // ==========================================

  async createComprobante(
    data: ComprobanteRecord,
    client?: PoolClient,
  ): Promise<ComprobanteRecord> {
    const queryFn = client
      ? client.query.bind(client)
      : this.db.query.bind(this.db);

    const keys = Object.keys(data).filter((k) => data[k] !== undefined);

    // Validar columnas
    for (const k of keys) {
      if (!SriRepositoryService.SAFE_IDENTIFIER.test(k)) {
        throw new Error(`Nombre de columna no válido: "${k}"`);
      }
    }

    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const columns = keys.join(', ');

    const result = await queryFn(
      `INSERT INTO comprobantes (${columns}) VALUES (${placeholders}) RETURNING *`,
      values,
    );

    return result.rows[0];
  }

  async updateComprobante(
    id: string,
    data: Partial<ComprobanteRecord>,
    client?: PoolClient,
  ): Promise<ComprobanteRecord> {
    const queryFn = client
      ? client.query.bind(client)
      : this.db.query.bind(this.db);

    const keys = Object.keys(data).filter((k) => data[k] !== undefined);

    // Validar columnas
    for (const k of keys) {
      if (!SriRepositoryService.SAFE_IDENTIFIER.test(k)) {
        throw new Error(`Nombre de columna no válido: "${k}"`);
      }
    }

    const values = keys.map((k) => data[k]);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

    const result = await queryFn(
      `UPDATE comprobantes SET ${setClause}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, id],
    );

    return result.rows[0];
  }

  async findComprobanteByClaveAcceso(
    claveAcceso: string,
  ): Promise<ComprobanteRecord | null> {
    return this.db.queryOne<ComprobanteRecord>(
      'SELECT * FROM comprobantes WHERE clave_acceso = $1',
      [claveAcceso],
    );
  }

  async updateComprobanteByClaveAcceso(
    claveAcceso: string,
    data: Partial<ComprobanteRecord>,
  ): Promise<ComprobanteRecord | null> {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    for (const k of keys) {
      if (!SriRepositoryService.SAFE_IDENTIFIER.test(k)) {
        throw new Error(`Nombre de columna no válido: "${k}"`);
      }
    }
    const values = keys.map((k) => data[k]);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const result = await this.db.query(
      `UPDATE comprobantes SET ${setClause}, updated_at = NOW() WHERE clave_acceso = $${keys.length + 1} RETURNING *`,
      [...values, claveAcceso],
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  // ==========================================
  // DETALLES METHODS
  // ==========================================

  async createDetalles(
    detalles: DetalleRecord[],
    client?: PoolClient,
  ): Promise<DetalleRecord[]> {
    return this.bulkInsert('comprobante_detalles', detalles, client);
  }

  // ==========================================
  // IMPUESTOS METHODS
  // ==========================================

  async createImpuestos(
    impuestos: ImpuestoRecord[],
    client?: PoolClient,
  ): Promise<ImpuestoRecord[]> {
    return this.bulkInsert('comprobante_impuestos', impuestos, client);
  }

  // ==========================================
  // TOTALES METHODS
  // ==========================================

  async createTotales(
    totales: TotalRecord[],
    client?: PoolClient,
  ): Promise<TotalRecord[]> {
    return this.bulkInsert('comprobante_totales', totales, client);
  }

  // ==========================================
  // PAGOS METHODS
  // ==========================================

  async createPagos(
    pagos: PagoRecord[],
    client?: PoolClient,
  ): Promise<PagoRecord[]> {
    return this.bulkInsert('comprobante_pagos', pagos, client);
  }

  // ==========================================
  // RETENCIONES METHODS
  // ==========================================

  async createRetenciones(
    retenciones: RetencionRecord[],
    client?: PoolClient,
  ): Promise<RetencionRecord[]> {
    return this.bulkInsert('comprobante_retenciones', retenciones, client);
  }

  async createImpuestosDocSustento(
    impuestos: ImpuestoDocSustentoRecord[],
    client?: PoolClient,
  ): Promise<ImpuestoDocSustentoRecord[]> {
    return this.bulkInsert('impuestos_doc_sustento', impuestos, client);
  }

  // ==========================================
  // XML METHODS
  // ==========================================

  async saveXml(data: XmlRecord, client?: PoolClient): Promise<XmlRecord> {
    const queryFn = client
      ? client.query.bind(client)
      : this.db.query.bind(this.db);

    const result = await queryFn(
      `INSERT INTO comprobante_xmls (comprobante_id, xml_firmado_path, xml_autorizado_path)
       VALUES ($1, $2, $3)
       ON CONFLICT (comprobante_id) DO UPDATE SET
         xml_firmado_path = COALESCE($2, comprobante_xmls.xml_firmado_path),
         xml_autorizado_path = COALESCE($3, comprobante_xmls.xml_autorizado_path)
       RETURNING *`,
      [data.comprobante_id, data.xml_firmado_path, data.xml_autorizado_path],
    );
    return result.rows[0];
  }

  // ==========================================
  // INFO ADICIONAL METHODS
  // ==========================================

  async createInfoAdicional(
    items: InfoAdicionalRecord[],
    client?: PoolClient,
  ): Promise<InfoAdicionalRecord[]> {
    return this.bulkInsert('info_adicional', items, client);
  }

  async createDetallesAdicionales(
    items: DetalleAdicionalRecord[],
    client?: PoolClient,
  ): Promise<DetalleAdicionalRecord[]> {
    return this.bulkInsert('detalles_adicionales', items, client);
  }

  // ==========================================
  // GUIA REMISION METHODS
  // ==========================================

  async createDestinatariosGuia(
    destinatarios: DestinatarioGuiaRecord[],
    client?: PoolClient,
  ): Promise<DestinatarioGuiaRecord[]> {
    return this.bulkInsert('destinatarios_guia', destinatarios, client);
  }

  async createDetallesGuia(
    detalles: DetalleGuiaRecord[],
    client?: PoolClient,
  ): Promise<DetalleGuiaRecord[]> {
    return this.bulkInsert('detalles_guia', detalles, client);
  }

  // ==========================================
  // NOTA DEBITO METHODS
  // ==========================================

  async createMotivosNotaDebito(
    motivos: MotivoNotaDebitoRecord[],
    client?: PoolClient,
  ): Promise<MotivoNotaDebitoRecord[]> {
    return this.bulkInsert('motivos_nota_debito', motivos, client);
  }

  /**
   * Obtiene los motivos de una Nota de Débito (tabla relacionada).
   * Usado por RideService para renderizar la tabla de motivos en el PDF.
   */
  async findMotivosNotaDebito(comprobanteId: string): Promise<any[]> {
    const result = await this.db.query<any>(
      `SELECT razon, valor
       FROM motivos_nota_debito
       WHERE comprobante_id = $1
       ORDER BY id`,
      [comprobanteId],
    );
    return result.rows;
  }

  /**
   * Obtiene los destinatarios de una Guía de Remisión.
   * Usado por RideService para renderizar destinatarios en el PDF.
   */
  async findDestinatariosGuiaByComprobanteId(comprobanteId: string): Promise<any[]> {
    const result = await this.db.query<any>(
      `SELECT id, tipo_identificacion_destinatario, identificacion_destinatario,
              razon_social_destinatario, dir_destinatario, motivo_traslado,
              doc_aduanero_unico, cod_estab_destino, ruta, cod_doc_sustento,
              num_doc_sustento, fecha_emision_doc_sustento, num_aut_doc_sustento,
              email_destinatario
       FROM guia_destinatarios
       WHERE comprobante_id = $1
       ORDER BY id`,
      [comprobanteId],
    );
    return result.rows;
  }

  /**
   * Obtiene los detalles (productos) de un destinatario de Guía de Remisión.
   */
  async findDetallesGuiaByDestinatarioId(destinatarioId: string): Promise<any[]> {
    const result = await this.db.query<any>(
      `SELECT codigo_interno, codigo_adicional, descripcion, cantidad
       FROM guia_detalles
       WHERE destinatario_id = $1
       ORDER BY id`,
      [destinatarioId],
    );
    return result.rows;
  }

  // ==========================================
  // TRANSACTION HELPER
  // ==========================================

  async executeInTransaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(callback);
  }

  // ==========================================
  // QUERY METHODS
  // ==========================================

  /**
   * Busca comprobantes con filtros y paginación
   */
  async findComprobantes(filters: {
    rucEmisor?: string;
    emisorIds?: string[];
    identificacionComprador?: string;
    tipoComprobante?: string;
    estado?: string;
    estados?: string[];
    fechaDesde?: string;
    fechaHasta?: string;
    establecimiento?: string;
    puntoEmision?: string;
    page?: number;
    limit: number;
    cursor?: string;
  }): Promise<{ data: any[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.emisorIds && filters.emisorIds.length > 0) {
      conditions.push(`c.emisor_id = ANY($${paramIndex++})`);
      params.push(filters.emisorIds);
    } else if (filters.rucEmisor) {
      conditions.push(`e.ruc = $${paramIndex++}`);
      params.push(filters.rucEmisor);
    }

    if (filters.identificacionComprador) {
      conditions.push(`c.receptor_identificacion = $${paramIndex++}`);
      params.push(filters.identificacionComprador);
    }

    if (filters.tipoComprobante) {
      conditions.push(`c.tipo_comprobante = $${paramIndex++}`);
      params.push(filters.tipoComprobante);
    }

    if (filters.estados && filters.estados.length > 0) {
      conditions.push(`c.estado = ANY($${paramIndex++})`);
      params.push(filters.estados);
    } else if (filters.estado) {
      conditions.push(`c.estado = $${paramIndex++}`);
      params.push(filters.estado);
    }

    if (filters.fechaDesde) {
      conditions.push(`c.fecha_emision >= $${paramIndex++}`);
      params.push(filters.fechaDesde);
    }

    if (filters.fechaHasta) {
      conditions.push(`c.fecha_emision <= $${paramIndex++}`);
      params.push(filters.fechaHasta);
    }

    if (filters.establecimiento) {
      conditions.push(`est.codigo = $${paramIndex++}`);
      params.push(filters.establecimiento);
    }

    if (filters.puntoEmision) {
      conditions.push(`pe.codigo = $${paramIndex++}`);
      params.push(filters.puntoEmision);
    }

    // Keyset pagination decodification
    if (filters.cursor) {
      try {
        const jsonStr = Buffer.from(filters.cursor, 'base64').toString('utf8');
        const cursorData = JSON.parse(jsonStr);
        if (cursorData && cursorData.createdAt && cursorData.id) {
          // c.created_at y c.id son menores que el cursor (orden descendente)
          conditions.push(`(c.created_at, c.id) < ($${paramIndex++}, $${paramIndex++})`);
          params.push(new Date(cursorData.createdAt), cursorData.id);
        }
      } catch (err) {
        throw new BadRequestException('Cursor de paginación inválido');
      }
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const filterParamsCount = params.length;

    // Keyset: limit + 1 para determinar si hay más páginas
    const limitClause = `LIMIT $${paramIndex++}`;
    params.push(filters.limit + 1);

    let total = 0;
    if (!filters.cursor) {
      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) as count 
         FROM comprobantes c
         LEFT JOIN emisores e ON c.emisor_id = e.id
         LEFT JOIN puntos_emision pe ON c.punto_emision_id = pe.id
         LEFT JOIN establecimientos est ON pe.establecimiento_id = est.id
         ${whereClause}`,
        params.slice(0, filterParamsCount),
      );
      total = countResult.rows.length > 0 ? parseInt(countResult.rows[0].count, 10) : 0;
    }

    const dataResult = await this.db.query<any>(
      `SELECT 
        c.id,
        c.emisor_id,
        c.clave_acceso,
        c.tipo_comprobante,
        c.ambiente,
        c.fecha_emision,
        c.secuencial,
        c.estado,
        c.fecha_autorizacion,
        c.numero_autorizacion as num_autorizacion,
        c.total_sin_impuestos as subtotal,
        COALESCE((SELECT SUM(valor) FROM comprobante_totales ct WHERE ct.comprobante_id = c.id), 0) as total_impuestos,
        c.importe_total as total,
        c.receptor_identificacion as identificacion_comprador,
        c.receptor_razon_social as razon_social_comprador,
        e.ruc as ruc_emisor,
        e.razon_social as razon_social_emisor,
        est.codigo as establecimiento,
        pe.codigo as punto_emision,
        c.created_at,
        c.updated_at
      FROM comprobantes c
      LEFT JOIN emisores e ON c.emisor_id = e.id
      LEFT JOIN puntos_emision pe ON c.punto_emision_id = pe.id
      LEFT JOIN establecimientos est ON pe.establecimiento_id = est.id
      ${whereClause}
      ORDER BY c.created_at DESC, c.id DESC
      ${limitClause}`,
      params,
    );

    return { data: dataResult.rows, total };
  }


  /**
   * Busca un comprobante por clave de acceso con info de XML disponible
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findComprobanteConDetalles(claveAcceso: string): Promise<any> {
    return this.db.queryOne<any>(
      `SELECT 
        c.*,
        e.ruc as ruc_emisor,
        e.razon_social as razon_social_emisor,
        e.nombre_comercial as nombre_comercial,
        e.direccion_matriz as direccion_matriz,
        e.obligado_contabilidad as obligado_contabilidad,
        e.contribuyente_especial as contribuyente_especial,
        e.agente_retencion as agente_retencion,
        e.contribuyente_rimpe as contribuyente_rimpe,
        est.codigo as establecimiento,
        est.direccion as direccion_establecimiento,
        pe.codigo as punto_emision,
        c.total_sin_impuestos as subtotal,
        c.total_descuento as total_descuento,
        COALESCE((SELECT SUM(valor) FROM comprobante_totales ct WHERE ct.comprobante_id = c.id), 0) as total_impuestos,
        c.importe_total as total,
        c.propina as propina,
        c.moneda as moneda,
        c.receptor_tipo_identificacion as receptor_tipo_identificacion,
        c.receptor_identificacion as identificacion_comprador,
        c.receptor_razon_social as razon_social_comprador,
        c.receptor_direccion as receptor_direccion,
        c.receptor_email as receptor_email,
        c.receptor_telefono as receptor_telefono,
        c.numero_autorizacion as num_autorizacion,
        CASE 
          WHEN x.id IS NOT NULL THEN true 
          ELSE false 
        END as xml_disponible
      FROM comprobantes c
      LEFT JOIN comprobante_xmls x ON c.id = x.comprobante_id
      LEFT JOIN emisores e ON c.emisor_id = e.id
      LEFT JOIN puntos_emision pe ON c.punto_emision_id = pe.id
      LEFT JOIN establecimientos est ON pe.establecimiento_id = est.id
      WHERE c.clave_acceso = $1`,
      [claveAcceso],
    );
  }

  /**
   * Obtiene los totales (impuestos agrupados) de un comprobante
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findTotalesByComprobanteId(comprobanteId: string): Promise<any[]> {
    const result = await this.db.query<any>(
      `SELECT
        codigo,
        codigo_porcentaje,
        base_imponible,
        tarifa,
        valor
      FROM comprobante_totales
      WHERE comprobante_id = $1
      ORDER BY codigo, codigo_porcentaje`,
      [comprobanteId],
    );
    return result.rows;
  }

  /**
   * Obtiene los impuestos de los detalles de un comprobante
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findImpuestosByComprobanteId(comprobanteId: string): Promise<any[]> {
    const result = await this.db.query<any>(
      `SELECT
        ci.comprobante_detalle_id,
        ci.codigo,
        ci.codigo_porcentaje,
        ci.tarifa,
        ci.base_imponible,
        ci.valor
      FROM comprobante_impuestos ci
      INNER JOIN comprobante_detalles cd ON ci.comprobante_detalle_id = cd.id
      WHERE cd.comprobante_id = $1
      ORDER BY cd.id, ci.codigo`,
      [comprobanteId],
    );
    return result.rows;
  }

  /**
   * Obtiene los pagos de un comprobante
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findPagosByComprobanteId(comprobanteId: string): Promise<any[]> {
    const result = await this.db.query<any>(
      `SELECT forma_pago, total, plazo, unidad_tiempo
       FROM comprobante_pagos
       WHERE comprobante_id = $1
       ORDER BY id`,
      [comprobanteId],
    );
    return result.rows;
  }

  /**
   * Obtiene los detalles de un comprobante
   */
  async findDetallesByComprobanteId(comprobanteId: string): Promise<any[]> {
    const result = await this.db.query<any>(
      `SELECT 
        d.id,
        d.codigo_principal,
        d.codigo_auxiliar,
        d.descripcion,
        d.cantidad,
        d.precio_unitario,
        d.descuento,
        d.precio_total_sin_impuesto as subtotal
      FROM comprobante_detalles d
      WHERE d.comprobante_id = $1
      ORDER BY d.id`,
      [comprobanteId],
    );
    return result.rows;
  }

  /**
   * Obtiene la info adicional de un comprobante
   * Retorna array vacío si la tabla no existe o no hay datos
   */
  async findInfoAdicionalByComprobanteId(
    comprobanteId: string,
  ): Promise<any[]> {
    try {
      const result = await this.db.query<any>(
        `SELECT nombre, valor 
         FROM info_adicional 
         WHERE comprobante_id = $1`,
        [comprobanteId],
      );
      return result.rows;
    } catch (error: unknown) {
      // Only suppress "table does not exist" (42P01) but log it; re-throw everything else
      const dbError = error as { code?: string; message?: string };
      if (dbError.code === '42P01') {
        this.logger.warn(
          `La tabla 'info_adicional' no existe. Retornando array vacío. Detalle: ${dbError.message || error}`,
        );
        return [];
      }
      throw error;
    }
  }

  /**
   * Obtiene el path del XML autorizado de un comprobante
   */
  async findXmlAutorizado(comprobanteId: string): Promise<string | null> {
    const result = await this.db.queryOne<{ xml_autorizado_path: string }>(
      `SELECT xml_autorizado_path FROM comprobante_xmls WHERE comprobante_id = $1`,
      [comprobanteId],
    );
    return result?.xml_autorizado_path || null;
  }

  /**
   * Obtiene el path del XML firmado de un comprobante
   */
  async findXmlFirmado(comprobanteId: string): Promise<string | null> {
    const result = await this.db.queryOne<{ xml_firmado_path: string }>(
      `SELECT xml_firmado_path FROM comprobante_xmls WHERE comprobante_id = $1`,
      [comprobanteId],
    );
    return result?.xml_firmado_path || null;
  }

  /**
   * Obtiene el registro completo de XMLs de un comprobante
   */
  async findXmlByComprobanteId(comprobanteId: string): Promise<{
    xml_firmado_path?: string;
    xml_autorizado_path?: string;
  } | null> {
    const result = await this.db.queryOne<{
      xml_firmado_path: string;
      xml_autorizado_path: string;
    }>(
      `SELECT xml_firmado_path, xml_autorizado_path FROM comprobante_xmls WHERE comprobante_id = $1`,
      [comprobanteId],
    );
    return result || null;
  }

  // ==========================================
  // PDF METHODS
  // ==========================================

  /**
   * Guarda el path del PDF del RIDE generado. Upsert por comprobante_id.
   * Si ya existe un PDF para el comprobante, actualiza el path y metadata.
   */
  async savePdfRide(data: {
    comprobante_id: string;
    pdf_ride_path: string;
    file_size_bytes: number;
    generated_by: 'auto' | 'manual';
    template_used: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO comprobante_pdfs
         (comprobante_id, pdf_ride_path, file_size_bytes, generated_by, template_used)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (comprobante_id) DO UPDATE SET
         pdf_ride_path = EXCLUDED.pdf_ride_path,
         file_size_bytes = EXCLUDED.file_size_bytes,
         generated_by = EXCLUDED.generated_by,
         template_used = EXCLUDED.template_used,
         updated_at = NOW()`,
      [
        data.comprobante_id,
        data.pdf_ride_path,
        data.file_size_bytes,
        data.generated_by,
        data.template_used,
      ],
    );
  }

  /**
   * Obtiene el path del PDF del RIDE guardado para un comprobante.
   */
  async findPdfRideByComprobanteId(
    comprobanteId: string,
  ): Promise<{
    pdf_ride_path: string;
    file_size_bytes: number | null;
    generated_by: string;
    template_used: string | null;
    generated_at: Date;
  } | null> {
    const result = await this.db.queryOne<{
      pdf_ride_path: string;
      file_size_bytes: number | null;
      generated_by: string;
      template_used: string | null;
      generated_at: Date;
    }>(
      `SELECT pdf_ride_path, file_size_bytes, generated_by, template_used, generated_at
       FROM comprobante_pdfs WHERE comprobante_id = $1`,
      [comprobanteId],
    );
    return result || null;
  }
}
