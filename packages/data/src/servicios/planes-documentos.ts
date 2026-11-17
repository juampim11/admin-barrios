/**
 * Los documentos de un plan de pagos (encargo P2a-3): el modelo de cláusulas de la administración, el
 * PDF del plan por sus dos caminos y los documentos que se suben (el firmado y el del estudio).
 *
 * - **El modelo** (`plan_modelo_clausulas`, `0096`): uno por administración y estudio, con el general
 *   como respaldo. Se crea con el borrador de `@admin-barrios/shared/planes-documentos` y se edita en
 *   Configuración › Estudios jurídicos. Quién puede lo decide la RLS (`administraciones_administradas`).
 * - **El PDF** lo arma el worker (ADR-0001): acá se encola el trabajo (`emitir_acuerdo_plan` o
 *   `emitir_anexo_plan`) y se arma la vista con **las cifras que guardó la base** —nunca recalculadas—.
 * - **Los documentos** se agregan solo por `app.plan_agregar_documento`, que escribe el documento y su
 *   evento con el SHA-256 juntos. Nada se reemplaza: se agrega otro y queda la historia.
 */
import { sql } from "drizzle-orm";
import { idSchema } from "@admin-barrios/shared/consultas";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { porcentajeDeTasa } from "@admin-barrios/shared/activacion";
import { aCentavos, formatearMonto, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import {
  ACENTO_NEUTRO,
  cifra,
  fechaImpresa,
  parsearVistaAcuerdoPlan,
  VERSION_VISTA_ACUERDO_PLAN,
  type VistaAcuerdoPlan,
} from "@admin-barrios/shared/documentos";
import { textoDePorcentaje, type EstadoPlan } from "@admin-barrios/shared/planes";
import {
  agregarDocumentoDelPlanSchema,
  armarDocumentoDelPlanSchema,
  CLAUSULAS_BORRADOR,
  completarClausula,
  crearModeloDeClausulasSchema,
  guardarModeloDeClausulasSchema,
  prepararSubidaDeDocumentoDelPlanSchema,
  type AgregarDocumentoDelPlan,
  type ArmarDocumentoDelPlan,
  type CaminoDelAcuerdo,
  type ClaseDocumentoPlan,
  type Clausula,
  type CrearModeloDeClausulas,
  type GuardarModeloDeClausulas,
  type PrepararSubidaDeDocumentoDelPlan,
  type VariableDeClausula,
} from "@admin-barrios/shared/planes-documentos";
import { claveDeDocumentoDePlan, nuevoToken, type ContentTypeDeComprobante } from "@admin-barrios/almacenamiento";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";

const ROLES_ADMIN = sql`array['admin_plataforma', 'admin_barrio']::app.rol_membership[]`;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El modelo de cláusulas
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type ModeloDeClausulas = {
  readonly id: string;
  readonly clausulas: readonly Clausula[];
  readonly textoValidado: boolean;
  /** Cuándo se guardó por última vez: la pantalla lo usa para volver a armar el editor después de guardar. */
  readonly actualizado: string;
};

export type ModelosDeLaAdministracion = {
  readonly puedeEditar: boolean;
  /** El general de la administración: el que se usa si el estudio del plan no tiene uno propio. */
  readonly general: ModeloDeClausulas | null;
  /** Uno por estudio activo de la administración, con su modelo o `null` si todavía no tiene. */
  readonly estudios: readonly { readonly estudioId: string; readonly nombre: string; readonly modelo: ModeloDeClausulas | null }[];
};

/** Los modelos de una administración, para Configuración › Estudios jurídicos. */
export async function modelosDeClausulas(
  tx: DbConIdentidad,
  parametros: { readonly administracionId: string },
): Promise<ModelosDeLaAdministracion> {
  const administracionId = idSchema.parse(parametros.administracionId);
  return enBase(async () => {
    const { rows } = await tx.execute<{
      id: string | null;
      estudio_id: string | null;
      nombre: string | null;
      clausulas: Clausula[] | null;
      texto_validado: boolean | null;
      actualizado: string | null;
      puede: boolean;
    }>(sql`
      with puede as (select ${administracionId}::uuid in (select app.administraciones_administradas()) as puede)
      select * from (
        select m.id, null::uuid as estudio_id, null::text as nombre, m.clausulas, m.texto_validado, m.updated_at::text as actualizado,
               (select puede from puede) as puede
          from (select 1) uno
          left join plan_modelo_clausulas m on m.administracion_id = ${administracionId} and m.estudio_id is null
        union all
        select m.id, ea.estudio_id, ea.nombre, m.clausulas, m.texto_validado, m.updated_at::text, (select puede from puede)
          from estudio_administracion ea
          left join plan_modelo_clausulas m on m.administracion_id = ea.administracion_id and m.estudio_id = ea.estudio_id
         where ea.administracion_id = ${administracionId} and ea.activo
      ) t
      -- El general primero; los estudios por nombre.
      order by t.estudio_id is not null, t.nombre
    `);
    const modelo = (r: (typeof rows)[number]): ModeloDeClausulas | null =>
      r.id === null ? null : { id: r.id, clausulas: r.clausulas ?? [], textoValidado: r.texto_validado ?? false, actualizado: r.actualizado ?? "" };
    const [general, ...estudios] = rows;
    return {
      puedeEditar: general?.puede ?? false,
      general: general ? modelo(general) : null,
      estudios: estudios.map((r) => ({ estudioId: r.estudio_id!, nombre: r.nombre!, modelo: modelo(r) })),
    };
  });
}

/** Crea el modelo (general o de un estudio) con el borrador de tres cláusulas, sin validar. */
export async function crearModeloDeClausulas(
  tx: DbConIdentidad,
  parametros: CrearModeloDeClausulas,
): Promise<{ readonly modeloId: string }> {
  const p = crearModeloDeClausulasSchema.parse(parametros);
  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into plan_modelo_clausulas (administracion_id, estudio_id, clausulas)
      values (${p.administracionId}, ${p.estudioId}, ${JSON.stringify(CLAUSULAS_BORRADOR)}::jsonb)
      returning id
    `);
    return { modeloId: rows[0]!.id };
  });
}

/** Guarda las cláusulas de un modelo y si el estudio ya validó el texto. */
export async function guardarModeloDeClausulas(
  tx: DbConIdentidad,
  parametros: GuardarModeloDeClausulas,
): Promise<{ readonly modeloId: string }> {
  const p = guardarModeloDeClausulasSchema.parse(parametros);
  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      update plan_modelo_clausulas
         set clausulas = ${JSON.stringify(p.clausulas)}::jsonb, texto_validado = ${p.textoValidado}
       where id = ${p.modeloId}
      returning id
    `);
    if (!rows[0]) rechazar("referencia_inexistente", "Ese modelo no existe o no lo podés editar.", "Recargá la pantalla.");
    return { modeloId: rows[0].id };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La vista del PDF
// ────────────────────────────────────────────────────────────────────────────────────────────────

type FilaPlan = {
  id: string;
  barrio_id: string;
  estado: EstadoPlan;
  tipo: "catalogo" | "a_medida";
  sistema: "fija" | "frances" | "libre";
  tasa: string;
  catalogo: string | null;
  modo_cobro: "barrio" | "estudio";
  estudio_cobra: string | null;
  estudio_del_plan: string | null;
  deuda_capital: string;
  deuda_interes: string;
  quita_interes: string;
  quita_capital: string;
  interes_financiacion: string;
  total_cuotas: string;
  fecha_firma: string | null;
  acta_referencia: string | null;
  manzana: string;
  lote: string;
  titular: string | null;
  barrio_nombre: string;
  administrador_nombre: string | null;
  tiene_mandato: boolean;
  cuotas_para_caer: number;
  modelo_id: string | null;
  clausulas: Clausula[] | null;
  texto_validado: boolean | null;
  puede: boolean;
  meses: { periodo: string; capital: string; interes: string }[];
  cuotas: { numero: number; vencimiento: string; importe: string; capital: string; interes: string }[];
};

const pesos = (m: string) => `$ ${formatearMonto(m)}`;

/**
 * La vista del PDF de un plan, con las cifras que guardó la base (al proponer o al firmar). Solo lee.
 * Corre en la transacción del worker, con la identidad de quien pidió el PDF: el plan, el modelo y el
 * titular se leen bajo RLS.
 */
export async function armarVistaDeAcuerdoPlan(
  tx: DbConIdentidad,
  parametros: { readonly planId: string; readonly camino: CaminoDelAcuerdo; readonly fechaIso: string },
): Promise<VistaAcuerdoPlan> {
  const planId = idSchema.parse(parametros.planId);
  const p = (
    await tx.execute<FilaPlan>(sql`
      select pp.id, pp.barrio_id, pp.estado, pp.tipo, pp.sistema, pp.tasa_mensual::text as tasa, k.nombre as catalogo, pp.modo_cobro,
             (select ea.nombre from estudio_administracion ea where ea.estudio_id = pp.estudio_id and ea.administracion_id = tb.parent_id) as estudio_cobra,
             (select ea.nombre from estudio_administracion ea
               where ea.estudio_id = coalesce(pp.estudio_id, k.estudio_id) and ea.administracion_id = tb.parent_id) as estudio_del_plan,
             pp.deuda_capital::text, pp.deuda_interes::text, pp.quita_interes::text, pp.quita_capital::text,
             pp.interes_financiacion::text, pp.total_cuotas::text, pp.fecha_firma::text, pp.acta_referencia,
             uf.manzana, uf.lote,
             (select string_agg(o.nombre, ' y ' order by o.nombre) from unidad_obligado uo join obligado o on o.id = uo.obligado_id
               where uo.unidad_funcional_id = pp.unidad_funcional_id and uo.hasta is null and uo.tipo = 'propietario') as titular,
             tb.nombre as barrio_nombre, ta.nombre as administrador_nombre, (m.id is not null) as tiene_mandato,
             coalesce((select cuotas_para_caer from plan_parametro_barrio where barrio_id = pp.barrio_id), 2)::int as cuotas_para_caer,
             mo.id as modelo_id, mo.clausulas, mo.texto_validado,
             app.has_role_on(pp.barrio_id, ${ROLES_ADMIN}) as puede,
             coalesce((select json_agg(json_build_object('periodo', pe.periodo, 'capital', pl.capital::text, 'interes', pl.interes::text)
                                       order by pe.periodo)
                         from plan_liquidacion pl join liquidacion l on l.id = pl.liquidacion_id
                         join periodo_expensa pe on pe.id = l.periodo_id
                        where pl.plan_id = pp.id), '[]'::json) as meses,
             coalesce((select json_agg(json_build_object('numero', c.numero, 'vencimiento', c.vencimiento::text, 'importe', c.importe::text,
                                                         'capital', c.capital::text, 'interes', c.interes::text) order by c.numero)
                         from plan_cuota c where c.plan_id = pp.id), '[]'::json) as cuotas
        from plan_pago pp
        join unidad_funcional uf on uf.id = pp.unidad_funcional_id
        join tenant_node tb on tb.id = pp.barrio_id
        left join plan_catalogo k on k.id = pp.catalogo_id
        left join mandato_administracion m on m.barrio_id = pp.barrio_id and m.hasta is null
        left join tenant_node ta on ta.id = m.administrador_id
        left join plan_modelo_clausulas mo on mo.id = app.plan_modelo_del_plan(pp.id)
       where pp.id = ${planId}
    `)
  ).rows[0];
  // Errores de negocio, con su texto para la pantalla: el worker los deja como motivo de la falla sin
  // reintentar (code-reviewer: no se clasifica por el texto del mensaje).
  // «No existe» y «no lo podés ver» son el mismo caso (no es un oráculo sobre planes de otro barrio).
  if (!p) rechazar("referencia_inexistente", "El plan ya no está disponible para quien pidió el PDF.", "Volvé a la ficha de la unidad.");
  if (!p.puede) rechazar("sin_permiso", "Quien pidió el PDF ya no administra el barrio.", "Lo pide la administración del barrio.");
  if (p.estado === "rechazado" || p.estado === "retirado") {
    rechazar("dato_invalido", "El plan está rechazado o retirado: no lleva documentos nuevos.", "Recargá la ficha de la unidad.");
  }
  // Compuerta del emisor (la de `marcaDelPeriodo`): con mandato pero sin nombre legible, no se imprime un emisor equivocado.
  if (p.tiene_mandato && !p.administrador_nombre) {
    rechazar("sin_permiso", "No se puede leer quién administra el barrio, y el PDF no sale con un emisor equivocado.", "Pedí acceso al mandato de administración.");
  }
  if (parametros.camino === "modelo" && !p.modelo_id) {
    rechazar("dato_invalido", "Todavía no hay un modelo de cláusulas para este plan.", "Crealo en Configuración general › Estudios jurídicos, o armá solo el anexo.");
  }

  const deuda = sumarMontos(p.deuda_capital, p.deuda_interes);
  const quita = sumarMontos(p.quita_interes, p.quita_capital);
  // El porcentaje, directo: lo que se perdona sobre la deuda, en décimas, medio hacia arriba (code-reviewer:
  // no derivarlo de `total_cuotas`, que con financiación no es deuda − quita).
  const centDeuda = aCentavos(deuda);
  const decimas = centDeuda === 0n ? 0n : (aCentavos(quita) * 2000n + centDeuda) / (2n * centDeuda);
  const porcentaje = textoDePorcentaje(`${decimas / 10n}.${decimas % 10n}`);
  const unidad = etiquetaUnidad(p.manzana, p.lote);
  const cantidad = p.cuotas.filter((c) => c.numero > 0).length;
  const valores: Record<VariableDeClausula, string> = {
    barrio: p.barrio_nombre,
    unidad,
    titular: p.titular ?? "quien figura como titular de la unidad",
    deuda: pesos(deuda),
    quita: pesos(quita),
    totalDelPlan: pesos(p.total_cuotas),
    cuotas: String(cantidad),
    cuotasParaCaer: p.cuotas_para_caer === 1 ? "1 cuota vencida" : `${p.cuotas_para_caer} cuotas vencidas`,
  };
  const financiacion =
    p.sistema === "frances"
      ? `Sistema francés al ${porcentajeDeTasa(p.tasa)} % mensual`
      : p.sistema === "fija"
        ? "Cuota fija sin interés de financiación"
        : "Cronograma a medida";

  return parsearVistaAcuerdoPlan({
    version: VERSION_VISTA_ACUERDO_PLAN,
    camino: parametros.camino,
    marca: {
      barrio: { nombre: p.barrio_nombre, logo: null, acentoHex: ACENTO_NEUTRO },
      emisor: { razonSocial: p.administrador_nombre ?? p.barrio_nombre, cuit: null, domicilio: null, contacto: null, logo: null },
      pie: [],
    },
    emitido: fechaImpresa(parametros.fechaIso),
    plan: {
      estado: p.estado,
      descripcion: p.tipo === "catalogo" ? `Plan del catálogo «${p.catalogo ?? "sin nombre"}»` : "Plan a medida",
      financiacion,
      cobro: p.modo_cobro === "estudio" && p.estudio_cobra ? `Cobra y rinde ${p.estudio_cobra}` : "Cobra el barrio, en la boleta de cada mes",
      cobraElEstudio: p.modo_cobro === "estudio" ? (p.estudio_cobra ?? "el estudio") : null,
      fechaFirma: p.fecha_firma ? fechaImpresa(p.fecha_firma) : null,
      acta: p.acta_referencia,
    },
    unidad: { etiqueta: unidad, titular: p.titular },
    deuda: {
      meses: p.meses.map((m) => ({
        periodo: formatearPeriodo(m.periodo),
        capital: cifra(m.capital),
        interes: cifra(m.interes),
        total: cifra(sumarMontos(m.capital, m.interes)),
      })),
      capital: cifra(p.deuda_capital),
      interes: cifra(p.deuda_interes),
      total: cifra(deuda),
    },
    quita: {
      interes: cifra(p.quita_interes),
      capital: cifra(p.quita_capital),
      total: cifra(quita),
      porcentaje,
    },
    financiacion: cifra(p.interes_financiacion),
    totalDelPlan: cifra(p.total_cuotas),
    cuotas: p.cuotas.map((c) => ({
      numero: c.numero,
      vencimiento: fechaImpresa(c.vencimiento),
      importe: cifra(c.importe),
      capital: cifra(c.capital),
      interes: cifra(c.interes),
    })),
    totalCuotas: {
      capital: cifra(sumarMontos("0.00", ...p.cuotas.map((c) => c.capital))),
      interes: cifra(sumarMontos("0.00", ...p.cuotas.map((c) => c.interes))),
    },
    cuotasParaCaer: p.cuotas_para_caer,
    clausulas:
      parametros.camino === "modelo"
        ? (p.clausulas ?? []).map((c) => ({ titulo: completarClausula(c.titulo, valores), texto: completarClausula(c.texto, valores) }))
        : null,
    textoAValidar: parametros.camino === "modelo" && !(p.texto_validado ?? false),
    estudio: parametros.camino === "anexo" ? p.estudio_del_plan : null,
    leyendas: [],
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Encolar el PDF, y los documentos del plan
// ────────────────────────────────────────────────────────────────────────────────────────────────

const TIPO_DE_TRABAJO: Record<CaminoDelAcuerdo, "emitir_acuerdo_plan" | "emitir_anexo_plan"> = {
  modelo: "emitir_acuerdo_plan",
  anexo: "emitir_anexo_plan",
};

/**
 * Pide el PDF del plan por uno de los dos caminos. Si ya hay uno armándose por ese camino, no encola
 * otro: devuelve ese. Los controles (la administración del barrio, el plan sin rechazar ni retirar, el
 * modelo para el camino a) los hace `app.trabajo_antes_insert()`.
 */
export async function encolarDocumentoDelPlan(
  tx: DbConIdentidad,
  parametros: ArmarDocumentoDelPlan,
): Promise<{ readonly trabajoId: string }> {
  const p = armarDocumentoDelPlanSchema.parse(parametros);
  const tipo = TIPO_DE_TRABAJO[p.camino];
  return enBase(async () => {
    // Antes de mirar si ya hay uno armándose: si no, quien solo lee el plan (el contador) recibía el id
    // del trabajo en curso como si lo hubiera pedido. El permiso lo vuelve a decidir la base al encolar.
    await planParaSubir(tx, p.planId);
    const enCurso = (
      await tx.execute<{ id: string }>(sql`
        select id from trabajo where referencia_id = ${p.planId} and tipo = ${tipo} and estado in ('encolado', 'corriendo')
      `)
    ).rows[0];
    if (enCurso) return { trabajoId: enCurso.id };
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into trabajo (tipo, referencia_id) values (${tipo}, ${p.planId}) returning id
    `);
    return { trabajoId: rows[0]!.id };
  });
}

/**
 * El acuerdo de un plan recién propuesto (la pantalla 3, «Enviar y armar el acuerdo»): con el modelo de
 * cláusulas si hay uno que el plan pueda usar, y si no, solo el anexo. Así nunca encola un trabajo que la
 * base rechazaría, y no deshace la propuesta que va en la misma transacción.
 */
export async function encolarElAcuerdoDelPlan(tx: DbConIdentidad, parametros: { readonly planId: string }): Promise<{ readonly trabajoId: string }> {
  const planId = idSchema.parse(parametros.planId);
  const { rows } = await tx.execute<{ hay: boolean }>(sql`select app.plan_modelo_del_plan(${planId}) is not null as hay`);
  return encolarDocumentoDelPlan(tx, { planId, camino: rows[0]?.hay ? "modelo" : "anexo" });
}

export type DocumentoDelPlan = {
  readonly id: string;
  readonly clase: ClaseDocumentoPlan;
  readonly sha256: string;
  readonly bytes: number;
  /** El nombre del archivo subido; `null` en los que arma el sistema. */
  readonly nombre: string | null;
  /** Cómo estaba el plan cuando se armó o se subió. */
  readonly estadoPlan: EstadoPlan;
  /** `YYYY-MM-DD HH:MI`, en la hora del barrio. */
  readonly registradoEl: string;
  readonly registradoPor: string;
};

export type DocumentosDelPlan = {
  /** El más nuevo primero. */
  readonly documentos: readonly DocumentoDelPlan[];
  /** Lo que se está armando ahora, por camino. */
  readonly armando: Readonly<Record<CaminoDelAcuerdo, boolean>>;
  /** El motivo, si el último PDF que se pidió (por cualquier camino) falló. */
  readonly fallo: string | null;
  /** Si hay un modelo de cláusulas que el plan pueda usar (el camino a). */
  readonly hayModelo: boolean;
  readonly modeloSinValidar: boolean;
  /** La administración del barrio, con el plan sin rechazar ni retirar. */
  readonly puedeAgregar: boolean;
};

/** Los documentos de un plan y cómo va el PDF de cada camino, para la ficha de la unidad. */
export async function documentosDelPlan(tx: DbConIdentidad, parametros: { readonly planId: string }): Promise<DocumentosDelPlan> {
  const planId = idSchema.parse(parametros.planId);
  return enBase(async () => {
    const { rows } = await tx.execute<{
      documentos: { id: string; clase: ClaseDocumentoPlan; sha256: string; bytes: number; nombre: string | null; estado_plan: EstadoPlan; el: string; por: string }[];
      trabajos: { tipo: string; estado: string; error: string | null }[];
      modelo: boolean;
      sin_validar: boolean;
      puede: boolean;
    }>(sql`
      select coalesce((select json_agg(json_build_object('id', d.id, 'clase', d.clase, 'sha256', d.sha256, 'bytes', d.bytes, 'nombre', d.nombre,
                                                         'estado_plan', d.estado_plan,
                                                         'el', to_char(d.registrado_at at time zone b.zona_horaria, 'YYYY-MM-DD HH24:MI'),
                                                         'por', coalesce(ud.nombre, 'La administración'))
                                       order by d.registrado_at desc)
                         from plan_documento d left join usuario_demo ud on ud.user_id = d.registrado_por
                        where d.plan_id = p.id), '[]'::json) as documentos,
             coalesce((select json_agg(json_build_object('tipo', t.tipo, 'estado', t.estado, 'error', t.error) order by t.solicitado_at desc)
                         from trabajo t where t.referencia_id = p.id and t.tipo in ('emitir_acuerdo_plan', 'emitir_anexo_plan')), '[]'::json) as trabajos,
             (app.plan_modelo_del_plan(p.id) is not null) as modelo,
             coalesce((select not m.texto_validado from plan_modelo_clausulas m where m.id = app.plan_modelo_del_plan(p.id)), false) as sin_validar,
             (app.has_role_on(p.barrio_id, ${ROLES_ADMIN}) and p.estado not in ('rechazado', 'retirado')) as puede
        from plan_pago p join barrio b on b.barrio_id = p.barrio_id
       where p.id = ${planId}
    `);
    const r = rows[0];
    if (!r) rechazar("referencia_inexistente", "Ese plan no existe o no tenés acceso.", "Volvé a la ficha de la unidad.");
    const ultimo = (camino: CaminoDelAcuerdo) => r.trabajos.find((t) => t.tipo === TIPO_DE_TRABAJO[camino]) ?? null;
    const armando = (camino: CaminoDelAcuerdo) => ["encolado", "corriendo"].includes(ultimo(camino)?.estado ?? "");
    // Solo el último pedido en general (code-reviewer): una falla vieja de un camino no tapa un PDF que
    // salió bien después por el otro.
    const masNuevo = r.trabajos[0] ?? null;
    const fallo = masNuevo?.estado === "fallado" ? (masNuevo.error ?? "No se pudo armar el PDF.") : null;
    return {
      documentos: r.documentos.map((d) => ({
        id: d.id,
        clase: d.clase,
        sha256: d.sha256,
        bytes: d.bytes,
        nombre: d.nombre,
        estadoPlan: d.estado_plan,
        registradoEl: d.el,
        registradoPor: d.por,
      })),
      armando: { modelo: armando("modelo"), anexo: armando("anexo") },
      fallo,
      hayModelo: r.modelo,
      modeloSinValidar: r.sin_validar,
      puedeAgregar: r.puede,
    };
  });
}

/** Lo que se lee del plan para agregarle un documento (o pedir su PDF): su barrio, si quien lo pide puede. */
async function planParaSubir(tx: DbConIdentidad, planId: string): Promise<{ readonly barrioId: string }> {
  const { rows } = await tx.execute<{ barrio_id: string; estado: EstadoPlan; puede: boolean }>(sql`
    select barrio_id, estado, app.has_role_on(barrio_id, ${ROLES_ADMIN}) as puede from plan_pago where id = ${planId}
  `);
  const r = rows[0];
  if (!r) rechazar("referencia_inexistente", "Ese plan no existe o no tenés acceso.", "Volvé a la ficha de la unidad.");
  if (!r.puede) rechazar("sin_permiso", "No podés agregar documentos a este plan.", "Lo hace la administración del barrio.");
  if (r.estado === "rechazado" || r.estado === "retirado") {
    rechazar("dato_invalido", "El plan está rechazado o retirado: no lleva documentos nuevos.", "Recargá la ficha de la unidad.");
  }
  return { barrioId: r.barrio_id };
}

/**
 * La clave donde el navegador sube un documento del plan, **antes** de agregarlo (como el adjunto de una
 * gestión). No escribe nada: la clave queda atada al barrio y al plan por `plan_documento_clave_chk` y,
 * al agregar, el servidor lee el objeto y calcula su SHA-256.
 */
export async function prepararSubidaDeDocumentoDelPlan(
  tx: DbConIdentidad,
  parametros: PrepararSubidaDeDocumentoDelPlan,
): Promise<{ readonly storageKey: string; readonly barrioId: string }> {
  const p = prepararSubidaDeDocumentoDelPlanSchema.parse(parametros);
  return enBase(async () => {
    const { barrioId } = await planParaSubir(tx, p.planId);
    return {
      barrioId,
      storageKey: claveDeDocumentoDePlan({ barrioId, planId: p.planId, token: nuevoToken(), contentType: p.contentType as ContentTypeDeComprobante }),
    };
  });
}

/** El barrio de un plan al que quien llama le puede agregar documentos (para verificar la clave antes de leer el objeto). */
export async function barrioDelPlanParaSubir(tx: DbConIdentidad, parametros: { readonly planId: string }): Promise<{ readonly barrioId: string }> {
  const planId = idSchema.parse(parametros.planId);
  return enBase(() => planParaSubir(tx, planId));
}

/**
 * Agrega el firmado o el documento del estudio. El `sha256` y los `bytes` los calcula quien llama
 * **leyendo el objeto subido** (la acción), nunca los manda el navegador.
 */
export async function agregarDocumentoDelPlan(
  tx: DbConIdentidad,
  parametros: AgregarDocumentoDelPlan & { readonly sha256: string; readonly bytes: number; readonly contentType: string },
): Promise<{ readonly documentoId: string }> {
  const p = agregarDocumentoDelPlanSchema.parse(parametros);
  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      select app.plan_agregar_documento(${p.planId}::uuid, ${p.clase}, ${p.clave}, ${parametros.sha256}, ${parametros.bytes}::int,
                                        ${parametros.contentType}, ${p.nombre}, null, null, null, null) as id
    `);
    return { documentoId: rows[0]!.id };
  });
}

/** Registra el PDF que armó el worker (el camino a o el b), con su vista congelada. */
export async function registrarDocumentoGeneradoDelPlan(
  tx: DbConIdentidad,
  parametros: {
    readonly planId: string;
    readonly camino: CaminoDelAcuerdo;
    readonly storageKey: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly vista: VistaAcuerdoPlan;
    readonly motor: string;
    readonly plantillaHash: string;
  },
): Promise<{ readonly documentoId: string }> {
  const clase: ClaseDocumentoPlan = parametros.camino === "modelo" ? "acuerdo" : "anexo";
  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      select app.plan_agregar_documento(${parametros.planId}::uuid, ${clase}, ${parametros.storageKey}, ${parametros.sha256},
                                        ${parametros.bytes}::int, 'application/pdf', null, ${JSON.stringify(parametros.vista)}::jsonb,
                                        ${VERSION_VISTA_ACUERDO_PLAN}, ${parametros.motor}, ${parametros.plantillaHash}) as id
    `);
    return { documentoId: rows[0]!.id };
  });
}

/** Para la descarga: la clave del documento, leída bajo RLS, y el nombre con el que baja (sin el titular). */
export async function prepararDescargaDeDocumentoDelPlan(
  tx: DbConIdentidad,
  parametros: { readonly documentoId: string },
): Promise<{ readonly storageKey: string; readonly nombreArchivo: string; readonly sha256: string }> {
  const id = idSchema.safeParse(parametros.documentoId);
  if (!id.success) rechazar("referencia_inexistente", "Ese documento no existe o no tenés acceso.", "Volvé a la ficha de la unidad.");
  return enBase(async () => {
    const { rows } = await tx.execute<{ clave: string; clase: ClaseDocumentoPlan; manzana: string; lote: string; sha256: string }>(sql`
      select d.storage_key as clave, d.clase, uf.manzana, uf.lote, d.sha256
        from plan_documento d join plan_pago p on p.id = d.plan_id join unidad_funcional uf on uf.id = p.unidad_funcional_id
       where d.id = ${id.data}
    `);
    const d = rows[0];
    if (!d) rechazar("referencia_inexistente", "Ese documento no existe o no tenés acceso.", "Volvé a la ficha de la unidad.");
    const base = { acuerdo: "Acuerdo", anexo: "Anexo", firmado: "Acuerdo-firmado", del_estudio: "Documento-del-estudio" }[d.clase];
    const unidad = etiquetaUnidad(d.manzana, d.lote).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
    return { storageKey: d.clave, nombreArchivo: `${base}-plan-${unidad}${d.clave.slice(d.clave.lastIndexOf("."))}`, sha256: d.sha256 };
  });
}
