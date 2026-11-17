/**
 * La mora del lado de la administración y los estudios jurídicos (encargo E-a, BL-050; `0091`).
 *
 * **Nada de esto calcula plata.** La deuda de cada unidad sale de `deudaALaFecha` (`deuda.ts`), la
 * misma cuenta del estado de cuenta y de la boleta, a la fecha de hoy en la hora del barrio. Acá se la
 * resume (meses vencidos, capital vencido, interés a hoy), se la compara con el criterio para
 * **proponer** derivaciones y se la congela en la foto de la derivación. Ninguna tabla de mora entra
 * al cupón, al interés ni a la imputación.
 *
 * Quién puede qué lo decide la RLS de `0091`: leer, cualquier rol de gestión; derivar, retirar y
 * configurar, la administración; las gestiones, también el operador.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { aCentavos, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { formatearCuit } from "@admin-barrios/shared/cuentas";
import { idSchema } from "@admin-barrios/shared/consultas";
import {
  agregarEstudioSchema,
  bajaEstudioSchema,
  buscarEstudioSchema,
  criterioAdministracionSchema,
  criterioEfectivo,
  CRITERIO_POR_DEFECTO,
  derivarSchema,
  editarVinculoSchema,
  estadoPromesa,
  estudioDelBarrioSchema,
  evaluarCriterio,
  LEYENDA_BASE,
  moraBarrioSchema,
  retirarSchema,
  situacionMora,
  vincularEstudioSchema,
  type AgregarEstudio,
  type BajaEstudio,
  type CanalGestion,
  type CriterioAdministracion,
  type CriterioMora,
  type Derivar,
  type EditarVinculo,
  type EstadoPromesa,
  type EstudioDelBarrio,
  type MoraBarrio,
  type OrigenDelCriterio,
  type PactoEjecutividad,
  type PreferenciaAviso,
  type ResultadoGestion,
  type Retirar,
  type SituacionMora,
  type VincularEstudio,
} from "@admin-barrios/shared/mora";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";
import { deudaALaFecha, type DeudaDeUnidad } from "./deuda.ts";
import { pagadoParaPromesa } from "./gestiones.ts";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lectura: la lista de mora
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type EstudioDelBarrioVista = {
  readonly id: string;
  readonly nombre: string;
  readonly porDefecto: boolean;
};

export type BarrioDeMora = {
  readonly id: string;
  readonly nombre: string;
  readonly hoy: string;
  readonly criterio: CriterioMora;
  readonly origenCriterio: OrigenDelCriterio;
  /** Los estudios que trabajan en el barrio: los únicos que ofrece el diálogo de derivar. */
  readonly estudios: readonly EstudioDelBarrioVista[];
  /**
   * Si quien mira puede derivar en este barrio: el mismo `has_role_on` de la policy de `derivacion`
   * (`0091`). Es solo para no ofrecer las casillas a quien la base le va a rechazar; la RLS decide igual.
   */
  readonly puedeDerivar: boolean;
};

export type UltimaGestion = {
  readonly fecha: string;
  readonly canal: CanalGestion;
  readonly resultado: ResultadoGestion | null;
  readonly autor: "administracion" | "estudio";
  /**
   * Si la última gestión es el renglón de una derivación que después se retiró, el día del retiro
   * (`YYYY-MM-DD`, en la hora del barrio): la pantalla dice «Retirada del estudio» y no «Derivación».
   */
  readonly retiradaEl: string | null;
};

export type PromesaDeUnidad = {
  readonly gestionId: string;
  readonly fecha: string;
  readonly monto: Monto;
  readonly pagado: Monto;
  readonly estado: EstadoPromesa;
};

export type FilaMora = {
  readonly barrioId: string;
  readonly barrio: string;
  readonly unidadFuncionalId: string;
  readonly unidad: string;
  readonly titular: string | null;
  /** Meses con capital vencido e impago. */
  readonly meses: number;
  /** Capital de esos meses. */
  readonly capital: Monto;
  /** Interés a hoy (el pendiente ya registrado más el del tramo al día de hoy). */
  readonly interes: Monto;
  readonly situacion: SituacionMora;
  /** Pasa los meses del criterio de su barrio (aunque no llegue al monto). */
  readonly pasaLosMeses: boolean;
  readonly derivacion: {
    readonly id: string;
    readonly estudioId: string;
    readonly estudio: string;
    readonly desde: string;
  } | null;
  readonly ultimaGestion: UltimaGestion | null;
  /** La última promesa no anulada, con su estado resuelto con lo imputado. */
  readonly promesa: PromesaDeUnidad | null;
  /** Hay una intimación registrada (resultado «Intimación entregada» o una carta documento). */
  readonly conIntimacion: boolean;
};

export type Mora = {
  readonly administracion: { readonly id: string; readonly nombre: string };
  readonly barrios: readonly BarrioDeMora[];
  readonly filas: readonly FilaMora[];
};

/**
 * Orden «natural» sin `localeCompare` (sin ICU completo no es estable; ver `conceptos-del-mes.ts`):
 * los tramos de dígitos se comparan como números, así «Mza 2» va antes que «Mza 10».
 */
function compararNatural(a: string, b: string): number {
  const pa = a.split(/(\d+)/);
  const pb = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (x === y) continue;
    if (i % 2 === 1) return Number(x) - Number(y) || (x < y ? -1 : 1);
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

type FilaBarrio = { id: string; nombre: string; hoy: string; administracion_id: string; administracion: string | null; puede_derivar: boolean };

/** Los barrios de una administración que quien mira puede leer (la RLS de `barrio` decide). */
async function barriosDeLaAdministracion(
  tx: DbConIdentidad,
  filtro: { readonly administracionId: string } | { readonly barrioId: string },
): Promise<FilaBarrio[]> {
  const admin = "administracionId" in filtro ? idSchema.parse(filtro.administracionId) : null;
  const barrio = "barrioId" in filtro ? idSchema.parse(filtro.barrioId) : null;
  const { rows } = await tx.execute<FilaBarrio>(sql`
    select b.barrio_id as id, n.nombre, (now() at time zone b.zona_horaria)::date::text as hoy,
           n.parent_id as administracion_id, (select a.nombre from tenant_node a where a.id = n.parent_id) as administracion,
           app.has_role_on(b.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) as puede_derivar
      from barrio b join tenant_node n on n.id = b.barrio_id
     where n.deleted_at is null
       and (${admin}::uuid is null or n.parent_id = ${admin}::uuid)
       and (${barrio}::uuid is null or b.barrio_id = ${barrio}::uuid)
     order by n.nombre
  `);
  return rows;
}

/** El criterio de la administración, o `null` si todavía no cargó uno. */
async function criterioDeAdministracion(tx: DbConIdentidad, administracionId: string): Promise<(CriterioMora & { leyendaBoleta: string }) | null> {
  const { rows } = await tx.execute<{ meses: number; monto_minimo: string; pedir_intimacion: boolean; leyenda_boleta: string }>(sql`
    select meses::int as meses, monto_minimo::text as monto_minimo, pedir_intimacion, leyenda_boleta
      from mora_criterio_administracion where administracion_id = ${administracionId}
  `);
  const f = rows[0];
  return f ? { meses: f.meses, montoMinimo: f.monto_minimo as Monto, pedirIntimacion: f.pedir_intimacion, leyendaBoleta: f.leyenda_boleta } : null;
}

type FilaMoraBarrio = { barrio_id: string; meses: number | null; monto_minimo: string | null; pedir_intimacion: boolean | null; leyenda_boleta: string | null };

async function moraDeBarrios(tx: DbConIdentidad, barrioIds: readonly string[]): Promise<Map<string, FilaMoraBarrio>> {
  if (barrioIds.length === 0) return new Map();
  const { rows } = await tx.execute<FilaMoraBarrio>(sql`
    select barrio_id, meses::int as meses, monto_minimo::text as monto_minimo, pedir_intimacion, leyenda_boleta
      from mora_barrio where barrio_id = any(${sql.param([...barrioIds])}::uuid[])
  `);
  return new Map(rows.map((r) => [r.barrio_id, r]));
}

async function estudiosDeBarrios(tx: DbConIdentidad, barrioIds: readonly string[]): Promise<Map<string, EstudioDelBarrioVista[]>> {
  const porBarrio = new Map<string, EstudioDelBarrioVista[]>();
  if (barrioIds.length === 0) return porBarrio;
  const { rows } = await tx.execute<{ barrio_id: string; id: string; nombre: string; por_defecto: boolean }>(sql`
    select eb.barrio_id, ea.estudio_id as id, ea.nombre, eb.por_defecto
      from estudio_barrio eb
      join tenant_node n on n.id = eb.barrio_id
      join estudio_administracion ea on ea.estudio_id = eb.estudio_id and ea.administracion_id = n.parent_id
     where eb.barrio_id = any(${sql.param([...barrioIds])}::uuid[])
     order by eb.por_defecto desc, ea.nombre
  `);
  for (const r of rows) {
    const lista = porBarrio.get(r.barrio_id) ?? [];
    lista.push({ id: r.id, nombre: r.nombre, porDefecto: r.por_defecto });
    porBarrio.set(r.barrio_id, lista);
  }
  return porBarrio;
}

/** Lo vencido de una unidad a `hoy`, leído de `deudaALaFecha` mes por mes. No se recalcula nada. */
function resumenVencido(d: DeudaDeUnidad, hoy: string): { meses: number; capital: Monto; interes: Monto } {
  const vencidos = d.porMes.filter((m) => m.vencimiento < hoy && aCentavos(m.capital) > 0n);
  return {
    meses: vencidos.length,
    capital: sumarMontos("0.00", ...vencidos.map((m) => m.capital)),
    // El interés de la unidad entero: el ya registrado y pendiente más el del tramo de hoy.
    interes: sumarMontos(d.interesPendiente, d.interesNuevo),
  };
}

/**
 * La lista de mora: las unidades con deuda vencida (y las derivadas) de los barrios de una
 * administración, o de un solo barrio. Una consulta de deuda por barrio (`deudaALaFecha`, la de
 * siempre) y una de cada dato de mora para todos juntos.
 */
export async function moraDeLaAdministracion(
  tx: DbConIdentidad,
  parametros: { readonly administracionId: string } | { readonly barrioId: string },
): Promise<Mora | null> {
  const barrios = await barriosDeLaAdministracion(tx, parametros);
  const primero = barrios[0];
  if (!primero) return null;
  const administracion = { id: primero.administracion_id, nombre: primero.administracion ?? "La administración" };
  const ids = barrios.map((b) => b.id);
  // En serie: las tres van por la misma `tx`, y `node-postgres` encola igual (regla 16).
  const criterioAdmin = await criterioDeAdministracion(tx, administracion.id);
  const propios = await moraDeBarrios(tx, ids);
  const estudios = await estudiosDeBarrios(tx, ids);

  const { rows: unidades } = await tx.execute<{ id: string; barrio_id: string; manzana: string; lote: string; titular: string | null }>(sql`
    select u.id, u.barrio_id, u.manzana, u.lote,
           (select o.nombre from unidad_obligado uo join obligado o on o.id = uo.obligado_id
             where uo.unidad_funcional_id = u.id and uo.hasta is null
             order by uo.es_notificado desc, o.nombre limit 1) as titular
      from unidad_funcional u where u.barrio_id = any(${sql.param(ids)}::uuid[])
  `);
  const unidadDe = new Map(unidades.map((u) => [u.id, u]));

  const { rows: derivaciones } = await tx.execute<{ id: string; unidad_funcional_id: string; estudio_id: string; estudio: string; desde: string }>(sql`
    select d.id, d.unidad_funcional_id, d.estudio_id, ea.nombre as estudio, d.derivada_at::date::text as desde
      from derivacion d
      join tenant_node n on n.id = d.barrio_id
      join estudio_administracion ea on ea.estudio_id = d.estudio_id and ea.administracion_id = n.parent_id
     where d.barrio_id = any(${sql.param(ids)}::uuid[]) and d.retirada_at is null
  `);
  const derivacionDe = new Map(derivaciones.map((d) => [d.unidad_funcional_id, d]));

  const { rows: ultimas } = await tx.execute<{
    unidad_funcional_id: string;
    fecha: string;
    canal: CanalGestion;
    resultado: ResultadoGestion | null;
    autor_tipo: "administracion" | "estudio";
    retirada_el: string | null;
  }>(sql`
    -- Una búsqueda por unidad con \`idx_gestion_unidad\` (dba-data): la tabla solo crece, y un
    -- \`distinct on\` sobre todas las gestiones de la administración la ordenaba entera.
    select u.id as unidad_funcional_id, g.fecha::text as fecha, g.canal, g.resultado, g.autor_tipo,
           (select (d.retirada_at at time zone b.zona_horaria)::date::text from derivacion d join barrio b on b.barrio_id = d.barrio_id
             where d.id = g.derivacion_id and d.retirada_at is not null) as retirada_el
      from unidad_funcional u
      cross join lateral (
        select g.fecha, g.canal, g.resultado, g.autor_tipo, g.derivacion_id from gestion g
         where g.unidad_funcional_id = u.id
           and not exists (select 1 from gestion_anulacion a where a.gestion_id = g.id)
         order by g.registrado_at desc limit 1
      ) g
     where u.barrio_id = any(${sql.param(ids)}::uuid[])
  `);
  const ultimaDe = new Map(ultimas.map((g) => [g.unidad_funcional_id, g]));

  const { rows: intimadas } = await tx.execute<{ unidad_funcional_id: string }>(sql`
    select distinct g.unidad_funcional_id from gestion g
     where g.barrio_id = any(${sql.param(ids)}::uuid[])
       -- Solo lo que la administración marcó como intimación (legal-ph, E-a2): una carta documento
       -- «Enviada» o con «Dato equivocado» no es una intimación entregada.
       and g.resultado = 'intimacion_entregada'
       and not exists (select 1 from gestion_anulacion a where a.gestion_id = g.id)
  `);
  const conIntimacion = new Set(intimadas.map((r) => r.unidad_funcional_id));

  const promesas = await ultimasPromesas(tx, ids, new Map(barrios.map((b) => [b.id, b.hoy])));

  const filas: FilaMora[] = [];
  const barriosVista: BarrioDeMora[] = [];
  for (const b of barrios) {
    const propio = propios.get(b.id) ?? null;
    const { criterio, origen } = criterioEfectivo(criterioAdmin, propio && {
      meses: propio.meses,
      montoMinimo: propio.monto_minimo as Monto | null,
      pedirIntimacion: propio.pedir_intimacion,
    });
    barriosVista.push({
      id: b.id,
      nombre: b.nombre,
      hoy: b.hoy,
      criterio,
      origenCriterio: origen,
      estudios: estudios.get(b.id) ?? [],
      puedeDerivar: b.puede_derivar,
    });

    const deuda = await deudaALaFecha(tx, { barrioId: b.id, fecha: b.hoy });
    const candidatas = new Set([...deuda.keys(), ...derivaciones.filter((d) => unidadDe.get(d.unidad_funcional_id)?.barrio_id === b.id).map((d) => d.unidad_funcional_id)]);
    for (const unidadId of candidatas) {
      const u = unidadDe.get(unidadId);
      if (!u) continue;
      const d = deuda.get(unidadId);
      const r = d ? resumenVencido(d, b.hoy) : { meses: 0, capital: "0.00" as Monto, interes: "0.00" as Monto };
      const derivada = derivacionDe.get(unidadId);
      if (r.meses === 0 && !derivada) continue;
      const evaluacion = evaluarCriterio({ meses: r.meses, deuda: sumarMontos(r.capital, r.interes) }, criterio);
      const promesa = promesas.get(unidadId) ?? null;
      const ultima = ultimaDe.get(unidadId);
      filas.push({
        barrioId: b.id,
        barrio: b.nombre,
        unidadFuncionalId: unidadId,
        unidad: etiquetaUnidad(u.manzana, u.lote),
        titular: u.titular,
        meses: r.meses,
        capital: r.capital,
        interes: r.interes,
        situacion: situacionMora({ derivada: derivada !== undefined, promesa: promesa?.estado ?? null, criterio: evaluacion }),
        pasaLosMeses: evaluacion.porMeses,
        derivacion: derivada ? { id: derivada.id, estudioId: derivada.estudio_id, estudio: derivada.estudio, desde: derivada.desde } : null,
        ultimaGestion: ultima
          ? { fecha: ultima.fecha, canal: ultima.canal, resultado: ultima.resultado, autor: ultima.autor_tipo, retiradaEl: ultima.retirada_el }
          : null,
        promesa,
        conIntimacion: conIntimacion.has(unidadId),
      });
    }
  }
  // Más meses primero; a igual cantidad, más deuda.
  filas.sort(
    (a, b) =>
      b.meses - a.meses ||
      Number(aCentavos(sumarMontos(b.capital, b.interes)) - aCentavos(sumarMontos(a.capital, a.interes))) ||
      compararNatural(a.barrio, b.barrio) ||
      compararNatural(a.unidad, b.unidad),
  );
  // Las cifras de arriba las cuenta la pantalla sobre estas mismas filas (`contarVistas`): una sola regla.
  return { administracion, barrios: barriosVista, filas };
}

/**
 * La última promesa no anulada de cada unidad, con lo pagado para ella (`pagadoParaPromesa`: todo lo
 * imputado, a capital y a interés, de los pagos entre el alta y la fecha prometida). Es la cuenta de
 * Aclade (`promesas_de_pago`, 0014), con el pago y la imputación de este repo. El estado lo resuelve
 * `estadoPromesa` con el día de hoy del barrio.
 */
async function ultimasPromesas(tx: DbConIdentidad, barrioIds: readonly string[], hoyDe: ReadonlyMap<string, string>): Promise<Map<string, PromesaDeUnidad>> {
  const { rows } = await tx.execute<{ id: string; barrio_id: string; unidad_funcional_id: string; promesa_fecha: string; promesa_monto: string; pagado: string }>(sql`
    with p as (
      select distinct on (g.unidad_funcional_id) g.id, g.barrio_id, g.unidad_funcional_id, g.fecha, g.promesa_fecha, g.promesa_monto
        from gestion g
       where g.barrio_id = any(${sql.param([...barrioIds])}::uuid[]) and g.promesa_fecha is not null
         and not exists (select 1 from gestion_anulacion a where a.gestion_id = g.id)
       order by g.unidad_funcional_id, g.registrado_at desc
    )
    select p.id, p.barrio_id, p.unidad_funcional_id, p.promesa_fecha::text as promesa_fecha, p.promesa_monto::text as promesa_monto,
           ${pagadoParaPromesa("p.unidad_funcional_id", "p.fecha", "p.promesa_fecha")}::text as pagado
      from p
  `);
  return new Map(
    rows.map((r) => {
      const monto = r.promesa_monto as Monto;
      const pagado = r.pagado as Monto;
      const hoy = hoyDe.get(r.barrio_id) ?? r.promesa_fecha;
      return [r.unidad_funcional_id, { gestionId: r.id, fecha: r.promesa_fecha, monto, pagado, estado: estadoPromesa({ monto, pagado, fecha: r.promesa_fecha }, hoy) }];
    }),
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Derivar y retirar
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** La foto de la deuda de una unidad al derivar: mes por mes, tal como la dio `deudaALaFecha`. */
export type FotoDeDerivacion = {
  readonly fecha: string;
  /** Cada mes que debe algo; `vencido` si su vencimiento ya pasó el día de la foto. */
  readonly meses: readonly {
    readonly periodo: string;
    readonly vencimiento: string;
    readonly vencido: boolean;
    readonly capital: Monto;
    readonly interes: Monto;
  }[];
  /** Todo el capital pendiente, vencido o no (`DeudaDeUnidad.capital`). */
  readonly capital: Monto;
  /** Solo el de los meses vencidos. */
  readonly capitalVencido: Monto;
  readonly interes: Monto;
  readonly total: Monto;
};

/** Copia lo que dio `deudaALaFecha`, mes por mes; solo suma los meses vencidos para su subtotal. */
export function fotoDeLaDeuda(d: DeudaDeUnidad, fecha: string): FotoDeDerivacion {
  const meses = d.porMes.map((m) => ({
    periodo: m.periodo,
    vencimiento: m.vencimiento,
    vencido: m.vencimiento < fecha,
    capital: m.capital,
    interes: m.interes,
  }));
  const interes = sumarMontos(d.interesPendiente, d.interesNuevo);
  return {
    fecha,
    meses,
    capital: d.capital,
    capitalVencido: sumarMontos("0.00", ...meses.filter((m) => m.vencido).map((m) => m.capital)),
    interes,
    total: sumarMontos(d.capital, interes),
  };
}

export type ResultadoDerivacion = {
  readonly tandaId: string;
  readonly unidades: number;
  /** Para el aviso de «sale un correo por estudio» (los correos los manda E-b). */
  readonly porEstudio: readonly { readonly estudioId: string; readonly estudio: string; readonly unidades: number; readonly barrios: number }[];
};

/**
 * Deriva en lote, en la transacción de quien llama: cada unidad a su estudio (que tiene que trabajar en
 * su barrio: lo exige `app.derivacion_antes`), con la foto de su deuda a hoy. El renglón «Derivación»
 * de sus gestiones lo agrega la base. Si una sola falla, no se deriva ninguna.
 */
export async function derivar(tx: DbConIdentidad, parametros: Derivar): Promise<ResultadoDerivacion> {
  const q = derivarSchema.parse(parametros);
  return enBase(async () => {
    const tandaId = randomUUID();
    const porBarrio = new Map<string, (typeof q.unidades)[number][]>();
    for (const u of q.unidades) porBarrio.set(u.barrioId, [...(porBarrio.get(u.barrioId) ?? []), u]);

    const nombres = new Map<string, string>();
    const resumen = new Map<string, { unidades: number; barrios: Set<string> }>();
    for (const [barrioId, unidades] of porBarrio) {
      const { rows: hoyRows } = await tx.execute<{ hoy: string }>(sql`
        select (now() at time zone b.zona_horaria)::date::text as hoy from barrio b where b.barrio_id = ${barrioId}
      `);
      const hoy = hoyRows[0]?.hoy;
      if (!hoy) rechazar("referencia_inexistente", "El barrio no existe o no tenés acceso.", "Recargá la pantalla.");
      const deuda = await deudaALaFecha(tx, { barrioId, fecha: hoy });
      for (const u of unidades) {
        const d = deuda.get(u.unidadFuncionalId);
        if (!d || aCentavos(resumenVencido(d, hoy).capital) <= 0n) {
          rechazar("dato_invalido", "Alguna de las unidades no tiene deuda vencida.", "Recargá la lista y volvé a elegir.");
        }
        const { rows: est } = await tx.execute<{ nombre: string }>(sql`
          select ea.nombre from estudio_administracion ea join tenant_node n on n.parent_id = ea.administracion_id
           where ea.estudio_id = ${u.estudioId} and n.id = ${barrioId}
        `);
        if (!est[0]) rechazar("estudio_fuera_del_barrio", "Ese estudio no trabaja en el barrio de la unidad.", "Recargá la pantalla.");
        nombres.set(u.estudioId, est[0].nombre);
        const derivacionId = randomUUID();
        await tx.execute(sql`
          insert into derivacion (id, barrio_id, unidad_funcional_id, estudio_id, tanda_id, motivo, nota, derivada_por)
          values (${derivacionId}, ${barrioId}, ${u.unidadFuncionalId}, ${u.estudioId}, ${tandaId}, ${q.motivo}, ${q.nota}, app.current_user_id())
        `);
        await tx.execute(sql`
          insert into derivacion_foto (derivacion_id, barrio_id, foto)
          values (${derivacionId}, ${barrioId}, ${JSON.stringify(fotoDeLaDeuda(d, hoy))}::jsonb)
        `);
        // El renglón «Derivación» de las gestiones lo escribe la base (`app.derivacion_despues_insert`).
        const r = resumen.get(u.estudioId) ?? { unidades: 0, barrios: new Set<string>() };
        r.unidades++;
        r.barrios.add(barrioId);
        resumen.set(u.estudioId, r);
      }
    }
    return {
      tandaId,
      unidades: q.unidades.length,
      porEstudio: [...resumen].map(([estudioId, r]) => ({ estudioId, estudio: nombres.get(estudioId) ?? "", unidades: r.unidades, barrios: r.barrios.size })),
    };
  });
}

/** Retira una unidad del estudio: la derivación queda en la historia con su motivo, quién y cuándo. */
export async function retirar(tx: DbConIdentidad, parametros: Retirar): Promise<void> {
  const q = retirarSchema.parse(parametros);
  await enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      -- Quién y cuándo los fija \`app.derivacion_antes\`.
      update derivacion set retiro_motivo = ${q.motivo}, retiro_nota = ${q.nota}
       where id = ${q.derivacionId} and retirada_at is null
       returning id
    `);
    if (!rows[0]) {
      rechazar("derivacion_ya_retirada", "Esa derivación ya se retiró o no tenés acceso.", "Recargá la pantalla.");
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Estudios jurídicos (configuración general)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type EstudioDeLaAdministracion = {
  readonly id: string;
  readonly nombre: string;
  readonly cuit: string;
  readonly correoAvisos: string;
  readonly telefonoBoleta: string | null;
  readonly preferenciaAviso: PreferenciaAviso;
  readonly activo: boolean;
  readonly barrios: readonly { readonly id: string; readonly nombre: string; readonly porDefecto: boolean }[];
  /** Derivaciones vigentes en los barrios de esta administración. */
  readonly derivadas: number;
};

export type ConfiguracionDeEstudios = {
  readonly administracion: { readonly id: string; readonly nombre: string };
  /** Si quien mira puede agregar, editar y dar de baja (la RLS lo vuelve a decidir al escribir). */
  readonly puedeEditar: boolean;
  readonly estudios: readonly EstudioDeLaAdministracion[];
  readonly criterio: CriterioMora & { readonly leyendaBoleta: string; readonly cargado: boolean };
};

export async function estudiosDeLaAdministracion(
  tx: DbConIdentidad,
  parametros: { readonly administracionId: string },
): Promise<ConfiguracionDeEstudios | null> {
  const administracionId = idSchema.parse(parametros.administracionId);
  const { rows: admin } = await tx.execute<{ nombre: string; puede: boolean }>(sql`
    select a.nombre, ${administracionId}::uuid in (select app.administraciones_administradas()) as puede
      from tenant_node a where a.id = ${administracionId} and a.tipo = 'administrador' and a.deleted_at is null
  `);
  if (!admin[0]) return null;
  const { rows } = await tx.execute<{
    id: string;
    nombre: string;
    cuit: string;
    correo_avisos: string;
    telefono_boleta: string | null;
    preferencia_aviso: PreferenciaAviso;
    activo: boolean;
    barrios: { id: string; nombre: string; porDefecto: boolean }[] | null;
    derivadas: number;
  }>(sql`
    select e.id, ea.nombre, e.cuit, ea.correo_avisos, ea.telefono_boleta, ea.preferencia_aviso, ea.activo,
           (select json_agg(json_build_object('id', n.id, 'nombre', n.nombre, 'porDefecto', eb.por_defecto) order by eb.por_defecto desc, n.nombre)
              from estudio_barrio eb join tenant_node n on n.id = eb.barrio_id
             where eb.estudio_id = e.id and n.parent_id = ea.administracion_id) as barrios,
           (select count(*)::int from derivacion d join tenant_node n on n.id = d.barrio_id
             where d.estudio_id = e.id and n.parent_id = ea.administracion_id and d.retirada_at is null) as derivadas
      from estudio_administracion ea join estudio_juridico e on e.id = ea.estudio_id
     where ea.administracion_id = ${administracionId}
     order by ea.activo desc, ea.nombre
  `);
  const criterio = await criterioDeAdministracion(tx, administracionId);
  return {
    administracion: { id: administracionId, nombre: admin[0].nombre },
    puedeEditar: admin[0].puede,
    estudios: rows.map((r) => ({
      id: r.id,
      nombre: r.nombre,
      cuit: formatearCuit(r.cuit),
      correoAvisos: r.correo_avisos,
      telefonoBoleta: r.telefono_boleta,
      preferenciaAviso: r.preferencia_aviso,
      activo: r.activo,
      barrios: r.barrios ?? [],
      derivadas: r.derivadas,
    })),
    criterio: criterio
      ? { ...criterio, cargado: true }
      : { ...CRITERIO_POR_DEFECTO, leyendaBoleta: LEYENDA_BASE, cargado: false },
  };
}

/**
 * Busca un estudio que ya usa el sistema, por correo o CUIT **exacto** (`app.buscar_estudio_exacto`):
 * solo el id y el nombre. `vinculado` dice si ya trabaja con esta administración (un vínculo dado de
 * baja no cuenta: se vuelve a vincular con `vincularEstudio`, que lo reactiva).
 */
export async function buscarEstudio(
  tx: DbConIdentidad,
  parametros: { readonly administracionId: string; readonly dato: string },
): Promise<{ readonly id: string; readonly nombre: string; readonly vinculado: boolean } | null> {
  const administracionId = idSchema.parse(parametros.administracionId);
  const { dato } = buscarEstudioSchema.parse({ dato: parametros.dato });
  const { rows } = await tx.execute<{ id: string; nombre: string }>(sql`select id, nombre from app.buscar_estudio_exacto(${dato})`);
  const f = rows[0];
  if (!f || rows.length > 1) return null;
  const { rows: v } = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from estudio_administracion
     where estudio_id = ${f.id} and administracion_id = ${administracionId} and activo
  `);
  return { id: f.id, nombre: f.nombre, vinculado: (v[0]?.n ?? 0) > 0 };
}

/** Da de alta un estudio nuevo y lo vincula con la administración, en la misma transacción. */
export async function agregarEstudio(tx: DbConIdentidad, parametros: AgregarEstudio): Promise<{ readonly estudioId: string }> {
  const q = agregarEstudioSchema.parse(parametros);
  return enBase(async () => {
    const estudioId = randomUUID();
    // Sin `returning`: la fila recién creada todavía no tiene vínculo y la RLS no la deja ver.
    await tx.execute(sql`
      insert into estudio_juridico (id, nombre, cuit, creado_por) values (${estudioId}, ${q.nombre}, ${q.cuit}, app.current_user_id())
    `);
    await insertarVinculo(tx, { ...q, estudioId });
    return { estudioId };
  });
}

/** Vincula con la administración un estudio que ya usa el sistema con otra. */
export async function vincularEstudio(tx: DbConIdentidad, parametros: VincularEstudio): Promise<void> {
  const q = vincularEstudioSchema.parse(parametros);
  await enBase(async () => {
    const { rows } = await tx.execute<{ activo: boolean }>(sql`
      select activo from estudio_administracion where estudio_id = ${q.estudioId} and administracion_id = ${q.administracionId}
    `);
    if (rows[0]) {
      // Un vínculo dado de baja se reactiva con los datos nuevos.
      await tx.execute(sql`
        update estudio_administracion set activo = true, nombre = ${q.nombre}, correo_avisos = ${q.correoAvisos},
               telefono_boleta = ${q.telefonoBoleta}, preferencia_aviso = ${q.preferenciaAviso}
         where estudio_id = ${q.estudioId} and administracion_id = ${q.administracionId}
      `);
      return;
    }
    await insertarVinculo(tx, q);
  });
}

async function insertarVinculo(
  tx: DbConIdentidad,
  q: {
    administracionId: string;
    estudioId: string;
    nombre: string;
    correoAvisos: string;
    telefonoBoleta: string | null;
    preferenciaAviso: PreferenciaAviso;
  },
): Promise<void> {
  const { rows } = await tx.execute<{ estudio_id: string }>(sql`
    insert into estudio_administracion (estudio_id, administracion_id, nombre, correo_avisos, telefono_boleta, preferencia_aviso, vinculado_por)
    values (${q.estudioId}, ${q.administracionId}, ${q.nombre}, ${q.correoAvisos}, ${q.telefonoBoleta}, ${q.preferenciaAviso}, app.current_user_id())
    returning estudio_id
  `);
  if (!rows[0]) rechazar("sin_permiso", "No podés agregar estudios en esta administración.", "Pedíselo a quien la administra.");
}

/**
 * Edita lo que esta administración guarda del estudio: el nombre con el que lo ve y los datos del
 * vínculo. La cuenta del estudio (su nombre de alta, su CUIT) no la edita ninguna administración.
 */
export async function editarVinculo(tx: DbConIdentidad, parametros: EditarVinculo): Promise<void> {
  const q = editarVinculoSchema.parse(parametros);
  await enBase(async () => {
    const { rows } = await tx.execute<{ estudio_id: string }>(sql`
      update estudio_administracion set nombre = ${q.nombre}, correo_avisos = ${q.correoAvisos}, telefono_boleta = ${q.telefonoBoleta},
             preferencia_aviso = ${q.preferenciaAviso}
       where estudio_id = ${q.estudioId} and administracion_id = ${q.administracionId}
       returning estudio_id
    `);
    if (!rows[0]) rechazar("sin_permiso", "No podés editar ese estudio.", "Recargá la pantalla.");
  });
}

/** Baja del vínculo: la base la frena si el estudio tiene derivaciones vigentes en esta administración. */
export async function bajaEstudio(tx: DbConIdentidad, parametros: BajaEstudio): Promise<void> {
  const q = bajaEstudioSchema.parse(parametros);
  await enBase(async () => {
    const { rows } = await tx.execute<{ estudio_id: string }>(sql`
      update estudio_administracion set activo = false
       where estudio_id = ${q.estudioId} and administracion_id = ${q.administracionId} and activo
       returning estudio_id
    `);
    if (!rows[0]) rechazar("sin_permiso", "No podés dar de baja ese estudio.", "Recargá la pantalla.");
  });
}

export async function guardarCriterioAdministracion(tx: DbConIdentidad, parametros: CriterioAdministracion): Promise<void> {
  const q = criterioAdministracionSchema.parse(parametros);
  await enBase(async () => {
    const { rows } = await tx.execute<{ administracion_id: string }>(sql`
      insert into mora_criterio_administracion (administracion_id, meses, monto_minimo, pedir_intimacion, leyenda_boleta, cargado_por)
      values (${q.administracionId}, ${q.meses}, ${q.montoMinimo}::numeric, ${q.pedirIntimacion}, ${q.leyendaBoleta}, app.current_user_id())
      on conflict (administracion_id) do update set meses = excluded.meses, monto_minimo = excluded.monto_minimo,
        pedir_intimacion = excluded.pedir_intimacion, leyenda_boleta = excluded.leyenda_boleta
      returning administracion_id
    `);
    if (!rows[0]) rechazar("sin_permiso", "No podés cambiar el criterio de esta administración.", "Pedíselo a quien la administra.");
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Mora y estudios del barrio (configuración del barrio)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type MoraDelBarrio = {
  readonly barrio: { readonly id: string; readonly nombre: string; readonly figuraJuridica: string };
  readonly administracion: { readonly id: string; readonly nombre: string };
  readonly puedeEditar: boolean;
  readonly criterioAdministracion: CriterioMora;
  /** `null` = usa el de la administración. */
  readonly criterioPropio: { readonly meses: number; readonly montoMinimo: Monto } | null;
  readonly pactoEjecutividad: PactoEjecutividad;
  readonly leyendaAdministracion: string;
  /** `null` = usa el texto base de la administración. */
  readonly leyendaPropia: string | null;
  /** Los estudios activos de la administración, con si trabajan acá y cuántas derivadas tienen acá. */
  readonly estudios: readonly {
    readonly id: string;
    readonly nombre: string;
    readonly enElBarrio: boolean;
    readonly porDefecto: boolean;
    readonly derivadas: number;
  }[];
};

export async function moraDelBarrio(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<MoraDelBarrio | null> {
  const barrioId = idSchema.parse(parametros.barrioId);
  const { rows } = await tx.execute<{
    nombre: string;
    figura: string;
    pacto: boolean | null;
    administracion_id: string;
    administracion: string | null;
    puede: boolean;
  }>(sql`
    select n.nombre, b.figura_juridica::text as figura, b.pacto_ejecutividad as pacto, n.parent_id as administracion_id,
           (select a.nombre from tenant_node a where a.id = n.parent_id) as administracion,
           app.has_role_on(b.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) as puede
      from barrio b join tenant_node n on n.id = b.barrio_id where b.barrio_id = ${barrioId} and n.deleted_at is null
  `);
  const b = rows[0];
  if (!b) return null;
  // En serie: las dos van por la misma `tx` (regla 16).
  const admin = await criterioDeAdministracion(tx, b.administracion_id);
  const propios = await moraDeBarrios(tx, [barrioId]);
  const propio = propios.get(barrioId);
  const { rows: estudios } = await tx.execute<{ id: string; nombre: string; en_el_barrio: boolean; por_defecto: boolean; derivadas: number }>(sql`
    select e.id, ea.nombre, eb.estudio_id is not null as en_el_barrio, coalesce(eb.por_defecto, false) as por_defecto,
           (select count(*)::int from derivacion d where d.estudio_id = e.id and d.barrio_id = ${barrioId} and d.retirada_at is null) as derivadas
      from estudio_administracion ea
      join estudio_juridico e on e.id = ea.estudio_id
      left join estudio_barrio eb on eb.estudio_id = e.id and eb.barrio_id = ${barrioId}
     where ea.administracion_id = ${b.administracion_id} and ea.activo
     order by coalesce(eb.por_defecto, false) desc, (eb.estudio_id is not null) desc, ea.nombre
  `);
  return {
    barrio: { id: barrioId, nombre: b.nombre, figuraJuridica: b.figura },
    administracion: { id: b.administracion_id, nombre: b.administracion ?? "La administración" },
    puedeEditar: b.puede,
    criterioAdministracion: admin ?? CRITERIO_POR_DEFECTO,
    criterioPropio:
      propio && propio.meses !== null && propio.monto_minimo !== null ? { meses: propio.meses, montoMinimo: propio.monto_minimo as Monto } : null,
    pactoEjecutividad: b.pacto === null ? "a_confirmar" : b.pacto ? "si" : "no",
    leyendaAdministracion: admin?.leyendaBoleta ?? LEYENDA_BASE,
    leyendaPropia: propio?.leyenda_boleta ?? null,
    estudios: estudios.map((e) => ({ id: e.id, nombre: e.nombre, enElBarrio: e.en_el_barrio, porDefecto: e.por_defecto, derivadas: e.derivadas })),
  };
}

export async function guardarMoraBarrio(tx: DbConIdentidad, parametros: MoraBarrio): Promise<void> {
  const q = moraBarrioSchema.parse(parametros);
  await enBase(async () => {
    const propio = q.criterio === "propio";
    const { rows } = await tx.execute<{ barrio_id: string }>(sql`
      insert into mora_barrio (barrio_id, meses, monto_minimo, leyenda_boleta, cargado_por)
      values (${q.barrioId}, ${propio ? q.meses : null}, ${propio ? q.montoMinimo : null}::numeric,
              ${q.aviso === "propio" ? q.leyendaBoleta : null}, app.current_user_id())
      on conflict (barrio_id) do update set meses = excluded.meses, monto_minimo = excluded.monto_minimo, leyenda_boleta = excluded.leyenda_boleta
      returning barrio_id
    `);
    if (!rows[0]) rechazar("sin_permiso", "No podés cambiar la mora de este barrio.", "Pedíselo a quien lo administra.");
    // El pacto es del barrio (`barrio.pacto_ejecutividad`, null = a confirmar), la columna de siempre.
    const pacto = q.pactoEjecutividad === "a_confirmar" ? null : q.pactoEjecutividad === "si";
    await tx.execute(sql`
      update barrio set pacto_ejecutividad = ${pacto}, updated_at = now()
       where barrio_id = ${q.barrioId} and pacto_ejecutividad is distinct from ${pacto}::boolean
    `);
  });
}

/** Sumar o sacar un estudio del barrio, o hacerlo el de por defecto (de a uno: el índice parcial lo exige). */
export async function cambiarEstudioDelBarrio(tx: DbConIdentidad, parametros: EstudioDelBarrio): Promise<void> {
  const q = estudioDelBarrioSchema.parse(parametros);
  await enBase(async () => {
    if (q.accion === "sumar") {
      // Entra sin ser el de por defecto: eso se elige aparte. Sin ninguno por defecto, el diálogo de
      // derivar preselecciona el estudio si es el único del barrio.
      await tx.execute(sql`
        insert into estudio_barrio (estudio_id, barrio_id, por_defecto) values (${q.estudioId}, ${q.barrioId}, false)
        on conflict do nothing
      `);
      return;
    }
    if (q.accion === "sacar") {
      const { rows } = await tx.execute<{ por_defecto: boolean }>(sql`
        delete from estudio_barrio where estudio_id = ${q.estudioId} and barrio_id = ${q.barrioId} returning por_defecto
      `);
      if (!rows[0]) rechazar("sin_permiso", "No podés sacar ese estudio del barrio.", "Recargá la pantalla.");
      return;
    }
    await tx.execute(sql`update estudio_barrio set por_defecto = false where barrio_id = ${q.barrioId} and por_defecto and estudio_id <> ${q.estudioId}`);
    const { rows } = await tx.execute<{ estudio_id: string }>(sql`
      update estudio_barrio set por_defecto = true where barrio_id = ${q.barrioId} and estudio_id = ${q.estudioId} returning estudio_id
    `);
    if (!rows[0]) rechazar("estudio_fuera_del_barrio", "Ese estudio no trabaja en este barrio.", "Sumalo primero al barrio.");
  });
}
