/**
 * El barrio y sus CINCO EJES independientes.
 *
 * Fuente: `knowledge/cordoba/REQUISITOS-MODELO-DATOS.md` §1 y `docs/diseno/03-modelo-datos.md` §B.1.
 *
 * El error más caro sería tratar esto como un solo campo "tipo de barrio": son cinco dimensiones
 * ortogonales y **cualquier combinación es válida** (un barrio puede ser SA + no adecuado + sin
 * encuadre URE + en La Calera + con servicios a cargo del municipio). Además, **todos se versionan**:
 * un barrio se adecua, cambia de figura o de encuadre, y lo que vale para un acto es el valor
 * vigente **en ese momento** (liquidar un período viejo usa la figura que regía entonces).
 */

import { z } from "zod";

/** Eje 1 — figura jurídica: determina órganos, instrumentación y vía de cobro. */
export const FIGURAS_JURIDICAS = ["sa", "asociacion_civil", "ph_especial", "fideicomiso", "geodesia"] as const;
export type FiguraJuridica = (typeof FIGURAS_JURIDICAS)[number];

/** Eje 2 — adecuación al art. 2075 CCyC: pesa en la ejecutividad del certificado de deuda. */
export const ADECUACIONES_2075 = ["si", "no", "en_tramite", "no_aplica"] as const;
export type Adecuacion2075 = (typeof ADECUACIONES_2075)[number];

/** Eje 3 — encuadre urbanístico: obligaciones municipales y tasas. */
export const ENCUADRES_URBANISTICOS = ["ure", "loteo_abierto", "cierre_calles", "sin_encuadre"] as const;
export type EncuadreUrbanistico = (typeof ENCUADRES_URBANISTICOS)[number];

/** Eje 5 — quién presta los servicios internos: adicional tarifario y superposición tasa/expensa. */
export const SERVICIOS_INTERNOS = ["municipio", "urbanizacion", "mixto"] as const;
export type ServiciosInternos = (typeof SERVICIOS_INTERNOS)[number];

/** Los cinco ejes, tal como se versionan en `barrio_atributo_vigencia`. */
export const EJES_BARRIO = [
  "figura_juridica",
  "adecuado_art_2075",
  "encuadre_urbanistico",
  "municipio", // eje 4: texto libre-controlado (slug del municipio), no enum: la lista crece
  "servicios_internos_a_cargo_de",
] as const;
export type EjeBarrio = (typeof EJES_BARRIO)[number];

/** Valores admitidos por eje. `municipio` no es enum: es el slug de `knowledge/<juris>/municipal/`. */
export const VALORES_POR_EJE: Record<Exclude<EjeBarrio, "municipio">, readonly string[]> = {
  figura_juridica: FIGURAS_JURIDICAS,
  adecuado_art_2075: ADECUACIONES_2075,
  encuadre_urbanistico: ENCUADRES_URBANISTICOS,
  servicios_internos_a_cargo_de: SERVICIOS_INTERNOS,
};

/** ¿`valor` es admisible para `eje`? (el municipio se valida como slug). */
export function valorDeEjeValido(eje: EjeBarrio, valor: string): boolean {
  if (eje === "municipio") return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(valor);
  return VALORES_POR_EJE[eje].includes(valor);
}

/** Titularidad de los espacios comunes (insumo del Inmobiliario, `provincial/02`). */
export const TITULARIDADES_ESPACIOS_COMUNES = ["ente", "propietarios", "mixto"] as const;
export type TitularidadEspaciosComunes = (typeof TITULARIDADES_ESPACIOS_COMUNES)[number];

/** Estado de la unidad — baldía y en construcción **generan expensas igual** (art. 2077). */
export const ESTADOS_UNIDAD = ["baldio", "en_construccion", "construido"] as const;
export type EstadoUnidad = (typeof ESTADOS_UNIDAD)[number];

/**
 * Título por el que alguien responde por la unidad. Puede haber **varios a la vez** y el propietario
 * **no se libera** por que haya un poseedor (art. 2050).
 */
export const TIPOS_OBLIGADO = ["propietario", "poseedor", "usufructuario", "tenedor"] as const;
export type TipoObligado = (typeof TIPOS_OBLIGADO)[number];

/**
 * Base del prorrateo. **No siempre es el porcentual de parte indivisa**: el reglamento puede fijar
 * superficie, lote o una mezcla (art. 2081 → guardrail §10 de los requisitos).
 */
export const BASES_COEFICIENTE = ["parte_indivisa", "superficie", "lote", "mixto"] as const;
export type BaseCoeficiente = (typeof BASES_COEFICIENTE)[number];

/** Documentos que el sistema guarda como dato de primera clase (`REQUISITOS §9`). */
export const TIPOS_DOCUMENTO_BARRIO = [
  "reglamento",
  "estatuto",
  "instrumento_municipal",
  "acta_asamblea",
  "acta_designacion_administrador",
  "constancia_adecuacion",
  "pacto_ejecutividad",
  "otro",
] as const;
export type TipoDocumentoBarrio = (typeof TIPOS_DOCUMENTO_BARRIO)[number];

export const figuraJuridicaSchema = z.enum(FIGURAS_JURIDICAS);
export const adecuacion2075Schema = z.enum(ADECUACIONES_2075);
export const encuadreUrbanisticoSchema = z.enum(ENCUADRES_URBANISTICOS);
export const serviciosInternosSchema = z.enum(SERVICIOS_INTERNOS);
export const ejeBarrioSchema = z.enum(EJES_BARRIO);
export const estadoUnidadSchema = z.enum(ESTADOS_UNIDAD);
export const tipoObligadoSchema = z.enum(TIPOS_OBLIGADO);
export const baseCoeficienteSchema = z.enum(BASES_COEFICIENTE);
export const tipoDocumentoBarrioSchema = z.enum(TIPOS_DOCUMENTO_BARRIO);
export const municipioSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "municipio inválido (esperado slug, ej 'villa-allende')");

/**
 * Cómo se llama el concepto que se le cobra a la unidad, **según la figura**: en un barrio-SA no son
 * "expensas" sino aportes o cuotas sociales.
 *
 * Devuelve `null` cuando **no hay fuente cargada** para esa figura: en ese caso el sistema no
 * inventa una denominación, la pide al administrador (regla dura del proyecto).
 */
export function sugerirDenominacionConcepto(
  figura: FiguraJuridica,
): { denominacion: string; fuente: string } | null {
  switch (figura) {
    case "ph_especial":
      return { denominacion: "expensa", fuente: "knowledge/cordoba/nacional/04-regimen-expensas.md" };
    case "sa":
      return { denominacion: "cuota social / aporte", fuente: "knowledge/cordoba/nacional/02-ley-19550-barrio-sa.md" };
    case "asociacion_civil":
      return { denominacion: "cuota social", fuente: "knowledge/cordoba/nacional/02-ley-19550-barrio-sa.md" };
    default:
      // fideicomiso y geodesia: sin fuente cargada → lo define el administrador.
      return null;
  }
}

/**
 * ¿El sistema puede sugerir la vía **ejecutiva** de cobro? Nunca afirma que la deuda sea ejecutable:
 * devuelve qué falta para poder siquiera sugerirla (`REQUISITOS §5`, guardrail más importante).
 */
export function faltantesParaViaEjecutiva(barrio: {
  figuraJuridica: FiguraJuridica;
  adecuadoArt2075: Adecuacion2075;
  reglamentoInscripto: boolean | null;
  pactoEjecutividad: boolean | null;
}): string[] {
  const faltantes: string[] = [];
  if (barrio.adecuadoArt2075 !== "si") faltantes.push("adecuación al art. 2075 no acreditada");
  if (barrio.reglamentoInscripto !== true) faltantes.push("reglamento inscripto no acreditado");
  if (barrio.pactoEjecutividad !== true) faltantes.push("pacto de ejecutividad no acreditado");
  if (barrio.figuraJuridica !== "ph_especial") {
    faltantes.push(`figura '${barrio.figuraJuridica}': la vía depende del instrumento, no del régimen de PH`);
  }
  return faltantes;
}
