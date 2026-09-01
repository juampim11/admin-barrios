/**
 * `GET /api/paquetes/[periodoId]` — descarga del ZIP de distribución de un período.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EL SEGMENTO ES EL PERÍODO Y NO EL PAQUETE
 *
 * Un paquete es un artefacto **derivado**: se rearma de sus partes, y por eso un período puede tener
 * varios —uno superado y el que vale—. `prepararDescargaDePaquete()` resuelve siempre **el último**,
 * y esa decisión es del servicio, no de quien arma el enlace.
 *
 * Una ruta por `paqueteId` dejaría descargar un ZIP superado con solo conservar la URL vieja: un
 * archivo que dice ser "las liquidaciones del período" y al que le faltan las boletas emitidas
 * después. Con el período en el segmento, el enlace no puede quedar viejo — apunta a lo que hoy es
 * el paquete del período, y si no hay ninguno contesta 404.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL RESTO ES EXACTAMENTE `api/documentos/[documentoId]`, Y A PROPÓSITO
 *
 * La credencial con la que esta aplicación firma **alcanza al bucket entero**: presignar se calcula
 * localmente con la clave, sin consultarle a nadie. Lo único que separa "el ZIP de este período" de
 * "todos los ZIP de todos los barrios" es que la `storage_key` haya salido de una fila leída bajo
 * RLS en esta misma request. De ahí la regla: **esta ruta recibe un id, jamás una clave.**
 *
 * `prepararDescargaDePaquete()` lee bajo RLS y **registra la acuñación del link antes de que exista**,
 * en la misma transacción. Si el registro falla, no hay URL.
 *
 * Y el `302` en vez del archivo: proxear el ZIP por Next sería el archivo entero en memoria del
 * proceso web —y un paquete es el más pesado de todo el sistema, cientos de PDF— contra las reglas
 * §1 y §2.h del presupuesto de recursos.
 *
 * **La URL firmada no se escribe en ningún log.**
 */

import { NextResponse } from "next/server";
import { TTL_DESCARGA_SEGUNDOS } from "@admin-barrios/almacenamiento";
import { prepararDescargaDePaquete } from "@admin-barrios/data/servicios/paquetes";
import { conSesionHttp } from "../../../../servidor/db.ts";
import { almacenamiento } from "../../../../servidor/almacenamiento.ts";
import { traducirFallo } from "../../../../acciones/resultado.ts";

export const dynamic = "force-dynamic";

export async function GET(
  _pedido: Request,
  { params }: { params: Promise<{ periodoId: string }> },
): Promise<NextResponse> {
  const { periodoId } = await params;

  try {
    // Leer y registrar, adentro de la sesión. Firmar es trabajo de CPU sin base: va afuera, que es
    // la regla de `db.ts`.
    const resultado = await conSesionHttp((tx) =>
      prepararDescargaDePaquete(tx, { periodoId, ttlSegundos: TTL_DESCARGA_SEGUNDOS }),
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
    // "No existe", "no es tuyo" y "todavía no se armó" salen iguales: distinguirlos convertiría esta
    // ruta en un oráculo de qué períodos existen en otros barrios.
    const estado = fallo.codigo === "documento_no_encontrado" ? 404 : 500;
    return NextResponse.json(
      { error: fallo.mensaje, correlacion: fallo.correlacion },
      { status: estado, headers: { "Cache-Control": "no-store" } },
    );
  }
}
