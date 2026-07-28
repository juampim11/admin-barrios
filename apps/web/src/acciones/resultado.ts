/**
 * Lo que una Server Action le devuelve a un formulario, y **es lo único que cruza al navegador**.
 *
 * No lleva la instancia de `ErrorDeNegocio` sino su forma plana (`ErrorParaMostrar`, el contrato de
 * `@admin-barrios/shared/errores`): la instancia arrastra `cause` —el error crudo de Postgres, con
 * los valores de filas que la RLS no dejaba ver— y React lo serializaría entero dentro del payload.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LOS CINCO ESTADOS, Y POR QUÉ NO SON TRES
 *
 * `inicial` · `ok` · `campos` · `falla` · `confirmar`.
 *
 * Las dos separaciones que importan:
 *
 * **`campos` no es `falla`.** Un error de validación llega **sin traducir y con detalle por campo**,
 * y su lugar es el campo, no un cartel arriba. Meterlos en la misma variante obligaría a cada
 * formulario a preguntar si el error tiene `fieldErrors`, y el camino de menor resistencia sería
 * mostrar todo junto en un cartel — que es exactamente lo que no queremos.
 *
 * **`confirmar` no es `falla`.** Hay rechazos del servicio que **no son un fallo**: son "esto
 * necesita que un administrador lo confirme". Tratarlos como error deja a la persona mirando un
 * callejón cuando en realidad tiene una salida; tratarlos como éxito sería que la pantalla decida
 * por su cuenta que algo es normal. Se distinguen por el `codigo`, contra la tabla **explícita** de
 * `confirmacion.ts`, y nunca por heurística sobre el texto. Ver ese archivo.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ VIAJAN LOS `valores`
 *
 * React **resetea los campos no controlados** de un `<form action={…}>` cuando la acción termina, con
 * éxito o sin él. Sin devolver lo tipeado, un rechazo del servidor vacía el formulario y la persona
 * vuelve a cargar ocho campos para corregir uno. Son los strings que esa misma persona acaba de
 * escribir: devolvérselos no expone nada que no tuviera.
 *
 * Este módulo **no** lleva `"use server"` a propósito: lo importan las acciones (servidor) y los
 * formularios (cliente). Es tipos y funciones puras, sin una sola línea que toque la base.
 */

import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";
import { paraMostrar, type ErrorParaMostrar } from "@admin-barrios/shared/errores";

/** Lo tipeado en el formulario. Siempre strings: `FormData` no produce números ni booleanos. */
export type ValoresDeFormulario = Readonly<Record<string, string>>;

/** Los mensajes de validación, por nombre de campo. Vienen de Zod, sin traducir. */
export type ErroresPorCampo = Readonly<Record<string, readonly string[] | undefined>>;

export type ResultadoDeAccion<T> =
  /** Todavía no se envió nada. Es el valor con el que arranca `useActionState`. */
  | { readonly estado: "inicial" }
  /** Se escribió. `valor` es lo que devolvió el servicio, ya serializable. */
  | { readonly estado: "ok"; readonly valor: T }
  /** No pasó el `parse`. Cada mensaje va **en su campo**. */
  | {
      readonly estado: "campos";
      readonly campos: ErroresPorCampo;
      readonly valores: ValoresDeFormulario;
    }
  /** El servicio rechazó. `error` se muestra tal cual: `mensaje` y `sugerencia` los escribimos nosotros. */
  | { readonly estado: "falla"; readonly error: ErrorParaMostrar; readonly valores: ValoresDeFormulario }
  /**
   * El servicio rechazó **pidiendo una confirmación explícita**, no fallando. La pantalla vuelve a
   * ofrecer lo mismo con un acto deliberado de por medio; los valores son los del intento anterior,
   * intactos, para que lo que se confirme sea exactamente lo que se había pedido.
   */
  | {
      readonly estado: "confirmar";
      readonly error: ErrorParaMostrar;
      readonly valores: ValoresDeFormulario;
    };

/** El estado con el que arranca todo formulario. */
export const INICIAL = { estado: "inicial" } as const;

/**
 * Los campos del formulario como strings.
 *
 * Descarta los `File` (no hay subida de archivos en este incremento) y las claves internas que Next
 * agrega al `FormData` de una Server Action, que empiezan con `$`. Sin ese filtro, `$ACTION_ID_…`
 * terminaría de vuelta en el navegador como `defaultValue` de un campo inexistente.
 */
export function valoresDe(form: FormData): ValoresDeFormulario {
  const valores: Record<string, string> = {};
  for (const [clave, valor] of form.entries()) {
    if (clave.startsWith("$")) continue;
    if (typeof valor !== "string") continue;
    valores[clave] = valor;
  }
  return valores;
}

/**
 * El resultado de un `safeParse` que falló, con los mensajes puestos en sus campos.
 *
 * `flatten()` reparte por `path[0]`. Lo que no cae en ningún campo —los `superRefine` sin `path`—
 * entra en `formErrors`, y se guarda bajo la clave `""`: los formularios la muestran arriba, que es
 * donde corresponde cuando el problema es la combinación y no un campo.
 */
export function camposInvalidos<T>(
  error: z.ZodError,
  valores: ValoresDeFormulario,
): ResultadoDeAccion<T> {
  const { fieldErrors, formErrors } = error.flatten();
  const campos: Record<string, readonly string[] | undefined> = { ...fieldErrors };
  if (formErrors.length > 0) campos[""] = formErrors;
  return { estado: "campos", campos, valores };
}

/**
 * Traduce un fallo del servicio a algo mostrable **y lo registra entero en el log del servidor**.
 *
 * Las dos mitades son igual de importantes: lo que sale a pantalla es el catálogo cerrado de
 * `shared/errores.ts` —nunca un `e.message`, que en este esquema interpola valores de filas que
 * quien disparó el error puede no tener derecho a leer (ADR-0002 §4.2)—, y lo que queda en el log
 * es el error original, indexado por el **mismo** identificador de correlación que la persona ve en
 * la pantalla y que va a leer por teléfono. Sin la segunda mitad, ese identificador no apunta a
 * nada.
 *
 * ⚠ **No captura los errores de control de flujo de Next.** `redirect()` y `notFound()` funcionan
 * lanzando: `unstable_rethrow` los re-lanza **antes** de traducir nada. Sin esa línea, una sesión
 * vencida se vería como "No se pudo completar la operación" en un formulario muerto (ADR-0002 §3.1).
 *
 * `crypto.randomUUID()` es el global de la Web Crypto API, no un import de `node:crypto`: un archivo
 * `"use server"` solo puede importar de la lista blanca del ADR-0002 §5.2 (regla 9).
 */
export function traducirFallo(e: unknown): ErrorParaMostrar {
  unstable_rethrow(e);
  const mostrable = paraMostrar(e, `web-${crypto.randomUUID().slice(0, 8)}`);
  console.error(
    `[accion] rechazo ${mostrable.codigo} · correlacion=${mostrable.correlacion}`,
    e,
  );
  return mostrable;
}
