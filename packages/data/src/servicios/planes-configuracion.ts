/**
 * P2a-1 — **Configuración general › Planes de pago** (maqueta de planes, pantalla 1): el catálogo de
 * planes estándar de la administración (alta, edición y baja), para qué barrios y con qué estudio, y
 * las reglas de los planes en cada barrio (`plan_parametro_barrio`: con cuántas cuotas impagas cae, qué
 * va primero al imputar, si se financia la mora y si una quita necesita el acta).
 *
 * Las reglas de negocio las vuelven a controlar la base (checks de `plan_catalogo`, el trigger de
 * `plan_catalogo_barrio` que exige que el barrio sea de la administración) y la RLS: este servicio no
 * es la última palabra, solo traduce la pantalla.
 */
import { sql } from "drizzle-orm";
import { idSchema } from "@admin-barrios/shared/consultas";
import { tasaDePorcentaje, porcentajeDeTasa } from "@admin-barrios/shared/activacion";
import type { Monto } from "@admin-barrios/shared/dinero";
import {
  bajaPlanDelCatalogoSchema,
  guardarPlanDelCatalogoSchema,
  guardarReglasGeneralesDePlanesSchema,
  guardarFirmanteDelConvenioSchema,
  guardarReglasDePlanesSchema,
  ORDEN_DE_IMPUTACION_POR_DEFECTO,
  TOPE_TASA_A_MEDIDA_POR_DEFECTO,
  REGLAS_DE_PLANES_POR_DEFECTO,
  type AnticipoDeCatalogo,
  type BajaPlanDelCatalogo,
  type GuardarReglasGeneralesDePlanes,
  type GuardarFirmanteDelConvenio,
  type GuardarPlanDelCatalogo,
  type GuardarReglasDePlanes,
  type ModoDeCobro,
  type OrdenDeImputacion,
  type SistemaDeCatalogo,
  type TipoDeFirmante,
} from "@admin-barrios/shared/planes";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";

export type PlanDelCatalogo = {
  readonly id: string;
  readonly nombre: string;
  readonly sistema: SistemaDeCatalogo;
  /** Como se escribe en pantalla: `2`, `2,5`. `null` en cuota fija. */
  readonly tasaPorcentaje: string | null;
  readonly cuotasMin: number;
  readonly cuotasMax: number;
  readonly anticipo: AnticipoDeCatalogo;
  readonly anticipoMaxPorcentaje: string | null;
  readonly deudaMaxima: Monto | null;
  readonly estudio: { readonly id: string; readonly nombre: string } | null;
  readonly modoCobro: ModoDeCobro;
  readonly activo: boolean;
  readonly barrios: readonly { readonly id: string; readonly nombre: string }[];
  /** Planes firmados o propuestos con este plan del catálogo. */
  readonly usos: number;
};

export type ReglasDelBarrio = {
  readonly barrioId: string;
  readonly barrio: string;
  readonly cuotasParaCaer: number;
  /** El reemplazo del barrio; `null` = «Como la administración» (`0098`). */
  readonly ordenImputacion: OrdenDeImputacion | null;
  /** El que rige: el del barrio o, si no tiene, el general. */
  readonly ordenImputacionEfectivo: OrdenDeImputacion;
  readonly financiaMora: boolean;
  readonly quitaRequiereActa: boolean;
  /** F4 tramo 3 (`0100`): la rendición la confirma otra persona. */
  readonly rendicionCuatroOjos: boolean;
  /** false: rigen las de por defecto (nadie las guardó todavía). */
  readonly cargadas: boolean;
};

export type ConfiguracionDePlanes = {
  readonly administracion: { readonly id: string; readonly nombre: string };
  readonly puedeEditar: boolean;
  /**
   * El orden de imputación general entre la cuota del plan y la expensa (`plan_parametro_administracion`,
   * `0098`). Sin fila, la más vieja primero.
   */
  readonly ordenImputacionGeneral: OrdenDeImputacion;
  /** F4 tramo 2 (`0099`): el tope de tasa mensual equivalente de un plan a medida, en % como en pantalla (`10`). */
  readonly topeTasaPorcentaje: string;
  readonly planes: readonly PlanDelCatalogo[];
  /** Los estudios vinculados y activos, para el selector «Acordado con». */
  readonly estudios: readonly { readonly id: string; readonly nombre: string }[];
  readonly barrios: readonly { readonly id: string; readonly nombre: string }[];
  readonly reglas: readonly ReglasDelBarrio[];
};

export async function configuracionDePlanes(
  tx: DbConIdentidad,
  parametros: { readonly administracionId: string },
): Promise<ConfiguracionDePlanes | null> {
  const administracionId = idSchema.parse(parametros.administracionId);
  const { rows: admin } = await tx.execute<{ nombre: string; puede: boolean; orden: OrdenDeImputacion | null; tope: string | null }>(sql`
    select a.nombre, ${administracionId}::uuid in (select app.administraciones_administradas()) as puede,
           (select pa.orden_imputacion from plan_parametro_administracion pa where pa.administracion_id = a.id) as orden,
           (select pa.tope_tasa_a_medida::text from plan_parametro_administracion pa where pa.administracion_id = a.id) as tope
      from tenant_node a where a.id = ${administracionId} and a.tipo = 'administrador' and a.deleted_at is null
  `);
  if (!admin[0]) return null;
  const ordenGeneral = admin[0].orden ?? ORDEN_DE_IMPUTACION_POR_DEFECTO;

  const { rows: barrios } = await tx.execute<{ id: string; nombre: string }>(sql`
    select n.id, n.nombre from tenant_node n
     where n.parent_id = ${administracionId} and n.tipo = 'barrio' and n.deleted_at is null
       and n.id in (select app.readable_tenant_ids())
     order by n.nombre
  `);
  const { rows: estudios } = await tx.execute<{ id: string; nombre: string }>(sql`
    select ea.estudio_id as id, ea.nombre from estudio_administracion ea
     where ea.administracion_id = ${administracionId} and ea.activo order by ea.nombre
  `);
  const { rows: planes } = await tx.execute<{
    id: string;
    nombre: string;
    sistema: SistemaDeCatalogo;
    tasa: string;
    cuotas_min: number;
    cuotas_max: number;
    anticipo: AnticipoDeCatalogo;
    anticipo_max: string | null;
    deuda_maxima: string | null;
    estudio_id: string | null;
    estudio: string | null;
    modo_cobro: ModoDeCobro;
    activo: boolean;
    barrios: { id: string; nombre: string }[] | null;
    usos: number;
  }>(sql`
    select c.id, c.nombre, c.sistema, c.tasa_mensual::text as tasa, c.cuotas_min, c.cuotas_max, c.anticipo,
           c.anticipo_max_pct::text as anticipo_max, c.deuda_maxima::text as deuda_maxima, c.estudio_id,
           (select ea.nombre from estudio_administracion ea where ea.estudio_id = c.estudio_id and ea.administracion_id = c.administracion_id) as estudio,
           c.modo_cobro, c.activo,
           (select json_agg(json_build_object('id', n.id, 'nombre', n.nombre) order by n.nombre)
              from plan_catalogo_barrio cb join tenant_node n on n.id = cb.barrio_id where cb.catalogo_id = c.id) as barrios,
           (select count(*)::int from plan_pago p where p.catalogo_id = c.id) as usos
      from plan_catalogo c
     where c.administracion_id = ${administracionId}
     order by c.activo desc, c.nombre
  `);
  const { rows: reglas } = await tx.execute<{
    barrio_id: string;
    cuotas_para_caer: number;
    orden_imputacion: OrdenDeImputacion | null;
    financia_mora: boolean;
    quita_requiere_acta: boolean;
    rendicion_cuatro_ojos: boolean;
  }>(sql`
    select barrio_id, cuotas_para_caer, orden_imputacion, financia_mora, quita_requiere_acta, rendicion_cuatro_ojos
      from plan_parametro_barrio where barrio_id = any(${sql.param(barrios.map((b) => b.id))}::uuid[])
  `);
  const reglaDe = new Map(reglas.map((r) => [r.barrio_id, r]));

  return {
    administracion: { id: administracionId, nombre: admin[0].nombre },
    puedeEditar: admin[0].puede,
    ordenImputacionGeneral: ordenGeneral,
    topeTasaPorcentaje: porcentajeDeTasa(admin[0].tope ?? TOPE_TASA_A_MEDIDA_POR_DEFECTO),
    planes: planes.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      sistema: p.sistema,
      tasaPorcentaje: p.sistema === "frances" ? porcentajeDeTasa(p.tasa) : null,
      cuotasMin: p.cuotas_min,
      cuotasMax: p.cuotas_max,
      anticipo: p.anticipo,
      anticipoMaxPorcentaje: p.anticipo_max === null ? null : porcentajeDeTasa(fraccionDePorcentaje(p.anticipo_max)),
      deudaMaxima: p.deuda_maxima as Monto | null,
      estudio: p.estudio_id ? { id: p.estudio_id, nombre: p.estudio ?? "Estudio" } : null,
      modoCobro: p.modo_cobro,
      activo: p.activo,
      barrios: p.barrios ?? [],
      usos: p.usos,
    })),
    estudios,
    barrios,
    reglas: barrios.map((b) => {
      const r = reglaDe.get(b.id);
      return {
        barrioId: b.id,
        barrio: b.nombre,
        cuotasParaCaer: r?.cuotas_para_caer ?? REGLAS_DE_PLANES_POR_DEFECTO.cuotasParaCaer,
        ordenImputacion: r?.orden_imputacion ?? REGLAS_DE_PLANES_POR_DEFECTO.ordenImputacion,
        ordenImputacionEfectivo: r?.orden_imputacion ?? ordenGeneral,
        financiaMora: r?.financia_mora ?? REGLAS_DE_PLANES_POR_DEFECTO.financiaMora,
        quitaRequiereActa: r?.quita_requiere_acta ?? REGLAS_DE_PLANES_POR_DEFECTO.quitaRequiereActa,
        rendicionCuatroOjos: r?.rendicion_cuatro_ojos ?? REGLAS_DE_PLANES_POR_DEFECTO.rendicionCuatroOjos,
        cargadas: r !== undefined,
      };
    }),
  };
}

/** `anticipo_max_pct` se guarda como porcentaje (`30.00`): a fracción para reusar `porcentajeDeTasa`. */
function fraccionDePorcentaje(pct: string): string {
  const t = tasaDePorcentaje(pct);
  return t ?? "0";
}

/** De lo que se escribe en pantalla a lo que guarda la base. */
function aPorcentajeDeLaBase(texto: string): string {
  const fraccion = tasaDePorcentaje(texto);
  if (fraccion === null) rechazar("dato_invalido", "El porcentaje no es válido.", "Escribí un número entre 0 y 100, por ejemplo 30.");
  // fracción (0.300000) → porcentaje con dos decimales (30.00).
  const millonesimas = BigInt(fraccion.replace(".", ""));
  const centesimas = millonesimas / 100n;
  return `${centesimas / 100n}.${(centesimas % 100n).toString().padStart(2, "0")}`;
}

/**
 * Alta o edición de un plan del catálogo, con sus barrios. Editar no cambia los planes ya firmados:
 * cada plan guarda su sistema, su tasa y su cronograma al firmarse.
 */
export async function guardarPlanDelCatalogo(tx: DbConIdentidad, parametros: GuardarPlanDelCatalogo): Promise<{ readonly planId: string }> {
  const q = guardarPlanDelCatalogoSchema.parse(parametros);
  return enBase(async () => {
    const tasa = q.sistema === "frances" && q.tasaPorcentaje !== null ? tasaDePorcentaje(q.tasaPorcentaje) : "0";
    if (tasa === null) rechazar("dato_invalido", "La tasa no es válida.", "Escribí la tasa mensual en %, por ejemplo 2 o 2,5.");
    const anticipoMax = q.anticipo === "no" || q.anticipoMaxPorcentaje === null ? null : aPorcentajeDeLaBase(q.anticipoMaxPorcentaje);
    // El estudio tiene que trabajar con la administración (el vínculo activo).
    if (q.estudioId !== null) {
      const { rows } = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from estudio_administracion
         where estudio_id = ${q.estudioId} and administracion_id = ${q.administracionId} and activo
      `);
      if ((rows[0]?.n ?? 0) === 0) rechazar("referencia_inexistente", "Ese estudio no trabaja con la administración.", "Elegí otro o vinculalo en Estudios jurídicos.");
    }

    let planId = q.planId;
    if (planId === null) {
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into plan_catalogo (administracion_id, nombre, sistema, tasa_mensual, cuotas_min, cuotas_max, anticipo, anticipo_max_pct,
                                   deuda_maxima, estudio_id, modo_cobro, creado_por)
        values (${q.administracionId}, ${q.nombre}, ${q.sistema}, ${tasa}::numeric, ${q.cuotasMin}, ${q.cuotasMax}, ${q.anticipo},
                ${anticipoMax}::numeric, ${q.deudaMaxima}::numeric, ${q.estudioId}, ${q.modoCobro}, app.current_user_id())
        returning id
      `);
      planId = rows[0]!.id;
    } else {
      // [P2a-2] Los barrios se sacan ANTES de cambiar el estudio: la base controla que el estudio trabaje en
      // cada barrio del plan (`0095`), y tiene que mirar los barrios nuevos, no los que se van.
      await tx.execute(sql`delete from plan_catalogo_barrio where catalogo_id = ${planId}`);
      const { rows } = await tx.execute<{ id: string }>(sql`
        update plan_catalogo set nombre = ${q.nombre}, sistema = ${q.sistema}, tasa_mensual = ${tasa}::numeric,
               cuotas_min = ${q.cuotasMin}, cuotas_max = ${q.cuotasMax}, anticipo = ${q.anticipo}, anticipo_max_pct = ${anticipoMax}::numeric,
               deuda_maxima = ${q.deudaMaxima}::numeric, estudio_id = ${q.estudioId}, modo_cobro = ${q.modoCobro}
         where id = ${planId} and administracion_id = ${q.administracionId} and activo
        returning id
      `);
      if (!rows[0]) rechazar("referencia_inexistente", "Ese plan no existe, está dado de baja o no tenés acceso.", "Recargá la lista.");
    }
    for (const barrioId of new Set(q.barrioIds)) {
      await tx.execute(sql`insert into plan_catalogo_barrio (catalogo_id, barrio_id) values (${planId}, ${barrioId})`);
    }
    return { planId };
  });
}

/**
 * Da de baja un plan del catálogo: no se ofrece más. Los planes ya firmados con él siguen igual (no se
 * borra: queda como referencia de dónde salieron).
 */
export async function darDeBajaPlanDelCatalogo(tx: DbConIdentidad, parametros: BajaPlanDelCatalogo): Promise<void> {
  const q = bajaPlanDelCatalogoSchema.parse(parametros);
  await enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      update plan_catalogo set activo = false where id = ${q.planId} and administracion_id = ${q.administracionId} and activo returning id
    `);
    if (!rows[0]) rechazar("referencia_inexistente", "Ese plan no existe, ya está dado de baja o no tenés acceso.", "Recargá la lista.");
  });
}

/** Guarda las reglas de los planes de un barrio (alta la primera vez, después se actualizan). */
export async function guardarReglasDePlanes(tx: DbConIdentidad, parametros: GuardarReglasDePlanes): Promise<void> {
  const q = guardarReglasDePlanesSchema.parse(parametros);
  await enBase(async () => {
    const { rows } = await tx.execute<{ barrio_id: string }>(sql`
      update plan_parametro_barrio set cuotas_para_caer = ${q.cuotasParaCaer}, orden_imputacion = ${q.ordenImputacion},
             financia_mora = ${q.financiaMora}, quita_requiere_acta = ${q.quitaRequiereActa},
             rendicion_cuatro_ojos = coalesce(${q.rendicionCuatroOjos ?? null}::boolean, rendicion_cuatro_ojos)
       where barrio_id = ${q.barrioId} returning barrio_id
    `);
    if (!rows[0]) {
      await tx.execute(sql`
        insert into plan_parametro_barrio (barrio_id, cuotas_para_caer, orden_imputacion, financia_mora, quita_requiere_acta, rendicion_cuatro_ojos)
        values (${q.barrioId}, ${q.cuotasParaCaer}, ${q.ordenImputacion}, ${q.financiaMora}, ${q.quitaRequiereActa}, coalesce(${q.rendicionCuatroOjos ?? null}::boolean, false))
      `);
    }
  });
}

/**
 * Las reglas generales de los planes de la administración: el orden de imputación entre la cuota del plan
 * y la expensa (F4 tramo 1, `0098`; lo usan los barrios sin uno propio) y el tope de tasa mensual
 * equivalente de un plan a medida (F4 tramo 2, `0099`). Alta la primera vez, después se actualiza; la
 * historia la escribe la base.
 */
export async function guardarReglasGeneralesDePlanes(tx: DbConIdentidad, parametros: GuardarReglasGeneralesDePlanes): Promise<void> {
  const q = guardarReglasGeneralesDePlanesSchema.parse(parametros);
  const tope = tasaDePorcentaje(q.topeTasaPorcentaje);
  if (tope === null) rechazar("dato_invalido", "El tope no es válido.", "Escribí el tope mensual en %, por ejemplo 10 o 7,5.");
  await enBase(async () => {
    const { rows } = await tx.execute<{ administracion_id: string }>(sql`
      insert into plan_parametro_administracion (administracion_id, orden_imputacion, tope_tasa_a_medida)
      select ${q.administracionId}, ${q.ordenImputacion}, ${tope}::numeric
       where ${q.administracionId}::uuid in (select app.administraciones_administradas())
      on conflict (administracion_id) do update
        set orden_imputacion = excluded.orden_imputacion, tope_tasa_a_medida = excluded.tope_tasa_a_medida
      returning administracion_id
    `);
    if (!rows[0]) rechazar("referencia_inexistente", "Esa administración no existe o no tenés permiso para cambiarla.", "Recargá la pantalla.");
  });
}

/**
 * El orden que rige en un barrio entre la cuota del plan y la expensa (el del barrio o el general). Lo
 * usa la pantalla de Cobros para saber si ofrece el selector («a elección de quien registra»). La
 * imputación no lo lee de acá: lo resuelve la base (`app.resolver_imputacion`).
 */
export async function ordenDeImputacionDelBarrio(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<OrdenDeImputacion> {
  const barrioId = idSchema.parse(parametros.barrioId);
  // La misma función que usa la imputación (`app.orden_plan_del_barrio`, `0098`): una sola definición del
  // «barrio → administración → la más vieja». Solo sobre un barrio que quien pregunta puede leer.
  const { rows } = await tx.execute<{ orden: OrdenDeImputacion | null }>(sql`
    select app.orden_plan_del_barrio(n.id) as orden
      from tenant_node n where n.id = ${barrioId} and n.tipo = 'barrio' and n.id in (select app.readable_tenant_ids())
  `);
  return rows[0]?.orden ?? ORDEN_DE_IMPUTACION_POR_DEFECTO;
}

/**
 * F4 tramo 2 (`0099`): el tope de tasa mensual equivalente de un plan a medida que rige en un barrio (el de
 * su administración; sin fila, el del catálogo, 10 %). Fracción con seis decimales (`"0.100000"`).
 */
export async function topeDeTasaAMedidaDelBarrio(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<string> {
  const barrioId = idSchema.parse(parametros.barrioId);
  // La función definer (`0099`): no cae al 10 % porque una RLS esconda la fila. Solo sobre un barrio legible.
  const { rows } = await tx.execute<{ tope: string | null }>(sql`
    select to_char(app.tope_tasa_a_medida_del_barrio(n.id), 'FM0.000000') as tope
      from tenant_node n where n.id = ${barrioId} and n.tipo = 'barrio' and n.id in (select app.readable_tenant_ids())
  `);
  return rows[0]?.tope ?? TOPE_TASA_A_MEDIDA_POR_DEFECTO;
}

/** F4 tramo 3 (`0100`): quién firma los convenios por el barrio. `null`: nadie cargado (el convenio sale como antes). */
export type FirmanteDelConvenio = {
  readonly tipo: TipoDeFirmante;
  readonly nombre: string;
  readonly cargo: string | null;
  readonly poder: string | null;
} | null;

export async function firmanteDelConvenio(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<FirmanteDelConvenio> {
  const barrioId = idSchema.parse(parametros.barrioId);
  const { rows } = await tx.execute<{ tipo: TipoDeFirmante | null; nombre: string | null; cargo: string | null; poder: string | null }>(sql`
    select firmante_tipo as tipo, firmante_nombre as nombre, firmante_cargo as cargo, firmante_poder as poder
      from plan_parametro_barrio where barrio_id = ${barrioId}
  `);
  const r = rows[0];
  return r?.tipo && r.nombre ? { tipo: r.tipo, nombre: r.nombre, cargo: r.cargo, poder: r.poder } : null;
}

/**
 * Guarda quién firma los convenios por el barrio (alta de las reglas del barrio si no estaban, con las de
 * por defecto). La base controla que estén los datos del tipo (`plan_parametro_firmante_chk`) y quién puede.
 */
export async function guardarFirmanteDelConvenio(tx: DbConIdentidad, parametros: GuardarFirmanteDelConvenio): Promise<void> {
  const q = guardarFirmanteDelConvenioSchema.parse(parametros);
  await enBase(async () => {
    const { rows } = await tx.execute<{ barrio_id: string }>(sql`
      update plan_parametro_barrio set firmante_tipo = ${q.tipo}, firmante_nombre = ${q.nombre}, firmante_cargo = ${q.cargo}, firmante_poder = ${q.poder}
       where barrio_id = ${q.barrioId} returning barrio_id
    `);
    if (!rows[0]) {
      await tx.execute(sql`
        insert into plan_parametro_barrio (barrio_id, firmante_tipo, firmante_nombre, firmante_cargo, firmante_poder)
        values (${q.barrioId}, ${q.tipo}, ${q.nombre}, ${q.cargo}, ${q.poder})
      `);
    }
  });
}
