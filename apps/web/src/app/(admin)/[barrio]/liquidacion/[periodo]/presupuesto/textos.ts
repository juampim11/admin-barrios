/**
 * Los textos de «Presupuesto del mes» (encargo 16c, pantalla 3 de la maqueta), como funciones puras.
 *
 * No deciden nada de negocio: suman lo que la persona va escribiendo (en centavos, con
 * `sumarMontos`) y dicen en palabras lo que ya resuelven `loQueJuntaElImporte` y `cubreElPresupuesto`
 * de `@admin-barrios/shared/presupuesto`, que son las mismas funciones que usa el servicio. Están
 * aparte para poder probarlas sin base y sin navegador, y las usa la isla de cliente.
 */

import { formatearMonto, montoSchema, restarMontos, sumarMontos, aCentavos, type Monto } from "@admin-barrios/shared/dinero";
import { nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { cubreElPresupuesto, loQueJuntaElImporte, type ModoDelImporte } from "@admin-barrios/shared/presupuesto";

const pesos = (monto: string): string => `$ ${formatearMonto(monto)}`;

/** `"2026-11"` → `"noviembre"`: el mes solo, como lo dice la maqueta («Gastado en noviembre»). */
export const elMes = (periodo: string): string => nombreDelPeriodo(periodo).split(" ")[0]!.toLowerCase();

const unidades = (n: number): string => (n === 1 ? "1 unidad" : `${n} unidades`);

/** Un importe escrito en el campo, si es uno: el campo avisa `""` cuando está vacío. */
const importeValido = (texto: string): Monto | null => (montoSchema.safeParse(texto).success ? (texto as Monto) : null);

/**
 * El gasto esperado y el total a pedir **mientras se escribe**: la suma de los rubros con importe y el
 * margen. Un campo vacío no suma (no es un cero que alguien escribió: es un rubro sin presupuesto).
 */
export function totalesDelPresupuesto(
  montos: readonly string[],
  margen: string,
): { readonly gastoEsperado: Monto; readonly totalAPedir: Monto } {
  const gastoEsperado = sumarMontos("0.00", ...montos.map(importeValido).filter((m): m is Monto => m !== null));
  return { gastoEsperado, totalAPedir: sumarMontos(gastoEsperado, importeValido(margen) ?? "0.00") };
}

/**
 * El rótulo del campo del importe. Por unidad lleva el nombre con el que el barrio llama a lo que
 * cobra («Expensa por unidad», «Cuota social por unidad»); por coeficiente es el total del mes.
 */
export function rotuloDelImporte(modo: ModoDelImporte, denominacionConMayuscula: string): string {
  return modo === "por_unidad" ? `${denominacionConMayuscula} por unidad` : "Total del mes";
}

/**
 * La cuenta del panel «Importe del mes» y si alcanza:
 * - por unidad: «45 unidades × $ 200.000,00 = $ 9.000.000,00»;
 * - por coeficiente: «$ 9.000.000,00 en total, repartido por coeficiente entre 45 unidades».
 *
 * Y la lectura: «Cubre el presupuesto.», «Cubre el presupuesto y sobran $ X.» o «No cubre el
 * presupuesto: faltan $ X.». Sin un importe escrito no hay cuenta.
 */
export function cuentaDelImporte(p: {
  readonly modo: ModoDelImporte;
  readonly unidades: number;
  readonly importe: string;
  readonly totalAPedir: string;
}): { readonly cuenta: string; readonly cubre: boolean; readonly lectura: string } | null {
  const importe = importeValido(p.importe);
  if (importe === null) return null;
  const junta = loQueJuntaElImporte(p.modo, importe, p.unidades);
  const cubre = cubreElPresupuesto(p.modo, importe, p.unidades, p.totalAPedir);
  const diferencia = restarMontos(junta, p.totalAPedir);
  const cuenta =
    p.modo === "por_unidad"
      ? `${unidades(p.unidades)} × ${pesos(importe)} = ${pesos(junta)}`
      : `${pesos(junta)} en total, repartido por coeficiente entre ${unidades(p.unidades)}`;
  const lectura = !cubre
    ? `No cubre el presupuesto: faltan ${pesos(restarMontos("0.00", diferencia))}.`
    : aCentavos(diferencia) === 0n
      ? "Cubre el presupuesto."
      : `Cubre el presupuesto y sobran ${pesos(diferencia)}.`;
  return { cuenta, cubre, lectura };
}

/** «En noviembre fue $ 195.000,00 por unidad.» / «En noviembre fue $ 9.000.000,00 en total.» */
export function enElMesAnterior(modo: ModoDelImporte, mesAnterior: string, monto: string | null): string | null {
  if (monto === null) return null;
  return `En ${elMes(mesAnterior)} fue ${pesos(monto)}${modo === "por_unidad" ? " por unidad" : " en total"}.`;
}

/** Lo que va en «Qué lo aprobó» si la persona no escribe otra cosa: «Presupuesto de diciembre 2026». */
export const descripcionDelImporte = (periodo: string): string => `Presupuesto de ${nombreDelPeriodo(periodo).toLowerCase()}`;

/** El campo arranca con el importe que rige el mes; si todavía no hay, con el que cubre el presupuesto. */
export const importePrecargado = (importe: { readonly vigente: string | null; readonly queCubre: string | null }): string =>
  importe.vigente ?? importe.queCubre ?? "";
