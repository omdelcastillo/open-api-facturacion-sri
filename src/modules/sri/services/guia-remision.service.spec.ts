import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GuiaRemisionService } from './guia-remision.service';
import { ClaveAccesoService } from './clave-acceso.service';
import { XmlBuilderService } from './xml-builder.service';
import { XmlSignerService } from './xml-signer.service';
import { SriSoapClient } from './sri-soap.client';
import { SriRepositoryService } from './sri-repository.service';
import { XmlStorageService } from './xml-storage.service';
import { SriBaseService } from './sri-base.service';
import { CreateGuiaRemisionDto } from '../dto';
import { TipoIdentificacion, Ambiente, TipoEmision } from '../constants';

/**
 * Tests unitarios para GuiaRemisionService.emitirGuiaRemision
 * Cubre validación de transportista, destinatarios, firma, envío SRI y persistencia
 */
describe('GuiaRemisionService — Emisión', () => {
  let service: GuiaRemisionService;
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

  function createValidDto(): CreateGuiaRemisionDto {
    return {
      fechaIniTransporte: '07/02/2026',
      fechaFinTransporte: '10/02/2026',
      emisor: {
        ruc: '0924383631001',
        razonSocial: 'Empresa Test S.A.',
        dirMatriz: 'Av. Amazonas 123, Quito',
        establecimiento: '001',
        puntoEmision: '001',
        obligadoContabilidad: 'SI',
      },
      dirPartida: 'Bodega Central, Quito',
      rucTransportista: '0924383631001',
      tipoIdentificacionTransportista: TipoIdentificacion.RUC,
      razonSocialTransportista: 'Transportes Rápidos S.A.',
      placa: 'ABC123',
      destinatarios: [
        {
          tipoIdentificacionDestinatario: '05',
          identificacionDestinatario: '1710034065',
          razonSocialDestinatario: 'Juan Pérez',
          dirDestinatario: 'Av. Amazonas 456, Guayaquil',
          motivoTraslado: 'Venta',
          detalles: [
            {
              codigoInterno: 'PROD001',
              descripcion: 'Producto terminado',
              cantidad: 10,
            },
          ],
        },
      ],
    } as any as CreateGuiaRemisionDto;
  }

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        GuiaRemisionService,
        {
          provide: ClaveAccesoService,
          useValue: {
            generate: jest.fn().mockReturnValue('0702202606092438363100110010010000000161245294016'),
          },
        },
        {
          provide: XmlBuilderService,
          useValue: {
            buildGuiaRemision: jest.fn().mockReturnValue('<guiaRemision>xml</guiaRemision>'),
          },
        },
        {
          provide: XmlSignerService,
          useValue: {
            signXmlForEmisor: jest.fn().mockResolvedValue('<guiaRemision>signed</guiaRemision>'),
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
            getDefaultAmbiente: jest.fn().mockReturnValue(Ambiente.PRUEBAS),
          },
        },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(GuiaRemisionService);
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
  // U-GR-01: Emisión exitosa — SRI autoriza
  // ==========================================
  it('U-GR-01: Emisión exitosa retorna GuiaRemisionResponseDto con success=true', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202606092438363100110010010000000161245294016',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      xmlAutorizado: '<guiaRemision>autorizado</guiaRemision>',
      mensajes: [],
    });

    const result = await service.emitirGuiaRemision(createValidDto());

    expect(result.success).toBe(true);
    expect(result.estado).toBe('AUTORIZADO');
    expect(result.claveAcceso).toHaveLength(49);
    expect(result.fechaAutorizacion).toBeDefined();
  });

  // ==========================================
  // U-GR-02: SRI devuelve comprobante (DEVUELTA)
  // ==========================================
  it('U-GR-02: SRI devuelve comprobante → estado=DEVUELTA', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202606092438363100110010010000000161245294016',
      estado: 'DEVUELTA',
      mensajes: [{ identificador: 'ERROR_1', mensaje: 'Campo inválido', tipo: 'ERROR' }],
    });

    const result = await service.emitirGuiaRemision(createValidDto());

    expect(result.success).toBe(false);
    expect(result.estado).toBe('DEVUELTA');
    expect(result.mensajes).toHaveLength(1);
  });

  // ==========================================
  // U-GR-03: SRI rechaza comprobante (RECHAZADO)
  // ==========================================
  it('U-GR-03: SRI rechaza → estado=RECHAZADO', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202606092438363100110010010000000161245294016',
      estado: 'RECHAZADO',
      mensajes: [{ identificador: 'ERROR_2', mensaje: 'Firma inválida', tipo: 'ERROR' }],
    });

    const result = await service.emitirGuiaRemision(createValidDto());

    expect(result.success).toBe(false);
    expect(result.estado).toBe('RECHAZADO');
  });

  // ==========================================
  // U-GR-04: Emisor no encontrado
  // ==========================================
  it('U-GR-04: Emisor no encontrado → lanza error', async () => {
    repository.findEmisorByRuc.mockResolvedValue(null as any);

    await expect(service.emitirGuiaRemision(createValidDto())).rejects.toThrow();
  });

  // ==========================================
  // U-GR-05: Emisor sin certificado P12
  // ==========================================
  it('U-GR-05: Emisor sin certificado P12 → lanza BadRequestException', async () => {
    repository.findEmisorByRuc.mockResolvedValue({
      ...mockEmisor,
      certificado_p12: null,
    } as any);

    await expect(service.emitirGuiaRemision(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-GR-06: Punto de emisión no encontrado
  // ==========================================
  it('U-GR-06: Punto de emisión no encontrado → lanza BadRequestException', async () => {
    repository.findPuntoEmision.mockResolvedValue(null as any);

    await expect(service.emitirGuiaRemision(createValidDto())).rejects.toThrow(BadRequestException);
  });

  // ==========================================
  // U-GR-07: Secuencial manual se respeta
  // ==========================================
  it('U-GR-07: Secuencial manual se respeta y no consulta BD', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202606092438363100110010010000000161245294016',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    dto.secuencial = '000000123';

    await service.emitirGuiaRemision(dto);

    expect(repository.getNextSecuencial).not.toHaveBeenCalled();
  });

  // ==========================================
  // U-GR-08: Validación de identificación del transportista falla
  // ==========================================
  it('U-GR-08: Identificación transportista inválida → lanza error antes de buscar emisor', async () => {
    base.validarIdentificacion.mockImplementation(() => {
      throw new BadRequestException('RUC inválido');
    });

    await expect(service.emitirGuiaRemision(createValidDto())).rejects.toThrow(BadRequestException);
    expect(repository.findEmisorByRuc).not.toHaveBeenCalled();
  });

  // ==========================================
  // U-GR-09: Clave de acceso generada con tipo GUIA_REMISION (06)
  // ==========================================
  it('U-GR-09: Clave de acceso se genera con tipoComprobante=06', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202606092438363100110010010000000161245294016',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await service.emitirGuiaRemision(createValidDto());

    expect(claveAccesoService.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        tipoComprobante: '06',
        ruc: '0924383631001',
      }),
    );
  });

  // ==========================================
  // U-GR-10: XML se construye y firma
  // ==========================================
  it('U-GR-10: XML se construye y se firma con certificado del emisor', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202606092438363100110010010000000161245294016',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await service.emitirGuiaRemision(createValidDto());

    expect(xmlBuilderService.buildGuiaRemision).toHaveBeenCalledTimes(1);
    expect(xmlSignerService.signXmlForEmisor).toHaveBeenCalledWith(
      expect.any(String),
      '0924383631001',
    );
  });

  // ==========================================
  // U-GR-11: Persistencia fallida emite evento persistencia_fallida
  // ==========================================
  it('U-GR-11: Falla en persistencia emite comprobante.persistencia_fallida', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    repository.createComprobante.mockRejectedValue(new Error('DB connection lost'));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202606092438363100110010010000000161245294016',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    await expect(service.emitirGuiaRemision(createValidDto())).rejects.toThrow('DB connection lost');

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.persistencia_fallida',
      expect.objectContaining({
        claveAcceso: expect.any(String),
        error: 'DB connection lost',
        tipoComprobante: '06',
      }),
    );
  });

  // ==========================================
  // U-GR-12: Ambiente por defecto cuando no se especifica
  // ==========================================
  it('U-GR-12: Usa ambiente por defecto (PRUEBAS) cuando dto no lo especifica', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202606092438363100110010010000000161245294016',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    delete (dto as any).ambiente;

    await service.emitirGuiaRemision(dto);

    expect(base.getDefaultAmbiente).toHaveBeenCalled();
    expect(claveAccesoService.generate).toHaveBeenCalledWith(
      expect.objectContaining({ ambiente: Ambiente.PRUEBAS }),
    );
  });

  // ==========================================
  // U-GR-13: mapResultToGuiaRemisionResponse mapea correctamente
  // ==========================================
  it('U-GR-13: mapResultToGuiaRemisionResponse mapea todos los campos', () => {
    const result = {
      success: true,
      claveAcceso: '1234567890123456789012345678901234567890123456789',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: 'AUTH-001',
      xmlAutorizado: '<xml/>',
      mensajes: [{ identificador: 'INFO', mensaje: 'OK', tipo: 'INFORMATIVO' }],
    };

    const response = (service as any).mapResultToGuiaRemisionResponse(result);

    expect(response.success).toBe(true);
    expect(response.claveAcceso).toBe(result.claveAcceso);
    expect(response.estado).toBe('AUTORIZADO');
    expect(response.fechaAutorizacion).toBe(result.fechaAutorizacion);
    expect(response.numeroAutorizacion).toBe('AUTH-001');
    expect(response.xmlAutorizado).toBe('<xml/>');
    expect(response.mensajes).toHaveLength(1);
  });

  // ==========================================
  // U-GR-14: SRI timeout → relanza error
  // ==========================================
  it('U-GR-14: SRI timeout → relanza error', async () => {
    sriSoapClient.enviarYAutorizar.mockRejectedValue(new Error('SRI timeout'));

    await expect(service.emitirGuiaRemision(createValidDto())).rejects.toThrow('SRI timeout');
  });

  // ==========================================
  // U-GR-15: Info adicional se persiste cuando existe
  // ==========================================
  it('U-GR-15: Info adicional se persiste cuando existe en el DTO', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202606092438363100110010010000000161245294016',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    dto.infoAdicional = [{ nombre: 'observacion', valor: 'Traslado urgente' }];

    await service.emitirGuiaRemision(dto);

    expect(repository.createInfoAdicional).toHaveBeenCalled();
  });

  // ==========================================
  // U-GR-16: Múltiples destinatarios se validan
  // ==========================================
  it('U-GR-16: Múltiples destinatarios se validan correctamente', async () => {
    repository.executeInTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202606092438363100110010010000000161245294016',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1234567890',
      mensajes: [],
    });

    const dto = createValidDto();
    dto.destinatarios.push({
      tipoIdentificacionDestinatario: '05',
      identificacionDestinatario: '0200123456',
      razonSocialDestinatario: 'María García',
      dirDestinatario: 'Av. Colón 789, Cuenca',
      motivoTraslado: 'Consignación',
      detalles: [
        { codigoInterno: 'PROD002', descripcion: 'Otro producto', cantidad: 5 },
      ],
    } as any);

    await service.emitirGuiaRemision(dto);

    // validarIdentificacion se llama para transportista + 2 destinatarios = 3 veces
    expect(base.validarIdentificacion).toHaveBeenCalledTimes(3);
  });

  // ==========================================
  // U-GR-17: Emisión exitosa emite comprobante.autorizado
  // ==========================================
  it('U-GR-17: Emisión exitosa emite comprobante.autorizado con tipoComprobante=06', async () => {
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: true,
      claveAcceso: '0702202606092438363100110010010000000199999999018',
      estado: 'AUTORIZADO',
      fechaAutorizacion: '2026-02-07T12:00:00Z',
      numeroAutorizacion: '1122334455',
      mensajes: [],
    });

    await service.emitirGuiaRemision(createValidDto());

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.autorizado',
      expect.objectContaining({
        claveAcceso: '0702202606092438363100110010010000000199999999018',
        tipoComprobante: '06',
        secuencial: expect.any(String),
        fechaAutorizacion: expect.any(String),
        numeroAutorizacion: expect.any(String),
      }),
    );
  });

  // ==========================================
  // U-GR-18: Comprobante DEVUELTA emite comprobante.rechazado
  // ==========================================
  it('U-GR-18: Comprobante DEVUELTA emite comprobante.rechazado', async () => {
    sriSoapClient.enviarYAutorizar.mockResolvedValue({
      success: false,
      claveAcceso: '0702202606092438363100110010010000000199999999018',
      estado: 'DEVUELTA',
      mensajes: [{ identificador: '01', mensaje: 'Error de validación', tipo: 'ERROR' }],
    });

    await service.emitirGuiaRemision(createValidDto());

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'comprobante.rechazado',
      expect.objectContaining({
        tipoComprobante: '06',
        estado: 'DEVUELTA',
      }),
    );
  });
});
