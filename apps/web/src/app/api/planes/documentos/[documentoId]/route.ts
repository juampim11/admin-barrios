/**
 * `GET /api/planes/documentos/[documentoId]` — descarga de un documento de un plan de pagos (encargo
 * P2a-3): el PDF que armó el sistema, el acuerdo firmado o el documento del estudio.
 *
 * Calco de `api/gestiones/[gestionId]/adjunto/route.ts`, con `prepararDescargaDeDocumentoDelPlan`. La
 * clave sale de la fila leída bajo RLS —nunca de un parámetro—: es lo único que separa este documento
 * de cualquier otro objeto del bucket (ver la cabecera de `servidor/almacenamiento.ts`).
 *
 * `referencia_inexistente` (no existe o no es tuyo) es un 404: no se distingue un caso del otro.
 *
 * **Antes de firmar la URL se comprueba el código de control** (revisión de seguridad, A2): la URL de
 * subida sigue sirviendo unos minutos después de agregar el documento, y quien lo subió podría volver a
 * subir otro archivo a la misma clave. Se lee el objeto y se compara su SHA-256 con el que quedó en el
 * plan: si no coincide, no se entrega (409) y el caso queda a la vista, en vez de servir un archivo
 * distinto del registrado. Son documentos de pocos MB y se bajan de a uno.
 */

import { NextResponse } from "next/server";
import { TTL_DESCARGA_SEGUNDOS } from "@admin-barrios/almacenamiento";
import { prepararDescargaDeDocumentoDelPlan } from "@admin-barrios/data/servicios/planes-documentos";
import { sha256DeAdjunto } from "@admin-barrios/data/servicios/gestiones";
import { conSesionHttp } from "../../../../../servidor/db.ts";
import { almacenamiento } from "../../../../../servidor/almacenamiento.ts";
import { traducirFallo } from "../../../../../acciones/resultado.ts";

export const dynamic = "force-dynamic";

export async function GET(
  _pedido: Request,
  { params }: { params: Promise<{ documentoId: string }> },
): Promise<NextResponse> {
  const { documentoId } = await params;

  try {
    const resultado = await conSesionHttp((tx) => prepararDescargaDeDocumentoDelPlan(tx, { documentoId }));
    if (!resultado.ok) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

    const contenido = await almacenamiento().get(resultado.valor.storageKey);
    if (sha256DeAdjunto(contenido) !== resultado.valor.sha256) {
      return NextResponse.json(
        {
          error:
            "El archivo guardado no coincide con su código de control: se modificó después de agregarlo. No se entrega; avisá a soporte.",
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
