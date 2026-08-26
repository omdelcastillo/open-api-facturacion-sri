import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsNotEmpty,
  IsEnum,
  IsDateString,
  Min,
  Max,
  Length,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum TipoRetencion {
  RENTA = 'RENTA',
  IVA = 'IVA',
  ISD = 'ISD',
}

export class CreateCatalogoRetencionDto {
  @ApiProperty({ description: 'Tipo de retención', enum: TipoRetencion })
  @IsEnum(TipoRetencion, { message: `tipo debe ser uno de: ${Object.values(TipoRetencion).join(', ')}` })
  tipo: TipoRetencion;

  @ApiProperty({ description: 'Código de retención (1-10 caracteres)', example: '312' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 10)
  @Matches(/^[A-Za-z0-9]+$/, { message: 'El código solo puede contener letras y números' })
  codigo: string;

  @ApiProperty({ description: 'Descripción de la retención' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 300)
  descripcion: string;

  @ApiProperty({ description: 'Porcentaje de retención', example: 2.0 })
  @IsNumber()
  @Min(0)
  @Max(100)
  porcentaje: number;

  @ApiPropertyOptional({ description: 'Fecha desde la que es vigente (YYYY-MM-DD)', example: '2026-03-01' })
  @IsOptional()
  @IsDateString()
  vigenteDesde?: string;

  @ApiPropertyOptional({ description: 'Fecha hasta la que es vigente (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  vigenteHasta?: string;

  @ApiPropertyOptional({ description: 'Si el código está activo', default: true })
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}

export class UpdateCatalogoRetencionDto {
  @ApiPropertyOptional({ description: 'Descripción de la retención' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Length(1, 300)
  descripcion?: string;

  @ApiPropertyOptional({ description: 'Porcentaje de retención' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  porcentaje?: number;

  @ApiPropertyOptional({ description: 'Fecha desde la que es vigente (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  vigenteDesde?: string;

  @ApiPropertyOptional({ description: 'Fecha hasta la que es vigente (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  vigenteHasta?: string;

  @ApiPropertyOptional({ description: 'Si el código está activo' })
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}

export class CatalogoRetencionResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tipo: string;

  @ApiProperty()
  codigo: string;

  @ApiProperty()
  descripcion: string;

  @ApiProperty()
  porcentaje: number;

  @ApiPropertyOptional()
  vigenteDesde: string | null;

  @ApiPropertyOptional()
  vigenteHasta: string | null;

  @ApiProperty()
  activo: boolean;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}
