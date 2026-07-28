/**
 * Los rechazos que **no son un fallo**: son "esto necesita que un administrador lo confirme".
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL PROBLEMA, EN UNA LÍNEA
 *
 * Un servicio puede rechazar una escritura no porque esté mal, sino porque es **inusual** y hace
 * falta que una persona con autoridad diga "sí, ya sé, hacelo igual". El camino es: el servicio
 * rechaza → la pantalla explica **con las cifras que devolvió el servidor** → la persona confirma de
 * forma explícita → se reintenta con esa confirmación en los parámetros.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LAS TRES REGLAS QUE ESTE ARCHIVO HACE CUMPLIR
 *
 * **1. La pantalla no puede decidir por su cuenta que algo es normal.** Un código entra acá porque
 * alguien lo escribió acá, no porque el texto del error "suene a advertencia". Nada de heurísticas
 * sobre `mensaje`, nada de `codigo.includes("tope")`. La tabla es explícita y chica, y el tipo
 * `Partial<Record<CodigoError, …>>` hace que un código que deja de existir en el catálogo de
 * `@admin-barrios/shared/errores` **rompa el build** en vez de quedar como una entrada muerta que
 * nadie va a volver a mirar.
 *
 * **2. La confirmación es un acto, no un reintento.** No hay reintento automático, ni un `catch` que
 * agregue el campo y vuelva a llamar. La persona tiene que marcar una casilla y apretar un botón
 * distinto del original, con las cifras del servidor a la vista. Si eso no pasa, no se escribe nada.
 *
 * **3. Las cifras las pone el servidor.** El texto de la confirmación se arma con `error.mensaje`,
 * `error.sugerencia` y `error.datos` —la lista blanca de valores que el catálogo de errores decidió
 * que son seguros de mostrar—. Este archivo aporta el **encuadre** (qué se está confirmando y con
 * qué palabras), nunca un número.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ HAY REGISTRADO HOY, Y QUÉ NO
 *
 * **Registrado: `cargo_requiere_confirmacion`** (migración `0025`). El cargo supera el umbral de
 * monto inusual del barrio —un múltiplo de la expensa de esa unidad— y la base lo rechaza pidiendo
 * el consentimiento. Se reintenta con `confirmarMontoInusual`, que es un campo real de
 * `aplicarConceptoAUnidadSchema` y **el único opcional del esquema**: en el primer intento no existe,
 * porque todavía nadie preguntó nada.
 *
 * **NO registrados, y hay que decir por qué**, porque parecen candidatos y no lo son:
 *
 * | Código | Por qué no va acá |
 * |---|---|
 * | `tope_operador` | No es "confirmá": es "vos no podés". Quien lo ve **no tiene derecho** a levantar su propio tope, así que ofrecerle una casilla sería ofrecerle un botón que no le corresponde. La salida es otra persona. |
 * | `concepto_requiere_admin` | Ídem: el concepto es de un rol que no es el suyo. |
 * | `sin_limite_de_aplicacion` | El barrio no declaró su tope. La salida es cargarlo, no saltearlo — y "sin techo definido, no hay techo" es justamente la decisión del dominio. |
 *
 * El valor de `"1"` en el campo sale de la lista cerrada de `confirmacionExplicitaSchema`
 * (`true` / `"true"` / `"on"` / `"1"`); **cualquier otra cosa es "no confirmó"**, que es el modo de
 * falla correcto para un candado.
 */

import { CODIGOS_ERROR, type CodigoError } from "@admin-barrios/shared/errores";
import type { ValoresDeFormulario } from "./resultado.ts";

/** Cómo se le presenta a una persona el rechazo que en realidad es un pedido de confirmación. */
export type Confirmacion = {
  /** Encabezado del aviso. Es lo primero que se lee: tiene que decir que **no** falló nada. */
  readonly titulo: string;
  /** Qué está autorizando, en una frase. Va arriba de la casilla. */
  readonly queSeConfirma: string;
  readonly leyendaDeLaCasilla: string;
  readonly textoDelBoton: string;
  /**
   * Los campos que se agregan al reintento. Se mezclan con los valores del intento anterior, así que
   * lo que se confirma es exactamente lo que se había pedido y no una versión distinta.
   */
  readonly campos: Readonly<Record<string, string>>;
};

export type Confirmaciones = Partial<Record<CodigoError, Confirmacion>>;

/**
 * La tabla. Chica y explícita a propósito: cada entrada es una decisión de producto sobre qué se le
 * permite confirmar a la persona que está mirando la pantalla.
 */
export const CONFIRMACIONES: Confirmaciones = {
  cargo_requiere_confirmacion: {
    // "Necesita" y no "no se pudo": lo primero que se lee tiene que decir que **no falló nada**.
    titulo: "Esto necesita que lo confirmes.",
    /*
     * El "por qué" **no se escribe acá**: viene en `error.mensaje` y `error.sugerencia`, con la cifra
     * concreta que calculó la base, y se muestra tal cual.
     *
     * Y este renglón está redactado **sin sujeto**, a propósito. El umbral es **acumulado por unidad
     * y por período**, no por cargo: el tercer cargo chico del mes puede disparar la confirmación
     * aunque los dos anteriores hayan pasado. Un texto que dijera "este cargo es muy alto" mandaría a
     * revisar el importe que se acaba de tipear —que puede estar perfecto— en vez de la lista de
     * cargos de esa unidad, que es donde está el problema. Cuál de los dos casos es lo dice el
     * `mensaje` del servidor, que es el único que lo sabe.
     */
    queSeConfirma:
      "El sistema comparó contra lo que esa unidad paga por mes y le pareció mucho. Puede estar " +
      "perfecto —una obra, un consumo grande— o puede ser un cero de más o un cargo repetido.",
    leyendaDeLaCasilla: "Revisé los importes y confirmo que se cobre.",
    textoDelBoton: "Confirmar y aplicar el cargo",
    campos: { confirmarMontoInusual: "1" },
  },
};

/**
 * ¿Este rechazo es en realidad un pedido de confirmación?
 *
 * Recibe la tabla por parámetro —con la de producción por defecto— **para que el test pueda
 * ejercitar la rama sin registrar un código real**. Sin eso, la única forma de probar el camino
 * sería agregar una entrada de verdad, o sea decidir por el otro agente qué código es confirmable.
 */
export function confirmacionDe(
  codigo: CodigoError,
  tabla: Confirmaciones = CONFIRMACIONES,
): Confirmacion | null {
  return tabla[codigo] ?? null;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El reintento
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * La casilla que habilita el reintento, y el código que se está confirmando.
 *
 * Llevan `__` por delante para que se vea de un vistazo, en el HTML y en un log de request, que no
 * son campos del dominio: ninguno de los esquemas de `@admin-barrios/shared/escrituras` los tiene, y
 * por lo tanto el `parse` los descarta. Lo único que hacen es habilitar el merge de `campos`.
 */
export const CAMPO_CONFIRMO = "__confirmo";
export const CAMPO_CODIGO_CONFIRMADO = "__codigoConfirmado";
export const VALOR_CONFIRMO = "si";

/** Los códigos del catálogo, como conjunto: lo que llega del formulario es un string cualquiera. */
const CODIGOS = new Set<string>(CODIGOS_ERROR);

/**
 * Los valores del formulario **más** los campos de la confirmación, si y solo si la persona marcó la
 * casilla y el código que dice estar confirmando está registrado en la tabla de arriba.
 *
 * Tres condiciones y las tres tienen que darse. Si falta una, devuelve los valores tal cual: el
 * servicio va a volver a rechazar con el mismo código y la pantalla va a volver a pedir la
 * confirmación, que es el comportamiento correcto — nunca "pasó igual".
 *
 * ⚠ **Esto no es un control de seguridad y no se puede usar como tal.** Quien arme el POST a mano
 * puede mandar los campos de la confirmación sin pasar por acá; la autorización la hacen el esquema
 * Zod y la base, como siempre (ADR-0002 §4.2). Lo que esta función garantiza es lo otro, que es lo
 * que la pantalla sí controla: que **la UI no confirme sola**. El formulario normal ni siquiera
 * dibuja esos campos.
 */
export function conConfirmacion(
  valores: ValoresDeFormulario,
  tabla: Confirmaciones = CONFIRMACIONES,
): ValoresDeFormulario {
  if (valores[CAMPO_CONFIRMO] !== VALOR_CONFIRMO) return valores;

  const codigo = valores[CAMPO_CODIGO_CONFIRMADO] ?? "";
  if (!CODIGOS.has(codigo)) return valores;

  const confirmacion = confirmacionDe(codigo as CodigoError, tabla);
  if (!confirmacion) return valores;

  return { ...valores, ...confirmacion.campos };
}
