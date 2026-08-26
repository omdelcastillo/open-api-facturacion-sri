import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import FormData from 'form-data';
import { createReadStream } from 'fs';
import { basename, extname } from 'path';
import { PdfImageService } from './pdf-image.service';

export interface ImageData {
  url: string;
  page?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
}

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  private readonly carboneApi: string;
  private readonly pdfRenderConfig: {
    maxAttempts: number;
    retryDelay: number;
  };
  private readonly carboneRenderOptions: Record<string, unknown>;

  constructor(
    private configService: ConfigService,
    private pdfImageService: PdfImageService,
  ) {
    this.carboneApi = this.configService.get<string>('carboneApi')!;
    this.pdfRenderConfig = {
      maxAttempts: this.configService.get<number>('pdfRender.maxAttempts') || 2,
      retryDelay: this.configService.get<number>('pdfRender.retryDelay') || 10,
    };
    this.carboneRenderOptions =
      this.configService.get('carboneRenderOptions') || {};
  }

  /**
   * Generate a PDF using the Carbone API
   */
  async generatePDF(
    jsonData: Record<string, unknown>,
    templatePath: string,
  ): Promise<Buffer> {
    // 1. Upload template to Carbone
    const formData = new FormData();
    const templateStream = createReadStream(templatePath);
    const ext = extname(templatePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.odt': 'application/vnd.oasis.opendocument.text',
      '.html': 'text/html',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    };
    formData.append('template', templateStream, {
      filename: basename(templatePath),
      contentType: contentTypes[ext] || 'application/octet-stream',
    });

    const templateResponse = await axios.post(
      `${this.carboneApi}/template`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Accept: 'application/json',
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      },
    );

    if (
      !templateResponse.data?.success ||
      !templateResponse.data?.data?.templateId
    ) {
      throw new Error('Error al obtener el ID del template');
    }

    const templateId = templateResponse.data.data.templateId;

    // 2. Render PDF
    const renderResponse = await axios.post(
      `${this.carboneApi}/render/${templateId}`,
      {
        data: jsonData,
        complement: this.carboneRenderOptions.complement || {},
        enum: this.carboneRenderOptions.enum || {},
        translations: this.carboneRenderOptions.translations || {},
        isDebugActive: this.carboneRenderOptions.isDebugActive || false,
        convertTo: this.carboneRenderOptions.convertTo || 'pdf',
        lang: this.carboneRenderOptions.lang || 'en-US',
        converter: this.carboneRenderOptions.converter || 'C',
      },
    );

    if (!renderResponse.data?.success || !renderResponse.data?.data?.renderId) {
      throw new Error('Error al iniciar el renderizado');
    }

    const renderId = renderResponse.data.data.renderId;

    // 3. Wait for render to complete before downloading.
    // Carbone's POST /render is async — the renderId is returned immediately
    // but the actual PDF rendering may still be in progress.
    // GET /status checks server health, NOT render completion.
    // Solution: poll the render download endpoint with retry until we get a valid PDF.
    let attempts = 0;
    const maxAttempts = this.pdfRenderConfig.maxAttempts;
    const retryDelay = this.pdfRenderConfig.retryDelay;

    while (attempts < maxAttempts) {
      // Wait before first attempt to give Carbone time to render
      if (attempts > 0) {
        this.logger.debug(
          `Render ${renderId} not ready, retrying in ${retryDelay}ms (attempt ${attempts + 1}/${maxAttempts})`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      } else {
        // Initial delay to allow render to start
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      try {
        const pdfResponse = await axios.get(
          `${this.carboneApi}/render/${renderId}`,
          { responseType: 'arraybuffer', timeout: 30000 },
        );

        // Verify we got a valid PDF (starts with %PDF)
        const pdfBuffer = Buffer.from(pdfResponse.data);
        if (pdfBuffer.length > 1000 && pdfBuffer.slice(0, 4).toString() === '%PDF') {
          return pdfBuffer;
        }

        this.logger.debug(
          `Received invalid/small PDF (${pdfBuffer.length} bytes), retrying...`,
        );
      } catch (downloadErr) {
        this.logger.debug(
          `Render not ready yet: ${(downloadErr as Error).message}`,
        );
      }

      attempts++;
    }

    throw new Error('Tiempo de espera agotado: Carbone no completó el render del PDF');
  }

  /**
   * Generate a PDF with images using post-processing
   */
  async generatePDFWithImages(
    jsonData: Record<string, unknown>,
    templatePath: string,
    images?: ImageData[],
  ): Promise<Buffer> {
    try {
      // 1. Generate base PDF using Carbone
      const pdfBuffer = await this.generatePDF(jsonData, templatePath);

      // 2. Add images if provided
      if (!images || images.length === 0) {
        return pdfBuffer;
      }

      // 3. Process PDF to add images
      return await this.pdfImageService.addImagesToPdf(pdfBuffer, images);
    } catch (error) {
      this.logger.error('Error al generar PDF con imágenes:', error);
      throw error;
    }
  }
}
