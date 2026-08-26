import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailService } from './email.service';

export interface EmailJobData {
  claveAcceso: string;
  emisorId?: string;
  receptorEmail?: string;
  subject?: string;
  trigger: 'auto' | 'manual';
}

/**
 * Processor de emails usando BullMQ.
 * Sigue el mismo patrón que WebhookProcessor (reintentos nativos de BullMQ).
 *
 * El processor llama a EmailService.sendRideEmail que:
 * 1. Obtiene datos del comprobante desde la BD (incluyendo receptor_email)
 * 2. Genera el RIDE PDF vía RideService + BarcodeService
 * 3. Envía el email vía Resend API
 * 4. Registra el resultado en email_logs
 */
@Processor('email-dispatch')
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly emailService: EmailService) {
    super();
  }

  async process(job: Job<EmailJobData>): Promise<void> {
    const { claveAcceso, receptorEmail, subject } = job.data;
    const attempt = job.attemptsMade + 1;

    this.logger.log(
      `[Email] Procesando job ${job.id} para ${claveAcceso} (intento ${attempt}, trigger=${job.data.trigger})`,
    );

    const result = await this.emailService.sendRideEmail(
      claveAcceso,
      receptorEmail,
      subject,
    );

    if (!result.success) {
      this.logger.error(
        `[Email] ❌ Fallo enviando ${claveAcceso} (intento ${attempt}): ${result.error}`,
      );
      throw new Error(result.error || 'Error enviando email');
    }

    this.logger.log(
      `[Email] ✅ Email enviado para ${claveAcceso} (Resend ID: ${result.resendId})`,
    );
  }
}