/**
 * Dataset de prueba que CUADRA EXACTAMENTE. Sirve como fixture y como test de referencia
 * del motor de prorrateo: cualquier implementación debe reproducir estos números al peso.
 *
 * Convenciones:
 *  - Importes en CENTAVOS (enteros). $7.156.250,00 => 715_625_000
 *  - Coeficientes en millonésimas de %: 12,500% => 12_500_000. Suma del padrón = 100_000_000.
 */
import type { z } from 'zod';

export const CONSORCIO = {
  id: 'c-04',
  codigo: 'C-04',
  nombre: 'Barrio Los Álamos',
  cuit: '30-71422908-4',
  direccion: 'Ruta 8 km 42',
  localidad: 'Pilar, Buenos Aires',
  tenantId: 't-01',
  sectores: [
    { id: 's-a', nombre: 'A · Torres' },
    { id: 's-b', nombre: 'B · Lotes' },
    { id: 's-c', nombre: 'C · Duplex' },
    { id: 's-d', nombre: 'D · Cocheras' },
  ],
  reglas: {
    baseRepartoDefault: 'COEFICIENTE',
    diaPrimerVencimiento: 5,
    diaSegundoVencimiento: 15,
    recargoSegundoVencimiento: 0.05,
    interesMoraMensual: 0.045,
    interesCapitalizable: false,
    imputacionPagos: 'DEUDA_MAS_ANTIGUA',
    fondoReservaPorcentaje: 0.03,
    requiereAprobacionConsejo: false,
    publicaEnPortalAlEmitir: true,
  },
} as const;

/** 8 UF. Suma de coeficientes = 100_000_000 (100,000%). */
export const UNIDADES = [
  { id: 'uf-a101', codigo: 'A-101', sectorId: 's-a', superficieM2: 124, coeficiente: 12_500_000, titular: 'Fernández, María',   ocupacion: 'PROPIETARIO',  saldoAnterior: 0 },
  { id: 'uf-a102', codigo: 'A-102', sectorId: 's-a', superficieM2: 112, coeficiente: 12_500_000, titular: 'Kovacs, Laura',      ocupacion: 'PROPIETARIO',  saldoAnterior: 0 },
  { id: 'uf-a104', codigo: 'A-104', sectorId: 's-a', superficieM2:  98, coeficiente: 12_500_000, titular: 'Bianchi, Néstor',    ocupacion: 'CONDOMINIO',   saldoAnterior: 0 },
  { id: 'uf-b014', codigo: 'B-014', sectorId: 's-b', superficieM2: 240, coeficiente: 15_000_000, titular: 'Ríos Hnos. SRL',     ocupacion: 'ALQUILADA',    saldoAnterior: 0 },
  { id: 'uf-b015', codigo: 'B-015', sectorId: 's-b', superficieM2: 106, coeficiente: 12_500_000, titular: 'Duarte, Sofía',      ocupacion: 'ALQUILADA',    saldoAnterior: 0 },
  { id: 'uf-c208', codigo: 'C-208', sectorId: 's-c', superficieM2:  88, coeficiente: 12_500_000, titular: 'Alsina, Rodolfo',    ocupacion: 'PROPIETARIO',  saldoAnterior: 100_000_000 },
  { id: 'uf-c311', codigo: 'C-311', sectorId: 's-c', superficieM2:  92, coeficiente: 12_500_000, titular: 'Ferrari, Nadia',     ocupacion: 'PROPIETARIO',  saldoAnterior: 0 },
  { id: 'uf-d031', codigo: 'D-031', sectorId: 's-d', superficieM2:  18, coeficiente: 10_000_000, titular: 'Sucesión Peralta',   ocupacion: 'EN_SUCESION',  saldoAnterior: 0 },
] as const;

export const RUBROS = [
  { id: 'r-sueldos',   nombre: 'Sueldos y cargas sociales', tipo: 'ORDINARIO',      baseReparto: 'COEFICIENTE', sectorId: null,  importe: 3_000_000_000 },
  { id: 'r-vigilancia',nombre: 'Seguridad y vigilancia',    tipo: 'ORDINARIO',      baseReparto: 'COEFICIENTE', sectorId: null,  importe: 2_000_000_000 },
  { id: 'r-verdes',    nombre: 'Espacios verdes',           tipo: 'ORDINARIO',      baseReparto: 'COEFICIENTE', sectorId: null,  importe:   725_000_000 },
  { id: 'r-piscina',   nombre: 'Piscina y club house',      tipo: 'ORDINARIO',      baseReparto: 'SECTOR',      sectorId: 's-b', importe:   275_000_000 },
  { id: 'r-ascensores',nombre: 'Ascensores (cuota 2/6)',    tipo: 'EXTRAORDINARIO', baseReparto: 'COEFICIENTE', sectorId: null,  importe:    80_000_000 },
] as const;

/** Totales esperados del período 2026-07 */
export const ESPERADO = {
  gastoOrdinario:      6_000_000_000,  // $60.000.000
  gastoPorCoeficiente: 5_725_000_000,  // ordinario menos piscina
  gastoSector:           275_000_000,  // piscina, sólo sector B
  extraordinaria:         80_000_000,  // cuota 2/6
  fondoReserva:          180_000_000,  // 3% sobre ordinarias
  intereses:               4_500_000,  // 4,5% mensual sobre el saldo de C-208
  totalEmitido:        6_264_500_000,  // $62.645.000
} as const;

/** Detalle por UF esperado (centavos). */
export const DETALLE_ESPERADO = [
  { ufId: 'uf-a101', ordinarias: 715_625_000, sector:           0, extraordinarias: 10_000_000, fondoReserva: 22_500_000, intereses:         0, total:   748_125_000 },
  { ufId: 'uf-a102', ordinarias: 715_625_000, sector:           0, extraordinarias: 10_000_000, fondoReserva: 22_500_000, intereses:         0, total:   748_125_000 },
  { ufId: 'uf-a104', ordinarias: 715_625_000, sector:           0, extraordinarias: 10_000_000, fondoReserva: 22_500_000, intereses:         0, total:   748_125_000 },
  { ufId: 'uf-b014', ordinarias: 858_750_000, sector: 150_000_000, extraordinarias: 12_000_000, fondoReserva: 27_000_000, intereses:         0, total: 1_047_750_000 },
  { ufId: 'uf-b015', ordinarias: 715_625_000, sector: 125_000_000, extraordinarias: 10_000_000, fondoReserva: 22_500_000, intereses:         0, total:   873_125_000 },
  { ufId: 'uf-c208', ordinarias: 715_625_000, sector:           0, extraordinarias: 10_000_000, fondoReserva: 22_500_000, intereses: 4_500_000, total:   752_625_000 },
  { ufId: 'uf-c311', ordinarias: 715_625_000, sector:           0, extraordinarias: 10_000_000, fondoReserva: 22_500_000, intereses:         0, total:   748_125_000 },
  { ufId: 'uf-d031', ordinarias: 572_500_000, sector:           0, extraordinarias:  8_000_000, fondoReserva: 18_000_000, intereses:         0, total:   598_500_000 },
] as const;

export const CUENTAS = [
  { id: 'cta-galicia', banco: 'Banco Galicia', numero: '4110-8/9', tipo: 'CA_PESOS',      saldo: 1_486_090_200, admiteGastoOrdinario: true },
  { id: 'cta-nacion',  banco: 'Banco Nación',  numero: '2290-4/1', tipo: 'FONDO_RESERVA', saldo:   741_200_000, admiteGastoOrdinario: false },
  { id: 'cta-wallet',  banco: 'Cobros digitales', numero: 'links', tipo: 'BILLETERA',     saldo:   128_431_000, admiteGastoOrdinario: false },
] as const;

export const MOVIMIENTOS = [
  { id: 'mov-1', cuentaId: 'cta-galicia', fecha: '2026-07-04', descripcion: 'TRANSFERENCIA CVU · FERNANDEZ MARIA', importe:   748_125_000, cuitOrdenante: '27-28904112-3', referencia: '1849022', linkPagoId: null, esMovimientoInterno: false, matchEsperado: { tipo: 'UF', ufId: 'uf-a101' } },
  { id: 'mov-2', cuentaId: 'cta-galicia', fecha: '2026-07-05', descripcion: 'DEBIN · RIOS HNOS SRL',               importe: 1_047_750_000, cuitOrdenante: '30-70889201-7', referencia: '1849188', linkPagoId: 'lp_88102', esMovimientoInterno: false, matchEsperado: { tipo: 'UF', ufId: 'uf-b014' } },
  { id: 'mov-3', cuentaId: 'cta-galicia', fecha: '2026-07-08', descripcion: 'DEPÓSITO EFECTIVO · SUCURSAL PILAR',  importe:   124_000_000, cuitOrdenante: null,            referencia: '1851004', linkPagoId: null, esMovimientoInterno: false, matchEsperado: { tipo: 'SIN_CONCILIAR' } },
  { id: 'mov-4', cuentaId: 'cta-galicia', fecha: '2026-07-10', descripcion: 'PAGO PROVEEDOR · SEGURIDAD NORTE SA', importe: -2_000_000_000, cuitOrdenante: '30-70889201-7', referencia: '1852771', linkPagoId: null, esMovimientoInterno: false, matchEsperado: { tipo: 'PROVEEDOR', comprobanteId: 'cbte-vig-07' } },
  { id: 'mov-5', cuentaId: 'cta-nacion',  fecha: '2026-07-02', descripcion: 'TRANSFERENCIA INTERNA DESDE CA $',    importe:   180_000_000, cuitOrdenante: null,            referencia: '4410021', linkPagoId: null, esMovimientoInterno: true,  matchEsperado: { tipo: 'INTERNO', movimientoId: 'mov-5b' } },
  { id: 'mov-6', cuentaId: 'cta-wallet',  fecha: '2026-07-06', descripcion: 'LINK DE PAGO · pago parcial',         importe:    12_000_000, cuitOrdenante: null,            referencia: null,      linkPagoId: 'lp_88213', esMovimientoInterno: false, matchEsperado: { tipo: 'UF', ufId: 'uf-c208' } },
] as const;

/* ------------------------------------------------------------------ */
/* Validaciones: usar como tests                                       */
/* ------------------------------------------------------------------ */

const COEF_TOTAL = 100_000_000;

export function sumaCoeficientes(): number {
  return UNIDADES.reduce((a, u) => a + u.coeficiente, 0);
}

/** Reparte un importe por coeficiente sin perder ni un centavo (resto al mayor coeficiente). */
export function repartirPorCoeficiente(
  importe: number,
  unidades: ReadonlyArray<{ id: string; coeficiente: number }>,
): Record<string, number> {
  const base = unidades.reduce((a, u) => a + u.coeficiente, 0);
  const out: Record<string, number> = {};
  let asignado = 0;
  for (const u of unidades) {
    const parte = Math.floor((importe * u.coeficiente) / base);
    out[u.id] = parte;
    asignado += parte;
  }
  const resto = importe - asignado;
  if (resto !== 0) {
    const mayor = [...unidades].sort((a, b) => b.coeficiente - a.coeficiente)[0];
    out[mayor.id] += resto;
  }
  return out;
}

export function validarLiquidacion(): { ok: boolean; errores: string[] } {
  const errores: string[] = [];

  if (sumaCoeficientes() !== COEF_TOTAL) {
    errores.push(`Los coeficientes suman ${sumaCoeficientes()} y deben sumar ${COEF_TOTAL} (100,000%)`);
  }

  const sumaDetalle = DETALLE_ESPERADO.reduce((a, d) => a + d.total, 0);
  if (sumaDetalle !== ESPERADO.totalEmitido) {
    errores.push(`La suma del detalle (${sumaDetalle}) no iguala el total emitido (${ESPERADO.totalEmitido})`);
  }

  const sumaComponentes =
    ESPERADO.gastoPorCoeficiente + ESPERADO.gastoSector + ESPERADO.extraordinaria +
    ESPERADO.fondoReserva + ESPERADO.intereses;
  if (sumaComponentes !== ESPERADO.totalEmitido) {
    errores.push(`Los componentes suman ${sumaComponentes} y el total emitido es ${ESPERADO.totalEmitido}`);
  }

  // el prorrateo por coeficiente debe reproducir el detalle esperado
  const calc = repartirPorCoeficiente(ESPERADO.gastoPorCoeficiente, UNIDADES);
  for (const d of DETALLE_ESPERADO) {
    if (calc[d.ufId] !== d.ordinarias) {
      errores.push(`Prorrateo de ${d.ufId}: calculado ${calc[d.ufId]}, esperado ${d.ordinarias}`);
    }
  }

  // la piscina sólo la paga el sector B, proporcional a sus coeficientes
  const sectorB = UNIDADES.filter((u) => u.sectorId === 's-b');
  const calcB = repartirPorCoeficiente(ESPERADO.gastoSector, sectorB);
  for (const u of sectorB) {
    const esperado = DETALLE_ESPERADO.find((d) => d.ufId === u.id)!.sector;
    if (calcB[u.id] !== esperado) {
      errores.push(`Piscina de ${u.id}: calculado ${calcB[u.id]}, esperado ${esperado}`);
    }
  }
  for (const d of DETALLE_ESPERADO) {
    if (!sectorB.some((u) => u.id === d.ufId) && d.sector !== 0) {
      errores.push(`${d.ufId} no es del sector B y tiene cargo de piscina`);
    }
  }

  return { ok: errores.length === 0, errores };
}
