/**
 * Armar un plan de pagos (encargo P2a-2; maqueta de planes, pantallas 2 y 3): todo lo que la pantalla
 * necesita leer para armarlo, en una lectura bajo RLS.
 *
 * Solo lee. Las cuentas en vivo de la pantalla (el cronograma del catálogo, el cuadre a medida) las hace
 * `@admin-barrios/shared/planes` con estos mismos datos, y al registrar el servidor las vuelve a hacer
 * con la deuda de ese momento (`crearPlanDeCatalogo`, `proponerPlanAMedida`): lo de la pantalla es una
 * vista previa, nunca la cifra que se guarda.
 */
import { sql } from "drizzle-orm";
import { idSchema } from "@admin-barrios/shared/consultas";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { porcentajeDeTasa } from "@admin-barrios/shared/activacion";
import type { Monto } from "@admin-barrios/shared/dinero";
import type { AnticipoDeCatalogo, ModoDeCobro, ParametrosDelCatalogo, SistemaDeCatalogo } from "@admin-barrios/shared/planes";
import type { DbConIdentidad } from "../client.ts";
import { deudaALaFecha } from "./deuda.ts";

/** Un mes que puede entrar al plan: vencido, con su capital y su mora a hoy. */
export type MesParaElPlan = {
  readonly liquidacionId: string;
  /** `YYYY-MM`. */
  readonly periodo: string;
  readonly vencimiento: string;
  readonly capital: Monto;
  readonly interes: Monto;
};

export type PlanDelCatalogoParaArmar = ParametrosDelCatalogo & {
  readonly id: string;
  readonly nombre: string;
  readonly sistema: SistemaDeCatalogo;
  /** Fracción, como la usa el motor: `"0.020000"`. */
  readonly tasaMensual: string;
  /** Como se escribe: `2`, `2,5`. Solo francés. */
  readonly tasaPorcentaje: string | null;
  readonly estudio: { readonly id: string; readonly nombre: string } | null;
  readonly modoCobro: ModoDeCobro;
};

export type DatosParaArmarPlan = {
  readonly unidad: { readonly id: string; readonly etiqueta: string };
  readonly titular: string | null;
  readonly barrio: { readonly id: string; readonly nombre: string };
  readonly hoy: string;
  /** Los meses vencidos que se pueden incluir, del más viejo al más nuevo. */
  readonly meses: readonly MesParaElPlan[];
  /** Los meses que deben algo pero todavía no vencieron: siguen en la boleta. */
  readonly sinVencer: readonly string[];
  /** El estudio al que está derivada hoy, si está derivada. */
  readonly derivadaA: string | null;
  readonly catalogo: readonly PlanDelCatalogoParaArmar[];
  /** Los estudios que trabajan en el barrio (pueden cobrar un plan a medida). */
  readonly estudios: readonly { readonly id: string; readonly nombre: string }[];
  readonly reglas: { readonly financiaMora: boolean; readonly quitaRequiereActa: boolean };
  /** La primera cuota que se propone: el mes que viene, el día de vencimiento de la boleta del barrio. */
  readonly primerVencimiento: string;
  /** El vencimiento que se propone para el anticipo: en cinco días. */
  readonly vencimientoAnticipo: string;
  /** El primer día en que puede vencer una cuota: mañana (la firma exige que venzan después de hoy). */
  readonly manana: string;
  /** Un plan vigente o pendiente: mientras exista, no se arma otro. */
  readonly planAbierto: { readonly id: string; readonly estado: "vigente" | "pendiente" } | null;
  /** Si quien mira administra el barrio (la base lo vuelve a decidir al registrar). */
  readonly puedeArmar: boolean;
};

export async function datosParaArmarPlan(
  tx: DbConIdentidad,
  parametros: { readonly unidadFuncionalId: string },
): Promise<DatosParaArmarPlan | null> {
  const id = idSchema.safeParse(parametros.unidadFuncionalId);
  if (!id.success) return null;
  const unidadId = id.data;
  const { rows } = await tx.execute<{
    barrio_id: string;
    barrio: string;
    manzana: string;
    lote: string;
    hoy: string;
    primer_vencimiento: string;
    vencimiento_anticipo: string;
    manana: string;
    financia_mora: boolean;
    quita_requiere_acta: boolean;
    puede: boolean;
  }>(sql`
    with h as (select (now() at time zone b.zona_horaria)::date as hoy, b.barrio_id, coalesce(b.dia_vencimiento, 10) as dia
                 from unidad_funcional u join barrio b on b.barrio_id = u.barrio_id where u.id = ${unidadId})
    select u.barrio_id, n.nombre as barrio, u.manzana, u.lote, h.hoy::text as hoy,
           (date_trunc('month', h.hoy) + interval '1 month'
             + (least(h.dia, extract(day from date_trunc('month', h.hoy) + interval '2 month' - interval '1 day')::int) - 1) * interval '1 day')::date::text
             as primer_vencimiento,
           (h.hoy + 5)::text as vencimiento_anticipo, (h.hoy + 1)::text as manana,
           coalesce(pr.financia_mora, false) as financia_mora, coalesce(pr.quita_requiere_acta, false) as quita_requiere_acta,
           app.has_role_on(u.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) as puede
      from unidad_funcional u join h on h.barrio_id = u.barrio_id join tenant_node n on n.id = u.barrio_id
      left join plan_parametro_barrio pr on pr.barrio_id = u.barrio_id
     where u.id = ${unidadId}
  `);
  const f = rows[0];
  if (!f) return null;

  const deuda = (await deudaALaFecha(tx, { barrioId: f.barrio_id, fecha: f.hoy, unidadFuncionalId: unidadId })).get(unidadId);
  // Lo que puede entrar: lo vencido que no es cuota de otro plan (la misma regla que `deudaQueEntra`).
  const porMes = (deuda?.porMes ?? []).filter((m) => m.origen !== "plan");
  const meses = porMes
    .filter((m) => m.vencimiento < f.hoy)
    .map((m) => ({ liquidacionId: m.liquidacionId, periodo: m.periodo, vencimiento: m.vencimiento, capital: m.capital, interes: m.interes }));
  const sinVencer = porMes.filter((m) => m.vencimiento >= f.hoy).map((m) => m.periodo);

  const { rows: titular } = await tx.execute<{ nombre: string }>(sql`
    select o.nombre from unidad_obligado uo join obligado o on o.id = uo.obligado_id
     where uo.unidad_funcional_id = ${unidadId} and uo.hasta is null
     order by uo.es_notificado desc, o.nombre limit 1
  `);
  const { rows: derivacion } = await tx.execute<{ estudio: string }>(sql`
    select coalesce(ea.nombre, e.nombre) as estudio
      from derivacion d join estudio_juridico e on e.id = d.estudio_id
      join tenant_node n on n.id = d.barrio_id
      left join estudio_administracion ea on ea.estudio_id = d.estudio_id and ea.administracion_id = n.parent_id
     where d.unidad_funcional_id = ${unidadId} and d.retirada_at is null
     limit 1
  `);
  const { rows: catalogo } = await tx.execute<{
    id: string;
    nombre: string;
    sistema: SistemaDeCatalogo;
    tasa: string;
    cuotas_min: number;
    cuotas_max: number;
    anticipo: AnticipoDeCatalogo;
    anticipo_max_pct: string | null;
    deuda_maxima: string | null;
    estudio_id: string | null;
    estudio: string | null;
    modo_cobro: ModoDeCobro;
  }>(sql`
    select c.id, c.nombre, c.sistema, c.tasa_mensual::text as tasa, c.cuotas_min, c.cuotas_max, c.anticipo,
           c.anticipo_max_pct::text as anticipo_max_pct, c.deuda_maxima::text as deuda_maxima, c.estudio_id,
           ea.nombre as estudio, c.modo_cobro
      from plan_catalogo c join plan_catalogo_barrio cb on cb.catalogo_id = c.id
      left join estudio_administracion ea on ea.estudio_id = c.estudio_id and ea.administracion_id = c.administracion_id
     where cb.barrio_id = ${f.barrio_id} and c.activo
     order by c.nombre, c.id
  `);
  const { rows: estudios } = await tx.execute<{ id: string; nombre: string }>(sql`
    select eb.estudio_id as id, ea.nombre
      from estudio_barrio eb join tenant_node n on n.id = eb.barrio_id
      join estudio_administracion ea on ea.estudio_id = eb.estudio_id and ea.administracion_id = n.parent_id and ea.activo
     where eb.barrio_id = ${f.barrio_id}
     order by eb.por_defecto desc, ea.nombre
  `);
  const { rows: abierto } = await tx.execute<{ id: string; estado: "vigente" | "pendiente" }>(sql`
    select id, estado from plan_pago where unidad_funcional_id = ${unidadId} and estado in ('vigente', 'pendiente')
     order by created_at desc limit 1
  `);

  return {
    unidad: { id: unidadId, etiqueta: etiquetaUnidad(f.manzana, f.lote) },
    titular: titular[0]?.nombre ?? null,
    barrio: { id: f.barrio_id, nombre: f.barrio },
    hoy: f.hoy,
    meses,
    sinVencer,
    derivadaA: derivacion[0]?.estudio ?? null,
    catalogo: catalogo.map((c) => ({
      id: c.id,
      nombre: c.nombre,
      sistema: c.sistema,
      tasaMensual: c.tasa,
      tasaPorcentaje: c.sistema === "frances" ? porcentajeDeTasa(c.tasa) : null,
      cuotasMin: c.cuotas_min,
      cuotasMax: c.cuotas_max,
      anticipo: c.anticipo,
      anticipoMaxPorcentaje: c.anticipo_max_pct,
      deudaMaxima: c.deuda_maxima as Monto | null,
      estudio: c.estudio_id && c.estudio ? { id: c.estudio_id, nombre: c.estudio } : null,
      modoCobro: c.modo_cobro,
    })),
    estudios,
    reglas: { financiaMora: f.financia_mora, quitaRequiereActa: f.quita_requiere_acta },
    primerVencimiento: f.primer_vencimiento,
    vencimientoAnticipo: f.vencimiento_anticipo,
    manana: f.manana,
    planAbierto: abierto[0] ?? null,
    puedeArmar: f.puede,
  };
}
