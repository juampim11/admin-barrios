/**
 * Esquemas Zod de los **parámetros de las consultas de lectura** (ADR-0002 §7.1).
 *
 * Viven acá y no en `packages/data` por la misma razón que los esquemas de escritura del §4.2: el
 * borde lo cruzan dos lados —la web que arma el parámetro y el servicio que lo consume— y un
 * esquema por lado es un contrato que se desincroniza. `apps/web` los importa desde
 * `@admin-barrios/shared/consultas`; `packages/data/src/servicios/*` los aplica en la primera línea
 * de cada servicio.
 *
 * **Por qué un servicio de lectura valida su entrada.** No es ceremonia: el `barrioId`/`periodoId`
 * sale de un segmento de URL, o sea de un string que manda el cliente. Sin este parseo, un valor
 * que no es uuid llega al `where` y Postgres devuelve un error de casteo crudo —que después hay que
 * traducir— en vez de un rechazo limpio. Lo que **no** hace este parseo es autorizar: quién puede
 * ver ese barrio lo decide la RLS y nada más (ADR-0002 §3.4).
 */

import { z } from "zod";

/** Identificador de fila. Todo el modelo usa `uuid`; no hay ids numéricos ni slugs (ADR-0002 §3.4). */
export const idSchema = z.string().uuid("no es un identificador válido");

export const consultaBarrioSchema = z.object({ barrioId: idSchema });
export type ConsultaBarrio = z.infer<typeof consultaBarrioSchema>;

export const consultaPeriodoSchema = z.object({ periodoId: idSchema });
export type ConsultaPeriodo = z.infer<typeof consultaPeriodoSchema>;

/**
 * Techo duro de filas por página. El padrón y la grilla de revisión son **las dos consultas anchas**
 * del incremento (ADR-0002 §7.1): un barrio típico tiene ~200 unidades, pero el producto es
 * multi-cliente y nada impide uno de 3.000. Sin techo, una sola pantalla se trae el padrón entero
 * con la PII de cada obligado y lo serializa al RSC.
 */
export const MAXIMO_POR_PAGINA = 500;

const paginaSchema = z.object({
  /** Cuántas filas devolver. Por defecto entra un barrio grande en una sola página. */
  limite: z.number().int().positive().max(MAXIMO_POR_PAGINA).default(MAXIMO_POR_PAGINA),
  desplazamiento: z.number().int().min(0).default(0),
});

export const consultaPadronSchema = consultaBarrioSchema.merge(paginaSchema).extend({
  /**
   * Las unidades dadas de baja **no se muestran por defecto**, pero se pueden pedir: la baja es
   * lógica (`baja_at`) porque su deuda sigue existiendo, así que ocultarlas para siempre escondería
   * plata (art. 2049 — la deuda cuelga de la unidad, no del dueño).
   */
  incluirBajas: z.boolean().default(false),
});
export type ConsultaPadron = z.infer<typeof consultaPadronSchema>;

export const consultaLiquidacionesSchema = consultaPeriodoSchema.merge(paginaSchema);
export type ConsultaLiquidaciones = z.infer<typeof consultaLiquidacionesSchema>;
