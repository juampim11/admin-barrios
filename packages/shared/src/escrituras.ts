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
import { MODELOS_EXPENSA } from "./liquidacion.ts";
import { origenPagoSchema, contentTypeComprobanteSchema } from "./cobros.ts";
import { medioPagoOPSchema } from "./proveedores.ts";
import { leerDocumento, normalizarAlias, normalizarCbu, normalizarCuit } from "./cuentas.ts";
import { estadoUnidadSchema, tipoObligadoSchema } from "./barrio.ts";

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
export const motivoSchema = z
  .string()
  .trim()
  .min(5, "el motivo: contá en una frase por qué se anula (queda registrado y no se puede editar)")
  .max(500);

/** El motivo de un rechazo: mismas reglas que `motivoSchema`, con un mensaje que habla de rechazar. */
export const motivoRechazoSchema = z
  .string()
  .trim()
  .min(5, "el motivo: contá en una frase por qué se rechaza la orden (queda registrado y no se puede editar)")
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

/**
 * La misma confirmación, pero que **puede no existir**: ausente queda ausente. En zod 4 un
 * `.default()` adentro de un `.optional()` se aplica igual cuando falta la clave (en zod 3 no), así que
 * `confirmacionExplicitaSchema.optional()` dejaba de distinguir "no se preguntó" de "dijo que no".
 */
const confirmacionExplicitaOpcionalSchema = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === "true" || v === "on" || v === "1")
  .optional();

// ── 1. Crear un período ────────────────────────────────────────────────────────────────────────

/**
 * **`estado` no está, y es deliberado.** Un período nace en `borrador` por trigger
 * (`app.periodo_nace_en_borrador`, migración `0013` §2). Aceptarlo por parámetro sería ofrecer un
 * campo que la base pisa: el clásico control que parece existir y no existe.
 *
 * **`modelo` SÍ está, y NO tiene default.** Es el cambio del 2026-08-04 y conviene decir qué estaba
 * mal antes: el campo no existía, así que todo período creado desde la pantalla se quedaba con el
 * `default 'variable'` de la columna (`0006`). En un barrio de cuota fija eso convertía cada mes
 * nuevo en uno que reparte gastos —y de paso escondía el acceso al valor de la expensa, que la
 * pantalla muestra según el modelo de los períodos que existen—. Estaba tapado solo porque los
 * períodos del barrio de demostración los sembraba un script.
 *
 * Que no tenga default es la parte que importa, y es la misma decisión que ya tomaron
 * `clasificacionFiscal` (la migración `0014` le sacó el default justamente para que dar de alta
 * obligue a declarar el encuadre) y `redondeo` (redondear cambia lo que se cobra: el sistema no
 * puede elegirlo en silencio). **`variable` no es la opción neutra**: es *repartir los gastos del
 * mes*, una forma de determinar lo que paga cada unidad tan concreta como la otra. Un formulario que
 * no mande el campo tiene que rebotar, no crear un mes en prorrateo.
 *
 * No confundirlo con el `.default(false)` de `confirmacionExplicitaSchema`, veinte líneas más
 * arriba: ahí la ausencia significa "no confirmó" y deja el candado **cerrado**. Acá no hay valor
 * seguro que asumir — los dos modelos cobran, nada más que de forma distinta.
 *
 * Los vencimientos son opcionales porque en la operatoria real se cargan después, cuando el barrio
 * decide la fecha — y un período sin vencimiento se puede liquidar igual.
 */
export const crearPeriodoSchema = z
  .object({
    barrioId: idSchema,
    periodo: periodoSchema,
    /*
     * ⚠ **Un solo `error` para todos los casos, no uno por caso.** En zod 3 esto era `errorMap`, y no
     * `required_error`/`invalid_type_error`: con esos dos, el caso "llegó un valor que no está en la
     * lista" —que incluye la cadena vacía de un radio sin marcar— salía con el texto por defecto en
     * inglés. En zod 4 (BL-008) el parámetro `error` con un texto hace lo mismo que aquel `errorMap`:
     * reemplaza el mensaje de cualquier problema de este campo.
     *
     * Un solo texto para las tres formas de llegar mal, a propósito: para quien mira la pantalla,
     * "no elegiste" y "elegiste algo que no existe" son la misma situación —el campo sigue sin
     * resolverse— y la segunda solo se alcanza armando el POST a mano.
     */
    modelo: z.enum(MODELOS_EXPENSA, {
      // zod 4: `error` reemplaza a `errorMap` con la misma semántica (vale para todos los casos).
      error: "elegí cómo se calcula lo que paga cada unidad en este mes",
    }),
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
    confirmarCuotaEnCero: confirmacionExplicitaOpcionalSchema,
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

// ── 7. Cobros: registrar y anular un pago, imputarlo contra liquidaciones ─────────────────────────
//
// El mismo criterio del resto del archivo: acá se valida FORMA, no negocio. Que el barrio derive de
// la unidad, que la unidad y el pago sean del mismo barrio, que una imputación no supere el saldo de
// la liquidación o el remanente del pago — todo eso lo hace cumplir la base (`app.pago_antes()` y
// `app.pago_imputacion_antes()`, migraciones `0033` y `0035`). Lo único que se replica acá es el
// pareo `origen`/`comprobanteAdjunto`, y solo para que el mensaje caiga en el campo del formulario en
// vez de rebotar contra el `CHECK` de la base (`pago_manual_exige_registrador_chk`).

/**
 * Registrar un pago. **`barrioId` no está**: se deriva de `unidadFuncionalId` bajo RLS, mismo
 * criterio que `registrarGastoSchema` deriva el barrio del período — un `barrioId` de más sería el
 * aislamiento dependiendo de un valor que manda el cliente.
 *
 * **`usuarioRegistrador` tampoco está**: lo escribe la base desde `app.current_user_id()` cuando
 * `origen = 'manual'`; un `extracto` no tiene registrador humano (nace de una futura ingesta).
 */
export const registrarPagoSchema = z
  .object({
    unidadFuncionalId: idSchema,
    /** El obligado a cuyo nombre se registra el cobro. Opcional: la unidad puede no tener uno vigente. */
    obligadoId: opcionalDeFormulario(idSchema),
    monto: importePositivoSchema,
    fecha: fechaIsoSchema,
    origen: origenPagoSchema,
    /**
     * Storage key del comprobante, ya subido antes de llamar a este servicio (la subida en sí es un
     * paso aparte, de `packages/almacenamiento`). **Obligatorio en un pago manual, ausente en uno de
     * extracto** — `pago_manual_exige_registrador_chk` hace cumplir lo mismo del lado de la base.
     */
    comprobanteAdjunto: opcionalDeFormulario(textoSchema(300, "el comprobante")),
  })
  .superRefine((v, ctx) => {
    if (v.origen === "manual" && v.comprobanteAdjunto === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comprobanteAdjunto"],
        message: "un pago cargado a mano necesita el comprobante adjunto",
      });
    }
    if (v.origen === "extracto" && v.comprobanteAdjunto !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comprobanteAdjunto"],
        message: "un pago de extracto no lleva un comprobante cargado a mano",
      });
    }
  });
export type RegistrarPago = z.infer<typeof registrarPagoSchema>;

export const anularPagoSchema = z.object({ pagoId: idSchema, motivo: motivoSchema });
export type AnularPago = z.infer<typeof anularPagoSchema>;

/**
 * Imputación manual, línea por línea: este pago contra esta liquidación, por este importe.
 *
 * **`barrioId` no está**: lo deriva `app.pago_imputacion_antes()` de la fila de `pago`, y verifica
 * que la `liquidacion` elegida sea del mismo barrio antes de aceptar la fila (mismo criterio que el
 * "AGUJERO 2" de `0023`: el período/la unidad de otro barrio da el mismo mensaje que si no existiera).
 */
export const imputarPagoSchema = z.object({
  pagoId: idSchema,
  liquidacionId: idSchema,
  montoImputado: importePositivoSchema,
});
export type ImputarPago = z.infer<typeof imputarPagoSchema>;

export const anularImputacionSchema = z.object({ imputacionId: idSchema, motivo: motivoSchema });
export type AnularImputacion = z.infer<typeof anularImputacionSchema>;

/**
 * Imputación automática de un pago, según `barrio.orden_imputacion` (migración `0036`). Un solo
 * campo: el resto lo decide `app.resolver_imputacion()` contra las liquidaciones con saldo pendiente
 * de la unidad del pago.
 */
export const resolverImputacionAutomaticaSchema = z.object({ pagoId: idSchema });

// ── Interés por pago fuera de término y condonación (ADR-0009) ───────────────────────────────

/** Los motivos de una condonación: cerrados, y el texto de `detalle` dice el resto. */
export const MOTIVOS_CONDONACION = ["negociacion", "comision_asamblea", "error", "otro"] as const;
export type MotivoCondonacion = (typeof MOTIVOS_CONDONACION)[number];
export const ETIQUETA_MOTIVO_CONDONACION: Record<MotivoCondonacion, string> = {
  negociacion: "Negociación",
  comision_asamblea: "Condonación de la comisión o asamblea",
  error: "Error",
  otro: "Otro",
};
const TIPOS_RESPALDO_CONDONACION = ["reglamento", "acta_asamblea", "acta_comision", "otro"] as const;

/**
 * Por qué no se cobra un interés: motivo, texto y respaldo opcional (el mismo de la tasa de T1). Es
 * la misma forma para «No cobrar interés de este pago» y para «Condonar» desde el estado de cuenta.
 */
const datosDeCondonacion = {
  motivo: z.enum(MOTIVOS_CONDONACION, { error: "Elegí el motivo." }),
  detalle: z.string().trim().min(10, "Contá el motivo en al menos 10 caracteres: queda en el registro.").max(500),
  respaldoTipo: opcionalDeFormulario(z.enum(TIPOS_RESPALDO_CONDONACION)).default(null),
  respaldoReferencia: opcionalDeFormulario(textoSchema(300, "la referencia del respaldo")).default(null),
  respaldoAdjunto: opcionalDeFormulario(textoSchema(300, "el adjunto")).default(null),
};
const respaldoCompleto = (v: { respaldoTipo: unknown; respaldoReferencia: unknown; respaldoAdjunto: unknown }, ctx: z.RefinementCtx) => {
  if ((v.respaldoTipo === null) !== (v.respaldoReferencia === null)) {
    ctx.addIssue({ code: "custom", path: ["respaldoReferencia"], message: "El respaldo lleva el instrumento y su referencia, los dos." });
  }
  if (v.respaldoAdjunto !== null && v.respaldoTipo === null) {
    ctx.addIssue({ code: "custom", path: ["respaldoTipo"], message: "Para adjuntar el respaldo, decí de qué instrumento es." });
  }
};

export const noCobrarInteresSchema = z.object(datosDeCondonacion).superRefine(respaldoCompleto);
export type NoCobrarInteres = z.infer<typeof noCobrarInteresSchema>;

/** Las opciones de la pantalla de registrar pago: la confirmación del interés y «No cobrar interés». */
export const opcionesDelPagoSchema = z.object({
  confirmarPagoConInteres: confirmacionExplicitaSchema,
  noCobrarInteres: confirmacionExplicitaSchema,
  /**
   * Los dos renglones de «No cobrar interés» (encargo 11, BL-030 j): el interés de este atraso y el
   * anterior que la unidad todavía debe. Cuentan solo con `noCobrarInteres` marcado.
   */
  noCobrarInteresDelPago: confirmacionExplicitaSchema,
  noCobrarInteresAnterior: confirmacionExplicitaSchema,
});

export const imputarPagoConInteresSchema = z.object({
  pagoId: idSchema,
  /** Si viene, el interés se condona en el mismo acto, con estos datos (motivo, detalle, respaldo). */
  noCobrarInteres: noCobrarInteresSchema.nullable().default(null),
  /**
   * Qué partes condona (encargo 11, BL-030 j): el interés que devengó este pago (`delPago`) y el
   * interés anterior que la unidad todavía debe (`anterior`). Sin decir, solo el de este pago.
   */
  condonar: z.object({ delPago: z.boolean(), anterior: z.boolean() }).default({ delPago: true, anterior: false }),
});
export type ImputarPagoConInteres = z.input<typeof imputarPagoConInteresSchema>;

export const condonarInteresSchema = z
  .object({
    unidadFuncionalId: idSchema,
    monto: importePositivoSchema,
    ...datosDeCondonacion,
    /** La segunda vez, con el importe a la vista (`condonacion_requiere_confirmacion`). */
    confirmarCondonacion: confirmacionExplicitaOpcionalSchema,
  })
  .superRefine(respaldoCompleto);
export type CondonarInteres = z.input<typeof condonarInteresSchema>;

export type ResolverImputacionAutomatica = z.infer<typeof resolverImputacionAutomaticaSchema>;

/**
 * Pedido de una URL de subida para el comprobante de un pago manual (`prepararSubidaDeComprobante`,
 * `packages/data/src/servicios/documentos.ts`). **`barrioId` no está**, mismo criterio que
 * `registrarPagoSchema`: lo deriva el servicio de la propia `unidadFuncionalId`, bajo RLS.
 *
 * `contentType` usa el mismo catálogo cerrado que valida el POST presignado (`eq` exacto, panel
 * `arquitecto-software` + `security-engineer`, 2026-08-18): declarar acá un valor fuera de la lista
 * ni siquiera llega a pedirle una firma al storage.
 */
export const prepararSubidaDeComprobanteSchema = z.object({
  unidadFuncionalId: idSchema,
  contentType: contentTypeComprobanteSchema,
});
export type PrepararSubidaDeComprobante = z.infer<typeof prepararSubidaDeComprobanteSchema>;

// ── 5. Proveedores / Órdenes de pago (doc 01 §4.6) ────────────────────────────────────────────

/**
 * Las condiciones fiscales que se eligen para un proveedor (encargo 10, BL-030 g): la lista que pidió
 * el usuario, tal cual. Antes era texto libre, y el mismo régimen aparecía escrito de tres maneras.
 *
 * **Los valores viejos se respetan.** Un proveedor cargado antes con un texto que no está acá se
 * muestra con ese texto, y al editarlo el desplegable lo ofrece tal cual (`opcionesDeCondicionFiscal`):
 * guardar la edición no lo cambia sin que nadie lo decida. Por eso el esquema sigue aceptando texto.
 */
export const CONDICIONES_FISCALES = [
  "Responsable Inscripto",
  "Monotributo",
  "Exento",
  "IVA no alcanzado",
  "Consumidor final",
] as const;
export type CondicionFiscal = (typeof CONDICIONES_FISCALES)[number];

/** Las opciones del desplegable: la lista y, si el proveedor tenía otro valor, ese valor tal cual. */
export function opcionesDeCondicionFiscal(actual: string | null | undefined): readonly { valor: string; texto: string }[] {
  const lista = CONDICIONES_FISCALES.map((c) => ({ valor: c, texto: c }));
  const viejo = actual?.trim() ?? "";
  if (viejo === "" || (CONDICIONES_FISCALES as readonly string[]).includes(viejo)) return lista;
  return [...lista, { valor: viejo, texto: `${viejo} (como estaba cargado)` }];
}

/**
 * Alta de un proveedor del catálogo del barrio. **`barrioId` SÍ está, a diferencia del resto de este
 * archivo** — corrección de un docstring que decía lo contrario: un proveedor no cuelga de ningún
 * período ni de ninguna otra fila de la que derivarlo bajo RLS (mismo caso que `crearPeriodoSchema`,
 * la única otra alta del recorrido sin fila de origen), así que lo manda quien llama, como un campo
 * oculto del formulario — la RLS de `insert` lo vuelve a verificar igual.
 * `cuit`/`condicionFiscal`/`contacto`/`cbu`/`alias` son dato, no cálculo — ninguno se infiere ni se
 * completa con un valor por defecto.
 */
export const registrarProveedorSchema = z.object({
  barrioId: idSchema,
  razonSocial: textoSchema(300, "la razón social"),
  cuit: textoOpcionalSchema(20),
  condicionFiscal: textoOpcionalSchema(100),
  contacto: textoOpcionalSchema(300),
  /** El mismo `check` de formato que valida la base (`proveedor_cbu_chk`): 22 dígitos, sin espacios. */
  cbu: opcionalDeFormulario(
    z.string().regex(/^[0-9]{22}$/, "el CBU tiene que tener exactamente 22 dígitos"),
  ),
  alias: textoOpcionalSchema(50),
});
export type RegistrarProveedor = z.infer<typeof registrarProveedorSchema>;

/**
 * `barrioId` viaja acá también (heredado de `registrarProveedorSchema`) pero el servicio
 * (`corregirProveedor()`) no lo usa: deriva el proveedor de `proveedorId` bajo RLS, como cualquier
 * corrección de una fila ya existente. Queda sin tocar en vez de partir el schema en dos: es el mismo
 * campo oculto que ya viaja en la pantalla de alta, y un valor de más que el servicio ignora no es
 * una superficie nueva — la RLS de `update` es la que manda.
 */
export const corregirProveedorSchema = registrarProveedorSchema.extend({ proveedorId: idSchema });
export type CorregirProveedor = z.infer<typeof corregirProveedorSchema>;

export const desactivarProveedorSchema = z.object({ proveedorId: idSchema });
export type DesactivarProveedor = z.infer<typeof desactivarProveedorSchema>;

/** Mismo esquema que `desactivarProveedorSchema`, en esquema propio — mismo criterio que
 *  `aprobarOrdenPagoSchema`/`rechazarOrdenPagoSchema`: una acción, un esquema, aunque la forma
 *  coincida. "Se desactiva, nunca se borra" implica reversible; sin esto era una regresión real
 *  respecto del prototipo aprobado, que sí mostraba "Reactivar" (hallazgo del usuario, 2026-08-26). */
export const reactivarProveedorSchema = z.object({ proveedorId: idSchema });
export type ReactivarProveedor = z.infer<typeof reactivarProveedorSchema>;

/**
 * Carga de una orden de pago, en `pendiente`. **`barrioId` no está** (se deriva de `periodoId` bajo
 * RLS, mismo patrón que `registrarGastoSchema`); **`estado`/`creadaPor` tampoco** (los pone el
 * trigger, `app.orden_pago_transicion()`, `0044`) — ofrecerlos por parámetro sería un campo que la
 * base pisa.
 */
export const registrarOrdenPagoSchema = z.object({
  proveedorId: idSchema,
  periodoId: idSchema,
  conceptoId: idSchema,
  numeroFactura: textoOpcionalSchema(100),
  descripcion: textoSchema(300, "la descripción"),
  monto: importePositivoSchema,
  /**
   * «Mes del servicio» (`YYYY-MM`, encargo 11, BL-030 k): de qué mes es el servicio que se paga.
   * Opcional y solo informativo: **no** cambia el período al que se imputa el gasto (`periodoId`).
   */
  mesServicio: opcionalDeFormulario(
    z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Elegí el mes y el año del servicio."),
  ),
});
export type RegistrarOrdenPago = z.input<typeof registrarOrdenPagoSchema>;

export const aprobarOrdenPagoSchema = z.object({ ordenPagoId: idSchema });
export type AprobarOrdenPago = z.infer<typeof aprobarOrdenPagoSchema>;

/** Rechazar dice por qué (0067): queda en la orden, a la vista de quien la cargó. */
export const rechazarOrdenPagoSchema = z.object({ ordenPagoId: idSchema, motivo: motivoRechazoSchema });
export type RechazarOrdenPago = z.infer<typeof rechazarOrdenPagoSchema>;

/**
 * Marca la orden como pagada. `medioPago` es cómo se ejecutó ESTE pago — no confundir con el
 * `cbu`/`alias` del proveedor, que es dato de contacto y no cambia de una orden a la siguiente.
 */
export const marcarOrdenPagadaSchema = z.object({
  ordenPagoId: idSchema,
  medioPago: medioPagoOPSchema,
});
export type MarcarOrdenPagada = z.infer<typeof marcarOrdenPagadaSchema>;

export const anularOrdenPagoSchema = z.object({ ordenPagoId: idSchema, motivo: motivoSchema });
export type AnularOrdenPago = z.infer<typeof anularOrdenPagoSchema>;

/**
 * Pedido de una URL de subida para el comprobante de una orden de pago
 * (`prepararSubidaDeComprobanteDeOP`, `packages/data/src/servicios/ordenes-pago.ts`). Mismo
 * criterio que `prepararSubidaDeComprobanteSchema`: `barrioId` no está, lo deriva el servicio de la
 * propia `ordenPagoId` bajo RLS.
 */
export const prepararSubidaDeComprobanteDeOPSchema = z.object({
  ordenPagoId: idSchema,
  contentType: contentTypeComprobanteSchema,
});
export type PrepararSubidaDeComprobanteDeOP = z.infer<typeof prepararSubidaDeComprobanteDeOPSchema>;

/**
 * Adjunta el comprobante ya subido (la storage key que devolvió `prepararSubidaDeComprobanteDeOP`).
 * Se puede llamar en cualquier estado de la orden — `app.orden_pago_transicion()` permite
 * `comprobante_adjunto: null → valor` como única excepción al congelamiento fuera de `pendiente`,
 * pero nunca `valor → otro valor`: quien necesita reemplazarlo anula la orden y carga una nueva.
 */
export const adjuntarComprobanteDeOPSchema = z.object({
  ordenPagoId: idSchema,
  storageKey: textoSchema(300, "el comprobante"),
});
export type AdjuntarComprobanteDeOP = z.infer<typeof adjuntarComprobanteDeOPSchema>;

/**
 * Pedido de una URL de subida para la FACTURA de una orden de pago — el documento que entregó el
 * proveedor, distinto del comprobante de pago (arriba). Mismo criterio de forma que
 * `prepararSubidaDeComprobanteDeOPSchema`; lo que cambia es a qué campo llega
 * (`facturaAdjunta`, no `comprobanteAdjunto`) del lado del servicio.
 */
export const prepararSubidaDeFacturaDeOPSchema = z.object({
  ordenPagoId: idSchema,
  contentType: contentTypeComprobanteSchema,
});
export type PrepararSubidaDeFacturaDeOP = z.infer<typeof prepararSubidaDeFacturaDeOPSchema>;

/**
 * Adjunta la factura ya subida. Mismo criterio que `adjuntarComprobanteDeOPSchema`: se puede llamar
 * en cualquier estado, `orden_pago_transicion()` (`0048`) permite `facturaAdjunta: null → valor`
 * pero nunca `valor → otro valor`.
 */
export const adjuntarFacturaDeOPSchema = z.object({
  ordenPagoId: idSchema,
  storageKey: textoSchema(300, "la factura"),
});
export type AdjuntarFacturaDeOP = z.infer<typeof adjuntarFacturaDeOPSchema>;

/**
 * Declara que esta orden de pago NUNCA va a tener factura (proveedor informal, sin CUIT) —
 * distinto de "todavía no llegó", que no necesita ningún campo (`administrador-consorcios`, panel
 * 2026-08-22). `motivo` es obligatorio: `orden_pago_factura_no_disponible_chk` (`0048`) lo exige
 * del lado de la base igual, esto es la primera línea de defensa.
 */
export const marcarFacturaNoDisponibleDeOPSchema = z.object({
  ordenPagoId: idSchema,
  motivo: motivoSchema,
});
export type MarcarFacturaNoDisponibleDeOP = z.infer<typeof marcarFacturaNoDisponibleDeOPSchema>;

// ── Alta de barrio y padrón editable (T3, BL-009) ─────────────────────────────────────────────

/** Un CBU tipeado: 22 dígitos con los dos verificadores bien (la base vuelve a mirar, `app.cbu_valido`). */
const cbuDeFormularioSchema = z.string().transform((t, ctx) => {
  const cbu = normalizarCbu(t);
  if (cbu === null) {
    ctx.addIssue({ code: "custom", message: "El CBU no es válido: tiene que tener 22 dígitos y los verificadores bien." });
    return z.NEVER;
  }
  return cbu;
});
const aliasDeFormularioSchema = z.string().transform((t, ctx) => {
  const alias = normalizarAlias(t);
  if (alias === null) {
    ctx.addIssue({ code: "custom", message: "El alias va de 6 a 20 letras, números, puntos o guiones." });
    return z.NEVER;
  }
  return alias;
});
const cuitDeFormularioSchema = z.string().transform((t, ctx) => {
  const cuit = normalizarCuit(t);
  if (cuit === null) {
    ctx.addIssue({ code: "custom", message: "El CUIT no es válido: revisá el dígito verificador." });
    return z.NEVER;
  }
  return cuit;
});
/** «CUIT, CUIL o DNI» en un solo campo. */
const documentoDeFormularioSchema = z.string().transform((t, ctx) => {
  const d = leerDocumento(t);
  if (d === "invalido" || d === null) {
    ctx.addIssue({ code: "custom", message: "No es un CUIT o CUIL válido (11 dígitos con verificador) ni un DNI (7 u 8 dígitos)." });
    return z.NEVER;
  }
  return d;
});
const mailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(120)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "El mail no tiene la forma nombre@dominio.");
const telefonoSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,25}$/, "El teléfono va con números, espacios, guiones o paréntesis.");
/** Un importe no negativo (la máscara de la pantalla ya lo normaliza a «48200.00»). */
const saldoInicialSchema = montoSchema.refine((m) => !m.startsWith("-"), "El saldo inicial no puede ser negativo.");
/** Superficie en m², con hasta 2 decimales y mayor que cero. «605,50» o «605.50». */
const superficieSchema = z
  .string()
  .trim()
  .transform((t) => (t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t))
  .pipe(z.string().regex(/^\d{1,8}(\.\d{1,2})?$/, "La superficie es un número con hasta 2 decimales (ej. 605,50)."))
  .refine((t) => !/^0+(\.0+)?$/.test(t), "La superficie tiene que ser mayor que cero.");

/** «Malagueño» → «malagueno»: el municipio se guarda como identificador estable (`municipioSchema`). */
export function municipioDesdeNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const FIGURAS_DEL_ALTA = ["sa", "asociacion_civil"] as const;
export const IDENTIFICACIONES_PAGO = ["cuenta_unica", "cuenta_por_unidad"] as const;
export type IdentificacionPago = (typeof IDENTIFICACIONES_PAGO)[number];
export const MEDIOS_DEL_ALTA = ["transferencia-qr", "generico-demo"] as const;
/** Un dato legal: el valor, o «A confirmar» (`""` en el formulario, `null` en la base). */
const legalSchema = <T extends readonly [string, ...string[]]>(valores: T) => opcionalDeFormulario(z.enum(valores)).default(null);

/**
 * Nuevo barrio (pantallas 1 y 2). `administradorId` es el nodo bajo el que se crea: lo manda la
 * pantalla y lo vuelve a verificar la base (`tenant_node_ins`: rol de administración sobre el padre).
 * Los cuatro datos legales aceptan «A confirmar».
 */
export const crearBarrioSchema = z
  .object({
    administradorId: idSchema,
    nombre: textoSchema(80, "el nombre"),
    razonSocial: textoOpcionalSchema(200),
    cuit: opcionalDeFormulario(cuitDeFormularioSchema).default(null),
    municipio: textoSchema(80, "el municipio")
      .transform(municipioDesdeNombre)
      .pipe(z.string().min(1, "el municipio: escribí su nombre")),
    figuraJuridica: z.enum(FIGURAS_DEL_ALTA, { error: "Elegí la figura jurídica: sociedad anónima o asociación civil." }),
    modelo: z.enum(MODELOS_EXPENSA, { error: "Elegí cómo se liquida." }),
    diaVencimiento: z.coerce.number().int().min(1, "Un día del 1 al 28.").max(28, "Un día del 1 al 28: así existe en todos los meses."),
    primerPeriodo: periodoSchema,
    identificacionPago: z.enum(IDENTIFICACIONES_PAGO, { error: "Elegí cómo se identifica el pago." }),
    cuentaCbu: cbuDeFormularioSchema,
    cuentaAlias: opcionalDeFormulario(aliasDeFormularioSchema).default(null),
    recaudador: textoOpcionalSchema(80),
    medioCobranza: z.enum(MEDIOS_DEL_ALTA, { error: "Elegí el medio impreso en la boleta." }),
    codigoPagoPrefijo: z.string().trim().regex(/^[0-9]{0,6}$/, "El prefijo son hasta 6 números (o ninguno).").default(""),
    mandatoDesde: fechaIsoSchema,
    actaAdjunto: opcionalDeFormulario(textoSchema(300, "el acta")).default(null),
    adecuadoArt2075: legalSchema(["si", "no", "en_tramite", "no_aplica"] as const),
    encuadreUrbanistico: legalSchema(["ure", "loteo_abierto", "cierre_calles", "sin_encuadre"] as const),
    serviciosInternos: legalSchema(["municipio", "urbanizacion", "mixto"] as const),
    reglamentoInscripto: legalSchema(["si", "no"] as const),
  })
  .superRefine((v, ctx) => {
    if (v.identificacionPago === "cuenta_unica" && v.recaudador !== null) {
      ctx.addIssue({ code: "custom", path: ["recaudador"], message: "El recaudador es solo para cuentas por unidad." });
    }
    if (v.identificacionPago === "cuenta_por_unidad" && v.recaudador === null) {
      ctx.addIssue({ code: "custom", path: ["recaudador"], message: "Elegí el recaudador de las cuentas por unidad." });
    }
  });
export type CrearBarrio = z.input<typeof crearBarrioSchema>;

/** Un titular en el alta de una unidad o en un cambio de titular. */
export const titularSchema = z.object({
  nombre: textoSchema(200, "el nombre o razón social"),
  caracter: tipoObligadoSchema.default("propietario"),
  documento: opcionalDeFormulario(documentoDeFormularioSchema).default(null),
  mail: opcionalDeFormulario(mailSchema).default(null),
  telefono: opcionalDeFormulario(telefonoSchema).default(null),
});
export type Titular = z.infer<typeof titularSchema>;

const datosDeUnidad = {
  superficie: opcionalDeFormulario(superficieSchema).default(null),
  estado: estadoUnidadSchema,
  nomenclatura: textoOpcionalSchema(60),
  cbu: opcionalDeFormulario(cbuDeFormularioSchema).default(null),
  alias: opcionalDeFormulario(aliasDeFormularioSchema).default(null),
};

/**
 * Agregar unidad (pantalla 3). Varios titulares, **una sola** marca de «Recibe la boleta»
 * (`recibeBoleta` es el índice). El código de pago lo asigna la base (`0059`).
 */
export const agregarUnidadSchema = z
  .object({
    barrioId: idSchema,
    manzana: textoSchema(20, "la manzana"),
    lote: textoSchema(20, "el lote"),
    ...datosDeUnidad,
    saldoInicial: opcionalDeFormulario(saldoInicialSchema).default(null),
    titulares: z.array(titularSchema).max(6, "Hasta 6 titulares por unidad.").default([]),
    recibeBoleta: z.coerce.number().int().min(0).default(0),
    /** La segunda vez, si un documento ya era de otra persona del barrio con otro nombre. */
    confirmarTitularRegistrado: confirmacionExplicitaOpcionalSchema,
  })
  .superRefine((v, ctx) => {
    if (v.titulares.length > 0 && v.recibeBoleta >= v.titulares.length) {
      ctx.addIssue({ code: "custom", path: ["recibeBoleta"], message: "Marcá quién recibe la boleta." });
    }
    const docs = v.titulares.flatMap((t) => (t.documento ? [`${t.documento.tipo}:${t.documento.numero}`] : []));
    if (new Set(docs).size !== docs.length) {
      ctx.addIssue({ code: "custom", path: ["titulares"], message: "El mismo documento está en dos titulares." });
    }
  });
export type AgregarUnidad = z.input<typeof agregarUnidadSchema>;

/** Editar (sin tocar manzana ni lote: identifican la unidad). */
export const editarUnidadSchema = z.object({
  unidadFuncionalId: idSchema,
  ...datosDeUnidad,
  saldoInicial: opcionalDeFormulario(saldoInicialSchema).default(null),
  mailPrincipal: opcionalDeFormulario(mailSchema).default(null),
});
export type EditarUnidad = z.input<typeof editarUnidadSchema>;

export const MOTIVOS_CAMBIO_TITULAR = ["venta", "sucesion", "correccion", "otro"] as const;
export const ETIQUETA_MOTIVO_CAMBIO_TITULAR: Record<(typeof MOTIVOS_CAMBIO_TITULAR)[number], string> = {
  venta: "Venta",
  sucesion: "Sucesión",
  correccion: "Corrección de datos",
  otro: "Otro",
};
export const TIPOS_RESPALDO_TITULAR = ["escritura", "boleto", "nota", "otro"] as const;
export const ETIQUETA_RESPALDO_TITULAR: Record<(typeof TIPOS_RESPALDO_TITULAR)[number], string> = {
  escritura: "Escritura",
  boleto: "Boleto de compraventa",
  nota: "Nota",
  otro: "Otro",
};

/**
 * Cambiar titular (pantalla 5): los titulares actuales cierran el día anterior a `desde`, y la deuda
 * sigue con la unidad (ADR-0010 §4, panel `legal-ph`).
 */
export const cambiarTitularSchema = z
  .object({
    unidadFuncionalId: idSchema,
    desde: fechaIsoSchema,
    titular: titularSchema,
    motivo: z.enum(MOTIVOS_CAMBIO_TITULAR, { error: "Elegí el motivo." }),
    detalle: textoOpcionalSchema(500),
    respaldoTipo: opcionalDeFormulario(z.enum(TIPOS_RESPALDO_TITULAR)).default(null),
    respaldoReferencia: opcionalDeFormulario(textoSchema(300, "la referencia del respaldo")).default(null),
    respaldoAdjunto: opcionalDeFormulario(textoSchema(300, "el adjunto")).default(null),
    confirmarTitularRegistrado: confirmacionExplicitaOpcionalSchema,
  })
  .superRefine((v, ctx) => {
    if (v.respaldoAdjunto !== null && v.respaldoTipo === null) {
      ctx.addIssue({ code: "custom", path: ["respaldoTipo"], message: "Para adjuntar el respaldo, decí qué documento es." });
    }
  });
export type CambiarTitular = z.input<typeof cambiarTitularSchema>;

export const MOTIVOS_BAJA = ["unificacion", "subdivision", "carga_por_error", "otro"] as const;
export const ETIQUETA_MOTIVO_BAJA: Record<(typeof MOTIVOS_BAJA)[number], string> = {
  unificacion: "Unificación con otro lote",
  subdivision: "Subdivisión",
  carga_por_error: "Carga por error",
  otro: "Otro",
};

/** Dar de baja: no recibe boleta desde el período siguiente, conserva su historia y su deuda. */
export const darDeBajaSchema = z.object({
  unidadFuncionalId: idSchema,
  motivo: z.enum(MOTIVOS_BAJA, { error: "Elegí el motivo." }),
  detalle: z.string().trim().min(10, "Contá el motivo en al menos 10 caracteres: queda en el historial.").max(500),
});
export type DarDeBaja = z.input<typeof darDeBajaSchema>;

/** Nueva versión de coeficientes (pantalla 6). La planilla, si es por planilla, viaja aparte. */
export const nuevaVersionCoeficientesSchema = z
  .object({
    barrioId: idSchema,
    forma: z.enum(["superficie", "iguales", "planilla"] as const, { error: "Elegí cómo se calculan." }),
    rigeDesde: periodoSchema,
    respaldoTipo: opcionalDeFormulario(z.enum(["reglamento", "acta_asamblea", "otro"] as const)).default(null),
    respaldoReferencia: opcionalDeFormulario(textoSchema(300, "la referencia del respaldo")).default(null),
    respaldoAdjunto: opcionalDeFormulario(textoSchema(300, "el adjunto")).default(null),
  })
  .superRefine((v, ctx) => {
    if ((v.respaldoTipo === null) !== (v.respaldoReferencia === null)) {
      ctx.addIssue({ code: "custom", path: ["respaldoReferencia"], message: "El respaldo lleva el instrumento y su referencia, los dos." });
    }
  });
export type NuevaVersionCoeficientes = z.input<typeof nuevaVersionCoeficientesSchema>;
