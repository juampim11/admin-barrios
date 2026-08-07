/**
 * De un error de Postgres a algo que le sirva a una persona — **lista de permitidos, no `e.message`**.
 *
 * ## Por qué existe este archivo
 *
 * Todo el módulo de expensas hace cumplir sus reglas en la base: `raise exception` en los triggers,
 * `check`, `unique` y FK. Eso es exactamente lo que se quería (un control que la app no puede
 * saltear), pero deja un problema propio: **el mensaje crudo no se puede mostrar**.
 *
 * Dos motivos, los dos concretos y verificables en este esquema:
 *
 * 1. **Filtra datos que la RLS no dejaba ver.** Los `raise exception` interpolan valores de filas
 *    (`'el concepto "%" no tiene valor vigente al %'`, `'el descuento puede llegar a % y el tope del
 *    operador es %'`), y un `unique_violation` trae el valor en conflicto en su `detail`. La RLS
 *    filtra el `select`; no filtra el mensaje de error (ADR-0002 §4.2).
 * 2. **No le dice a nadie qué hacer.** `new row violates row-level security policy for table
 *    "gasto_periodo"` es correcto y es inútil: el administrador ve un error y no sabe si tiene que
 *    corregir un dato, pedirle a otra persona que lo haga, o avisar que algo está roto.
 *
 * ## Cómo funciona
 *
 * Una tabla de reglas. Cada regla dice **cuándo** aplica (por nombre de constraint, por SQLSTATE, o
 * por un patrón sobre el mensaje) y **qué se muestra**: un texto escrito por nosotros y una
 * sugerencia. Los valores del error original solo salen si la regla los pide **explícitamente**, y
 * cada una de esas decisiones está justificada en su comentario. El default —cuando nada matchea— es
 * un texto genérico con un identificador de correlación.
 *
 * **El error original nunca se pierde:** viaja en `cause` del `ErrorDeNegocio` y se registra con
 * `registrarParaElLog()`. Lo que no hace es llegar a una pantalla.
 *
 * ## Dónde se aplica
 *
 * En los propios servicios de escritura, con `enBase()`. No en el llamador. Es la regla del enunciado
 * de esta tanda: *ninguna escritura puede depender de que el llamador se acuerde de algo*. Si la
 * traducción viviera en la Server Action, la primera ruta nueva —o el worker, o un script— la
 * saltearía sin que nada fallara.
 */

import { randomUUID } from "node:crypto";
import { ErrorDeNegocio, type CodigoError } from "@admin-barrios/shared/errores";

/** Lo que expone un error de `pg`. No se importa el tipo del driver: acá alcanza la forma. */
type ErrorPostgres = {
  readonly code?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly message?: string;
  readonly detail?: string;
};

/**
 * Busca el error del driver en la cadena de `cause`.
 *
 * Hace falta porque Drizzle puede envolver el error del driver, y una versión que hoy no envuelve
 * puede envolver mañana. Sin este recorrido, un cambio de versión de Drizzle degradaría **todas** las
 * traducciones a "desconocido" en silencio: el gate seguiría verde y las pantallas empezarían a
 * mostrar el texto genérico. Hay un test que lo cubre con el error anidado.
 */
function errorDePostgres(e: unknown): ErrorPostgres | null {
  let actual: unknown = e;
  for (let i = 0; i < 5 && actual !== null && typeof actual === "object"; i++) {
    const posible = actual as ErrorPostgres & { cause?: unknown };
    if (typeof posible.code === "string" && /^[0-9A-Z]{5}$/.test(posible.code)) return posible;
    actual = posible.cause;
  }
  return null;
}

type Regla = {
  readonly codigo: CodigoError;
  /** Nombre exacto del constraint que violó. Es la señal más precisa que da Postgres. */
  readonly constraint?: string;
  /** SQLSTATE. Se usa solo cuando no hay constraint (RLS, permisos). */
  readonly sqlstate?: string;
  /**
   * Patrón sobre el mensaje. **Solo para los `raise exception` que escribimos nosotros**, cuyo texto
   * está fijado en una migración ya aplicada y por lo tanto no cambia. Nunca sobre mensajes del
   * motor, que dependen de la versión y del idioma del servidor.
   */
  readonly patron?: RegExp;
  /**
   * El texto que ve la persona. Recibe los grupos capturados por `patron`, y cada regla decide cuáles
   * usa: **capturar no es mostrar**. Ver la justificación en cada caso.
   */
  readonly mensaje: (g: readonly string[]) => string;
  readonly sugerencia: string;
  /** Valores seguros que se adjuntan para que la UI los pueda resaltar. Mismo criterio. */
  readonly datos?: (g: readonly string[]) => Record<string, string>;
};

/**
 * El catálogo. **Cerrado**: lo que no está acá se degrada a `desconocido`.
 *
 * El orden importa: se devuelve la primera que matchea, y las reglas por `constraint` van antes que
 * las de SQLSTATE porque son más precisas (una violación de `uq_periodo_barrio` también es un `23505`).
 */
const REGLAS: readonly Regla[] = [
  // ── Período ─────────────────────────────────────────────────────────────────────────────────
  {
    codigo: "periodo_ya_existe",
    constraint: "uq_periodo_barrio",
    // No se muestra el `detail` del unique, que trae el par (barrio_id, periodo) en crudo. El período
    // lo acaba de tipear la persona: no hace falta devolvérselo desde la base.
    mensaje: () => "Este barrio ya tiene un período con ese mes.",
    sugerencia: "Abrí el período que ya existe, o elegí otro mes.",
  },
  {
    codigo: "periodo_no_editable",
    // `app.periodo_editable` (migración 0013 §1). El estado sí se muestra: es del período que la
    // persona está mirando y que ya puede leer, y sin él el mensaje no explica nada.
    patron: /^el período ya está (\w+)\s*: no se edita/,
    mensaje: (g) => `El período ya está ${g[1] ?? "emitido"}: no se puede modificar.`,
    sugerencia:
      "Un período emitido no se corrige: la diferencia se registra en el período siguiente. " +
      "Si todavía no se distribuyó y hay un error grave, hablalo con quien administra el barrio.",
    datos: (g) => ({ estado: g[1] ?? "" }),
  },
  {
    codigo: "periodo_no_editable",
    // Falla cerrado de `app.periodo_editable`: no pudo determinar el período o el período no existe.
    // No se muestra el uuid: no aporta nada a quien mira la pantalla y sí al log.
    patron: /^(no se pudo determinar el período de la fila|el período .* no existe): se rechaza por seguridad/,
    mensaje: () => "No se pudo verificar a qué período pertenece este dato, así que no se guardó.",
    sugerencia: "Recargá la pantalla y volvé a intentar. Si sigue pasando, es un problema del sistema.",
  },
  {
    codigo: "transicion_invalida",
    patron: /^transición de estado inválida: (\w+) → (\w+)/,
    mensaje: (g) => `Un período ${g[1] ?? ""} no puede pasar a ${g[2] ?? ""}.`,
    sugerencia: "Recargá la pantalla: el período ya cambió de estado, probablemente desde otra sesión.",
  },
  {
    codigo: "coeficientes_sin_cerrar",
    patron: /^la versión de coeficientes del período no está cerrada/,
    mensaje: () => "La versión de coeficientes del barrio todavía está abierta.",
    sugerencia:
      "Hay que cerrar la versión de coeficientes antes de emitir: mientras esté abierta, los " +
      "porcentajes pueden cambiar y las boletas dejarían de poder rehacerse.",
  },
  {
    codigo: "sin_coeficientes",
    patron: /^el período no tiene versión de coeficientes/,
    mensaje: () => "El período no tiene una versión de coeficientes asignada.",
    sugerencia: "Generá el borrador antes de emitir: ahí se fija contra qué versión se liquidó.",
  },
  {
    codigo: "periodo_no_cuadra",
    // Las cifras SÍ se muestran: son agregados del período que se está emitiendo, y quien emite ya
    // tiene rol de gestión sobre ese barrio (`ROLES_QUE_EMITEN`), o sea que puede leer los gastos y
    // las liquidaciones de las que salen. Sin los números, "no cuadra" no se puede investigar.
    patron: /^el período no cuadra \(modelo (\w+)\): esperado ([\d.-]+) y repartido ([\d.-]+) \(diferencia ([\d.-]+)\)/,
    mensaje: (g) =>
      `El período no cuadra: hay $ ${g[2] ?? "?"} para repartir y las boletas suman $ ${g[3] ?? "?"} ` +
      `(diferencia de $ ${g[4] ?? "?"}).`,
    sugerencia:
      "Volvé a generar el borrador. Si la diferencia sigue, es que se cargó o se borró un gasto " +
      "después de generarlo.",
    datos: (g) => ({ esperado: g[2] ?? "", repartido: g[3] ?? "", diferencia: g[4] ?? "" }),
  },
  {
    codigo: "periodo_no_cuadra",
    patron: /^el período no cuadra: (.+)$/,
    // ⚠ **ESTA REGLA ES UN PASO DIRECTO: muestra lo que sea que la función interpole**, incluidos
    // importes. Hoy son agregados del período que se está emitiendo —cargos contra aplicaciones,
    // cuotas fijas contra su versión, subtotales contra sus líneas— y quien emite tiene rol de
    // gestión sobre ese barrio, así que ya los puede leer. Por eso está bien HOY.
    //
    // Lo que hay que saber antes de tocar `app.validar_emision`: **agregar un `raise exception` con
    // el prefijo "el período no cuadra:" es modificar el canal de errores de la aplicación.** Si ese
    // mensaje nuevo interpola algo que no sea un agregado del propio período —el nombre de un
    // obligado, el detalle de un cargo, un dato de otra tabla— sale a la pantalla sin que nadie lo
    // revise. En ese caso hay que escribirle su propia regla ARRIBA de esta.
    mensaje: (g) => `El período no cuadra: ${g[1] ?? ""}`,
    sugerencia: "Volvé a generar el borrador y revisá la grilla antes de emitir.",
  },
  {
    // `app.validar_aplicaciones` (0017 §8) — la tercera capa anti-adulteración. Dispara cuando
    // alguien logró meter un importe infiel en `concepto_boleta_unidad`: es el evento más grave que
    // este módulo puede detectar, y caía a "No se pudo completar la operación." Sale con nombre.
    codigo: "periodo_no_cuadra",
    patron: /^hay (\d+) descuentos calculados sobre una base que no es la de su liquidación/,
    mensaje: (g) =>
      `Hay ${g[1] ?? "?"} descuentos calculados sobre una base que no es la de la boleta de esa unidad.`,
    sugerencia:
      "Volvé a generar el borrador: el importe de un descuento lo calcula la base contra la propia " +
      "liquidación. Si después de regenerar sigue apareciendo, avisá con el código de referencia: " +
      "significa que esas filas se escribieron por fuera del sistema.",
  },
  {
    codigo: "periodo_no_cuadra",
    patron: /^hay (\d+) aplicaciones cuyo importe no coincide con el valor aprobado del catálogo/,
    mensaje: (g) =>
      `Hay ${g[1] ?? "?"} cargos o descuentos cuyo importe no coincide con el valor aprobado del catálogo.`,
    sugerencia:
      "El período no se emite así. Anulá esas aplicaciones y volvé a cargarlas. Si vuelve a pasar, " +
      "avisá con el código de referencia.",
  },
  {
    codigo: "periodo_incompleto",
    patron: /^el período liquida por cuota fija pero no tiene una versión de cuota asignada/,
    mensaje: () => "El período cobra cuota fija y no tiene asignada una versión de cuotas.",
    sugerencia: "Generá el borrador antes de emitir: ahí se fija contra qué versión de cuotas se liquidó.",
  },
  {
    codigo: "periodo_no_encontrado",
    // `app.resolver_aplicaciones` con un período inexistente. No se muestra el uuid: no le dice nada
    // a quien mira la pantalla y sí queda en el log.
    patron: /^el período \S+ no existe$/,
    mensaje: () => "El período no existe o no tenés acceso.",
    sugerencia: "Volvé al listado de períodos del barrio y entrá de nuevo.",
  },
  {
    codigo: "transicion_invalida",
    patron: /^un período nace en borrador/,
    mensaje: () => "Un período se crea en borrador: emitir es un paso posterior, no un estado inicial.",
    sugerencia: "Creá el período, cargale los gastos, generá el borrador y recién ahí emitilo.",
  },
  {
    codigo: "periodo_incompleto",
    patron: /^faltan liquidaciones: (\d+) unidades activas y (\d+) liquidaciones/,
    mensaje: (g) =>
      `Faltan boletas: el barrio tiene ${g[1] ?? "?"} unidades activas y hay ${g[2] ?? "?"} boletas generadas.`,
    sugerencia:
      "Volvé a generar el borrador. Si la diferencia sigue, hay unidades sin coeficiente en la " +
      "versión con la que se liquidó, o se dio de alta una unidad después de generar.",
    datos: (g) => ({ unidades: g[1] ?? "", liquidaciones: g[2] ?? "" }),
  },
  {
    codigo: "periodo_incompleto",
    patron: /^faltan (\d+) cuotas fijas/,
    mensaje: (g) => `Hay ${g[1] ?? "?"} unidades activas sin cuota fija asignada.`,
    sugerencia: "Cargá la cuota de esas unidades en la versión vigente y volvé a generar el borrador.",
  },
  {
    codigo: "periodo_incompleto",
    patron: /^hay (\d+) conceptos aplicados sin resolver/,
    mensaje: (g) => `Hay ${g[1] ?? "?"} cargos o descuentos aplicados a los que no se les calculó el importe.`,
    sugerencia: "Volvé a generar el borrador: el importe de un cargo lo calcula la base al generarlo.",
  },
  {
    codigo: "neto_negativo",
    patron: /^hay unidades cuyo neto del período quedaría negativo/,
    mensaje: () => "Hay unidades cuya boleta quedaría en negativo.",
    sugerencia:
      "Una boleta negativa no es un descuento: es una nota de crédito, que es otro documento. " +
      "Revisá los descuentos aplicados a esas unidades.",
  },

  // ── Cargos y descuentos ─────────────────────────────────────────────────────────────────────
  {
    codigo: "concepto_no_encontrado",
    patron: /^el concepto de boleta no existe/,
    mensaje: () => "Ese concepto no existe o no es de este barrio.",
    sugerencia: "Recargá la lista de conceptos y elegí uno de nuevo.",
  },
  {
    codigo: "concepto_sin_valor_vigente",
    // El nombre del concepto se muestra: es del catálogo del barrio sobre el que la persona está
    // trabajando y que acaba de elegir de una lista que ya leyó bajo RLS. La fecha también es suya.
    patron: /^el concepto "(.+)" no tiene valor vigente al (\d{4}-\d{2}-\d{2})/,
    mensaje: (g) => `El concepto “${g[1] ?? ""}” no tiene un valor cargado al ${g[2] ?? ""}.`,
    sugerencia:
      "Cargá el valor vigente del concepto para esa fecha antes de aplicarlo. El importe sale del " +
      "catálogo, no de esta pantalla.",
    datos: (g) => ({ concepto: g[1] ?? "", fecha: g[2] ?? "" }),
  },
  {
    codigo: "concepto_requiere_admin",
    patron: /^el concepto "(.+)" solo lo puede aplicar un administrador del barrio/,
    mensaje: (g) => `El concepto “${g[1] ?? ""}” solo lo puede aplicar un administrador del barrio.`,
    sugerencia: "Pedile a quien administra el barrio que lo aplique.",
    datos: (g) => ({ concepto: g[1] ?? "" }),
  },
  {
    codigo: "sin_limite_de_aplicacion",
    patron: /^el barrio no tiene límite de aplicación vigente/,
    mensaje: () => "El barrio no tiene definido hasta qué monto puede aplicar descuentos un operador.",
    sugerencia:
      "Hasta que quien administra el barrio cargue ese límite, los descuentos los tiene que aplicar " +
      "un administrador. Es a propósito: sin techo definido, no hay techo.",
  },
  {
    codigo: "tope_operador",
    // Los dos montos se muestran: el del descuento lo acaba de elegir la persona y el tope es una
    // política del barrio en el que trabaja. Sin los números el mensaje no dice qué pedir.
    patron: /^el descuento puede llegar a (.+) y el tope del operador es ([\d.]+)/,
    mensaje: (g) => `Ese descuento puede llegar a $ ${g[1] ?? "?"} y tu tope es $ ${g[2] ?? "?"}.`,
    sugerencia: "Lo tiene que aplicar un administrador del barrio.",
    datos: (g) => ({ maximo: g[1] ?? "", tope: g[2] ?? "" }),
  },
  {
    codigo: "tope_operador",
    // Anclada como todas las demás. Sin el `^` era la única regla que podía matchear en el medio de
    // un mensaje escrito para otra cosa — no filtraba (no usa grupos), pero sí podía robarle el
    // match a una regla posterior más específica.
    patron: /^el porcentaje .* supera el máximo del operador/,
    mensaje: () => "El porcentaje de ese descuento supera el máximo que podés aplicar.",
    sugerencia: "Lo tiene que aplicar un administrador del barrio.",
  },
  {
    codigo: "tope_operador",
    patron: /^los descuentos de esta unidad en el período ya suman hasta ([\d.]+) y el tope del operador es ([\d.]+)/,
    mensaje: (g) =>
      `Los descuentos de esa unidad en el período ya suman hasta $ ${g[1] ?? "?"} y tu tope es $ ${g[2] ?? "?"}.`,
    sugerencia:
      "El tope es por unidad y por período, no por descuento: partirlo en varios conceptos chicos no " +
      "lo evade. Lo tiene que aplicar un administrador del barrio.",
    datos: (g) => ({ acumulado: g[1] ?? "", tope: g[2] ?? "" }),
  },
  // ── Cargos: tope del operador y confirmación por monto inusual (migración 0025) ─────────────
  //
  // Los dos primeros son AUTORIZACIÓN (`tope_operador` / `sin_limite_de_aplicacion`): no hay nada que
  // reintentar, lo tiene que aplicar un administrador. Los tres siguientes son otra cosa y por eso
  // tienen código propio (`cargo_requiere_confirmacion`): el cargo es válido y quien lo aplica puede
  // seguir, pero tiene que decir que sí a un importe que el sistema encontró raro.
  {
    codigo: "sin_limite_de_aplicacion",
    patron: /^el barrio no tiene tope de cargos vigente/,
    mensaje: () => "El barrio no tiene definido hasta qué monto puede aplicar cargos un operador.",
    sugerencia:
      "Hasta que quien administra el barrio cargue ese tope, los cargos los tiene que aplicar un " +
      "administrador. Es a propósito: sin techo definido, no hay techo.",
  },
  {
    codigo: "tope_operador",
    // Las dos cifras se muestran: el importe sale del precio del catálogo que la persona acaba de
    // elegir (por la cantidad que tipeó) y el tope es una política del barrio en el que trabaja.
    patron: /^el cargo de ([\d.]+) supera el tope de cargos del operador \(([\d.]+)\)/,
    mensaje: (g) => `Ese cargo es de $ ${g[1] ?? "?"} y tu tope por cargo es $ ${g[2] ?? "?"}.`,
    sugerencia: "Lo tiene que aplicar un administrador del barrio.",
    datos: (g) => ({ importe: g[1] ?? "", tope: g[2] ?? "" }),
  },
  {
    codigo: "tope_operador",
    patron: /^los cargos de esta unidad en el período ya suman ([\d.]+) y el tope de cargos del operador es ([\d.]+)/,
    mensaje: (g) =>
      `Los cargos de esa unidad en el período sumarían $ ${g[1] ?? "?"} y tu tope es $ ${g[2] ?? "?"}.`,
    sugerencia:
      "El tope es por unidad y por período, no por cargo: partirlo en varios chicos no lo evade. " +
      "Lo tiene que aplicar un administrador del barrio.",
    datos: (g) => ({ acumulado: g[1] ?? "", tope: g[2] ?? "" }),
  },
  {
    // El caso que el usuario pidió que se viera con la cifra concreta: "este cargo es 31 veces la
    // expensa de esta unidad". El múltiplo, el importe y la expensa se muestran los tres — sin ellos
    // el mensaje sería "confirmá", que es exactamente el cartel que no se quería. Los tres son datos
    // que quien aplica ya puede leer: el importe lo acaba de armar, y la expensa de esa unidad está
    // en su propia boleta, que un rol de gestión del barrio ve bajo RLS.
    codigo: "cargo_requiere_confirmacion",
    patron: /^este cargo es ([\d.]+) veces la expensa de esta unidad \(([\d.]+) contra ([\d.]+)\)/,
    mensaje: (g) =>
      `Ese cargo es ${g[1] ?? "?"} veces la expensa de esa unidad: $ ${g[2] ?? "?"} contra $ ${g[3] ?? "?"}.`,
    sugerencia:
      "Si el importe es el correcto, confirmalo y se aplica. Si no, revisá la cantidad y el precio " +
      "del concepto: un cero de más es el error más común de esta pantalla.",
    datos: (g) => ({ multiplo: g[1] ?? "", importe: g[2] ?? "", expensa: g[3] ?? "" }),
  },
  {
    codigo: "cargo_requiere_confirmacion",
    patron: /^los cargos de esta unidad en el período suman ([\d.]+) veces su expensa \(([\d.]+) contra ([\d.]+)\)/,
    mensaje: (g) =>
      `Con este, los cargos de esa unidad en el período suman ${g[1] ?? "?"} veces su expensa: ` +
      `$ ${g[2] ?? "?"} contra $ ${g[3] ?? "?"}.`,
    sugerencia:
      "Mirá la lista de cargos de esa unidad antes de confirmar: puede haber uno cargado dos veces. " +
      "Si está todo bien, confirmalo y se aplica.",
    datos: (g) => ({ multiplo: g[1] ?? "", acumulado: g[2] ?? "", expensa: g[3] ?? "" }),
  },
  {
    // La unidad todavía no tiene ninguna boleta contra la cual comparar. **No se falla abierto**: se
    // pide confirmación igual, contra la única referencia que el barrio declaró (su tope de cargos) o
    // contra ninguna, que es el caso del barrio recién dado de alta.
    codigo: "cargo_requiere_confirmacion",
    patron:
      /^esta unidad todavía no tiene ninguna boleta contra la cual comparar y los cargos del período suman ([\d.]+) \(referencia del barrio: ([\d.]+|ninguna)\)/,
    mensaje: (g) =>
      g[2] === "ninguna"
        ? `Esa unidad todavía no tiene ninguna boleta y el barrio no tiene tope de cargos cargado: ` +
          `no hay con qué comparar estos $ ${g[1] ?? "?"}.`
        : `Esa unidad todavía no tiene ninguna boleta para comparar, y los cargos del período suman ` +
          `$ ${g[1] ?? "?"} (el barrio considera de rutina hasta $ ${g[2] ?? "?"}).`,
    sugerencia:
      "Es el primer período de esa unidad: el sistema no tiene una expensa anterior contra la cual " +
      "medir. Revisá el importe y confirmalo para aplicarlo.",
    datos: (g) => ({ acumulado: g[1] ?? "", referencia: g[2] ?? "" }),
  },
  {
    codigo: "dato_invalido",
    // Inalcanzable hoy (`cbu_parametro_chk` garantiza el parámetro de cada método). Tiene mensaje
    // propio para el día que se agregue un método nuevo: el modo de falla es "no se aplica", y quien
    // lo vea tiene que entender por qué en vez de recibir un código de soporte.
    patron: /^no se puede determinar el importe de este cargo/,
    mensaje: () => "No se pudo determinar cuánto cuesta ese cargo, así que no se aplicó.",
    sugerencia: "Revisá el valor cargado en el concepto. Si está bien, avisá con el código de referencia.",
  },
  {
    codigo: "descuento_duplicado",
    constraint: "uq_cbu_descuento_unico",
    mensaje: () => "Esa unidad ya tiene ese descuento aplicado en este período.",
    sugerencia: "Si querés cambiarlo, anulá el que está y aplicá uno nuevo. Un descuento no se edita.",
  },
  {
    codigo: "aplicacion_no_se_edita",
    patron: /^una aplicación no se edita/,
    mensaje: () => "Un cargo o descuento aplicado no se edita.",
    sugerencia: "Anulalo con un motivo y volvé a cargarlo. Editarlo borraría la evidencia de qué se aprobó.",
  },
  {
    codigo: "aplicacion_ya_anulada",
    patron: /^una anulación no se revierte/,
    mensaje: () => "Ese cargo ya está anulado, y una anulación no se revierte.",
    sugerencia: "Si hay que volver a cobrarlo, aplicá el concepto de nuevo.",
  },
  {
    // Migración 0021, AGUJERO 1. El candado vive en la base justamente porque un script o un job no
    // pasan por el `where anulado_at is null` del servicio: para ellos, este es el único mensaje.
    codigo: "aplicacion_ya_anulada",
    patron: /^el motivo de una anulación no se reescribe/,
    mensaje: () => "El motivo de una anulación no se puede cambiar.",
    sugerencia:
      "Quedó registrado cuando se anuló y es la única explicación de por qué ese importe no se cobró. " +
      "Si hay que aclarar algo, va como nota del período.",
  },
  {
    codigo: "registro_inmutable",
    patron: /^el registro de eventos es append-only/,
    mensaje: () => "El registro de auditoría no se modifica ni se borra.",
    sugerencia: "Es a propósito: es lo que permite reconstruir quién aplicó y quién anuló cada cargo.",
  },
  {
    codigo: "aplicacion_huerfana",
    // La etiqueta de la unidad (manzana-lote) y el nombre del concepto son del barrio en el que la
    // persona trabaja: los ve en el padrón y en el catálogo. Sin ellos hay que buscar a mano entre
    // cientos de aplicaciones cuál es la que rompe.
    patron: /^la unidad (.+) tiene aplicado "(.+)" pero no se le liquidó nada/,
    mensaje: (g) =>
      `La unidad ${g[1] ?? ""} tiene aplicado “${g[2] ?? ""}” pero no se le generó boleta ` +
      `(probablemente esté dada de baja).`,
    sugerencia: "Anulá esa aplicación, o revisá el padrón si la unidad tendría que estar activa.",
    datos: (g) => ({ unidad: g[1] ?? "", concepto: g[2] ?? "" }),
  },
  {
    codigo: "concepto_duplicado",
    constraint: "uq_concepto_boleta_barrio_nombre",
    mensaje: () => "Ya existe un concepto con ese nombre en el barrio.",
    sugerencia: "Usá el que ya existe, o elegí otro nombre.",
  },
  {
    codigo: "concepto_duplicado",
    constraint: "uq_concepto_barrio_nombre",
    mensaje: () => "Ya existe un concepto de gasto con ese nombre en el barrio.",
    sugerencia: "Usá el que ya existe, o elegí otro nombre.",
  },
  {
    codigo: "dato_invalido",
    patron: /^el tope es el techo de un descuento/,
    mensaje: () => "El tope es el techo de un descuento: en un cargo recortaría lo que hay que cobrar.",
    sugerencia: "Sacá el tope, o cambiá el concepto a descuento.",
  },
  {
    codigo: "dato_invalido",
    constraint: "cbv_tope_obligatorio_chk",
    mensaje: () => "Un descuento por porcentaje necesita un tope.",
    sugerencia:
      "Sin techo, el descuento crece con la expensa: el 5 % de hoy es otro número el mes que hay una obra.",
  },
  {
    codigo: "dato_invalido",
    constraint: "concepto_boleta_valor_parametro_chk",
    mensaje: () => "El valor cargado no corresponde al método del concepto.",
    sugerencia: "Un monto fijo lleva monto, un porcentaje lleva porcentaje, y precio × cantidad lleva precio.",
  },

  // ── Coherencia de tenant y referencias ──────────────────────────────────────────────────────
  //
  // Las FKs compuestas `(id, barrio_id)` de 0005 y 0016 son las que hacen **estructuralmente
  // imposible** que un gasto, un cargo o una línea de boleta cruce de barrio. El precio de que el
  // candado sea declarativo es que el mensaje del motor es ilegible; eso se arregla acá.
  // Migración 0023 §2. Estos cuatro los levanta `app.cbu_antes()` **antes** que las FK compuestas y
  // antes que `app.periodo_editable()`, que era por donde se filtraba el estado de un período ajeno.
  //
  // Los dos primeros son el mensaje UNIFORME: se emiten cuando el usuario no tiene acceso al barrio
  // de la referencia, y por eso "no existe" y "es de otro barrio" tienen que verse igual. Comparten
  // `codigo` con los dos siguientes **a propósito**: si tuvieran uno propio, el `codigo` sería el
  // oráculo que el mensaje dejó de ser.
  {
    codigo: "referencia_de_otro_barrio",
    patron: /^el período no existe o no es de este barrio/,
    mensaje: () => "Ese período no existe o no es de este barrio.",
    sugerencia: "Volvé a la pantalla del período y elegí un concepto del catálogo de ese barrio.",
  },
  {
    codigo: "referencia_de_otro_barrio",
    patron: /^la unidad no existe o no es de este barrio/,
    mensaje: () => "Esa unidad no existe o no es de este barrio.",
    sugerencia: "Elegí una unidad del padrón de este barrio.",
  },
  {
    codigo: "referencia_de_otro_barrio",
    patron: /^el período no es del mismo barrio que el concepto elegido/,
    mensaje: () => "Ese período no es del mismo barrio que el concepto elegido.",
    sugerencia: "Volvé a la pantalla del período y elegí un concepto del catálogo de ese barrio.",
  },
  {
    codigo: "referencia_de_otro_barrio",
    patron: /^la unidad no es del mismo barrio que el concepto elegido/,
    mensaje: () => "Esa unidad no es del mismo barrio que el concepto elegido.",
    sugerencia: "Elegí una unidad del padrón del barrio al que pertenece el concepto.",
  },
  {
    codigo: "referencia_de_otro_barrio",
    constraint: "fk_cbu_periodo_barrio",
    mensaje: () => "Ese período no es del mismo barrio que el concepto elegido.",
    sugerencia: "Volvé a la pantalla del período y elegí un concepto del catálogo de ese barrio.",
  },
  {
    codigo: "referencia_de_otro_barrio",
    constraint: "fk_cbu_uf_barrio",
    mensaje: () => "Esa unidad no es del mismo barrio que el concepto elegido.",
    sugerencia: "Elegí una unidad del padrón de este barrio.",
  },
  {
    codigo: "referencia_de_otro_barrio",
    constraint: "fk_gasto_concepto_barrio",
    mensaje: () => "Ese concepto de gasto no es de este barrio.",
    sugerencia: "Elegí un concepto del catálogo del barrio del período.",
  },
  {
    codigo: "referencia_de_otro_barrio",
    constraint: "fk_gasto_acta_barrio",
    mensaje: () => "Esa acta no es de este barrio.",
    sugerencia: "Elegí un documento del barrio del período.",
  },
  {
    codigo: "referencia_de_otro_barrio",
    constraint: "fk_gasto_periodo_barrio",
    mensaje: () => "El gasto no corresponde al barrio del período.",
    sugerencia: "Recargá la pantalla y volvé a intentar.",
  },
  {
    // Migración 0020 §1. El `%` interpola el TIPO del nodo (un enum de tres valores: administrador,
    // barrio, subsector), no un dato de nadie — pero igual no se muestra: no significa nada para
    // quien está cargando un mandato.
    codigo: "dato_invalido",
    patron: /^el mandato tiene que apuntar a un nodo de tipo administrador/,
    mensaje: () => "El administrador del mandato tiene que ser un estudio, no un barrio ni un sector.",
    sugerencia: "Elegí el estudio que administra el barrio.",
  },
  {
    codigo: "dato_invalido",
    patron: /^el administrador del mandato tiene que ser un ancestro del barrio/,
    mensaje: () => "Ese estudio no administra este barrio.",
    sugerencia:
      "Que un estudio administre un barrio de otro árbol es una excepción de aislamiento y va por " +
      "otro camino, que registra quién la otorgó y por qué.",
  },
  {
    codigo: "dato_invalido",
    patron: /^no se pudo resolver el nodo del mandato/,
    mensaje: () => "No se pudo verificar el estudio del mandato, así que no se guardó.",
    sugerencia: "Recargá la pantalla y volvé a intentar.",
  },
  {
    codigo: "referencia_inexistente",
    sqlstate: "23503",
    mensaje: () => "Uno de los datos elegidos ya no existe.",
    sugerencia: "Recargá la pantalla: puede haberse borrado desde otra sesión.",
  },

  // ── Permisos ────────────────────────────────────────────────────────────────────────────────
  {
    codigo: "sin_permiso",
    patron: /^no tenés permiso para liquidar este período/,
    mensaje: () => "No tenés permiso para liquidar este período.",
    sugerencia: "Liquidar y emitir es de un administrador del barrio o de un operador.",
  },
  {
    codigo: "sin_permiso",
    patron: /^no hay usuario en la sesión/,
    // Es un bug nuestro si aparece: significa que se escribió sin pasar por `conUsuario()`. Igual se
    // traduce, porque el modo de falla visible tiene que ser útil y no un volcado.
    mensaje: () => "La sesión no está activa.",
    sugerencia: "Volvé a entrar y repetí la operación.",
  },
  {
    codigo: "sin_permiso",
    // 42501 = insufficient_privilege. Cubre dos cosas que para quien mira son la misma: la policy de
    // RLS rechazó la fila, o el rol no tiene el grant sobre esa columna (el caso del importe de un
    // cargo, que `app_request` perdió a propósito en 0017 §7).
    sqlstate: "42501",
    mensaje: () => "No tenés permiso para hacer esto en este barrio.",
    sugerencia:
      "Si creés que deberías tenerlo, pedile a quien administra el barrio que revise tu rol. " +
      "Puede ser también que estés mirando un barrio al que ya no tenés acceso.",
  },

  // ── Emisión de documentos (ADR-0002 §6) ─────────────────────────────────────────────────────
  {
    // `uq_trabajo_pendiente`: un solo trabajo encolado o corriendo por (período, tipo). Esto NO es
    // un error de quien apretó el botón: es la idempotencia haciendo su trabajo, y el mensaje tiene
    // que decir eso — "ya existe y no se puede repetir" mandaría a alguien a buscar qué hizo mal.
    codigo: "trabajo_ya_encolado",
    constraint: "uq_trabajo_pendiente",
    mensaje: () => "Los documentos de este período ya se están generando.",
    sugerencia: "Esperá a que termine: la pantalla se actualiza sola cuando está listo.",
  },
  {
    // Falla cerrado de `app.trabajo_antes_insert()`. **Un solo mensaje para "no existe" y para "no
    // es tuyo"**: distinguirlos convertiría el encolado en un oráculo que dice si un período de otro
    // barrio existe. El trigger corre bajo la RLS del solicitante justamente para que los dos casos
    // sean el mismo caso, y el mensaje no puede deshacer eso.
    codigo: "periodo_no_encontrado",
    patron: /^no se pudo derivar el barrio de la referencia: se rechaza por seguridad/,
    mensaje: () => "El período no existe o no tenés acceso.",
    sugerencia: "Volvé al listado de períodos del barrio y entrá de nuevo.",
  },
  {
    // El mismo control que ya hace el servicio, pero desde la base: acá el mensaje puede ser preciso
    // porque el trigger solo llega a esta línea si el período **existe y es accesible**.
    codigo: "transicion_invalida",
    patron: /^el período no está emitido: los documentos salen de lo que quedó emitido/,
    mensaje: () => "Todavía no se pueden generar los documentos: el período no está emitido.",
    sugerencia:
      "Terminá de revisar el borrador y emití el período. Los documentos salen de lo que quedó emitido.",
  },
  {
    codigo: "documento_no_encontrado",
    patron: /^no se pudo derivar el barrio del documento: se rechaza por seguridad/,
    mensaje: () => "El documento no existe o no tenés acceso.",
    sugerencia: "Volvé a la lista de documentos del período y probá de nuevo.",
  },
  {
    codigo: "sin_permiso",
    patron: /^el alcance y la identidad de un trabajo no se modifican después de encolarlo/,
    mensaje: () => "No se puede cambiar un trabajo de emisión que ya fue encolado.",
    sugerencia: "Si hace falta emitir de nuevo, encolá un trabajo nuevo.",
  },

  // ── Genéricos del motor, al final ───────────────────────────────────────────────────────────
  {
    codigo: "dato_invalido",
    sqlstate: "23514",
    // NUNCA se muestra el nombre del constraint ni el `detail`: el detail de un check trae la fila
    // entera (`Failing row contains (…)`), con los importes y los textos de una fila que quien
    // escribe puede no tener derecho a leer.
    mensaje: () => "Alguno de los datos no cumple una regla del sistema y no se guardó.",
    sugerencia: "Revisá los importes y las fechas. Si todo parece correcto, avisá con el código de referencia.",
  },
  {
    // Un valor con `vigente_desde` ANTERIOR al abierto choca contra el índice parcial de "un solo
    // valor abierto por concepto". El mensaje genérico de 23505 —"ese dato ya existe"— decía lo
    // contrario de lo que pasó: la persona no repitió nada, quiso cargar un precio retroactivo.
    codigo: "dato_invalido",
    constraint: "uq_concepto_boleta_valor_abierta",
    mensaje: () => "No se puede cargar un valor con fecha anterior al que ya está vigente.",
    sugerencia:
      "El catálogo se versiona hacia adelante: cargá el valor nuevo con una fecha posterior a la del " +
      "valor vigente. Corregir el pasado cambiaría lo que ya se cobró.",
  },
  {
    // Dos personas generando el borrador del mismo período a la vez. "Ese dato ya existe" manda a
    // recargar una pantalla; lo que hay que decir es que hay otra generación en curso.
    codigo: "periodo_no_editable",
    constraint: "uq_liquidacion_periodo_uf",
    mensaje: () => "Otra persona está generando el borrador de este período en este momento.",
    sugerencia: "Esperá unos segundos y recargá para ver el resultado.",
  },
  {
    codigo: "dato_invalido",
    sqlstate: "23505",
    mensaje: () => "Ese dato ya existe y no se puede repetir.",
    sugerencia: "Recargá la pantalla para ver el que ya está cargado.",
  },
  {
    // `numeric_value_out_of_range`. Un cero de más en un importe daba un código de soporte, que es
    // el peor mensaje posible para el error de tipeo más común de una pantalla de carga.
    codigo: "dato_invalido",
    sqlstate: "22003",
    mensaje: () => "Ese número es demasiado grande para el campo.",
    sugerencia: "Revisá que no haya un cero de más ni un punto donde iba una coma.",
  },
  {
    codigo: "dato_invalido",
    sqlstate: "22P02", // invalid_text_representation: un uuid o un numeric mal formado.
    mensaje: () => "Alguno de los datos tiene un formato que el sistema no entiende.",
    sugerencia: "Recargá la pantalla y volvé a cargar el formulario.",
  },
];

/** Prueba una regla contra un error ya identificado como de Postgres. */
function coincide(regla: Regla, e: ErrorPostgres): readonly string[] | null {
  if (regla.constraint) return e.constraint === regla.constraint ? [] : null;
  if (regla.patron) {
    const m = regla.patron.exec(e.message ?? "");
    return m ? (m as unknown as readonly string[]) : null;
  }
  if (regla.sqlstate) return e.code === regla.sqlstate ? [] : null;
  return null;
}

/**
 * Deja el error original en el log del servidor, indexado por el mismo identificador que ve la
 * persona en pantalla.
 *
 * Es la contraparte de no mostrar nada: si el detalle no se registra acá, no existe en ningún lado y
 * la traducción pasa de "no filtra" a "esconde". Se escribe con `console.error` a propósito —es lo
 * que el runtime de Next y el worker recogen sin configuración— y **nunca** en una tabla que después
 * lea una pantalla (misma trampa que la columna `error` de `trabajo`, ADR-0002 §4.2).
 */
function registrarParaElLog(correlacion: string, e: unknown, pg: ErrorPostgres | null): void {
  console.error(
    JSON.stringify({
      evento: "error_de_escritura",
      correlacion,
      sqlstate: pg?.code ?? null,
      constraint: pg?.constraint ?? null,
      tabla: pg?.table ?? null,
      mensaje: pg?.message ?? (e instanceof Error ? e.message : String(e)),
      detalle: pg?.detail ?? null,
    }),
  );
}

/**
 * Traduce cualquier fallo a un `ErrorDeNegocio`.
 *
 * Los `ErrorDeNegocio` pasan de largo (ya están traducidos: los lanzan los propios servicios cuando
 * la regla la conocen ellos, como "el período no existe o no es accesible").
 */
export function traducirError(e: unknown): ErrorDeNegocio {
  if (e instanceof ErrorDeNegocio) return e;

  const correlacion = randomUUID();
  const pg = errorDePostgres(e);
  registrarParaElLog(correlacion, e, pg);

  if (pg) {
    for (const regla of REGLAS) {
      const grupos = coincide(regla, pg);
      if (grupos) {
        return new ErrorDeNegocio({
          codigo: regla.codigo,
          mensaje: regla.mensaje(grupos),
          sugerencia: regla.sugerencia,
          correlacion,
          datos: regla.datos?.(grupos) ?? {},
          causa: e,
        });
      }
    }
  }

  return new ErrorDeNegocio({
    codigo: "desconocido",
    mensaje: "No se pudo completar la operación.",
    sugerencia: `Volvé a intentar. Si sigue pasando, pasale este código a quien te da soporte: ${correlacion}`,
    correlacion,
    causa: e,
  });
}

/**
 * Envuelve una escritura para que **nunca** salga de acá un error de la BASE sin traducir.
 *
 * Los `ZodError` quedan afuera a propósito: no son fallos, son la respuesta a un formulario mal
 * completado, y sus `issues` por campo son lo que la pantalla necesita. Por eso el `.parse()` de cada
 * servicio va antes de esta llamada y no adentro.
 *
 * Se usa en el cuerpo de cada servicio de escritura y no en el llamador: la traducción es parte del
 * contrato del servicio, no una cortesía que la pantalla tiene que acordarse de pedir.
 */
export async function enBase<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw traducirError(e);
  }
}

/**
 * Atajo para los rechazos que decide el propio servicio (no la base).
 *
 * Su caso más importante es el que ninguna policy señala: bajo RLS, un `update … where id = $1`
 * sobre una fila que el usuario no puede ver **actualiza cero filas y no lanza nada**. Sin esta
 * función, el servicio devolvería éxito y la pantalla diría "listo" sin que hubiera pasado nada.
 */
export function rechazar(
  codigo: CodigoError,
  mensaje: string,
  sugerencia: string,
  datos?: Record<string, string>,
  causa?: unknown,
): never {
  const correlacion = randomUUID();

  // Un `desconocido` que sale de acá es, por definición, un camino que **no debería haber pasado**
  // (un `insert` que no insertó y no rebotó, un throw inesperado del motor puro). `traducirError()`
  // no lo va a loguear después, porque corta apenas ve un `ErrorDeNegocio` ya armado. Si no se
  // registra acá no se registra en ningún lado, y la traducción dejaría de "no filtrar" para pasar a
  // **esconder** — que es la trampa que este archivo documenta, vista desde adentro.
  if (codigo === "desconocido" || causa !== undefined) {
    registrarParaElLog(correlacion, causa ?? new Error(mensaje), errorDePostgres(causa));
  }

  throw new ErrorDeNegocio({
    codigo,
    mensaje,
    sugerencia,
    correlacion,
    ...(datos ? { datos } : {}),
    ...(causa !== undefined ? { causa } : {}),
  });
}

/**
 * El rechazo de "el período no existe o no tenés acceso", que aparece **idéntico en tres servicios**
 * (cargar un gasto, generar el borrador y emitir).
 *
 * Se extrae solo este: los demás "cero filas → rechazar" comparten la forma pero no el contenido —el
 * código y la sugerencia son distintos en cada uno, y esa diferencia es justamente el valor—. Este,
 * en cambio, es la misma frase tres veces, y que puedan divergir es el único riesgo real.
 *
 * "No existe" y "no tenés acceso" viajan juntos **a propósito**: si el servicio los distinguiera, el
 * uuid de un período ajeno sería un oráculo de existencia.
 */
export function rechazarPeriodoInaccesible(): never {
  rechazar(
    "periodo_no_encontrado",
    "El período no existe o no tenés acceso.",
    "Volvé al listado de períodos del barrio y entrá de nuevo.",
  );
}
