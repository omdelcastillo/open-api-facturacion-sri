import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RetencionService } from './retencion.service';
import { ClaveAccesoService } from './clave-acceso.service';
import { XmlBuilderService } from './xml-builder.service';
import { XmlSignerService } from './xml-signer.service';
import { SriSoapClient } from './sri-soap.client';
import { SriRepositoryService } from './sri-repository.service';
import { XmlStorageService } from './xml-storage.service';
import { SriBaseService } from './sri-base.service';
import { CreateRetencionDto } from '../dto';
import { TipoIdentificacion, Ambiente, TipoEmision } from '../constants';

/**
 * Tests unitarios para RetencionService.emitirRetencion
 * Cubre validación de retenciones, firma, envío SRI y persistencia
 */
describe('RetencionService — Emisión', () => {
  let service: RetencionService;
  let claveAccesoService: jest.Mocked<ClaveAccesoService>;
  let xmlBuilderService: jest.Mocked<XmlBuilderService>;
  let xmlSignerService: jest.Mocked<XmlSignerService>;
  let sriSoapClient: jest.Mocked<SriSoapClient>;
  let repository: jest.Mocked<SriRepositoryService>;
  let xmlStorage: jest.Mocked<XmlStorageService>;
  let base: jest.Mocked<SriBaseService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const mockClient = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'row-uuid-1' }] }) };

  const mockEmisor = {
    id: 'emisor-uuid-1',
    tenant_id: 'tenant-1',
    ruc: '0924383631001',
    razon_social: 'Empresa Test S.A.',
    estado: 'ACTIVO',
    ambiente: 1,
    certificado_p12: Buffer.from('fake-p12'),
    certificado_nombre: 'cert.p12',
    certificado_password_encrypted: 'encrypted-pass',
  };

  const mockPuntoEmision = {
    punto_emision_id: 'pe-uuid-1',
    establecimiento_id: 'est-uuid-1',
    codigo: '001',
    descripcion: 'Punto de venta 1',
    activo: true,
  };

  function createValidDto(): CreateRetencionDto {
    return {
      fechaEmision: '07/02/2026',
      emisor: {
        ruc: '0924383631001',
        razonSocial: 'Empresa Test S.A.',
        dirMatriz: 'Av. Amazonas 123, Quito',
        establecimiento: '001',
        puntoEmision: '001',
        obligadoContabilidad: 'SI',
      },
      sujetoRetenido: {
        tipoIdentificacion: TipoIdentificacion.RUC,
        identificacion: '0924383631001',
        razonSocial: 'Proveedor S.A.',
        email: 'proveedor@test.com',
      },
      periodoFiscal: '01/2026',
      impuestos: [
        {
          codigo: '1',
          codigoRetencion: '312',
          baseImponible: 1000,
          porcentajeRetener: 2,
          valorRetenido: 20,
          codDocSustento: '01',
          numDocSustento: '001-001-000000001',
          fechaEmisionDocSustento: '01/02/2026',
          totalSinImpuestos: 1000,
          importeTotal: 1120,
          impuestosDocSustento: [
            {
              codImpuestoDocSustento: '2',
              codigoPorcentaje: '2',
              baseImponible: 1000,
              tarifa: 12,
              valorImpuesto: 120,
            },
          ],
        },
      ],
    } as any as CreateRetencionDto;
  }

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        RetencionService,
        {
          provide: ClaveAccesoService,
          useValue: {
            generate: jest.fn().mockReturnValue('0702202607092438363100110010010000000161245294017'),
          },
        },
        {
          provide: XmlBuilderService,
          useValue: {
            buildRetencion: jest.fn().mockReturnValue('<retencion>xml</retencion>'),
          },
        },
        {
          provide: XmlSignerService,
          useValue: {
            signXmlForEmisor: jest.fn().mockResolvedValue('<retencion>signed</retencion>'),
          },
        },
        {
          provide: SriSoapClient,
          useValue: {
            enviarYAutorizar: jest.fn(),
            validarComprobante: jest.fn(),
            autorizarComprobante: jest.fn(),
          },
        },
        {
          provide: SriRepositoryService,
          useValue: {
            findEmisorByRuc: jest.fn().mockResolvedValue(mockEmisor),
            findPuntoEmision: jest.fn().mockResolvedValue(mockPuntoEmision),
            executeInTransaction: jest.fn(),
            getNextSecuencial: jest.fn().mockResolvedValue('000000016'),
            createComprobante: jest.fn().mockResolvedValue({ id: 'comp-uuid-1' }),
            createInfoAdicional: jest.fn().mockResolvedValue([{ id: 'info-uuid-1' }]),
            saveXml: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: XmlStorageService,
          useValue: {
            saveAllXmls: jest.fn().mockReturnValue({
              sinFirmaPath: undefined,
              firmadoPath: '/xmls/firmado/test.xml',
              autorizadoPath: undefined,
            }),
            saveXml: jest.fn(),
            readXml: jest.fn(),
          },
        },
        {
          provide: SriBaseService,
          useValue: {
            validarIdentificacion: jest.fn(),
            validarTipoIdentificacionCatalogo: jest.fn().mockResolvedValue(undefined),
            validarRetencionesCatalogo: jest.fn().mockResolvedValue(undefined),
            validarDocumentoSustentoCatalogo: jest.fn().mockResolvedValue(undefined),
            getDefaultAmbiente: jest.fn().mockReturnValue(Ambiente.PRUEBAS),
          },
        },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(RetencionService);
    claveAccesoService = module.get(ClaveAccesoService);
    xmlBuilderService = module.get(XmlBuilderService);
    xmlSignerService = module.get(XmlSignerService);
    sriSoapClient = module.get(SriSoapClient);
    repository = module.get(SriRepositoryService);
    xmlStorage = module.get(XmlStorageService);
    base = module.get(SriBaseService);
    eventEmitter = module.get(EventEmitter2);
  });

  // ==========================================
  // U-RET-01: Emisión exitosa — SRI autoriza
  // ==========================================
  it('U-RET-01: Emisión exitosa retorna RetencionResponseDto con success=true', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202607092438363100110010010000000161245294017',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      xmlAutorizado: '<retencion>autorizado</retencion>',
      mensajes: [],
    });

    const result = await service.emitirRetencion(createValidDto());

    expect(result.success).toBe(true);
    expect(result.estado).toBe('AUTORIZADO');
    expect(result.claveAcceso).toHaveLength(49);
    expect(result.fechaAutorizacion).toBeDefined();
  });

  // ==========================================
  // U-RET-02: SRI devuelve comprobante (DEVUELTA)
  // ==========================================
  it('U-RET-02: SRI devuelve comprobante → estado=DEVUELTA', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202607092438363100110010010000000161245294017',
      estado: 'DEVUELTA',
      mensajes: [{ identificador: 'ERROR_1', mensaje: 'Campo inválido', tipo: 'ERROR' }],
    });

    const result = await service.emitirRetencion(createValidDto());

    expect(result.success).toBe(false);
    expect(result.estado).toBe('DEVUELTA');
    expect(result.mensajes).toHaveLength(1);
  });

  // ==========================================
  // U-RET-03: SRI rechaza comprobante (RECHAZADO)
  // ==========================================
  it('U-RET-03: SRI rechaza → estado=RECHAZADO', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202607092438363100110010010000000161245294017',
      estado: 'RECHAZADO',
      mensajes: [{ identificador: 'ERROR_2', mensaje: 'Firma inválida', tipo: 'ERROR' }],
    });

    const result = await service.emitirRetencion(createValidDto());

    expect(result.success).toBe(false);
    expect(result.estado).toBe('RECHAZADO');
  });

  // ==========================================
  // U-RET-04: Emisor no encontrado
  // ==========================================
  it('U-RET-04: Emisor no encontrado → lanza error', async () => {
    repository.findEmisorByRuc.mockResolvedValue(null as any);

    await expect(service.emitirRetencion(createValidDto())).rejects.toThrow();
  });

  // ==========================================
  // U-RET-05: Emisor sin certificado P12
  // ==========================================
  it('U-RET-05: Emisor sin certificado P12 → lanza BadRequestException', async () => {
    repository.findEmisorByRuc.mockResolvedValue({
      ...mockEmisor,
      certificado_p12: null,
    } as any);

    await expect(service.emitirRetencion(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-RET-06: Punto de emisión no encontrado
  // ==========================================
  it('U-RET-06: Punto de emisión no encontrado → lanza BadRequestException', async () => {
    repository.findPuntoEmision.mockResolvedValue(null as any);

    await expect(service.emitirRetencion(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-RET-07: Secuencial manual se respeta
  // ==========================================
  it('U-RET-07: Secuencial manual se respeta y no consulta BD', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202607092438363100110010010000000161245294017',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    dto.secuencial = '000000123';

    await service.emitirRetencion(dto);

    expect(repository.getNextSecuencial).not.toHaveBeenCalled();
  });

  // ==========================================
  // U-RET-08: Validación de identificación falla
  // ==========================================
  it('U-RET-08: Identificación inválida → lanza error antes de buscar emisor', async () => {
    base.validarIdentificacion.mockImplementation(() => {
      throw new BadRequestException('RUC inválido');
    });

    await expect(service.emitirRetencion(createValidDto())).rejects.toThrow(BadRequestException);
    expect(repository.findEmisorByRuc).not.toHaveBeenCalled();
  });

  // ==========================================
  // U-RET-09: Validación de retenciones catálogo falla
  // ==========================================
  it('U-RET-09: Retenciones inválidas → lanza BadRequestException', async () => {
    base.validarRetencionesCatalogo.mockRejectedValue(
      new BadRequestException('Códigos de retención inválidos'),
    );

    await expect(service.emitirRetencion(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-RET-10: Validación de documento sustento falla
  // ==========================================
  it('U-RET-10: Documento sustento inválido → lanza BadRequestException', async () => {
    base.validarDocumentoSustentoCatalogo.mockRejectedValue(
      new BadRequestException('Código de documento sustento inválido'),
    );

    await expect(service.emitirRetencion(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-RET-11: Clave de acceso generada con tipo RETENCION (07)
  // ==========================================
  it('U-RET-11: Clave de acceso se genera con tipoComprobante=07', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202607092438363100110010010000000161245294017',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await service.emitirRetencion(createValidDto());

    expect(claveAccesoService.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        tipoComprobante: '07',
        ruc: '0924383631001',
      }),
    );
  });

  // ==========================================
  // U-RET-12: XML se construye y firma
  // ==========================================
  it('U-RET-12: XML se construye y se firma con certificado del emisor', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202607092438363100110010010000000161245294017',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await service.emitirRetencion(createValidDto());

    expect(xmlBuilderService.buildRetencion).toHaveBeenCalledTimes(1);
    expect(xmlSignerService.signXmlForEmisor).toHaveBeenCalledWith(
      expect.any(String),
      '0924383631001',
    );
  });

  // ==========================================
  // U-RET-13: Persistencia fallida emite evento persistencia_fallida
  // ==========================================
  it('U-RET-13: Falla en persistencia emite comprobante.persistencia_fallida', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    repository.createComprobante.mockRejectedValue(new Error('DB connection lost'));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202607092438363100110010010000000161245294017',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await expect(service.emitirRetencion(createValidDto())).rejects.toThrow('DB connection lost');

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.persistencia_fallida',
      expect.objectContaining({
        claveAcceso: expect.any(String),
        error: 'DB connection lost',
        tipoComprobante: '07',
      }),
    );
  });

  // ==========================================
  // U-RET-14: Ambiente por defecto cuando no se especifica
  // ==========================================
  it('U-RET-14: Usa ambiente por defecto (PRUEBAS) cuando dto no lo especifica', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202607092438363100110010010000000161245294017',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    delete (dto as any).ambiente;

    await service.emitirRetencion(dto);

    expect(base.getDefaultAmbiente).toHaveBeenCalled();
    expect(claveAccesoService.generate).toHaveBeenCalledWith(
      expect.objectContaining({ ambiente: Ambiente.PRUEBAS }),
    );
  });

  // ==========================================
  // U-RET-15: mapResultToRetencionResponse mapea correctamente
  // ==========================================
  it('U-RET-15: mapResultToRetencionResponse mapea todos los campos', () => {
    const result = {
      success: true,
      claveAcceso: '1234567890123456789012345678901234567890123456789',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: 'AUTH-001',
      xmlAutorizado: '<xml/>',
      mensajes: [{ identificador: 'INFO', mensaje: 'OK', tipo: 'INFORMATIVO' }],
    };

    const response = (service as any).mapResultToRetencionResponse(result);

    expect(response.success).toBe(true);
    expect(response.claveAcceso).toBe(result.claveAcceso);
    expect(response.estado).toBe('AUTORIZADO');
    expect(response.fechaAutorizacion).toBe(result.fechaAutorizacion);
    expect(response.numeroAutorizacion).toBe('AUTH-001');
    expect(response.xmlAutorizado).toBe('<xml/>');
    expect(response.mensajes).toHaveLength(1);
  });

  // ==========================================
  // U-RET-16: SRI timeout → relanza error
  // ==========================================
  it('U-RET-16: SRI timeout → relanza error', async () => {
    sriSoapClient.enviarYAutorizar.mockRejectedValue(new Error('SRI timeout'));

    await expect(service.emitirRetencion(createValidDto())).rejects.toThrow('SRI timeout');
  });

  // ==========================================
  // U-RET-17: Info adicional se persiste cuando existe
  // ==========================================
  it('U-RET-17: Info adicional se persiste cuando existe en el DTO', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202607092438363100110010010000000161245294017',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    dto.infoAdicional = [{ nombre: 'observacion', valor: 'Retención mensual' }];

    await service.emitirRetencion(dto);

    expect(repository.createInfoAdicional).toHaveBeenCalled();
  });

  // ==========================================
  // U-RET-18: Emisión exitosa emite comprobante.autorizado con payload correcto
  // ==========================================
  it('U-RET-18: Emisión exitosa emite comprobante.autorizado con tipoComprobante=07', async () => {
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202607092438363100110010010000000199999999017',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await service.emitirRetencion(createValidDto());

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.autorizado',
      expect.objectContaining({
        claveAcceso: '0702202607092438363100110010010000000199999999017',
        tipoComprobante: '07',
        secuencial: expect.any(String),
        fechaAutorizacion: expect.any(String),
        numeroAutorizacion: expect.any(String),
      }),
    );
  });

  // ==========================================
  // U-RET-19: Comprobante DEVUELTA emite comprobante.rechazado con payload correcto
  // ==========================================
  it('U-RET-19: Comprobante DEVUELTA emite comprobante.rechazado', async () => {
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202607092438363100110010010000000199999999017',
      estado: 'DEVUELTA',
      mensajes: [{ identificador: '01', mensaje: 'Error de validación', tipo: 'ERROR' }],
    });

    await service.emitirRetencion(createValidDto());

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.rechazado',
      expect.objectContaining({
        tipoComprobante: '07',
        estado: 'DEVUELTA',
      }),
    );
  });
});
