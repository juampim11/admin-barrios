/**
 * La rendición manual del estudio (encargo P2b, pantalla 5 de la maqueta de planes de pago).
 *
 * Por barrio. En la v1 la carga la administración (`admin_plataforma`, `admin_barrio`): el estudio
 * todavía no entra al sistema. Las reglas las hace cumplir la base (`0097`): que la cuota sea de un plan
 * vigente que cobra ese estudio, que el ingreso entre a la cuenta del barrio, que lo confirmado no
 * cambie y que la confirmación cuadre. Acá se arma lo que ve la pantalla y se traducen los errores.
 *
 * Los archivos (el PDF firmado y el comprobante de cada ingreso) los sube el navegador a una clave que
 * da el servidor; el SHA-256 y los bytes los calcula la acción **leyendo el objeto**, nunca el navegador
 * (como los documentos del plan, P2a-3).
 */
import { sql } from "drizzle-orm";
import { idSchema } from "@admin-barrios/shared/consultas";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { aCentavos, formatearMonto, restarMontos, sumarMontos } from "@admin-barrios/shared/dinero";
import { formatearFecha, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import {
  adjuntarPdfDeRendicionSchema,
  agregarCuotaARendicionSchema,
  agregarIngresoARendicionSchema,
  anularRendicionSchema,
  crearRendicionSchema,
  NOMBRE_MEDIO_DEL_INGRESO,
  NOMBRE_MEDIO_DEL_VECINO,
  prepararSubidaDeRendicionSchema,
  type AdjuntarPdfDeRendicion,
  type AgregarCuotaARendicion,
  type AgregarIngresoARendicion,
  type AnularRendicion,
  type CrearRendicion,
  type EstadoRendicion,
  type MedioDelIngreso,
  type MedioDelVecino,
  type PrepararSubidaDeRendicion,
} from "@admin-barrios/shared/planes-rendicion";
import { claveDeArchivoDeRendicion, nuevoToken, type ContentTypeDeComprobante } from "@admin-barrios/almacenamiento";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";

const ROLES_ADMIN = sql`array['admin_plataforma', 'admin_barrio']::app.rol_membership[]`;

const etiquetaCuota = (numero: number, cuotas: number) => (numero === 0 ? "Anticipo" : `Cuota ${numero} de ${cuotas}`);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La lista
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type RendicionEnLista = {
  readonly id: string;
  readonly estudio: string;
  readonly periodo: string;
  readonly estado: EstadoRendicion;
  readonly cuotas: number;
  readonly importe: string;
  readonly confirmada: string | null;
  /** F4 tramo 3 (`0100`): «Anulada el {fecha} por {persona}: {motivo}». `null` si no se anuló. */
  readonly anulada: string | null;
};

export type RendicionesDelBarrio = {
  readonly barrio: { readonly id: string; readonly nombre: string };
  readonly puedeCargar: boolean;
  /** `YYYY-MM`, en la zona del barrio: el mes que se sugiere al abrir una rendición. */
  readonly mesActual: string;
  /** Los estudios con los que se puede abrir una rendición: los de la administración del barrio. */
  readonly estudios: readonly { readonly id: string; readonly nombre: string }[];
  readonly rendiciones: readonly RendicionEnLista[];
};

export async function rendicionesDelBarrio(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<RendicionesDelBarrio> {
  const barrioId = idSchema.parse(parametros.barrioId);
  return enBase(async () => {
    const { rows: p } = await tx.execute<{ puede: boolean; nombre: string; mes: string }>(sql`
      select app.has_role_on(tb.id, ${ROLES_ADMIN}) as puede, tb.nombre, to_char(now() at time zone b.zona_horaria, 'YYYY-MM') as mes
        from tenant_node tb join barrio b on b.barrio_id = tb.id where tb.id = ${barrioId}
    `);
    if (!p[0]) rechazar("referencia_inexistente", "Ese barrio no existe o no tenés acceso.", "Volvé al inicio.");
    const { rows: estudios } = await tx.execute<{ id: string; nombre: string }>(sql`
      select ea.estudio_id as id, ea.nombre from estudio_administracion ea
       where ea.administracion_id = (select tb.parent_id from tenant_node tb where tb.id = ${barrioId}) and ea.activo
       order by ea.nombre
    `);
    const { rows } = await tx.execute<{
      id: string;
      estudio: string | null;
      periodo: string;
      estado: EstadoRendicion;
      cuotas: number;
      importe: string;
      confirmada_at: string | null;
      anulada_at: string | null;
      anulada_por: string | null;
      motivo_anulacion: string | null;
    }>(sql`
      select r.id, ea.nombre as estudio, r.periodo, r.estado,
             (r.anulada_at at time zone b.zona_horaria)::date::text as anulada_at, r.motivo_anulacion,
             (select ud.nombre from usuario_demo ud where ud.user_id = r.anulada_por) as anulada_por,
             (select count(*) from plan_rendicion_cuota rc where rc.rendicion_id = r.id)::int as cuotas,
             (select coalesce(sum(rc.importe), 0) from plan_rendicion_cuota rc where rc.rendicion_id = r.id)::numeric(14,2)::text as importe,
             (r.confirmada_at at time zone b.zona_horaria)::date::text as confirmada_at
        from plan_rendicion r
        join barrio b on b.barrio_id = r.barrio_id
        left join estudio_administracion ea
          on ea.estudio_id = r.estudio_id and ea.administracion_id = (select tb.parent_id from tenant_node tb where tb.id = r.barrio_id)
       where r.barrio_id = ${barrioId}
       order by r.periodo desc, r.created_at desc
    `);
    return {
      barrio: { id: barrioId, nombre: p[0].nombre },
      mesActual: p[0].mes,
      puedeCargar: p[0].puede === true,
      estudios,
      rendiciones: rows.map((r) => ({
        id: r.id,
        estudio: r.estudio ?? "Estudio",
        periodo: nombreDelPeriodo(r.periodo),
        estado: r.estado,
        cuotas: r.cuotas,
        importe: formatearMonto(r.importe),
        confirmada: r.confirmada_at ? formatearFecha(r.confirmada_at) : null,
        anulada: textoDeAnulacion(r.anulada_at, r.anulada_por, r.motivo_anulacion),
      })),
    };
  });
}

/** «Anulada el 19/11/2026 por Ana Pérez: el estudio rindió mal el mes.» (sin nombre conocido: «por la administración»). */
function textoDeAnulacion(el: string | null, por: string | null, motivo: string | null): string | null {
  if (!el) return null;
  return `Anulada el ${formatearFecha(el)} por ${por ?? "la administración"}: ${motivo ?? ""}`;
}

export async function crearRendicion(tx: DbConIdentidad, parametros: CrearRendicion): Promise<{ readonly rendicionId: string }> {
  const p = crearRendicionSchema.parse(parametros);
  return enBase(async () => {
    // [F4 tramo 2, BL-055 d] Puede haber varias por estudio y mes (un estudio que rinde en dos tandas),
    // pero una segunda suele ser un error de carga: se confirma.
    if (!p.confirmarOtraRendicion) {
      const { rows: otra } = await tx.execute<{ estudio: string }>(sql`
        select coalesce(ea.nombre, 'el estudio') as estudio
          from plan_rendicion r
          join tenant_node n on n.id = r.barrio_id
          left join estudio_administracion ea on ea.estudio_id = r.estudio_id and ea.administracion_id = n.parent_id
         where r.barrio_id = ${p.barrioId} and r.estudio_id = ${p.estudioId} and r.periodo = ${p.periodo}
         limit 1
      `);
      if (otra[0]) {
        const mes = nombreDelPeriodo(p.periodo).toLowerCase();
        rechazar(
          "rendicion_repetida_requiere_confirmacion",
          `Ya hay una rendición de ${otra[0].estudio} para ${mes}: ¿es otra?`,
          "Si es la misma, volvé y seguí cargando la que ya está. Una cuota no se puede rendir dos veces.",
          { estudio: otra[0].estudio, periodo: p.periodo },
        );
      }
    }
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into plan_rendicion (barrio_id, estudio_id, periodo, creado_por)
      values (${p.barrioId}, ${p.estudioId}, ${p.periodo}, app.current_user_id())
      returning id
    `);
    return { rendicionId: rows[0]!.id };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Una rendición
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type CuotaDeLaRendicion = {
  readonly id: string;
  readonly unidad: string;
  readonly unidadId: string;
  readonly plan: string;
  readonly cuota: string;
  readonly parcial: boolean;
  readonly cobro: string;
  readonly importe: string;
};

export type IngresoDeLaRendicion = {
  readonly id: string;
  readonly fecha: string;
  readonly medio: string;
  readonly cuenta: string;
  readonly comprobante: string;
  readonly codigoDeControl: string;
  readonly importe: string;
};

export type CuotaParaRendir = {
  readonly planCuotaId: string;
  readonly etiqueta: string;
  /** Lo que le falta pagar (canónico, para precargar el importe). */
  readonly saldo: string;
};

export type Rendicion = {
  readonly id: string;
  readonly barrioId: string;
  readonly barrioNombre: string;
  readonly estudio: string;
  readonly periodo: string;
  readonly periodoCodigo: string;
  readonly estado: EstadoRendicion;
  readonly puedeEditar: boolean;
  readonly documento: { readonly nombre: string; readonly codigoDeControl: string } | null;
  readonly cuotas: readonly CuotaDeLaRendicion[];
  readonly ingresos: readonly IngresoDeLaRendicion[];
  readonly totalCuotas: string;
  readonly totalIngresos: string;
  readonly diferencia: string;
  readonly cuadra: boolean;
  /** Las cuotas que el estudio puede rendir todavía (planes vigentes que cobra, ya emitidas, con saldo). */
  readonly paraRendir: readonly CuotaParaRendir[];
  /** El CBU de la cuenta del barrio, para mostrar a dónde entra el ingreso. `null`: el barrio no la cargó. */
  readonly cuentaDelBarrio: string | null;
  readonly confirmada: string | null;
  /** F4 tramo 3: «Anulada el {fecha} por {persona}: {motivo}», o `null`. */
  readonly anulada: string | null;
  /** Confirmada y quien mira administra el barrio: se puede anular. */
  readonly puedeAnular: boolean;
  /**
   * F4 tramo 3, cuatro ojos: el barrio pide que la confirme otra persona y quien mira la cargó (la creó o
   * cargó la última cuota o ingreso). La base lo vuelve a controlar al confirmar.
   */
  readonly laConfirmaOtraPersona: boolean;
  /** Después de confirmar: cada pago que dejó la rendición. */
  readonly pagos: readonly {
    readonly unidad: string;
    readonly cuota: string;
    readonly fecha: string;
    readonly importe: string;
    /**
     * Cómo quedó la cuota: entera, en parte, o el pago se reimputó a la deuda original porque el plan cayó.
     * [F4 tramo 3] `anulado`: la rendición se anuló y el pago quedó sin efecto.
     */
    readonly estado: "pagada" | "parcial" | "reimputado" | "anulado";
  }[];
};

export async function rendicion(tx: DbConIdentidad, parametros: { readonly rendicionId: string }): Promise<Rendicion> {
  const id = idSchema.safeParse(parametros.rendicionId);
  if (!id.success) rechazar("referencia_inexistente", "Esa rendición no existe o no tenés acceso.", "Volvé a la lista de rendiciones.");
  return enBase(async () => {
    const { rows } = await tx.execute<{
      id: string;
      barrio_id: string;
      barrio_nombre: string;
      estudio_id: string;
      estudio: string | null;
      periodo: string;
      estado: EstadoRendicion;
      documento_nombre: string | null;
      documento_sha256: string | null;
      documento_clave: string | null;
      puede: boolean;
      cbu: string | null;
      confirmada_at: string | null;
      anulada_at: string | null;
      anulada_por: string | null;
      motivo_anulacion: string | null;
      cuatro_ojos: boolean;
      la_cargo: boolean;
    }>(sql`
      select r.id, r.barrio_id, (select tb.nombre from tenant_node tb where tb.id = r.barrio_id) as barrio_nombre, r.estudio_id, ea.nombre as estudio, r.periodo, r.estado, r.documento_nombre, r.documento_sha256, r.documento_clave,
             app.has_role_on(r.barrio_id, ${ROLES_ADMIN}) as puede, b.cuenta_cbu as cbu,
             (r.anulada_at at time zone b.zona_horaria)::date::text as anulada_at, r.motivo_anulacion,
             (select ud.nombre from usuario_demo ud where ud.user_id = r.anulada_por) as anulada_por,
             coalesce((select pb.rendicion_cuatro_ojos from plan_parametro_barrio pb where pb.barrio_id = r.barrio_id), false) as cuatro_ojos,
             -- Quien la cargó: la creó, o cargó la última cuota o ingreso (la misma regla que la base, 0100).
             (app.current_user_id() = r.creado_por
              or app.current_user_id() is not distinct from (
                   select x.cargado_por from (
                     select cargado_por, created_at, id from plan_rendicion_cuota where rendicion_id = r.id
                     union all
                     select cargado_por, created_at, id from plan_rendicion_ingreso where rendicion_id = r.id) x
                    order by x.created_at desc, x.id desc limit 1)) as la_cargo,
             (r.confirmada_at at time zone b.zona_horaria)::date::text as confirmada_at
        from plan_rendicion r
        join barrio b on b.barrio_id = r.barrio_id
        left join estudio_administracion ea
          on ea.estudio_id = r.estudio_id and ea.administracion_id = (select tb.parent_id from tenant_node tb where tb.id = r.barrio_id)
       where r.id = ${id.data}
    `);
    const r = rows[0];
    if (!r) rechazar("referencia_inexistente", "Esa rendición no existe o no tenés acceso.", "Volvé a la lista de rendiciones.");

    const { rows: cuotas } = await tx.execute<{
      id: string;
      unidad_id: string;
      manzana: string;
      lote: string;
      plan: string;
      numero: number;
      total: number;
      importe: string;
      importe_cuota: string;
      fecha_cobro: string;
      medio_vecino: MedioDelVecino;
    }>(sql`
      select rc.id, pp.unidad_funcional_id as unidad_id, uf.manzana, uf.lote,
             case when pp.tipo = 'catalogo' then coalesce(k.nombre, 'Plan del catálogo') else 'A medida' end as plan,
             pc.numero::int as numero, (select count(*) from plan_cuota x where x.plan_id = pp.id and x.numero > 0)::int as total,
             rc.importe::text, pc.importe::text as importe_cuota, rc.fecha_cobro::text, rc.medio_vecino
        from plan_rendicion_cuota rc
        join plan_cuota pc on pc.id = rc.plan_cuota_id
        join plan_pago pp on pp.id = pc.plan_id
        join unidad_funcional uf on uf.id = pp.unidad_funcional_id
        left join plan_catalogo k on k.id = pp.catalogo_id
       where rc.rendicion_id = ${r.id}
       order by uf.manzana, uf.lote, pc.numero
    `);
    const { rows: ingresos } = await tx.execute<{
      id: string;
      fecha: string;
      medio: MedioDelIngreso;
      cuenta_cbu: string;
      comprobante_nombre: string | null;
      comprobante_sha256: string;
      importe: string;
    }>(sql`
      select id, fecha::text, medio, cuenta_cbu, comprobante_nombre, comprobante_sha256, importe::text
        from plan_rendicion_ingreso where rendicion_id = ${r.id} order by fecha, id
    `);
    const { rows: candidatas } =
      r.estado === "borrador"
        ? await tx.execute<{ id: string; manzana: string; lote: string; numero: number; total: number; saldo: string; vencimiento: string }>(sql`
            select pc.id, uf.manzana, uf.lote, pc.numero::int as numero,
                   (select count(*) from plan_cuota x where x.plan_id = pp.id and x.numero > 0)::int as total,
                   app.saldo_de_liquidacion(pc.liquidacion_id)::numeric(14,2)::text as saldo, pc.vencimiento::text as vencimiento
              from plan_cuota pc
              join plan_pago pp on pp.id = pc.plan_id
              join unidad_funcional uf on uf.id = pp.unidad_funcional_id
             where pc.barrio_id = ${r.barrio_id} and pp.estado = 'vigente' and pp.modo_cobro = 'estudio' and pp.estudio_id = ${r.estudio_id}
               and pc.liquidacion_id is not null and app.saldo_de_liquidacion(pc.liquidacion_id) > 0
               and not exists (select 1 from plan_rendicion_cuota rc where rc.rendicion_id = ${r.id} and rc.plan_cuota_id = pc.id)
             order by uf.manzana, uf.lote, pc.numero
          `)
        : { rows: [] };
    const { rows: pagos } =
      r.estado !== "borrador"
        ? await tx.execute<{ manzana: string; lote: string; numero: number; total: number; fecha: string; importe: string; saldo: string; vigente: boolean; anulado: boolean }>(sql`
            select uf.manzana, uf.lote, pc.numero::int as numero, p.anulado_at is not null as anulado,
                   (select count(*) from plan_cuota x where x.plan_id = pc.plan_id and x.numero > 0)::int as total,
                   p.fecha::text, rp.importe::text, app.saldo_de_liquidacion(pc.liquidacion_id)::numeric(14,2)::text as saldo,
                   -- Si el plan cayó, la caída reimputó el pago a la deuda original: ya no está en la cuota.
                   exists (select 1 from pago_imputacion pi where pi.pago_id = rp.pago_id and pi.liquidacion_id = pc.liquidacion_id
                              and pi.anulado_at is null) as vigente
              from plan_rendicion_pago rp
              join pago p on p.id = rp.pago_id
              join plan_cuota pc on pc.id = rp.plan_cuota_id
              join unidad_funcional uf on uf.id = p.unidad_funcional_id
             where rp.rendicion_id = ${r.id}
             order by uf.manzana, uf.lote, pc.numero, p.fecha
          `)
        : { rows: [] };

    const totalCuotas = sumarMontos("0.00", ...cuotas.map((c) => c.importe));
    const totalIngresos = sumarMontos("0.00", ...ingresos.map((i) => i.importe));
    const diferencia = restarMontos(totalCuotas, totalIngresos);
    return {
      id: r.id,
      barrioId: r.barrio_id,
      barrioNombre: r.barrio_nombre,
      estudio: r.estudio ?? "Estudio",
      periodo: nombreDelPeriodo(r.periodo),
      periodoCodigo: r.periodo,
      estado: r.estado,
      puedeEditar: r.puede && r.estado === "borrador",
      documento: r.documento_clave && r.documento_sha256 ? { nombre: r.documento_nombre ?? "Rendición firmada.pdf", codigoDeControl: r.documento_sha256 } : null,
      cuotas: cuotas.map((c) => ({
        id: c.id,
        unidad: etiquetaUnidad(c.manzana, c.lote),
        unidadId: c.unidad_id,
        plan: c.plan,
        cuota: etiquetaCuota(c.numero, c.total),
        parcial: aCentavos(c.importe) < aCentavos(c.importe_cuota),
        cobro: `${formatearFecha(c.fecha_cobro)} · ${NOMBRE_MEDIO_DEL_VECINO[c.medio_vecino]}`,
        importe: formatearMonto(c.importe),
      })),
      ingresos: ingresos.map((i) => ({
        id: i.id,
        fecha: formatearFecha(i.fecha),
        medio: NOMBRE_MEDIO_DEL_INGRESO[i.medio],
        cuenta: `CBU terminado en ${i.cuenta_cbu.slice(-4)}`,
        comprobante: i.comprobante_nombre ?? "Comprobante",
        codigoDeControl: i.comprobante_sha256,
        importe: formatearMonto(i.importe),
      })),
      totalCuotas: formatearMonto(totalCuotas),
      totalIngresos: formatearMonto(totalIngresos),
      diferencia: formatearMonto(diferencia),
      cuadra: aCentavos(totalCuotas) > 0n && aCentavos(diferencia) === 0n,
      paraRendir: candidatas.map((c) => ({
        planCuotaId: c.id,
        etiqueta: `${etiquetaUnidad(c.manzana, c.lote)} · ${etiquetaCuota(c.numero, c.total)} · vence el ${formatearFecha(c.vencimiento)} · le falta $ ${formatearMonto(c.saldo)}`,
        saldo: c.saldo,
      })),
      cuentaDelBarrio: r.cbu,
      confirmada: r.confirmada_at ? formatearFecha(r.confirmada_at) : null,
      anulada: textoDeAnulacion(r.anulada_at, r.anulada_por, r.motivo_anulacion),
      puedeAnular: r.puede && r.estado === "confirmada",
      laConfirmaOtraPersona: r.estado === "borrador" && r.cuatro_ojos && r.la_cargo,
      pagos: pagos.map((p) => ({
        unidad: etiquetaUnidad(p.manzana, p.lote),
        cuota: etiquetaCuota(p.numero, p.total),
        fecha: formatearFecha(p.fecha),
        importe: formatearMonto(p.importe),
        estado: p.anulado ? "anulado" : !p.vigente ? "reimputado" : aCentavos(p.saldo) <= 0n ? "pagada" : "parcial",
      })),
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Cargar y quitar
// ────────────────────────────────────────────────────────────────────────────────────────────────

export async function agregarCuotaARendicion(tx: DbConIdentidad, parametros: AgregarCuotaARendicion): Promise<{ readonly id: string }> {
  const p = agregarCuotaARendicionSchema.parse(parametros);
  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into plan_rendicion_cuota (rendicion_id, barrio_id, plan_cuota_id, importe, fecha_cobro, medio_vecino)
      select r.id, r.barrio_id, ${p.planCuotaId}, ${p.importe}::numeric, ${p.fechaCobro}::date, ${p.medioVecino}
        from plan_rendicion r where r.id = ${p.rendicionId}
      returning id
    `);
    if (!rows[0]) rechazar("referencia_inexistente", "Esa rendición no existe o no tenés acceso.", "Volvé a la lista de rendiciones.");
    return { id: rows[0].id };
  });
}

export async function quitarCuotaDeRendicion(tx: DbConIdentidad, parametros: { readonly id: string }): Promise<void> {
  const id = idSchema.parse(parametros.id);
  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`delete from plan_rendicion_cuota where id = ${id} returning id`);
    if (!rows[0]) rechazar("referencia_inexistente", "Esa cuota ya no está en la rendición.", "Recargá la pantalla.");
  });
}

export async function quitarIngresoDeRendicion(tx: DbConIdentidad, parametros: { readonly id: string }): Promise<void> {
  const id = idSchema.parse(parametros.id);
  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`delete from plan_rendicion_ingreso where id = ${id} returning id`);
    if (!rows[0]) rechazar("referencia_inexistente", "Ese ingreso ya no está en la rendición.", "Recargá la pantalla.");
  });
}

/** El barrio de una rendición en borrador que quien llama puede editar (para dar la clave o verificarla). */
export async function rendicionParaSubir(tx: DbConIdentidad, parametros: { readonly rendicionId: string }): Promise<{ readonly barrioId: string }> {
  const rendicionId = idSchema.parse(parametros.rendicionId);
  return enBase(async () => {
    const { rows } = await tx.execute<{ barrio_id: string; estado: EstadoRendicion; puede: boolean }>(sql`
      select barrio_id, estado, app.has_role_on(barrio_id, ${ROLES_ADMIN}) as puede from plan_rendicion where id = ${rendicionId}
    `);
    const r = rows[0];
    if (!r) rechazar("referencia_inexistente", "Esa rendición no existe o no tenés acceso.", "Volvé a la lista de rendiciones.");
    if (!r.puede) rechazar("sin_permiso", "No podés cargar esta rendición.", "La carga la administración del barrio.");
    if (r.estado !== "borrador") rechazar("dato_invalido", "La rendición ya está confirmada: no se modifica.", "Recargá la pantalla.");
    return { barrioId: r.barrio_id };
  });
}

/**
 * La clave donde el navegador sube el PDF firmado o el comprobante de un ingreso, **antes** de
 * agregarlo. No escribe nada: la clave queda atada al barrio y a la rendición por el CHECK de `0097`.
 */
export async function prepararSubidaDeRendicion(
  tx: DbConIdentidad,
  parametros: PrepararSubidaDeRendicion,
): Promise<{ readonly storageKey: string; readonly barrioId: string }> {
  const p = prepararSubidaDeRendicionSchema.parse(parametros);
  if (p.para === "pdf" && p.contentType !== "application/pdf") {
    rechazar("dato_invalido", "La rendición firmada va en PDF.", "Elegí el PDF que mandó el estudio.");
  }
  const { barrioId } = await rendicionParaSubir(tx, { rendicionId: p.rendicionId });
  return {
    barrioId,
    storageKey: claveDeArchivoDeRendicion({ barrioId, rendicionId: p.rendicionId, token: nuevoToken(), contentType: p.contentType as ContentTypeDeComprobante }),
  };
}

/** Adjunta (o cambia, mientras está en borrador) el PDF firmado. El SHA-256 lo calcula quien llama leyendo el objeto. */
export async function adjuntarPdfDeRendicion(
  tx: DbConIdentidad,
  parametros: AdjuntarPdfDeRendicion & { readonly sha256: string; readonly bytes: number },
): Promise<void> {
  const p = adjuntarPdfDeRendicionSchema.parse(parametros);
  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      update plan_rendicion
         set documento_clave = ${p.clave}, documento_sha256 = ${parametros.sha256}, documento_bytes = ${parametros.bytes}::int,
             documento_nombre = ${p.nombre || null}
       where id = ${p.rendicionId}
      returning id
    `);
    if (!rows[0]) rechazar("referencia_inexistente", "Esa rendición no existe o no tenés acceso.", "Volvé a la lista de rendiciones.");
  });
}

/** Agrega un ingreso al barrio. La cuenta es la del barrio (la base lo verifica); el SHA-256 lo calcula quien llama. */
export async function agregarIngresoARendicion(
  tx: DbConIdentidad,
  parametros: AgregarIngresoARendicion & { readonly sha256: string; readonly bytes: number },
): Promise<{ readonly id: string }> {
  const p = agregarIngresoARendicionSchema.parse(parametros);
  return enBase(async () => {
    const { rows: b } = await tx.execute<{ cbu: string | null }>(sql`
      select b.cuenta_cbu as cbu from plan_rendicion r join barrio b on b.barrio_id = r.barrio_id where r.id = ${p.rendicionId}
    `);
    if (!b[0]) rechazar("referencia_inexistente", "Esa rendición no existe o no tenés acceso.", "Volvé a la lista de rendiciones.");
    if (!b[0].cbu) rechazar("dato_invalido", "El barrio no tiene cargada su cuenta bancaria.", "Cargala en la configuración del barrio y volvé.");
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into plan_rendicion_ingreso (rendicion_id, barrio_id, fecha, medio, importe, cuenta_cbu, comprobante_clave, comprobante_sha256,
                                          comprobante_bytes, comprobante_nombre)
      select r.id, r.barrio_id, ${p.fecha}::date, ${p.medio}, ${p.importe}::numeric, ${b[0].cbu}, ${p.clave}, ${parametros.sha256},
             ${parametros.bytes}::int, ${p.nombre || null}
        from plan_rendicion r where r.id = ${p.rendicionId}
      returning id
    `);
    return { id: rows[0]!.id };
  });
}

/** Confirma la rendición: cada pedazo de ingreso queda como un pago imputado a su cuota. Devuelve cuántos pagos dejó. */
export async function confirmarRendicion(tx: DbConIdentidad, parametros: { readonly rendicionId: string }): Promise<{ readonly pagos: number }> {
  const rendicionId = idSchema.parse(parametros.rendicionId);
  return enBase(async () => {
    // [F4 tramo 3] Una anulada no se vuelve a confirmar (la base también lo frena, con otro texto).
    const { rows: e } = await tx.execute<{ estado: string }>(sql`select estado from plan_rendicion where id = ${rendicionId}`);
    if (e[0]?.estado === "anulada") rechazar("dato_invalido", "La rendición está anulada: no se vuelve a confirmar.", "Si hace falta, cargá una rendición nueva.");
    const { rows } = await tx.execute<{ n: number }>(sql`select app.plan_rendicion_confirmar(${rendicionId}::uuid)::int as n`);
    return { pagos: rows[0]!.n };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// [F4 tramo 3, BL-053 a] Anular una rendición confirmada
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type ConsecuenciaDeAnular = {
  readonly unidad: string;
  /** Lo que la cuota (o las cuotas) del plan vuelven a deber al anular. */
  readonly vuelveADeber: string;
  /** El plan está cumplido: vuelve a vigente. */
  readonly reabre: boolean;
  /**
   * El plan cayó: los pagos se habían reimputado a la deuda de la unidad, que vuelve a deber esto (capital e
   * interés por mora por separado). `null` si no hay nada reimputado.
   */
  readonly deudaReimputada: { readonly capital: string; readonly interes: string } | null;
  /** El plan está cumplido y la unidad ya tiene otro plan abierto: la anulación se va a frenar. */
  readonly bloquea: boolean;
  /** La frase para el diálogo, con las cifras. */
  readonly texto: string;
};

/**
 * Qué pasa si se anula: por cada plan de la rendición, cuánto vuelven a deber sus cuotas (o su deuda
 * original, si el plan cayó) y si un plan cumplido vuelve a vigente. Son las imputaciones vivas de los
 * pagos de la rendición: exactamente lo que el contraasiento deja sin efecto.
 */
export async function consecuenciasDeAnularRendicion(
  tx: DbConIdentidad,
  parametros: { readonly rendicionId: string },
): Promise<readonly ConsecuenciaDeAnular[]> {
  const rendicionId = idSchema.parse(parametros.rendicionId);
  return enBase(async () => {
    // Por pago, sus imputaciones vivas: a la cuota rendida, al capital de otra liquidación (la caída las
    // reimputó a la deuda de la unidad) y al interés por mora. Exactamente lo que el contraasiento anula.
    const { rows } = await tx.execute<{
      manzana: string;
      lote: string;
      estado: string;
      a_cuota: string;
      a_capital: string;
      a_interes: string;
      otro_abierto: boolean;
      deuda_en_otro_plan: boolean;
    }>(sql`
      select uf.manzana, uf.lote, pp.estado,
             coalesce(sum((select coalesce(sum(pi.monto_imputado), 0) from pago_imputacion pi
                            where pi.pago_id = rp.pago_id and pi.anulado_at is null and pi.liquidacion_id = pc.liquidacion_id)), 0)::numeric(14,2)::text as a_cuota,
             coalesce(sum((select coalesce(sum(pi.monto_imputado), 0) from pago_imputacion pi
                            where pi.pago_id = rp.pago_id and pi.anulado_at is null and pi.liquidacion_id <> pc.liquidacion_id)), 0)::numeric(14,2)::text as a_capital,
             coalesce(sum((select coalesce(sum(pii.monto_imputado), 0) from pago_imputacion_interes pii
                            where pii.pago_id = rp.pago_id and pii.anulado_at is null)), 0)::numeric(14,2)::text as a_interes,
             exists (select 1 from plan_pago o where o.unidad_funcional_id = pp.unidad_funcional_id and o.id <> pp.id
                        and o.estado in ('vigente', 'pendiente')) as otro_abierto,
             -- [F4 tramo 4] La misma condición que frena la anulación en la base (0100, M1 del tramo 3): lo que
             -- la caída reimputó está ahora en otro plan vigente o cumplido.
             bool_or(exists (select 1 from pago_imputacion pi
                               join plan_liquidacion pl on pl.liquidacion_id = pi.liquidacion_id
                               join plan_pago o on o.id = pl.plan_id and o.estado in ('vigente', 'cumplido') and o.id <> pp.id
                              where pi.pago_id = rp.pago_id and pi.anulado_at is null)
                     or exists (select 1 from pago_imputacion_interes pii
                                  join interes_devengado d on d.id = pii.interes_id
                                  join plan_liquidacion pl on pl.liquidacion_id = d.liquidacion_id
                                  join plan_pago o on o.id = pl.plan_id and o.estado in ('vigente', 'cumplido') and o.id <> pp.id
                                 where pii.pago_id = rp.pago_id and pii.anulado_at is null)) as deuda_en_otro_plan
        from plan_rendicion_pago rp
        join plan_cuota pc on pc.id = rp.plan_cuota_id
        join plan_pago pp on pp.id = pc.plan_id
        join unidad_funcional uf on uf.id = pp.unidad_funcional_id
       where rp.rendicion_id = ${rendicionId}
       group by pp.id, pp.unidad_funcional_id, uf.manzana, uf.lote, pp.estado
       order by uf.manzana, uf.lote
    `);
    return rows.map((r) => {
      const unidad = etiquetaUnidad(r.manzana, r.lote);
      const cuota = formatearMonto(r.a_cuota);
      const reimputada = aCentavos(r.a_capital) + aCentavos(r.a_interes) > 0n;
      const deudaReimputada = reimputada ? { capital: formatearMonto(r.a_capital), interes: formatearMonto(r.a_interes) } : null;
      const reabre = r.estado === "cumplido";
      const bloquea = (reabre && r.otro_abierto) || r.deuda_en_otro_plan;
      const reimputadoTexto = deudaReimputada
        ? aCentavos(r.a_interes) > 0n
          ? `$ ${deudaReimputada.capital} de capital y $ ${deudaReimputada.interes} de interés por mora`
          : `$ ${deudaReimputada.capital}`
        : "$ 0,00";
      const texto = r.deuda_en_otro_plan
        ? `La deuda de ${unidad} que cubrió la rendición está ahora en otro plan vigente o cumplido: no se puede anular.`
        : bloquea
          ? `El plan de ${unidad} está cumplido y la unidad ya tiene otro plan abierto: no se puede anular hasta resolver ese plan.`
          : reabre
            ? `El plan de ${unidad} está cumplido: vuelve a vigente y sus cuotas vuelven a deber $ ${cuota}.`
            : r.estado === "caido"
              ? `El plan de ${unidad} cayó: lo que se había reimputado a la deuda de la unidad vuelve a deber ${reimputadoTexto}.`
              : `${unidad}: sus cuotas vuelven a deber $ ${cuota}.`;
      return { unidad, vuelveADeber: cuota, reabre, deudaReimputada, bloquea, texto };
    });
  });
}

/**
 * Anula una rendición confirmada, con motivo: el contraasiento (`app.plan_rendicion_anular`, `0100`) anula
 * los pagos que dejó y sus imputaciones, sin borrar nada; las cuotas vuelven a su saldo anterior y un plan
 * que esa rendición había cumplido vuelve a vigente. Devuelve cuántos pagos quedaron anulados.
 */
export async function anularRendicion(tx: DbConIdentidad, parametros: AnularRendicion): Promise<{ readonly pagos: number }> {
  const p = anularRendicionSchema.parse(parametros);
  return enBase(async () => {
    const { rows } = await tx.execute<{ n: number }>(sql`select app.plan_rendicion_anular(${p.rendicionId}::uuid, ${p.motivo})::int as n`);
    return { pagos: rows[0]!.n };
  });
}

/** Para la descarga: la clave del PDF o del comprobante, leída bajo RLS, con su SHA-256 para verificarlo. */
export async function prepararDescargaDeArchivoDeRendicion(
  tx: DbConIdentidad,
  parametros: { readonly rendicionId: string; readonly ingresoId: string | null },
): Promise<{ readonly storageKey: string; readonly nombreArchivo: string; readonly sha256: string }> {
  const rendicionId = idSchema.safeParse(parametros.rendicionId);
  const ingresoId = parametros.ingresoId === null ? null : idSchema.safeParse(parametros.ingresoId);
  if (!rendicionId.success || (ingresoId !== null && !ingresoId.success)) {
    rechazar("referencia_inexistente", "Ese archivo no existe o no tenés acceso.", "Volvé a la rendición.");
  }
  return enBase(async () => {
    const { rows } =
      ingresoId === null
        ? await tx.execute<{ clave: string | null; sha256: string | null; periodo: string }>(sql`
            select documento_clave as clave, documento_sha256 as sha256, periodo from plan_rendicion where id = ${rendicionId.data}
          `)
        : await tx.execute<{ clave: string | null; sha256: string | null; periodo: string }>(sql`
            select i.comprobante_clave as clave, i.comprobante_sha256 as sha256, r.periodo
              from plan_rendicion_ingreso i join plan_rendicion r on r.id = i.rendicion_id
             where i.id = ${ingresoId.data!} and i.rendicion_id = ${rendicionId.data}
          `);
    const f = rows[0];
    if (!f?.clave || !f.sha256) rechazar("referencia_inexistente", "Ese archivo no existe o no tenés acceso.", "Volvé a la rendición.");
    const base = ingresoId === null ? "Rendicion-firmada" : "Comprobante-de-ingreso";
    return { storageKey: f.clave, nombreArchivo: `${base}-${f.periodo}${f.clave.slice(f.clave.lastIndexOf("."))}`, sha256: f.sha256 };
  });
}
