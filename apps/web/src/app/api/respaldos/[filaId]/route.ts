/**
 * `GET /api/respaldos/[filaId]` — descarga del adjunto que respalda un valor de parámetro de mora (el
 * reglamento o el acta de donde sale una tasa, ADR-0006).
 *
 * Calco de `api/comprobantes/[pagoId]/route.ts`. La clave **no viaja por parámetro**: sale de la fila
 * leída bajo RLS por `leerAdjuntoDeRespaldo()` — la credencial de la web alcanza al bucket entero, y
 * lo único que separa "este respaldo" de "cualquier objeto" es que la clave venga de una fila que la
 * persona puede leer (ver la cabecera de `servidor/almacenamiento.ts`).
 *
 * `null` —fila inexistente, ajena bajo RLS, o sin adjunto— es un 404, sin distinguir entre los tres:
 * no es un oráculo de qué filas existen.
 */

import { NextResponse } from "next/server";
import { TTL_DESCARGA_SEGUNDOS } from "@admin-barrios/almacenamiento";
import { leerAdjuntoDeRespaldo } from "@admin-barrios/data/servicios/parametros";
import { conSesionHttp } from "../../../../servidor/db.ts";
import { almacenamiento } from "../../../../servidor/almacenamiento.ts";
import { traducirFallo } from "../../../../acciones/resultado.ts";

export const dynamic = "force-dynamic";

const SIN_CACHE = { "Cache-Control": "no-store" };

export async function GET(
  _pedido: Request,
  { params }: { params: Promise<{ filaId: string }> },
): Promise<NextResponse> {
  const { filaId } = await params;

  try {
    const resultado = await conSesionHttp((tx) => leerAdjuntoDeRespaldo(tx, { filaId }));
    if (!resultado.ok) return NextResponse.json({ error: "sin sesión" }, { status: 401, headers: SIN_CACHE });
    if (!resultado.valor) {
      return NextResponse.json({ error: "No hay un adjunto para descargar." }, { status: 404, headers: SIN_CACHE });
    }

    const clave = resultado.valor.storageKey;
    const extension = clave.split(".").pop() ?? "pdf";
    const url = await almacenamiento().urlFirmada(clave, {
      expiraEnSegundos: TTL_DESCARGA_SEGUNDOS,
      descargarComo: `respaldo.${extension}`,
    });

    return NextResponse.redirect(url, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        Vary: "Cookie",
      },
    });
  } catch (e) {
    const fallo = traducirFallo(e);
    return NextResponse.json(
      { error: fallo.mensaje, correlacion: fallo.correlacion },
      { status: 500, headers: SIN_CACHE },
    );
  }
}
