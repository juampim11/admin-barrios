"use server";

/**
 * Las dos únicas acciones de esta tanda, y ninguna escribe una fila del dominio: entrar eligiendo del
 * elenco de la demo, y salir.
 *
 * **Por qué el provider no se toca desde acá.** `servidor/db.ts` expone `iniciarSesionDeDemo()` y
 * `cerrarSesionActual()`, que devuelven una **instrucción de cookie**; el `AuthProvider` no conoce el
 * almacén de cookies de Next y esta acción no conoce el adapter. Esa costura existe para que la app
 * no pueda armar la `EntradaHttp` —o sea, no pueda escribir `headers: new Map([["host",
 * "localhost"]])` y desactivar desde adentro la vuelta 2 del candado del ADR-0002 §2.4—.
 *
 * **Los `redirect()` van afuera de todo `try`.** Funcionan lanzando: un `catch` ancho se los tragaría
 * y la navegación se vería como un error de formulario (ADR-0002 §3.1). Acá no hay ningún `try`, que
 * es la forma más simple de cumplirlo.
 *
 * **El error vuelve por la URL y no por estado de React.** Sin `useActionState` no hace falta un
 * componente de cliente, y la pantalla de entrada sigue costando cero JavaScript. El motivo exacto
 * —que lo escribe el adapter— se registra en el log del servidor y al navegador va un mensaje
 * genérico: es la misma regla del `mensajeDeError` del ADR-0002 §4.2, aplicada al único canal de
 * error que tiene esta tanda.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { cerrarSesionActual, iniciarSesionDeDemo } from "../servidor/db.ts";

/**
 * La forma de la cookie, sacada de la propia firma de la puerta.
 *
 * Se deriva con `Awaited<ReturnType<…>>` y no se importa de `@admin-barrios/auth` porque un archivo
 * `"use server"` solo puede importar de la lista blanca del ADR-0002 §5.2 (regla 9), y `auth` no está
 * en ella — con razón: la app no tiene por qué hablar con el proveedor de identidad, solo con la
 * puerta.
 */
type InstruccionCookie = Awaited<ReturnType<typeof cerrarSesionActual>>;

/** El uuid llega de un `<form>`, o sea del cliente: se valida antes de que toque nada. */
const entradaSchema = z.object({ usuarioId: z.string().uuid() });

/** Traduce la instrucción neutral del provider al almacén de cookies de Next. */
async function aplicar(cookie: InstruccionCookie): Promise<void> {
  const almacen = await cookies();
  almacen.set(cookie.nombre, cookie.valor, {
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    maxAge: cookie.maxEdad,
  });
}

/** Entra suplantando a alguien del elenco. No retorna: los dos caminos terminan en `redirect()`. */
export async function entrarComoUsuarioDemo(form: FormData): Promise<void> {
  const entrada = entradaSchema.safeParse({ usuarioId: form.get("usuarioId") });
  if (!entrada.success) redirect("/entrar?error=1");

  const resultado = await iniciarSesionDeDemo(entrada.data.usuarioId);
  if (!resultado.ok) {
    console.warn("[entrar] no se pudo suplantar:", resultado.motivo);
    redirect("/entrar?error=1");
  }

  await aplicar(resultado.cookie);
  redirect("/");
}

/** Sale. Vacía la cookie y vuelve a la pantalla de entrada. */
export async function salir(): Promise<void> {
  await aplicar(await cerrarSesionActual());
  redirect("/entrar");
}
