import { Module, Global } from '@nestjs/common';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { EmailProcessor } from './email.processor';
import { DatabaseModule } from '../../database/database.module';
import { SriModule } from '../sri/sri.module';
import { PdfModule } from '../pdf/pdf.module';

/**
 * Módulo de envío de emails (RIDE PDF) tras autorización de comprobantes SRI.
 *
 * Arquitectura:
 * 1. Evento 'comprobante.autorizado' → @OnEvent listener → encola job BullMQ
 * 2. EmailProcessor consume el job → llama a EmailService.sendRideEmail
 * 3. EmailService genera RIDE + barcode → adjunta PDF → envía via Resend API
 * 4. Resultado se registra en la tabla email_logs (audit trail)
 *
 * Reintentos gestionados por BullMQ con backoff exponencial.
 * Configuración via env vars: RESEND_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME, EMAIL_ENABLED
 */
@Global()
@Module({
  imports: [DatabaseModule, SriModule, PdfModule],
  controllers: [EmailController],
  providers: [EmailService, EmailProcessor],
  exports: [EmailService],
})
export class EmailModule {}