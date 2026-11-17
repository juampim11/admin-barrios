/**
 * Armar un plan (P2a-2; maqueta de planes, pantallas 2 y 3): los textos y las cuentas de la vista
 * previa. Funciones puras, sin estado, para que se prueben solas.
 *
 * Las cuentas no son propias: el cronograma lo arma `cronogramaDeCatalogo`, el cuadre `cuadreAMedida` y
 * si un plan entra en el catálogo lo dice `fueraDelCatalogo`, los tres de `@admin-barrios/shared/planes`,
 * que son los mismos que usa el servidor al registrar. Lo de la pantalla es una vista previa: la cifra que
 * se guarda la vuelve a calcular el servidor con la deuda de ese momento.
 */
import type { PlanDelCatalogoParaArmar } from "@admin-barrios/data/servicios/planes-armar";
import { aCentavos, deCentavos, formatearMonto, type Monto } from "@admin-barrios/shared/dinero";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { CUOTAS_MAXIMAS_PLAN, repartirEnCuotas, textoDePorcentaje, vencimientoDeCuota } from "@admin-barrios/shared/planes";

/** «$ 1.234,56». */
export const pesos = (m: string): string => `$ ${formatearMonto(m)}`;

/** «2 a 6 cuotas» / «3 cuotas». */
export function textoDeCuotasDelCatalogo(p: Pick<PlanDelCatalogoParaArmar, "cuotasMin" | "cuotasMax">): string {
  return p.cuotasMin === p.cuotasMax ? `${p.cuotasMax} ${p.cuotasMax === 1 ? "cuota" : "cuotas"}` : `${p.cuotasMin} a ${p.cuotasMax} cuotas`;
}

/** Lo que dice cada opción del desplegable de planes: «12 cuotas al 2 % (Estudio Jurídico Demo)». */
export function opcionDelCatalogo(p: Pick<PlanDelCatalogoParaArmar, "nombre" | "estudio">): string {
  return p.estudio ? `${p.nombre} (${p.estudio.nombre})` : p.nombre;
}

/** Lo que dice el plan del catálogo, en una línea: las cuotas, la financiación, el anticipo y el tope. */
export function resumenDelCatalogo(p: PlanDelCatalogoParaArmar): string {
  const financiacion = p.sistema === "frances" ? `francés al ${p.tasaPorcentaje ?? "—"} % mensual` : "cuota fija sin interés";
  const anticipo =
    p.anticipo === "no"
      ? "sin anticipo"
      : `anticipo ${p.anticipo === "opcional" ? "opcional" : "obligatorio"} de hasta el ${textoDePorcentaje(p.anticipoMaxPorcentaje ?? "0")} %`;
  const tope = p.deudaMaxima ? `, para deudas de hasta ${pesos(p.deudaMaxima)}` : "";
  return `${textoDeCuotasDelCatalogo(p)}, ${financiacion}, ${anticipo}${tope}.`;
}

/**
 * Las cantidades de cuotas para elegir: primero las del plan y después las demás, agrupadas aparte,
 * porque elegir una de esas convierte el plan en uno a medida.
 */
export function opcionesDeCuotas(p: Pick<PlanDelCatalogoParaArmar, "cuotasMin" | "cuotasMax">) {
  const opciones: { valor: string; texto: string; grupo: string }[] = [];
  for (let n = p.cuotasMax; n >= p.cuotasMin; n--) opciones.push({ valor: String(n), texto: String(n), grupo: "Las del plan" });
  for (let n = 1; n <= CUOTAS_MAXIMAS_PLAN; n++) {
    if (n < p.cuotasMin || n > p.cuotasMax) opciones.push({ valor: String(n), texto: String(n), grupo: "Fuera del plan (pasa a ser a medida)" });
  }
  return opciones;
}

/** «Primera cuota: 10/12/2026 · última: 10/11/2027.» (el anticipo no cuenta). */
export function rangoDeVencimientos(cuotas: readonly { readonly numero: number; readonly vencimiento: string }[]): string {
  const sinAnticipo = cuotas.filter((c) => c.numero > 0);
  const primera = sinAnticipo[0];
  const ultima = sinAnticipo[sinAnticipo.length - 1];
  if (!primera || !ultima) return "";
  return primera === ultima
    ? `Una sola cuota, el ${formatearFecha(primera.vencimiento)}.`
    : `Primera cuota: ${formatearFecha(primera.vencimiento)} · última: ${formatearFecha(ultima.vencimiento)}.`;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El cronograma a medida (pantalla 3)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Una fila de la tabla editable. `clave` identifica la fila en React; el número sale del orden. */
export type FilaAMedida = {
  readonly clave: string;
  readonly anticipo: boolean;
  /** `AAAA-MM-DD` o vacío. */
  readonly vencimiento: string;
  /** Monto canónico (`"1234.56"`) o vacío. */
  readonly importe: string;
};

/** El número de cada fila: el anticipo es la 0 y las cuotas van de 1 en adelante, en orden. */
export function numerarFilas(filas: readonly FilaAMedida[]): number[] {
  let n = 0;
  return filas.map((f) => (f.anticipo ? 0 : ++n));
}

/** Las filas completas, como las recibe el servidor (el cronograma que viaja en el formulario). */
export function cronogramaDeLasFilas(filas: readonly FilaAMedida[]): { numero: number; vencimiento: string; importe: string }[] {
  const numeros = numerarFilas(filas);
  return filas.map((f, i) => ({ numero: numeros[i]!, vencimiento: f.vencimiento, importe: f.importe }));
}

/** Las filas que ya tienen fecha e importe mayor que cero: las que entran en la suma. */
export function filasCompletas(filas: readonly FilaAMedida[]): { numero: number; vencimiento: string; importe: Monto }[] {
  return cronogramaDeLasFilas(filas).filter((f): f is { numero: number; vencimiento: string; importe: Monto } => {
    if (f.vencimiento === "" || f.importe === "") return false;
    try {
      return aCentavos(f.importe) > 0n;
    } catch {
      return false;
    }
  });
}

/**
 * «Repartir lo que falta en partes iguales»: lo que falta para la deuda (deuda − anticipo) en las cuotas
 * que hay, iguales, y la última ajusta los centavos. Sin cuotas, no cambia nada.
 */
export function repartirLoQueFalta(filas: readonly FilaAMedida[], deuda: Monto): FilaAMedida[] {
  const cuotas = filas.filter((f) => !f.anticipo).length;
  if (cuotas === 0) return [...filas];
  const anticipo = filas.find((f) => f.anticipo && f.importe !== "");
  const falta = aCentavos(deuda) - (anticipo ? aCentavos(anticipo.importe) : 0n);
  if (falta <= 0n) return [...filas];
  const partes = repartirEnCuotas(deCentavos(falta), cuotas);
  let j = 0;
  return filas.map((f) => (f.anticipo ? f : { ...f, importe: partes[j++]! }));
}

/** El vencimiento que se propone para una cuota nueva: un mes después de la última, o el primero sugerido. */
export function vencimientoDeLaSiguiente(filas: readonly FilaAMedida[], primerVencimiento: string): string {
  const ultima = [...filas].reverse().find((f) => !f.anticipo && f.vencimiento !== "");
  return ultima ? vencimientoDeCuota(ultima.vencimiento, 1) : primerVencimiento;
}
