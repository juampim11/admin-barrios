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

export const consultaUnidadSchema = z.object({ unidadFuncionalId: idSchema });
export type ConsultaUnidad = z.infer<typeof consultaUnidadSchema>;

export const consultaPagoSchema = z.object({ pagoId: idSchema });
export type ConsultaPago = z.infer<typeof consultaPagoSchema>;

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

// --- Exportación de movimientos (doc 01 §4.8, ADR-0004) ----------------------------------------

/** Período `YYYY-MM`, el mismo formato y el mismo `CHECK` que `periodo_expensa.periodo`. */
const periodoDeRangoSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "período inválido (esperado YYYY-MM)");

/**
 * Techo de meses por exportación. **No es una preferencia de producto: es el freno de un `GET`
 * síncrono** que arma el libro entero en memoria del proceso web (`security-engineer`, panel
 * 2026-08-26). Con 24 meses, un barrio de 510 unidades entra holgado (~12.000 filas) y
 * `desde=1900-01&hasta=2999-12` ni siquiera llega a la base.
 *
 * El otro freno —el de filas— vive en `MAXIMO_FILAS_EXPORTACION`, y son dos porque frenan cosas
 * distintas: este acota el rango que se pide, aquel acota lo que ese rango resultó contener.
 */
export const MAXIMO_MESES_EXPORTACION = 24;

/**
 * Techo de filas del libro. Calcado del `MAX_UF` del sistema de gas, con el volumen de este
 * dominio: un período de un barrio de 510 unidades son ~510 pagos más decenas de gastos, y un año
 * ronda las 6.000 filas. 50.000 deja lugar de sobra para un barrio grande con 24 meses y corta el
 * pedido absurdo antes de construir el workbook.
 *
 * **Se verifica con un `COUNT`, no cargando las filas**: contar para después decidir que era
 * demasiado ya habría pagado el costo que este techo existe para evitar.
 */
export const MAXIMO_FILAS_EXPORTACION = 50_000;

/**
 * El rango de una exportación de movimientos, **inclusivo en los dos extremos**.
 *
 * El corte es **por período y no por fecha**, y la razón es del modelo, no de comodidad: `pago`
 * tiene `fecha` propia, pero `gasto_periodo` **no la tiene** —solo `created_at`, que es cuándo se
 * cargó— y su único anclaje temporal real es el período. Un filtro por fechas recortaría ingresos y
 * egresos con criterios distintos y los totales no cerrarían contra nada.
 */
export const consultaExportacionSchema = consultaBarrioSchema
  .extend({
    periodoDesde: periodoDeRangoSchema,
    periodoHasta: periodoDeRangoSchema,
  })
  .refine((v) => v.periodoHasta >= v.periodoDesde, {
    message: "el período final no puede ser anterior al inicial",
    path: ["periodoHasta"],
  })
  .refine((v) => mesesEntre(v.periodoDesde, v.periodoHasta) <= MAXIMO_MESES_EXPORTACION, {
    message: `el rango no puede superar los ${MAXIMO_MESES_EXPORTACION} meses`,
    path: ["periodoHasta"],
  });
export type ConsultaExportacion = z.infer<typeof consultaExportacionSchema>;

/**
 * Meses cubiertos por un rango `YYYY-MM`, inclusive: `2026-01`→`2026-01` es 1, no 0.
 *
 * Aritmética de calendario sobre enteros chicos, sin `Date`: una zona horaria no tiene nada que
 * decir sobre un período, y `new Date("2026-01")` interpreta UTC y puede devolver diciembre del año
 * anterior en un huso al oeste — el modo de falla exacto que la regla 7 del gate persigue.
 */
function mesesEntre(desde: string, hasta: string): number {
  const [anioDesde = "0", mesDesde = "0"] = desde.split("-");
  const [anioHasta = "0", mesHasta = "0"] = hasta.split("-");
  const absolutoDesde = Number.parseInt(anioDesde, 10) * 12 + Number.parseInt(mesDesde, 10);
  const absolutoHasta = Number.parseInt(anioHasta, 10) * 12 + Number.parseInt(mesHasta, 10);
  return absolutoHasta - absolutoDesde + 1;
}
