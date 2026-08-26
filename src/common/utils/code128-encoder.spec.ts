import { encodeCode128, injectBarcodeIfClave } from './code128-encoder';

describe('encodeCode128', () => {
  describe('validaciones de entrada', () => {
    it('lanza error si data contiene caracteres no numéricos', () => {
      expect(() => encodeCode128('12A45')).toThrow('numérico');
      expect(() => encodeCode128('PJJ123C')).toThrow('numérico');
    });

    it('lanza error si data está vacío', () => {
      expect(() => encodeCode128('')).toThrow('vacío');
    });

    it('acepta ceros al inicio (prefijo válido en claves del SRI)', () => {
      expect(() =>
        encodeCode128('0000000000000000000000000000000000000000000000000'),
      ).not.toThrow();
    });
  });

  describe('mapeo fuente Code 128 (ASCII/Latin-1 con OS/2 parcheado)', () => {
    // Mapping por cmap subtable plat=0 enc=3 fmt=4:
    //   value 0..94  -> chr(V + 32)  (ASCII imprimible U+0020..U+007E)
    //   value 95..106 -> chr(V + 105) (Latin-1 Supplement U+00C8..U+00D3)
    // Confiamos en OS/2 parcheado (bits 0, 48, 57) para que LibreOffice no sustituya.
    it('value 0 (pair "00") -> chr(32) = espacio ASCII', () => {
      const r = encodeCode128('00');
      expect(r.charCodeAt(1)).toBe(32); // ASCII ' '
    });

    it('value 20 (pair "20") -> chr(52) = "4"', () => {
      const r = encodeCode128('20');
      expect(r.charCodeAt(1)).toBe(52); // '4' (52 = 20 + 32)
    });

    it('value 26 (pair "26") -> chr(58) = ":"', () => {
      const r = encodeCode128('26');
      expect(r.charCodeAt(1)).toBe(58); // ':' (58 = 26 + 32)
    });

    it('value 49 (pair "49") -> chr(81) = "Q"', () => {
      const r = encodeCode128('49');
      expect(r.charCodeAt(1)).toBe(81); // 'Q' (81 = 49 + 32)
    });

    it('value 56 (pair "56") -> chr(88) = "X"', () => {
      const r = encodeCode128('56');
      expect(r.charCodeAt(1)).toBe(88); // 'X' (88 = 56 + 32)
    });

    it('value 94 -> chr(126) = "~"', () => {
      const r = encodeCode128('94');
      expect(r.charCodeAt(1)).toBe(126); // '~' (94 + 32 = 126)
    });

    it('value 95 -> chr(200) = "È" (Latin-1 Supplement inicio)', () => {
      const r = encodeCode128('95');
      expect(r.charCodeAt(1)).toBe(200); // 'È' (200 = 95 + 105)
    });

    it('value 99 -> chr(204) = "Ì"', () => {
      const r = encodeCode128('99');
      expect(r.charCodeAt(1)).toBe(204); // 'Ì' (99 + 105 = 204)
    });

    it('value 100 (CODE_B switch) -> chr(205) = "Í"', () => {
      const r = encodeCode128('123');
      expect(r.charCodeAt(2)).toBe(205); // CODE_B switch Í (100 + 105)
    });

    it('value 104 (START_B) -> chr(209) = "Ñ"', () => {
      const r = encodeCode128('7');
      expect(r.charCodeAt(0)).toBe(209); // START_B Ñ (104 + 105)
    });

    it('value 105 (START_C) -> chr(210) = "Ò"', () => {
      const r = encodeCode128('12');
      expect(r.charCodeAt(0)).toBe(210); // START_C Ò (105 + 105)
    });

    it('value 106 (STOP) -> chr(211) = "Ó"', () => {
      const r = encodeCode128('12');
      expect(r.charCodeAt(r.length - 1)).toBe(211); // STOP Ó (106 + 105)
    });
  });

  describe('Code Set B (1 solo dígito)', () => {
    it('codifica "5" usando Code Set B desde el inicio', () => {
      // START_B(104) + '5' Code B (value 21) + check + STOP
      // check: (104×1 + 21×2) mod 103 = 146 mod 103 = 43
      const result = encodeCode128('5');
      expect(result.length).toBe(4);
      expect(result.charCodeAt(0)).toBe(209); // START_B -> Ñ
      expect(result.charCodeAt(1)).toBe(53); // '5' Code B value 21 -> chr(53) '5'
      expect(result.charCodeAt(2)).toBe(75); // check digit value 43 -> chr(75) 'K'
      expect(result.charCodeAt(3)).toBe(211); // STOP -> Ó
    });
  });

  describe('Code Set C puro (count par)', () => {
    it('codifica "12" como un par Code 128C', () => {
      // START_C(105) + pair '12'(12) + check + STOP
      // check: (105×1 + 12×2) mod 103 = 129 mod 103 = 26
      const result = encodeCode128('12');
      expect(result.length).toBe(4);
      expect(result.charCodeAt(0)).toBe(210); // START_C
      expect(result.charCodeAt(1)).toBe(44); // pair 12 value 12 -> chr(44) ','
      expect(result.charCodeAt(2)).toBe(58); // check digit value 26 -> chr(58) ':'
      expect(result.charCodeAt(3)).toBe(211); // STOP
    });

    it('codifica "00" como value 0 -> chr(32) = espacio ASCII', () => {
      const result = encodeCode128('00');
      expect(result.charCodeAt(1)).toBe(32); // value 0 -> espacio
      // check: (105×1 + 0×2) mod 103 = 105 mod 103 = 2 -> chr(34) '"'
      expect(result.charCodeAt(2)).toBe(34); // check digit value 2
    });

    it('codifica "99" como value 99 -> chr(204) = "Ì"', () => {
      const result = encodeCode128('99');
      expect(result.charCodeAt(1)).toBe(204); // value 99
    });
  });

  describe('Code Set C + B (count impar, caso claveAcceso 49 dígitos)', () => {
    it('codifica 49 dígitos terminados en "5"', () => {
      const clave = '0802202701100212755100110010010000000041581102815';
      const result = encodeCode128(clave);
      // Estructura: START_C + 24 pares + CODE_B + 1 dígito + check + STOP = 29 chars
      expect(clave.length).toBe(49);
      expect(result.length).toBe(29);
      expect(result.charCodeAt(0)).toBe(210); // START_C -> Ò
      expect(result.charCodeAt(25)).toBe(205); // CODE_B switch -> Í
      expect(result.charCodeAt(26)).toBe(53); // '5' Code B value 21 -> chr(53) '5'
      expect(result.charCodeAt(28)).toBe(211); // STOP -> Ó
    });

    it('codifica 49 dígitos terminados en "9"', () => {
      const clave9 = '0802202701100212755100110010010000000041581102819';
      const result = encodeCode128(clave9);
      expect(result.length).toBe(29);
      expect(result.charCodeAt(0)).toBe(210); // START_C
      expect(result.charCodeAt(25)).toBe(205); // CODE_B switch
      expect(result.charCodeAt(26)).toBe(57); // '9' Code B value 25 -> chr(57) '9'
      expect(result.charCodeAt(28)).toBe(211); // STOP
    });

    it('codifica todos los dígitos finales 0-9 (cobertura completa)', () => {
      const base = '080220270110021275510011001001000000004158110281';
      for (let d = 0; d <= 9; d++) {
        const clave = base + d.toString();
        const result = encodeCode128(clave);
        expect(result.length).toBe(29);
        expect(result.charCodeAt(0)).toBe(210); // START_C
        expect(result.charCodeAt(25)).toBe(205); // CODE_B switch
        // Code B value for digit d = d + 16 (0->16, 9->25); ASCII = chr(d + 16 + 32) = chr(d + 48)
        expect(result.charCodeAt(26)).toBe(d + 48);
        expect(result.charCodeAt(28)).toBe(211); // STOP
      }
    });
  });

  describe('dígito verificador', () => {
    it('check digit se calcula como Σ(value × position) mod 103', () => {
      // "1234" -> START_C + 12 + 34 + check + STOP
      // check: (105×1 + 12×2 + 34×3) mod 103 = 231 mod 103 = 25
      const result = encodeCode128('1234');
      expect(result.length).toBe(5);
      expect(result.charCodeAt(0)).toBe(210); // START_C
      expect(result.charCodeAt(1)).toBe(44); // pair 12 value 12 -> chr(44) ','
      expect(result.charCodeAt(2)).toBe(66); // pair 34 value 34 -> chr(66) 'B'
      expect(result.charCodeAt(3)).toBe(57); // check digit value 25 -> chr(57) '9'
      expect(result.charCodeAt(4)).toBe(211); // STOP
    });
  });

  describe('Output no produce PUA chars (compatibilidad OS/2 + ASCII)', () => {
    it('todos los chars están en ASCII range (32..126) o Latin-1 (200..211)', () => {
      const inputs = [
        '0',
        '9',
        '00',
        '99',
        '0802202701100212755100110010010000000041581102815',
        '1234567890123456789012345678901234567890123456789',
      ];
      for (const input of inputs) {
        const r = encodeCode128(input);
        for (let i = 0; i < r.length; i++) {
          const cp = r.charCodeAt(i);
          const inAscii = cp >= 32 && cp <= 126;
          const inLatin1 = cp >= 200 && cp <= 211;
          expect(inAscii || inLatin1).toBe(true);
        }
      }
    });
  });
});

describe('injectBarcodeIfClave', () => {
  it('inyecta claveAccesoBarcode cuando infoTributaria.claveAcceso existe', () => {
    const data: any = {
      infoTributaria: {
        claveAcceso: '0802202701100212755100110010010000000041581102815',
        estab: '001',
      },
      infoFactura: { razonSocialComprador: 'Test' },
    };
    const result = injectBarcodeIfClave(data);
    expect(result).toBe(data);
    expect(data.infoTributaria.claveAccesoBarcode).toBeDefined();
    expect(typeof data.infoTributaria.claveAccesoBarcode).toBe('string');
    expect(data.infoTributaria.claveAccesoBarcode.length).toBe(29);
  });

  it('no hace nada si no existe infoTributaria', () => {
    const data: any = { otroCampo: 'x' };
    const result = injectBarcodeIfClave(data);
    expect(result).toBe(data);
    expect(data.infoTributaria).toBeUndefined();
    expect(data.claveAccesoBarcode).toBeUndefined();
  });

  it('no hace nada si infoTributaria.claveAcceso no existe', () => {
    const data: any = { infoTributaria: { estab: '001' } };
    const result = injectBarcodeIfClave(data);
    expect(result).toBe(data);
    expect(data.infoTributaria.claveAccesoBarcode).toBeUndefined();
  });

  it('no hace nada si infoTributaria.claveAcceso no es string', () => {
    const data: any = { infoTributaria: { claveAcceso: 12345 } };
    const result = injectBarcodeIfClave(data);
    expect(result).toBe(data);
    expect(data.infoTributaria.claveAccesoBarcode).toBeUndefined();
  });

  it('mantiene el valor original de claveAcceso (no lo modifica)', () => {
    const clave = '0802202701100212755100110010010000000041581102815';
    const data: any = { infoTributaria: { claveAcceso: clave } };
    injectBarcodeIfClave(data);
    expect(data.infoTributaria.claveAcceso).toBe(clave);
    expect(data.infoTributaria.claveAccesoBarcode).not.toBe(clave);
  });
});