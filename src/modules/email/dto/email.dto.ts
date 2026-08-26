import {
  IsString,
  IsOptional,
  IsEmail,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendEmailDto {
  @ApiPropertyOptional({
    description: 'Email destinatario. Si se omite, usa receptor_email de la BD.',
    example: 'cliente@ejemplo.com',
  })
  @IsOptional()
  @IsEmail({}, { message: 'El email no es válido' })
  to?: string;

  @ApiPropertyOptional({
    description: 'Asunto personalizado. Si se omite, usa el asunto por defecto.',
  })
  @IsOptional()
  @IsString()
  subject?: string;
}

export class EmailLogResponseDto {
  id: string;
  claveAcceso: string;
  receptorEmail: string;
  tipoEmail: string;
  asunto: string;
  exitoso: boolean;
  error: string | null;
  resendId: string | null;
  intento: number;
  tiempoRespuestaMs: number | null;
  createdAt: string;
}