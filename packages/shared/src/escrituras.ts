/**
 * Esquemas Zod de los **parámetros de las escrituras** (ADR-0002 §4.2, paso 1).
 *
 * Hermano de `consultas.ts` y por el mismo motivo: el borde lo cruzan dos lados —la Server Action que
 * arma el parámetro desde un `FormData` y el servicio de `packages/data` que lo consume— y un esquema
 * por lado es un contrato que se desincroniza.
 *
 * Tres reglas que explican cómo están escritos:
 *
 * **1. Todo llega como string.** `Object.fromEntries(formData)` no produce números ni booleanos. Por
 * eso los importes son `montoSchema` (string decimal exacto) y las cantidades también: un
 * `z.coerce.number()` sobre un importe es el `Number()` que la regla 5 del ADR-0002 §5.2 prohíbe, y
 * la pérdida de exactitud sería **silenciosa**.
 *
 * **2. Acá no se valida ninguna regla de negocio.** Que el período sea editable lo decide el trigger
 * `app.periodo_editable`; que el concepto tenga valor vigente, `app.cbu_antes()`; que el descuento
 * entre en el tope del operador, la misma función. Lo que se valida acá es **forma**: que un uuid sea
 * un uuid y que un importe tenga dos decimales. Duplicar la regla de negocio en Zod la pone en dos
 * lugares, y el día que diverjan gana el que no tiene el dinero.
 *
 * **3. Lo que el request NO manda no está en el esquema.** `aplicarConceptoAUnidadSchema` no tiene
 * `precio_unitario`, ni `monto_fijo`, ni `importe`: son las columnas que escribe la base desde el
 * catálogo (migración `0017` §5, doc 08 §AC). Que no existan en el tipo es lo que hace que la pantalla
 * no pueda ni siquiera intentar mandarlas — y que nadie se pregunte por qué se ignoran.
 *
 * **Por qué NO son `.strict()`, que es la pregunta obvia.** Un `.strict()` rechaza el objeto entero si
 * trae una clave de más, y `Object.fromEntries(formData)` de una Server Action **siempre** trae claves
 * de más (Next agrega las suyas, y un formulario real lleva botones y campos de UI). Con `.strict()`
 * toda acción fallaría con un error de validación incomprensible. El modo por defecto de Zod —
 * **descartar** lo desconocido— es además el comportamiento seguro para lo que importa acá: un
 * `precio_unitario` inyectado en el `FormData` no llega al objeto parseado, y por lo tanto no llega a
 * la sentencia. Hay un test que lo verifica pasando campos de más a propósito.
 */

import { z } from "zod";
import { montoSchema, periodoSchema } from "./dinero.ts";
import { fechaIsoSchema } from "./fechas.ts";
import { idSchema } from "./consultas.ts";

/**
 * Importe que no puede ser negativo — precios, topes, montos de catálogo.
 *
 * `montoSchema` admite el signo porque hay cifras que legítimamente son negativas (un descuento en la
 * boleta viaja negativo). Ninguna de las que se **cargan a mano** en estos formularios lo es: un
 * precio unitario de `-38000.00` no es un descuento, es un cargo al revés. La base también lo
 * rechaza (`concepto_boleta_valor_precio_chk`, `_monto_chk`, `_tope_chk`); acá se repite **solo para
 * que el mensaje caiga en el campo** en vez de rebotar el formulario entero con un nombre de
 * constraint.
 */
const importePositivoSchema = montoSchema.refine(
  (m) => !m.startsWith("-"),
  "el importe no puede ser negativo",
);

/** Texto que una persona escribe y que después se imprime o se archiva. */
const textoSchema = (max: number, campo: string) =>
  z
    .string()
    .trim()
    .min(1, `${campo}: no puede quedar vacío`)
    .max(max, `${campo}: máximo ${max} caracteres`);

/** Igual, pero el campo puede no venir. `""` se normaliza a `null`, que es lo que guarda la base. */
const textoOpcionalSchema = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .default(null);

/**
 * Campo opcional que llega de un formulario. **`""` significa "no cargado".**
 *
 * Sin esto, un campo opcional era imposible de dejar vacío, y el modo de falla era del peor tipo: el
 * navegador manda `""` para un `<input>` vacío —`null` no existe en un `FormData`—, `.nullable()`
 * solo acepta `null`, y el resultado era que dejar en blanco un vencimiento devolvía "fecha inválida
 * (esperado YYYY-MM-DD)" sobre un campo que la propia etiqueta declara opcional. Verificado en la
 * pantalla de alta de período el 2026-07-28.
 *
 * Va con `preprocess` y no con una unión (`z.union([z.literal(""), fechaIsoSchema])`) por el mensaje:
 * una unión reporta "Invalid input" con el detalle de cada rama, y se pierde el "fecha inválida
 * (esperado YYYY-MM-DD)" que es justamente lo que hace que el error sirva. Con `preprocess`, un valor
 * no vacío llega al esquema de adentro tal cual y conserva su mensaje.
 *
 * `.trim()` antes de comparar: un campo con espacios sueltos tampoco es un valor cargado.
 */
const opcionalDeFormulario = <T extends z.ZodTypeAny>(esquema: T) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    esquema.nullable().default(null),
  );

/**
 * Motivo de una anulación. **Mínimo de 5 caracteres y no es ceremonia**: la anulación de un cargo es
 * irreversible y su motivo queda en el registro append-only como única explicación de por qué esa
 * plata no se cobró. Un motivo `"x"` deja el asiento sin explicación para siempre.
 */
const motivoSchema = z
  .string()
  .trim()
  .min(5, "el motivo: contá en una frase por qué se anula (queda registrado y no se puede editar)")
  .max(500);

/**
 * Una confirmación explícita de la persona, llegando por `FormData` (o sea, como texto).
 *
 * **`z.coerce.boolean()` está prohibido acá y el motivo es concreto**: `Boolean("false")` es `true`, y
 * también lo son `"0"`, `"no"` y cualquier string no vacío. Un checkbox desmarcado que el navegador
 * mande como `"false"` se leería como una confirmación dada — es decir, el campo que existe para
 * frenar un cargo de $3.000.000 lo dejaría pasar solo.
 *
 * Por eso la lista de lo que cuenta como "sí" es **cerrada** y todo lo demás es `false`: el modo de
 * falla de un valor raro tiene que ser "no confirmó", nunca "confirmó". `"on"` es lo que manda un
 * `<input type="checkbox">` sin `value`.
 */
const confirmacionExplicitaSchema = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === "true" || v === "on" || v === "1")
  .default(false);

// ── 1. Crear un período ────────────────────────────────────────────────────────────────────────

/**
 * **`estado` no está, y es deliberado.** Un período nace en `borrador` por trigger
 * (`app.periodo_nace_en_borrador`, migración `0013` §2). Aceptarlo por parámetro sería ofrecer un
 * campo que la base pisa: el clásico control que parece existir y no existe.
 *
 * Los vencimientos son opcionales porque en la operatoria real se cargan después, cuando el barrio
 * decide la fecha — y un período sin vencimiento se puede liquidar igual.
 */
export const crearPeriodoSchema = z
  .object({
    barrioId: idSchema,
    periodo: periodoSchema,
    primerVencimiento: opcionalDeFormulario(fechaIsoSchema),
    segundoVencimiento: opcionalDeFormulario(fechaIsoSchema),
    notas: textoOpcionalSchema(2_000),
  })
  .superRefine((v, ctx) => {
    // El mismo control que `periodo_vencimientos_chk`. Se replica acá **solo** para que el mensaje
    // llegue al campo del formulario en vez de como un error de constraint sobre el formulario entero.
    if (v.primerVencimiento && v.segundoVencimiento && v.segundoVencimiento < v.primerVencimiento) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segundoVencimiento"],
        message: "el segundo vencimiento no puede ser anterior al primero",
      });
    }
  });
export type CrearPeriodo = z.infer<typeof crearPeriodoSchema>;

// ── 2. Gastos del período ──────────────────────────────────────────────────────────────────────

/**
 * **`barrioId` no está**, y es la misma decisión que en las lecturas (ADR-0002 §3.4): el barrio se
 * deriva del período bajo RLS. Un servicio que recibe un `barrioId` que después usa para filtrar hace
 * que el aislamiento dependa de un parámetro que manda el cliente.
 *
 * **`sinRespaldoAsamblea` tampoco está**: esa marca la pone el trigger
 * `app.gasto_respaldo_extraordinaria` (migración `0007` §2), y la pone la base justamente para que
 * valga igual si el gasto entra por la pantalla, por una importación o por un job.
 */
export const registrarGastoSchema = z.object({
  periodoId: idSchema,
  conceptoId: idSchema,
  descripcion: textoSchema(300, "la descripción"),
  monto: montoSchema.refine((m) => !m.startsWith("-"), "el monto de un gasto no puede ser negativo"),
  proveedorNombre: textoOpcionalSchema(200),
  comprobante: textoOpcionalSchema(100),
  /**
   * Acta que respalda una extraordinaria. **Opcional a propósito**: una extraordinaria sin acta se
   * carga igual y queda marcada (doc 08 §A.0 punto 2, corrección del usuario del 2026-07-24). Una
   * bomba que se rompe no espera a la asamblea.
   */
  actaDocumentoId: opcionalDeFormulario(idSchema),
});
export type RegistrarGasto = z.infer<typeof registrarGastoSchema>;

/**
 * Corregir un gasto ya cargado. **El concepto no se puede cambiar**: cambiarlo cambia el tipo
 * (ordinaria/extraordinaria), el encuadre fiscal y si es fondo de reserva — o sea, es otro gasto.
 * Se borra y se carga de nuevo, que es barato mientras el período está en borrador.
 */
export const corregirGastoSchema = registrarGastoSchema
  .omit({ periodoId: true, conceptoId: true })
  .extend({ gastoId: idSchema });
export type CorregirGasto = z.infer<typeof corregirGastoSchema>;

export const anularGastoSchema = z.object({ gastoId: idSchema });
export type AnularGasto = z.infer<typeof anularGastoSchema>;

// ── 3. Catálogo de conceptos de boleta ─────────────────────────────────────────────────────────

export const claseConceptoBoletaSchema = z.enum(["cargo", "descuento"]);
export const metodoConceptoBoletaSchema = z.enum(["monto_fijo", "porcentaje", "precio_x_cantidad"]);
export const baseCalculoConceptoSchema = z.enum(["expensa_ordinaria", "sin_base"]);
export const financiamientoDescuentoSchema = z.enum([
  "partida_presupuestada",
  "absorbe_barrio",
  "fondo_reserva",
]);
export const clasificacionFiscalSchema = z.enum([
  "alcanzado",
  "no_alcanzado",
  "ingreso_ajeno",
  "no_gravado",
  "sin_clasificar",
]);

/** Porcentaje con hasta 6 decimales, como string. Mismo motivo que el dinero: nada de `Number`. */
const porcentajeSchema = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, "porcentaje inválido (ej '10' o '10.500000')");

/** Cantidad con hasta 3 decimales (cuántas reservas, cuántas jornadas). String, no `number`. */
const cantidadSchema = z.string().regex(/^\d+(\.\d{1,3})?$/, "cantidad inválida (ej '1' o '2.5')");

/**
 * Alta de un concepto del catálogo del barrio **con su primer valor vigente, en una sola operación**.
 *
 * Están juntos porque separarlos crea un estado intermedio inútil y peligroso: un concepto sin valor
 * no se puede aplicar —`app.cbu_antes()` lo rechaza con "no tiene valor vigente al …"— y la pantalla
 * que lo listara tendría que explicar por qué ese concepto existe pero no sirve.
 *
 * **`clasificacionFiscal` no tiene default.** El default `no_alcanzado` se eliminó en la migración
 * `0014` justamente para que dar de alta un concepto obligue a declarar el encuadre. Repetir un
 * default acá lo reintroduciría por la ventana.
 */
export const crearConceptoBoletaSchema = z
  .object({
    barrioId: idSchema,
    nombre: textoSchema(120, "el nombre del concepto"),
    clase: claseConceptoBoletaSchema,
    metodo: metodoConceptoBoletaSchema,
    baseCalculo: baseCalculoConceptoSchema.default("sin_base"),
    clasificacionFiscal: clasificacionFiscalSchema,
    financiamiento: financiamientoDescuentoSchema.nullable().default(null),
    /** El concepto solo lo puede aplicar un `admin_barrio`, nunca un `operador`. */
    requiereAdmin: z.boolean().default(false),
    ordenImpresion: z.number().int().min(0).max(9_999).default(0),
    // El primer valor vigente.
    vigenteDesde: fechaIsoSchema,
    montoFijo: opcionalDeFormulario(importePositivoSchema),
    porcentaje: opcionalDeFormulario(porcentajeSchema),
    precioUnitario: opcionalDeFormulario(importePositivoSchema),
    tope: opcionalDeFormulario(importePositivoSchema),
  })
  .superRefine(revisarParametrosDelValor);
export type CrearConceptoBoleta = z.infer<typeof crearConceptoBoletaSchema>;

/**
 * Un valor nuevo para un concepto que ya existe. La vigencia anterior **la cierra la base**
 * (`app.concepto_boleta_valor_antes`, migración `0016` §5): no hay un campo `vigenteHasta` acá porque
 * cerrarla desde el request permitiría dejar un hueco de vigencia, y en ese hueco un concepto deja de
 * poder aplicarse sin que nadie lo haya decidido.
 *
 * **El método no viaja**: lo fija el concepto y una FK lo hace cumplir (`fk_cbv_concepto_metodo`). El
 * servicio lo lee del catálogo.
 */
export const registrarValorConceptoSchema = z
  .object({
    conceptoBoletaId: idSchema,
    vigenteDesde: fechaIsoSchema,
    montoFijo: opcionalDeFormulario(importePositivoSchema),
    porcentaje: opcionalDeFormulario(porcentajeSchema),
    precioUnitario: opcionalDeFormulario(importePositivoSchema),
    tope: opcionalDeFormulario(importePositivoSchema),
  })
  .superRefine((v, ctx) => {
    // Sin `metodo` no se puede verificar la combinación acá: la verifica el servicio contra el
    // catálogo, y en última instancia `concepto_boleta_valor_parametro_chk`. Lo único que se puede
    // afirmar sin leer la base es que **algún** parámetro tiene que venir.
    if (v.montoFijo === null && v.porcentaje === null && v.precioUnitario === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["montoFijo"],
        message: "hay que cargar el valor del concepto (monto fijo, porcentaje o precio unitario)",
      });
    }
  });
export type RegistrarValorConcepto = z.infer<typeof registrarValorConceptoSchema>;

/**
 * La combinación de parámetros según el método, y las dos reglas que la base también hace cumplir.
 *
 * Se replica acá **solo por el mensaje**: `concepto_boleta_valor_parametro_chk` y
 * `cbv_tope_obligatorio_chk` ya lo garantizan. La diferencia es que un `check` rebota el formulario
 * entero con el nombre de un constraint, y esto marca el campo.
 */
function revisarParametrosDelValor(
  v: {
    clase: "cargo" | "descuento";
    metodo: "monto_fijo" | "porcentaje" | "precio_x_cantidad";
    baseCalculo: "expensa_ordinaria" | "sin_base";
    financiamiento: string | null;
    montoFijo: string | null;
    porcentaje: string | null;
    precioUnitario: string | null;
    tope: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  const marcar = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

  const esperados = {
    monto_fijo: ["montoFijo", v.montoFijo],
    porcentaje: ["porcentaje", v.porcentaje],
    precio_x_cantidad: ["precioUnitario", v.precioUnitario],
  } as const;
  const [campo, valor] = esperados[v.metodo];
  if (valor === null) marcar(campo, "falta el valor para el método elegido");
  for (const [metodo, [otroCampo, otroValor]] of Object.entries(esperados)) {
    if (metodo !== v.metodo && otroValor !== null) {
      marcar(otroCampo, "sobra: no corresponde al método elegido");
    }
  }

  // `concepto_boleta_base_chk`: el porcentual necesita base; el resto, ninguna.
  if ((v.metodo === "porcentaje") !== (v.baseCalculo !== "sin_base")) {
    marcar("baseCalculo", "un porcentaje se calcula sobre una base; los demás métodos no llevan base");
  }
  // `concepto_boleta_metodo_chk`: precio × cantidad solo tiene sentido en un cargo.
  if (v.metodo === "precio_x_cantidad" && v.clase !== "cargo") {
    marcar("metodo", "precio por cantidad es de un cargo: un descuento no se cobra por unidad de uso");
  }
  // `concepto_boleta_financiamiento_chk` — doc 08 §N: ningún descuento sin declarar quién lo paga.
  if ((v.clase === "descuento") !== (v.financiamiento !== null)) {
    marcar(
      "financiamiento",
      v.clase === "descuento"
        ? "hay que declarar de dónde sale la plata del descuento"
        : "un cargo no tiene financiamiento: es plata que entra",
    );
  }
  // `cbv_tope_obligatorio_chk`: un porcentual sin techo escala con la expensa.
  if (v.metodo === "porcentaje" && v.tope === null) {
    marcar("tope", "un porcentaje necesita tope: sin techo crece con la expensa (5% de una obra es otro número)");
  }
  // `cbu_tope_clase_chk` / `app.cbv_antes()`: en un cargo el tope recortaría lo que hay que cobrar.
  if (v.tope !== null && v.clase !== "descuento") {
    marcar("tope", "el tope es el techo de un descuento: en un cargo recortaría en silencio lo que hay que cobrar");
  }
}

// ── 4. Aplicar un concepto a una unidad, y anularlo ────────────────────────────────────────────

/**
 * **Siete campos y ni uno más.** Es literalmente lo que el request tiene permitido mandar según las
 * migraciones `0017` §5 y `0025`: qué concepto, a qué unidad, de qué período, cuándo, cuántas
 * unidades, por qué — y, desde `0025`, si confirma un importe inusual.
 * El nombre, la clase, el método, el precio, el porcentaje, el tope, el encuadre fiscal, quién
 * financia, la base de cálculo, el importe y la firma **los escribe la base**.
 *
 * Que el tipo no tenga esos campos no es cosmético: es lo que hace que `frontend-dev` no pueda armar
 * un formulario que los mande, y que nadie tenga que acordarse de ignorarlos.
 *
 * `origenEvaluacion` admite dos valores y no tres: `cuenta_corriente` está **inhabilitado** por
 * `cbu_origen_chk` hasta que exista el módulo de cobros, porque hoy el sistema no puede afirmar que
 * verificó nada — y una boleta que dice "el sistema verificó" sin que nadie haya verificado es peor
 * que no decir nada.
 */
export const aplicarConceptoAUnidadSchema = z.object({
  periodoId: idSchema,
  unidadFuncionalId: idSchema,
  conceptoBoletaId: idSchema,
  /**
   * Cuándo pasó el hecho. **Decide qué valor del catálogo se congela** (`app.cbu_antes()` busca el
   * vigente a esta fecha), así que no es un dato administrativo: es el que fija el precio.
   *
   * **Opcional a propósito, y solo tiene sentido pedirla para un cargo por uso.** El quincho se usó
   * un día concreto y ese día tenía su precio. Un **descuento** —la bonificación por pago en
   * término— no tiene un "hecho" en una fecha: la condición se evalúa al cierre del período. Pedirla
   * ahí obligaba a inventar un dato que, en silencio, decidía si se aplicaba el 7,5 % de hoy o el 5 %
   * de tres meses atrás.
   *
   * Cuando no viene, el servicio usa **el primer día del período**. Es determinístico, se conoce en
   * el momento de aplicar —a diferencia de la fecha de emisión, que todavía no existe— y coincide
   * con cómo se decide en la práctica: *"la bonificación, si cambia, es a principio de mes, cuando se
   * define también el nuevo valor de la expensa; todo antes de emitir las boletas"* (usuario,
   * 2026-08-04).
   */
  fechaHecho: opcionalDeFormulario(fechaIsoSchema),
  /** Solo la usa `precio_x_cantidad`. En los otros métodos la base la pisa con `null`. */
  cantidad: opcionalDeFormulario(cantidadSchema),
  detalle: textoSchema(500, "el detalle"),
  origenEvaluacion: z.enum(["carga_manual", "override_administrador"]).default("carga_manual"),
  /**
   * **La respuesta a una pregunta que la base ya hizo**, no una casilla que el formulario manda por
   * las dudas.
   *
   * El flujo es: se aplica sin esto → si el cargo supera el umbral del barrio, el `insert` **se
   * rechaza** con `codigo: "cargo_requiere_confirmacion"` y un mensaje que trae la cifra concreta
   * ("este cargo es 31 veces la expensa de esta unidad") → la pantalla se la muestra a la persona →
   * si dice que sí, se reintenta con esto en `true`.
   *
   * Mandarlo siempre en `true` "para que no moleste" desactiva el único freno que hay contra un cero
   * de más en una boleta: el umbral lo evalúa la base (`app.cbu_antes`, migración `0025`) y esto es
   * solo el consentimiento. No autoriza nada — el tope del `operador` **no** se levanta con esto.
   */
  confirmarMontoInusual: confirmacionExplicitaSchema,
});
/**
 * **`confirmarMontoInusual` es el único campo opcional del tipo, y no por comodidad.**
 *
 * El resto de los campos son obligatorios porque siempre hay algo que decir sobre ellos. La
 * confirmación no: en el primer intento **no existe**, porque todavía nadie preguntó nada. Solo
 * aparece cuando la base rechazó el cargo pidiéndola. Que el tipo lo refleje evita que un formulario
 * la mande de arranque "para completar el objeto", que es la forma más fácil de convertir el candado
 * en un cartel.
 */
export type AplicarConceptoAUnidad = Omit<
  z.infer<typeof aplicarConceptoAUnidadSchema>,
  "confirmarMontoInusual"
> & {
  /** `true` (o `"true"` / `"on"` / `"1"` desde un `FormData`). Cualquier otra cosa es "no confirmó". */
  readonly confirmarMontoInusual?: boolean | string;
};

/** Una aplicación no se edita: se anula con motivo y se crea otra (doc 08 §Y y §AC punto 2). */
export const anularAplicacionSchema = z.object({
  aplicacionId: idSchema,
  motivo: motivoSchema,
});
export type AnularAplicacion = z.infer<typeof anularAplicacionSchema>;

// ── 5. Generar el borrador y emitir ────────────────────────────────────────────────────────────

/**
 * **`saldosAnteriores` no está en el esquema del formulario a propósito.** Hoy entra por parámetro
 * desde un script porque el módulo de cobros no existe (ADR-0002 §8); el día que exista, sale de la
 * cuenta corriente y no de una pantalla. Ofrecerlo como campo sería invitar a tipear a mano la deuda
 * de un vecino.
 */
export const generarBorradorSchema = z.object({ periodoId: idSchema });
export type GenerarBorrador = z.infer<typeof generarBorradorSchema>;

export const emitirPeriodoSchema = z.object({ periodoId: idSchema });
export type EmitirPeriodo = z.infer<typeof emitirPeriodoSchema>;

// ── 6. La cuota fija: definir la del mes que viene ─────────────────────────────────────────────

/**
 * Porcentaje de ajuste, como string decimal. Admite negativo —una cuota puede bajar— y hasta cuatro
 * decimales, que es lo que guarda la columna.
 *
 * **Los dos límites no son simétricos, y ninguno es decorativo:**
 *
 * - **Techo de 1000 %.** No es una regla contable: es el cero-de-más al tipear, que en una cuota
 *   multiplicada por todas las unidades del barrio no se detecta leyendo.
 * - **Piso de −100 %.** Ahí la cuota llega a cero; más abajo el resultado es **negativo**, y una
 *   cuota negativa no es un descuento: no significa nada. Antes de este piso, `-200` producía
 *   `-384000.00`, la pantalla lo mostraba bajo el rótulo "Cuota nueva" como si fuera un valor
 *   posible, y recién lo frenaba el `cuota_fija_importe_chk` de la base con el mensaje genérico de
 *   un constraint. Falla cerrado, sí, pero después de afirmar un número imposible.
 */
export const PORCENTAJE_MAXIMO = 1000;
export const PORCENTAJE_MINIMO = -100;

/**
 * ¿Este texto es un porcentaje de ajuste que el borde va a aceptar?
 *
 * **Se exporta, y ese es el punto.** La vista previa de la pantalla tiene que mostrar exactamente lo
 * que el servidor va a aceptar, y la primera versión copió *solo la regex*: con `9999` la pantalla
 * decía "el barrio pasa a facturar 19.674.871.800,00 por mes" y el servidor rechazaba. Copiar una
 * regla es garantizar que en algún momento diverja; llamar a la misma función, no.
 *
 * Devuelve un booleano y **no lanza nunca**: es el predicado, no el validador.
 */
export function esPorcentajeDeAjusteValido(porcentaje: string): boolean {
  const v = porcentaje.trim();
  // La coma no se acepta: aceptar las dos formas haría que "3,2" y "3.2" convivan en la base como
  // textos distintos. Lo que sí hay que hacer es decirlo con un mensaje entendible, no explotar.
  if (!/^-?\d{1,4}(\.\d{1,4})?$/.test(v)) return false;
  const escala = enEscalaDeCuatro(v);
  return escala <= BigInt(PORCENTAJE_MAXIMO) * 10_000n && escala >= BigInt(PORCENTAJE_MINIMO) * 10_000n;
}

/**
 * `"-3.25"` → `-32500n`, en la escala entera de 4 decimales de la columna. Entero y no `Number`: es
 * la comparación que decide si un porcentaje entra o no, y la regla 5 del ADR-0002 §5.2 prohíbe el
 * punto flotante en el camino del dinero, también cuando solo se compara.
 *
 * **Exige que la forma ya esté verificada.** `BigInt("3,2")` lanza un `SyntaxError`, y una excepción
 * adentro de un validador de Zod **no la atrapa `safeParse`**: sube hasta la Server Action y se ve
 * como un error genérico en vez de "el porcentaje: un número como 3.2". Pasó de verdad: los `.refine`
 * de una cadena de `ZodString` **corren aunque el `.regex()` anterior haya fallado** (Zod v3 acumula
 * issues, no corta), así que llegaba acá el texto crudo. Por eso el único llamador es el predicado de
 * arriba, que chequea la forma primero.
 */
function enEscalaDeCuatro(porcentaje: string): bigint {
  const negativo = porcentaje.startsWith("-");
  const [ent = "0", dec = ""] = (negativo ? porcentaje.slice(1) : porcentaje).split(".");
  const valor = BigInt(ent) * 10_000n + BigInt(dec.padEnd(4, "0").slice(0, 4));
  return negativo ? -valor : valor;
}

/**
 * Porcentaje de ajuste, como string decimal. Admite negativo —una cuota puede bajar— y hasta cuatro
 * decimales, que es lo que guarda la columna.
 *
 * **Los dos límites no son simétricos, y ninguno es decorativo:**
 *
 * - **Techo de 1000 %.** No es una regla contable: es el cero-de-más al tipear, que en una cuota
 *   multiplicada por todas las unidades del barrio no se detecta leyendo.
 * - **Piso de −100 %.** Ahí la cuota llega a cero; más abajo el resultado es **negativo**, y una
 *   cuota negativa no es un descuento: no significa nada.
 *
 * Un solo `refine` sobre el predicado exportado, y no una cadena de `.regex().refine().refine()`: la
 * cadena hacía que los refines corrieran sobre texto que ya había fallado la forma (ver
 * `enEscalaDeCuatro`), y además repartía la regla en tres lugares que la pantalla no podía reusar.
 */
const porcentajeDeAjusteSchema = z
  .string()
  .trim()
  .refine(
    esPorcentajeDeAjusteValido,
    `el porcentaje: un número como 3.2 (con punto, hasta 4 decimales), entre ${PORCENTAJE_MINIMO} y ${PORCENTAJE_MAXIMO}`,
  );

export const REDONDEOS = ["centavo", "peso", "centena", "mil"] as const;

/**
 * Definir la cuota que rige desde una fecha. **Las dos formas de cargarla son casos del mismo acto**,
 * por eso es un solo esquema con una unión discriminada y no dos escrituras: lo que cambia es cómo se
 * llega al número, no qué se está haciendo.
 *
 * - `porcentaje`: la forma normal. El directorio decide *"le damos el 3,2 %"* y el sistema hace la
 *   cuenta sobre la cuota vigente **de cada unidad**. Si el barrio tiene importes distintos por
 *   unidad, el porcentaje se aplica a cada uno: es la única lectura de "aumentar un 3,2 %" que no
 *   inventa nada.
 * - `importe`: para el primer período del barrio —no hay contra qué aplicar un porcentaje— y para el
 *   ajuste que se fija en pesos. **Iguala a todas las unidades**, y por eso la pantalla lo advierte
 *   cuando hay importes distintos.
 *
 * **`redondeo` no tiene default y es a propósito.** Redondear cambia lo que se cobra; el sistema no
 * puede elegirlo en silencio. Se elige en la pantalla, se ve el resultado, y recién ahí se confirma.
 */
export const definirCuotaFijaSchema = z.intersection(
  z.object({
    barrioId: idSchema,
    /**
     * **Desde qué PERÍODO rige, no desde qué día.**
     *
     * El valor de la expensa se decide por mes: "la de septiembre es tal". Que se cargue el 28 de
     * agosto o el 2 de septiembre no cambia nada — lo que manda es a qué mes se le aplica. Pedir un
     * día obligaba a elegir uno, y un día mal elegido (el 15) parte el mes en dos versiones sin que
     * nadie lo haya querido: la liquidación toma la vigente al **primer día** del período, así que
     * cualquier fecha del 2 al 31 se comporta igual que la del 1 y solo agrega formas de equivocarse.
     *
     * El servicio lo convierte a la fecha del día 1, que es lo que guarda la columna.
     */
    rigeDesde: periodoSchema,
    /** Qué la aprobó: "Acta de directorio 112", "Resolución del administrador". */
    descripcion: textoOpcionalSchema(300),
    /**
     * **El único campo opcional del esquema**, y el mismo patrón que `confirmarMontoInusual`: en el
     * primer intento no existe, porque todavía nadie preguntó nada. Aparece solo cuando la persona
     * marcó la casilla del pedido de confirmación que devolvió el servidor.
     */
    confirmarCuotaEnCero: confirmacionExplicitaSchema.optional(),
  }),
  z.discriminatedUnion("forma", [
    z.object({
      forma: z.literal("porcentaje"),
      porcentaje: porcentajeDeAjusteSchema,
      redondeo: z.enum(REDONDEOS),
    }),
    z.object({
      forma: z.literal("importe"),
      importe: importePositivoSchema,
    }),
  ]),
);
export type DefinirCuotaFija = z.infer<typeof definirCuotaFijaSchema>;
