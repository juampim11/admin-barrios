/**
 * `GET /api/documentos/[documentoId]` — descarga de un documento emitido.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL CONTROL QUE SOSTIENE TODO LO DEMÁS
 *
 * La credencial con la que esta aplicación firma URLs **alcanza al bucket entero**: presignar no
 * consulta a nadie, se calcula localmente con la clave. Lo único que separa "la boleta de esta
 * unidad" de "todas las boletas de todos los barrios" es que la `storage_key` haya salido de una
 * fila leída bajo RLS en esta misma request.
 *
 * De ahí sale la regla, y hay un test de arquitectura que la vigila: **esta ruta recibe un
 * `documentoId`, jamás una clave**. Una ruta que acepte una clave por parámetro —"para no tener que
 * consultar dos veces"— convierte la credencial en una llave maestra.
 *
 * `prepararDescarga()` hace las dos cosas en una transacción y en este orden: lee el documento bajo
 * RLS y **registra la acuñación del link antes de que exista**. Si el registro falla, no hay URL.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UN `302` Y NO EL ARCHIVO
 *
 * Proxear el objeto por Next sería el archivo entero en memoria del proceso web y el doble de
 * tráfico de salida, contra las reglas §1 y §2.h del presupuesto de recursos. El precio de la URL
 * firmada es que **descarga sin sesión mientras dure**, y ese precio se paga con cuatro cosas
 * escritas y no con confianza: TTL de 90 segundos, `no-store` puesto **en el presign** (el de esta
 * respuesta no viaja al objeto), `attachment` para que no se renderice inline —que es lo que hace
 * que el desplegador de vistas previas de una aplicación de mensajería muestre el importe en la
 * burbuja del chat— y `no-referrer`, para que la URL de la aplicación no aparezca en los registros
 * del proveedor de almacenamiento.
 *
 * **La URL firmada no se escribe en ningún log.**
 */

import { NextResponse } from "next/server";
import { TTL_DESCARGA_SEGUNDOS } from "@admin-barrios/almacenamiento";
import { prepararDescarga } from "@admin-barrios/data/servicios/documentos";
import { conSesionHttp } from "../../../../servidor/db.ts";
import { almacenamiento } from "../../../../servidor/almacenamiento.ts";
import { traducirFallo } from "../../../../acciones/resultado.ts";

export const dynamic = "force-dynamic";

export async function GET(
  _pedido: Request,
  { params }: { params: Promise<{ documentoId: string }> },
): Promise<NextResponse> {
  const { documentoId } = await params;

  try {
    // Leer y registrar, adentro de la sesión. Firmar es trabajo de CPU sin base: va afuera, que es la
    // regla de `db.ts` — adentro de `conSesion` no se hace nada que no necesite la transacción.
    const resultado = await conSesionHttp((tx) =>
      prepararDescarga(tx, { documentoId, ttlSegundos: TTL_DESCARGA_SEGUNDOS }),
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
    const estado = fallo.codigo === "documento_no_encontrado" ? 404 : 500;
    return NextResponse.json(
      { error: fallo.mensaje, correlacion: fallo.correlacion },
      { status: estado, headers: { "Cache-Control": "no-store" } },
    );
  }
}
