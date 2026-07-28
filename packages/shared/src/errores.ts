/**
 * El error que una persona puede leer — y el que nunca sale del servidor.
 *
 * **El problema concreto que resuelve.** Todo el módulo de expensas hace cumplir sus reglas con
 * `raise exception` y con `check`/`unique`/FK de Postgres. Esos mensajes **interpolan valores de
 * filas** (`'el concepto "%" no tiene valor vigente al %'`, `'el descuento puede llegar a % y el tope
 * del operador es %'`, `'el período % no existe'`), y un `unique_violation` trae el valor en conflicto
 * en su `detail`. Ese valor puede pertenecer a una fila que quien disparó el error **no puede leer
 * bajo RLS**: la RLS filtra el `select`, no filtra el mensaje de error. Un canal que deja pasar
 * `e.message` es un `select` que no pasó por la RLS (ADR-0002 §4.2).
 *
 * **La forma de la solución, en una línea:** el error crudo **nunca** cruza el límite; cruza un
 * `ErrorDeNegocio` con un `codigo` de un conjunto **cerrado**, un `mensaje` que escribimos nosotros,
 * una `sugerencia` de qué hacer, y un `correlacion` para cruzarlo con el log del servidor — donde sí
 * queda el error original, entero, en `cause`.
 *
 * **Por qué vive en `shared` y no en `apps/web`.** Lo cruzan dos lados: `packages/data` lo produce y
 * `apps/web` lo consume (y mañana la mobile). Un catálogo por lado es un contrato que se
 * desincroniza — el mismo motivo por el que `consultas.ts` vive acá. Lo que **no** hay acá es nada
 * de Postgres: la traducción desde el driver vive en `packages/data/src/errores.ts`, que es la única
 * capa que tiene derecho a saber qué es un SQLSTATE.
 */

/**
 * Los motivos por los que una escritura puede fallar, enumerados.
 *
 * **Es una lista cerrada a propósito.** Un `codigo` nuevo obliga a pasar por acá, o sea a decidir
 * explícitamente qué se le muestra a una persona. Sin esta lista, el camino de menor resistencia es
 * mostrar el `e.message` — que es exactamente lo que no se puede hacer.
 *
 * `"desconocido"` es el default y **no es un agujero**: su mensaje es genérico y el detalle real solo
 * existe en el log, indexado por `correlacion`.
 */
export const CODIGOS_ERROR = [
  // Período
  "periodo_ya_existe",
  "periodo_no_encontrado",
  "periodo_no_editable",
  "periodo_no_cuadra",
  "periodo_incompleto",
  "transicion_invalida",
  "coeficientes_sin_cerrar",
  /** El **período** no tiene versión de coeficientes asignada: falta generar el borrador. */
  "sin_coeficientes",
  /**
   * El **barrio** no tiene ninguna versión cerrada y vigente. Es otra situación y tiene otra salida
   * —hay que cargar y cerrar la versión, que es trabajo de padrón, no de liquidación—, así que no
   * comparte código con la de arriba: el `codigo` es lo que la pantalla usa para decidir a dónde
   * mandar a la persona.
   */
  "barrio_sin_coeficientes",
  "neto_negativo",
  // Gasto
  "gasto_no_encontrado",
  // Catálogo y aplicaciones de boleta
  "concepto_no_encontrado",
  "concepto_duplicado",
  "concepto_sin_valor_vigente",
  "concepto_requiere_admin",
  "descuento_duplicado",
  "sin_limite_de_aplicacion",
  "tope_operador",
  "aplicacion_no_encontrada",
  "aplicacion_ya_anulada",
  "aplicacion_no_se_edita",
  "aplicacion_huerfana",
  "registro_inmutable",
  // Transversales
  "sin_permiso",
  "referencia_de_otro_barrio",
  "referencia_inexistente",
  "dato_invalido",
  "desconocido",
] as const;

export type CodigoError = (typeof CODIGOS_ERROR)[number];

/**
 * Un fallo que **le sirve a quien está mirando la pantalla**.
 *
 * Tres campos y ninguno decorativo:
 *
 * - `message` — qué pasó, en castellano, escrito por nosotros. Nunca es el texto del driver.
 * - `sugerencia` — qué hacer. Un error de dinero sin salida es un callejón: el administrador ya sabe
 *   que algo falló, lo que no sabe es si tiene que corregir un importe, pedirle a otra persona que lo
 *   haga, o avisar que hay un problema.
 * - `correlacion` — el identificador que aparece en el log del servidor con el error original. Es lo
 *   que permite que soporte encuentre la causa sin que la causa se haya impreso en la pantalla.
 *
 * `cause` lleva el error original (ES2022). **Se registra, no se muestra**: `ErrorDeNegocio` es lo
 * único que un adaptador de transporte tiene permitido serializar hacia afuera, y solo por sus
 * campos —nunca la instancia entera, que arrastraría `cause`.
 */
export class ErrorDeNegocio extends Error {
  override readonly name = "ErrorDeNegocio";
  readonly codigo: CodigoError;
  readonly sugerencia: string;
  readonly correlacion: string;
  /**
   * Valores que **decidimos, uno por uno**, que son seguros de mostrar: salen de datos que quien
   * disparó el error ya podía leer, o de lo que acaba de escribir en el formulario. No es un volcado
   * del error; es una lista blanca por regla (ver el catálogo en `packages/data/src/errores.ts`).
   */
  readonly datos: Readonly<Record<string, string>>;

  constructor(entrada: {
    codigo: CodigoError;
    mensaje: string;
    sugerencia: string;
    correlacion: string;
    datos?: Readonly<Record<string, string>>;
    causa?: unknown;
  }) {
    super(entrada.mensaje, entrada.causa === undefined ? undefined : { cause: entrada.causa });
    this.codigo = entrada.codigo;
    this.sugerencia = entrada.sugerencia;
    this.correlacion = entrada.correlacion;
    this.datos = entrada.datos ?? {};
  }
}

export function esErrorDeNegocio(e: unknown): e is ErrorDeNegocio {
  return e instanceof ErrorDeNegocio;
}

/**
 * Lo que se le muestra a una persona, y lo único que puede cruzar hacia el cliente.
 *
 * Es un objeto plano **serializable**: una Server Action devuelve esto, no la instancia. Si
 * devolviera la instancia, `cause` —el error crudo de Postgres, con los valores de filas que la RLS
 * no dejaba ver— viajaría al navegador dentro del payload de React.
 */
export type ErrorParaMostrar = {
  readonly ok: false;
  readonly codigo: CodigoError;
  readonly mensaje: string;
  readonly sugerencia: string;
  readonly correlacion: string;
  readonly datos: Readonly<Record<string, string>>;
};

/**
 * Convierte cualquier fallo en algo mostrable, **sin decidir nada**.
 *
 * Un error que no es `ErrorDeNegocio` no se intenta interpretar acá: se degrada a `desconocido` con
 * un texto genérico. Que la degradación sea posible es lo que hace que la lista de arriba pueda ser
 * cerrada sin que un caso no previsto rompa una pantalla.
 *
 * ⚠ **No captura los errores de control de flujo de Next** (`redirect()`/`notFound()` funcionan
 * lanzando): eso es responsabilidad del llamador, que tiene que re-lanzarlos **antes** de llamar acá
 * (ADR-0002 §3.1). Acá no se puede hacer, porque `shared` no depende de `next/navigation`.
 */
export function paraMostrar(e: unknown, correlacionSiFalta: string): ErrorParaMostrar {
  if (esErrorDeNegocio(e)) {
    return {
      ok: false,
      codigo: e.codigo,
      mensaje: e.message,
      sugerencia: e.sugerencia,
      correlacion: e.correlacion,
      datos: e.datos,
    };
  }
  return {
    ok: false,
    codigo: "desconocido",
    mensaje: "No se pudo completar la operación.",
    sugerencia:
      `Volvé a intentar. Si sigue pasando, pasale este código a quien te da soporte: ${correlacionSiFalta}`,
    correlacion: correlacionSiFalta,
    datos: {},
  };
}
