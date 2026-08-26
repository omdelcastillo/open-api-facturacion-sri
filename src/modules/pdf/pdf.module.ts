import { Module } from '@nestjs/common';
import { PdfController } from './pdf.controller';
import { PdfService } from './pdf.service';
import { PdfImageService } from './pdf-image.service';
import { BarcodeService } from './barcode.service';
import { TemplateModule } from '../template/template.module';

@Module({
  imports: [TemplateModule],
  controllers: [PdfController],
  providers: [PdfService, PdfImageService, BarcodeService],
  exports: [PdfService, PdfImageService, BarcodeService],
})
export class PdfModule {}
