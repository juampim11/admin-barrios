/**
 * `GET /api/recibos/[reciboId]` — descarga de un recibo emitido.
 *
 * Calco exacto de `api/documentos/[documentoId]/route.ts` — leer ese comentario para el porqué
 * completo de cada decisión (el `documentoId`-nunca-una-clave, el registro antes de firmar, el `302`
 * en vez de proxear el objeto, el TTL de 90 segundos). Acá solo lo que cambia: el servicio es
 * `prepararDescargaDeRecibo` y el parámetro de ruta es `reciboId`.
 */

import { NextResponse } from "next/server";
import { TTL_DESCARGA_SEGUNDOS } from "@admin-barrios/almacenamiento";
import { prepararDescargaDeRecibo } from "@admin-barrios/data/servicios/documentos";
import { conSesionHttp } from "../../../../servidor/db.ts";
import { almacenamiento } from "../../../../servidor/almacenamiento.ts";
import { traducirFallo } from "../../../../acciones/resultado.ts";

export const dynamic = "force-dynamic";

export async function GET(
  _pedido: Request,
  { params }: { params: Promise<{ reciboId: string }> },
): Promise<NextResponse> {
  const { reciboId } = await params;

  try {
    const resultado = await conSesionHttp((tx) =>
      prepararDescargaDeRecibo(tx, { reciboId, ttlSegundos: TTL_DESCARGA_SEGUNDOS }),
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
    // "No existe" y "no es tuyo" salen iguales: distinguirlos convertiría esta ruta en un oráculo.
    const estado = fallo.codigo === "recibo_no_encontrado" ? 404 : 500;
    return NextResponse.json(
      { error: fallo.mensaje, correlacion: fallo.correlacion },
      { status: estado, headers: { "Cache-Control": "no-store" } },
    );
  }
}
