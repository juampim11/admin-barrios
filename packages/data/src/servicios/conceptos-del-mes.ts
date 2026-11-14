/**
 * «Conceptos del mes» (encargo 16b, Etapa 1.3): lo que se le pide a cada unidad en un mes, concepto por
 * concepto, y las dos formas nuevas en que un concepto entra al mes sin que nadie lo cargue unidad por
 * unidad:
 *
 *  - **Sola** (`concepto_boleta.modo_mes = 'sola'`): al calcular el mes, el catálogo deja una
 *    aplicación en cada unidad a la que el concepto va —todas, o las de un grupo, que se expande en ese
 *    momento—. Origen `catalogo_sola`.
 *  - **Planilla de usos**: una planilla con unidad, concepto, fecha y cantidad. Queda UNA aplicación por
 *    unidad, concepto y mes, con la cantidad sumada (origen `planilla`), y cada uso en la tabla hija
 *    `concepto_boleta_unidad_uso`, que solo se agrega.
 *
 * Las dos pasan por `app.cbu_antes`, sin atajos: firma quien calcula o quien sube la planilla, y si es
 * un operador valen sus topes. El importe lo resuelve la base (`app.resolver_aplicaciones`). Y
 * `app.validar_emision` v6 (`0084`) verifica que la cantidad de un renglón de planilla sea la suma de
 * sus usos.
 *
 * La planilla es una entrada de terceros: se valida fila por fila, se muestra la vista previa con los
 * errores, y se aplica entera o no se aplica.
 */

import { sql } from "drizzle-orm";
import { sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { idSchema } from "@admin-barrios/shared/consultas";
import {
  aplicarPlanillaDeUsosSchema,
  claveDeUso,
  leerPlanillaUsos,
  MAX_USOS_POR_UNIDAD,
  nombreDeConceptoNormalizado,
  textoDeUsos,
  type AplicarPlanillaDeUsos,
  type ErrorDeFila,
  type OrigenDeAplicacion,
  type UnidadDeUso,
} from "@admin-barrios/shared/conceptos";
import { NOMBRE_BONIFICACION } from "@admin-barrios/shared/devengado";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar, rechazarPeriodoInaccesible, traducirError } from "../errores.ts";
import { ORDEN_NATURAL_U } from "./orden-de-unidades.ts";
import { bonificacionDelMes } from "./devengado.ts";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lo que el catálogo aplica solo
// ────────────────────────────────────────────────────────────────────────────────────────────────

type ConceptoSolo = {
  id: string;
  nombre: string;
  clase: "cargo" | "descuento";
  destinatario: "todas" | "grupo";
  grupo_id: string | null;
  grupo_nombre: string | null;
  valor_id: string | null;
  /** La fecha con que se graba la aplicación: el día 1 del mes, o el día desde el que rige el valor. */
  fecha_hecho: string | null;
  /** El importe fijo del valor, si lo tiene (para avisar de un descuento mayor que la expensa). */
  monto_fijo: string | null;
};

/**
 * Los conceptos activos que se aplican solos, con el valor del mes: **el último que empiece a regir
 * hasta el último día del mes**. No solo el del día 1: un concepto cargado el 14 con vigencia desde el
 * 14 ya vale para ese mes, y exigirle el día 1 trababa el cálculo entero (code-reviewer, 2). La
 * aplicación se graba con la fecha desde la que ese valor rige (o el día 1, si ya regía), que es la
 * que `app.cbu_antes` usa para congelar el valor.
 */
async function conceptosSolos(tx: DbConIdentidad, barrioId: string, mes: string): Promise<ConceptoSolo[]> {
  const { rows } = await tx.execute<ConceptoSolo>(sql`
    select cb.id, cb.nombre, cb.clase::text as clase, cb.destinatario, cb.grupo_id, g.nombre as grupo_nombre,
           v.id as valor_id, greatest(v.vigente_desde, ${`${mes}-01`}::date)::text as fecha_hecho,
           v.monto_fijo::numeric(14,2)::text as monto_fijo
      from concepto_boleta cb
      left join grupo_unidades g on g.id = cb.grupo_id
      left join lateral (
        select x.id, x.vigente_desde, x.monto_fijo from concepto_boleta_valor x
         where x.concepto_boleta_id = cb.id
           and x.vigente_desde < (${`${mes}-01`}::date + interval '1 month')
           and (x.vigente_hasta is null or x.vigente_hasta > ${`${mes}-01`}::date)
         order by x.vigente_desde desc limit 1
      ) v on true
     where cb.barrio_id = ${barrioId} and cb.activo and cb.modo_mes = 'sola' and cb.regla_barrio is null
     order by cb.orden_impresion, cb.nombre
  `);
  return rows;
}

/** Las unidades activas a las que va un concepto que se aplica solo: todas, o las del grupo. */
async function unidadesDelConcepto(tx: DbConIdentidad, barrioId: string, c: ConceptoSolo): Promise<string[]> {
  const { rows } =
    c.destinatario === "grupo"
      ? await tx.execute<{ id: string }>(sql`
          select u.id from grupo_unidades_miembro m join unidad_funcional u on u.id = m.unidad_funcional_id
           where m.grupo_id = ${c.grupo_id} and u.baja_at is null
        `)
      : await tx.execute<{ id: string }>(sql`select id from unidad_funcional where barrio_id = ${barrioId} and baja_at is null`);
  return rows.map((r) => r.id);
}

/**
 * Al calcular el mes: deja aplicado cada concepto que se aplica solo, en las unidades a las que va, y
 * solo en ellas. Es la misma conciliación que la bonificación por pago en término: una aplicación no
 * se borra ni se edita, así que se anula (con motivo) la que ya no corresponde y se agrega la que
 * falta. Volver a calcular sin cambios no toca nada.
 *
 * Corre dentro de `generarLiquidaciones`, después de la bonificación y antes de
 * `app.resolver_aplicaciones`. Cada alta pasa por `app.cbu_antes`.
 */
export async function aplicarConceptosSolos(
  tx: DbConIdentidad,
  parametros: { readonly periodoId: string; readonly barrioId: string; readonly mes: string },
): Promise<void> {
  const { periodoId, barrioId, mes } = parametros;
  const conceptos = await conceptosSolos(tx, barrioId, mes);
  // Lo vivo en el mes: lo que aplicó el catálogo, y lo cargado a mano de un concepto que hoy se aplica solo.
  const { rows: vivas } = await tx.execute<{ id: string; concepto_id: string; unidad_funcional_id: string; valor_id: string; del_catalogo: boolean }>(sql`
    select c.id, c.concepto_boleta_id as concepto_id, c.unidad_funcional_id, c.valor_id, (c.origen_evaluacion = 'catalogo_sola') as del_catalogo
      from concepto_boleta_unidad c
      join concepto_boleta cb on cb.id = c.concepto_boleta_id
     where c.periodo_id = ${periodoId} and c.anulado_at is null
       and (c.origen_evaluacion = 'catalogo_sola' or (cb.modo_mes = 'sola' and cb.regla_barrio is null and cb.activo))
  `);
  if (conceptos.length === 0 && vivas.length === 0) return;

  const anular = async (ids: readonly string[], motivo: string) => {
    if (ids.length === 0) return;
    await tx.execute(sql`
      update concepto_boleta_unidad
         set anulado_at = now(), anulado_por = app.current_user_id(), motivo_anulacion = ${motivo}
       where id = any(${sql.param(ids)}::uuid[]) and anulado_at is null
    `);
  };

  // Antes de escribir nada: todo concepto que se aplica solo tiene que tener un valor para el mes.
  const sinValor = conceptos.find((c) => c.valor_id === null);
  if (sinValor) {
    rechazar(
      "periodo_incompleto",
      `El concepto «${sinValor.nombre}» se aplica solo y no tiene un valor que rija este mes.`,
      "Cargale el valor en Configuración → Conceptos del barrio, o desactivalo.",
    );
  }
  const idsSolos = new Set(conceptos.map((c) => c.id));
  // Lo que el catálogo había aplicado de un concepto que dejó de aplicarse solo (o se desactivó).
  await anular(
    vivas.filter((v) => v.del_catalogo && !idsSolos.has(v.concepto_id)).map((v) => v.id),
    "El concepto ya no se aplica solo.",
  );
  // Lo cargado a mano de un concepto que se aplica solo: lo reemplaza la aplicación del catálogo.
  await anular(
    vivas.filter((v) => !v.del_catalogo).map((v) => v.id),
    "El concepto se aplica solo: la aplicación la hace el catálogo al calcular el mes.",
  );

  for (const c of conceptos) {
    const van = new Set(await unidadesDelConcepto(tx, barrioId, c));
    const suyas = vivas.filter((v) => v.del_catalogo && v.concepto_id === c.id);
    await anular(
      suyas.filter((v) => !van.has(v.unidad_funcional_id) || v.valor_id !== c.valor_id).map((v) => v.id),
      "La unidad ya no recibe el concepto con lo que hay al calcular.",
    );
    const quedan = new Set(suyas.filter((v) => van.has(v.unidad_funcional_id) && v.valor_id === c.valor_id).map((v) => v.unidad_funcional_id));
    const faltan = [...van].filter((u) => !quedan.has(u));
    if (faltan.length === 0) continue;
    // Un descuento de importe fijo no puede ser más que la expensa común de la unidad
    // (`cbu_no_supera_base_chk`): la base lo rechazaría sin decir cuál (code-reviewer, 3).
    if (c.clase === "descuento" && c.monto_fijo !== null) {
      const { rows: chicas } = await tx.execute<{ manzana: string; lote: string; n: number }>(sql`
        select u.manzana, u.lote, count(*) over ()::int as n
          from liquidacion l join unidad_funcional u on u.id = l.unidad_funcional_id
         where l.periodo_id = ${periodoId} and l.unidad_funcional_id = any(${sql.param(faltan)}::uuid[])
           and l.subtotal_cuota_fija + l.subtotal_ordinarias < ${c.monto_fijo}::numeric
         order by ${ORDEN_NATURAL_U} limit 3
      `);
      if (chicas.length > 0) {
        const n = chicas[0]!.n;
        rechazar(
          "periodo_incompleto",
          `El descuento «${c.nombre}» es mayor que la expensa de ${n === 1 ? "una unidad" : `${n} unidades`} ` +
            `(${chicas.map((u) => etiquetaUnidad(u.manzana, u.lote)).join(", ")}${n > 3 ? "…" : ""}).`,
          "Bajale el importe en Configuración → Conceptos del barrio, o sacá esas unidades del grupo.",
        );
      }
    }
    const detalle = c.destinatario === "grupo" ? `Grupo: ${c.grupo_nombre ?? "sin nombre"}` : "Todas las unidades";
    try {
      // `confirmacion_monto_inusual` va en verdadero: el importe lo fijó la administración en el
      // catálogo, no lo tipeó nadie ahora. El tope del operador NO se levanta con esto (`0025`).
      await tx.execute(sql`
        insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id, fecha_hecho, detalle,
                                            origen_evaluacion, confirmacion_monto_inusual)
        select ${periodoId}, u, ${c.id}, ${c.fecha_hecho}::date, ${detalle}, 'catalogo_sola', true
          from unnest(${sql.param(faltan)}::uuid[]) as u
      `);
    } catch (e) {
      const traducido = traducirError(e);
      if (traducido.codigo === "tope_operador" || traducido.codigo === "sin_limite_de_aplicacion" || traducido.codigo === "concepto_requiere_admin") {
        rechazar(
          "tope_operador",
          traducido.codigo === "concepto_requiere_admin"
            ? `El concepto «${c.nombre}», que se aplica solo, lo aplica solamente un administrador del barrio.`
            : `El concepto «${c.nombre}», que se aplica solo, supera lo que un operador puede aplicar en este barrio.`,
          "Emití con un usuario administrador del barrio, o pedile que cargue o suba el tope del operador.",
          undefined,
          e,
        );
      }
      throw traducido;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La planilla de usos
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que una unidad usó de un concepto según la planilla, ya sumado. */
export type RenglonDeUsos = {
  readonly unidadFuncionalId: string;
  readonly unidad: string;
  readonly conceptoBoletaId: string;
  readonly concepto: string;
  readonly unidadUso: UnidadDeUso | null;
  /** Los usos de ESTA planilla. */
  readonly usos: readonly { readonly fila: number; readonly fecha: string; readonly cantidad: string }[];
  /** La cantidad de esta planilla. */
  readonly cantidad: string;
  /** Lo que ya había cargado de planillas anteriores del mes para esta unidad y concepto. */
  readonly cantidadAnterior: string;
  /** La cantidad con que queda el renglón de la boleta: lo anterior más lo de esta planilla. */
  readonly cantidadTotal: string;
  /** La fecha del último uso del mes: a esa fecha se toma el precio y con ella se graba el renglón. */
  readonly fechaDelPrecio: string;
  readonly precioUnitario: Monto;
  /** `precio × cantidadTotal`: lo que va a decir la boleta. */
  readonly importe: Monto;
};

export type VistaPreviaDeUsos = {
  readonly archivo: string;
  readonly filasLeidas: number;
  readonly renglones: readonly RenglonDeUsos[];
  /** Todos los errores, por fila. Con uno solo, la planilla no se aplica. */
  readonly errores: readonly ErrorDeFila[];
  /** La suma de los importes de los renglones. */
  readonly total: Monto;
};

/** Hasta cuántos meses antes del mes que se liquida puede ser un uso. */
const MESES_DE_USOS_HACIA_ATRAS = 3;
/** El primer día del mes que está `n` meses antes de `periodo` (`YYYY-MM`). */
const mesesAtras = (periodo: string, n: number): string => {
  const [a = 0, m = 0] = periodo.split("-").map(Number);
  const total = a * 12 + (m - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
};
const fechaCorta = (iso: string): string => iso.split("-").reverse().join("/");

const sumarCantidades = (cantidades: readonly string[]): string => {
  // Milésimas enteras: las cantidades tienen hasta tres decimales (`numeric(12,3)`).
  const total = cantidades.reduce((a, c) => {
    const [ent = "0", dec = ""] = c.split(".");
    return a + BigInt(ent) * 1000n + BigInt(dec.padEnd(3, "0").slice(0, 3));
  }, 0n);
  const dec = (total % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return dec === "" ? (total / 1000n).toString() : `${total / 1000n}.${dec}`;
};

async function periodoParaCargar(
  tx: DbConIdentidad,
  periodoId: string,
  trabar = false,
): Promise<{ barrioId: string; periodo: string; hoy: string }> {
  const { rows } = await tx.execute<{ barrio_id: string; periodo: string; estado: string; puede: boolean; hoy: string }>(sql`
    select p.barrio_id, p.periodo, p.estado::text as estado,
           app.has_role_on(p.barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) as puede,
           (select (now() at time zone b.zona_horaria)::date::text from barrio b where b.barrio_id = p.barrio_id) as hoy
      from periodo_expensa p where p.id = ${periodoId}
  `);
  const p = rows[0];
  if (!p) rechazarPeriodoInaccesible();
  if (p.estado !== "borrador" && p.estado !== "revisada") {
    rechazar("periodo_no_editable", "El mes ya está emitido: no se le cargan usos.", "Los usos que falten van en el mes siguiente.", { estado: p.estado });
  }
  if (!p.puede) {
    rechazar("sin_permiso", "No tenés permiso para cargar usos en este barrio.", "Los carga la administración del barrio o un operador.");
  }
  // Al aplicar, UN escritor por mes: el mismo candado que toma el cálculo (`generar`, `liquidacion.ts`).
  // Dos subidas a la vez (un doble clic) pasarían las dos el control de «ya aplicada» y duplicarían los
  // usos; así la segunda espera y encuentra lo que dejó la primera (panel `security-engineer`, 1).
  if (trabar) await tx.execute(sql`select 1 from periodo_expensa where id = ${periodoId} for no key update`);
  return { barrioId: p.barrio_id, periodo: p.periodo, hoy: p.hoy };
}

/**
 * Arma la vista previa de una planilla de usos: lo que quedaría en cada boleta y **todos** los errores,
 * por fila. No escribe nada. Además de la forma de cada fila (`leerPlanillaUsos`), verifica contra la
 * base que la unidad exista y esté activa, que el concepto sea del barrio, esté activo y se cobre por
 * uso, que tenga un precio a la fecha del último uso, y que una unidad no pase de 100 usos de un
 * concepto en el mes (el tope del renglón de la boleta).
 */
async function armarVistaPrevia(
  tx: DbConIdentidad,
  periodoId: string,
  periodo: { readonly barrioId: string; readonly periodo: string; readonly hoy: string },
  archivo: string,
  filas: readonly (readonly string[])[],
): Promise<VistaPreviaDeUsos> {
  const { barrioId } = periodo;
  const leida = leerPlanillaUsos(filas);
  const errores: ErrorDeFila[] = [...leida.errores];
  /*
   * **La fecha de un uso fija el precio** (el renglón congela el valor vigente a la fecha del último
   * uso), así que no puede ser cualquiera (panel `security-engineer`, 2): ni posterior a hoy —un error
   * de tipeo, «2062», congelaría un aumento programado que todavía no rige— ni anterior a tres meses
   * antes del mes que se liquida —una planilla con fechas viejas cobraría el precio viejo—.
   */
  const desde = mesesAtras(periodo.periodo, MESES_DE_USOS_HACIA_ATRAS);
  const enVentana = (u: { fila: number; fecha: string }): boolean => {
    if (u.fecha > periodo.hoy) errores.push({ fila: u.fila, mensaje: `La fecha ${fechaCorta(u.fecha)} es posterior a hoy: un uso se carga después de ocurrido.` });
    else if (u.fecha < desde) errores.push({ fila: u.fila, mensaje: `La fecha ${fechaCorta(u.fecha)} es demasiado vieja para este mes: se cargan usos desde el ${fechaCorta(desde)}.` });
    else return true;
    return false;
  };

  const { rows: unidades } = await tx.execute<{ id: string; manzana: string; lote: string }>(sql`
    select id, manzana, lote from unidad_funcional where barrio_id = ${barrioId} and baja_at is null
  `);
  const unidadDe = new Map(unidades.map((u) => [`${u.manzana.trim().toUpperCase()}|${u.lote.trim().toUpperCase()}`, u]));
  const { rows: conceptos } = await tx.execute<{ id: string; nombre: string; metodo: string; activo: boolean; unidad_uso: UnidadDeUso | null; modo_mes: string | null }>(sql`
    select id, nombre, metodo::text as metodo, activo, unidad_uso, modo_mes from concepto_boleta where barrio_id = ${barrioId}
  `);
  const conceptoDe = new Map(conceptos.map((c) => [nombreDeConceptoNormalizado(c.nombre), c]));
  // Dos conceptos que solo difieren en acentos o mayúsculas: la planilla no puede decir cuál es.
  const repetidos = new Set(
    conceptos.map((c) => nombreDeConceptoNormalizado(c.nombre)).filter((n, i, todos) => todos.indexOf(n) !== i),
  );

  // Se agrupa por unidad y concepto: un renglón de boleta por cada par.
  const grupos = new Map<string, { unidad: (typeof unidades)[number]; concepto: (typeof conceptos)[number]; usos: { fila: number; fecha: string; cantidad: string }[] }>();
  for (const u of leida.usos) {
    const unidad = unidadDe.get(`${u.manzana.toUpperCase()}|${u.lote.toUpperCase()}`);
    const concepto = conceptoDe.get(nombreDeConceptoNormalizado(u.concepto));
    if (!enVentana(u)) continue;
    if (!unidad) errores.push({ fila: u.fila, mensaje: `La unidad ${etiquetaUnidad(u.manzana, u.lote)} no existe en el barrio o está dada de baja.` });
    else if (repetidos.has(nombreDeConceptoNormalizado(u.concepto))) {
      errores.push({ fila: u.fila, mensaje: `Hay más de un concepto del barrio que se llama «${u.concepto}» (difieren en acentos o mayúsculas): renombrá uno antes de cargar la planilla.` });
    } else if (!concepto) errores.push({ fila: u.fila, mensaje: `El concepto «${u.concepto}» no está en los conceptos del barrio.` });
    else if (!concepto.activo) errores.push({ fila: u.fila, mensaje: `El concepto «${concepto.nombre}» está desactivado.` });
    else if (concepto.metodo !== "precio_x_cantidad") errores.push({ fila: u.fila, mensaje: `El concepto «${concepto.nombre}» no se cobra por uso: no entra por planilla.` });
    else {
      const clave = claveDeUso(unidad.manzana, unidad.lote, concepto.nombre);
      const g = grupos.get(clave) ?? { unidad, concepto, usos: [] };
      g.usos.push({ fila: u.fila, fecha: u.fecha, cantidad: u.cantidad });
      grupos.set(clave, g);
    }
  }

  // Lo que ya entró por planillas anteriores de este mes, para sumar y para no pasar el tope.
  const { rows: anteriores } = await tx.execute<{ unidad_funcional_id: string; concepto_id: string; cantidad: string; ultima: string | null }>(sql`
    select c.unidad_funcional_id, c.concepto_boleta_id as concepto_id, trim_scale(c.cantidad)::text as cantidad,
           (select max(s.fecha)::text from concepto_boleta_unidad_uso s where s.aplicacion_id = c.id) as ultima
      from concepto_boleta_unidad c
     where c.periodo_id = ${periodoId} and c.anulado_at is null and c.origen_evaluacion = 'planilla'
  `);
  const anteriorDe = new Map(anteriores.map((a) => [`${a.unidad_funcional_id}|${a.concepto_id}`, a]));

  // El precio de un concepto a una fecha, una consulta por (concepto, fecha) y no por renglón.
  const precios = new Map<string, string | null>();
  const precioA = async (conceptoBoletaId: string, fecha: string): Promise<string | null> => {
    const clave = `${conceptoBoletaId}|${fecha}`;
    if (!precios.has(clave)) {
      const { rows: precio } = await tx.execute<{ precio: string | null }>(sql`
        select v.precio_unitario::numeric(14,2)::text as precio from concepto_boleta_valor v
         where v.concepto_boleta_id = ${conceptoBoletaId}
           and v.vigente_desde <= ${fecha}::date and (v.vigente_hasta is null or v.vigente_hasta > ${fecha}::date)
         order by v.vigente_desde desc limit 1
      `);
      precios.set(clave, precio[0]?.precio ?? null);
    }
    return precios.get(clave) ?? null;
  };

  // Un uso igual a uno ya cargado en el mes (misma unidad, concepto, fecha y cantidad) es la misma
  // planilla subida con otro nombre, o una fila repetida: cargarlo de nuevo cobraría dos veces.
  const { rows: cargados } = await tx.execute<{ clave: string }>(sql`
    select c.unidad_funcional_id || '|' || c.concepto_boleta_id || '|' || s.fecha::text || '|' || trim_scale(s.cantidad)::text as clave
      from concepto_boleta_unidad_uso s join concepto_boleta_unidad c on c.id = s.aplicacion_id
     where c.periodo_id = ${periodoId} and c.anulado_at is null
  `);
  const yaCargado = new Set(cargados.map((c) => c.clave));
  for (const [clave, g] of grupos) {
    const nuevos = g.usos.filter((u) => {
      if (!yaCargado.has(`${g.unidad.id}|${g.concepto.id}|${u.fecha}|${u.cantidad}`)) return true;
      errores.push({
        fila: u.fila,
        mensaje: `${etiquetaUnidad(g.unidad.manzana, g.unidad.lote)} ya tiene cargado ese uso de «${g.concepto.nombre}» del ${fechaCorta(u.fecha)} en este mes.`,
      });
      return false;
    });
    if (nuevos.length === 0) grupos.delete(clave);
    else g.usos = nuevos;
  }

  const renglones: (Omit<RenglonDeUsos, "importe"> & { importe: Monto | null })[] = [];
  for (const g of grupos.values()) {
    const anterior = anteriorDe.get(`${g.unidad.id}|${g.concepto.id}`);
    // El precio es UNO por renglón: el que rige a la fecha del ÚLTIMO uso del mes, contando los que ya
    // estaban cargados. Es la misma fecha con que se graba la aplicación: lo que se ve es lo que queda.
    const ultima = [...g.usos.map((u) => u.fecha), ...(anterior?.ultima ? [anterior.ultima] : [])].sort().at(-1)!;
    const precioUnitario = await precioA(g.concepto.id, ultima);
    if (precioUnitario === null) {
      for (const u of g.usos) errores.push({ fila: u.fila, mensaje: `El concepto «${g.concepto.nombre}» no tiene precio al ${u.fecha.split("-").reverse().join("/")}.` });
      continue;
    }
    const cantidad = sumarCantidades(g.usos.map((u) => u.cantidad));
    const cantidadAnterior = anterior?.cantidad ?? "0";
    const cantidadTotal = sumarCantidades([cantidad, cantidadAnterior]);
    if (Number(cantidadTotal) > MAX_USOS_POR_UNIDAD) {
      errores.push({
        fila: g.usos[0]!.fila,
        mensaje: `${etiquetaUnidad(g.unidad.manzana, g.unidad.lote)} suma ${textoDeUsos(cantidadTotal, g.concepto.unidad_uso)} de «${g.concepto.nombre}» en el mes: el máximo por unidad es ${MAX_USOS_POR_UNIDAD}.`,
      });
      continue;
    }
    renglones.push({
      unidadFuncionalId: g.unidad.id,
      unidad: etiquetaUnidad(g.unidad.manzana, g.unidad.lote),
      conceptoBoletaId: g.concepto.id,
      concepto: g.concepto.nombre,
      unidadUso: g.concepto.unidad_uso,
      usos: g.usos,
      cantidad,
      cantidadAnterior,
      cantidadTotal,
      fechaDelPrecio: ultima,
      precioUnitario: precioUnitario as Monto,
      importe: null,
    });
  }
  // Los importes, en UNA consulta y con la aritmética de la base (la misma de `app.cbu_importe_bruto`).
  if (renglones.length > 0) {
    const { rows: importes } = await tx.execute<{ i: number; importe: string }>(sql`
      select x.i, round(x.precio * x.cantidad, 2)::numeric(14,2)::text as importe
        from jsonb_to_recordset(${JSON.stringify(renglones.map((r, i) => ({ i, precio: r.precioUnitario, cantidad: r.cantidadTotal })))}::jsonb)
             as x(i integer, precio numeric, cantidad numeric)
    `);
    for (const f of importes) renglones[f.i]!.importe = f.importe as Monto;
  }
  const completos = renglones.map((r) => ({ ...r, importe: r.importe ?? ("0.00" as Monto) }));

  // La misma planilla dos veces duplicaría los usos.
  const { rows: repetida } = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from concepto_boleta_unidad_uso u join concepto_boleta_unidad c on c.id = u.aplicacion_id
     where c.periodo_id = ${periodoId} and c.anulado_at is null and lower(u.archivo) = lower(${archivo})
  `);
  if ((repetida[0]?.n ?? 0) > 0) {
    errores.unshift({ fila: 1, mensaje: `La planilla «${archivo}» ya se aplicó en este mes. Si es otra, cambiale el nombre al archivo.` });
  }

  return {
    archivo,
    filasLeidas: leida.usos.length + leida.errores.length,
    renglones: completos,
    errores: errores.sort((a, b) => a.fila - b.fila),
    total: sumarMontos("0.00", ...completos.map((r) => r.importe)),
  };
}

/** La vista previa de una planilla de usos: no escribe nada. La pueden pedir quienes aplican cargos. */
export async function vistaPreviaDePlanillaDeUsos(tx: DbConIdentidad, parametros: AplicarPlanillaDeUsos): Promise<VistaPreviaDeUsos> {
  const p = aplicarPlanillaDeUsosSchema.parse(parametros);
  return enBase(async () => {
    const periodo = await periodoParaCargar(tx, p.periodoId);
    return armarVistaPrevia(tx, p.periodoId, periodo, p.archivo, p.filas);
  });
}

export type PlanillaDeUsosAplicada = { readonly renglones: number; readonly usos: number; readonly total: Monto };

/**
 * Aplica la planilla: **entera o nada**. Con un solo error no se carga ninguna fila.
 *
 * Por cada unidad y concepto queda UNA aplicación con origen `planilla` y la cantidad sumada. Si ya
 * había una de una planilla anterior del mes, se anula (con motivo) y la nueva lleva sus usos más los
 * de esta: una aplicación no se edita. Cada uso queda en `concepto_boleta_unidad_uso`, con la planilla
 * de la que vino.
 *
 * Si los cargos de una unidad superan lo habitual, la base rechaza con `cargo_requiere_confirmacion`
 * y se reintenta con `confirmarMontoInusual` (el tope del operador no se levanta con eso).
 */
export async function aplicarPlanillaDeUsos(tx: DbConIdentidad, parametros: AplicarPlanillaDeUsos): Promise<PlanillaDeUsosAplicada> {
  const p = aplicarPlanillaDeUsosSchema.parse(parametros);
  return enBase(async () => {
    const periodo = await periodoParaCargar(tx, p.periodoId, true);
    const vista = await armarVistaPrevia(tx, p.periodoId, periodo, p.archivo, p.filas);
    if (vista.errores.length > 0) {
      rechazar(
        "dato_invalido",
        `La planilla tiene ${vista.errores.length === 1 ? "una fila con un error" : `${vista.errores.length} errores`}: no se cargó nada.`,
        "Corregí la planilla y volvé a subirla. Se carga entera o no se carga.",
        { errores: String(vista.errores.length) },
      );
    }
    if (vista.renglones.length === 0) rechazar("dato_invalido", "La planilla no tiene usos para cargar.", "Revisá el archivo.");

    let usos = 0;
    for (const r of vista.renglones) {
      // Lo que ya había de planillas anteriores para esta unidad y concepto: se anula y sus usos pasan
      // al renglón nuevo (copiados, con la planilla de la que vinieron).
      const { rows: previas } = await tx.execute<{ id: string }>(sql`
        select id from concepto_boleta_unidad
         where periodo_id = ${p.periodoId} and unidad_funcional_id = ${r.unidadFuncionalId} and concepto_boleta_id = ${r.conceptoBoletaId}
           and origen_evaluacion = 'planilla' and anulado_at is null
      `);
      const idsPrevias = previas.map((x) => x.id);
      const { rows: usosPrevios } = idsPrevias.length
        ? await tx.execute<{ fecha: string; cantidad: string; archivo: string; fila: number | null }>(sql`
            select fecha::text, cantidad::text, archivo, fila from concepto_boleta_unidad_uso
             where aplicacion_id = any(${sql.param(idsPrevias)}::uuid[]) order by fecha, created_at
          `)
        : { rows: [] };
      if (idsPrevias.length > 0) {
        await tx.execute(sql`
          update concepto_boleta_unidad
             set anulado_at = now(), anulado_por = app.current_user_id(),
                 motivo_anulacion = ${`Reemplazada al sumar la planilla «${p.archivo}».`}
           where id = any(${sql.param(idsPrevias)}::uuid[]) and anulado_at is null
        `);
      }
      const { rows: nueva } = await tx.execute<{ id: string }>(sql`
        insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id, fecha_hecho, cantidad, detalle,
                                            origen_evaluacion, confirmacion_monto_inusual)
        values (${p.periodoId}, ${r.unidadFuncionalId}, ${r.conceptoBoletaId}, ${r.fechaDelPrecio}::date, ${r.cantidadTotal}::numeric,
                ${`Usos cargados por planilla (${p.archivo})`.slice(0, 500)}, 'planilla', ${p.confirmarMontoInusual})
        returning id
      `);
      const aplicacionId = nueva[0]?.id;
      if (!aplicacionId) rechazar("desconocido", "No se pudieron cargar los usos.", "Recargá la pantalla y volvé a intentar.");
      const todos = [
        ...usosPrevios.map((u) => ({ fecha: u.fecha, cantidad: u.cantidad, archivo: u.archivo, fila: u.fila })),
        ...r.usos.map((u) => ({ fecha: u.fecha, cantidad: u.cantidad, archivo: p.archivo, fila: u.fila as number | null })),
      ];
      await tx.execute(sql`
        insert into concepto_boleta_unidad_uso (barrio_id, aplicacion_id, fecha, cantidad, archivo, fila)
        select ${periodo.barrioId}, ${aplicacionId}, x.fecha, x.cantidad, x.archivo, x.fila
          from jsonb_to_recordset(${JSON.stringify(todos)}::jsonb) as x(fecha date, cantidad numeric, archivo text, fila integer)
      `);
      usos += r.usos.length;
    }
    return { renglones: vista.renglones.length, usos, total: vista.total };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La pestaña «Conceptos del mes»
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Una unidad dentro de un concepto del mes. */
export type AplicacionDelMes = {
  /** `null` cuando todavía no hay aplicación: un concepto que se aplica solo, antes de calcular el mes. */
  readonly aplicacionId: string | null;
  readonly unidadFuncionalId: string;
  readonly unidad: string;
  /** Con signo: un descuento va en negativo. `null` = todavía no se puede saber (un porcentaje, antes de calcular). */
  readonly importe: Monto | null;
  readonly detalle: string | null;
  /** Los usos, si vino de una planilla. */
  readonly usos: readonly { readonly fecha: string; readonly cantidad: string; readonly archivo: string }[];
  readonly aplicadoPor: string | null;
  /** `YYYY-MM-DD` en la hora del barrio. */
  readonly aplicadoEl: string | null;
};

export type ConceptoDelMes = {
  /** Estable para la pantalla: el concepto y de dónde sale. */
  readonly clave: string;
  readonly conceptoBoletaId: string | null;
  readonly nombre: string;
  readonly clase: "cargo" | "descuento";
  /** De dónde sale: la bonificación por pago en término, el catálogo solo, una planilla, o a mano. */
  readonly origen: "bonificacion" | "sola" | "planilla" | "mano";
  /** A quién va, en palabras: «Todas», «Grupo: Lotes baldíos», «Quien lo usó», «Una unidad», «Las que están al día». */
  readonly aQuien: string;
  readonly unidades: number;
  /** La suma, con signo. `null` si alguna unidad todavía no tiene importe. */
  readonly importe: Monto | null;
  /** La explicación corta de «de dónde sale»: la regla, el archivo y los usos, o quién y cuándo. */
  readonly deDonde: string;
  readonly aplicaciones: readonly AplicacionDelMes[];
};

export type ConceptosDelMes = {
  readonly periodoId: string;
  readonly periodo: string;
  readonly emitido: boolean;
  /** Quien mira puede subir una planilla o aplicar un concepto (y el mes no está emitido). */
  readonly puedeCargar: boolean;
  readonly conceptos: readonly ConceptoDelMes[];
};

type FilaAplicacion = {
  id: string;
  concepto_id: string;
  nombre: string;
  clase: "cargo" | "descuento";
  origen: OrigenDeAplicacion;
  destinatario: string | null;
  grupo_nombre: string | null;
  unidad_uso: UnidadDeUso | null;
  la_anula_el_calculo: boolean;
  unidad_funcional_id: string;
  manzana: string;
  lote: string;
  importe: string | null;
  cantidad: string | null;
  detalle: string;
  por: string | null;
  el: string;
  usos: { fecha: string; cantidad: string; archivo: string }[] | null;
};

/**
 * Lo que se le pide a cada unidad este mes, concepto por concepto (sin la expensa, que la pantalla
 * toma de las boletas del mes). Un renglón por concepto y por origen.
 *
 * Antes de emitir, los conceptos que se aplican solos y la bonificación todavía no tienen
 * aplicaciones (se crean al calcular): se muestran con las unidades a las que van hoy y el importe
 * que se conoce de antemano. Después de emitir, es lo que quedó.
 */
export async function conceptosDelMes(tx: DbConIdentidad, parametros: { readonly periodoId: string }): Promise<ConceptosDelMes> {
  const periodoId = idSchema.parse(parametros.periodoId);
  return enBase(async () => {
    const { rows: periodos } = await tx.execute<{ barrio_id: string; periodo: string; estado: string; puede: boolean }>(sql`
      select p.barrio_id, p.periodo, p.estado::text as estado,
             app.has_role_on(p.barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) as puede
        from periodo_expensa p where p.id = ${periodoId}
    `);
    const p = periodos[0];
    if (!p) rechazarPeriodoInaccesible();
    const emitido = p.estado === "emitida" || p.estado === "distribuida";

    const { rows } = await tx.execute<FilaAplicacion>(sql`
      select c.id, c.concepto_boleta_id as concepto_id, c.nombre_concepto as nombre, c.clase::text as clase,
             c.origen_evaluacion as origen, cb.destinatario, g.nombre as grupo_nombre, cb.unidad_uso,
             (cb.modo_mes is not distinct from 'sola' and cb.regla_barrio is null and cb.activo
              and c.origen_evaluacion not in ('catalogo_sola', 'regla_barrio')) as la_anula_el_calculo,
             c.unidad_funcional_id, u.manzana, u.lote,
             -- Resuelto si el mes ya se calculó; si no, lo que se sabe sin la base de la boleta.
             coalesce(c.monto_resuelto,
                      case when c.clase = 'descuento' then -1 else 1 end
                      * app.cbu_importe_bruto(c.metodo, c.monto_fijo, c.porcentaje, c.precio_unitario, c.cantidad, null))::numeric(14,2)::text as importe,
             trim_scale(c.cantidad)::text as cantidad, c.detalle,
             (select x.nombre from usuario_demo x where x.user_id = c.aplicado_por) as por,
             to_char(c.aplicado_at at time zone b.zona_horaria, 'YYYY-MM-DD') as el,
             (select json_agg(json_build_object('fecha', s.fecha::text, 'cantidad', trim_scale(s.cantidad)::text, 'archivo', s.archivo) order by s.fecha, s.created_at)
                from concepto_boleta_unidad_uso s where s.aplicacion_id = c.id) as usos
        from concepto_boleta_unidad c
        join concepto_boleta cb on cb.id = c.concepto_boleta_id
        left join grupo_unidades g on g.id = cb.grupo_id
        join unidad_funcional u on u.id = c.unidad_funcional_id
        join barrio b on b.barrio_id = c.barrio_id
       where c.periodo_id = ${periodoId} and c.anulado_at is null
       order by ${ORDEN_NATURAL_U}
    `);

    const origenDe = (o: OrigenDeAplicacion): ConceptoDelMes["origen"] =>
      o === "regla_barrio" ? "bonificacion" : o === "catalogo_sola" ? "sola" : o === "planilla" ? "planilla" : "mano";
    const grupos = new Map<string, FilaAplicacion[]>();
    for (const f of rows) {
      // Antes de emitir, lo que el próximo cálculo va a anular no se muestra ni se suma: el renglón
      // del concepto que se aplica solo ya lo cuenta (code-reviewer, 10).
      if (!emitido && f.la_anula_el_calculo) continue;
      const clave = `${f.concepto_id}|${origenDe(f.origen)}`;
      grupos.set(clave, [...(grupos.get(clave) ?? []), f]);
    }
    const aQuien = (f: { destinatario: string | null; grupo_nombre: string | null }, origen: ConceptoDelMes["origen"]): string =>
      origen === "bonificacion"
        ? "Las que están al día"
        : f.destinatario === "todas"
          ? "Todas"
          : f.destinatario === "grupo"
            ? `Grupo: ${f.grupo_nombre ?? "sin nombre"}`
            : f.destinatario === "por_uso" || origen === "planilla"
              ? "Quien lo usó"
              : "Una unidad";
    const sumar = (importes: readonly (string | null)[]): Monto | null =>
      importes.some((i) => i === null) ? null : sumarMontos("0.00", ...(importes as string[]));

    const conceptos: ConceptoDelMes[] = [...grupos].map(([clave, filas]) => {
      const primera = filas[0]!;
      const origen = origenDe(primera.origen);
      const usos = filas.flatMap((f) => f.usos ?? []);
      const archivos = [...new Set(usos.map((u) => u.archivo))];
      const cantidad = filas.every((f) => f.cantidad !== null) ? sumarCantidades(filas.map((f) => f.cantidad as string)) : null;
      const deDonde =
        origen === "bonificacion"
          ? "Regla del barrio: pago en término"
          : origen === "sola"
            ? "Regla del catálogo: se aplica sola"
            : origen === "planilla"
              ? `${archivos.join(", ")} · ${textoDeUsos(cantidad ?? String(usos.length), primera.unidad_uso)}`
              : filas.length === 1
                ? `${primera.por ?? "Sin nombre"} · ${primera.el.split("-").reverse().join("/")}`
                : `${filas.length} cargas a mano`;
      return {
        clave,
        conceptoBoletaId: primera.concepto_id,
        nombre: origen === "bonificacion" ? NOMBRE_BONIFICACION : primera.nombre,
        clase: primera.clase,
        origen,
        aQuien: aQuien(primera, origen),
        unidades: new Set(filas.map((f) => f.unidad_funcional_id)).size,
        importe: sumar(filas.map((f) => f.importe)),
        deDonde,
        aplicaciones: filas.map((f) => ({
          aplicacionId: f.id,
          unidadFuncionalId: f.unidad_funcional_id,
          unidad: etiquetaUnidad(f.manzana, f.lote),
          importe: f.importe as Monto | null,
          detalle: f.detalle,
          usos: f.usos ?? [],
          aplicadoPor: f.por,
          aplicadoEl: f.el,
        })),
      };
    });

    if (!emitido) {
      // Lo que se va a aplicar solo al calcular: todavía no tiene aplicaciones (o las tiene de un
      // cálculo anterior, que ya están arriba y no se repiten).
      const yaEstan = new Set(conceptos.filter((c) => c.origen === "sola").map((c) => c.conceptoBoletaId));
      for (const c of await conceptosSolos(tx, p.barrio_id, p.periodo)) {
        if (yaEstan.has(c.id)) continue;
        const van = await unidadesDelConcepto(tx, p.barrio_id, c);
        const { rows: unidades } = await tx.execute<{ id: string; manzana: string; lote: string; importe: string | null }>(sql`
          select u.id, u.manzana, u.lote,
                 (select (case when ${c.clase} = 'descuento' then -1 else 1 end * v.monto_fijo)::numeric(14,2)::text
                    from concepto_boleta_valor v where v.id = ${c.valor_id}) as importe
            from unidad_funcional u where u.id = any(${sql.param(van)}::uuid[])
           order by ${ORDEN_NATURAL_U}
        `);
        conceptos.push({
          clave: `${c.id}|sola`,
          conceptoBoletaId: c.id,
          nombre: c.nombre,
          clase: c.clase,
          origen: "sola",
          aQuien: aQuien({ destinatario: c.destinatario, grupo_nombre: c.grupo_nombre }, "sola"),
          unidades: unidades.length,
          importe: sumar(unidades.map((u) => u.importe)),
          deDonde: "Regla del catálogo: se aplica sola al calcular",
          aplicaciones: unidades.map((u) => ({
            aplicacionId: null,
            unidadFuncionalId: u.id,
            unidad: etiquetaUnidad(u.manzana, u.lote),
            importe: u.importe as Monto | null,
            detalle: null,
            usos: [],
            aplicadoPor: null,
            aplicadoEl: null,
          })),
        });
      }
      // La bonificación por pago en término, si el mes la aplica sola y todavía no se calculó.
      if (!conceptos.some((c) => c.origen === "bonificacion")) {
        const bonificacion = await bonificacionDelMes(tx, { periodoId });
        if (bonificacion.modo === "sola") {
          const reciben = bonificacion.unidades.filter((u) => u.recibe);
          conceptos.push({
            clave: "bonificacion",
            conceptoBoletaId: null,
            nombre: NOMBRE_BONIFICACION,
            clase: "descuento",
            origen: "bonificacion",
            aQuien: "Las que están al día",
            unidades: reciben.length,
            importe: null,
            deDonde: `${bonificacion.cuantoTexto ?? "Regla del barrio"} · ${bonificacion.resumen.alDia} al día${
              bonificacion.resumen.excepciones > 0 ? ` y ${bonificacion.resumen.excepciones === 1 ? "1 excepción" : `${bonificacion.resumen.excepciones} excepciones`}` : ""
            }`,
            aplicaciones: reciben.map((u) => ({
              aplicacionId: null,
              unidadFuncionalId: u.unidadFuncionalId,
              unidad: u.etiqueta,
              importe: null,
              detalle: u.excepcion?.tipo === "dar" ? "Otorgada por la administración" : "Al día",
              usos: [],
              aplicadoPor: null,
              aplicadoEl: null,
            })),
          });
        }
      }
    }

    // Orden fijo: la bonificación, lo que se aplica solo, las planillas y lo cargado a mano.
    const peso = { bonificacion: 0, sola: 1, planilla: 2, mano: 3 } as const;
    // Comparación simple y no `localeCompare`: sin ICU completo el orden por idioma no es estable.
    conceptos.sort((a, b) => peso[a.origen] - peso[b.origen] || (a.nombre.toLowerCase() < b.nombre.toLowerCase() ? -1 : a.nombre.toLowerCase() > b.nombre.toLowerCase() ? 1 : 0));
    return { periodoId, periodo: p.periodo, emitido, puedeCargar: p.puede && !emitido, conceptos };
  });
}

/** El total de los conceptos del mes que ya tienen importe, con signo. Para el pie de la pestaña. */
export const totalDeConceptos = (conceptos: readonly ConceptoDelMes[]): Monto =>
  sumarMontos("0.00", ...conceptos.map((c) => c.importe).filter((i): i is Monto => i !== null));
