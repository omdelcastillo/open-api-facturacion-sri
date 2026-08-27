import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { SriController } from './sri.controller';
import { CatalogosController } from './catalogos.controller';
import { SriService } from './sri.service';
import {
  ClaveAccesoService,
  XmlBuilderService,
  XmlSignerService,
  SriSoapFactoryService,
  SriSoapClient,
  IdentificacionValidatorService,
  CatalogoValidatorService,
  SriBaseService,
  FacturaService,
  NotaCreditoService,
  NotaDebitoService,
  RetencionService,
  GuiaRemisionService,
} from './services';
import { SriRepositoryService } from './services/sri-repository.service';
import { XmlStorageService } from './services/xml-storage.service';
import { EmisoresModule } from '../emisores/emisores.module';
import { PdfModule } from '../pdf/pdf.module';
import { TemplateModule } from '../template/template.module';
import { SriEmisionProcessor } from './processors/sri-emision.processor';
import { RideService } from './services/ride.service';
import { RideStorageService } from './services/ride-storage.service';
import { RideStorageListener } from './services/ride-storage.listener';
import { RideStorageProcessor } from './processors/ride-storage.processor';

@Module({
  imports: [
    ConfigModule,
    EmisoresModule,
    PdfModule,
    TemplateModule,
    BullModule.registerQueue({ name: 'sri-emision' }),
    BullModule.registerQueue({ name: 'ride-storage' }),
  ],
  controllers: [SriController, CatalogosController],
  providers: [
    SriService,
    SriBaseService,
    FacturaService,
    NotaCreditoService,
    NotaDebitoService,
    RetencionService,
    GuiaRemisionService,
    SriRepositoryService,
    XmlStorageService,
    ClaveAccesoService,
    XmlBuilderService,
    XmlSignerService,
    SriSoapFactoryService,
    SriSoapClient,
    IdentificacionValidatorService,
    CatalogoValidatorService,
    SriEmisionProcessor,
    RideService,
    RideStorageService,
    RideStorageListener,
    RideStorageProcessor,
  ],
  exports: [
    SriService,
    SriBaseService,
    FacturaService,
    NotaCreditoService,
    NotaDebitoService,
    RetencionService,
    GuiaRemisionService,
    SriRepositoryService,
    XmlStorageService,
    ClaveAccesoService,
    XmlBuilderService,
    XmlSignerService,
    SriSoapFactoryService,
    CatalogoValidatorService,
    RideService,
    RideStorageService,
  ],
})
export class SriModule {}
