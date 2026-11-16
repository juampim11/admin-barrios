/**
 * Los textos de «Conceptos del barrio» (encargo 16b, pantalla 2 de la maqueta), como funciones puras:
 * cómo se dice a quién va un concepto, cómo se calcula y cómo entra cada mes.
 *
 * No calculan nada: escriben en palabras lo que el servicio ya resolvió (`listarConceptosBoleta`,
 * `listarConceptos`, `leerComoSeDevenga`). Están aparte de la pantalla para poder probarlas sin base.
 *
 * **Ningún texto asume un modelo** (CLAUDE.md §1.6): lo que se dice de los gastos depende de dónde
 * sale el importe del mes en este barrio, y el nombre de lo que se cobra llega por parámetro.
 */

import { formatearMonto } from "@admin-barrios/shared/dinero";
import {
  TEXTO_DESTINATARIO,
  TEXTO_MODO_DEL_MES,
  type DestinatarioConcepto,
  type ModoDelMes,
  type UnidadDeUso,
} from "@admin-barrios/shared/conceptos";
import type { ModoBonificacion, OrigenDevengado } from "@admin-barrios/shared/devengado";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { sumarDias } from "@admin-barrios/shared/interes-mora";

/** Lo que estas funciones miran de un concepto de boleta (un subconjunto de `ConceptoBoletaDeLista`). */
export type ConceptoParaTexto = {
  readonly clase: "cargo" | "descuento";
  readonly metodo: string;
  readonly destinatario: DestinatarioConcepto;
  readonly grupoNombre: string | null;
  readonly grupoUnidades: number | null;
  readonly modoMes: ModoDelMes;
  readonly unidadUso: UnidadDeUso | null;
  readonly deLaRegla: boolean;
  readonly valorVigente: {
    readonly montoFijo: string | null;
    readonly porcentaje: string | null;
    readonly precioUnitario: string | null;
    readonly tope: string | null;
  } | null;
};

const pesos = (monto: string): string => `$ ${formatearMonto(monto)}`;

export const cuantasUnidades = (n: number): string => (n === 1 ? "1 unidad" : `${n} unidades`);

/**
 * Un porcentaje como lo lee una persona: «7,5», «10». La base guarda seis decimales (`7.500000`), que
 * son precisión de cálculo y no de lectura. Es texto de punta a punta: no pasa por un número.
 */
export function porcentajeLegible(valor: string): string {
  const [entero = "0", decimales = ""] = valor.trim().split(".");
  const sinCeros = decimales.replace(/0+$/, "");
  return sinCeros === "" ? entero : `${entero},${sinCeros}`;
}

/** «Suma» o «Resta»: lo que el concepto le hace al cupón de la unidad. */
export const sumaOResta = (clase: "cargo" | "descuento"): string => (clase === "cargo" ? "Suma" : "Resta");

/**
 * Cómo se calcula, con el valor que rige hoy: «$ 15.000,00 por unidad», «$ 12.000,00 por turno»,
 * «7,5 % de la expensa, hasta $ 20.000,00», «Importe a cargar cada vez». Sin un valor que rija hoy,
 * lo dice: ese concepto no se puede aplicar con fecha de hoy.
 *
 * `denominacion` es cómo llama el barrio a lo que cobra cada mes («expensa», «cuota social»).
 */
export function comoSeCalcula(c: ConceptoParaTexto, denominacion: string): string {
  if (c.metodo === "importe_libre") return "Importe a cargar cada vez";
  const v = c.valorVigente;
  if (v === null) return "Sin valor vigente";
  if (c.metodo === "monto_fijo" && v.montoFijo !== null) return `${pesos(v.montoFijo)} por unidad`;
  if (c.metodo === "precio_x_cantidad" && v.precioUnitario !== null) return `${pesos(v.precioUnitario)} por ${c.unidadUso ?? "uso"}`;
  if (c.metodo === "porcentaje" && v.porcentaje !== null) {
    const tope = v.tope === null ? "" : `, hasta ${pesos(v.tope)}`;
    return `${porcentajeLegible(v.porcentaje)} % de la ${denominacion}${tope}`;
  }
  return "Sin valor vigente";
}

/**
 * A quién va. La bonificación por pago en término la aplica la regla del barrio: va a las unidades
 * que están al día si se aplica sola, y a la unidad que se elija si se carga a mano.
 */
export function aQuienVa(c: ConceptoParaTexto, modoDeLaBonificacion: ModoBonificacion): string {
  if (c.deLaRegla) return modoDeLaBonificacion === "a_mano" ? TEXTO_DESTINATARIO.una_unidad : "Las que están al día";
  if (c.destinatario === "grupo") {
    return `Grupo: ${c.grupoNombre ?? "sin nombre"} (${cuantasUnidades(c.grupoUnidades ?? 0)})`;
  }
  return TEXTO_DESTINATARIO[c.destinatario];
}

/** Cómo entra cada mes: «Sola», «Por planilla o a mano», «A mano». */
export function cadaMes(c: ConceptoParaTexto, modoDeLaBonificacion: ModoBonificacion): string {
  if (c.deLaRegla) {
    return modoDeLaBonificacion === "sola" ? TEXTO_MODO_DEL_MES.sola.corto : modoDeLaBonificacion === "a_mano" ? TEXTO_MODO_DEL_MES.mano.corto : "No se aplica";
  }
  return TEXTO_MODO_DEL_MES[c.modoMes].corto;
}

/**
 * Qué pasa con un gasto de este tipo en el cupón de cada unidad. Depende de dónde sale el importe del
 * mes: si lo define la administración, lo de todos los meses ya está en ese importe y solo los gastos
 * extraordinarios se reparten aparte.
 */
export function comoSeReparteElGasto(tipo: string, origen: OrigenDevengado | null): string {
  if (tipo === "extraordinaria") return "Se reparte por coeficiente dentro del cupón del mes";
  // El barrio todavía no definió de dónde sale el importe del mes: no se afirma ni una cosa ni la otra.
  if (origen === null) return "Depende de cómo se devenga en este barrio";
  return origen === "gastos"
    ? "Se reparte entre las unidades dentro del cupón del mes"
    : "No se reparte aparte: el importe del mes lo define la administración";
}

/** El resumen de las unidades de un grupo: las primeras y cuántas más. */
export function resumenDeUnidades(etiquetas: readonly string[], cuantas = 4): string {
  if (etiquetas.length === 0) return "Todavía sin unidades";
  const primeras = etiquetas.slice(0, cuantas).join(", ");
  const resto = etiquetas.length - cuantas;
  return resto > 0 ? `${primeras} y ${resto} más` : primeras;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El historial de valores de un concepto (encargo 17b, 7d)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que estas funciones miran de un renglón del historial (un subconjunto de `ValorDeConceptoEnElHistorial`). */
export type ValorParaTexto = NonNullable<ConceptoParaTexto["valorVigente"]>;

/**
 * Un valor del historial, dicho igual que el valor vigente en la tabla de arriba: el mismo texto,
 * con el valor de ese renglón en lugar del de hoy. No hay una segunda forma de escribir un valor.
 */
export const valorDelHistorial = (c: ConceptoParaTexto, valor: ValorParaTexto, denominacion: string): string =>
  comoSeCalcula({ ...c, valorVigente: valor }, denominacion);

/**
 * Hasta qué día rigió, **inclusive**. La base guarda el fin de la vigencia como exclusivo (es el día
 * en que empieza el valor siguiente), y a una persona se le dice el último día que valió: el
 * anterior. «—» si sigue abierto.
 *
 * Si lo reemplazó otro valor que rige desde el mismo día, no rigió ni un día: se dice, en vez de
 * mostrar un «hasta» anterior a su «desde».
 */
export function hastaCuandoRigio(vigenteDesde: string, vigenteHasta: string | null): string {
  if (vigenteHasta === null) return "—";
  if (vigenteHasta <= vigenteDesde) return "No llegó a regir";
  return formatearFecha(sumarDias(vigenteHasta, -1));
}

/** El estado de un valor, con el tono de su chip. Los mismos tres del historial de la cuota. */
export const ESTADO_DEL_VALOR = {
  programado: { tono: "info", texto: "Programado" },
  vigente: { tono: "exito", texto: "Vigente" },
  anterior: { tono: "neutro", texto: "Anterior" },
} as const;

/**
 * Quién cargó el valor y qué día: «Valeria Ríos · 15/11/2026». Un valor sin persona detrás (el
 * concepto ya venía con él: sembrado o importado) es la «Carga inicial», igual que en la cuota.
 */
export const quienLoCargo = (cargadoPor: string | null, cargadoEl: string): string =>
  `${cargadoPor ?? "Carga inicial"} · ${formatearFecha(cargadoEl)}`;

/** Lo que se dice en lugar de la tabla cuando el concepto no tiene ningún valor que listar. */
export function sinHistorial(c: Pick<ConceptoParaTexto, "metodo" | "deLaRegla">): string {
  if (c.metodo === "importe_libre") return "Este concepto no tiene valores: el importe se escribe cada vez que se aplica a una unidad.";
  if (c.deLaRegla) return "Todavía no se cargó ningún valor. Se define en «Cómo se devenga».";
  return "Todavía no se cargó ningún valor.";
}
