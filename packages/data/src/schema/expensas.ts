/**
 * Esquema de EXPENSAS y liquidación mensual. Ver `docs/diseno/01-alcance-modulos.md` §4.2 y
 * `knowledge/cordoba/REQUISITOS-MODELO-DATOS.md` §4.
 *
 * El cálculo vive en `@admin-barrios/shared/liquidacion` (puro y testeado). Acá está el dato y los
 * invariantes que hace cumplir la base:
 *  - una **extraordinaria** exige respaldo de asamblea (art. 2048);
 *  - un período **emitido no se edita** (se corrige en el siguiente);
 *  - no se emite un período **descuadrado** (lo repartido tiene que ser igual al gasto);
 *  - la **mora** sale de una tasa versionada del barrio; si no hay, se liquida capital y se marca.
 */

import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import {
  CLASIFICACIONES_FISCALES,
  ESTADOS_PERIODO,
  MODELOS_EXPENSA,
  TIPOS_CONCEPTO,
  type RedondeoDeCuota,
} from "@admin-barrios/shared/liquidacion";
import { app } from "./tenancy.ts";
import { barrio, documentoBarrio, coeficienteVersion, unidadFuncional, obligado } from "./dominio.ts";

const comoEnum = (valores: readonly string[]) => [...valores] as [string, ...string[]];

export const tipoConcepto = app.enum("tipo_concepto", comoEnum(TIPOS_CONCEPTO));
export const clasificacionFiscal = app.enum("clasificacion_fiscal", comoEnum(CLASIFICACIONES_FISCALES));
export const estadoPeriodo = app.enum("estado_periodo", comoEnum(ESTADOS_PERIODO));
/** De dónde sale una línea de la boleta. Reemplaza al viejo booleano `es_cuota_fija`. */
export const claseItem = app.enum("clase_item", ["prorrateo", "cuota_fija", "cargo", "descuento"]);
export const modeloExpensa = app.enum("modelo_expensa", comoEnum(MODELOS_EXPENSA));

/**
 * Catálogo de conceptos del barrio (seguridad, mantenimiento, fondo de reserva…).
 * La `clasificacion_fiscal` se guarda aunque el módulo contable esté fuera del MVP.
 */
export const concepto = pgTable(
  "concepto",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    nombre: text("nombre").notNull(),
    tipo: tipoConcepto("tipo").notNull(),
    /**
     * Encuadre fiscal del concepto. **Sin default a propósito**: con `no_alcanzado` por default, cada
     * concepto nuevo afirmaba por omisión que no está alcanzado por IIBB — una afirmación fiscal que
     * nadie hizo, contra la regla de no presuponer encuadre (doc 04 §B.1). Ahora hay que declararlo,
     * y `sin_clasificar` es la opción honesta cuando todavía no se sabe.
     */
    clasificacionFiscal: clasificacionFiscal("clasificacion_fiscal").notNull(),
    /** Va a cuenta separada y se muestra aparte en la liquidación (art. 2046 inc. d). */
    esFondoReserva: boolean("es_fondo_reserva").notNull().default(false),
    activo: boolean("activo").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_concepto_barrio_nombre").on(t.barrioId, sql`lower(${t.nombre})`),
    index("idx_concepto_barrio").on(t.barrioId),
  ],
);

/** Tasa de mora **versionada** por barrio (sale del reglamento). Si no hay, no se inventa. */
export const tasaMora = pgTable(
  "tasa_mora",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    /** Mensual, como fracción: 0.03 = 3% mensual. */
    tasaMensual: numeric("tasa_mensual", { precision: 12, scale: 6 }).notNull(),
    vigenteDesde: date("vigente_desde", { mode: "string" }).notNull(),
    vigenteHasta: date("vigente_hasta", { mode: "string" }),
    documentoId: uuid("documento_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_tasa_mora_barrio").on(t.barrioId),
    uniqueIndex("uq_tasa_mora_abierta").on(t.barrioId).where(sql`vigente_hasta is null`),
    check("tasa_mora_positiva_chk", sql`${t.tasaMensual} >= 0`),
    check("tasa_mora_rango_chk", sql`${t.vigenteHasta} is null or ${t.vigenteHasta} >= ${t.vigenteDesde}`),
  ],
);

/**
 * Cuota fija mensual, versionada: la fija el directorio o el administrador y rige hasta que se
 * define otra. Se versiona para poder liquidar un período pasado con la cuota que regía entonces
 * (mismo criterio que los 5 ejes del barrio y que los coeficientes).
 */
export const cuotaFijaVersion = pgTable(
  "cuota_fija_version",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    descripcion: text("descripcion"),
    vigenteDesde: date("vigente_desde", { mode: "string" }).notNull(),
    vigenteHasta: date("vigente_hasta", { mode: "string" }),
    /** Acta de directorio / resolución del administrador que la aprueba. */
    documentoId: uuid("documento_id"),
    aprobadaPor: uuid("aprobada_por"),
    /**
     * Aumento aplicado sobre la versión anterior, en **porcentaje** (`3.2000` = 3,2 %). Es la
     * *explicación* de la cuota, y no se deduce del importe: `null` cuando el número se cargó
     * directo (la primera cuota del barrio, o un ajuste que el directorio fijó en pesos).
     */
    ajustePorcentaje: numeric("ajuste_porcentaje", { precision: 9, scale: 4 }),
    /** A qué se redondeó el resultado del porcentaje. No es formato: cambia lo que se cobra. */
    redondeo: text("redondeo").$type<RedondeoDeCuota>(),
    /** Contra qué versión se aplicó el porcentaje, para poder rehacer la cuenta años después. */
    versionAnteriorId: uuid("version_anterior_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_cuota_fija_version_barrio").on(t.barrioId),
    uniqueIndex("uq_cuota_fija_version_abierta").on(t.barrioId).where(sql`vigente_hasta is null`),
    check("cuota_fija_version_rango_chk", sql`${t.vigenteHasta} is null or ${t.vigenteHasta} >= ${t.vigenteDesde}`),
    check("cuota_fija_version_ajuste_chk", sql`${t.ajustePorcentaje} is null or ${t.versionAnteriorId} is not null`),
    check("cuota_fija_version_anterior_distinta_chk", sql`${t.versionAnteriorId} is null or ${t.versionAnteriorId} <> ${t.id}`),
  ],
);

/** Importe fijo de cada unidad dentro de una versión (todas iguales, o distintas: lo decide el barrio). */
export const cuotaFija = pgTable(
  "cuota_fija",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => cuotaFijaVersion.id, { onDelete: "cascade" }),
    unidadFuncionalId: uuid("unidad_funcional_id")
      .notNull()
      .references(() => unidadFuncional.id, { onDelete: "restrict" }),
    importe: numeric("importe", { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_cuota_fija_version_uf").on(t.versionId, t.unidadFuncionalId),
    index("idx_cuota_fija_barrio").on(t.barrioId),
    check("cuota_fija_importe_chk", sql`${t.importe} >= 0`),
  ],
);

/** Período mensual de expensas de un barrio. */
export const periodoExpensa = pgTable(
  "periodo_expensa",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    /** `YYYY-MM`. */
    periodo: text("periodo").notNull(),
    estado: estadoPeriodo("estado").notNull().default("borrador"),
    /**
     * Cómo se determina lo que paga cada unidad en ESTE período: por los gastos (`variable`) o por
     * la cuota que fijó el directorio (`fija`). Se guarda por período porque un barrio puede
     * cambiar de modelo sin perder la historia de cómo se liquidó cada mes.
     */
    modelo: modeloExpensa("modelo").notNull().default("variable"),
    /** Versión de cuota fija usada (solo modelo `fija`); queda congelada al emitir. */
    cuotaFijaVersionId: uuid("cuota_fija_version_id").references(() => cuotaFijaVersion.id, {
      onDelete: "restrict",
    }),
    /** Versión de coeficientes con la que se liquidó: queda congelada al emitir. */
    coeficienteVersionId: uuid("coeficiente_version_id").references(() => coeficienteVersion.id, {
      onDelete: "restrict",
    }),
    /**
     * Cómo se llama el concepto EN ESTE PERÍODO ("expensa", "cuota social"…). Se congela al liquidar:
     * `barrio.figura_juridica` se versiona, así que si el barrio cambia de figura no puede cambiar
     * retroactivamente la etiqueta de todas las liquidaciones ya emitidas.
     */
    denominacionConcepto: text("denominacion_concepto"),
    primerVencimiento: date("primer_vencimiento", { mode: "string" }),
    segundoVencimiento: date("segundo_vencimiento", { mode: "string" }),
    /** Suma de los gastos cargados. La escribe el servicio al liquidar; la base valida que cuadre. */
    totalGastos: numeric("total_gastos", { precision: 14, scale: 2 }),
    /** Cargos de boleta del período (quincho, invitados…): NO participan del cuadre del prorrateo. */
    totalCargos: numeric("total_cargos", { precision: 14, scale: 2 }),
    /** Descuentos del período, en negativo. Tampoco participan del cuadre. */
    totalDescuentos: numeric("total_descuentos", { precision: 14, scale: 2 }),
    emitidaAt: timestamp("emitida_at", { withTimezone: true }),
    emitidaPor: uuid("emitida_por"),
    distribuidaAt: timestamp("distribuida_at", { withTimezone: true }),
    notas: text("notas"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_periodo_barrio").on(t.barrioId, t.periodo),
    index("idx_periodo_barrio").on(t.barrioId),
    check("periodo_formato_chk", sql`${t.periodo} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      "periodo_vencimientos_chk",
      sql`${t.segundoVencimiento} is null or ${t.primerVencimiento} is null or ${t.segundoVencimiento} >= ${t.primerVencimiento}`,
    ),
  ],
);

/** Un gasto cargado en el período, que se va a prorratear. */
export const gastoPeriodo = pgTable(
  "gasto_periodo",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    periodoId: uuid("periodo_id")
      .notNull()
      .references(() => periodoExpensa.id, { onDelete: "cascade" }),
    conceptoId: uuid("concepto_id")
      .notNull()
      .references(() => concepto.id, { onDelete: "restrict" }),
    descripcion: text("descripcion").notNull(),
    monto: numeric("monto", { precision: 14, scale: 2 }).notNull(),
    /** Proveedor como texto hasta que exista el módulo de proveedores (MVP, más adelante). */
    proveedorNombre: text("proveedor_nombre"),
    comprobante: text("comprobante"),
    /** Acta que respalda una extraordinaria (art. 2048), si la hay. */
    actaDocumentoId: uuid("acta_documento_id").references(() => documentoBarrio.id, { onDelete: "restrict" }),
    /**
     * Extraordinaria cargada **sin** acta. El sistema **no lo impide** (pasa en la operatoria real):
     * lo marca — lo pone el trigger — para que la liquidación y el reclamo sepan que ese gasto no
     * tiene respaldo asambleario. Importa a la hora de reclamar la deuda, no al cargarla.
     */
    sinRespaldoAsamblea: boolean("sin_respaldo_asamblea").notNull().default(false),
    motivoSinRespaldo: text("motivo_sin_respaldo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_gasto_periodo").on(t.periodoId),
    index("idx_gasto_barrio").on(t.barrioId),
    check("gasto_monto_chk", sql`${t.monto} >= 0`),
  ],
);

/** Liquidación de una unidad para un período. */
export const liquidacion = pgTable(
  "liquidacion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    periodoId: uuid("periodo_id")
      .notNull()
      .references(() => periodoExpensa.id, { onDelete: "cascade" }),
    unidadFuncionalId: uuid("unidad_funcional_id")
      .notNull()
      .references(() => unidadFuncional.id, { onDelete: "restrict" }),
    /** A quién se le notifica (el obligado marcado como notificado al momento de liquidar). */
    obligadoId: uuid("obligado_id").references(() => obligado.id, { onDelete: "set null" }),
    coeficienteAplicado: numeric("coeficiente_aplicado", { precision: 18, scale: 9 }).notNull(),
    subtotalCuotaFija: numeric("subtotal_cuota_fija", { precision: 14, scale: 2 }).notNull().default("0.00"),
    /** Cargos de la unidad (quincho, invitados): suman, y no salen de un gasto repartido. */
    subtotalCargos: numeric("subtotal_cargos", { precision: 14, scale: 2 }).notNull().default("0.00"),
    /** Descuentos de la unidad: **negativo**. Sin esta columna el PDF no puede imprimir bruto,
     * descuento y neto, que es lo que hace que el incentivo del descuento funcione. */
    subtotalDescuentos: numeric("subtotal_descuentos", { precision: 14, scale: 2 }).notNull().default("0.00"),
    subtotalOrdinarias: numeric("subtotal_ordinarias", { precision: 14, scale: 2 }).notNull(),
    subtotalExtraordinarias: numeric("subtotal_extraordinarias", { precision: 14, scale: 2 }).notNull(),
    subtotalFondoReserva: numeric("subtotal_fondo_reserva", { precision: 14, scale: 2 }).notNull(),
    /** Identificador legible para el administrador y el propietario (no un UUID). */
    numeroComprobante: text("numero_comprobante"),
    saldoAnterior: numeric("saldo_anterior", { precision: 14, scale: 2 }).notNull().default("0.00"),
    /**
     * De dónde sale el saldo anterior. Mientras no exista el módulo de cobros, es `carga_manual` o
     * `sin_movimientos`: el documento tiene que poder decirlo, no presentarlo como si saliera de una
     * cuenta corriente que todavía no existe.
     */
    saldoAnteriorOrigen: text("saldo_anterior_origen").notNull().default("sin_movimientos"),
    /** NULL con `mora_pendiente_definicion` = el barrio no tiene tasa cargada: no se inventa. */
    interesMora: numeric("interes_mora", { precision: 14, scale: 2 }),
    moraPendienteDefinicion: boolean("mora_pendiente_definicion").notNull().default(false),
    tasaMoraAplicada: numeric("tasa_mora_aplicada", { precision: 12, scale: 6 }),
    /** Días de atraso usados para el interés: sin esto la cuenta no se puede rehacer a mano. */
    diasAtraso: integer("dias_atraso"),
    /** Fecha hasta la que se computó la mora. */
    fechaCorteMora: date("fecha_corte_mora", { mode: "string" }),
    total: numeric("total", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_liquidacion_periodo_uf").on(t.periodoId, t.unidadFuncionalId),
    uniqueIndex("uq_liquidacion_id_periodo_uf").on(t.id, t.periodoId, t.unidadFuncionalId),
    index("idx_liquidacion_barrio").on(t.barrioId),
    index("idx_liquidacion_uf").on(t.unidadFuncionalId),
    check(
      "liquidacion_mora_chk",
      sql`(${t.moraPendienteDefinicion} and ${t.interesMora} is null) or (not ${t.moraPendienteDefinicion} and ${t.interesMora} is not null)`,
    ),
  ],
);

/** Cada línea de la boleta, con su origen: de qué gasto o de qué aplicación sale. */
export const itemLiquidacion = pgTable(
  "item_liquidacion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    liquidacionId: uuid("liquidacion_id")
      .notNull()
      .references(() => liquidacion.id, { onDelete: "cascade" }),
    // NULL en la línea de cuota fija: no sale de un gasto del período.
    // Cascade: la línea no sobrevive al gasto que la originó (solo puede pasar en borrador;
    // después de emitir, el trigger `periodo_editable` no deja borrar nada).
    gastoId: uuid("gasto_id").references(() => gastoPeriodo.id, { onDelete: "cascade" }),
    conceptoId: uuid("concepto_id").references(() => concepto.id, { onDelete: "restrict" }),
    descripcion: text("descripcion").notNull(),
    /**
     * Ordinaria/extraordinaria del art. 2048. **Nullable**: una línea "Alquiler de quincho" no es
     * ninguna de las dos, y meterla en el enum contaminaría `subtotal_ordinarias` y, con eso, el
     * certificado de deuda.
     */
    tipo: tipoConcepto("tipo"),
    esFondoReserva: boolean("es_fondo_reserva").notNull().default(false),
    /** @deprecated Se conserva un release por compatibilidad; la verdad es `clase_item`. */
    esCuotaFija: boolean("es_cuota_fija").notNull().default(false),
    /** De dónde sale la línea. Se llena por backfill en la migración y queda NOT NULL. */
    claseItem: claseItem("clase_item").notNull(),
    /** Las tres juntas o ninguna: son la FK que ata la línea a su aplicación, unidad y período. */
    aplicacionId: uuid("aplicacion_id"),
    aplicacionPeriodoId: uuid("aplicacion_periodo_id"),
    aplicacionUnidadId: uuid("aplicacion_unidad_id"),
    /**
     * Snapshot de la clasificación fiscal del concepto al momento de liquidar. El catálogo
     * (`concepto`) es editable después de emitir: sin esta copia, regenerar un documento viejo podría
     * mostrar otra clasificación que la que se emitió.
     */
    clasificacionFiscal: clasificacionFiscal("clasificacion_fiscal"),
    /** Snapshot: el gasto se cargó sin acta de asamblea. */
    sinRespaldoAsamblea: boolean("sin_respaldo_asamblea").notNull().default(false),
    /** Snapshot del acta que respalda la extraordinaria (título), para poder citarla. */
    actaTitulo: text("acta_titulo"),
    /** Monto del gasto repartido, o importe de la cuota fija: la base que explica la cifra. */
    baseMonto: numeric("base_monto", { precision: 14, scale: 2 }).notNull(),
    /** NULL en la cuota fija: no hubo prorrateo. */
    coeficienteAplicado: numeric("coeficiente_aplicado", { precision: 18, scale: 9 }),
    monto: numeric("monto", { precision: 14, scale: 2 }).notNull(),
    /** `base × coeficiente` redondeado: lo que da la cuenta a mano. */
    montoTeorico: numeric("monto_teorico", { precision: 14, scale: 2 }),
    /** `monto − monto_teorico`: el resto del reparto, explícito en vez de escondido. */
    ajusteRedondeo: numeric("ajuste_redondeo", { precision: 14, scale: 2 }).notNull().default("0.00"),
  },
  (t) => [
    // Cubre por prefijo lo que hacía `idx_item_liquidacion`, y resuelve el cuadre por clase con un
    // index-only scan (medido: 32 ms → 6,8 ms con 288.000 líneas).
    index("idx_item_liquidacion_clase").on(t.liquidacionId, t.claseItem),
    index("idx_item_barrio").on(t.barrioId),
    uniqueIndex("uq_item_aplicacion").on(t.aplicacionId).where(sql`aplicacion_id is not null`),
  ],
);

export type ConceptoRow = typeof concepto.$inferSelect;
export type PeriodoExpensaRow = typeof periodoExpensa.$inferSelect;
export type GastoPeriodoRow = typeof gastoPeriodo.$inferSelect;
export type LiquidacionRow = typeof liquidacion.$inferSelect;
export type ItemLiquidacionRow = typeof itemLiquidacion.$inferSelect;
export type TasaMoraRow = typeof tasaMora.$inferSelect;
export type CuotaFijaVersionRow = typeof cuotaFijaVersion.$inferSelect;
export type CuotaFijaRow = typeof cuotaFija.$inferSelect;
