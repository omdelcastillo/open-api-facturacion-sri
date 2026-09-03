import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotaDebitoService } from './nota-debito.service';
import { ClaveAccesoService } from './clave-acceso.service';
import { XmlBuilderService } from './xml-builder.service';
import { XmlSignerService } from './xml-signer.service';
import { SriSoapClient } from './sri-soap.client';
import { SriRepositoryService } from './sri-repository.service';
import { XmlStorageService } from './xml-storage.service';
import { SriBaseService } from './sri-base.service';
import { CatalogoValidatorService } from './catalogo-validator.service';
import { CreateNotaDebitoDto } from '../dto';
import { TipoIdentificacion, Ambiente, TipoEmision } from '../constants';

/**
 * Tests unitarios para NotaDebitoService.emitirNotaDebito
 * Cubre validación de motivos, impuestos, firma, envío SRI y persistencia
 */
describe('NotaDebitoService — Emisión', () => {
  let service: NotaDebitoService;
  let claveAccesoService: jest.Mocked<ClaveAccesoService>;
  let xmlBuilderService: jest.Mocked<XmlBuilderService>;
  let xmlSignerService: jest.Mocked<XmlSignerService>;
  let sriSoapClient: jest.Mocked<SriSoapClient>;
  let repository: jest.Mocked<SriRepositoryService>;
  let xmlStorage: jest.Mocked<XmlStorageService>;
  let base: jest.Mocked<SriBaseService>;
  let catalogoValidator: jest.Mocked<CatalogoValidatorService>;
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

  function createValidDto(): CreateNotaDebitoDto {
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
      motivos: [
        { razon: 'Interés por mora', valor: 10 },
        { razon: 'Gasto de cobranza', valor: 5 },
      ],
      impuestos: [
        {
          codigo: '2',
          codigoPorcentaje: '2',
          tarifa: 12,
          baseImponible: 15,
          valor: 1.8,
        },
      ],
    } as any as CreateNotaDebitoDto;
  }

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        NotaDebitoService,
        {
          provide: ClaveAccesoService,
          useValue: {
            generate: jest.fn().mockReturnValue('0702202605092438363100110010010000000161245294015'),
          },
        },
        {
          provide: XmlBuilderService,
          useValue: {
            buildNotaDebito: jest.fn().mockReturnValue('<notaDebito>xml</notaDebito>'),
          },
        },
        {
          provide: XmlSignerService,
          useValue: {
            signXmlForEmisor: jest.fn().mockResolvedValue('<notaDebito>signed</notaDebito>'),
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
            validarDocumentoSustentoCatalogo: jest.fn().mockResolvedValue(undefined),
            getDefaultAmbiente: jest.fn().mockReturnValue(Ambiente.PRUEBAS),
          },
        },
        {
          provide: CatalogoValidatorService,
          useValue: {
            validateImpuestos: jest.fn().mockResolvedValue({ valid: true, errors: [] }),
          },
        },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(NotaDebitoService);
    claveAccesoService = module.get(ClaveAccesoService);
    xmlBuilderService = module.get(XmlBuilderService);
    xmlSignerService = module.get(XmlSignerService);
    sriSoapClient = module.get(SriSoapClient);
    repository = module.get(SriRepositoryService);
    xmlStorage = module.get(XmlStorageService);
    base = module.get(SriBaseService);
    catalogoValidator = module.get(CatalogoValidatorService);
    eventEmitter = module.get(EventEmitter2);
  });

  // ==========================================
  // U-ND-01: Emisión exitosa — SRI autoriza
  // ==========================================
  it('U-ND-01: Emisión exitosa retorna NotaDebitoResponseDto con success=true', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202605092438363100110010010000000161245294015',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      xmlAutorizado: '<notaDebito>autorizado</notaDebito>',
      mensajes: [],
    });

    const result = await service.emitirNotaDebito(createValidDto());

    expect(result.success).toBe(true);
    expect(result.estado).toBe('AUTORIZADO');
    expect(result.claveAcceso).toHaveLength(49);
    expect(result.fechaAutorizacion).toBeDefined();
  });

  // ==========================================
  // U-ND-02: SRI devuelve comprobante (DEVUELTA)
  // ==========================================
  it('U-ND-02: SRI devuelve comprobante → estado=DEVUELTA', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202605092438363100110010010000000161245294015',
      estado: 'DEVUELTA',
      mensajes: [{ identificador: 'ERROR_1', mensaje: 'Campo inválido', tipo: 'ERROR' }],
    });

    const result = await service.emitirNotaDebito(createValidDto());

    expect(result.success).toBe(false);
    expect(result.estado).toBe('DEVUELTA');
    expect(result.mensajes).toHaveLength(1);
  });

  // ==========================================
  // U-ND-03: SRI rechaza comprobante (RECHAZADO)
  // ==========================================
  it('U-ND-03: SRI rechaza → estado=RECHAZADO', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202605092438363100110010010000000161245294015',
      estado: 'RECHAZADO',
      mensajes: [{ identificador: 'ERROR_2', mensaje: 'Firma inválida', tipo: 'ERROR' }],
    });

    const result = await service.emitirNotaDebito(createValidDto());

    expect(result.success).toBe(false);
    expect(result.estado).toBe('RECHAZADO');
  });

  // ==========================================
  // U-ND-04: Emisor no encontrado
  // ==========================================
  it('U-ND-04: Emisor no encontrado → lanza error', async () => {
    repository.findEmisorByRuc.mockResolvedValue(null as any);

    await expect(service.emitirNotaDebito(createValidDto())).rejects.toThrow();
  });

  // ==========================================
  // U-ND-05: Emisor sin certificado P12
  // ==========================================
  it('U-ND-05: Emisor sin certificado P12 → lanza BadRequestException', async () => {
    repository.findEmisorByRuc.mockResolvedValue({
      ...mockEmisor,
      certificado_p12: null,
    } as any);

    await expect(service.emitirNotaDebito(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-ND-06: Punto de emisión no encontrado
  // ==========================================
  it('U-ND-06: Punto de emisión no encontrado → lanza BadRequestException', async () => {
    repository.findPuntoEmision.mockResolvedValue(null as any);

    await expect(service.emitirNotaDebito(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-ND-07: Secuencial manual se respeta
  // ==========================================
  it('U-ND-07: Secuencial manual se respeta y no consulta BD', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202605092438363100110010010000000161245294015',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    dto.secuencial = '000000123';

    await service.emitirNotaDebito(dto);

    expect(repository.getNextSecuencial).not.toHaveBeenCalled();
  });

  // ==========================================
  // U-ND-08: Validación de identificación falla
  // ==========================================
  it('U-ND-08: Identificación inválida → lanza error antes de buscar emisor', async () => {
    base.validarIdentificacion.mockImplementation(() => {
      throw new BadRequestException('Cédula inválida');
    });

    await expect(service.emitirNotaDebito(createValidDto())).rejects.toThrow(BadRequestException);
    expect(repository.findEmisorByRuc).not.toHaveBeenCalled();
  });

  // ==========================================
  // U-ND-09: Validación de impuestos via CatalogoValidator falla
  // ==========================================
  it('U-ND-09: Impuestos inválidos (catalogoValidator) → lanza BadRequestException', async () => {
    catalogoValidator.validateImpuestos.mockResolvedValue({
      valid: false,
      errors: ['Código de impuesto 99 no existe'],
    });

    await expect(service.emitirNotaDebito(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-ND-10: Validación de documento sustento falla
  // ==========================================
  it('U-ND-10: Documento sustento inválido → lanza BadRequestException', async () => {
    base.validarDocumentoSustentoCatalogo.mockRejectedValue(
      new BadRequestException('Código de documento sustento inválido'),
    );

    await expect(service.emitirNotaDebito(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-ND-11: Clave de acceso generada con tipo NOTA_DEBITO (05)
  // ==========================================
  it('U-ND-11: Clave de acceso se genera con tipoComprobante=05', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202605092438363100110010010000000161245294015',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await service.emitirNotaDebito(createValidDto());

    expect(claveAccesoService.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        tipoComprobante: '05',
        ruc: '0924383631001',
      }),
    );
  });

  // ==========================================
  // U-ND-12: XML se construye y firma
  // ==========================================
  it('U-ND-12: XML se construye y se firma con certificado del emisor', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202605092438363100110010010000000161245294015',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await service.emitirNotaDebito(createValidDto());

    expect(xmlBuilderService.buildNotaDebito).toHaveBeenCalledTimes(1);
    expect(xmlSignerService.signXmlForEmisor).toHaveBeenCalledWith(
      expect.any(String),
      '0924383631001',
    );
  });

  // ==========================================
  // U-ND-13: Persistencia fallida emite evento persistencia_fallida
  // ==========================================
  it('U-ND-13: Falla en persistencia emite comprobante.persistencia_fallida', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    repository.createComprobante.mockRejectedValue(new Error('DB connection lost'));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202605092438363100110010010000000161245294015',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await expect(service.emitirNotaDebito(createValidDto())).rejects.toThrow('DB connection lost');

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.persistencia_fallida',
      expect.objectContaining({
        claveAcceso: expect.any(String),
        error: 'DB connection lost',
        tipoComprobante: '05',
      }),
    );
  });

  // ==========================================
  // U-ND-14: Ambiente por defecto cuando no se especifica
  // ==========================================
  it('U-ND-14: Usa ambiente por defecto (PRUEBAS) cuando dto no lo especifica', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202605092438363100110010010000000161245294015',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    delete (dto as any).ambiente;

    await service.emitirNotaDebito(dto);

    expect(base.getDefaultAmbiente).toHaveBeenCalled();
    expect(claveAccesoService.generate).toHaveBeenCalledWith(
      expect.objectContaining({ ambiente: Ambiente.PRUEBAS }),
    );
  });

  // ==========================================
  // U-ND-15: mapResultToNotaDebitoResponse mapea correctamente
  // ==========================================
  it('U-ND-15: mapResultToNotaDebitoResponse mapea todos los campos', () => {
    const result = {
      success: true,
      claveAcceso: '1234567890123456789012345678901234567890123456789',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: 'AUTH-001',
      xmlAutorizado: '<xml/>',
      mensajes: [{ identificador: 'INFO', mensaje: 'OK', tipo: 'INFORMATIVO' }],
    };

    const response = (service as any).mapResultToNotaDebitoResponse(result);

    expect(response.success).toBe(true);
    expect(response.claveAcceso).toBe(result.claveAcceso);
    expect(response.estado).toBe('AUTORIZADO');
    expect(response.fechaAutorizacion).toBe(result.fechaAutorizacion);
    expect(response.numeroAutorizacion).toBe('AUTH-001');
    expect(response.xmlAutorizado).toBe('<xml/>');
    expect(response.mensajes).toHaveLength(1);
  });

  // ==========================================
  // U-ND-16: SRI timeout → relanza error
  // ==========================================
  it('U-ND-16: SRI timeout → relanza error', async () => {
    sriSoapClient.enviarYAutorizar.mockRejectedValue(new Error('SRI timeout'));

    await expect(service.emitirNotaDebito(createValidDto())).rejects.toThrow('SRI timeout');
  });

  // ==========================================
  // U-ND-17: Cálculo de totales con motivos e impuestos
  // ==========================================
  it('U-ND-17: Cálculo de totalSinImpuestos y valorTotal correctos', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202605092438363100110010010000000161245294015',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await service.emitirNotaDebito(createValidDto());

    // createComprobante se llama con total_sin_impuestos=15 (10+5) y importe_total=16.8 (15+1.8)
    const callArg = repository.createComprobante.mock.calls[0][0];
    expect(callArg.total_sin_impuestos).toBe(15);
    expect(callArg.importe_total).toBe(16.8);
  });

  // ==========================================
  // U-ND-18: Emisión exitosa emite comprobante.autorizado
  // ==========================================
  it('U-ND-18: Emisión exitosa emite comprobante.autorizado con tipoComprobante=05', async () => {
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202605092438363100110010010000000177777777018',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '9876543210',
      mensajes: [],
    });

    await service.emitirNotaDebito(createValidDto());

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.autorizado',
      expect.objectContaining({
        claveAcceso: '0702202605092438363100110010010000000177777777018',
        tipoComprobante: '05',
        secuencial: expect.any(String),
        fechaAutorizacion: expect.any(String),
        numeroAutorizacion: expect.any(String),
      }),
    );
  });

  // ==========================================
  // U-ND-19: Comprobante DEVUELTA emite comprobante.rechazado
  // ==========================================
  it('U-ND-19: Comprobante DEVUELTA emite comprobante.rechazado', async () => {
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202605092438363100110010010000000177777777018',
      estado: 'DEVUELTA',
      mensajes: [{ identificador: '01', mensaje: 'Error de validación', tipo: 'ERROR' }],
    });

    await service.emitirNotaDebito(createValidDto());

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.rechazado',
      expect.objectContaining({
        tipoComprobante: '05',
        estado: 'DEVUELTA',
      }),
    );
  });
});
