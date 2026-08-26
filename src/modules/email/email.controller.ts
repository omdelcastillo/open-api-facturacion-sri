import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { EmailService } from './email.service';
import { SendEmailDto } from './dto/email.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/dto/auth.dto';

@ApiTags('Email')
@ApiBearerAuth('JWT')
@Controller('email')
export class EmailController {
  private readonly logger = new Logger(EmailController.name);

  constructor(private readonly emailService: EmailService) {}

  @Post('comprobantes/:claveAcceso/send')
  @ApiOperation({
    summary: 'Reenviar RIDE por email (manual)',
    description:
      'Genera el RIDE del comprobante, lo adjunta y envía por email al receptor. Si se omite "to", usa el email guardado en la BD.',
  })
  @ApiResponse({ status: 200, description: 'Email enviado exitosamente' })
  @ApiResponse({ status: 404, description: 'Comprobante no encontrado' })
  @ApiResponse({ status: 500, description: 'Error enviando email' })
  async sendEmail(
    @Param('claveAcceso') claveAcceso: string,
    @Body() dto: SendEmailDto,
  ): Promise<{ success: boolean; resendId?: string; error?: string }> {
    if (!claveAcceso || claveAcceso.length !== 49) {
      throw new BadRequestException('La clave de acceso debe tener 49 dígitos');
    }

    this.logger.log(`POST /email/comprobantes/${claveAcceso}/send`);

    const result = await this.emailService.sendRideEmail(
      claveAcceso,
      dto.to,
      dto.subject,
    );

    if (!result.success) {
      throw new BadRequestException(
        result.error || 'No se pudo enviar el email',
      );
    }

    return result;
  }

  @Get('logs')
  @ApiOperation({ summary: 'Listar logs de emails enviados' })
  @ApiQuery({ name: 'page', required: false, description: 'Página' })
  @ApiQuery({ name: 'limit', required: false, description: 'Resultados por página (máx 100)' })
  @ApiQuery({ name: 'claveAcceso', required: false, description: 'Filtrar por clave de acceso' })
  @ApiResponse({ status: 200, description: 'Logs paginados' })
  async getLogs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('claveAcceso') claveAcceso?: string,
  ): Promise<{
    data: any[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    return this.emailService.getLogs(
      Number(page) || 1,
      Number(limit) || 50,
      claveAcceso,
    );
  }
}