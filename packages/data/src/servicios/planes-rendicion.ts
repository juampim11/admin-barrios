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
  crearRendicionSchema,
  NOMBRE_MEDIO_DEL_INGRESO,
  NOMBRE_MEDIO_DEL_VECINO,
  prepararSubidaDeRendicionSchema,
  type AdjuntarPdfDeRendicion,
  type AgregarCuotaARendicion,
  type AgregarIngresoARendicion,
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
    }>(sql`
      select r.id, ea.nombre as estudio, r.periodo, r.estado,
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
      })),
    };
  });
}

export async function crearRendicion(tx: DbConIdentidad, parametros: CrearRendicion): Promise<{ readonly rendicionId: string }> {
  const p = crearRendicionSchema.parse(parametros);
  return enBase(async () => {
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
  /** Después de confirmar: cada pago que dejó la rendición. */
  readonly pagos: readonly {
    readonly unidad: string;
    readonly cuota: string;
    readonly fecha: string;
    readonly importe: string;
    /** Cómo quedó la cuota: entera, en parte, o el pago se reimputó a la deuda original porque el plan cayó. */
    readonly estado: "pagada" | "parcial" | "reimputado";
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
    }>(sql`
      select r.id, r.barrio_id, (select tb.nombre from tenant_node tb where tb.id = r.barrio_id) as barrio_nombre, r.estudio_id, ea.nombre as estudio, r.periodo, r.estado, r.documento_nombre, r.documento_sha256, r.documento_clave,
             app.has_role_on(r.barrio_id, ${ROLES_ADMIN}) as puede, b.cuenta_cbu as cbu,
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
      r.estado === "confirmada"
        ? await tx.execute<{ manzana: string; lote: string; numero: number; total: number; fecha: string; importe: string; saldo: string; vigente: boolean }>(sql`
            select uf.manzana, uf.lote, pc.numero::int as numero,
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
      pagos: pagos.map((p) => ({
        unidad: etiquetaUnidad(p.manzana, p.lote),
        cuota: etiquetaCuota(p.numero, p.total),
        fecha: formatearFecha(p.fecha),
        importe: formatearMonto(p.importe),
        estado: !p.vigente ? "reimputado" : aCentavos(p.saldo) <= 0n ? "pagada" : "parcial",
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
    const { rows } = await tx.execute<{ n: number }>(sql`select app.plan_rendicion_confirmar(${rendicionId}::uuid)::int as n`);
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
