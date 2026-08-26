/**
 * `GET /api/ordenes-pago/[ordenId]/comprobante` — descarga del comprobante de pago de una orden.
 *
 * Calco de `api/comprobantes/[pagoId]/route.ts`, con `prepararDescargaDeComprobanteDeOP` y el
 * parámetro de ruta `ordenId`. Mismos dos códigos de rechazo que no son "500 del sistema", los dos
 * traducidos a 404 —
 *
 * · `desconocido`: la orden no existe o no es tuya bajo RLS (no se distingue un caso del otro, para
 *   no convertir esto en un oráculo);
 * · `comprobante_no_adjunto`: la orden existe y es accesible, pero todavía no tiene comprobante de
 *   pago cargado. No es un error del sistema: es que no hay nada que descargar todavía.
 */

import { NextResponse } from "next/server";
import { TTL_DESCARGA_SEGUNDOS } from "@admin-barrios/almacenamiento";
import { prepararDescargaDeComprobanteDeOP } from "@admin-barrios/data/servicios/ordenes-pago";
import { conSesionHttp } from "../../../../../servidor/db.ts";
import { almacenamiento } from "../../../../../servidor/almacenamiento.ts";
import { traducirFallo } from "../../../../../acciones/resultado.ts";

export const dynamic = "force-dynamic";

export async function GET(
  _pedido: Request,
  { params }: { params: Promise<{ ordenId: string }> },
): Promise<NextResponse> {
  const { ordenId } = await params;

  try {
    const resultado = await conSesionHttp((tx) =>
      prepararDescargaDeComprobanteDeOP(tx, { ordenPagoId: ordenId, ttlSegundos: TTL_DESCARGA_SEGUNDOS }),
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
    const estado = fallo.codigo === "desconocido" || fallo.codigo === "comprobante_no_adjunto" ? 404 : 500;
    return NextResponse.json(
      { error: fallo.mensaje, correlacion: fallo.correlacion },
      { status: estado, headers: { "Cache-Control": "no-store" } },
    );
  }
}
