/**
 * Parámetros de mora e imputación: lectura para las dos pantallas de configuración, escritura (fijar,
 * volver al valor general, anular un cambio programado), y la resolución con vigencias que usa la
 * liquidación (ADR-0006).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LA RESOLUCIÓN VIVE EN LA BASE, Y SOLO AHÍ
 *
 * "Qué valor rige en este barrio a esta fecha y de dónde sale" lo contesta
 * `app.parametro_resuelto()` (`0057`). Acá **no** hay una segunda implementación en TypeScript: las
 * pantallas listan filas (historial, programados) pero el valor vigente y su origen salen siempre de
 * la función. Dos copias de una regla de herencia terminan divergiendo — es la lección de la `0029`.
 *
 * "Hoy" también lo dice la base (`current_date`): es la misma fecha contra la que `fijar_parametro`
 * decide qué es retroactivo, y la pantalla no puede tener otra.
 */

import { sql } from "drizzle-orm";
import {
  anularParametroSchema,
  CLAVES_PARAMETRO,
  definicionDe,
  fijarParametroSchema,
  prepararSubidaDeRespaldoSchema,
  textoDeValor,
  volverAlValorGeneralSchema,
  type AnularParametro,
  type CargaParametro,
  type ClaveParametro,
  type FijarParametro,
  type OrigenParametro,
  type PrepararSubidaDeRespaldo,
  type TipoRespaldo,
  type ValorUsado,
  type VolverAlValorGeneral,
} from "@admin-barrios/shared/parametros-mora";
import { sumarDias, type ParametrosMora, type VigenciasMora } from "@admin-barrios/shared/interes-mora";
import type { FormaGracia } from "@admin-barrios/shared/parametros-mora";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { claveDeRespaldo, nuevoToken, type ContentTypeDeComprobante } from "@admin-barrios/almacenamiento";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Tipos de lectura
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type Respaldo = {
  readonly tipo: TipoRespaldo;
  readonly referencia: string;
  /** Storage key. La pantalla no la muestra: arma el link de descarga con el `filaId`. */
  readonly adjunto: string | null;
};

/** Una fila del historial de vigencias. */
export type FilaDeHistorial = {
  readonly filaId: string;
  readonly vigenteDesde: string;
  /** `null` solo en el barrio: "vuelve al valor general". */
  readonly valor: unknown;
  readonly motivo: string;
  readonly carga: CargaParametro;
  readonly respaldo: Respaldo | null;
  /** Rige después de hoy y no está anulada: se puede anular. */
  readonly programada: boolean;
  readonly anulada: { readonly motivo: string } | null;
};

/** El valor que rige hoy, con de dónde sale. */
export type ValorVigente = {
  readonly valor: unknown;
  readonly origen: OrigenParametro;
  readonly vigenteDesde: string;
  readonly carga: CargaParametro;
  readonly filaId: string;
  readonly respaldo: Respaldo | null;
};

export type BarrioDeLaAdministracion = { readonly id: string; readonly nombre: string; readonly unidades: number };

export type ParametroGeneral = {
  readonly clave: ClaveParametro;
  /** `null` = sin definir (solo `imputacion.orden` en una administración migrada). */
  readonly vigente: ValorVigente | null;
  readonly programados: readonly FilaDeHistorial[];
  readonly historial: readonly FilaDeHistorial[];
  /** Barrios que hoy no heredan esta clave (o que tienen un valor propio programado). */
  readonly barriosConPropio: readonly { readonly id: string; readonly nombre: string }[];
};

export type ConfiguracionGeneral = {
  readonly administracion: { readonly id: string; readonly nombre: string };
  readonly hoy: string;
  readonly puedeEditar: boolean;
  readonly barrios: readonly BarrioDeLaAdministracion[];
  readonly parametros: readonly ParametroGeneral[];
};

export type ParametroDelBarrio = {
  readonly clave: ClaveParametro;
  /** Lo que rige hoy en el barrio, con su origen. `null` = sin definir. */
  readonly vigente: ValorVigente | null;
  /** Lo que rige hoy en la administración (para "en la configuración general: …"). */
  readonly general: ValorVigente | null;
  readonly programadosPropios: readonly FilaDeHistorial[];
  readonly programadosGenerales: readonly FilaDeHistorial[];
  readonly historialPropio: readonly FilaDeHistorial[];
  readonly historialGeneral: readonly FilaDeHistorial[];
};

export type ConfiguracionDelBarrio = {
  readonly barrio: BarrioDeLaAdministracion;
  readonly administracion: { readonly id: string; readonly nombre: string };
  readonly hoy: string;
  readonly puedeEditar: boolean;
  readonly parametros: readonly ParametroDelBarrio[];
};

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lectura
// ────────────────────────────────────────────────────────────────────────────────────────────────

type FilaResuelta = {
  clave: string;
  valor: unknown;
  origen: OrigenParametro;
  fila_id: string;
  vigente_desde: string;
  carga: CargaParametro;
  respaldo_tipo: TipoRespaldo | null;
  respaldo_referencia: string | null;
  respaldo_adjunto: string | null;
};

function respaldoDe(f: {
  respaldo_tipo: TipoRespaldo | null;
  respaldo_referencia: string | null;
  respaldo_adjunto: string | null;
}): Respaldo | null {
  return f.respaldo_tipo && f.respaldo_referencia
    ? { tipo: f.respaldo_tipo, referencia: f.respaldo_referencia, adjunto: f.respaldo_adjunto }
    : null;
}

function aVigente(f: FilaResuelta): ValorVigente {
  return {
    valor: f.valor,
    origen: f.origen,
    vigenteDesde: f.vigente_desde,
    carga: f.carga,
    filaId: f.fila_id,
    respaldo: respaldoDe(f),
  };
}

/** Todos los valores resueltos de un nodo a una fecha, por clave. Una sola consulta. */
async function resueltos(tx: DbConIdentidad, nodoId: string, fecha: string): Promise<Map<ClaveParametro, FilaResuelta>> {
  const { rows } = await tx.execute<FilaResuelta>(sql`
    select r.clave, x.valor, x.origen, x.fila_id, x.vigente_desde::text as vigente_desde, x.carga,
           x.respaldo_tipo, x.respaldo_referencia, x.respaldo_adjunto
      from parametro_registro r
     cross join lateral app.parametro_resuelto(${nodoId}::uuid, r.clave, ${fecha}::date) x
  `);
  return new Map(rows.map((f) => [f.clave as ClaveParametro, f]));
}

type FilaCruda = {
  id: string;
  nodo_id: string;
  clave: ClaveParametro;
  valor: unknown;
  vigente_desde: string;
  motivo: string;
  carga: CargaParametro;
  respaldo_tipo: TipoRespaldo | null;
  respaldo_referencia: string | null;
  respaldo_adjunto: string | null;
  anulacion_motivo: string | null;
};

/** Las filas de los nodos dados, de la más nueva a la más vieja. Bajo RLS. */
async function filasDe(tx: DbConIdentidad, nodos: readonly string[]): Promise<FilaCruda[]> {
  if (nodos.length === 0) return [];
  const { rows } = await tx.execute<FilaCruda>(sql`
    select v.id, v.nodo_id, v.clave, v.valor, v.vigente_desde::text as vigente_desde, v.motivo, v.carga,
           v.respaldo_tipo, v.respaldo_referencia, v.respaldo_adjunto, a.motivo as anulacion_motivo
      from parametro_valor v
      left join parametro_anulacion a on a.fila_id = v.id
     where v.nodo_id in (${sql.join(nodos.map((n) => sql`${n}::uuid`), sql`, `)})
     order by v.vigente_desde desc, v.orden desc
  `);
  return rows;
}

function aHistorial(f: FilaCruda, hoy: string): FilaDeHistorial {
  return {
    filaId: f.id,
    vigenteDesde: f.vigente_desde,
    valor: f.valor,
    motivo: f.motivo,
    carga: f.carga,
    respaldo: respaldoDe(f),
    programada: f.vigente_desde > hoy && f.anulacion_motivo === null,
    anulada: f.anulacion_motivo === null ? null : { motivo: f.anulacion_motivo },
  };
}

async function hoyDeLaBase(tx: DbConIdentidad): Promise<string> {
  const { rows } = await tx.execute<{ hoy: string }>(sql`select current_date::text as hoy`);
  return rows[0]?.hoy ?? "";
}

async function puedeEditar(tx: DbConIdentidad, nodoId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`select app.puede_editar_parametros(${nodoId}::uuid) as ok`);
  return rows[0]?.ok === true;
}

/**
 * La administración de un barrio legible: su padre en la tenancía. `null` si el barrio no es
 * accesible. El nombre puede no ser legible para quien solo es miembro del barrio (la tenancía no
 * abre a los ancestros salvo con mandato, `0020`): en ese caso se dice "la administración".
 */
async function administracionDe(
  tx: DbConIdentidad,
  barrioId: string,
): Promise<{ barrio: BarrioDeLaAdministracion; administracion: { id: string; nombre: string } } | null> {
  const { rows } = await tx.execute<{ id: string; nombre: string; unidades: number; admin_id: string; admin_nombre: string | null }>(sql`
    select n.id, n.nombre,
           (select count(*) from unidad_funcional u where u.barrio_id = b.barrio_id and u.baja_at is null)::int as unidades,
           n.parent_id as admin_id,
           (select a.nombre from tenant_node a where a.id = n.parent_id) as admin_nombre
      from barrio b
      join tenant_node n on n.id = b.barrio_id
     where b.barrio_id = ${barrioId}::uuid and n.deleted_at is null
  `);
  const f = rows[0];
  if (!f) return null;
  return {
    barrio: { id: f.id, nombre: f.nombre, unidades: f.unidades },
    administracion: { id: f.admin_id, nombre: f.admin_nombre ?? "La administración" },
  };
}

/**
 * La configuración general de la administración de un barrio — pantalla 1 de la maqueta. Se entra
 * por un barrio porque así se navega (la barra lateral es la del barrio); lo que se muestra es de la
 * administración y vale para todos sus barrios. `null` si el barrio no es accesible.
 */
export async function leerConfiguracionGeneral(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string },
): Promise<ConfiguracionGeneral | null> {
  const base = await administracionDe(tx, parametros.barrioId);
  if (!base) return null;
  const adminId = base.administracion.id;
  const hoy = await hoyDeLaBase(tx);

  // Los barrios de la administración que esta persona puede leer (la RLS de `barrio` decide).
  const { rows: barrios } = await tx.execute<BarrioDeLaAdministracion>(sql`
    select n.id, n.nombre,
           (select count(*) from unidad_funcional u where u.barrio_id = b.barrio_id and u.baja_at is null)::int as unidades
      from barrio b join tenant_node n on n.id = b.barrio_id
     where n.parent_id = ${adminId}::uuid and n.deleted_at is null
     order by n.nombre
  `);

  const [vigentes, filas, editar] = await Promise.all([
    resueltos(tx, adminId, hoy),
    filasDe(tx, [adminId, ...barrios.map((b) => b.id)]),
    puedeEditar(tx, adminId),
  ]);

  // Qué barrios NO heredan hoy cada clave, según la función (no según una copia de la regla).
  const { rows: propios } = await tx.execute<{ barrio_id: string; clave: ClaveParametro }>(sql`
    select n.id as barrio_id, r.clave
      from tenant_node n
      join barrio b on b.barrio_id = n.id
     cross join parametro_registro r
     cross join lateral app.parametro_resuelto(n.id, r.clave, current_date) x
     where n.parent_id = ${adminId}::uuid and n.deleted_at is null and x.origen = 'barrio'
  `);
  const conPropio = new Map<ClaveParametro, Set<string>>();
  for (const p of propios) conPropio.set(p.clave, (conPropio.get(p.clave) ?? new Set()).add(p.barrio_id));
  // Un propio PROGRAMADO también hace que el cambio general no lo alcance desde esa fecha.
  for (const f of filas) {
    if (f.nodo_id !== adminId && f.vigente_desde > hoy && f.valor !== null && f.anulacion_motivo === null) {
      conPropio.set(f.clave, (conPropio.get(f.clave) ?? new Set()).add(f.nodo_id));
    }
  }

  return {
    administracion: base.administracion,
    hoy,
    puedeEditar: editar,
    barrios,
    parametros: CLAVES_PARAMETRO.map((clave) => {
      const propiasDeLaAdmin = filas.filter((f) => f.nodo_id === adminId && f.clave === clave).map((f) => aHistorial(f, hoy));
      const v = vigentes.get(clave);
      const ids = conPropio.get(clave) ?? new Set<string>();
      return {
        clave,
        vigente: v ? aVigente(v) : null,
        programados: propiasDeLaAdmin.filter((h) => h.programada).reverse(),
        historial: propiasDeLaAdmin,
        barriosConPropio: barrios.filter((b) => ids.has(b.id)).map((b) => ({ id: b.id, nombre: b.nombre })),
      };
    }),
  };
}

/** La configuración del barrio — pantalla 2 de la maqueta. `null` si el barrio no es accesible. */
export async function leerConfiguracionDelBarrio(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string },
): Promise<ConfiguracionDelBarrio | null> {
  const base = await administracionDe(tx, parametros.barrioId);
  if (!base) return null;
  const hoy = await hoyDeLaBase(tx);
  const adminId = base.administracion.id;
  const [vigentes, generales, filas, editar] = await Promise.all([
    resueltos(tx, base.barrio.id, hoy),
    resueltos(tx, adminId, hoy),
    filasDe(tx, [base.barrio.id, adminId]),
    puedeEditar(tx, base.barrio.id),
  ]);

  return {
    barrio: base.barrio,
    administracion: base.administracion,
    hoy,
    puedeEditar: editar,
    parametros: CLAVES_PARAMETRO.map((clave) => {
      const propias = filas.filter((f) => f.nodo_id === base.barrio.id && f.clave === clave).map((f) => aHistorial(f, hoy));
      const deLaAdmin = filas.filter((f) => f.nodo_id === adminId && f.clave === clave).map((f) => aHistorial(f, hoy));
      const v = vigentes.get(clave);
      const g = generales.get(clave);
      return {
        clave,
        vigente: v ? aVigente(v) : null,
        general: g ? aVigente(g) : null,
        programadosPropios: propias.filter((h) => h.programada && h.valor !== null).reverse(),
        programadosGenerales: deLaAdmin.filter((h) => h.programada).reverse(),
        historialPropio: propias,
        historialGeneral: deLaAdmin,
      };
    }),
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Escritura
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type ParametroFijado = { readonly filaId: string; readonly clave: ClaveParametro; readonly vigenteDesde: string };

/**
 * Fija un valor desde hoy o una fecha futura, en la administración o en un barrio. Al pasar «Cobra
 * interés» a Sí pide confirmación diciendo qué orden de imputación rige y cómo cambiarlo (decisión
 * del titular, T1); el reintento con `confirmarActivarInteres` la da.
 */
export async function fijarParametro(tx: DbConIdentidad, parametros: FijarParametro): Promise<ParametroFijado> {
  const p = fijarParametroSchema.parse(parametros);

  return enBase(async () => {
    // El permiso primero: sin esto, quien no puede editar recibía el pedido de confirmación y recién
    // al confirmar se enteraba de que no podía (revisión de `security-engineer`, B1).
    if (!(await puedeEditar(tx, p.nodoId))) {
      rechazar(
        "sin_permiso",
        "Solo la administración cambia los parámetros de mora.",
        "Pedíselo a quien administra el barrio. Podés ver los valores y su historial, pero no cambiarlos.",
      );
    }
    if (p.clave === "interes.cobra" && p.valor === true && !p.confirmarActivarInteres) {
      const { rows } = await tx.execute<{ valor: unknown; origen: OrigenParametro; vigente_desde: string }>(sql`
        select x.valor, x.origen, x.vigente_desde::text as vigente_desde
          from app.parametro_resuelto(${p.nodoId}::uuid, 'imputacion.orden', ${p.rigeDesde}::date) x
      `);
      const orden = rows[0];
      const def = definicionDe("imputacion.orden");
      const texto = orden ? def.opciones?.find((o) => o.valor === orden.valor)?.texto ?? String(orden.valor) : null;
      rechazar(
        "activar_interes_requiere_confirmacion",
        texto
          ? `Desde el ${formatearFecha(p.rigeDesde)} se va a cobrar interés. Los pagos que no cubran todo el saldo se imputan así: «${texto}» (${
              orden?.origen === "barrio" ? "propio del barrio" : "configuración general"
            }).`
          : `Desde el ${formatearFecha(p.rigeDesde)} se va a cobrar interés, y todavía no hay un orden de imputación definido: hasta que lo fijes, los pagos se imputan a mano.`,
        "Si el reglamento dice otra cosa, cambialo en «Orden de imputación», en esta misma pantalla. Se puede hacer antes o después de confirmar.",
      );
    }

    const { rows } = await tx.execute<{ id: string }>(sql`
      select app.fijar_parametro(
        ${p.nodoId}::uuid, ${p.clave}, ${JSON.stringify(p.valor)}::jsonb, ${p.rigeDesde}::date, ${p.motivo},
        ${p.respaldoTipo}, ${p.respaldoReferencia}, ${p.respaldoAdjunto}
      ) as id
    `);
    const id = rows[0]?.id;
    if (!id) rechazar("desconocido", "No se pudo guardar el cambio.", "Recargá la pantalla y volvé a intentar.");
    return { filaId: id, clave: p.clave, vigenteDesde: p.rigeDesde };
  });
}

/**
 * «Volver al valor general»: desde la fecha elegida el barrio vuelve a heredar, y los valores propios
 * programados para después se anulan con el mismo motivo (lo hace la base).
 */
export async function volverAlValorGeneral(tx: DbConIdentidad, parametros: VolverAlValorGeneral): Promise<ParametroFijado> {
  const p = volverAlValorGeneralSchema.parse(parametros);
  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      select app.fijar_parametro(${p.barrioId}::uuid, ${p.clave}, 'null'::jsonb, ${p.rigeDesde}::date, ${p.motivo}) as id
    `);
    const id = rows[0]?.id;
    if (!id) rechazar("desconocido", "No se pudo guardar el cambio.", "Recargá la pantalla y volvé a intentar.");
    return { filaId: id, clave: p.clave, vigenteDesde: p.rigeDesde };
  });
}

/** Anula un cambio programado (que todavía no rige). Lo que ya rige no se anula: se fija otro valor. */
export async function anularParametroProgramado(tx: DbConIdentidad, parametros: AnularParametro): Promise<{ readonly filaId: string }> {
  const p = anularParametroSchema.parse(parametros);
  return enBase(async () => {
    await tx.execute(sql`select app.anular_parametro_programado(${p.filaId}::uuid, ${p.motivo})`);
    return { filaId: p.filaId };
  });
}

/**
 * Registra el pedido de subida del adjunto de un respaldo y devuelve la clave, **antes** de firmar
 * nada — mismo patrón que `prepararSubidaDeComprobante()`. La policy de insert exige poder editar los
 * parámetros de ese nodo.
 */
export async function prepararSubidaDeRespaldo(
  tx: DbConIdentidad,
  parametros: PrepararSubidaDeRespaldo,
): Promise<{ readonly storageKey: string }> {
  const p = prepararSubidaDeRespaldoSchema.parse(parametros);
  return enBase(async () => {
    const { rows } = await tx.execute<{ tipo: string; puede: boolean }>(sql`
      select n.tipo::text as tipo, app.puede_editar_parametros(n.id) as puede
        from tenant_node n where n.id = ${p.nodoId}::uuid
    `);
    const nodo = rows[0];
    if (!nodo || !nodo.puede || (nodo.tipo !== "administrador" && nodo.tipo !== "barrio")) {
      rechazar(
        "sin_permiso",
        "Solo la administración cambia los parámetros de mora.",
        "Pedíselo a quien administra el barrio.",
      );
    }
    const storageKey = claveDeRespaldo({
      nivel: nodo.tipo === "barrio" ? "barrio" : "administracion",
      nodoId: p.nodoId,
      token: nuevoToken(),
      contentType: p.contentType as ContentTypeDeComprobante,
    });
    await tx.execute(sql`
      insert into subida_respaldo_solicitada (nodo_id, storage_key, content_type)
      values (${p.nodoId}::uuid, ${storageKey}, ${p.contentType})
    `);
    return { storageKey };
  });
}

/**
 * El adjunto de respaldo de una fila, para descargarlo. Bajo RLS: si la fila no es legible, `null`.
 * La ruta de descarga firma la URL con esta clave.
 */
export async function leerAdjuntoDeRespaldo(
  tx: DbConIdentidad,
  parametros: { readonly filaId: string },
): Promise<{ readonly storageKey: string } | null> {
  if (!/^[0-9a-f-]{36}$/.test(parametros.filaId)) return null;
  const { rows } = await tx.execute<{ respaldo_adjunto: string | null }>(sql`
    select respaldo_adjunto from parametro_valor where id = ${parametros.filaId}::uuid
  `);
  const clave = rows[0]?.respaldo_adjunto;
  return clave ? { storageKey: clave } : null;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Para la liquidación: los parámetros con vigencias de una ventana
// ────────────────────────────────────────────────────────────────────────────────────────────────

const CLAVES_INTERES: readonly ClaveParametro[] = [
  "interes.cobra",
  "interes.tasa_compensatoria",
  "interes.tasa_punitoria",
  "interes.gracia_dias",
  "interes.forma_gracia",
  "interes.tolerancia",
];

function aValorUsado(f: FilaResuelta): ValorUsado {
  return {
    valor: f.valor,
    origen: f.origen,
    vigenteDesde: f.vigente_desde,
    carga: f.carga,
    filaId: f.fila_id,
    respaldo: respaldoDe(f),
  };
}

function aParametrosMora(m: Map<ClaveParametro, FilaResuelta>): ParametrosMora | null {
  if (CLAVES_INTERES.some((c) => !m.has(c))) return null;
  const v = (c: ClaveParametro) => m.get(c)?.valor;
  return {
    cobra: v("interes.cobra") === true,
    tasaCompensatoria: String(v("interes.tasa_compensatoria")),
    tasaPunitoria: String(v("interes.tasa_punitoria")),
    graciaDias: Number(v("interes.gracia_dias")),
    formaGracia: v("interes.forma_gracia") as FormaGracia,
    tolerancia: String(v("interes.tolerancia")),
  };
}

export type ParametrosDeLaVentana = {
  /** `null` si falta algún parámetro de interés: no se inventa (la liquidación sale "pendiente"). */
  readonly vigencias: VigenciasMora | null;
  /** Los valores a la fecha de referencia, con su origen: lo que queda guardado en la liquidación. */
  readonly valores: Readonly<Record<string, ValorUsado>>;
  readonly tramos: readonly { desde: string; cobra: boolean; tasaCompensatoria: string; tasaPunitoria: string }[];
};

/**
 * Los parámetros de un barrio para la ventana `(inicio, corte]`, con cada cambio que caiga adentro.
 * `inicio` es `corte − días`. La resolución de cada fecha la hace la base; acá solo se arma la
 * función `en(fecha)` que busca el último corte ≤ fecha.
 */
export async function parametrosParaLaVentana(
  tx: DbConIdentidad,
  entrada: { readonly barrioId: string; readonly inicio: string; readonly corte: string },
): Promise<ParametrosDeLaVentana> {
  const { rows } = await tx.execute<{ d: string }>(sql`
    select d::text as d from app.parametros_cambios(${entrada.barrioId}::uuid, ${entrada.inicio}::date, ${entrada.corte}::date) d
  `);
  const cambios = rows.map((r) => r.d);
  const fechas = [...new Set([entrada.inicio, ...cambios, entrada.corte])].sort();
  const porFecha = new Map<string, Map<ClaveParametro, FilaResuelta>>();
  for (const f of fechas) porFecha.set(f, await resueltos(tx, entrada.barrioId, f));

  const alCorte = porFecha.get(entrada.corte) ?? new Map();
  const valores: Record<string, ValorUsado> = {};
  for (const [clave, f] of alCorte) valores[clave] = aValorUsado(f);

  const conocidos = fechas.map((f) => ({ f, p: aParametrosMora(porFecha.get(f) ?? new Map()) }));
  if (conocidos.some((c) => c.p === null)) return { vigencias: null, valores, tramos: [] };
  const vigencias: VigenciasMora = {
    cambios,
    en: (fecha) => {
      let elegido = conocidos[0]!.p!;
      for (const c of conocidos) if (c.f <= fecha) elegido = c.p!;
      return elegido;
    },
  };
  // El primer tramo arranca el día SIGUIENTE al inicio (la ventana es `(inicio, corte]`), y dos tramos
  // seguidos iguales son uno: un cambio que no movió nada de lo que pesa día a día (una fila tapada
  // por el valor propio, un cambio al mismo valor) no es un cambio de tasa.
  const tramos: { desde: string; cobra: boolean; tasaCompensatoria: string; tasaPunitoria: string }[] = [];
  // Sin días de atraso no hay ventana: un solo "tramo" con lo que rige a la fecha de referencia.
  const primero = entrada.inicio === entrada.corte ? entrada.corte : sumarDias(entrada.inicio, 1);
  for (const desde of [primero, ...cambios]) {
    const p = vigencias.en(desde);
    const t = { desde, cobra: p.cobra, tasaCompensatoria: p.tasaCompensatoria, tasaPunitoria: p.tasaPunitoria };
    const previo = tramos[tramos.length - 1];
    if (previo && previo.cobra === t.cobra && previo.tasaCompensatoria === t.tasaCompensatoria && previo.tasaPunitoria === t.tasaPunitoria) continue;
    tramos.push(t);
  }
  return { vigencias, valores, tramos };
}

/** Texto de un valor para mostrar (reexport para las pantallas, que no importan `shared` dos veces). */
export { textoDeValor };
