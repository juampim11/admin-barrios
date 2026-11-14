/**
 * El padrón editable y el alta de barrio (T3, BL-009; ADR-0010).
 *
 * **Quién escribe.** Todas las operaciones de este archivo son de `admin_plataforma` y `admin_barrio`
 * (como los parámetros de T1). Las hace cumplir la base: cada operación escribe su `padron_evento` en
 * la misma transacción, y la RLS y el trigger de esa tabla solo dejan a esos dos roles (`0065`). El
 * `exigirAdministracion()` de acá adelanta el rechazo para que el mensaje sea claro.
 *
 * **Nada de esto toca una liquidación emitida.** Agregar o dar de baja una unidad cambia qué unidades
 * entran en la PRÓXIMA generación de un período no emitido; las emitidas son inmutables (`0030`). Por
 * eso los diálogos hablan del «próximo período» (`proximoPeriodo`).
 *
 * **La deuda es de la unidad.** Un cambio de titular cierra los titulares anteriores el día anterior y
 * abre el nuevo; la cuenta corriente (`saldo_uf`) no se mueve, y cada liquidación guarda a quién se le
 * emitió (`liquidacion.obligado_id`): quién era titular en cada período no se pierde nunca (condición
 * de `legal-ph`, ADR-0010 §4).
 */

import { sql } from "drizzle-orm";
import {
  agregarUnidadSchema,
  cambiarTitularSchema,
  crearBarrioSchema,
  darDeBajaSchema,
  editarUnidadSchema,
  nuevaVersionCoeficientesSchema,
  vencimientosDelBarrioSchema,
  MENSAJE_RESIDENTE_SIN_NOMBRE,
  type AgregarUnidad,
  type CambiarTitular,
  type CrearBarrio,
  type DarDeBaja,
  type EditarUnidad,
  type NuevaVersionCoeficientes,
  type Titular,
  type VencimientosDelBarrio,
} from "@admin-barrios/shared/escrituras";
import { consultaBarrioSchema, consultaUnidadSchema } from "@admin-barrios/shared/consultas";
import { fechaIsoSchema } from "@admin-barrios/shared/fechas";
import { sumarDias } from "@admin-barrios/shared/interes-mora";
import {
  etiquetaUnidad,
  sugerirDenominacionConcepto,
  type CaracterResidente,
  type EstadoUnidad,
  type TipoObligado,
} from "@admin-barrios/shared/barrio";
import { documentoLegible, nombresIguales, type Documento } from "@admin-barrios/shared/cuentas";
import { codigoDePago, type FormatoCodigoPago } from "@admin-barrios/shared/codigo-pago";
import { BASE_DE_FORMA, repartirCoeficientes, sumarCoeficientes, type FormaCoeficiente } from "@admin-barrios/shared/coeficientes";
import {
  filasParaExportar,
  leerPlanillaCoeficientes,
  leerPlanillaPadron,
  planDePadron,
  PlanillaInvalida,
  type DecisionPersona,
  type PersonaRegistrada,
  type PlanDePadron,
  type UnidadExistente,
} from "@admin-barrios/shared/padron";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";
import { condicionDeBusquedaDeUnidad } from "./busqueda-de-unidad.ts";
import { ORDEN_NATURAL_U, ordenNaturalDeUnidad } from "./orden-de-unidades.ts";

const ROLES_ADMIN = sql`array['admin_plataforma','admin_barrio']::app.rol_membership[]`;

/** `uuid[]` como un solo parámetro (Drizzle expande un arreglo JS en N parámetros). */
const uuids = (ids: readonly string[]) => sql`${sql.param([...ids])}::uuid[]`;
const textos = (t: readonly (string | null)[]) => sql`${sql.param([...t])}::text[]`;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Permisos y datos del barrio
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** ¿Puede este usuario modificar el padrón de este barrio? Para mostrar u ocultar los botones. */
export async function puedeEditarPadron(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<boolean> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);
  const { rows } = await tx.execute<{ puede: boolean }>(sql`select app.has_role_on(${barrioId}::uuid, ${ROLES_ADMIN}) as puede`);
  return rows[0]?.puede ?? false;
}

async function exigirAdministracion(
  tx: DbConIdentidad,
  barrioId: string,
  mensaje = "El padrón lo modifica la administración del barrio.",
): Promise<void> {
  if (!(await puedeEditarPadron(tx, { barrioId }))) {
    rechazar(
      "sin_permiso",
      mensaje,
      "Lo pueden hacer quienes tienen rol de administrador del barrio o de la plataforma. Con tu rol se ve, sin botones.",
    );
  }
}

const sumarMes = (periodo: string): string => {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
};

/** Lo que el padrón necesita saber del barrio para decidir qué mostrar. */
export type BarrioDelPadron = {
  readonly id: string;
  readonly nombre: string;
  readonly identificacionPago: "cuenta_unica" | "cuenta_por_unidad" | null;
  readonly cuentaPorUnidad: boolean;
  readonly cuentaCbu: string | null;
  readonly cuentaAlias: string | null;
  readonly recaudador: string | null;
  /** El modelo con el que liquida: el del alta, o el del último período si el barrio es de antes de T3. */
  readonly modelo: "fija" | "variable" | null;
  readonly formatoCodigoPago: FormatoCodigoPago;
  readonly hoy: string;
  /**
   * El período al que llega lo que se cambie hoy en el padrón: el borrador más viejo si hay uno (se
   * vuelve a generar), si no el mes siguiente al último emitido, si no el primer período del barrio.
   */
  readonly proximoPeriodo: string;
};

export async function leerBarrioDelPadron(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string },
): Promise<BarrioDelPadron | null> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);
  const f = (
    await tx.execute<{
      id: string;
      nombre: string;
      identificacion_pago: "cuenta_unica" | "cuenta_por_unidad" | null;
      cuenta_cbu: string | null;
      cuenta_alias: string | null;
      recaudador: string | null;
      modelo: "fija" | "variable" | null;
      largo: number;
      prefijo: string;
      separador: "-" | "";
      hoy: string;
      primer_periodo: string | null;
      ultimo_emitido: string | null;
      borrador: string | null;
    }>(sql`
      select b.barrio_id as id, n.nombre, b.identificacion_pago, b.cuenta_cbu, b.cuenta_alias, b.recaudador,
             coalesce(b.modelo_liquidacion::text,
                      (select p.modelo::text from periodo_expensa p where p.barrio_id = b.barrio_id order by p.periodo desc limit 1)) as modelo,
             b.codigo_pago_largo as largo, b.codigo_pago_prefijo as prefijo, b.codigo_pago_separador as separador,
             (now() at time zone b.zona_horaria)::date::text as hoy,
             b.primer_periodo,
             (select max(p.periodo) from periodo_expensa p where p.barrio_id = b.barrio_id and p.estado not in ('borrador', 'revisada')) as ultimo_emitido,
             (select min(p.periodo) from periodo_expensa p where p.barrio_id = b.barrio_id and p.estado in ('borrador', 'revisada')) as borrador
        from barrio b
        join tenant_node n on n.id = b.barrio_id
       where b.barrio_id = ${barrioId}
    `)
  ).rows[0];
  if (!f) return null;
  const candidatos = [
    f.borrador ?? (f.ultimo_emitido ? sumarMes(f.ultimo_emitido) : null) ?? f.primer_periodo ?? f.hoy.slice(0, 7),
    ...(f.primer_periodo ? [f.primer_periodo] : []),
    // Un borrador viejo, anterior a un período ya emitido, no es «el próximo»: lo que se cambia hoy
    // rige, como muy temprano, desde el mes siguiente al último emitido.
    ...(f.ultimo_emitido ? [sumarMes(f.ultimo_emitido)] : []),
  ];
  return {
    id: f.id,
    nombre: f.nombre,
    identificacionPago: f.identificacion_pago,
    cuentaPorUnidad: f.identificacion_pago === "cuenta_por_unidad",
    cuentaCbu: f.cuenta_cbu,
    cuentaAlias: f.cuenta_alias,
    recaudador: f.recaudador,
    modelo: f.modelo,
    formatoCodigoPago: { largo: f.largo, prefijo: f.prefijo, separador: f.separador },
    hoy: f.hoy,
    proximoPeriodo: candidatos.sort().at(-1)!,
  };
}

async function exigirBarrio(tx: DbConIdentidad, barrioId: string): Promise<BarrioDelPadron> {
  const b = await leerBarrioDelPadron(tx, { barrioId });
  if (!b) rechazar("referencia_inexistente", "El barrio no existe o no tenés acceso.", "Volvé a Mis barrios y entrá de nuevo.");
  return b;
}

async function registrarEvento(
  tx: DbConIdentidad,
  e: {
    barrioId: string;
    unidadId: string | null;
    tipo: string;
    vigenteDesde?: string | null;
    motivo?: string | null;
    detalle?: string | null;
    datos?: Record<string, unknown>;
    archivo?: string | null;
    respaldo?: { tipo: string | null; referencia: string | null; adjunto: string | null };
  },
): Promise<void> {
  await tx.execute(sql`
    insert into padron_evento (barrio_id, unidad_funcional_id, tipo, vigente_desde, motivo, detalle, datos, archivo,
                               respaldo_tipo, respaldo_referencia, respaldo_adjunto)
    values (${e.barrioId}, ${e.unidadId}, ${e.tipo}, ${e.vigenteDesde ?? null}, ${e.motivo ?? null}, ${e.detalle ?? null},
            ${JSON.stringify(e.datos ?? {})}::jsonb, ${e.archivo ?? null},
            ${e.respaldo?.tipo ?? null}, ${e.respaldo?.referencia ?? null}, ${e.respaldo?.adjunto ?? null})
  `);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Nuevo barrio
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Las administraciones donde el usuario puede crear un barrio (rol de administración sobre el nodo). */
export async function administracionesDondeCrear(tx: DbConIdentidad): Promise<readonly { id: string; nombre: string }[]> {
  const { rows } = await tx.execute<{ id: string; nombre: string }>(sql`
    select n.id, n.nombre from tenant_node n
     where n.tipo = 'administrador' and n.deleted_at is null and app.has_role_on(n.id, ${ROLES_ADMIN})
     order by n.nombre
  `);
  return rows;
}

/**
 * Crea el barrio: su nodo en la tenancía (colgado de la administración: los admin de la
 * administración lo ven por herencia, sin membresías nuevas), la ficha, el mandato desde la fecha que
 * se cargó (con el acta, si vino) y el evento del alta. La mora la hereda de la configuración general.
 */
export async function crearBarrio(tx: DbConIdentidad, parametros: CrearBarrio): Promise<{ readonly barrioId: string }> {
  const p = crearBarrioSchema.parse(parametros);
  return enBase(async () => {
    const puede = (
      await tx.execute<{ puede: boolean }>(sql`select app.has_role_on(${p.administradorId}::uuid, ${ROLES_ADMIN}) as puede`)
    ).rows[0]?.puede;
    if (!puede) {
      rechazar(
        "sin_permiso",
        "No podés crear barrios en esa administración.",
        "Crear un barrio es de quien administra la administración (admin_barrio o admin_plataforma sobre ella).",
      );
    }
    const nodo = (
      await tx.execute<{ id: string }>(sql`
        insert into tenant_node (tipo, nombre, parent_id) values ('barrio', ${p.nombre}, ${p.administradorId}) returning id
      `)
    ).rows[0]!;
    const denominacion = sugerirDenominacionConcepto(p.figuraJuridica)?.denominacion ?? null;
    await tx.execute(sql`
      insert into barrio (barrio_id, figura_juridica, adecuado_art_2075, encuadre_urbanistico, municipio,
                          servicios_internos_a_cargo_de, reglamento_inscripto, denominacion_concepto, cuit,
                          razon_social, dia_vencimiento, primer_periodo, modelo_liquidacion, identificacion_pago,
                          recaudador, cuenta_cbu, cuenta_alias, medio_cobranza_clave, codigo_pago_prefijo,
                          dias_segundo_vencimiento, dias_corte, representante_nombre, representante_caracter)
      values (${nodo.id}, ${p.figuraJuridica}, ${p.adecuadoArt2075}, ${p.encuadreUrbanistico}, ${p.municipio},
              ${p.serviciosInternos}, ${p.reglamentoInscripto === null ? null : p.reglamentoInscripto === "si"},
              ${denominacion}, ${p.cuit}, ${p.razonSocial}, ${p.diaVencimiento}, ${p.primerPeriodo}, ${p.modelo},
              ${p.identificacionPago}, ${p.recaudador}, ${p.cuentaCbu}, ${p.cuentaAlias}, ${p.medioCobranza},
              ${p.codigoPagoPrefijo}, ${p.diasSegundoVencimiento}, ${p.diasCorte},
              ${p.figuraJuridica === "sin_entidad" ? p.representanteNombre : null},
              ${p.figuraJuridica === "sin_entidad" ? p.representanteCaracter : null})
    `);
    let actaId: string | null = null;
    if (p.actaAdjunto !== null) {
      // El acta se subió con la administración como nodo (el barrio todavía no existía): tiene que
      // ser una subida pedida para ESA administración (panel `security-engineer`, M1).
      const subida = (
        await tx.execute<{ ok: boolean }>(sql`
          select exists (select 1 from subida_respaldo_solicitada
                          where storage_key = ${p.actaAdjunto} and nodo_id = ${p.administradorId}) as ok
        `)
      ).rows[0]?.ok;
      if (!subida) rechazar("dato_invalido", "El acta adjunta no es una subida de esta administración.", "Volvé a adjuntar el acta.");
      actaId = (
        await tx.execute<{ id: string }>(sql`
          insert into documento_barrio (barrio_id, tipo, titulo, storage_key, fecha_documento, subido_por)
          values (${nodo.id}, 'acta_designacion_administrador', 'Acta de designación', ${p.actaAdjunto},
                  ${p.mandatoDesde}, app.current_user_id())
          returning id
        `)
      ).rows[0]!.id;
    }
    await tx.execute(sql`
      insert into mandato_administracion (barrio_id, administrador_id, desde, acta_documento_id)
      values (${nodo.id}, ${p.administradorId}, ${p.mandatoDesde}, ${actaId})
    `);
    await registrarEvento(tx, {
      barrioId: nodo.id,
      unidadId: null,
      tipo: "alta_barrio",
      detalle: `Alta del barrio ${p.nombre}.`,
      datos: {
        pendientes: [
          ...(p.adecuadoArt2075 === null ? ["adecuado_art_2075"] : []),
          ...(p.encuadreUrbanistico === null ? ["encuadre_urbanistico"] : []),
          ...(p.serviciosInternos === null ? ["servicios_internos_a_cargo_de"] : []),
          ...(p.reglamentoInscripto === null ? ["reglamento_inscripto"] : []),
        ],
      },
    });
    return { barrioId: nodo.id };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Los vencimientos del barrio (encargo 15, `0078`)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cambia los vencimientos del barrio (Configuración, «Datos del barrio»): el día del primero, los días
 * hasta el segundo y los días de corte. **Rigen para los meses que se abran después**: los meses ya
 * abiertos conservan los suyos (se cambian en sus vencimientos hasta emitir) y los emitidos no se
 * tocan nunca. Lo hace la administración del barrio: lo adelanta `exigirAdministracion`, lo hace
 * cumplir el trigger `trg_barrio_vencimientos` y lo registra `padron_evento` (`configuracion_barrio`).
 */
export async function cambiarVencimientosDelBarrio(tx: DbConIdentidad, parametros: VencimientosDelBarrio): Promise<void> {
  const p = vencimientosDelBarrioSchema.parse(parametros);
  return enBase(async () => {
    await exigirAdministracion(tx, p.barrioId, "Los vencimientos del barrio los configura la administración del barrio.");
    const antes = (
      await tx.execute<{ dia: number | null; segundo: number | null; corte: number | null }>(sql`
        select dia_vencimiento as dia, dias_segundo_vencimiento as segundo, dias_corte as corte
          from barrio where barrio_id = ${p.barrioId} for update
      `)
    ).rows[0];
    if (!antes) rechazar("referencia_inexistente", "El barrio no existe o no tenés acceso.", "Volvé a Mis barrios y entrá de nuevo.");
    const cambios: string[] = [];
    const legible = (v: number | null) => (v === null ? "no usa" : `${v} días`);
    if (antes.dia !== p.diaVencimiento) cambios.push(`día del primer vencimiento ${antes.dia ?? "—"} → ${p.diaVencimiento}`);
    if (antes.segundo !== p.diasSegundoVencimiento) {
      cambios.push(`segundo vencimiento ${legible(antes.segundo)} → ${legible(p.diasSegundoVencimiento)}`);
    }
    if (antes.corte !== p.diasCorte) cambios.push(`corte ${legible(antes.corte)} → ${legible(p.diasCorte)}`);
    if (cambios.length === 0) return;
    await tx.execute(sql`
      update barrio
         set dia_vencimiento = ${p.diaVencimiento}, dias_segundo_vencimiento = ${p.diasSegundoVencimiento}, dias_corte = ${p.diasCorte}
       where barrio_id = ${p.barrioId}
    `);
    await registrarEvento(tx, {
      barrioId: p.barrioId,
      unidadId: null,
      tipo: "configuracion_barrio",
      detalle: `Vencimientos del barrio: ${cambios.join(", ")}.`,
      datos: { antes, despues: { dia: p.diaVencimiento, segundo: p.diasSegundoVencimiento, corte: p.diasCorte } },
    });
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Titulares
// ────────────────────────────────────────────────────────────────────────────────────────────────

const esPersonaJuridica = (d: Documento | null) => d?.tipo === "cuit" && ["30", "33", "34"].includes(d.numero.slice(0, 2));

/**
 * La persona del barrio para un titular: la que ya está registrada con ese documento (si el nombre es
 * el mismo, o si se confirmó que es la misma), o una nueva. Un documento registrado con otro nombre
 * sin confirmar se rechaza con `titular_ya_registrado`, que la pantalla convierte en una pregunta.
 */
async function asegurarPersona(tx: DbConIdentidad, barrioId: string, t: Titular, confirmado: boolean): Promise<string> {
  if (t.documento) {
    const registrada = (
      await tx.execute<{ id: string; nombre: string }>(
        t.documento.tipo === "cuit"
          ? sql`select id, nombre from obligado where barrio_id = ${barrioId} and cuit_cuil = ${t.documento.numero}`
          : sql`select id, nombre from obligado where barrio_id = ${barrioId} and tipo_documento = 'DNI'
                  and numero_documento = ${t.documento.numero} order by created_at, id limit 1`,
      )
    ).rows[0];
    if (registrada) {
      if (!nombresIguales(registrada.nombre, t.nombre) && !confirmado) {
        rechazar(
          "titular_ya_registrado",
          `${documentoLegible(t.documento)} ya es de ${registrada.nombre} en este barrio; acá dice ${t.nombre}.`,
          "Si es la misma persona, confirmalo y se usa la registrada (con su nombre). Si no, corregí el documento.",
          { registrado: registrada.nombre, documento: documentoLegible(t.documento) },
        );
      }
      if (t.mail || t.telefono) {
        await tx.execute(sql`
          update obligado set email = coalesce(email, ${t.mail}), telefono = coalesce(telefono, ${t.telefono}) where id = ${registrada.id}
        `);
      }
      return registrada.id;
    }
  }
  return (
    await tx.execute<{ id: string }>(sql`
      insert into obligado (barrio_id, nombre, es_persona_juridica, tipo_documento, numero_documento, cuit_cuil, email, telefono)
      values (${barrioId}, ${t.nombre}, ${esPersonaJuridica(t.documento)},
              ${t.documento ? (t.documento.tipo === "cuit" ? "CUIT" : "DNI") : null}, ${t.documento?.numero ?? null},
              ${t.documento?.tipo === "cuit" ? t.documento.numero : null}, ${t.mail}, ${t.telefono})
      returning id
    `)
  ).rows[0]!.id;
}

async function vincularTitular(
  tx: DbConIdentidad,
  v: { barrioId: string; unidadId: string; obligadoId: string; caracter: TipoObligado; desde: string; recibe: boolean; nombre: string; mail: string | null },
): Promise<void> {
  await tx.execute(sql`
    insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
    values (${v.barrioId}, ${v.unidadId}, ${v.obligadoId}, ${v.caracter}, ${v.desde}, ${v.recibe})
  `);
  if (v.mail) {
    await tx.execute(sql`
      insert into unidad_contacto (barrio_id, unidad_funcional_id, email, nombre, principal)
      values (${v.barrioId}, ${v.unidadId}, ${v.mail}, ${v.nombre}, ${v.recibe})
      on conflict do nothing
    `);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Coeficientes: la versión que rige desde un período
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Crea y cierra una versión de coeficientes que rige desde `rigeDesde` (YYYY-MM). La anterior abierta
 * hacia adelante queda cerrada en esa fecha. Reglas (ADR-0010 §5):
 *   - no puede regir desde un período ya emitido (lo emitido no se toca);
 *   - no puede regir antes que la vigente (no se reemplaza hacia atrás);
 *   - suma 1 exacto, sin ceros (`repartirCoeficientes`).
 */
async function escribirVersion(
  tx: DbConIdentidad,
  v: {
    barrioId: string;
    rigeDesde: string;
    base: "superficie" | "lote" | "parte_indivisa" | "partes_iguales";
    descripcion: string;
    valores: readonly { unidadFuncionalId: string; valor: string }[];
    documentoId: string | null;
  },
): Promise<string> {
  const desde = `${v.rigeDesde}-01`;
  const choque = (
    await tx.execute<{ emitido: string | null; posterior: string | null }>(sql`
      select (select max(p.periodo) from periodo_expensa p
               where p.barrio_id = ${v.barrioId} and p.estado not in ('borrador', 'revisada') and p.periodo >= ${v.rigeDesde}) as emitido,
             (select max(cv.vigente_desde)::text from coeficiente_version cv
               where cv.barrio_id = ${v.barrioId} and cv.cerrada and cv.vigente_desde > ${desde}::date) as posterior
    `)
  ).rows[0];
  if (choque?.emitido) {
    rechazar(
      "coeficientes_superpuestos",
      `El período ${choque.emitido} ya se emitió: una versión nueva no puede regir desde ${v.rigeDesde}.`,
      "Elegí un período que todavía no se haya emitido. Lo emitido no se recalcula.",
    );
  }
  if (choque?.posterior) {
    rechazar(
      "coeficientes_superpuestos",
      `Ya hay una versión que rige desde ${choque.posterior.slice(0, 7)}, después de ${v.rigeDesde}.`,
      "Una versión no reemplaza a otra hacia atrás. Elegí ese período o uno posterior.",
    );
  }
  await tx.execute(sql`
    update coeficiente_version set vigente_hasta = ${desde}::date
     where barrio_id = ${v.barrioId} and cerrada and vigente_hasta is null
  `);
  const id = (
    await tx.execute<{ id: string }>(sql`
      insert into coeficiente_version (barrio_id, base, descripcion, vigente_desde, documento_id)
      values (${v.barrioId}, ${v.base}, ${v.descripcion}, ${desde}::date, ${v.documentoId}) returning id
    `)
  ).rows[0]!.id;
  await tx.execute(sql`
    insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor)
    select ${v.barrioId}, ${id}, u, c::numeric
      from unnest(${uuids(v.valores.map((x) => x.unidadFuncionalId))}, ${textos(v.valores.map((x) => x.valor))}) as x(u, c)
  `);
  await tx.execute(sql`update coeficiente_version set cerrada = true, cerrada_por = app.current_user_id() where id = ${id}`);
  return id;
}

/** Las unidades activas del barrio, en el orden de la boleta (manzana y lote como número cuando lo son). */
async function unidadesActivasOrdenadas(
  tx: DbConIdentidad,
  barrioId: string,
): Promise<{ id: string; manzana: string; lote: string; superficie: string | null }[]> {
  return (
    await tx.execute<{ id: string; manzana: string; lote: string; superficie: string | null }>(sql`
      select id, manzana, lote, superficie_m2::text as superficie from unidad_funcional
       where barrio_id = ${barrioId} and baja_at is null
       order by ${ordenNaturalDeUnidad(sql`manzana`, sql`lote`)}, id
    `)
  ).rows;
}

/**
 * En un barrio de **cuota fija**, el coeficiente es «partes iguales» (lo usan las extraordinarias): al
 * agregar unidades se arma solo una versión nueva con todas las activas, que rige desde el próximo
 * período. En un barrio por coeficiente NO se inventa nada: la pantalla de coeficientes avisa y la
 * generación del período se frena hasta que una versión las incluya.
 */
async function asegurarPartesIguales(tx: DbConIdentidad, barrio: BarrioDelPadron): Promise<void> {
  const vigente = (
    await tx.execute<{ base: string }>(sql`
      select base::text from coeficiente_version where barrio_id = ${barrio.id} and cerrada and vigente_hasta is null
    `)
  ).rows[0];
  const esPartesIguales = vigente ? vigente.base === "partes_iguales" : barrio.modelo === "fija";
  if (!esPartesIguales) return;
  const activas = await unidadesActivasOrdenadas(tx, barrio.id);
  if (activas.length === 0) return;
  const faltan = (
    await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from unidad_funcional u
       where u.barrio_id = ${barrio.id} and u.baja_at is null
         and not exists (select 1 from coeficiente c join coeficiente_version cv on cv.id = c.version_id
                          where cv.barrio_id = ${barrio.id} and cv.cerrada and cv.vigente_hasta is null and c.unidad_funcional_id = u.id)
    `)
  ).rows[0]!.n;
  if (faltan === 0) return;
  // Si ya hay una versión programada más adelante, la nueva rige desde ahí (no la reemplaza hacia atrás).
  const posterior = (
    await tx.execute<{ desde: string | null }>(sql`
      select to_char(max(vigente_desde), 'YYYY-MM') as desde from coeficiente_version where barrio_id = ${barrio.id} and cerrada
    `)
  ).rows[0]?.desde;
  const rigeDesde = posterior && posterior > barrio.proximoPeriodo ? posterior : barrio.proximoPeriodo;
  await escribirVersion(tx, {
    barrioId: barrio.id,
    rigeDesde,
    base: "partes_iguales",
    descripcion: "Partes iguales: un lote, una cuota (se arma sola al agregar unidades)",
    valores: activas.map((u) => ({ unidadFuncionalId: u.id, valor: "1" })),
    documentoId: null,
  });
  await registrarEvento(tx, {
    barrioId: barrio.id,
    unidadId: null,
    tipo: "version_coeficientes",
    vigenteDesde: `${rigeDesde}-01`,
    detalle: `Partes iguales desde ${rigeDesde}: ${activas.length} unidades (se arma sola al agregar unidades a un barrio de cuota fija).`,
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Agregar, editar, cambiar titular, dar de baja
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type UnidadAgregada = { readonly unidadFuncionalId: string; readonly codigoPago: string; readonly proximoPeriodo: string };

/** Agregar una unidad con sus titulares (rigen desde hoy). El código de pago lo asigna la base. */
export async function agregarUnidad(tx: DbConIdentidad, parametros: AgregarUnidad): Promise<UnidadAgregada> {
  const p = agregarUnidadSchema.parse(parametros);
  return enBase(async () => {
    await exigirAdministracion(tx, p.barrioId);
    const barrio = await exigirBarrio(tx, p.barrioId);
    if (!barrio.cuentaPorUnidad && (p.cbu !== null || p.alias !== null)) {
      rechazar("dato_invalido", "Este barrio cobra con una cuenta para todo el barrio.", "La cuenta por unidad no se carga: dejá vacíos el CBU y el alias.");
    }
    const uf = (
      await tx.execute<{ id: string; numero: number }>(sql`
        insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, superficie_m2, nomenclatura_catastral, cbu, alias, saldo_inicial,
                                      numero_accion, residente_nombre, residente_caracter, residente_telefono, residente_email)
        values (${p.barrioId}, ${p.manzana}, ${p.lote}, ${p.estado}, ${p.superficie}::numeric, ${p.nomenclatura},
                ${p.cbu}, ${p.alias}, ${p.saldoInicial ?? "0.00"}::numeric,
                ${p.numeroAccion}, ${p.residenteNombre}, ${p.residenteCaracter}, ${p.residenteTelefono}, ${p.residenteMail})
        returning id, codigo_pago_numero::int as numero
      `)
    ).rows[0]!;
    for (const [i, t] of p.titulares.entries()) {
      const obligadoId = await asegurarPersona(tx, p.barrioId, t, p.confirmarTitularRegistrado === true);
      await vincularTitular(tx, {
        barrioId: p.barrioId,
        unidadId: uf.id,
        obligadoId,
        caracter: t.caracter,
        desde: barrio.hoy,
        recibe: i === p.recibeBoleta,
        nombre: t.nombre,
        mail: t.mail,
      });
    }
    await registrarEvento(tx, {
      barrioId: p.barrioId,
      unidadId: uf.id,
      tipo: "alta",
      detalle: `Alta de ${etiquetaUnidad(p.manzana, p.lote)}${p.titulares.length > 0 ? ` con ${p.titulares.map((t) => t.nombre).join(" y ")}` : ""}.`,
      datos: {
        saldoInicial: p.saldoInicial ?? "0.00",
        titulares: p.titulares.length,
        numeroAccion: p.numeroAccion,
        // El residente se registra como hecho (que se cargó), sin sus datos de contacto.
        conResidente: p.residenteNombre !== null,
      },
    });
    await asegurarPartesIguales(tx, barrio);
    return {
      unidadFuncionalId: uf.id,
      codigoPago: codigoDePago(uf.numero, barrio.formatoCodigoPago),
      proximoPeriodo: barrio.proximoPeriodo,
    };
  });
}

type FilaUnidad = {
  id: string;
  barrio_id: string;
  manzana: string;
  lote: string;
  estado: EstadoUnidad;
  superficie: string | null;
  nomenclatura: string | null;
  cbu: string | null;
  alias: string | null;
  saldo_inicial: string;
  baja: boolean;
  numero_accion: string | null;
  residente_nombre: string | null;
  residente_caracter: string | null;
  residente_telefono: string | null;
  residente_email: string | null;
};

async function leerUnidad(tx: DbConIdentidad, unidadFuncionalId: string): Promise<FilaUnidad> {
  const u = (
    await tx.execute<FilaUnidad>(sql`
      select id, barrio_id, manzana, lote, estado_unidad::text as estado, superficie_m2::text as superficie,
             nomenclatura_catastral as nomenclatura, cbu, alias, saldo_inicial::text, baja_at is not null as baja,
             numero_accion, residente_nombre, residente_caracter, residente_telefono, residente_email
        from unidad_funcional where id = ${unidadFuncionalId}
    `)
  ).rows[0];
  if (!u) rechazar("referencia_inexistente", "La unidad no existe o no tenés acceso.", "Volvé al padrón y entrá de nuevo.");
  return u;
}

/** Editar la unidad sin tocar manzana ni lote. */
export async function editarUnidad(tx: DbConIdentidad, parametros: EditarUnidad): Promise<void> {
  const p = editarUnidadSchema.parse(parametros);
  return enBase(async () => {
    const u = await leerUnidad(tx, p.unidadFuncionalId);
    await exigirAdministracion(tx, u.barrio_id);
    if (u.baja) rechazar("unidad_dada_de_baja", "La unidad está dada de baja: no se edita.", "Su historia y su deuda se ven en la ficha y en Cobros.");
    const barrio = await exigirBarrio(tx, u.barrio_id);
    if (!barrio.cuentaPorUnidad && (p.cbu !== null || p.alias !== null)) {
      rechazar("dato_invalido", "Este barrio cobra con una cuenta para todo el barrio.", "La cuenta por unidad no se carga: dejá vacíos el CBU y el alias.");
    }
    // Sin el campo (no editable, o no se tocó), el saldo inicial queda como estaba.
    const saldo = p.saldoInicial ?? u.saldo_inicial;
    // Comparar números como números: «600» y «600.00» son la misma superficie (revisión, hallazgo 12).
    const dos = (v: string | null) => (v === null ? null : `${v.split(".")[0]!.replace(/^0+(?=\d)/, "")}.${(v.split(".")[1] ?? "").padEnd(2, "0")}`);
    const cambios: string[] = [];
    if (dos(p.superficie ?? null) !== dos(u.superficie)) cambios.push(`superficie ${u.superficie ?? "—"} → ${p.superficie ?? "—"}`);
    if (p.estado !== u.estado) cambios.push(`estado ${u.estado} → ${p.estado}`);
    if (p.nomenclatura !== u.nomenclatura) cambios.push("nomenclatura");
    if (p.cbu !== u.cbu || (p.alias ?? null) !== u.alias) cambios.push("cuenta de la unidad");
    if (dos(saldo) !== dos(u.saldo_inicial)) cambios.push(`saldo inicial ${u.saldo_inicial} → ${saldo}`);
    // Número de acción y residente (`0078`): lo que no vino queda como estaba (`siViene` del esquema).
    const numeroAccion = p.numeroAccion === undefined ? u.numero_accion : p.numeroAccion;
    const residente = {
      nombre: p.residenteNombre === undefined ? u.residente_nombre : p.residenteNombre,
      caracter: p.residenteCaracter === undefined ? u.residente_caracter : p.residenteCaracter,
      telefono: p.residenteTelefono === undefined ? u.residente_telefono : p.residenteTelefono,
      mail: p.residenteMail === undefined ? u.residente_email : p.residenteMail,
    };
    if (residente.nombre === null && (residente.caracter !== null || residente.telefono !== null || residente.mail !== null)) {
      rechazar("dato_invalido", MENSAJE_RESIDENTE_SIN_NOMBRE, "Completá el nombre del residente, o borrá también sus otros datos.");
    }
    if (numeroAccion !== u.numero_accion) cambios.push(`número de acción ${u.numero_accion ?? "—"} → ${numeroAccion ?? "—"}`);
    // El residente va al historial sin sus datos de contacto: qué cambió, no el teléfono ni el mail.
    if (
      residente.nombre !== u.residente_nombre ||
      residente.caracter !== u.residente_caracter ||
      residente.telefono !== u.residente_telefono ||
      residente.mail !== u.residente_email
    ) {
      cambios.push(residente.nombre === null && u.residente_nombre !== null ? "residente quitado" : "residente o inquilino");
    }
    await tx.execute(sql`
      update unidad_funcional
         set superficie_m2 = ${p.superficie}::numeric, estado_unidad = ${p.estado}, nomenclatura_catastral = ${p.nomenclatura},
             cbu = ${p.cbu}, alias = ${p.alias}, saldo_inicial = ${saldo}::numeric,
             numero_accion = ${numeroAccion}, residente_nombre = ${residente.nombre}, residente_caracter = ${residente.caracter},
             residente_telefono = ${residente.telefono}, residente_email = ${residente.mail}
       where id = ${u.id}
    `);
    if (p.mailPrincipal !== null) {
      const notificado = (
        await tx.execute<{ obligado_id: string; email: string | null; nombre: string }>(sql`
          select uo.obligado_id, o.email, o.nombre from unidad_obligado uo join obligado o on o.id = uo.obligado_id
           where uo.unidad_funcional_id = ${u.id} and uo.hasta is null and uo.es_notificado
        `)
      ).rows[0];
      if (!notificado) {
        rechazar(
          "dato_invalido",
          "La unidad no tiene a nadie que reciba la boleta: no hay un mail principal que cambiar.",
          "Cargá primero el titular (o cambiá el titular) y después su mail.",
        );
      }
      if (notificado.email !== p.mailPrincipal) {
        cambios.push("mail principal");
        await tx.execute(sql`update obligado set email = ${p.mailPrincipal} where id = ${notificado.obligado_id}`);
        await tx.execute(sql`update unidad_contacto set principal = false where unidad_funcional_id = ${u.id} and principal`);
        await tx.execute(sql`
          insert into unidad_contacto (barrio_id, unidad_funcional_id, email, nombre, principal)
          values (${u.barrio_id}, ${u.id}, ${p.mailPrincipal}, ${notificado.nombre}, true)
          on conflict (unidad_funcional_id, lower(email)) do update set principal = true, activo = true
        `);
      }
    }
    if (cambios.length > 0) {
      await registrarEvento(tx, { barrioId: u.barrio_id, unidadId: u.id, tipo: "edicion", detalle: `Edición: ${cambios.join(", ")}.` });
    }
  });
}

export type TitularCambiado = { readonly deuda: string; readonly cerrados: number };

/**
 * Cambiar titular: los titulares vigentes cierran el día anterior a `desde`, el nuevo rige desde esa
 * fecha y recibe la boleta. **La deuda sigue con la unidad**: la cuenta corriente no se mueve. La
 * fecha no puede ser futura (los titulares vigentes son los de `hasta is null`: un cambio programado
 * cambiaría hoy a quién se le emite) ni anterior o igual al inicio de los actuales.
 */
export async function cambiarTitular(tx: DbConIdentidad, parametros: CambiarTitular): Promise<TitularCambiado> {
  const p = cambiarTitularSchema.parse(parametros);
  return enBase(async () => {
    const u = await leerUnidad(tx, p.unidadFuncionalId);
    await exigirAdministracion(tx, u.barrio_id);
    if (u.baja) rechazar("unidad_dada_de_baja", "La unidad está dada de baja: no se le cambia el titular.", "Su historia y su deuda se ven en la ficha.");
    const barrio = await exigirBarrio(tx, u.barrio_id);
    if (p.desde > barrio.hoy) {
      rechazar("fecha_de_titular_invalida", "La fecha del cambio no puede ser futura.", "Registrá el cambio el día que rige (o después, con la fecha en que rigió).");
    }
    const actuales = (
      await tx.execute<{ id: string; nombre: string; desde: string }>(sql`
        select uo.id, o.nombre, uo.desde::text from unidad_obligado uo join obligado o on o.id = uo.obligado_id
         where uo.unidad_funcional_id = ${u.id} and uo.hasta is null
      `)
    ).rows;
    const ultimo = actuales.map((a) => a.desde).sort().at(-1);
    // Con «Corrección de datos» el cambio puede ser el mismo día que el inicio de los actuales (un
    // titular cargado mal hoy se corrige hoy): los anteriores cierran ese mismo día.
    const correccion = p.motivo === "correccion";
    if (ultimo && (correccion ? p.desde < ultimo : p.desde <= ultimo)) {
      rechazar(
        "fecha_de_titular_invalida",
        `Los titulares actuales rigen desde ${ultimo}: el cambio tiene que ser posterior.`,
        "Revisá la fecha del cambio (escritura, boleto o declaratoria).",
      );
    }
    const deuda =
      (await tx.execute<{ saldo: string }>(sql`select saldo_actual::text as saldo from saldo_uf where unidad_funcional_id = ${u.id}`)).rows[0]?.saldo ??
      "0.00";
    await tx.execute(sql`
      update unidad_obligado set hasta = greatest(${p.desde}::date - 1, desde) where unidad_funcional_id = ${u.id} and hasta is null
    `);
    await tx.execute(sql`update unidad_contacto set principal = false, activo = false where unidad_funcional_id = ${u.id} and activo`);
    const obligadoId = await asegurarPersona(tx, u.barrio_id, p.titular, p.confirmarTitularRegistrado === true);
    await vincularTitular(tx, {
      barrioId: u.barrio_id,
      unidadId: u.id,
      obligadoId,
      caracter: p.titular.caracter,
      desde: p.desde,
      recibe: true,
      nombre: p.titular.nombre,
      mail: p.titular.mail,
    });
    if (p.titular.mail) {
      await tx.execute(sql`
        update unidad_contacto set principal = true, activo = true where unidad_funcional_id = ${u.id} and lower(email) = ${p.titular.mail}
      `);
    }
    await registrarEvento(tx, {
      barrioId: u.barrio_id,
      unidadId: u.id,
      tipo: "cambio_titular",
      vigenteDesde: p.desde,
      motivo: p.motivo,
      detalle: p.detalle,
      datos: { anteriores: actuales.map((a) => a.nombre), nuevo: p.titular.nombre, deudaAlCambio: deuda },
      respaldo: { tipo: p.respaldoTipo, referencia: p.respaldoReferencia, adjunto: p.respaldoAdjunto },
    });
    return { deuda, cerrados: actuales.length };
  });
}

/**
 * Dar de baja: deja de entrar en la generación de los períodos no emitidos (no recibe boleta desde el
 * próximo período), conserva su historia, sus pagos y su deuda (que se sigue pudiendo cobrar), y su
 * código de pago no se reutiliza (la secuencia de `0059` nunca retrocede).
 */
export async function darDeBaja(tx: DbConIdentidad, parametros: DarDeBaja): Promise<{ readonly sinBoletaDesde: string }> {
  const p = darDeBajaSchema.parse(parametros);
  return enBase(async () => {
    const u = await leerUnidad(tx, p.unidadFuncionalId);
    await exigirAdministracion(tx, u.barrio_id);
    if (u.baja) rechazar("unidad_dada_de_baja", "La unidad ya está dada de baja.", "Su historia y su deuda se ven en la ficha.");
    const barrio = await exigirBarrio(tx, u.barrio_id);
    await tx.execute(sql`
      update unidad_funcional set baja_at = now(), baja_motivo = ${p.motivo}, baja_detalle = ${p.detalle}, baja_por = app.current_user_id()
       where id = ${u.id}
    `);
    await registrarEvento(tx, {
      barrioId: u.barrio_id,
      unidadId: u.id,
      tipo: "baja",
      motivo: p.motivo,
      detalle: p.detalle,
      datos: { sinBoletaDesde: barrio.proximoPeriodo },
    });
    return { sinBoletaDesde: barrio.proximoPeriodo };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La grilla del padrón (pantalla 3)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export const FILTROS_PADRON = ["todas", "sin_titular", "sin_mail", "sin_cuenta", "bajas"] as const;
export type FiltroPadron = (typeof FILTROS_PADRON)[number];

export type FilaDelPadron = {
  readonly id: string;
  readonly etiqueta: string;
  readonly codigoPago: string;
  /** Número de acción (`0078`), si el barrio lo usa. */
  readonly numeroAccion: string | null;
  readonly titulares: readonly { readonly nombre: string; readonly documento: string | null }[];
  readonly estado: EstadoUnidad;
  readonly superficie: string | null;
  readonly mails: readonly string[];
  readonly tieneCuentaPropia: boolean;
  readonly dadaDeBaja: boolean;
};

export type IndicadoresDelPadron = {
  readonly activas: number;
  readonly bajas: number;
  readonly sinTitular: number;
  readonly sinMail: number;
  /** Activas sin cuenta propia: solo tiene sentido con «una cuenta por unidad». */
  readonly sinCuenta: number;
};

export type PadronEditable = {
  readonly filas: readonly FilaDelPadron[];
  readonly total: number;
  readonly indicadores: IndicadoresDelPadron;
};

/**
 * La grilla del padrón con sus filtros («Sin titular», «Sin mail», «Sin cuenta propia», «Dadas de
 * baja») y la búsqueda por manzana, lote, titular, CUIT o código de pago. «Todas» son las activas: las
 * dadas de baja tienen su filtro (siguen en el padrón con su historia y su deuda).
 */
export async function listarPadronEditable(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string; readonly filtro: FiltroPadron; readonly busqueda: string; readonly limite: number; readonly desplazamiento: number },
): Promise<PadronEditable> {
  const { barrioId } = consultaBarrioSchema.parse({ barrioId: parametros.barrioId });
  const barrio = await exigirBarrio(tx, barrioId);
  const limite = Math.min(Math.max(1, Math.trunc(parametros.limite)), 500);
  const desplazamiento = Math.max(0, Math.trunc(parametros.desplazamiento));
  const condiciones = sql`u.barrio_id = ${barrioId}`;
  const filtro = {
    todas: sql` and u.baja_at is null`,
    bajas: sql` and u.baja_at is not null`,
    sin_titular: sql` and u.baja_at is null and not exists (select 1 from unidad_obligado uo where uo.unidad_funcional_id = u.id and uo.hasta is null)`,
    sin_mail: sql` and u.baja_at is null and not exists (select 1 from unidad_contacto c where c.unidad_funcional_id = u.id and c.activo)`,
    sin_cuenta: sql` and u.baja_at is null and u.cbu is null and u.alias is null`,
  }[parametros.filtro];
  // La misma búsqueda que la grilla de Cobros: vive en un solo lugar (`busqueda-de-unidad.ts`).
  const textoBusqueda = condicionDeBusquedaDeUnidad(parametros.busqueda);

  const total = (
    await tx.execute<{ n: number }>(sql`select count(*)::int as n from unidad_funcional u where ${condiciones}${filtro}${textoBusqueda}`)
  ).rows[0]!.n;
  const filas = (
    await tx.execute<{
      id: string;
      manzana: string;
      lote: string;
      numero: number;
      estado: EstadoUnidad;
      superficie: string | null;
      cuenta: boolean;
      baja: boolean;
      numero_accion: string | null;
    }>(sql`
      select u.id, u.manzana, u.lote, u.codigo_pago_numero::int as numero, u.estado_unidad::text as estado, u.numero_accion,
             u.superficie_m2::text as superficie, (u.cbu is not null or u.alias is not null) as cuenta, u.baja_at is not null as baja
        from unidad_funcional u
       where ${condiciones}${filtro}${textoBusqueda}
       order by ${ORDEN_NATURAL_U}, u.id
       limit ${limite} offset ${desplazamiento}
    `)
  ).rows;
  const ids = filas.map((f) => f.id);
  const titulares =
    ids.length === 0
      ? []
      : (
          await tx.execute<{ unidad_funcional_id: string; nombre: string; cuit_cuil: string | null; numero_documento: string | null }>(sql`
            select uo.unidad_funcional_id, o.nombre, o.cuit_cuil, o.numero_documento
              from unidad_obligado uo join obligado o on o.id = uo.obligado_id
             where uo.unidad_funcional_id = any(${uuids(ids)}) and uo.hasta is null
             order by uo.es_notificado desc, uo.desde, o.nombre
          `)
        ).rows;
  const mails =
    ids.length === 0
      ? []
      : (
          await tx.execute<{ unidad_funcional_id: string; email: string }>(sql`
            select unidad_funcional_id, email from unidad_contacto
             where unidad_funcional_id = any(${uuids(ids)}) and activo order by principal desc, email
          `)
        ).rows;
  const indicadores = (
    await tx.execute<{ activas: number; bajas: number; sin_titular: number; sin_mail: number; sin_cuenta: number }>(sql`
      select count(*) filter (where u.baja_at is null)::int as activas,
             count(*) filter (where u.baja_at is not null)::int as bajas,
             count(*) filter (where u.baja_at is null and not exists (
               select 1 from unidad_obligado uo where uo.unidad_funcional_id = u.id and uo.hasta is null))::int as sin_titular,
             count(*) filter (where u.baja_at is null and not exists (
               select 1 from unidad_contacto c where c.unidad_funcional_id = u.id and c.activo))::int as sin_mail,
             count(*) filter (where u.baja_at is null and u.cbu is null and u.alias is null)::int as sin_cuenta
        from unidad_funcional u where u.barrio_id = ${barrioId}
    `)
  ).rows[0]!;

  return {
    total,
    indicadores: {
      activas: indicadores.activas,
      bajas: indicadores.bajas,
      sinTitular: indicadores.sin_titular,
      sinMail: indicadores.sin_mail,
      sinCuenta: barrio.cuentaPorUnidad ? indicadores.sin_cuenta : 0,
    },
    filas: filas.map((f) => ({
      id: f.id,
      etiqueta: etiquetaUnidad(f.manzana, f.lote),
      codigoPago: codigoDePago(f.numero, barrio.formatoCodigoPago),
      numeroAccion: f.numero_accion,
      titulares: titulares
        .filter((t) => t.unidad_funcional_id === f.id)
        .map((t) => ({
          nombre: t.nombre,
          documento: t.cuit_cuil ? documentoLegible({ tipo: "cuit", numero: t.cuit_cuil }) : t.numero_documento ? `DNI ${t.numero_documento}` : null,
        })),
      estado: f.estado,
      superficie: f.superficie,
      mails: mails.filter((m) => m.unidad_funcional_id === f.id).map((m) => m.email),
      tieneCuentaPropia: f.cuenta,
      dadaDeBaja: f.baja,
    })),
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Ficha de la unidad
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type TitularDeFicha = {
  readonly obligadoId: string;
  readonly nombre: string;
  readonly documento: string | null;
  readonly caracter: TipoObligado;
  readonly desde: string;
  readonly hasta: string | null;
  readonly recibeBoleta: boolean;
  readonly email: string | null;
  readonly telefono: string | null;
};

export type EventoDeFicha = {
  readonly fecha: string;
  readonly tipo: string;
  readonly detalle: string;
  readonly motivo: string | null;
  readonly vigenteDesde: string | null;
  readonly archivo: string | null;
  /** Con qué rol se hizo (lo fija la base): `admin_barrio` o `admin_plataforma`. */
  readonly rol: string;
  readonly respaldo: string | null;
};

export type FichaDeUnidad = {
  readonly id: string;
  readonly barrioId: string;
  readonly manzana: string;
  readonly lote: string;
  readonly etiqueta: string;
  readonly codigoPago: string;
  readonly estado: EstadoUnidad;
  readonly superficie: string | null;
  readonly nomenclatura: string | null;
  readonly cbu: string | null;
  readonly alias: string | null;
  readonly saldoInicial: string;
  readonly saldoInicialEditable: boolean;
  /** Número de acción (`0078`). */
  readonly numeroAccion: string | null;
  /**
   * Residente o inquilino, **solo informativo** (`0078`): la boleta, el envío y la deuda van siempre
   * al propietario. `null` si no hay ninguno cargado.
   */
  readonly residente: {
    readonly nombre: string;
    readonly caracter: CaracterResidente | null;
    readonly telefono: string | null;
    readonly mail: string | null;
  } | null;
  readonly altaAt: string;
  readonly baja: { readonly at: string; readonly motivo: string | null; readonly detalle: string | null } | null;
  readonly deuda: string;
  readonly titulares: readonly TitularDeFicha[];
  readonly anteriores: readonly TitularDeFicha[];
  readonly contactos: readonly { readonly email: string; readonly nombre: string | null; readonly principal: boolean }[];
  readonly historial: readonly EventoDeFicha[];
};

export async function fichaDeUnidad(tx: DbConIdentidad, parametros: { readonly unidadFuncionalId: string }): Promise<FichaDeUnidad | null> {
  const { unidadFuncionalId } = consultaUnidadSchema.parse(parametros);
  const u = (
    await tx.execute<{
      id: string;
      barrio_id: string;
      manzana: string;
      lote: string;
      numero: number;
      largo: number;
      prefijo: string;
      separador: "-" | "";
      estado: EstadoUnidad;
      superficie: string | null;
      nomenclatura: string | null;
      cbu: string | null;
      alias: string | null;
      saldo_inicial: string;
      editable: boolean;
      alta_at: string;
      baja_at: string | null;
      baja_motivo: string | null;
      baja_detalle: string | null;
      deuda: string | null;
      numero_accion: string | null;
      residente_nombre: string | null;
      residente_caracter: CaracterResidente | null;
      residente_telefono: string | null;
      residente_email: string | null;
    }>(sql`
      select u.id, u.barrio_id, u.manzana, u.lote, u.codigo_pago_numero::int as numero,
             u.numero_accion, u.residente_nombre, u.residente_caracter, u.residente_telefono, u.residente_email,
             b.codigo_pago_largo as largo, b.codigo_pago_prefijo as prefijo, b.codigo_pago_separador as separador,
             u.estado_unidad::text as estado, u.superficie_m2::text as superficie, u.nomenclatura_catastral as nomenclatura,
             u.cbu, u.alias, u.saldo_inicial::text,
             not exists (select 1 from liquidacion l join periodo_expensa p on p.id = l.periodo_id
                          where l.unidad_funcional_id = u.id and p.estado not in ('borrador', 'revisada')) as editable,
             to_char(u.created_at at time zone b.zona_horaria, 'YYYY-MM-DD') as alta_at,
             to_char(u.baja_at at time zone b.zona_horaria, 'YYYY-MM-DD') as baja_at, u.baja_motivo, u.baja_detalle,
             (select s.saldo_actual::text from saldo_uf s where s.unidad_funcional_id = u.id) as deuda
        from unidad_funcional u join barrio b on b.barrio_id = u.barrio_id
       where u.id = ${unidadFuncionalId}
    `)
  ).rows[0];
  if (!u) return null;

  const titulares = (
    await tx.execute<{
      obligado_id: string;
      nombre: string;
      cuit_cuil: string | null;
      tipo_documento: string | null;
      numero_documento: string | null;
      tipo: TipoObligado;
      desde: string;
      hasta: string | null;
      es_notificado: boolean;
      email: string | null;
      telefono: string | null;
    }>(sql`
      select uo.obligado_id, o.nombre, o.cuit_cuil, o.tipo_documento, o.numero_documento, uo.tipo::text as tipo,
             uo.desde::text, uo.hasta::text, uo.es_notificado, o.email, o.telefono
        from unidad_obligado uo join obligado o on o.id = uo.obligado_id
       where uo.unidad_funcional_id = ${u.id}
       order by uo.hasta is null desc, uo.es_notificado desc, uo.desde desc, o.nombre
    `)
  ).rows.map(
    (t): TitularDeFicha => ({
      obligadoId: t.obligado_id,
      nombre: t.nombre,
      documento: t.cuit_cuil
        ? documentoLegible({ tipo: "cuit", numero: t.cuit_cuil })
        : t.numero_documento
          ? `${t.tipo_documento ?? ""} ${t.numero_documento}`.trim()
          : null,
      caracter: t.tipo,
      desde: t.desde,
      hasta: t.hasta,
      recibeBoleta: t.es_notificado,
      email: t.email,
      telefono: t.telefono,
    }),
  );
  const contactos = (
    await tx.execute<{ email: string; nombre: string | null; principal: boolean }>(sql`
      select email, nombre, principal from unidad_contacto where unidad_funcional_id = ${u.id} and activo order by principal desc, email
    `)
  ).rows;
  const historial = (
    await tx.execute<{
      fecha: string;
      tipo: string;
      detalle: string | null;
      motivo: string | null;
      vigente_desde: string | null;
      archivo: string | null;
      rol: string;
      respaldo: string | null;
    }>(sql`
      select to_char(e.created_at at time zone b.zona_horaria, 'YYYY-MM-DD HH24:MI') as fecha, e.tipo, e.detalle, e.motivo,
             e.vigente_desde::text, e.archivo, e.rol,
             nullif(concat_ws(' · ', e.respaldo_tipo, e.respaldo_referencia), '') as respaldo
        from padron_evento e join barrio b on b.barrio_id = e.barrio_id
       where e.unidad_funcional_id = ${u.id} order by e.created_at desc, e.id
    `)
  ).rows.map(
    (e): EventoDeFicha => ({
      fecha: e.fecha,
      tipo: e.tipo,
      detalle: e.detalle ?? "",
      motivo: e.motivo,
      vigenteDesde: e.vigente_desde,
      archivo: e.archivo,
      rol: e.rol,
      respaldo: e.respaldo,
    }),
  );

  return {
    id: u.id,
    barrioId: u.barrio_id,
    manzana: u.manzana,
    lote: u.lote,
    etiqueta: etiquetaUnidad(u.manzana, u.lote),
    codigoPago: codigoDePago(u.numero, { largo: u.largo, prefijo: u.prefijo, separador: u.separador }),
    estado: u.estado,
    superficie: u.superficie,
    nomenclatura: u.nomenclatura,
    cbu: u.cbu,
    alias: u.alias,
    saldoInicial: u.saldo_inicial,
    saldoInicialEditable: u.editable,
    numeroAccion: u.numero_accion,
    residente: u.residente_nombre
      ? { nombre: u.residente_nombre, caracter: u.residente_caracter, telefono: u.residente_telefono, mail: u.residente_email }
      : null,
    altaAt: u.alta_at,
    baja: u.baja_at ? { at: u.baja_at, motivo: u.baja_motivo, detalle: u.baja_detalle } : null,
    deuda: u.deuda ?? "0.00",
    titulares: titulares.filter((t) => t.hasta === null),
    anteriores: titulares.filter((t) => t.hasta !== null),
    contactos,
    historial,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Planilla: vista previa, confirmación y exportación
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que ya hay en el barrio, en la forma que espera `planDePadron`. */
async function padronExistente(
  tx: DbConIdentidad,
  barrioId: string,
): Promise<{ existentes: UnidadExistente[]; registradas: PersonaRegistrada[]; titularesDe: Map<string, TitularParaExportar[]> }> {
  const unidades = (
    await tx.execute<{
      id: string;
      manzana: string;
      lote: string;
      baja: boolean;
      superficie: string | null;
      estado: EstadoUnidad;
      nomenclatura: string | null;
      cbu: string | null;
      alias: string | null;
      saldo_inicial: string;
      editable: boolean;
      numero_accion: string | null;
      residente_nombre: string | null;
      residente_caracter: CaracterResidente | null;
      residente_telefono: string | null;
      residente_email: string | null;
    }>(sql`
      select u.id, u.manzana, u.lote, u.baja_at is not null as baja, u.superficie_m2::text as superficie,
             u.estado_unidad::text as estado, u.nomenclatura_catastral as nomenclatura, u.cbu, u.alias, u.saldo_inicial::text,
             u.numero_accion, u.residente_nombre, u.residente_caracter, u.residente_telefono, u.residente_email,
             not exists (select 1 from liquidacion l join periodo_expensa p on p.id = l.periodo_id
                          where l.unidad_funcional_id = u.id and p.estado not in ('borrador', 'revisada')) as editable
        from unidad_funcional u where u.barrio_id = ${barrioId}
       order by ${ORDEN_NATURAL_U}
    `)
  ).rows;
  const vinculos = (
    await tx.execute<{
      unidad_funcional_id: string;
      obligado_id: string;
      nombre: string;
      cuit_cuil: string | null;
      tipo_documento: string | null;
      numero_documento: string | null;
      email: string | null;
      telefono: string | null;
      tipo: TipoObligado;
      es_notificado: boolean;
    }>(sql`
      select uo.unidad_funcional_id, o.id as obligado_id, o.nombre, o.cuit_cuil, o.tipo_documento, o.numero_documento,
             o.email, o.telefono, uo.tipo::text as tipo, uo.es_notificado
        from unidad_obligado uo join obligado o on o.id = uo.obligado_id
       where uo.barrio_id = ${barrioId} and uo.hasta is null
       order by uo.es_notificado desc, uo.desde, o.nombre
    `)
  ).rows;
  const documentoDe = (v: { cuit_cuil: string | null; tipo_documento: string | null; numero_documento: string | null }): Documento | null =>
    v.cuit_cuil
      ? { tipo: "cuit", numero: v.cuit_cuil }
      : v.tipo_documento === "DNI" && v.numero_documento
        ? { tipo: "dni", numero: v.numero_documento }
        : null;
  const etiquetaDe = new Map(unidades.map((u) => [u.id, etiquetaUnidad(u.manzana, u.lote)]));
  const titularesDe = new Map<string, TitularParaExportar[]>();
  const registradas = new Map<string, PersonaRegistrada & { unidades: string[] }>();
  for (const v of vinculos) {
    const documento = documentoDe(v);
    const lista = titularesDe.get(v.unidad_funcional_id) ?? [];
    lista.push({
      obligadoId: v.obligado_id,
      nombre: v.nombre,
      documento,
      email: v.email,
      telefono: v.telefono,
      caracter: v.tipo,
      recibeBoleta: v.es_notificado,
    });
    titularesDe.set(v.unidad_funcional_id, lista);
  }
  // Las personas del barrio (con o sin unidad vigente), por documento.
  const personas = (
    await tx.execute<{ id: string; nombre: string; cuit_cuil: string | null; tipo_documento: string | null; numero_documento: string | null }>(sql`
      select id, nombre, cuit_cuil, tipo_documento, numero_documento from obligado where barrio_id = ${barrioId} order by created_at, id
    `)
  ).rows;
  for (const o of personas) {
    const documento = documentoDe(o);
    if (!documento) continue;
    const k = `${documento.tipo}:${documento.numero}`;
    if (!registradas.has(k)) registradas.set(k, { obligadoId: o.id, nombre: o.nombre, documento, unidades: [] });
  }
  for (const v of vinculos) {
    const documento = documentoDe(v);
    if (!documento) continue;
    registradas.get(`${documento.tipo}:${documento.numero}`)?.unidades.push(etiquetaDe.get(v.unidad_funcional_id) ?? "");
  }
  return {
    existentes: unidades.map((u) => ({
      id: u.id,
      manzana: u.manzana,
      lote: u.lote,
      dadaDeBaja: u.baja,
      superficie: u.superficie,
      estado: u.estado,
      nomenclatura: u.nomenclatura,
      cbu: u.cbu,
      alias: u.alias,
      saldoInicial: u.saldo_inicial,
      saldoInicialEditable: u.editable,
      numeroAccion: u.numero_accion,
      residente: u.residente_nombre
        ? { nombre: u.residente_nombre, caracter: u.residente_caracter, telefono: u.residente_telefono, mail: u.residente_email }
        : null,
      titulares: titularesDe.get(u.id) ?? [],
    })),
    registradas: [...registradas.values()],
    titularesDe,
  };
}

type TitularParaExportar = {
  obligadoId: string;
  nombre: string;
  documento: Documento | null;
  email: string | null;
  telefono: string | null;
  caracter: TipoObligado;
  recibeBoleta: boolean;
};

export type VistaPreviaDelPadron = PlanDePadron & {
  readonly archivo: string;
  /** El código de pago que recibiría cada alta, en el orden de la planilla (lo confirma la base). */
  readonly codigosPrevistos: ReadonlyMap<number, string>;
};

export type EntradaDeImportacion = {
  readonly barrioId: string;
  readonly archivo: string;
  readonly filas: readonly (readonly string[])[];
  readonly decisiones?: ReadonlyMap<number, DecisionPersona> | undefined;
};

async function planificar(tx: DbConIdentidad, e: EntradaDeImportacion, barrio: BarrioDelPadron) {
  let lectura;
  try {
    lectura = leerPlanillaPadron(e.filas, { cuentaPorUnidad: barrio.cuentaPorUnidad });
  } catch (error) {
    if (error instanceof PlanillaInvalida) rechazar("dato_invalido", error.message, "Bajá la plantilla y respetá el encabezado.");
    throw error;
  }
  const actual = await padronExistente(tx, barrio.id);
  return { plan: planDePadron(lectura, actual.existentes, actual.registradas, e.decisiones ?? new Map()), actual };
}

/** La vista previa: no escribe nada. */
export async function vistaPreviaDeImportacion(tx: DbConIdentidad, entrada: EntradaDeImportacion): Promise<VistaPreviaDelPadron> {
  const { barrioId } = consultaBarrioSchema.parse({ barrioId: entrada.barrioId });
  return enBase(async () => {
    await exigirAdministracion(tx, barrioId);
    const barrio = await exigirBarrio(tx, barrioId);
    const { plan } = await planificar(tx, entrada, barrio);
    const ultimo = Number(
      (await tx.execute<{ n: string }>(sql`select coalesce((select ultimo_numero from codigo_pago_secuencia where barrio_id = ${barrioId}), 0)::text as n`))
        .rows[0]!.n,
    );
    const codigosPrevistos = new Map<number, string>();
    let n = ultimo;
    for (const u of plan.unidades) if (u.accion === "alta") codigosPrevistos.set(u.fila, codigoDePago(++n, barrio.formatoCodigoPago));
    return { ...plan, archivo: entrada.archivo, codigosPrevistos };
  });
}

export type ImportacionConfirmada = { readonly altas: number; readonly correcciones: number; readonly sinCambios: number };

/**
 * Confirma la importación: vuelve a leer y a planificar contra el padrón de AHORA (lo que vio la
 * persona pudo cambiar), y si queda una sola fila con error o «a revisar» sin decidir, no escribe
 * nada. Todo en una transacción: todo o nada.
 */
export async function confirmarImportacion(tx: DbConIdentidad, entrada: EntradaDeImportacion): Promise<ImportacionConfirmada> {
  const { barrioId } = consultaBarrioSchema.parse({ barrioId: entrada.barrioId });
  const archivo = entrada.archivo.slice(0, 200);
  return enBase(async () => {
    await exigirAdministracion(tx, barrioId);
    const barrio = await exigirBarrio(tx, barrioId);
    const { plan, actual } = await planificar(tx, entrada, barrio);
    if (!plan.ok) {
      rechazar(
        "planilla_con_errores",
        plan.conError > 0
          ? `La planilla tiene ${plan.conError} ${plan.conError === 1 ? "fila con error" : "filas con error"}: no se importó nada.`
          : `Quedan ${plan.aRevisar} ${plan.aRevisar === 1 ? "fila" : "filas"} a revisar sin decidir: no se importó nada.`,
        "Corregí la planilla y subila de nuevo, o decidí las filas «a revisar» en la vista previa.",
      );
    }

    // Las personas nuevas se crean una vez por documento (la misma persona puede tener varios lotes), y
    // las que traen documento, en UN insert: el plan ya resolvió cuáles están registradas (esas vienen
    // con `obligadoId`), así que las demás son nuevas. Las que no traen documento van de a una.
    const personaPorDoc = new Map<string, string>();
    const nuevas = new Map<string, (typeof plan.unidades)[number]["titulares"][number]>();
    for (const u of plan.unidades) {
      if (u.accion !== "alta") continue;
      for (const t of u.titulares) {
        // La primera grafía manda (la de la fila más arriba), no la última.
        const k = t.documento ? `${t.documento.tipo}:${t.documento.numero}` : null;
        if (!t.obligadoId && k && !nuevas.has(k)) nuevas.set(k, t);
      }
    }
    if (nuevas.size > 0) {
      const lista = [...nuevas.values()];
      const creadas = (
        await tx.execute<{ id: string; tipo_documento: string; numero_documento: string }>(sql`
          insert into obligado (barrio_id, nombre, es_persona_juridica, tipo_documento, numero_documento, cuit_cuil, email, telefono)
          select ${barrioId}, n, j::boolean, td, nd, c, e, t
            from unnest(${textos(lista.map((t) => t.nombre))}, ${textos(lista.map((t) => String(esPersonaJuridica(t.documento))))},
                        ${textos(lista.map((t) => (t.documento!.tipo === "cuit" ? "CUIT" : "DNI")))}, ${textos(lista.map((t) => t.documento!.numero))},
                        ${textos(lista.map((t) => (t.documento!.tipo === "cuit" ? t.documento!.numero : null)))},
                        ${textos(lista.map((t) => t.mail))}, ${textos(lista.map((t) => t.telefono))}) as x(n, j, td, nd, c, e, t)
          returning id, tipo_documento, numero_documento
        `)
      ).rows;
      for (const c of creadas) personaPorDoc.set(`${c.tipo_documento === "CUIT" ? "cuit" : "dni"}:${c.numero_documento}`, c.id);
    }
    const persona = async (t: (typeof plan.unidades)[number]["titulares"][number]): Promise<string> => {
      if (t.obligadoId) return t.obligadoId;
      const k = t.documento ? `${t.documento.tipo}:${t.documento.numero}` : null;
      if (k && personaPorDoc.has(k)) return personaPorDoc.get(k)!;
      const id = await asegurarPersona(tx, barrioId, { nombre: t.nombre, caracter: t.caracter, documento: t.documento, mail: t.mail, telefono: t.telefono }, true);
      if (k) personaPorDoc.set(k, id);
      return id;
    };

    // Altas en lote (un insert para todas): 700 unidades no son 700 viajes.
    const altas = plan.unidades.filter((u) => u.accion === "alta" && u.unidad);
    const idPorFila = new Map<number, string>();
    if (altas.length > 0) {
      const insertadas = (
        await tx.execute<{ id: string; manzana: string; lote: string }>(sql`
          insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, superficie_m2, nomenclatura_catastral, cbu, alias, saldo_inicial,
                                        numero_accion, residente_nombre, residente_caracter, residente_telefono, residente_email)
          select ${barrioId}, m, l, e::app.estado_unidad, s::numeric, n, c, a, coalesce(si, '0')::numeric, na, rn, rc, rt, rm
            from unnest(${textos(altas.map((u) => u.unidad!.manzana))}, ${textos(altas.map((u) => u.unidad!.lote))},
                        ${textos(altas.map((u) => u.unidad!.estado ?? "baldio"))}, ${textos(altas.map((u) => u.unidad!.superficie))},
                        ${textos(altas.map((u) => u.unidad!.nomenclatura))}, ${textos(altas.map((u) => u.unidad!.cbu))},
                        ${textos(altas.map((u) => u.unidad!.alias))}, ${textos(altas.map((u) => u.unidad!.saldoInicial))},
                        ${textos(altas.map((u) => u.unidad!.numeroAccion))}, ${textos(altas.map((u) => u.unidad!.residente?.nombre ?? null))},
                        ${textos(altas.map((u) => u.unidad!.residente?.caracter ?? null))},
                        ${textos(altas.map((u) => u.unidad!.residente?.telefono ?? null))},
                        ${textos(altas.map((u) => u.unidad!.residente?.mail ?? null))})
                 with ordinality as x(m, l, e, s, n, c, a, si, na, rn, rc, rt, rm, o)
           order by o
          returning id, manzana, lote
        `)
      ).rows;
      // Manzana y lote son únicos en el barrio: alcanzan para volver de la fila insertada a la de la planilla.
      const idPorUnidad = new Map(insertadas.map((r) => [`${r.manzana}|${r.lote}`, r.id]));
      for (const u of altas) idPorFila.set(u.fila, idPorUnidad.get(`${u.unidad!.manzana}|${u.unidad!.lote}`)!);
    }

    const vinculos: { u: string; o: string; tipo: string; recibe: boolean; nombre: string; mail: string | null }[] = [];
    const eventos: { u: string; tipo: string; detalle: string }[] = [];
    for (const u of plan.unidades) {
      if (u.accion === "alta") {
        const id = idPorFila.get(u.fila)!;
        for (const t of u.titulares) vinculos.push({ u: id, o: await persona(t), tipo: t.caracter, recibe: t.recibeBoleta, nombre: t.nombre, mail: t.mail });
        eventos.push({ u: id, tipo: "alta_planilla", detalle: `Alta por planilla (${archivo}): ${u.detalle.join(" ")}` });
      } else if (u.accion === "corrige" && u.existenteId && u.unidad) {
        const d = u.unidad;
        await tx.execute(sql`
          update unidad_funcional
             set superficie_m2 = coalesce(${d.superficie}::numeric, superficie_m2),
                 estado_unidad = coalesce(${d.estado}::app.estado_unidad, estado_unidad),
                 nomenclatura_catastral = coalesce(${d.nomenclatura}, nomenclatura_catastral),
                 cbu = coalesce(${d.cbu}, cbu), alias = coalesce(${d.alias}, alias),
                 saldo_inicial = coalesce(${d.saldoInicial}::numeric, saldo_inicial),
                 numero_accion = coalesce(${d.numeroAccion}, numero_accion),
                 -- El residente va entero (los cuatro datos juntos) cuando la planilla lo trae.
                 residente_nombre = case when ${d.residente !== null} then ${d.residente?.nombre ?? null} else residente_nombre end,
                 residente_caracter = case when ${d.residente !== null} then ${d.residente?.caracter ?? null} else residente_caracter end,
                 residente_telefono = case when ${d.residente !== null} then ${d.residente?.telefono ?? null} else residente_telefono end,
                 residente_email = case when ${d.residente !== null} then ${d.residente?.mail ?? null} else residente_email end
           where id = ${u.existenteId}
        `);
        for (const t of u.titulares) {
          const actualDe = actual.titularesDe
            .get(u.existenteId)
            ?.find((x) => (t.documento && x.documento ? x.documento.numero === t.documento.numero : nombresIguales(x.nombre, t.nombre)));
          if (!actualDe) continue;
          if (t.mail || t.telefono) {
            await tx.execute(sql`
              update obligado set email = coalesce(${t.mail}, email), telefono = coalesce(${t.telefono}, telefono) where id = ${actualDe.obligadoId}
            `);
          }
          if (t.mail) {
            // Como «Editar»: el mail nuevo de quien recibe la boleta pasa a ser el principal (revisión, 7).
            if (actualDe.recibeBoleta) {
              await tx.execute(sql`update unidad_contacto set principal = false where unidad_funcional_id = ${u.existenteId} and principal`);
            }
            await tx.execute(sql`
              insert into unidad_contacto (barrio_id, unidad_funcional_id, email, nombre, principal)
              values (${barrioId}, ${u.existenteId}, ${t.mail}, ${actualDe.nombre}, ${actualDe.recibeBoleta})
              on conflict (unidad_funcional_id, lower(email)) do update set activo = true, principal = excluded.principal
            `);
          }
        }
        eventos.push({ u: u.existenteId, tipo: "correccion_planilla", detalle: `Corrección por planilla (${archivo}): ${u.detalle.join(" ")}` });
      }
    }
    if (vinculos.length > 0) {
      await tx.execute(sql`
        insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
        select ${barrioId}, u, o, t::app.tipo_obligado, ${barrio.hoy}::date, r::boolean
          from unnest(${uuids(vinculos.map((v) => v.u))}, ${uuids(vinculos.map((v) => v.o))}, ${textos(vinculos.map((v) => v.tipo))},
                      ${textos(vinculos.map((v) => String(v.recibe)))}) as x(u, o, t, r)
      `);
      const conMail = vinculos.filter((v) => v.mail);
      if (conMail.length > 0) {
        await tx.execute(sql`
          insert into unidad_contacto (barrio_id, unidad_funcional_id, email, nombre, principal)
          select ${barrioId}, u, e, n, r::boolean
            from unnest(${uuids(conMail.map((v) => v.u))}, ${textos(conMail.map((v) => v.mail))}, ${textos(conMail.map((v) => v.nombre))},
                        ${textos(conMail.map((v) => String(v.recibe)))}) as x(u, e, n, r)
          on conflict do nothing
        `);
      }
    }
    if (eventos.length > 0) {
      await tx.execute(sql`
        insert into padron_evento (barrio_id, unidad_funcional_id, tipo, detalle, archivo)
        select ${barrioId}, u, t, d, ${archivo}
          from unnest(${uuids(eventos.map((e) => e.u))}, ${textos(eventos.map((e) => e.tipo))}, ${textos(eventos.map((e) => e.detalle.slice(0, 1000)))}) as x(u, t, d)
      `);
    }
    if (altas.length > 0) await asegurarPartesIguales(tx, barrio);
    return { altas: plan.altas, correcciones: plan.correcciones, sinCambios: plan.sinCambios };
  });
}

/** El padrón con las mismas columnas que se importan (encabezado incluido). Sin las bajas. */
export async function exportarPadron(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<string[][]> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);
  // Lleva CUIT, documentos, mails, teléfonos y cuentas de todo el barrio: la baja la administración,
  // y queda registrado quién y cuándo (panel `security-engineer`, G2).
  await exigirAdministracion(tx, barrioId);
  const barrio = await exigirBarrio(tx, barrioId);
  const { existentes, titularesDe } = await padronExistente(tx, barrioId);
  await registrarEvento(tx, { barrioId, unidadId: null, tipo: "exportacion", detalle: "Exportación del padrón (planilla)." });
  return filasParaExportar(
    existentes.filter((u) => !u.dadaDeBaja).map((u) => ({ ...u, titulares: titularesDe.get(u.id) ?? [] })),
    barrio.cuentaPorUnidad,
  );
}

const CARACTER_DEL_VINCULO: Record<TipoObligado, string> = {
  propietario: "Propietario",
  poseedor: "Poseedor",
  usufructuario: "Usufructuario",
  tenedor: "Tenedor",
};

/** El encabezado de «Padrón a una fecha», en el orden de las columnas. */
export const COLUMNAS_PADRON_A_UNA_FECHA = [
  "unidad",
  "numero_accion",
  "titular",
  "caracter",
  "documento",
  "porcentaje_titularidad",
  "desde",
] as const;

/**
 * «Padrón a una fecha» (encargo 15): una fila por titular vigente ese día, del historial de titulares
 * (`unidad_obligado`, con `hasta` inclusivo: el cambio de titular cierra al anterior el día previo).
 * Entran las unidades que ese día estaban en el padrón: las dadas de baja después de la fecha, sí; las
 * dadas de baja antes, no.
 *
 * Va el **carácter** de cada vínculo (propietario, poseedor, usufructuario, tenedor): el historial
 * guarda los cuatro y un padrón con valor legal no los puede mezclar sin decirlo (`security-engineer`,
 * I3). Qué caracteres cuentan para cada uso (una asamblea, un listado) lo decide quien lo usa.
 *
 * **El porcentaje de titularidad no está en el modelo**: el historial guarda quién y desde cuándo, no
 * la parte de cada condómino. Con un solo propietario ese día es 100; con varios, la celda va vacía en
 * vez de inventar partes iguales, y los otros caracteres no llevan porcentaje (HANDOFF del encargo 15).
 * El número de acción es el **actual**: no tiene historial. Una unidad sin titular ese día no tiene fila.
 *
 * Lleva documentos de todo el barrio: la baja la administración, y queda registrado (`exportacion`),
 * como `exportarPadron`.
 */
export async function padronAUnaFecha(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string; readonly fecha: string },
): Promise<string[][]> {
  const { barrioId } = consultaBarrioSchema.parse({ barrioId: parametros.barrioId });
  const fecha = fechaIsoSchema.parse(parametros.fecha);
  // La expresión regular deja pasar un 31 de febrero: que la fecha exista de verdad (code-reviewer, H4).
  const existe = (() => {
    try {
      return sumarDias(fecha, 0) === fecha;
    } catch {
      return false;
    }
  })();
  if (!existe) rechazar("dato_invalido", "Esa fecha no existe.", "Elegí la fecha en el calendario.");
  await exigirAdministracion(tx, barrioId);
  const filas = (
    await tx.execute<{
      manzana: string;
      lote: string;
      numero_accion: string | null;
      nombre: string;
      caracter: TipoObligado;
      cuit_cuil: string | null;
      tipo_documento: string | null;
      numero_documento: string | null;
      desde: string;
      titulares: number;
    }>(sql`
      select u.manzana, u.lote, u.numero_accion, o.nombre, uo.tipo::text as caracter, o.cuit_cuil, o.tipo_documento, o.numero_documento,
             uo.desde::text as desde,
             count(*) filter (where uo.tipo = 'propietario') over (partition by u.id)::int as titulares
        from unidad_obligado uo
        join unidad_funcional u on u.id = uo.unidad_funcional_id
        join obligado o on o.id = uo.obligado_id
        join barrio b on b.barrio_id = u.barrio_id
       where u.barrio_id = ${barrioId}
         and uo.desde <= ${fecha}::date
         and (uo.hasta is null or uo.hasta >= ${fecha}::date)
         and (u.baja_at is null or (u.baja_at at time zone b.zona_horaria)::date > ${fecha}::date)
       order by ${ORDEN_NATURAL_U}, uo.es_notificado desc, uo.desde, o.nombre
    `)
  ).rows;
  await registrarEvento(tx, {
    barrioId,
    unidadId: null,
    tipo: "exportacion",
    detalle: `Exportación del padrón al ${fecha.split("-").reverse().join("/")} (planilla).`,
    datos: { fecha, filas: filas.length },
  });
  return [
    [...COLUMNAS_PADRON_A_UNA_FECHA],
    ...filas.map((f) => [
      etiquetaUnidad(f.manzana, f.lote),
      f.numero_accion ?? "",
      f.nombre,
      CARACTER_DEL_VINCULO[f.caracter],
      f.cuit_cuil
        ? documentoLegible({ tipo: "cuit", numero: f.cuit_cuil })
        : f.numero_documento
          ? `${f.tipo_documento ?? ""} ${f.numero_documento}`.trim()
          : "",
      // 100 solo para el único propietario: un tenedor o un poseedor no tienen parte de la titularidad.
      f.caracter === "propietario" && f.titulares === 1 ? "100" : "",
      f.desde.split("-").reverse().join("/"),
    ]),
  ];
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Coeficientes (pantalla 6)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type VersionDeCoeficientes = {
  readonly id: string;
  readonly numero: number;
  readonly base: string;
  readonly descripcion: string | null;
  readonly rigeDesde: string;
  readonly rigeHasta: string | null;
  readonly unidades: number;
  readonly suma: string;
  readonly usadaParaLiquidar: boolean;
  readonly estado: "vigente" | "programada" | "historica";
};

export type CoeficientesDelBarrio = {
  readonly versiones: readonly VersionDeCoeficientes[];
  /** Unidades activas sin coeficiente en la versión que rige el próximo período. */
  readonly sinCoeficiente: readonly string[];
  readonly unidadesActivas: number;
  readonly superficieTotal: string | null;
  readonly conSuperficie: number;
};

export async function coeficientesDelBarrio(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<CoeficientesDelBarrio> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);
  const barrio = await exigirBarrio(tx, barrioId);
  const versiones = (
    await tx.execute<{
      id: string;
      base: string;
      descripcion: string | null;
      desde: string;
      hasta: string | null;
      unidades: number;
      suma: string;
      usada: boolean;
    }>(sql`
      select cv.id, cv.base::text, cv.descripcion, to_char(cv.vigente_desde, 'YYYY-MM') as desde, to_char(cv.vigente_hasta, 'YYYY-MM') as hasta,
             (select count(*)::int from coeficiente c where c.version_id = cv.id) as unidades,
             (select coalesce(sum(c.valor), 0)::numeric(24,9)::text from coeficiente c where c.version_id = cv.id) as suma,
             exists (select 1 from periodo_expensa p where p.coeficiente_version_id = cv.id and p.estado not in ('borrador', 'revisada')) as usada
        from coeficiente_version cv
       where cv.barrio_id = ${barrioId} and cv.cerrada
       order by cv.created_at, cv.id
    `)
  ).rows;
  const proximo = `${barrio.proximoPeriodo}`;
  const rige = (v: { desde: string; hasta: string | null }) => v.desde <= proximo && (v.hasta === null || v.hasta > proximo);
  const lista: VersionDeCoeficientes[] = versiones
    // Las que quedaron sin rango (reemplazadas antes de regir) no se listan como historia.
    .filter((v) => v.hasta === null || v.hasta > v.desde)
    .map((v, i): VersionDeCoeficientes => ({
      id: v.id,
      numero: i + 1,
      base: v.base,
      descripcion: v.descripcion,
      rigeDesde: v.desde,
      rigeHasta: v.hasta,
      unidades: v.unidades,
      suma: v.suma,
      usadaParaLiquidar: v.usada,
      estado: rige(v) ? "vigente" : v.desde > proximo ? "programada" : "historica",
    }))
    .reverse();
  const vigente = lista.find((v) => v.estado === "vigente") ?? lista.find((v) => v.rigeHasta === null);
  const sinCoeficiente = (
    await tx.execute<{ manzana: string; lote: string }>(sql`
      select u.manzana, u.lote from unidad_funcional u
       where u.barrio_id = ${barrioId} and u.baja_at is null
         and not exists (select 1 from coeficiente c where c.version_id = ${vigente?.id ?? null}::uuid and c.unidad_funcional_id = u.id)
       order by ${ORDEN_NATURAL_U} limit 200
    `)
  ).rows.map((u) => etiquetaUnidad(u.manzana, u.lote));
  const totales = (
    await tx.execute<{ n: number; superficie: string | null; con: number }>(sql`
      select count(*)::int as n, sum(superficie_m2)::numeric(14,2)::text as superficie, count(superficie_m2)::int as con
        from unidad_funcional where barrio_id = ${barrioId} and baja_at is null
    `)
  ).rows[0]!;
  return { versiones: lista, sinCoeficiente, unidadesActivas: totales.n, superficieTotal: totales.superficie, conSuperficie: totales.con };
}

export type VersionCreada = { readonly versionId: string; readonly unidades: number; readonly suma: string };

/**
 * Una versión nueva: por superficie (todas las activas tienen que tener superficie), iguales por lote,
 * o con los valores de una planilla (`manzana · lote · coeficiente`, que se normalizan a 1). En los
 * tres casos, 9 decimales y el resto a la última unidad.
 */
export async function crearVersionCoeficientes(
  tx: DbConIdentidad,
  parametros: NuevaVersionCoeficientes & { readonly planilla?: readonly (readonly string[])[] | undefined },
): Promise<VersionCreada> {
  const p = nuevaVersionCoeficientesSchema.parse(parametros);
  return enBase(async () => {
    await exigirAdministracion(tx, p.barrioId);
    const activas = await unidadesActivasOrdenadas(tx, p.barrioId);
    if (activas.length === 0) rechazar("sin_unidades", "El barrio no tiene unidades activas.", "Cargá el padrón antes de los coeficientes.");
    let pesos: { unidadFuncionalId: string; peso: string }[];
    const forma = p.forma as FormaCoeficiente;
    if (forma === "superficie") {
      const sin = activas.filter((u) => u.superficie === null || Number(u.superficie) <= 0);
      if (sin.length > 0) {
        rechazar(
          "dato_invalido",
          `Hay ${sin.length} ${sin.length === 1 ? "unidad" : "unidades"} sin superficie (por ejemplo ${etiquetaUnidad(sin[0]!.manzana, sin[0]!.lote)}).`,
          "Cargá la superficie en el padrón (a mano o por planilla), o elegí «Iguales por lote».",
        );
      }
      pesos = activas.map((u) => ({ unidadFuncionalId: u.id, peso: u.superficie! }));
    } else if (forma === "iguales") {
      pesos = activas.map((u) => ({ unidadFuncionalId: u.id, peso: "1" }));
    } else {
      const leida = leerPlanillaCoeficientes(parametros.planilla ?? []);
      if (!leida.ok) rechazar("dato_invalido", leida.errores.slice(0, 5).join(" "), "Corregí la planilla y subila de nuevo.");
      const porClave = new Map(leida.filas.map((f) => [`${f.manzana.toUpperCase()}|${f.lote.toUpperCase()}`, f]));
      const faltan = activas.filter((u) => !porClave.has(`${u.manzana.toUpperCase()}|${u.lote.toUpperCase()}`));
      const sobran = leida.filas.filter((f) => !activas.some((u) => u.manzana.toUpperCase() === f.manzana.toUpperCase() && u.lote.toUpperCase() === f.lote.toUpperCase()));
      if (faltan.length > 0 || sobran.length > 0) {
        rechazar(
          "dato_invalido",
          [
            faltan.length > 0 ? `Faltan ${faltan.length} unidades activas (por ejemplo ${etiquetaUnidad(faltan[0]!.manzana, faltan[0]!.lote)}).` : "",
            sobran.length > 0 ? `Sobran ${sobran.length} filas que no son unidades activas (por ejemplo la fila ${sobran[0]!.fila}).` : "",
          ]
            .join(" ")
            .trim(),
          "La planilla de coeficientes lleva todas las unidades activas, y solo esas.",
        );
      }
      pesos = activas.map((u) => ({ unidadFuncionalId: u.id, peso: porClave.get(`${u.manzana.toUpperCase()}|${u.lote.toUpperCase()}`)!.peso }));
    }
    const valores = repartirCoeficientes(pesos);
    let documentoId: string | null = null;
    if (p.respaldoTipo !== null) {
      documentoId = (
        await tx.execute<{ id: string }>(sql`
          insert into documento_barrio (barrio_id, tipo, titulo, storage_key, subido_por)
          values (${p.barrioId}, ${p.respaldoTipo === "acta_asamblea" ? "acta_asamblea" : p.respaldoTipo === "reglamento" ? "reglamento" : "otro"},
                  ${p.respaldoReferencia ?? "Respaldo de coeficientes"}, ${p.respaldoAdjunto}, app.current_user_id())
          returning id
        `)
      ).rows[0]!.id;
    }
    const versionId = await escribirVersion(tx, {
      barrioId: p.barrioId,
      rigeDesde: p.rigeDesde,
      base: BASE_DE_FORMA[forma],
      descripcion: `${forma === "superficie" ? "Por superficie" : forma === "iguales" ? "Iguales por lote" : "Cargados por planilla"}`,
      valores,
      documentoId,
    });
    const suma = sumarCoeficientes(valores.map((v) => v.valor));
    await registrarEvento(tx, {
      barrioId: p.barrioId,
      unidadId: null,
      tipo: "version_coeficientes",
      vigenteDesde: `${p.rigeDesde}-01`,
      detalle: `Versión de coeficientes ${forma} desde ${p.rigeDesde}: ${valores.length} unidades, suma ${suma}.`,
      respaldo: { tipo: p.respaldoTipo, referencia: p.respaldoReferencia, adjunto: p.respaldoAdjunto },
    });
    return { versionId, unidades: valores.length, suma };
  });
}
