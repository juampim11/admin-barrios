/**
 * `GET /[barrio]/configuracion/general` — **la ruta vieja de la configuración general**.
 *
 * La configuración general es de la administración y ahora vive en `/configuracion` (encargo 8, T1
 * §4). Esta ruta queda para que no se rompa ningún enlace guardado: redirige a la entrada desde un
 * barrio, que recuerda este barrio como el último visitado y sigue a `/configuracion`. Con un id que
 * ni siquiera tiene forma de id, directo a `/configuracion`.
 *
 * Es un route handler y no una página para no pasar por el layout del barrio: no hay nada que leer
 * antes de redirigir.
 */

import { NextResponse, type NextRequest } from "next/server";
import { esIdValido, RUTA_CONFIGURACION_GENERAL, rutaDeConfiguracionGeneralDesde } from "../../../../../rutas.ts";

export const dynamic = "force-dynamic";

export async function GET(
  pedido: NextRequest,
  { params }: { params: Promise<{ barrio: string }> },
): Promise<NextResponse> {
  const { barrio } = await params;
  const destino = esIdValido(barrio) ? rutaDeConfiguracionGeneralDesde(barrio) : RUTA_CONFIGURACION_GENERAL;
  return NextResponse.redirect(new URL(destino, pedido.url), 307);
}
