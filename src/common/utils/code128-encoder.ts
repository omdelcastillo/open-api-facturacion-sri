/**
 * Code 128 encoder para la fuente `Code 128` de grandzebu.net
 * (descargada desde https://carbone.io/file/code128.ttf).
 *
 * Convierte un string numérico en un string de caracteres que la fuente
 * `Code 128` renderiza como un barcode Code 128 scannable, completo con
 * código de inicio, código de cambio (si aplica), dígito verificador y STOP.
 *
 * Usa Code Set C (pares densos) para pares de dígitos, y Code Set B para el
 * último dígito suelto cuando el count es impar (caso típico de clave de
 * acceso de 49 dígitos del SRI Ecuador).
 *
 * Mapeo a fuente grandzebu: cada value V se mapea al carácter Unicode
 * `chr(V + 102)` que la fuente convierte en el glyph de barras correspondiente.
 *
 * Referencias:
 *  - https://en.wikipedia.org/wiki/Code_128
 *  - https://grandzebu.net/informatique/codbar-en/code128.htm
 */

const START_CODE_C = 105;
const START_CODE_B = 104;
const CODE_B_SWITCH = 100;
const STOP = 106;

/**
 * Mapea un Code 128 value (0-106) al carácter Unicode que la fuente
 * `Code 128` de grandzebu.net renderiza como el glyph de barras correspondiente.
 *
 * Tabla oficial (paired con cmap TTF subtable plat=0 enc=3 fmt=4):
 *  - Values 0..94   → chr(V + 32)  (U+0020..U+007E)  (ASCII imprimible: ' ' a '~')
 *  - Values 95..106 → chr(V + 105) (U+00C8..U+00D3) (Latin-1 Supplement: 'È' a 'Ó')
 *
 * IMPORTANTE: Antes usábamos PUA (U+F020+V) para evitar sustitución de
 * fuente por parte de LibreOffice. Sin embargo, LibreOffice (incluido el
 * de Carbone EE dentro del contenedor docker) NO rinde glyphs visibles para
 * PUA chars en este font (la tabla OS/2 sin Unicode Coverage bits = Libre
 * sustituye con NOTDEF = invisible). Por eso el lector leía "algunos pares
 * mal" o "patrones mixtos" — el font nunca llegaba a aplicarse correctamente.
 *
 * Hemos parcheado la tabla OS/2 del font (`code128.ttf`) declarando los bits
 * 0 (Basic Latin), 48 (Latin-1 Supplement) y 57 (PUA) en ulUnicodeRange1/2.
 * Con eso, LibreOffice respeta Code 128 como font activo para los chars
 * ASCII/Latin-1 en el rango de cmap plat=0, evitando la sustitución.
 *
 * El cmap plat=0 fmt=4 segmento [0x20-0x7E, delta=-29] entrega exactamente
 * gid = (cp - 29) para cada ASCII codepoint — equivalentemente, gid = V + 3
 * (donde V es el Code value). Y el segmento [0xC8-0xD3, delta=-102] entrega
 * gid = V + 3 para los high-code values 95..106 (chars È a Ó). Por tanto:
 *   - ASCII '4' (cp 0x34) → gid 23 → glyph Code value 20 (pattern 221231)
 *   - Latin-1 'Ò' (cp 0xD2) → gid 108 → glyph Code value 105 (START_C)
 *
 * Fuente: code128.ttf de grandzebu.net (carbone.io/file/code128.ttf),
 * parcheada en OS/2 con bits 0, 48, 57.
 */
function valueToChar(value: number): string {
  if (value <= 94) {
    return String.fromCharCode(value + 32);
  }
  return String.fromCharCode(value + 105);
}

function calcCheckDigit(values: number[]): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] * (i + 1);
  }
  return sum % 103;
}

function digitToCodeB(d: string): number {
  return d.charCodeAt(0) - '0'.charCodeAt(0) + 16;
}

function pairToCodeC(pair: string): number {
  return parseInt(pair, 10);
}

/**
 * Codifica un string numérico (solo dígitos 0-9) como Code 128.
 *
 * - Length 1: usa Code Set B desde el inicio.
 * - Length par: usa puro Code Set C (pares densos).
 * - Length impar (ej. 49 dígitos de clave de acceso SRI):
 *   Code Set C para los primeros (n-1) dígitos + Code Set B para el último
 *   dígito suelto, con un código de cambio CODE_B entre ambos.
 *
 * El dígito verificador se calcula usando la fórmula oficial de Code 128:
 *   checksum = Σ(value × position) mod 103, donde position 1 = START.
 *
 * @param data String numérico (solo dígitos 0-9, no vacío).
 * @returns String de caracteres que la fuente `Code 128` renderiza como barras.
 * @throws Error si `data` no es numérico o está vacío.
 */
export function encodeCode128(data: string): string {
  if (!/^\d+$/.test(data)) {
    throw new Error(
      `encodeCode128: data debe ser un string numérico (solo dígitos 0-9). Recibido: "${data}"`,
    );
  }
  if (data.length === 0) {
    throw new Error('encodeCode128: data no puede estar vacío');
  }

  const values: number[] = [];

  if (data.length === 1) {
    values.push(START_CODE_B);
    values.push(digitToCodeB(data));
  } else if (data.length % 2 === 0) {
    values.push(START_CODE_C);
    for (let i = 0; i < data.length; i += 2) {
      values.push(pairToCodeC(data.substring(i, i + 2)));
    }
  } else {
    values.push(START_CODE_C);
    const evenLength = data.length - 1;
    for (let i = 0; i < evenLength; i += 2) {
      values.push(pairToCodeC(data.substring(i, i + 2)));
    }
    values.push(CODE_B_SWITCH);
    values.push(digitToCodeB(data[evenLength]));
  }

  const checkDigit = calcCheckDigit(values);
  values.push(checkDigit);
  values.push(STOP);

  return values.map(valueToChar).join('');
}

/**
 * Función utilitaria para inyectar `claveAccesoBarcode` en un objeto de datos
 * que contiene `infoTributaria.claveAcceso`. Mutacional (muta `data`).
 * Idempotente: si no existe `infoTributaria.claveAcceso`, no hace nada.
 *
 * Pensada para usarse en controladores antes de pasar el JSON a Carbone,
 * de modo que el template solo use `{d.infoTributaria.claveAccesoBarcode}`
 * (sin formatter, que es la forma soportada por Carbone Community Edition).
 */
export function injectBarcodeIfClave<T extends Record<string, any>>(data: T): T {
  const clave =
    data?.infoTributaria?.claveAcceso && typeof data.infoTributaria.claveAcceso === 'string'
      ? data.infoTributaria.claveAcceso
      : null;
  if (clave) {
    data.infoTributaria.claveAccesoBarcode = encodeCode128(clave);
  }
  return data;
}