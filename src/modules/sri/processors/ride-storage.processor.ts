import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RideStorageService } from '../services/ride-storage.service';
import { RideStorageJobData } from '../services/ride-storage.listener';

@Processor('ride-storage')
export class RideStorageProcessor extends WorkerHost {
  private readonly logger = new Logger(RideStorageProcessor.name);

  constructor(private readonly rideStorageService: RideStorageService) {
    super();
  }

  async process(job: Job<RideStorageJobData>): Promise<void> {
    const { claveAcceso, tipoComprobante } = job.data;
    this.logger.log(
      `Procesando guardado de RIDE PDF para ...${claveAcceso.slice(-8)} (tipo ${tipoComprobante})`,
    );

    const result = await this.rideStorageService.guardarRidePdf(claveAcceso);

    if (result) {
      this.logger.log(
        `✅ PDF del RIDE guardado: ${result.path} (${result.sizeBytes} bytes)`,
      );
    } else {
      this.logger.warn(
        `⚠️  No se pudo guardar el PDF del RIDE para ${claveAcceso} — revisar logs previos`,
      );
    }
  }
}
