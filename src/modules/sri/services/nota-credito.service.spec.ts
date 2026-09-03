import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotaCreditoService } from './nota-credito.service';
import { ClaveAccesoService } from './clave-acceso.service';
import { XmlBuilderService } from './xml-builder.service';
import { XmlSignerService } from './xml-signer.service';
import { SriSoapClient } from './sri-soap.client';
import { SriRepositoryService } from './sri-repository.service';
import { XmlStorageService } from './xml-storage.service';
import { SriBaseService } from './sri-base.service';
import { CreateNotaCreditoDto } from '../dto';
import { TipoIdentificacion, Ambiente, TipoEmision } from '../constants';

/**
 * Tests unitarios para NotaCreditoService.emitirNotaCredito
 * Cubre el patrón: validar → generar XML → firmar → enviar SRI → persistir
 */
describe('NotaCreditoService — Emisión', () => {
  let service: NotaCreditoService;
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

  function createValidDto(): CreateNotaCreditoDto {
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
      comprador: {
        tipoIdentificacion: TipoIdentificacion.CEDULA,
        identificacion: '1710034065',
        razonSocial: 'Juan Pérez',
      },
      codDocModificado: '01',
      numDocModificado: '001-001-000000001',
      fechaEmisionDocSustento: '01/02/2026',
      motivo: 'Devolución de producto',
      detalles: [
        {
          codigoPrincipal: 'PROD001',
          descripcion: 'Producto devuelto',
          cantidad: 1,
          precioUnitario: 100,
          descuento: 0,
          impuestos: [
            {
              codigo: '2',
              codigoPorcentaje: '2',
              tarifa: 12,
              baseImponible: 100,
              valor: 12,
            },
          ],
        },
      ],
    } as any as CreateNotaCreditoDto;
  }

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        NotaCreditoService,
        {
          provide: ClaveAccesoService,
          useValue: {
            generate: jest.fn().mockReturnValue('0702202604092438363100110010010000000161245294014'),
          },
        },
        {
          provide: XmlBuilderService,
          useValue: {
            buildNotaCredito: jest.fn().mockReturnValue('<notaCredito>xml</notaCredito>'),
          },
        },
        {
          provide: XmlSignerService,
          useValue: {
            signXmlForEmisor: jest.fn().mockResolvedValue('<notaCredito>signed</notaCredito>'),
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
            createDetalles: jest.fn().mockResolvedValue([{ id: 'det-uuid-1' }]),
            createImpuestos: jest.fn().mockResolvedValue([{ id: 'imp-uuid-1' }]),
            createTotales: jest.fn().mockResolvedValue([{ id: 'tot-uuid-1' }]),
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
            validarImpuestosDetalles: jest.fn().mockResolvedValue(undefined),
            validarFormasPagoCatalogo: jest.fn().mockResolvedValue(undefined),
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

    service = module.get(NotaCreditoService);
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
  // U-NC-01: Emisión exitosa — SRI autoriza
  // ==========================================
  it('U-NC-01: Emisión exitosa retorna NotaCreditoResponseDto con success=true', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202604092438363100110010010000000161245294014',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      xmlAutorizado: '<notaCredito>autorizado</notaCredito>',
      mensajes: [],
    });

    const result = await service.emitirNotaCredito(createValidDto());

    expect(result.success).toBe(true);
    expect(result.estado).toBe('AUTORIZADO');
    expect(result.claveAcceso).toHaveLength(49);
    expect(result.fechaAutorizacion).toBeDefined();
    expect(result.numeroAutorizacion).toBeDefined();
  });

  // ==========================================
  // U-NC-02: SRI devuelve comprobante (DEVUELTA)
  // ==========================================
  it('U-NC-02: SRI devuelve comprobante → estado=DEVUELTA', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202604092438363100110010010000000161245294014',
      estado: 'DEVUELTA',
      mensajes: [{ identificador: 'ERROR_1', mensaje: 'Campo inválido', tipo: 'ERROR' }],
    });

    const result = await service.emitirNotaCredito(createValidDto());

    expect(result.success).toBe(false);
    expect(result.estado).toBe('DEVUELTA');
    expect(result.mensajes).toHaveLength(1);
  });

  // ==========================================
  // U-NC-03: SRI rechaza comprobante (RECHAZADO)
  // ==========================================
  it('U-NC-03: SRI rechaza → estado=RECHAZADO', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202604092438363100110010010000000161245294014',
      estado: 'RECHAZADO',
      mensajes: [{ identificador: 'ERROR_2', mensaje: 'Firma inválida', tipo: 'ERROR' }],
    });

    const result = await service.emitirNotaCredito(createValidDto());

    expect(result.success).toBe(false);
    expect(result.estado).toBe('RECHAZADO');
  });

  // ==========================================
  // U-NC-04: Emisor no encontrado
  // ==========================================
  it('U-NC-04: Emisor no encontrado → lanza error', async () => {
    repository.findEmisorByRuc.mockResolvedValue(null as any);

    await expect(service.emitirNotaCredito(createValidDto())).rejects.toThrow();
  });

  // ==========================================
  // U-NC-05: Emisor sin certificado P12
  // ==========================================
  it('U-NC-05: Emisor sin certificado P12 → lanza BadRequestException', async () => {
    repository.findEmisorByRuc.mockResolvedValue({
      ...mockEmisor,
      certificado_p12: null,
    } as any);

    await expect(service.emitirNotaCredito(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-NC-06: Punto de emisión no encontrado
  // ==========================================
  it('U-NC-06: Punto de emisión no encontrado → lanza BadRequestException', async () => {
    repository.findPuntoEmision.mockResolvedValue(null as any);

    await expect(service.emitirNotaCredito(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-NC-07: Secuencial manual se respeta
  // ==========================================
  it('U-NC-07: Secuencial manual se respeta y no consulta BD', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202604092438363100110010010000000161245294014',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    dto.secuencial = '000000123';

    await service.emitirNotaCredito(dto);

    expect(repository.getNextSecuencial).not.toHaveBeenCalled();
  });

  // ==========================================
  // U-NC-08: Validación de identificación falla
  // ==========================================
  it('U-NC-08: Identificación inválida → lanza error antes de buscar emisor', async () => {
    base.validarIdentificacion.mockImplementation(() => {
      throw new BadRequestException('Cédula inválida');
    });

    await expect(service.emitirNotaCredito(createValidDto())).rejects.toThrow(BadRequestException);
    expect(repository.findEmisorByRuc).not.toHaveBeenCalled();
  });

  // ==========================================
  // U-NC-09: Validación de documento sustento falla
  // ==========================================
  it('U-NC-09: Documento sustento inválido → lanza BadRequestException', async () => {
    base.validarDocumentoSustentoCatalogo.mockRejectedValue(
      new BadRequestException('Código de documento sustento inválido'),
    );

    await expect(service.emitirNotaCredito(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-NC-10: Clave de acceso generada con tipo NOTA_CREDITO (04)
  // ==========================================
  it('U-NC-10: Clave de acceso se genera con tipoComprobante=04', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202604092438363100110010010000000161245294014',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await service.emitirNotaCredito(createValidDto());

    expect(claveAccesoService.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        tipoComprobante: '04',
        ruc: '0924383631001',
        establecimiento: '001',
        puntoEmision: '001',
      }),
    );
  });

  // ==========================================
  // U-NC-11: XML se construye y firma
  // ==========================================
  it('U-NC-11: XML se construye y se firma con certificado del emisor', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202604092438363100110010010000000161245294014',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await service.emitirNotaCredito(createValidDto());

    expect(xmlBuilderService.buildNotaCredito).toHaveBeenCalledTimes(1);
    expect(xmlSignerService.signXmlForEmisor).toHaveBeenCalledWith(
      expect.any(String),
      '0924383631001',
    );
  });

  // ==========================================
  // U-NC-12: Persistencia fallida emite evento persistencia_fallida
  // ==========================================
  it('U-NC-12: Falla en persistencia emite comprobante.persistencia_fallida', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    repository.createComprobante.mockRejectedValue(new Error('DB connection lost'));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202604092438363100110010010000000161245294014',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await expect(service.emitirNotaCredito(createValidDto())).rejects.toThrow('DB connection lost');

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.persistencia_fallida',
      expect.objectContaining({
        claveAcceso: expect.any(String),
        error: 'DB connection lost',
        tipoComprobante: '04',
      }),
    );
  });

  // ==========================================
  // U-NC-13: Ambiente por defecto cuando no se especifica
  // ==========================================
  it('U-NC-13: Usa ambiente por defecto (PRUEBAS) cuando dto no lo especifica', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202604092438363100110010010000000161245294014',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    delete (dto as any).ambiente;

    await service.emitirNotaCredito(dto);

    expect(base.getDefaultAmbiente).toHaveBeenCalled();
    expect(claveAccesoService.generate).toHaveBeenCalledWith(
      expect.objectContaining({ ambiente: Ambiente.PRUEBAS }),
    );
  });

  // ==========================================
  // U-NC-14: mapResultToNotaCreditoResponse mapea correctamente
  // ==========================================
  it('U-NC-14: mapResultToNotaCreditoResponse mapea todos los campos', () => {
    const result = {
      success: true,
      claveAcceso: '1234567890123456789012345678901234567890123456789',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: 'AUTH-001',
      xmlAutorizado: '<xml/>',
      mensajes: [{ identificador: 'INFO', mensaje: 'OK', tipo: 'INFORMATIVO' }],
    };

    const response = (service as any).mapResultToNotaCreditoResponse(result);

    expect(response.success).toBe(true);
    expect(response.claveAcceso).toBe(result.claveAcceso);
    expect(response.estado).toBe('AUTORIZADO');
    expect(response.fechaAutorizacion).toBe(result.fechaAutorizacion);
    expect(response.numeroAutorizacion).toBe('AUTH-001');
    expect(response.xmlAutorizado).toBe('<xml/>');
    expect(response.mensajes).toHaveLength(1);
  });

  // ==========================================
  // U-NC-15: Validación de impuestos falla
  // ==========================================
  it('U-NC-15: Impuestos inválidos → lanza BadRequestException', async () => {
    base.validarImpuestosDetalles.mockRejectedValue(
      new BadRequestException('Código de impuesto inválido'),
    );

    await expect(service.emitirNotaCredito(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-NC-16: SRI timeout → relanza error
  // ==========================================
  it('U-NC-16: SRI timeout → relanza error', async () => {
    sriSoapClient.enviarYAutorizar.mockRejectedValue(new Error('SRI timeout'));

    await expect(service.emitirNotaCredito(createValidDto())).rejects.toThrow('SRI timeout');
  });

  // ==========================================
  // U-NC-17: Info adicional se persiste cuando existe
  // ==========================================
  it('U-NC-17: Info adicional se persiste cuando existe en el DTO', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202604092438363100110010010000000161245294014',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    dto.infoAdicional = [{ nombre: 'observacion', valor: 'NC por devolución' }]

    await service.emitirNotaCredito(dto);

    expect(repository.createInfoAdicional).toHaveBeenCalled();
  });

  // ==========================================
  // U-NC-18: Emisión exitosa emite comprobante.autorizado
  // ==========================================
  it('U-NC-18: Emisión exitosa emite comprobante.autorizado con tipoComprobante=04', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202604092438363100110010010000000161245294014',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await service.emitirNotaCredito(createValidDto());

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.autorizado',
      expect.objectContaining({
        claveAcceso: '0702202604092438363100110010010000000161245294014',
        tipoComprobante: '04',
        secuencial: expect.any(String),
        fechaAutorizacion: expect.any(String),
        numeroAutorizacion: expect.any(String),
      }),
    );
  });

  // ==========================================
  // U-NC-19: Comprobante rechazado emite comprobante.rechazado
  // ==========================================
  it('U-NC-19: Comprobante DEVUELTA emite comprobante.rechazado', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202604092438363100110010010000000161245294014',
      estado: 'DEVUELTA',
      mensajes: [{ identificador: '01', mensaje: 'Error de validación', tipo: 'ERROR' }],
    });

    await service.emitirNotaCredito(createValidDto());

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.rechazado',
      expect.objectContaining({
        tipoComprobante: '04',
        estado: 'DEVUELTA',
      }),
    );
  });
});
