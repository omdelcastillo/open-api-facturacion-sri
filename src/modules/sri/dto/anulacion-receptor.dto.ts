import { IsString, IsIn, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RespuestaAnulacionDto {
  @ApiProperty({
    description: 'Respuesta del receptor ante la solicitud de anulación',
    enum: ['ACEPTADA', 'RECHAZADA'],
  })
  @IsString()
  @IsIn(['ACEPTADA', 'RECHAZADA'])
  respuesta: 'ACEPTADA' | 'RECHAZADA';

  @ApiPropertyOptional({
    description: 'Motivo de la respuesta (especialmente si es RECHAZADA)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  motivo?: string;
}

export class SolicitudAnulacionResponseDto {
  id: string;
  comprobanteClaveAcceso: string;
  tipoComprobante: string;
  emisorRuc: string;
  receptorIdentificacion: string;
  estado: string;
  motivoSolicitud?: string;
  respuestaMotivo?: string;
  respondidoAt?: string;
  creadoAt: string;
}
