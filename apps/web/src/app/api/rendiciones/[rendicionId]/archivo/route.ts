/**
 * `GET /api/rendiciones/[rendicionId]/archivo[?ingreso=id]` — descarga del PDF firmado de una rendición
 * del estudio, o del comprobante de uno de sus ingresos (encargo P2b).
 *
 * Calco de `api/planes/documentos/[documentoId]/route.ts`: la clave sale de la fila leída bajo RLS
 * —nunca de un parámetro—, `referencia_inexistente` es un 404, y **antes de firmar la URL se compara el
 * SHA-256 del objeto con el guardado** (409 si no coincide: la URL de subida sigue viva unos minutos).
 */

import { NextResponse } from "next/server";
import { TTL_DESCARGA_SEGUNDOS } from "@admin-barrios/almacenamiento";
import { prepararDescargaDeArchivoDeRendicion } from "@admin-barrios/data/servicios/planes-rendicion";
import { sha256DeAdjunto } from "@admin-barrios/data/servicios/gestiones";
import { conSesionHttp } from "../../../../../servidor/db.ts";
import { almacenamiento } from "../../../../../servidor/almacenamiento.ts";
import { traducirFallo } from "../../../../../acciones/resultado.ts";

export const dynamic = "force-dynamic";

export async function GET(
  pedido: Request,
  { params }: { params: Promise<{ rendicionId: string }> },
): Promise<NextResponse> {
  const { rendicionId } = await params;
  const ingresoId = new URL(pedido.url).searchParams.get("ingreso");

  try {
    const resultado = await conSesionHttp((tx) => prepararDescargaDeArchivoDeRendicion(tx, { rendicionId, ingresoId }));
    if (!resultado.ok) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

    const contenido = await almacenamiento().get(resultado.valor.storageKey);
    if (sha256DeAdjunto(contenido) !== resultado.valor.sha256) {
      return NextResponse.json(
        {
          error:
            "El archivo guardado no coincide con su código de control: se modificó después de cargarlo. No se entrega; avisá a soporte.",
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

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
    const estado = fallo.codigo === "referencia_inexistente" ? 404 : 500;
    return NextResponse.json(
      { error: fallo.mensaje, correlacion: fallo.correlacion },
      { status: estado, headers: { "Cache-Control": "no-store" } },
    );
  }
}
