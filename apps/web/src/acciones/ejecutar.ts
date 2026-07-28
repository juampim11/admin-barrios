import "server-only";

/**
 * El paso 2 y 3 de toda Server Action de escritura: **abrir la sesión y llamar a un servicio**.
 *
 * La regla del ADR-0002 §4.2 dice que una acción tiene cuatro pasos y ninguno más: `parse` con Zod,
 * `conSesion`, **una** llamada a un servicio, y `revalidatePath` + resultado serializable. Este
 * archivo es los pasos 2 y 3, escritos una sola vez, para que las siete acciones del recorrido no
 * puedan escribirlos distinto — que es como se cuelan las diferencias que después nadie encuentra.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LAS DOS COSAS QUE ESTE ARCHIVO HACE BIEN Y QUE ES FÁCIL HACER MAL
 *
 * **1. El `try` envuelve la llamada al SERVICIO, nunca a `conSesion`.** `conSesion` puede hacer
 * `redirect("/entrar")` cuando la sesión no está, y en Next `redirect()` funciona **lanzando**: un
 * `catch` un renglón más afuera se lo tragaría y la sesión vencida se vería como un error de
 * formulario, con la persona reintentando contra un formulario muerto (ADR-0002 §3.1). Por eso el
 * `try` está adentro del callback y no alrededor de él.
 *
 * **2. Un rechazo que pide confirmación no sale como fallo.** El `codigo` del error se busca en la
 * tabla explícita de `confirmacion.ts`; si está, el resultado es `confirmar` y no `falla`. La
 * pantalla no interpreta el texto del error para adivinarlo, y esta función tampoco: consulta una
 * tabla que alguien escribió a mano.
 *
 * **No hace el `parse` ni el `revalidatePath`.** Los dos dependen de la acción concreta —cuál es el
 * esquema, cuáles son las rutas que quedaron viejas— y esconderlos acá los volvería invisibles justo
 * donde hay que poder leerlos de un vistazo.
 */

import { conSesion } from "../servidor/db.ts";
import { confirmacionDe } from "./confirmacion.ts";
import { traducirFallo, type ResultadoDeAccion, type ValoresDeFormulario } from "./resultado.ts";

/**
 * La transacción con la identidad puesta, **derivada de la firma de la puerta** y no importada de
 * `@admin-barrios/data/client`.
 *
 * No es una elegancia: la regla 2b del test de arquitectura falla si cualquier archivo que no sea
 * `servidor/db.ts` importa `/client`, y con razón —ahí viven las fábricas que abren la conexión sin
 * RLS—. Sacar el tipo de `typeof conSesion` da exactamente el mismo tipo sin nombrar el módulo.
 */
export type Transaccion = Parameters<Parameters<typeof conSesion>[0]>[0];

/**
 * Corre `llamarAlServicio` con la sesión puesta y devuelve un resultado que un formulario entiende.
 *
 * `valores` son los del formulario, y viajan de vuelta en los dos caminos que no son éxito: React
 * resetea los campos no controlados cuando la acción termina, así que sin ellos un rechazo del
 * servidor vacía el formulario entero.
 */
export async function ejecutar<T>(
  valores: ValoresDeFormulario,
  llamarAlServicio: (tx: Transaccion) => Promise<T>,
): Promise<ResultadoDeAccion<T>> {
  const resultado = await conSesion(async (tx) => {
    try {
      return { ok: true as const, valor: await llamarAlServicio(tx) };
    } catch (e) {
      // Traduce y registra. No decide nada: el catálogo cerrado de `shared/errores.ts` ya decidió
      // qué se puede mostrar de cada rechazo, y el error crudo se queda en el log del servidor.
      return { ok: false as const, error: traducirFallo(e) };
    }
  });

  if (resultado.ok) return { estado: "ok", valor: resultado.valor };

  return {
    estado: confirmacionDe(resultado.error.codigo) ? "confirmar" : "falla",
    error: resultado.error,
    valores,
  };
}
