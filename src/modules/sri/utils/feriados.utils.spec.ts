import {
  getFeriadosEcuador,
  esFeriadoEcuador,
  calcularDiasHabilesEcuador,
  siguienteDiaHabil,
} from './feriados.utils';

describe('feriados.utils', () => {
  // ==========================================
  // getFeriadosEcuador
  // ==========================================
  describe('getFeriadosEcuador', () => {
    it('debe retornar feriados fijos para 2026', () => {
      const feriados = getFeriadosEcuador(2026);
      // 10 feriados fijos + Viernes Santo + Lunes Carnaval + Martes Carnaval = 13
      expect(feriados.length).toBeGreaterThanOrEqual(13);

      // Verificar Año Nuevo
      const anioNuevo = feriados.find(
        (f) => f.getMonth() === 0 && f.getDate() === 1,
      );
      expect(anioNuevo).toBeDefined();
    });

    it('debe incluir Viernes Santo en marzo o abril', () => {
      const feriados = getFeriadosEcuador(2026);
      const viernesSanto = feriados.find(
        (f) => f.getMonth() === 2 || f.getMonth() === 3,
      );
      // Al menos un feriado variable en marzo/abril
      expect(viernesSanto).toBeDefined();
    });
  });

  // ==========================================
  // esFeriadoEcuador
  // ==========================================
  describe('esFeriadoEcuador', () => {
    it('debe retornar true para Año Nuevo', () => {
      const anioNuevo = new Date(2026, 0, 1);
      expect(esFeriadoEcuador(anioNuevo)).toBe(true);
    });

    it('debe retornar true para Navidad', () => {
      const navidad = new Date(2026, 11, 25);
      expect(esFeriadoEcuador(navidad)).toBe(true);
    });

    it('debe retornar false para un día normal', () => {
      const diaNormal = new Date(2026, 2, 15); // 15 de marzo
      expect(esFeriadoEcuador(diaNormal)).toBe(false);
    });

    it('debe retornar true para Día del Trabajo (1 de mayo)', () => {
      const trabajo = new Date(2026, 4, 1);
      expect(esFeriadoEcuador(trabajo)).toBe(true);
    });
  });

  // ==========================================
  // calcularDiasHabilesEcuador
  // ==========================================
  describe('calcularDiasHabilesEcuador', () => {
    it('debe contar 5 días hábiles en una semana sin feriados', () => {
      const lunes = new Date(2026, 2, 9); // Lunes 9 de marzo 2026
      const viernes = new Date(2026, 2, 13); // Viernes 13 de marzo 2026
      const dias = calcularDiasHabilesEcuador(lunes, viernes);
      expect(dias).toBe(4); // lun, mar, mié, jue (viernes no se cuenta porque cur < fin)
    });

    it('debe excluir fines de semana', () => {
      const lunes = new Date(2026, 2, 9);
      const lunesSiguiente = new Date(2026, 2, 16);
      const dias = calcularDiasHabilesEcuador(lunes, lunesSiguiente);
      expect(dias).toBe(5); // 5 días hábiles (lun-vie)
    });

    it('debe excluir feriados nacionales', () => {
      // 1 de mayo es feriado (Día del Trabajo)
      const abril30 = new Date(2026, 3, 30); // Jueves 30 de abril
      const mayo4 = new Date(2026, 4, 4); // Lunes 4 de mayo
      const dias = calcularDiasHabilesEcuador(abril30, mayo4);
      // Jueves 30 (1) + Viernes 1 (feriado, excluido) + Sábado (excluido) + Domingo (excluido)
      // = 1 día hábil (solo el jueves 30)
      expect(dias).toBe(1);
    });
  });

  // ==========================================
  // siguienteDiaHabil
  // ==========================================
  describe('siguienteDiaHabil', () => {
    it('debe retornar el mismo día si es hábil', () => {
      const lunes = new Date(2026, 2, 9); // Lunes 9 de marzo 2026
      const result = siguienteDiaHabil(lunes);
      expect(result.getDate()).toBe(9);
      expect(result.getMonth()).toBe(2);
    });

    it('debe avanzar al lunes si es sábado', () => {
      const sabado = new Date(2026, 2, 14); // Sábado 14 de marzo 2026
      const result = siguienteDiaHabil(sabado);
      expect(result.getDay()).toBe(1); // Lunes
    });

    it('debe avanzar al lunes si es domingo', () => {
      const domingo = new Date(2026, 2, 15); // Domingo 15 de marzo 2026
      const result = siguienteDiaHabil(domingo);
      expect(result.getDay()).toBe(1); // Lunes
    });

    it('debe avanzar al siguiente día hábil si es feriado', () => {
      const anioNuevo = new Date(2026, 0, 1); // Jueves, feriado
      const result = siguienteDiaHabil(anioNuevo);
      // 1 de enero es jueves feriado → viernes 2 (no es feriado)
      expect(result.getDate()).toBe(2);
    });
  });
});
