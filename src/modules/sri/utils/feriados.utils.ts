/**
 * Feriados nacionales del Ecuador.
 * Incluye feriados fijos (fecha constante cada año) y variables
 * (Semana Santa: calculada por algoritmo de Gauss).
 *
 * Fuente: Código del Trabajo del Ecuador, Art. 65.
 */

/**
 * Retorna los feriados nacionales del Ecuador para un año dado.
 * Las fechas están en zona horaria local (sin offset UTC).
 */
export function getFeriadosEcuador(year: number): Date[] {
  const feriados: Date[] = [];

  // Feriados fijos (mm-dd)
  const feriadosFijos = [
    '01-01', // Año Nuevo
    '05-01', // Día del Trabajo
    '05-24', // Batalla del Pichincha
    '07-24', // Natalicio de Simón Bolívar
    '08-10', // Primer Grito de Independencia
    '10-09', // Independencia de Guayaquil
    '11-02', // Día de los Difuntos
    '11-03', // Independencia de Cuenca
    '12-06', // Fundación de Quito
    '12-25', // Navidad
  ];

  for (const mmdd of feriadosFijos) {
    const [month, day] = mmdd.split('-').map(Number);
    feriados.push(new Date(year, month - 1, day));
  }

  // Semana Santa (Viernes Santo) — calculado por algoritmo de Gauss
  const viernesSanto = calcularViernesSanto(year);
  feriados.push(viernesSanto);

  // Carnaval (lunes y martes) — 48 días antes del Viernes Santo
  const lunesCarnaval = new Date(viernesSanto);
  lunesCarnaval.setDate(viernesSanto.getDate() - 48);
  const martesCarnaval = new Date(viernesSanto);
  martesCarnaval.setDate(viernesSanto.getDate() - 47);
  feriados.push(lunesCarnaval, martesCarnaval);

  return feriados;
}

/**
 * Verifica si una fecha es feriado nacional en Ecuador.
 */
export function esFeriadoEcuador(date: Date): boolean {
  const feriados = getFeriadosEcuador(date.getFullYear());
  return feriados.some((f) => esMismoDia(f, date));
}

/**
 * Calcula los días hábiles entre dos fechas, excluyendo
 * fines de semana (sábado y domingo) y feriados nacionales del Ecuador.
 */
export function calcularDiasHabilesEcuador(inicio: Date, fin: Date): number {
  let count = 0;
  const cur = new Date(inicio);
  while (cur < fin) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6 && !esFeriadoEcuador(cur)) {
      count++;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * Calcula el próximo día hábil si la fecha cae en fin de semana o feriado.
 * Per NAC-DGERCGC25-00000017: "si esa fecha coincide con días de descanso
 * obligatorio o feriados nacionales o locales, se podrán anular hasta el
 * siguiente día hábil."
 */
export function siguienteDiaHabil(date: Date): Date {
  const result = new Date(date);
  while (result.getDay() === 0 || result.getDay() === 6 || esFeriadoEcuador(result)) {
    result.setDate(result.getDate() + 1);
  }
  return result;
}

// ── Helpers privados ──────────────────────────────────────────

function esMismoDia(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Algoritmo de Gauss para calcular el Viernes Santo (Domingo de Pascua - 2 días).
 */
function calcularViernesSanto(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1; // 0-indexed
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  const domingoPascua = new Date(year, month, day);
  const viernesSanto = new Date(domingoPascua);
  viernesSanto.setDate(domingoPascua.getDate() - 2);
  return viernesSanto;
}
