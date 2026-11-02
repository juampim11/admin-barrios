/**
 * `GET /api/comprobantes/[pagoId]` — descarga del comprobante adjunto a un pago manual.
 *
 * Calco de `api/documentos/[documentoId]/route.ts`, con `prepararDescargaDeComprobante` y el
 * parámetro de ruta `pagoId`. Una sola diferencia real con las otras dos rutas de descarga: acá hay
 * **dos** códigos de rechazo que no son "500 del sistema" y los dos se traducen a 404 —
 *
 * · `pago_no_encontrado`: el pago no existe o no es tuyo bajo RLS (mismo criterio que las otras dos
 *   rutas: no se distingue un caso del otro, para no convertir esto en un oráculo);
 * · `comprobante_no_adjunto`: el pago existe y es accesible, pero es de `origen = 'extracto'` y esos
 *   nunca llevan comprobante cargado a mano. No es un error del sistema ni un pago ajeno: es que no
 *   hay nada que descargar, y un 404 es lo que corresponde — mismo criterio que
 *   `documento_no_encontrado` en la ruta de documentos.
 */

import { NextResponse } from "next/server";
import { TTL_DESCARGA_SEGUNDOS } from "@admin-barrios/almacenamiento";
import { prepararDescargaDeComprobante } from "@admin-barrios/data/servicios/documentos";
import { conSesionHttp } from "../../../../servidor/db.ts";
import { almacenamiento } from "../../../../servidor/almacenamiento.ts";
import { traducirFallo } from "../../../../acciones/resultado.ts";

export const dynamic = "force-dynamic";

export async function GET(
  _pedido: Request,
  { params }: { params: Promise<{ pagoId: string }> },
): Promise<NextResponse> {
  const { pagoId } = await params;

  try {
    const resultado = await conSesionHttp((tx) =>
      prepararDescargaDeComprobante(tx, { pagoId, ttlSegundos: TTL_DESCARGA_SEGUNDOS }),
    );
    if (!resultado.ok) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

    const url = await almacenamiento().urlFirmada(resultado.valor.storageKey, {
      expiraEnSegundos: TTL_DESCARGA_SEGUNDOS,
      descargarComo: resultado.valor.nombreArchivo,
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
    const estado =
      fallo.codigo === "pago_no_encontrado" || fallo.codigo === "comprobante_no_adjunto" ? 404 : 500;
    return NextResponse.json(
      { error: fallo.mensaje, correlacion: fallo.correlacion },
      { status: estado, headers: { "Cache-Control": "no-store" } },
    );
  }
}
