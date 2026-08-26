import { Injectable, Logger } from '@nestjs/common';
import bwipjs from 'bwip-js';
import { PDFDocument, rgb } from 'pdf-lib';

export interface BarcodeOptions {
  /** Barcode width in millimeters (default: 90) */
  width?: number;
  /** Barcode height in millimeters (default: 20) */
  height?: number;
  /** Scale factor for higher resolution (default: 3) */
  scale?: number;
  /** Include human-readable text below barcode (default: false) */
  includetext?: boolean;
}

@Injectable()
export class BarcodeService {
  private readonly logger = new Logger(BarcodeService.name);

  /**
   * Generate a Code 128 barcode as a PNG buffer.
   *
   * Uses bwip-js (pure JS, no native deps) to render the barcode as a raster
   * image. This avoids font substitution issues in LibreOffice/Carbone when
   * using barcode fonts (e.g., grandzebu Code 128).
   *
   * @param data String to encode (typically the 49-digit claveAcceso)
   * @param options Barcode rendering options
   * @returns PNG image buffer
   */
  async generateCode128Png(
    data: string,
    options: BarcodeOptions = {},
  ): Promise<Buffer> {
    const {
      width = 90,
      height = 20,
      scale = 3,
      includetext = false,
    } = options;

    if (!data) {
      throw new Error('BarcodeService: data is required');
    }

    this.logger.debug(
      `Generating Code 128 PNG for data (len=${data.length}): ${data.substring(0, 10)}...`,
    );

    return new Promise<Buffer>((resolve, reject) => {
      bwipjs.toBuffer(
        {
          bcid: 'code128',
          text: data,
          scale,
          height: height,
          includetext,
          textxalign: 'center',
          paddingwidth: 5,
          paddingheight: 3,
        },
        (err, png) => {
          if (err) {
            const errMsg = typeof err === 'string' ? err : err.message;
            const errStack = typeof err === 'string' ? undefined : err.stack;
            this.logger.error(
              `Error generating Code 128 PNG: ${errMsg}`,
              errStack,
            );
            reject(new Error(errMsg));
            return;
          }
          if (!png) {
            reject(new Error('bwip-js returned null PNG buffer'));
            return;
          }
          this.logger.debug(
            `Code 128 PNG generated: ${png.length} bytes for data len=${data.length}`,
          );
          resolve(png as Buffer);
        },
      );
    });
  }

  /**
   * Generate a Code 128 barcode as a PNG buffer optimized for the RIDE PDF.
   * Uses higher scale for better scan reliability.
   */
  async generateCode128ForRide(data: string): Promise<Buffer> {
    return this.generateCode128Png(data, {
      width: 90,
      height: 20,
      scale: 5,
      includetext: true,
    });
  }

  /**
   * Post-procesa un PDF para embeber el barcode Code 128 de la clave de
   * acceso como imagen PNG (bwip-js). Soluciona el problema de font
   * substitution en LibreOffice que hacía que el barcode renderizado con
   * fuente no fuera scannable.
   *
   * 1. Genera barcode Code 128 como PNG
   * 2. Cubre el texto antiguo del barcode con un rectángulo blanco
   * 3. Coloca la imagen PNG centrada sobre el rectángulo blanco
   *
   * @param pdfBuffer PDF original generado por Carbone
   * @param claveAcceso Clave de acceso de 49 dígitos
   * @returns PDF modificado con barcode embebido
   */
  async embedBarcodeInPdf(
    pdfBuffer: Buffer,
    claveAcceso: string,
  ): Promise<Buffer> {
    if (!claveAcceso) {
      return pdfBuffer;
    }

    try {
      const barcodePng = await this.generateCode128ForRide(claveAcceso);

      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const pages = pdfDoc.getPages();
      if (!pages || pages.length === 0) {
        return pdfBuffer;
      }

      const firstPage = pages[0];
      const { width: pageW, height: pageH } = firstPage.getSize();

      // Coordenadas del barcode en el template ODS renderizado (A4 portrait)
      // El texto del barcode original aparece en y=202-228pt (top-down) →
      // y=614-640pt (bottom-up). Cubrimos con un rectángulo blanco.
      const cellX = 278;
      const cellY = 568;
      const cellW = 430;
      const cellH = 75;

      firstPage.drawRectangle({
        x: cellX,
        y: cellY,
        width: cellW,
        height: cellH,
        color: rgb(1, 1, 1),
      });

      const pngImage = await pdfDoc.embedPng(barcodePng);
      const aspectRatio = pngImage.width / pngImage.height;
      const targetW = 255;
      const targetH = targetW / aspectRatio;
      const x = 283;
      const y = 580;

      firstPage.drawImage(pngImage, {
        x,
        y,
        width: targetW,
        height: targetH,
      });

      return Buffer.from(await pdfDoc.save());
    } catch (err) {
      this.logger.warn(
        `No se pudo embeber barcode en PDF: ${(err as Error).message}`,
      );
      return pdfBuffer;
    }
  }
}