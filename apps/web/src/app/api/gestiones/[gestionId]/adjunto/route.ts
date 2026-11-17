/**
 * `GET /api/gestiones/[gestionId]/adjunto` — descarga del adjunto de una gestión de cobranza (la carta
 * documento, la nota firmada; encargo E-a2).
 *
 * Calco de `api/comprobantes/[pagoId]/route.ts`, con `prepararDescargaDeAdjuntoDeGestion`. La clave
 * sale de la fila de la gestión leída bajo RLS —nunca de un parámetro—: es lo único que separa este
 * adjunto de cualquier otro objeto del bucket (ver la cabecera de `servidor/almacenamiento.ts`).
 *
 * `referencia_inexistente` (la gestión no existe, no es tuya o no tiene adjunto) es un 404: no se
 * distingue un caso del otro, para no convertir esto en un oráculo.
 */

import { NextResponse } from "next/server";
import { TTL_DESCARGA_SEGUNDOS } from "@admin-barrios/almacenamiento";
import { prepararDescargaDeAdjuntoDeGestion } from "@admin-barrios/data/servicios/gestiones";
import { conSesionHttp } from "../../../../../servidor/db.ts";
import { almacenamiento } from "../../../../../servidor/almacenamiento.ts";
import { traducirFallo } from "../../../../../acciones/resultado.ts";

export const dynamic = "force-dynamic";

export async function GET(
  _pedido: Request,
  { params }: { params: Promise<{ gestionId: string }> },
): Promise<NextResponse> {
  const { gestionId } = await params;

  try {
    const resultado = await conSesionHttp((tx) => prepararDescargaDeAdjuntoDeGestion(tx, { gestionId }));
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
    const estado = fallo.codigo === "referencia_inexistente" ? 404 : 500;
    return NextResponse.json(
      { error: fallo.mensaje, correlacion: fallo.correlacion },
      { status: estado, headers: { "Cache-Control": "no-store" } },
    );
  }
}
