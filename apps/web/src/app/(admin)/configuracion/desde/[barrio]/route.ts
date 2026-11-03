/**
 * `GET /configuracion/desde/[barrio]` — entrar a la configuración general **desde un barrio**.
 *
 * Recuerda ese barrio en una cookie `httpOnly` (`COOKIE_ULTIMO_BARRIO`) y redirige a `/configuracion`.
 * Para qué sirve el recuerdo (encargo 8, T1 §4):
 *
 * - **Elegir la administración** cuando quien mira ve más de una: la de ese barrio.
 * - **Salir de la configuración general al barrio de donde se vino**: la barra lateral de
 *   `/configuracion` lleva las secciones de ese barrio.
 *
 * **Es un route handler y no un componente de servidor** porque un componente de servidor no puede
 * escribir cookies; tampoco hace falta una Server Action: es un enlace común (cero JavaScript), y
 * escribir una preferencia de navegación en un `GET` no cambia ningún dato del dominio.
 *
 * **La cookie no autoriza nada.** Solo se valida que el id tenga forma de id (`esIdValido`); si ese
 * barrio es visible lo decide la RLS cada vez que la página lo lee, y uno ajeno o borrado se ignora.
 */

import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_ULTIMO_BARRIO, esIdValido, RUTA_CONFIGURACION_GENERAL } from "../../../../../rutas.ts";

export const dynamic = "force-dynamic";

/** Noventa días: una preferencia de navegación, no una sesión. */
const NOVENTA_DIAS_EN_SEGUNDOS = 60 * 60 * 24 * 90;

export async function GET(
  pedido: NextRequest,
  { params }: { params: Promise<{ barrio: string }> },
): Promise<NextResponse> {
  const { barrio } = await params;
  const respuesta = NextResponse.redirect(new URL(RUTA_CONFIGURACION_GENERAL, pedido.url), 303);
  if (esIdValido(barrio)) {
    respuesta.cookies.set(COOKIE_ULTIMO_BARRIO, barrio, {
      httpOnly: true,
      sameSite: "lax",
      secure: pedido.nextUrl.protocol === "https:",
      path: "/",
      maxAge: NOVENTA_DIAS_EN_SEGUNDOS,
    });
  }
  return respuesta;
}
