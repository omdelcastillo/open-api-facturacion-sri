import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { RideService } from './ride.service';
import { SriRepositoryService } from './sri-repository.service';

export interface RidePdfSaved {
  path: string;
  sizeBytes: number;
}

/**
 * Service for storing RIDE PDF files in the filesystem.
 * Mirrors the path pattern used by XmlStorageService:
 *   pdfs/{ruc}/{year}/{month}/{claveAcceso}.pdf
 */
@Injectable()
export class RideStorageService {
  private readonly logger = new Logger(RideStorageService.name);
  private readonly pdfsBaseDir: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly rideService: RideService,
    private readonly repository: SriRepositoryService,
  ) {
    this.pdfsBaseDir =
      this.configService.get<string>('directories.pdfs') || '../pdfs';
  }

  /**
   * Generates the RIDE PDF, writes it to disk and persists its path in BD.
   * Returns the relative path on success, or null if any step fails.
   * The caller (RideStorageProcessor) is responsible for retries via BullMQ.
   */
  async guardarRidePdf(
    claveAcceso: string,
  ): Promise<RidePdfSaved | null> {
    try {
      const comprobante =
        await this.repository.findComprobanteByClaveAcceso(claveAcceso);
      if (!comprobante?.id) {
        this.logger.warn(
          `No se encontró comprobante para claveAcceso=${claveAcceso}`,
        );
        return null;
      }

      const pdfBuffer = Buffer.from(
        await this.rideService.generarRide(claveAcceso),
      );

      const relativePath = this.buildRutaRelativa(claveAcceso, comprobante);
      const fullPath = join(this.pdfsBaseDir, relativePath);

      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, pdfBuffer);

      this.logger.log(
        `PDF guardado: ${relativePath} (${pdfBuffer.length} bytes)`,
      );

      await this.repository.savePdfRide({
        comprobante_id: comprobante.id,
        pdf_ride_path: relativePath,
        file_size_bytes: pdfBuffer.length,
        generated_by: 'auto',
        template_used: 'factura',
      });

      return { path: relativePath, sizeBytes: pdfBuffer.length };
    } catch (err) {
      this.logger.error(
        `Error guardando PDF para ${claveAcceso}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Builds the relative path mirroring the XmlStorageService convention.
   * Structure: {ruc}/{year}/{month}/{claveAcceso}.pdf
   */
  private buildRutaRelativa(
    claveAcceso: string,
    comprobante: { emisor_ruc?: string; fecha_emision?: string | Date },
  ): string {
    const ruc =
      comprobante.emisor_ruc || claveAcceso.substring(10, 23);
    const fecha = comprobante.fecha_emision
      ? new Date(comprobante.fecha_emision)
      : new Date();
    const year = fecha.getFullYear().toString();
    const month = (fecha.getMonth() + 1).toString().padStart(2, '0');
    return join(ruc, year, month, `${claveAcceso}.pdf`);
  }
}
