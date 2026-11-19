/**
 * Las gestiones de cobranza de una unidad y su ficha de mora (encargo E-a2, BL-050; tablas de `0091`).
 *
 * Portado de Aclade (`aclade-cobranzas`): `registrar_gestion`, `anular_gestion` y `promesas_de_pago`
 * de `supabase/migrations/0014_gestiones_reclamo_legal.sql` (241-421). Allá son funciones de la base
 * con `app.puede`; acá los permisos los decide la RLS de `0091` y estas reglas viven en el servicio:
 * la promesa de hoy en adelante y hasta `PLAZO_MAXIMO_PROMESA_DIAS`, el doble clic y el adjunto.
 *
 * **Nada de esto calcula plata.** La deuda de la ficha sale de `deudaALaFecha` (la del estado de
 * cuenta y la boleta) y lo pagado para una promesa es la suma de lo imputado, que ya existe.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { claveDeAdjuntoDeGestion, nuevoToken, SUFIJO_PATRON_CLAVE_ADJUNTO_GESTION, type ContentTypeDeComprobante } from "@admin-barrios/almacenamiento";
import { aCentavos, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { idSchema } from "@admin-barrios/shared/consultas";
import {
  anularGestionSchema,
  estadoPromesa,
  PLAZO_MAXIMO_PROMESA_DIAS,
  prepararSubidaDeAdjuntoSchema,
  registrarGestionSchema,
  type AnularGestion,
  type CanalGestion,
  type EstadoPromesa,
  type MotivoDerivacion,
  type MotivoRetiro,
  type PrepararSubidaDeAdjunto,
  type RegistrarGestion,
  type ResultadoGestion,
} from "@admin-barrios/shared/mora";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";
import { deudaALaFecha, diasDeAtrasoPorUnidad } from "./deuda.ts";
import type { FotoDeDerivacion } from "./mora.ts";

/**
 * Lo pagado para una promesa: **todo lo imputado** (no anulado) de los pagos no anulados de la unidad
 * con fecha entre el alta de la gestión y la fecha prometida, inclusive — a capital
 * (`pago_imputacion`) y a interés (`pago_imputacion_interes`). Con solo el capital, un pago de
 * $ 50.000 que la imputación de siempre reparte entre interés y capital no cumplía una promesa de
 * $ 50.000. Es la regla de Aclade (`promesas_de_pago`, sus `movimientos` de imputación), con las
 * tablas de este repo. **No imputa nada: suma lo que ya se imputó.**
 *
 * `unidad`, `desde` y `hasta` son expresiones SQL de la consulta que lo usa (columnas fijas del código).
 */
export function pagadoParaPromesa(unidad: string, desde: string, hasta: string) {
  const u = sql.raw(unidad);
  const d = sql.raw(desde);
  const h = sql.raw(hasta);
  return sql`(select coalesce(sum(x.monto), 0)::numeric(14,2) from (
      select pi.monto_imputado as monto from pago_imputacion pi join pago pg on pg.id = pi.pago_id
       where pg.unidad_funcional_id = ${u} and pg.anulado_at is null and pi.anulado_at is null and pg.fecha between ${d} and ${h}
         and pg.origen <> 'plan' -- [P1] el pago de un plan no es plata que el vecino pagó
      union all
      select pii.monto_imputado from pago_imputacion_interes pii join pago pg on pg.id = pii.pago_id
       where pg.unidad_funcional_id = ${u} and pg.anulado_at is null and pii.anulado_at is null and pg.fecha between ${d} and ${h}
         and pg.origen <> 'plan'
    ) x)`;
}

const ROLES_QUE_GESTIONAN = sql`array['admin_plataforma', 'admin_barrio', 'operador']::app.rol_membership[]`;
const ROLES_QUE_DERIVAN = sql`array['admin_plataforma', 'admin_barrio']::app.rol_membership[]`;

/** «No existe» y «no la podés ver» son el mismo caso: un uuid ajeno no es un oráculo de existencia. */
function rechazarUnidad(): never {
  rechazar("unidad_no_encontrada", "Esa unidad no existe o no tenés acceso a ella.", "Volvé a la mora del barrio y elegí la unidad de nuevo.");
}

async function unidadVisible(tx: DbConIdentidad, unidadFuncionalId: string): Promise<{ barrioId: string; hoy: string }> {
  const { rows } = await tx.execute<{ barrio_id: string; hoy: string }>(sql`
    select u.barrio_id, (now() at time zone b.zona_horaria)::date::text as hoy
      from unidad_funcional u join barrio b on b.barrio_id = u.barrio_id
     where u.id = ${unidadFuncionalId}
  `);
  const f = rows[0];
  if (!f) rechazarUnidad();
  return { barrioId: f.barrio_id, hoy: f.hoy };
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Adjunto: la clave la da el servidor; el sha256 lo calcula el servidor leyendo lo subido
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * La clave donde el navegador sube el adjunto de una gestión, **antes** de registrarla (como el
 * comprobante de un pago). Solo para quien puede registrar gestiones en el barrio de la unidad.
 * No escribe nada: la clave queda atada al barrio por `gestion_adjunto_clave_chk` y, al registrar,
 * el servidor lee el objeto (si no existe, no se registra).
 */
export async function prepararSubidaDeAdjuntoDeGestion(
  tx: DbConIdentidad,
  parametros: PrepararSubidaDeAdjunto,
): Promise<{ readonly storageKey: string }> {
  const p = prepararSubidaDeAdjuntoSchema.parse(parametros);
  return enBase(async () => {
    const { barrioId } = await unidadVisible(tx, p.unidadFuncionalId);
    const { rows } = await tx.execute<{ puede: boolean }>(sql`select app.has_role_on(${barrioId}::uuid, ${ROLES_QUE_GESTIONAN}) as puede`);
    if (!rows[0]?.puede) rechazar("sin_permiso", "No podés registrar gestiones en este barrio.", "Pedíselo a quien lo administra.");
    return { storageKey: claveDeAdjuntoDeGestion({ barrioId, token: nuevoToken(), contentType: p.contentType as ContentTypeDeComprobante }) };
  });
}

/** El sha256 de lo que se subió, en hexadecimal (64 caracteres). Lo calcula el servidor. */
export function sha256DeAdjunto(contenido: Buffer): string {
  return createHash("sha256").update(contenido).digest("hex");
}

/** El content-type de un adjunto, por la extensión de su clave (la lista cerrada de la clave). */
export function tipoDeAdjunto(clave: string): string {
  const ext = clave.slice(clave.lastIndexOf(".") + 1).toLowerCase();
  return ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : "image/jpeg";
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Registrar y anular
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Registra una gestión de la administración (Aclade `registrar_gestion`). La base fija el día (hoy en
 * el barrio), quién y cuándo; acá van las reglas que Aclade valida en su función: la promesa de hoy
 * en adelante y hasta el plazo, y la misma gestión dos veces seguidas (doble clic) se rechaza.
 *
 * `adjuntoSha256` lo calcula quien llama **leyendo el objeto del almacenamiento** (la Server Action,
 * con `sha256DeAdjunto`): el servicio no confía en un hash del navegador ni toca el almacenamiento.
 */
export async function registrarGestion(
  tx: DbConIdentidad,
  parametros: RegistrarGestion & { readonly adjuntoSha256?: string | null },
): Promise<{ readonly gestionId: string }> {
  const q = registrarGestionSchema.parse(parametros);
  const sha = parametros.adjuntoSha256 ?? null;
  return enBase(async () => {
    const { barrioId, hoy } = await unidadVisible(tx, q.unidadFuncionalId);
    if (q.promesaFecha !== null) {
      if (q.promesaFecha < hoy) {
        rechazar("dato_invalido", "Esa fecha ya pasó: la promesa va de hoy en adelante.", "Elegí una fecha desde hoy.", { campo: "promesaFecha" });
      }
      const maximo = sumarDias(hoy, PLAZO_MAXIMO_PROMESA_DIAS);
      if (q.promesaFecha > maximo) {
        rechazar("dato_invalido", `La fecha prometida puede ser hasta ${PLAZO_MAXIMO_PROMESA_DIAS} días desde hoy.`, "Elegí una fecha más cercana.", {
          campo: "promesaFecha",
        });
      }
    }
    if (q.adjunto !== null) {
      if (!new RegExp(`^barrios/${barrioId}${SUFIJO_PATRON_CLAVE_ADJUNTO_GESTION}`).test(q.adjunto.clave) || !sha || !/^[0-9a-f]{64}$/.test(sha)) {
        rechazar("dato_invalido", "El archivo adjunto no se pudo verificar.", "Volvé a elegir el archivo y registrá la gestión de nuevo.");
      }
    }
    if (q.adjunto !== null) {
      // Una clave es de UNA gestión: la de otra (que se ve en su descarga) no se reusa como respaldo
      // de esta (security-engineer, E-a2). Bajo RLS se ve, porque la clave ya es de este barrio.
      const { rows: usada } = await tx.execute<{ n: number }>(sql`select count(*)::int as n from gestion where adjunto_clave = ${q.adjunto.clave}`);
      if ((usada[0]?.n ?? 0) > 0) rechazar("dato_invalido", "El archivo adjunto no se pudo verificar.", "Volvé a elegir el archivo y registrá la gestión de nuevo.");
    }
    // De a una por unidad, así el control del doble clic no se saltea con dos pedidos a la vez.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('gestion/' || ${q.unidadFuncionalId}, 7))`);
    const { rows: repetida } = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from gestion x
       where x.unidad_funcional_id = ${q.unidadFuncionalId} and x.registrado_por = app.current_user_id()
         and x.registrado_at > clock_timestamp() - interval '30 seconds'
         and (x.canal, x.resultado, x.nota, x.promesa_fecha, x.promesa_monto)
             is not distinct from (${q.canal}::text, ${q.resultado}::text, ${q.nota}::text, ${q.promesaFecha}::date, ${q.promesaMonto}::numeric)
    `);
    if ((repetida[0]?.n ?? 0) > 0) rechazar("dato_invalido", "Esa gestión ya se registró recién.", "Mirá la lista de gestiones: ya está.");
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, nota, fecha, promesa_fecha, promesa_monto,
                           adjunto_clave, adjunto_sha256, adjunto_nombre, adjunto_tipo, registrado_por)
      values (${barrioId}, ${q.unidadFuncionalId}, 'administracion', ${q.canal}, ${q.resultado}, ${q.nota}, ${hoy}::date,
              ${q.promesaFecha}::date, ${q.promesaMonto}::numeric,
              ${q.adjunto?.clave ?? null}, ${q.adjunto ? sha : null}, ${q.adjunto?.nombre ?? null},
              ${q.adjunto ? tipoDeAdjunto(q.adjunto.clave) : null}, app.current_user_id())
      returning id
    `);
    if (!rows[0]) rechazar("sin_permiso", "No podés registrar gestiones en este barrio.", "Pedíselo a quien lo administra.");
    return { gestionId: rows[0].id };
  });
}

/** Anula una gestión de la administración con motivo (Aclade `anular_gestion`): la gestión queda, tachada. */
export async function anularGestion(tx: DbConIdentidad, parametros: AnularGestion): Promise<void> {
  const q = anularGestionSchema.parse(parametros);
  await enBase(async () => {
    const { rows } = await tx.execute<{ barrio_id: string; autor_tipo: string; canal: string; anulada: boolean; propia: boolean; administra: boolean }>(sql`
      select g.barrio_id, g.autor_tipo, g.canal, exists (select 1 from gestion_anulacion a where a.gestion_id = g.id) as anulada,
             g.registrado_por = app.current_user_id() as propia,
             app.has_role_on(g.barrio_id, ${ROLES_QUE_DERIVAN}) as administra
        from gestion g where g.id = ${q.gestionId}
    `);
    const g = rows[0];
    if (!g) rechazar("referencia_inexistente", "Esa gestión no existe o no tenés acceso.", "Recargá la ficha.");
    if (g.anulada) rechazar("dato_invalido", "La gestión ya está anulada.", "Recargá la ficha.");
    if (g.autor_tipo !== "administracion") rechazar("sin_permiso", "Las gestiones del estudio las anula el estudio.", "Pedíselo al estudio.");
    if (g.canal === "derivacion") rechazar("dato_invalido", "El renglón de una derivación no se anula: la derivación se retira.", "Usá «Retirar del estudio».");
    // El operador anula las que cargó él; la administración, cualquiera (security-engineer, E-a2).
    if (!g.propia && !g.administra) rechazar("sin_permiso", "Solo podés anular las gestiones que cargaste vos.", "Pedíselo a quien administra el barrio.");
    await tx.execute(sql`
      insert into gestion_anulacion (gestion_id, barrio_id, autor_tipo, motivo, anulada_por)
      values (${q.gestionId}, ${g.barrio_id}, 'administracion', ${q.motivo}, app.current_user_id())
    `);
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La ficha de mora de una unidad (pantalla 3)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type GestionDeLaFicha = {
  readonly id: string;
  readonly registradoAt: string;
  readonly fecha: string;
  readonly autor: "administracion" | "estudio";
  /** El nombre de quien la cargó si se conoce (usuarios de la demo), o el del estudio. */
  readonly quien: string | null;
  readonly canal: CanalGestion;
  readonly resultado: ResultadoGestion | null;
  readonly nota: string | null;
  readonly promesa: { readonly fecha: string; readonly monto: Monto; readonly pagado: Monto; readonly estado: EstadoPromesa } | null;
  readonly adjunto: { readonly nombre: string; readonly tipo: string } | null;
  readonly anulacion: { readonly motivo: string; readonly at: string } | null;
  /** En el renglón de una derivación que después se retiró: el día del retiro (como en la lista). */
  readonly retiradaEl: string | null;
  /** La administración puede anularla: es suya, no está anulada y no es el renglón de una derivación. */
  readonly anulable: boolean;
};

export type DerivacionDeLaFicha = {
  readonly id: string;
  readonly estudio: string;
  readonly motivo: MotivoDerivacion;
  readonly nota: string | null;
  readonly derivadaAt: string;
  readonly retiro: { readonly motivo: MotivoRetiro; readonly nota: string | null; readonly at: string } | null;
  readonly foto: FotoDeDerivacion | null;
};

export type FichaDeMora = {
  readonly barrio: { readonly id: string; readonly nombre: string };
  readonly unidad: { readonly id: string; readonly etiqueta: string };
  readonly titular: { readonly nombre: string; readonly telefono: string | null; readonly email: string | null } | null;
  readonly hoy: string;
  /** Las cifras, de `deudaALaFecha` y `diasDeAtrasoPorUnidad` (las de siempre). */
  readonly meses: number;
  /** Los meses vencidos e impagos (`YYYY-MM`), para el origen del capital vencido. */
  readonly periodosVencidos: readonly string[];
  readonly capitalVencido: Monto;
  readonly interes: Monto;
  readonly atraso: { readonly dias: number; readonly desde: string } | null;
  readonly derivacionVigente: DerivacionDeLaFicha | null;
  readonly derivaciones: readonly DerivacionDeLaFicha[];
  readonly gestiones: readonly GestionDeLaFicha[];
  /** La última promesa no anulada, para la etiqueta de arriba. */
  readonly promesa: GestionDeLaFicha["promesa"];
  readonly puedeRegistrar: boolean;
  readonly puedeRetirar: boolean;
  /** La última fecha que admite una promesa hoy (`hoy + PLAZO_MAXIMO_PROMESA_DIAS`). */
  readonly promesaMaxima: string;
  /**
   * F4 tramo 4: si el barrio cobra interés por mora hoy (`interes.cobra`, el del barrio o el de su
   * administración). Sin interés, la ficha lo dice junto a «interés a hoy» en vez de dejar un 0 sin explicar.
   */
  readonly cobraInteres: boolean;
};

export async function fichaDeMora(tx: DbConIdentidad, parametros: { readonly unidadFuncionalId: string }): Promise<FichaDeMora | null> {
  const id = idSchema.safeParse(parametros.unidadFuncionalId);
  if (!id.success) return null;
  const unidadId = id.data;
  const { rows: u } = await tx.execute<{
    barrio_id: string;
    barrio: string;
    manzana: string;
    lote: string;
    hoy: string;
    administracion_id: string;
    puede_registrar: boolean;
    puede_retirar: boolean;
    zona: string;
  }>(sql`
    select u.barrio_id, n.nombre as barrio, b.zona_horaria as zona, u.manzana, u.lote, (now() at time zone b.zona_horaria)::date::text as hoy, n.parent_id as administracion_id,
           app.has_role_on(u.barrio_id, ${ROLES_QUE_GESTIONAN}) as puede_registrar,
           app.has_role_on(u.barrio_id, ${ROLES_QUE_DERIVAN}) as puede_retirar
      from unidad_funcional u join barrio b on b.barrio_id = u.barrio_id join tenant_node n on n.id = u.barrio_id
     where u.id = ${unidadId}
  `);
  const f = u[0];
  if (!f) return null;
  // Las marcas de tiempo, en la hora del barrio (la base guarda UTC): «16/11 22:26» y no «17/11 01:26».
  const zona = f.zona;

  const { rows: titular } = await tx.execute<{ nombre: string; telefono: string | null; email: string | null }>(sql`
    select o.nombre, o.telefono, o.email from unidad_obligado uo join obligado o on o.id = uo.obligado_id
     where uo.unidad_funcional_id = ${unidadId} and uo.hasta is null
     order by uo.es_notificado desc, o.nombre limit 1
  `);

  const deuda = (await deudaALaFecha(tx, { barrioId: f.barrio_id, fecha: f.hoy, unidadFuncionalId: unidadId })).get(unidadId);
  const vencidos = deuda ? deuda.porMes.filter((m) => m.vencimiento < f.hoy && aCentavos(m.capital) > 0n) : [];
  const atraso = (await diasDeAtrasoPorUnidad(tx, { barrioId: f.barrio_id, unidadFuncionalId: unidadId })).get(unidadId) ?? null;

  const { rows: derivaciones } = await tx.execute<{
    id: string;
    estudio: string;
    motivo: MotivoDerivacion;
    nota: string | null;
    derivada_at: string;
    retiro_motivo: MotivoRetiro | null;
    retiro_nota: string | null;
    retirada_at: string | null;
    foto: FotoDeDerivacion | null;
  }>(sql`
    select d.id, coalesce(ea.nombre, 'Estudio') as estudio, d.motivo, d.nota, (d.derivada_at at time zone ${zona})::text as derivada_at,
           d.retiro_motivo, d.retiro_nota, (d.retirada_at at time zone ${zona})::text as retirada_at, f.foto
      from derivacion d
      left join estudio_administracion ea on ea.estudio_id = d.estudio_id and ea.administracion_id = ${f.administracion_id}
      left join derivacion_foto f on f.derivacion_id = d.id
     where d.unidad_funcional_id = ${unidadId}
     order by d.derivada_at desc
  `);
  const derivacionesVista: DerivacionDeLaFicha[] = derivaciones.map((d) => ({
    id: d.id,
    estudio: d.estudio,
    motivo: d.motivo,
    nota: d.nota,
    derivadaAt: d.derivada_at,
    retiro: d.retirada_at && d.retiro_motivo ? { motivo: d.retiro_motivo, nota: d.retiro_nota, at: d.retirada_at } : null,
    foto: d.foto,
  }));

  const { rows: gestiones } = await tx.execute<{
    id: string;
    registrado_at: string;
    fecha: string;
    autor_tipo: "administracion" | "estudio";
    quien: string | null;
    canal: CanalGestion;
    resultado: ResultadoGestion | null;
    nota: string | null;
    promesa_fecha: string | null;
    promesa_monto: string | null;
    pagado: string | null;
    adjunto_nombre: string | null;
    adjunto_tipo: string | null;
    anulacion_motivo: string | null;
    anulada_at: string | null;
    propia: boolean;
    retirada_el: string | null;
  }>(sql`
    select g.id, g.registrado_por = app.current_user_id() as propia,
           (select (d.retirada_at at time zone ${zona})::date::text from derivacion d where d.id = g.derivacion_id and d.retirada_at is not null) as retirada_el, (g.registrado_at at time zone ${zona})::text as registrado_at, g.fecha::text as fecha, g.autor_tipo,
           coalesce((select ud.nombre from usuario_demo ud where ud.user_id = g.registrado_por),
                    case when g.autor_tipo = 'estudio' then ea.nombre end) as quien,
           g.canal, g.resultado, g.nota, g.promesa_fecha::text as promesa_fecha, g.promesa_monto::text as promesa_monto,
           case when g.promesa_fecha is not null then
             ${pagadoParaPromesa("g.unidad_funcional_id", "g.fecha", "g.promesa_fecha")}::text
           end as pagado,
           g.adjunto_nombre, g.adjunto_tipo, a.motivo as anulacion_motivo, (a.anulada_at at time zone ${zona})::text as anulada_at
      from gestion g
      left join gestion_anulacion a on a.gestion_id = g.id
      left join estudio_administracion ea on ea.estudio_id = g.estudio_id and ea.administracion_id = ${f.administracion_id}
     where g.unidad_funcional_id = ${unidadId}
     order by g.registrado_at desc
  `);
  const gestionesVista: GestionDeLaFicha[] = gestiones.map((g) => {
    const promesa =
      g.promesa_fecha && g.promesa_monto && g.pagado !== null
        ? {
            fecha: g.promesa_fecha,
            monto: g.promesa_monto as Monto,
            pagado: g.pagado as Monto,
            estado: estadoPromesa({ monto: g.promesa_monto as Monto, pagado: g.pagado as Monto, fecha: g.promesa_fecha }, f.hoy),
          }
        : null;
    return {
      id: g.id,
      registradoAt: g.registrado_at,
      fecha: g.fecha,
      autor: g.autor_tipo,
      quien: g.quien,
      canal: g.canal,
      resultado: g.resultado,
      nota: g.nota,
      promesa,
      adjunto: g.adjunto_nombre && g.adjunto_tipo ? { nombre: g.adjunto_nombre, tipo: g.adjunto_tipo } : null,
      anulacion: g.anulacion_motivo && g.anulada_at ? { motivo: g.anulacion_motivo, at: g.anulada_at } : null,
      retiradaEl: g.retirada_el,
      anulable:
        f.puede_registrar &&
        (f.puede_retirar || g.propia) &&
        g.autor_tipo === "administracion" &&
        g.canal !== "derivacion" &&
        g.anulacion_motivo === null,
    };
  });

  return {
    barrio: { id: f.barrio_id, nombre: f.barrio },
    unidad: { id: unidadId, etiqueta: etiquetaUnidad(f.manzana, f.lote) },
    titular: titular[0] ?? null,
    hoy: f.hoy,
    meses: vencidos.length,
    periodosVencidos: vencidos.map((m) => m.periodo),
    capitalVencido: sumarMontos("0.00", ...vencidos.map((m) => m.capital)),
    interes: deuda ? sumarMontos(deuda.interesPendiente, deuda.interesNuevo) : "0.00",
    atraso,
    derivacionVigente: derivacionesVista.find((d) => d.retiro === null) ?? null,
    derivaciones: derivacionesVista,
    gestiones: gestionesVista,
    promesa: gestionesVista.find((g) => g.promesa !== null && g.anulacion === null)?.promesa ?? null,
    puedeRegistrar: f.puede_registrar,
    puedeRetirar: f.puede_retirar,
    promesaMaxima: sumarDias(f.hoy, PLAZO_MAXIMO_PROMESA_DIAS),
    cobraInteres: (
      await tx.execute<{ cobra: boolean }>(sql`
        select coalesce((select x.valor = 'true'::jsonb from app.parametro_resuelto(${f.barrio_id}::uuid, 'interes.cobra', ${f.hoy}::date) x), false) as cobra
      `)
    ).rows[0]?.cobra === true,
  };
}

/** El adjunto de una gestión, para descargarlo: la clave y el nombre (la RLS decide si se ve). */
export async function prepararDescargaDeAdjuntoDeGestion(
  tx: DbConIdentidad,
  parametros: { readonly gestionId: string },
): Promise<{ readonly storageKey: string; readonly nombreArchivo: string }> {
  const id = idSchema.safeParse(parametros.gestionId);
  if (!id.success) rechazar("referencia_inexistente", "Ese adjunto no existe o no tenés acceso.", "Volvé a la ficha de la unidad.");
  return enBase(async () => {
    const { rows } = await tx.execute<{ clave: string | null; nombre: string | null }>(sql`
      select adjunto_clave as clave, adjunto_nombre as nombre from gestion where id = ${id.data}
    `);
    const g = rows[0];
    if (!g?.clave || !g.nombre) rechazar("referencia_inexistente", "Ese adjunto no existe o no tenés acceso.", "Volvé a la ficha de la unidad.");
    // El nombre que ve la persona, sin caracteres que rompan el encabezado de la descarga, y con la
    // extensión de la clave (la lista cerrada), no la que haya tipeado quien subió (security-engineer).
    const extension = g.clave.slice(g.clave.lastIndexOf("."));
    const base = g.nombre.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N} _-]/gu, "_").slice(0, 100) || "adjunto";
    return { storageKey: g.clave, nombreArchivo: `${base}${extension}` };
  });
}
