/**
 * Activar un barrio que ya venía funcionando (encargo 17, Etapa 1.4, `0085`–`0088`).
 *
 * Un barrio nace **sin activar** y no emite. Para activarlo se trae lo que venía de antes: el padrón,
 * los conceptos y la **deuda anterior, mes por mes** —no como un saldo—. La deuda anterior son
 * «períodos históricos» (`periodo_expensa.origen = 'historico'`): liquidaciones emitidas, anteriores al
 * primer mes a devengar, una por unidad, mes y vencimiento. Como son deuda de la cuenta corriente, la
 * imputación, el interés, el estado de cuenta y el arrastre a la primera boleta ya las saben leer.
 *
 * Todo lo que escribe pasa por la base, que es la que decide:
 *   · la carga, por `app.cargar_deuda_historica` (la única puerta; entra entera o no entra, y mientras
 *     el barrio no emita su primer mes, una planilla nueva descarta y reemplaza la anterior);
 *   · la activación, por un `update` de `barrio` que valida y firma `app.barrio_activacion_antes`.
 * Acá se arma la vista previa con los errores por fila, se traduce la planilla a ids y se leen las
 * pantallas. El validador de la planilla es `@admin-barrios/shared/activacion` (regla EX-4: recibe las
 * celdas como texto; el archivo lo lee el servidor con el lector de siempre).
 */

import { sql } from "drizzle-orm";
import {
  activarBarrioSchema,
  cargarDeudaAnteriorSchema,
  claveDeUnidad,
  leerPlanillaDeDeuda,
  type ActivarBarrio,
  type CargarDeudaAnterior,
  type EstadoDeActivacion,
} from "@admin-barrios/shared/activacion";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { nombreDeConceptoNormalizado, type ErrorDeFila } from "@admin-barrios/shared/conceptos";
import { consultaBarrioSchema, consultaUnidadSchema } from "@admin-barrios/shared/consultas";
import { aCentavos, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";
import { deudaALaFecha } from "./deuda.ts";
import { ordenNaturalDeUnidad } from "./orden-de-unidades.ts";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El estado: los pasos del Tablero
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type EstadoDeLaActivacion = {
  readonly activacion: EstadoDeActivacion;
  /** El primer mes que el barrio va a devengar en el sistema, `YYYY-MM`. `null` si no se cargó. */
  readonly primerPeriodo: string | null;
  /** Hoy, en la hora del barrio. */
  readonly hoy: string;
  /** Paso 1: unidades activas del padrón. */
  readonly unidades: number;
  /** Paso 2: conceptos activos del catálogo (los gastos que se reparten más los cargos y descuentos). */
  readonly conceptos: number;
  /** Paso 3: `null` = sin resolver; `cargada` = hay planilla; `sin_deuda` = se dijo que no trae. */
  readonly deudaAnterior: "cargada" | "sin_deuda" | null;
  readonly deudas: number;
  readonly unidadesConDeuda: number;
  readonly totalDeuda: Monto;
  readonly saldosAFavor: number;
  readonly totalAFavor: Monto;
  /** La tasa mensual vigente del barrio hoy (fracción): la que se propone para la deuda anterior. */
  readonly tasaVigente: string;
  /** Si quien mira puede cargar la deuda y activar (la administración del barrio). */
  readonly puedeActivar: boolean;
  /** Si el barrio ya emitió un mes: desde ahí la planilla no se reemplaza. */
  readonly yaEmitio: boolean;
  /** Si la deuda cargada ya tiene cobros o intereses registrados: tampoco se reemplaza. */
  readonly conCobros: boolean;
  /** Datos de la activación, si ya se activó pasando por acá. */
  readonly activadoEl: string | null;
  readonly activadoPor: string | null;
  readonly tasaDeLaDeudaAnterior: string | null;
  readonly motivoDeLaTasa: string | null;
};

/** La tasa vigente del barrio a una fecha: compensatoria más punitoria, o cero si no cobra interés. */
const TASA_VIGENTE = (barrio: ReturnType<typeof sql>, fecha: ReturnType<typeof sql>) => sql`
  (case when (select x.valor from app.parametro_resuelto(${barrio}, 'interes.cobra', ${fecha}) x) = 'true'::jsonb
        then coalesce((select (x.valor #>> '{}')::numeric from app.parametro_resuelto(${barrio}, 'interes.tasa_compensatoria', ${fecha}) x), 0)
           + coalesce((select (x.valor #>> '{}')::numeric from app.parametro_resuelto(${barrio}, 'interes.tasa_punitoria', ${fecha}) x), 0)
        else 0 end)::numeric(12,6)::text`;

/** En qué paso de la activación está el barrio. `null` si no existe o no se ve. */
export async function estadoDeLaActivacion(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string },
): Promise<EstadoDeLaActivacion | null> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);
  const f = (
    await tx.execute<{
      activacion: EstadoDeActivacion;
      primer_periodo: string | null;
      hoy: string;
      unidades: number;
      conceptos: number;
      deuda_anterior_estado: "cargada" | "sin_deuda" | null;
      deudas: number;
      unidades_con_deuda: number;
      total_deuda: string;
      saldos_a_favor: number;
      total_a_favor: string;
      tasa_vigente: string;
      puede: boolean;
      ya_emitio: boolean;
      con_cobros: boolean;
      activado_el: string | null;
      activado_por: string | null;
      tasa: string | null;
      motivo: string | null;
    }>(sql`
      with b as (
        select b.*, (now() at time zone b.zona_horaria)::date as hoy from barrio b where b.barrio_id = ${barrioId}
      ),
      h as (
        select l.id, l.unidad_funcional_id, l.total
          from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
         where pe.barrio_id = ${barrioId} and pe.origen = 'historico'
      )
      select b.activacion, b.primer_periodo, b.hoy::text as hoy,
             (select count(*)::int from unidad_funcional u where u.barrio_id = b.barrio_id and u.baja_at is null) as unidades,
             (select count(*)::int from concepto c where c.barrio_id = b.barrio_id and c.activo)
               + (select count(*)::int from concepto_boleta cb where cb.barrio_id = b.barrio_id and cb.activo) as conceptos,
             b.deuda_anterior_estado,
             (select count(*)::int from item_liquidacion i join h on h.id = i.liquidacion_id) as deudas,
             (select count(distinct h.unidad_funcional_id)::int from h) as unidades_con_deuda,
             (select coalesce(sum(h.total), 0)::numeric(14,2)::text from h) as total_deuda,
             (select count(*)::int from pago p where p.barrio_id = b.barrio_id and p.origen = 'activacion' and p.anulado_at is null) as saldos_a_favor,
             (select coalesce(sum(p.monto), 0)::numeric(14,2)::text from pago p
               where p.barrio_id = b.barrio_id and p.origen = 'activacion' and p.anulado_at is null) as total_a_favor,
             ${TASA_VIGENTE(sql`b.barrio_id`, sql`b.hoy`)} as tasa_vigente,
             app.has_role_on(b.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) as puede,
             exists (select 1 from periodo_expensa pe
                      where pe.barrio_id = b.barrio_id and pe.origen = 'mensual' and pe.estado in ('emitida', 'distribuida')) as ya_emitio,
             (exists (select 1 from h where exists (select 1 from pago_imputacion pi where pi.liquidacion_id = h.id)
                                         or exists (select 1 from interes_devengado d where d.liquidacion_id = h.id))
              or exists (select 1 from pago p where p.barrio_id = b.barrio_id and p.origen = 'activacion'
                            and (exists (select 1 from pago_imputacion pi where pi.pago_id = p.id)
                              or exists (select 1 from pago_imputacion_interes pii where pii.pago_id = p.id)))) as con_cobros,
             b.activacion_fecha::text as activado_el,
             (select x.nombre from usuario_demo x where x.user_id = b.activado_por) as activado_por,
             b.deuda_anterior_tasa::text as tasa, b.deuda_anterior_tasa_motivo as motivo
        from b
    `)
  ).rows[0];
  if (!f) return null;
  return {
    activacion: f.activacion,
    primerPeriodo: f.primer_periodo,
    hoy: f.hoy,
    unidades: f.unidades,
    conceptos: f.conceptos,
    deudaAnterior: f.deuda_anterior_estado,
    deudas: f.deudas,
    unidadesConDeuda: f.unidades_con_deuda,
    totalDeuda: f.total_deuda as Monto,
    saldosAFavor: f.saldos_a_favor,
    totalAFavor: f.total_a_favor as Monto,
    tasaVigente: f.tasa_vigente,
    puedeActivar: f.puede,
    yaEmitio: f.ya_emitio,
    conCobros: f.con_cobros,
    activadoEl: f.activado_el,
    activadoPor: f.activado_por,
    tasaDeLaDeudaAnterior: f.tasa,
    motivoDeLaTasa: f.motivo,
  };
}

async function exigirAdministracion(tx: DbConIdentidad, barrioId: string, que: string): Promise<void> {
  const { rows } = await tx.execute<{ puede: boolean }>(sql`
    select app.has_role_on(${barrioId}::uuid, array['admin_plataforma','admin_barrio']::app.rol_membership[]) as puede
  `);
  if (!rows[0]?.puede) rechazar("sin_permiso", `${que} es de la administración del barrio.`, "Pedíselo a quien administra el barrio.");
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La planilla de deuda: vista previa y carga
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Un renglón de la planilla ya resuelto contra el padrón y el catálogo. */
export type RenglonDeDeudaAnterior = {
  readonly fila: number;
  readonly tipo: "deuda" | "a_favor";
  readonly unidadFuncionalId: string;
  readonly unidad: string;
  /** `YYYY-MM`. `null` en un saldo a favor. */
  readonly periodo: string | null;
  /** El nombre del concepto como está en el catálogo. `null` en un saldo a favor. */
  readonly concepto: string | null;
  readonly vencimiento: string | null;
  /** Lo que falta pagar, o el saldo a favor: siempre positivo. */
  readonly importe: Monto;
};

export type VistaPreviaDeDeudaAnterior = {
  readonly archivo: string;
  readonly filasLeidas: number;
  /** Solo los renglones sin error. */
  readonly renglones: readonly RenglonDeDeudaAnterior[];
  /** Todos los errores, por fila del archivo. Con uno solo no entra ningún renglón. */
  readonly errores: readonly ErrorDeFila[];
  readonly deudas: number;
  readonly totalDeuda: Monto;
  readonly saldosAFavor: number;
  readonly totalAFavor: Monto;
  readonly unidadesConDeuda: number;
  /** Si confirmar reemplaza una carga anterior. */
  readonly reemplaza: boolean;
};

type RenglonParaLaBase = RenglonDeDeudaAnterior & { readonly conceptoId: string | null; readonly conceptoBoletaId: string | null };

async function armarVistaPrevia(
  tx: DbConIdentidad,
  barrioId: string,
  archivo: string,
  filas: readonly (readonly string[])[],
): Promise<VistaPreviaDeDeudaAnterior & { readonly paraLaBase: readonly RenglonParaLaBase[] }> {
  const leida = leerPlanillaDeDeuda(filas);
  const errores: ErrorDeFila[] = [...leida.errores];

  const barrio = (
    await tx.execute<{ primer_periodo: string | null; hoy: string; ya_emitio: boolean; reemplaza: boolean }>(sql`
      select b.primer_periodo, (now() at time zone b.zona_horaria)::date::text as hoy,
             exists (select 1 from periodo_expensa pe
                      where pe.barrio_id = b.barrio_id and pe.origen = 'mensual' and pe.estado in ('emitida', 'distribuida')) as ya_emitio,
             (exists (select 1 from periodo_expensa pe where pe.barrio_id = b.barrio_id and pe.origen = 'historico')
              or exists (select 1 from pago p where p.barrio_id = b.barrio_id and p.origen = 'activacion' and p.anulado_at is null)) as reemplaza
        from barrio b where b.barrio_id = ${barrioId}
    `)
  ).rows[0];
  if (!barrio) rechazar("dato_invalido", "Ese barrio no existe o no tenés acceso.", "Volvé al tablero.");
  if (barrio.primer_periodo === null) {
    errores.unshift({ fila: 1, mensaje: "El barrio no tiene cargado el primer mes a devengar: sin eso no se sabe qué meses son anteriores." });
  }
  if (barrio.ya_emitio) {
    errores.unshift({ fila: 1, mensaje: "El barrio ya emitió su primer mes: la deuda anterior no se reemplaza con otra planilla, se corrige con un ajuste." });
  }

  const { rows: unidades } = await tx.execute<{ id: string; manzana: string; lote: string; saldo_inicial: string }>(sql`
    select id, manzana, lote, saldo_inicial::text as saldo_inicial from unidad_funcional
     where barrio_id = ${barrioId} and baja_at is null
  `);
  const unidadDe = new Map(unidades.map((u) => [claveDeUnidad(u.manzana, u.lote), u]));

  // El catálogo del barrio, los dos juntos: los gastos que se reparten (la expensa, una extraordinaria)
  // y los cargos. Un descuento no es una deuda.
  const { rows: catalogo } = await tx.execute<{ id: string; nombre: string; de: "concepto" | "concepto_boleta" }>(sql`
    select id, nombre, 'concepto' as de from concepto where barrio_id = ${barrioId}
    union all
    select id, nombre, 'concepto_boleta' from concepto_boleta where barrio_id = ${barrioId} and clase::text = 'cargo'
  `);
  const conceptoDe = new Map(catalogo.map((c) => [nombreDeConceptoNormalizado(c.nombre), c]));
  const repetidos = new Set(
    catalogo.map((c) => nombreDeConceptoNormalizado(c.nombre)).filter((n, i, todos) => todos.indexOf(n) !== i),
  );

  const resolverUnidad = (fila: number, manzana: string, lote: string): (typeof unidades)[number] | null => {
    const u = unidadDe.get(claveDeUnidad(manzana, lote));
    if (!u) {
      errores.push({ fila, mensaje: `La unidad ${etiquetaUnidad(manzana, lote)} no está en el padrón del barrio (o está dada de baja).` });
      return null;
    }
    if (aCentavos(u.saldo_inicial) !== 0n) {
      errores.push({
        fila,
        mensaje: `La unidad ${etiquetaUnidad(u.manzana, u.lote)} tiene un saldo inicial cargado: la deuda entra mes por mes o como saldo, no de las dos formas. Poné el saldo inicial en cero.`,
      });
      return null;
    }
    return u;
  };

  const renglones: RenglonParaLaBase[] = [];
  for (const d of leida.deudas) {
    const unidad = resolverUnidad(d.fila, d.manzana, d.lote);
    if (!unidad) continue;
    const nombre = nombreDeConceptoNormalizado(d.concepto);
    const concepto = conceptoDe.get(nombre);
    if (repetidos.has(nombre)) {
      errores.push({ fila: d.fila, mensaje: `Hay más de un concepto del barrio que se llama «${d.concepto}»: renombrá uno antes de cargar la planilla.` });
    } else if (!concepto) {
      errores.push({ fila: d.fila, mensaje: `El concepto «${d.concepto}» no está en los conceptos del barrio: cargalo en Configuración antes de subir la planilla.` });
    } else if (barrio.primer_periodo !== null && d.periodo >= barrio.primer_periodo) {
      errores.push({
        fila: d.fila,
        mensaje: `El mes ${d.periodo.slice(5)}/${d.periodo.slice(0, 4)} no es anterior al primer mes que va a devengar el sistema: la deuda anterior es de meses previos.`,
      });
    } else if (d.vencimiento > barrio.hoy) {
      errores.push({ fila: d.fila, mensaje: "El vencimiento es posterior a hoy: lo que todavía no venció no es deuda anterior." });
    } else if (d.vencimiento < `${d.periodo}-01`) {
      // Un año mal tipeado devengaría años de interés (panel `security-engineer`, M5).
      errores.push({ fila: d.fila, mensaje: "El vencimiento es anterior al mes de la deuda: revisá la fecha (dd/mm/aaaa)." });
    } else {
      renglones.push({
        fila: d.fila,
        tipo: "deuda",
        unidadFuncionalId: unidad.id,
        unidad: etiquetaUnidad(unidad.manzana, unidad.lote),
        periodo: d.periodo,
        concepto: concepto.nombre,
        vencimiento: d.vencimiento,
        importe: d.importe,
        conceptoId: concepto.de === "concepto" ? concepto.id : null,
        conceptoBoletaId: concepto.de === "concepto_boleta" ? concepto.id : null,
      });
    }
  }
  for (const f of leida.aFavor) {
    const unidad = resolverUnidad(f.fila, f.manzana, f.lote);
    if (!unidad) continue;
    renglones.push({
      fila: f.fila,
      tipo: "a_favor",
      unidadFuncionalId: unidad.id,
      unidad: etiquetaUnidad(unidad.manzana, unidad.lote),
      periodo: null,
      concepto: null,
      vencimiento: null,
      importe: f.importe,
      conceptoId: null,
      conceptoBoletaId: null,
    });
  }
  renglones.sort((a, b) => a.fila - b.fila);
  const deudas = renglones.filter((r) => r.tipo === "deuda");
  const aFavor = renglones.filter((r) => r.tipo === "a_favor");
  return {
    archivo,
    filasLeidas: leida.deudas.length + leida.aFavor.length + leida.errores.length,
    renglones: renglones.map(({ conceptoId: _c, conceptoBoletaId: _b, ...r }) => r),
    paraLaBase: renglones,
    errores: errores.sort((a, b) => a.fila - b.fila),
    deudas: deudas.length,
    totalDeuda: sumarMontos("0.00", ...deudas.map((r) => r.importe)),
    saldosAFavor: aFavor.length,
    totalAFavor: sumarMontos("0.00", ...aFavor.map((r) => r.importe)),
    unidadesConDeuda: new Set(deudas.map((r) => r.unidadFuncionalId)).size,
    reemplaza: barrio.reemplaza,
  };
}

/** La vista previa de la planilla de deuda: **no escribe nada**. Devuelve todos los errores, por fila. */
export async function vistaPreviaDeDeudaAnterior(tx: DbConIdentidad, parametros: CargarDeudaAnterior): Promise<VistaPreviaDeDeudaAnterior> {
  const p = cargarDeudaAnteriorSchema.parse(parametros);
  return enBase(async () => {
    await exigirAdministracion(tx, p.barrioId, "Cargar la deuda anterior");
    const { paraLaBase: _p, ...vista } = await armarVistaPrevia(tx, p.barrioId, p.archivo, p.filas);
    return vista;
  });
}

export type DeudaAnteriorCargada = {
  readonly deudas: number;
  readonly unidades: number;
  readonly total: Monto;
  readonly saldosAFavor: number;
  readonly totalAFavor: Monto;
  readonly reemplaza: boolean;
};

type RespuestaDeLaCarga = { deudas: number; unidades: number; total: number | string; saldosAFavor: number; totalAFavor: number | string; reemplaza: boolean };

async function llamarALaCarga(
  tx: DbConIdentidad,
  barrioId: string,
  deudas: readonly unknown[],
  aFavor: readonly unknown[],
  archivo: string | null,
): Promise<DeudaAnteriorCargada> {
  // Los totales se piden como texto con dos decimales: un `numeric` adentro de un jsonb llegaría como
  // número de JavaScript, y la plata no pasa por `number`.
  const { rows } = await tx.execute<{ r: RespuestaDeLaCarga; total: string; total_a_favor: string }>(sql`
    select x.r, (x.r ->> 'total')::numeric(14,2)::text as total, (x.r ->> 'totalAFavor')::numeric(14,2)::text as total_a_favor
      from (select app.cargar_deuda_historica(${barrioId}::uuid, ${JSON.stringify(deudas)}::jsonb, ${JSON.stringify(aFavor)}::jsonb, ${archivo}) as r) x
  `);
  const f = rows[0];
  if (!f) rechazar("desconocido", "No se pudo cargar la deuda anterior.", "Recargá la pantalla y volvé a intentar.");
  return {
    deudas: Number(f.r.deudas),
    unidades: Number(f.r.unidades),
    total: f.total as Monto,
    saldosAFavor: Number(f.r.saldosAFavor),
    totalAFavor: f.total_a_favor as Monto,
    reemplaza: f.r.reemplaza,
  };
}

/**
 * Carga la planilla de deuda: **entera o nada**. Con un solo renglón con error no entra ninguno. Si ya
 * había una carga, la descarta y la reemplaza —mientras el barrio no haya emitido su primer mes ni
 * haya cobros contra esa deuda; la base lo controla—.
 *
 * Cada deuda queda como una línea de una liquidación histórica (una por unidad, mes y vencimiento) y
 * cada saldo a favor, como un cobro sin imputar de origen `activacion`. **Hoy nada lo imputa solo**
 * (la emisión no imputa cobros y no hay pantalla para imputar uno ya registrado): queda en la cuenta de
 * la unidad, a la vista, hasta que se decida cómo se aplica. Ver `HANDOFF.md`, encargo 17.
 */
export async function cargarDeudaAnterior(tx: DbConIdentidad, parametros: CargarDeudaAnterior): Promise<DeudaAnteriorCargada> {
  const p = cargarDeudaAnteriorSchema.parse(parametros);
  return enBase(async () => {
    await exigirAdministracion(tx, p.barrioId, "Cargar la deuda anterior");
    const vista = await armarVistaPrevia(tx, p.barrioId, p.archivo, p.filas);
    if (vista.errores.length > 0) {
      rechazar(
        "dato_invalido",
        `La planilla tiene ${vista.errores.length === 1 ? "un renglón con error" : `${vista.errores.length} errores`}: no se cargó nada.`,
        "Corregí la planilla y volvé a subirla. Se carga entera o no se carga.",
        { errores: String(vista.errores.length) },
      );
    }
    if (vista.paraLaBase.length === 0) {
      rechazar("dato_invalido", "La planilla no tiene ninguna deuda ni saldo a favor.", "Si el barrio no trae deuda, usá «El barrio no trae deuda».");
    }
    return llamarALaCarga(
      tx,
      p.barrioId,
      vista.paraLaBase
        .filter((r) => r.tipo === "deuda")
        .map((r) => ({
          unidad: r.unidadFuncionalId,
          periodo: r.periodo,
          vencimiento: r.vencimiento,
          concepto: r.conceptoId,
          concepto_boleta: r.conceptoBoletaId,
          importe: r.importe,
        })),
      vista.paraLaBase.filter((r) => r.tipo === "a_favor").map((r) => ({ unidad: r.unidadFuncionalId, importe: r.importe })),
      p.archivo,
    );
  });
}

/** «El barrio no trae deuda»: lo deja dicho (y descarta una planilla anterior, si la había). */
export async function declararSinDeudaAnterior(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<DeudaAnteriorCargada> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);
  return enBase(async () => {
    await exigirAdministracion(tx, barrioId, "Decir que el barrio no trae deuda");
    return llamarALaCarga(tx, barrioId, [], [], null);
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Verificar antes de activar
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type MesDeDeudaAnterior = {
  readonly liquidacionId: string;
  /** `YYYY-MM`. */
  readonly periodo: string;
  /** Los conceptos de ese mes y vencimiento, como están en el catálogo. */
  readonly concepto: string;
  readonly vencimiento: string;
  readonly capital: Monto;
  /** El interés a la fecha de la verificación, con la tasa de la deuda anterior. */
  readonly interes: Monto;
};

export type VerificacionDeDeudaAnterior = {
  /** A qué fecha está calculado el interés: hoy, en la hora del barrio. */
  readonly fecha: string;
  /** La tasa mensual con que se calculó (fracción) y la vigente del barrio, para comparar. */
  readonly tasa: string;
  readonly tasaVigente: string;
  readonly capital: Monto;
  readonly interes: Monto;
  readonly unidades: readonly {
    readonly unidadFuncionalId: string;
    readonly unidad: string;
    readonly capital: Monto;
    readonly interes: Monto;
    readonly meses: readonly MesDeDeudaAnterior[];
  }[];
  readonly saldosAFavor: readonly { readonly unidadFuncionalId: string; readonly unidad: string; readonly importe: Monto }[];
};

/**
 * Lo que quedó cargado, para comparar con el sistema anterior antes de activar: capital e interés por
 * unidad, mes por mes. El interés corre de cada vencimiento a hoy con `tasa` (la que la administración
 * está por elegir; si no se pasa, la vigente del barrio). En un barrio ya activado, la tasa es la que
 * quedó guardada y lo que se pase se ignora.
 */
export async function verificacionDeDeudaAnterior(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string; readonly tasa?: string },
): Promise<VerificacionDeDeudaAnterior> {
  const { barrioId } = consultaBarrioSchema.parse({ barrioId: parametros.barrioId });
  const estado = await estadoDeLaActivacion(tx, { barrioId });
  if (!estado) rechazar("dato_invalido", "Ese barrio no existe o no tenés acceso.", "Volvé al tablero.");
  if (parametros.tasa !== undefined && !/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/.test(parametros.tasa)) {
    rechazar("dato_invalido", "La tasa para la deuda anterior no es válida.", "Es un porcentaje mensual entre 0 y 100.", { campo: "tasa" });
  }
  const tasa = estado.tasaDeLaDeudaAnterior ?? parametros.tasa ?? estado.tasaVigente;
  const deuda = await deudaALaFecha(tx, { barrioId, fecha: estado.hoy, tasaDeLaDeudaAnterior: tasa });

  const { rows: lineas } = await tx.execute<{ liquidacion_id: string; concepto: string }>(sql`
    select l.id as liquidacion_id, string_agg(i.descripcion, ' + ' order by i.descripcion) as concepto
      from liquidacion l
      join periodo_expensa pe on pe.id = l.periodo_id
      join item_liquidacion i on i.liquidacion_id = l.id
     where pe.barrio_id = ${barrioId} and pe.origen = 'historico'
     group by l.id
  `);
  const conceptoDe = new Map(lineas.map((l) => [l.liquidacion_id, l.concepto]));
  const { rows: unidades } = await tx.execute<{ id: string; manzana: string; lote: string }>(sql`
    select u.id, u.manzana, u.lote from unidad_funcional u where u.barrio_id = ${barrioId}
     order by ${ordenNaturalDeUnidad(sql`u.manzana`, sql`u.lote`)}
  `);

  const salida: Array<VerificacionDeDeudaAnterior["unidades"][number]> = [];
  for (const u of unidades) {
    const meses = (deuda.get(u.id)?.porMes ?? [])
      .filter((m) => m.origen === "historico")
      .map((m) => ({
        liquidacionId: m.liquidacionId,
        periodo: m.periodo,
        concepto: conceptoDe.get(m.liquidacionId) ?? "",
        vencimiento: m.vencimiento,
        capital: m.capital,
        interes: m.interes,
      }));
    if (meses.length === 0) continue;
    salida.push({
      unidadFuncionalId: u.id,
      unidad: etiquetaUnidad(u.manzana, u.lote),
      capital: sumarMontos("0.00", ...meses.map((m) => m.capital)),
      interes: sumarMontos("0.00", ...meses.map((m) => m.interes)),
      meses,
    });
  }
  const { rows: favor } = await tx.execute<{ id: string; manzana: string; lote: string; importe: string }>(sql`
    select u.id, u.manzana, u.lote, p.monto::numeric(14,2)::text as importe
      from pago p join unidad_funcional u on u.id = p.unidad_funcional_id
     where p.barrio_id = ${barrioId} and p.origen = 'activacion' and p.anulado_at is null
     order by ${ordenNaturalDeUnidad(sql`u.manzana`, sql`u.lote`)}
  `);
  return {
    fecha: estado.hoy,
    tasa,
    tasaVigente: estado.tasaVigente,
    capital: sumarMontos("0.00", ...salida.map((u) => u.capital)),
    interes: sumarMontos("0.00", ...salida.map((u) => u.interes)),
    unidades: salida,
    saldosAFavor: favor.map((f) => ({ unidadFuncionalId: f.id, unidad: etiquetaUnidad(f.manzana, f.lote), importe: f.importe as Monto })),
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Activar
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type BarrioActivado = {
  readonly activadoEl: string;
  readonly primerPeriodo: string;
  /** La tasa mensual que quedó para la deuda anterior (fracción) y la vigente de ese día. */
  readonly tasa: string;
  readonly tasaVigente: string;
};

/**
 * Activa el barrio: desde acá puede emitir. Es **una sola vez** y solo de la administración (lo
 * controla `app.barrio_activacion_antes`, que además firma quién y cuándo y deja el evento en el
 * historial). La tasa para la deuda anterior se elige acá y no se vuelve a tocar: de cada vencimiento
 * a hoy, la deuda anterior devenga con ella; desde mañana, con los parámetros normales del barrio. Si
 * no es la vigente, pide un motivo.
 */
export async function activarBarrio(tx: DbConIdentidad, parametros: ActivarBarrio): Promise<BarrioActivado> {
  const p = activarBarrioSchema.parse(parametros);
  return enBase(async () => {
    await exigirAdministracion(tx, p.barrioId, "Activar el barrio");
    const { rows } = await tx.execute<{ activado_el: string; primer_periodo: string; tasa: string; tasa_vigente: string }>(sql`
      update barrio
         set activacion = 'activo', deuda_anterior_tasa = ${p.tasa}::numeric, deuda_anterior_tasa_motivo = ${p.motivo}
       where barrio_id = ${p.barrioId} and activacion = 'sin_activar'
      returning activacion_fecha::text as activado_el, primer_periodo, deuda_anterior_tasa::text as tasa,
                deuda_anterior_tasa_vigente::text as tasa_vigente
    `);
    const f = rows[0];
    if (!f) rechazar("dato_invalido", "El barrio ya está activado.", "Recargá el tablero.");
    return { activadoEl: f.activado_el, primerPeriodo: f.primer_periodo, tasa: f.tasa, tasaVigente: f.tasa_vigente };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El estado de cuenta: la deuda mes por mes
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type MesAdeudado = {
  readonly liquidacionId: string;
  /** `YYYY-MM`. */
  readonly periodo: string;
  /** En la deuda anterior, los conceptos de la planilla; en un mes del sistema, cómo se llama la expensa (o `null`). */
  readonly concepto: string | null;
  readonly vencimiento: string;
  readonly capital: Monto;
  /** Interés a hoy: el pendiente ya registrado más el que devengó hasta hoy. */
  readonly interes: Monto;
  readonly origen: "mensual" | "historico" | "plan";
};

/** Lo que una unidad debe hoy, mes por mes, del más viejo al más nuevo, con de dónde sale cada uno. */
export async function deudaMesPorMesDeUnidad(
  tx: DbConIdentidad,
  parametros: { readonly unidadFuncionalId: string },
): Promise<{ readonly fecha: string; readonly meses: readonly MesAdeudado[]; readonly capital: Monto; readonly interes: Monto }> {
  const { unidadFuncionalId } = consultaUnidadSchema.parse(parametros);
  const u = (
    await tx.execute<{ barrio_id: string; hoy: string }>(sql`
      select u.barrio_id, (now() at time zone b.zona_horaria)::date::text as hoy
        from unidad_funcional u join barrio b on b.barrio_id = u.barrio_id where u.id = ${unidadFuncionalId}
    `)
  ).rows[0];
  if (!u) rechazar("unidad_no_encontrada", "Esa unidad no existe o no tenés acceso a ella.", "Volvé al padrón del barrio.");
  const deuda = (await deudaALaFecha(tx, { barrioId: u.barrio_id, fecha: u.hoy, unidadFuncionalId })).get(unidadFuncionalId);
  const porMes = deuda?.porMes ?? [];
  const { rows: nombres } = porMes.length
    ? await tx.execute<{ liquidacion_id: string; concepto: string | null }>(sql`
        select l.id as liquidacion_id,
               case when pe.origen = 'historico'
                    then (select string_agg(i.descripcion, ' + ' order by i.descripcion) from item_liquidacion i where i.liquidacion_id = l.id)
                    else pe.denominacion_concepto end as concepto
          from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
         where l.id = any(${sql.param(porMes.map((m) => m.liquidacionId))}::uuid[])
      `)
    : { rows: [] };
  const conceptoDe = new Map(nombres.map((n) => [n.liquidacion_id, n.concepto]));
  const meses = porMes.map((m) => ({
    liquidacionId: m.liquidacionId,
    periodo: m.periodo,
    concepto: conceptoDe.get(m.liquidacionId) ?? null,
    vencimiento: m.vencimiento,
    capital: m.capital,
    interes: m.interes,
    origen: m.origen,
  }));
  return {
    fecha: u.hoy,
    meses,
    capital: sumarMontos("0.00", ...meses.map((m) => m.capital)),
    interes: sumarMontos("0.00", ...meses.map((m) => m.interes)),
  };
}
