import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';

export interface RideStorageJobData {
  claveAcceso: string;
  tipoComprobante: string;
}

/**
 * Listener for comprobante.autorizado event.
 * Enqueues a BullMQ job to generate, persist and store the RIDE PDF.
 * Tipo de comprobante configurable via RIDE_STORAGE_TIPOS env var.
 * Default: solo FACTURA (01). Para futuros tipos: "01,04,05,06,07"
 */
@Injectable()
export class RideStorageListener {
  private readonly logger = new Logger(RideStorageListener.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectQueue('ride-storage')
    private readonly rideStorageQueue: Queue<RideStorageJobData>,
  ) {}

  @OnEvent('comprobante.autorizado')
  async handleComprobanteAutorizado(payload: {
    emisorId?: string;
    claveAcceso: string;
    tipoComprobante: string;
    secuencial: string;
    fechaAutorizacion?: string;
    numeroAutorizacion?: string;
  }) {
    const enabled = this.configService.get<boolean>('queues.rideStorage.enabled');
    if (!enabled) {
      this.logger.debug(
        'Ride storage deshabilitado (RIDE_STORAGE_ENABLED=false). No se encola.',
      );
      return;
    }

    const tiposPermitidos = this.configService
      .get<string>('queues.rideStorage.tiposPermitidos', '01')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    if (!tiposPermitidos.includes(payload.tipoComprobante)) {
      this.logger.debug(
        `Tipo ${payload.tipoComprobante} no habilitado para guardado de PDF. ` +
          `Permitidos: ${tiposPermitidos.join(',')}`,
      );
      return;
    }

    this.logger.log(
      `Evento comprobante.autorizado recibido — encolando guardado de PDF para ${payload.claveAcceso} (tipo ${payload.tipoComprobante})`,
    );

    await this.rideStorageQueue.add('save-ride-pdf', {
      claveAcceso: payload.claveAcceso,
      tipoComprobante: payload.tipoComprobante,
    });
  }
}
