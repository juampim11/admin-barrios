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
 * LAS TRES COSAS QUE ESTE ARCHIVO HACE BIEN Y QUE ES FÁCIL HACER MAL
 *
 * **1. El `catch` está AFUERA de la transacción.** Parece un detalle de estilo y es una escritura
 * perdida. `conUsuario()` corre sobre `db.transaction(...)`: si el callback **retorna normalmente**,
 * drizzle manda `COMMIT`. Con el `try/catch` adentro —que fue la primera versión de este archivo—
 * un error lanzado desde TypeScript **después** de haber escrito (un `rechazar()` de dominio tras un
 * `insert`, un `TypeError` sobre un `rows[0]` que no existe) se convertía en un retorno normal, la
 * transacción no estaba abortada, y la escritura parcial quedaba **confirmada** mientras la pantalla
 * decía "no se pudo completar la operación". Con el error propagándose, drizzle hace `ROLLBACK` y
 * recién ahí se traduce.
 *
 * El motivo por el que ese `try` había quedado adentro —que un `catch` de más afuera se traga el
 * `redirect("/entrar")` de `conSesion`, que en Next funciona **lanzando** (ADR-0002 §3.1)— sigue
 * cubierto, pero por donde corresponde: `traducirFallo` arranca con `unstable_rethrow`, así que los
 * errores de control de flujo de Next salen de acá intactos.
 *
 * **2. Un rechazo que pide confirmación no sale como fallo, y se resuelve UNA sola vez.** El `codigo`
 * se busca en la tabla explícita de `confirmacion.ts` **acá**, del lado que decide, y la
 * `Confirmacion` viaja adentro del resultado. Si la pantalla la volviera a buscar, servidor y
 * cliente estarían consultando dos copias de la misma tabla y un despliegue con pestañas viejas
 * abiertas dejaría un rechazo sin ningún cartel en pantalla.
 *
 * **3. Los `valores` que vuelven son los CRUDOS del formulario.** Nunca los mergeados con la
 * confirmación: esos van al `parse` y a ningún otro lado. Ver la nota de `ejecutar`.
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
 * ⚠ **`valores` tienen que ser los CRUDOS del formulario, sin la confirmación mergeada.**
 *
 * Vuelven al navegador para repoblar el formulario —React resetea los campos no controlados cuando la
 * acción termina— y `PedidoDeConfirmacion` los reemite como campos ocultos. Si acá entrara el objeto
 * ya mergeado, `confirmarMontoInusual` quedaría **pegado** en el formulario: desde el segundo pedido
 * de confirmación el campo viajaría solo, la casilla pasaría a ser decorativa, y la base guardaría
 * "alguien revisó y confirmó" sobre un envío en el que nadie marcó nada. El candado se convierte en
 * un cartel justo en el registro que después contesta un reclamo.
 *
 * El merge alimenta **solo** al `safeParse`; lo parseado va al servicio y lo crudo vuelve a pantalla.
 */
export async function ejecutar<T>(
  valores: ValoresDeFormulario,
  llamarAlServicio: (tx: Transaccion) => Promise<T>,
): Promise<ResultadoDeAccion<T>> {
  try {
    // Sin `try` adentro del callback: un retorno normal desde ahí es un `COMMIT`, y un error de
    // dominio lanzado después de escribir dejaría la escritura parcial confirmada. Ver la cabecera.
    return { estado: "ok", valor: await conSesion((tx) => llamarAlServicio(tx)) };
  } catch (e) {
    // Traduce y registra. No decide nada: el catálogo cerrado de `shared/errores.ts` ya decidió qué se
    // puede mostrar de cada rechazo, y el error crudo se queda en el log del servidor. La primera
    // línea de `traducirFallo` re-lanza los errores de control de flujo de Next.
    const error = traducirFallo(e);
    const confirmacion = confirmacionDe(error.codigo);
    return confirmacion
      ? { estado: "confirmar", error, confirmacion, valores }
      : { estado: "falla", error, valores };
  }
}
