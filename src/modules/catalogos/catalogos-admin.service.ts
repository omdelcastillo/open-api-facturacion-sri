import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CatalogoValidatorService } from '../sri/services/catalogo-validator.service';
import type { CreateCatalogoRetencionDto, UpdateCatalogoRetencionDto } from './dto/catalogo-retencion.dto';

@Injectable()
export class CatalogosAdminService {
  private readonly logger = new Logger(CatalogosAdminService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly catalogoValidator: CatalogoValidatorService,
  ) {}

  async findAllRetenciones(includeInactive = false): Promise<any[]> {
    const query = includeInactive
      ? `SELECT id, tipo, codigo, descripcion, porcentaje, vigente_desde, vigente_hasta, activo, created_at, updated_at FROM catalogo_retenciones ORDER BY tipo, codigo`
      : `SELECT id, tipo, codigo, descripcion, porcentaje, vigente_desde, vigente_hasta, activo, created_at, updated_at FROM catalogo_retenciones WHERE activo = true ORDER BY tipo, codigo`;

    const result = await this.db.query<any>(query);
    return result.rows.map((r) => this.mapRow(r));
  }

  async findRetencionById(id: string): Promise<any> {
    const result = await this.db.query<any>(
      `SELECT id, tipo, codigo, descripcion, porcentaje, vigente_desde, vigente_hasta, activo, created_at, updated_at FROM catalogo_retenciones WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) {
      throw new NotFoundException(`Retención con id ${id} no encontrada`);
    }
    return this.mapRow(result.rows[0]);
  }

  async createRetencion(dto: CreateCatalogoRetencionDto): Promise<any> {
    const existing = await this.db.query<any>(
      `SELECT id FROM catalogo_retenciones WHERE tipo = $1 AND codigo = $2`,
      [dto.tipo, dto.codigo],
    );
    if (existing.rows.length > 0) {
      throw new ConflictException(`Ya existe una retención con tipo ${dto.tipo} y código ${dto.codigo}`);
    }

    const result = await this.db.query<any>(
      `INSERT INTO catalogo_retenciones (tipo, codigo, descripcion, porcentaje, vigente_desde, vigente_hasta, activo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, tipo, codigo, descripcion, porcentaje, vigente_desde, vigente_hasta, activo, created_at, updated_at`,
      [
        dto.tipo,
        dto.codigo,
        dto.descripcion,
        dto.porcentaje,
        dto.vigenteDesde ?? new Date().toISOString().split('T')[0],
        dto.vigenteHasta ?? null,
        dto.activo ?? true,
      ],
    );

    await this.catalogoValidator.forceRefreshCache();
    this.logger.log(`Retención creada: ${dto.tipo}-${dto.codigo} (${dto.porcentaje}%)`);

    return this.mapRow(result.rows[0]);
  }

  async updateRetencion(id: string, dto: UpdateCatalogoRetencionDto): Promise<any> {
    const exists = await this.db.query<any>(`SELECT id FROM catalogo_retenciones WHERE id = $1`, [id]);
    if (exists.rows.length === 0) {
      throw new NotFoundException(`Retención con id ${id} no encontrada`);
    }

    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (dto.descripcion !== undefined) {
      fields.push(`descripcion = $${paramIndex++}`);
      values.push(dto.descripcion);
    }
    if (dto.porcentaje !== undefined) {
      fields.push(`porcentaje = $${paramIndex++}`);
      values.push(dto.porcentaje);
    }
    if (dto.vigenteDesde !== undefined) {
      fields.push(`vigente_desde = $${paramIndex++}`);
      values.push(dto.vigenteDesde);
    }
    if (dto.vigenteHasta !== undefined) {
      fields.push(`vigente_hasta = $${paramIndex++}`);
      values.push(dto.vigenteHasta);
    }
    if (dto.activo !== undefined) {
      fields.push(`activo = $${paramIndex++}`);
      values.push(dto.activo);
    }

    if (fields.length === 0) {
      return this.findRetencionById(id);
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await this.db.query<any>(
      `UPDATE catalogo_retenciones SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING id, tipo, codigo, descripcion, porcentaje, vigente_desde, vigente_hasta, activo, created_at, updated_at`,
      values,
    );

    await this.catalogoValidator.forceRefreshCache();
    this.logger.log(`Retención actualizada: id=${id}`);

    return this.mapRow(result.rows[0]);
  }

  async deleteRetencion(id: string): Promise<void> {
    const exists = await this.db.query<any>(`SELECT id FROM catalogo_retenciones WHERE id = $1`, [id]);
    if (exists.rows.length === 0) {
      throw new NotFoundException(`Retención con id ${id} no encontrada`);
    }

    await this.db.query(`UPDATE catalogo_retenciones SET activo = false, updated_at = NOW() WHERE id = $1`, [id]);

    await this.catalogoValidator.forceRefreshCache();
    this.logger.log(`Retención desactivada (soft delete): id=${id}`);
  }

  private mapRow(r: any): any {
    return {
      id: r.id,
      tipo: r.tipo,
      codigo: r.codigo,
      descripcion: r.descripcion,
      porcentaje: parseFloat(r.porcentaje),
      vigenteDesde: r.vigente_desde,
      vigenteHasta: r.vigente_hasta,
      activo: r.activo,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
