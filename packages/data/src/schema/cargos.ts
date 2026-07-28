/**
 * Conceptos prefijados que se agregan a la boleta de una unidad: **cargos** (alquiler de quincho,
 * pádel, Club House) y **descuentos** (vecino cumplidor, bonificación a jubilado).
 *
 * Diseño y decisiones: `docs/diseno/08-criterios-de-reparto.md` Partes II y III.
 *
 * Tres piezas, el mismo patrón que `cuota_fija_version` / `cuota_fija`:
 *   catálogo (`concepto_boleta`) → valor versionado (`concepto_boleta_valor`) → aplicación
 *   a una unidad en un período (`concepto_boleta_unidad`).
 *
 * Dos reglas que se hacen cumplir por construcción y no por validación:
 *  - **El signo lo pone la clase, no quien escribe**: se guarda `importe_resuelto` como magnitud
 *    (≥ 0) y `monto_resuelto` es una **columna generada** que le pone el signo. Un descuento con
 *    monto positivo es inexpresable.
 *  - **Las bases prohibidas no existen como valor**: `base_calculo` no puede nombrar fondo de
 *    reserva, extraordinaria, interés ni saldo anterior (doc 08 §M). Una exclusión que se valida
 *    después es una exclusión que alguien puede desactivar.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./tenancy.ts";
import { barrio, unidadFuncional } from "./dominio.ts";
import { clasificacionFiscal, periodoExpensa } from "./expensas.ts";

export const claseConceptoBoleta = app.enum("clase_concepto_boleta", ["cargo", "descuento"]);
export const metodoConceptoBoleta = app.enum("metodo_concepto_boleta", [
  "monto_fijo",
  "porcentaje",
  "precio_x_cantidad",
]);
/**
 * Sobre qué se calcula un descuento porcentual. **Solo dos valores a propósito**: no existe
 * "expensa del período" (incluiría la extraordinaria y el descuento se derramaría sobre la obra),
 * ni fondo de reserva, ni interés, ni saldo anterior.
 */
export const baseCalculoConcepto = app.enum("base_calculo_concepto", ["expensa_ordinaria", "sin_base"]);

/** Cómo se financia un descuento (doc 08 §N). Sin default: el barrio lo declara. */
export const financiamientoDescuento = app.enum("financiamiento_descuento", [
  "partida_presupuestada",
  "absorbe_barrio",
  "fondo_reserva",
]);

/** Catálogo del barrio. El `admin_barrio` lo define; el `operador` solo aplica lo que existe. */
export const conceptoBoleta = pgTable(
  "concepto_boleta",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    nombre: text("nombre").notNull(),
    clase: claseConceptoBoleta("clase").notNull(),
    metodo: metodoConceptoBoleta("metodo").notNull(),
    baseCalculo: baseCalculoConcepto("base_calculo").notNull().default("sin_base"),
    /** Encuadre fiscal. El alquiler de amenities es `ingreso_ajeno` y puede cambiar la situación
     * del barrio frente a IIBB (doc 08 §Z): se declara, no se presupone. */
    clasificacionFiscal: clasificacionFiscal("clasificacion_fiscal").notNull(),
    /** De dónde sale la plata del descuento. Obligatorio para `clase = 'descuento'`. */
    financiamiento: financiamientoDescuento("financiamiento"),
    /** Conceptos que el `operador` no aplica nunca (condonaciones, eximiciones nominativas). */
    requiereAdmin: boolean("requiere_admin").notNull().default(false),
    ordenImpresion: integer("orden_impresion").notNull().default(0),
    activo: boolean("activo").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_concepto_boleta_barrio").on(t.barrioId),
    uniqueIndex("uq_concepto_boleta_barrio_nombre").on(t.barrioId, sql`lower(${t.nombre})`),
    // Un monto fijo no tiene base sobre la cual aplicarse; un porcentaje sin base no se puede calcular.
    check(
      "concepto_boleta_base_chk",
      sql`(${t.metodo} = 'porcentaje') = (${t.baseCalculo} <> 'sin_base')`,
    ),
    // Un descuento por precio × cantidad no existe en el dominio.
    check("concepto_boleta_metodo_chk", sql`${t.clase} = 'cargo' or ${t.metodo} <> 'precio_x_cantidad'`),
    // Ningún descuento se activa sin declarar quién lo paga (doc 08 §N).
    check(
      "concepto_boleta_financiamiento_chk",
      sql`(${t.clase} = 'descuento') = (${t.financiamiento} is not null)`,
    ),
  ],
);

/** El parámetro (monto, % o precio) con vigencia. Cambiarlo = versión nueva, nunca editar. */
export const conceptoBoletaValor = pgTable(
  "concepto_boleta_valor",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    conceptoBoletaId: uuid("concepto_boleta_id")
      .notNull()
      .references(() => conceptoBoleta.id, { onDelete: "cascade" }),
    /** Denormalizado del catálogo: permite que el check de parámetros sea declarativo. */
    metodo: metodoConceptoBoleta("metodo").notNull(),
    montoFijo: numeric("monto_fijo", { precision: 14, scale: 2 }),
    /**
     * **En UNIDADES DE PORCENTAJE**: `5.000000` = 5%. Distinto de `tasa_mora.tasa_mensual`, que es
     * fracción. El piso de 0,01 atrapa la confusión de convención: nadie da un descuento del 0,05%,
     * así que un `0.05` escrito por error rebota en vez de cobrar $90 donde iban $9.000.
     */
    porcentaje: numeric("porcentaje", { precision: 9, scale: 6 }),
    precioUnitario: numeric("precio_unitario", { precision: 14, scale: 2 }),
    /** Techo del descuento. Obligatorio en los porcentuales: un % sin techo escala con la expensa. */
    tope: numeric("tope", { precision: 14, scale: 2 }),
    vigenteDesde: date("vigente_desde", { mode: "string" }).notNull(),
    vigenteHasta: date("vigente_hasta", { mode: "string" }),
    documentoId: uuid("documento_id"),
    aprobadaPor: uuid("aprobada_por"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_concepto_boleta_valor_barrio").on(t.barrioId),
    // Por CONCEPTO, no por barrio: copiar el de `cuota_fija_version` tal cual dejaría todos los
    // conceptos del barrio compartiendo una sola vigencia.
    uniqueIndex("uq_concepto_boleta_valor_abierta")
      .on(t.conceptoBoletaId)
      .where(sql`vigente_hasta is null`),
    // Resuelve "el valor vigente a la fecha X" con un index scan: evita el N+1 al liquidar.
    index("idx_concepto_boleta_valor_vigencia").on(t.conceptoBoletaId, sql`vigente_desde desc`),
    check("concepto_boleta_valor_rango_chk", sql`${t.vigenteHasta} is null or ${t.vigenteHasta} >= ${t.vigenteDesde}`),
    check(
      "concepto_boleta_valor_porcentaje_chk",
      sql`${t.metodo} <> 'porcentaje' or (${t.porcentaje} >= 0.01 and ${t.porcentaje} <= 100)`,
    ),
    check("concepto_boleta_valor_tope_chk", sql`${t.tope} is null or ${t.tope} > 0`),
    check("concepto_boleta_valor_monto_chk", sql`${t.montoFijo} is null or ${t.montoFijo} >= 0`),
    check("concepto_boleta_valor_precio_chk", sql`${t.precioUnitario} is null or ${t.precioUnitario} >= 0`),
    // Un parámetro y solo el que corresponde al método.
    check(
      "concepto_boleta_valor_parametro_chk",
      sql`case ${t.metodo}
            when 'monto_fijo'        then ${t.montoFijo} is not null and ${t.porcentaje} is null and ${t.precioUnitario} is null
            when 'porcentaje'        then ${t.porcentaje} is not null and ${t.montoFijo} is null and ${t.precioUnitario} is null
            when 'precio_x_cantidad' then ${t.precioUnitario} is not null and ${t.montoFijo} is null and ${t.porcentaje} is null
          end`,
    ),
  ],
);

/**
 * La aplicación a una unidad en un período.
 *
 * **Cuelga de `(periodo_id, unidad_funcional_id)`, NUNCA de `liquidacion`**: regenerar un borrador
 * borra y recalcula las liquidaciones, y si la aplicación colgara de ahí, cada regeneración
 * evaporaría en silencio todos los cargos y descuentos cargados a mano (doc 08 §S/§AA).
 *
 * **Dos ciclos de vida**: primero se *declara* (qué concepto, a quién, cuándo, con qué detalle) y
 * después se *resuelve* (la base y el importe), porque el descuento del 5% no se puede calcular
 * hasta que exista el subtotal, que sale del prorrateo. Por eso las columnas de resolución nacen
 * nulas — y la emisión exige que no quede ninguna sin resolver.
 */
export const conceptoBoletaUnidad = pgTable(
  "concepto_boleta_unidad",
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
    conceptoBoletaId: uuid("concepto_boleta_id")
      .notNull()
      .references(() => conceptoBoleta.id, { onDelete: "restrict" }),
    valorId: uuid("valor_id")
      .notNull()
      .references(() => conceptoBoletaValor.id, { onDelete: "restrict" }),

    // --- Snapshot del catálogo y del parámetro (el catálogo es editable después de emitir) ---
    clase: claseConceptoBoleta("clase").notNull(),
    metodo: metodoConceptoBoleta("metodo").notNull(),
    nombreConcepto: text("nombre_concepto").notNull(),
    baseCalculo: baseCalculoConcepto("base_calculo").notNull(),
    clasificacionFiscal: clasificacionFiscal("clasificacion_fiscal").notNull(),
    /**
     * Quién paga el descuento, congelado igual que el resto del snapshot: el catálogo se puede
     * editar después de emitir, y si esto se leyera de ahí, cambiar el concepto en julio
     * reescribiría retroactivamente qué decía la bonificación de marzo (doc 08 §N).
     */
    financiamiento: financiamientoDescuento("financiamiento"),
    montoFijo: numeric("monto_fijo", { precision: 14, scale: 2 }),
    porcentaje: numeric("porcentaje", { precision: 9, scale: 6 }),
    precioUnitario: numeric("precio_unitario", { precision: 14, scale: 2 }),
    cantidad: numeric("cantidad", { precision: 12, scale: 3 }),
    tope: numeric("tope", { precision: 14, scale: 2 }),

    // --- Resolución (nula hasta que se liquida) ---
    baseCalculada: numeric("base_calculada", { precision: 14, scale: 2 }),
    /** Magnitud, siempre ≥ 0. El signo lo pone `monto_resuelto`, que es columna generada. */
    importeResuelto: numeric("importe_resuelto", { precision: 14, scale: 2 }),
    /** Lo que hubiera dado sin tope: se imprime cuando el tope muerde, para no truncar en silencio. */
    importeSinTope: numeric("importe_sin_tope", { precision: 14, scale: 2 }),
    /**
     * El importe CON signo, derivado por la base (creada a mano en 0016). Se declara acá para que el
     * esquema TS no quede desincronizado del físico y la próxima migración generada no intente
     * volver a crearla.
     */
    montoResuelto: numeric("monto_resuelto", { precision: 14, scale: 2 }).generatedAlwaysAs(
      sql`case when clase = 'descuento' then -importe_resuelto else importe_resuelto end`,
    ),

    // --- Origen (regla dura: toda cifra se explica) ---
    fechaHecho: date("fecha_hecho", { mode: "string" }).notNull(),
    detalle: text("detalle").notNull(),
    /** Lo pisa la base con la identidad de la sesión: una firma que manda el cliente no es una firma. */
    aplicadoPor: uuid("aplicado_por").notNull(),
    aplicadoAt: timestamp("aplicado_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * De dónde salió la evaluación (p. ej. "vecino cumplidor"). **`cuenta_corriente` no está
     * habilitado**: hasta que exista el módulo de cobros, el sistema no puede afirmar que verificó
     * nada, y una boleta que dice "el sistema verificó" cuando nadie verificó es peor que no decir
     * nada (doc 08 §AA).
     */
    origenEvaluacion: text("origen_evaluacion").notNull().default("carga_manual"),
    /**
     * El cargo superó el umbral de monto inusual del barrio y quien lo aplicó **lo confirmó**
     * (migración `0025`). Lo escribe `app.cbu_antes()`, no el request: lo que el request manda es la
     * intención, y la base la normaliza a lo que de verdad pasó. Así la columna se puede auditar
     * ("los cargos confirmados por monto inusual del trimestre") sin que la ensucien casillas
     * tildadas de más.
     */
    confirmacionMontoInusual: boolean("confirmacion_monto_inusual").notNull().default(false),
    anuladoAt: timestamp("anulado_at", { withTimezone: true }),
    anuladoPor: uuid("anulado_por"),
    motivoAnulacion: text("motivo_anulacion"),
  },
  (t) => [
    index("idx_cbu_barrio").on(t.barrioId),
    index("idx_cbu_periodo_uf").on(t.periodoId, t.unidadFuncionalId),
    // Destino de la FK de tres columnas que impide que un cargo caiga en la boleta de otra unidad.
    uniqueIndex("uq_cbu_id_periodo_uf").on(t.id, t.periodoId, t.unidadFuncionalId),
    uniqueIndex("uq_cbu_id_barrio").on(t.id, t.barrioId),
    // Los descuentos no se aplican dos veces; los cargos SÍ se repiten (dos reservas en el mes).
    uniqueIndex("uq_cbu_descuento_unico")
      .on(t.periodoId, t.unidadFuncionalId, t.conceptoBoletaId)
      .where(sql`clase = 'descuento' and anulado_at is null`),
    check("cbu_importe_chk", sql`${t.importeResuelto} is null or ${t.importeResuelto} >= 0`),
    check("cbu_resolucion_chk", sql`(${t.baseCalculada} is null) or (${t.importeResuelto} is not null)`),
    check("cbu_cantidad_chk", sql`${t.cantidad} is null or (${t.cantidad} > 0 and ${t.cantidad} <= 100)`),
    // El mismo candado que el catálogo, pero acá: de ESTA tabla sale el dinero de la boleta. Sin él,
    // una aplicación con `cantidad` nula pasa todos los controles y revienta la liquidación del
    // período entero al multiplicar por NULL.
    check(
      "cbu_parametro_chk",
      sql`case ${t.metodo}
            when 'monto_fijo'        then ${t.montoFijo} is not null and ${t.porcentaje} is null and ${t.precioUnitario} is null and ${t.cantidad} is null
            when 'porcentaje'        then ${t.porcentaje} is not null and ${t.montoFijo} is null and ${t.precioUnitario} is null and ${t.cantidad} is null
            when 'precio_x_cantidad' then ${t.precioUnitario} is not null and ${t.cantidad} is not null and ${t.montoFijo} is null and ${t.porcentaje} is null
          end`,
    ),
    // El tope es el techo del DESCUENTO. En un cargo sería lo contrario de un control: recortaría en
    // silencio lo que hay que cobrar, y el cuadre ni se enteraría porque compara contra el ya capado.
    check("cbu_tope_clase_chk", sql`${t.tope} is null or ${t.clase} = 'descuento'`),
    check("cbu_financiamiento_chk", sql`(${t.clase} = 'descuento') = (${t.financiamiento} is not null)`),
    check("cbu_origen_chk", sql`${t.origenEvaluacion} in ('carga_manual', 'override_administrador')`),
    // El candado de confirmación es de los cargos: un descuento no puede superar su propia base.
    check("cbu_confirmacion_clase_chk", sql`not ${t.confirmacionMontoInusual} or ${t.clase} = 'cargo'`),
    check(
      "cbu_anulacion_chk",
      sql`(${t.anuladoAt} is null and ${t.anuladoPor} is null and ${t.motivoAnulacion} is null)
          or (${t.anuladoAt} is not null and ${t.anuladoPor} is not null and ${t.motivoAnulacion} is not null)`,
    ),
  ],
);

/** Registro append-only de lo que pasó con cada aplicación. Sin UPDATE ni DELETE para nadie. */
export const conceptoBoletaUnidadEvento = pgTable(
  "concepto_boleta_unidad_evento",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    aplicacionId: uuid("aplicacion_id")
      .notNull()
      .references(() => conceptoBoletaUnidad.id, { onDelete: "cascade" }),
    evento: text("evento").notNull(),
    actor: uuid("actor").notNull(),
    ocurridoAt: timestamp("ocurrido_at", { withTimezone: true }).notNull().defaultNow(),
    importeResuelto: numeric("importe_resuelto", { precision: 14, scale: 2 }),
    baseCalculada: numeric("base_calculada", { precision: 14, scale: 2 }),
    motivo: text("motivo"),
  },
  (t) => [
    index("idx_cbu_evento_aplicacion").on(t.aplicacionId),
    index("idx_cbu_evento_barrio").on(t.barrioId),
    check("cbu_evento_tipo_chk", sql`${t.evento} in ('alta', 'resolucion', 'anulacion')`),
  ],
);

/** Tope de lo que un `operador` puede aplicar sin pasar por `admin_barrio`. Sin default permisivo. */
export const limiteAplicacionBarrio = pgTable(
  "limite_aplicacion_barrio",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    montoMaxOperador: numeric("monto_max_operador", { precision: 14, scale: 2 }).notNull(),
    porcentajeMaxOperador: numeric("porcentaje_max_operador", { precision: 9, scale: 6 }).notNull(),
    /**
     * Hasta cuánto puede aplicar un `operador` en **cargos** a una misma unidad en un mismo período,
     * **acumulado** (migración `0025`). `null` = el operador no aplica cargos: falla cerrado, igual
     * que el tope de descuentos, y por el mismo motivo — un default de "$X hasta que lo configuren"
     * es un agujero con fecha de vencimiento.
     *
     * Es además la referencia de "cargo de rutina" del barrio cuando la unidad **todavía no tiene
     * ninguna boleta** contra la cual comparar (ver `app.cbu_expensa_de_referencia`).
     */
    montoMaxCargoOperador: numeric("monto_max_cargo_operador", { precision: 14, scale: 2 }),
    /**
     * Cuántas veces la expensa de la unidad pueden sumar los cargos de un período antes de que el
     * sistema **exija confirmación explícita** (`null` = 3, el default del sistema, escrito en
     * `app.cbu_antes()`).
     *
     * **No es un permiso**: por encima del umbral el cargo entra igual, pero solo si quien lo aplica
     * confirma. Es el freno al error de tipeo, no una autorización — esa es la columna de arriba.
     */
    multiploConfirmacionCargo: numeric("multiplo_confirmacion_cargo", { precision: 6, scale: 2 }),
    vigenteDesde: date("vigente_desde", { mode: "string" }).notNull(),
    vigenteHasta: date("vigente_hasta", { mode: "string" }),
    aprobadoPor: uuid("aprobado_por"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_limite_aplicacion_barrio").on(t.barrioId),
    uniqueIndex("uq_limite_aplicacion_abierto").on(t.barrioId).where(sql`vigente_hasta is null`),
    check("limite_monto_chk", sql`${t.montoMaxOperador} >= 0`),
    check("limite_porcentaje_chk", sql`${t.porcentajeMaxOperador} >= 0 and ${t.porcentajeMaxOperador} <= 100`),
    check("limite_monto_cargo_chk", sql`${t.montoMaxCargoOperador} is null or ${t.montoMaxCargoOperador} >= 0`),
    // Las dos puntas importan: abajo, un control que salta siempre se aprende a despachar sin leer
    // (1 es legítimo: barrio estricto). Arriba, **el parámetro no puede ser la forma de apagar el
    // control**: un cargo de 100 veces la expensa no es una política, es un cero de más.
    check(
      "limite_multiplo_chk",
      sql`${t.multiploConfirmacionCargo} is null
          or (${t.multiploConfirmacionCargo} >= 1 and ${t.multiploConfirmacionCargo} <= 100)`,
    ),
  ],
);

export type ConceptoBoletaRow = typeof conceptoBoleta.$inferSelect;
export type ConceptoBoletaValorRow = typeof conceptoBoletaValor.$inferSelect;
export type ConceptoBoletaUnidadRow = typeof conceptoBoletaUnidad.$inferSelect;
