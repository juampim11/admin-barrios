/**
 * `GET /api/trabajos/[trabajoId]` — el estado de una generación de documentos.
 *
 * **Es un Route Handler y no una Server Action** porque es polling: un `GET` barato y repetido desde
 * el navegador, y una Server Action es un `POST` que devuelve un valor serializado, no una respuesta
 * HTTP. Además es, textualmente, el primer endpoint que la aplicación del residente va a reusar sin
 * cambios (ADR-0002 §4.3).
 *
 * La autorización es la de siempre: `conSesionHttp` + la RLS sobre `trabajo`. Un trabajo de otro
 * barrio devuelve 404 y no 403 — distinguirlos diría si existe.
 */

import { NextResponse } from "next/server";
import { leerTrabajo } from "@admin-barrios/data/servicios/trabajos";
import { conSesionHttp } from "../../../../servidor/db.ts";
import { traducirFallo } from "../../../../acciones/resultado.ts";

export const dynamic = "force-dynamic";

export async function GET(
  _pedido: Request,
  { params }: { params: Promise<{ trabajoId: string }> },
): Promise<NextResponse> {
  const { trabajoId } = await params;

  try {
    const resultado = await conSesionHttp((tx) => leerTrabajo(tx, trabajoId));
    if (!resultado.ok) return NextResponse.json({ error: "sin sesión" }, { status: 401 });

    return NextResponse.json(resultado.valor, {
      // Es el estado de un proceso en curso, bajo sesión: no tiene por qué quedar en ningún caché.
      headers: { "Cache-Control": "no-store", Vary: "Cookie" },
    });
  } catch (e) {
    const fallo = traducirFallo(e);
    const estado = fallo.codigo === "trabajo_no_encontrado" ? 404 : 500;
    return NextResponse.json(
      { error: fallo.mensaje, correlacion: fallo.correlacion },
      { status: estado, headers: { "Cache-Control": "no-store" } },
    );
  }
}
