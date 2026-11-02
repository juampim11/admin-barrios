/**
 * `GET /api/ordenes-pago/[ordenId]/factura` — descarga de la factura del proveedor de una orden.
 *
 * Mismo contrato que `api/ordenes-pago/[ordenId]/comprobante/route.ts`, con
 * `prepararDescargaDeFacturaDeOP` en vez de `prepararDescargaDeComprobanteDeOP`. El único código de
 * rechazo propio es `factura_no_adjunta`: la orden existe y es accesible, pero no tiene factura
 * adjunta — ni cargada, ni declarada "no disponible". No es un error del sistema: es que no hay nada
 * que descargar.
 */

import { NextResponse } from "next/server";
import { TTL_DESCARGA_SEGUNDOS } from "@admin-barrios/almacenamiento";
import { prepararDescargaDeFacturaDeOP } from "@admin-barrios/data/servicios/ordenes-pago";
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
      prepararDescargaDeFacturaDeOP(tx, { ordenPagoId: ordenId, ttlSegundos: TTL_DESCARGA_SEGUNDOS }),
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
    const estado = fallo.codigo === "desconocido" || fallo.codigo === "factura_no_adjunta" ? 404 : 500;
    return NextResponse.json(
      { error: fallo.mensaje, correlacion: fallo.correlacion },
      { status: estado, headers: { "Cache-Control": "no-store" } },
    );
  }
}
