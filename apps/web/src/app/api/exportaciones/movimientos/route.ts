/**
 * `GET /api/exportaciones/movimientos` — el libro de movimientos del barrio, en XLSX (doc 01 §4.8,
 * ADR-0004).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTA RUTA ES SÍNCRONA Y NO ENCOLA UN TRABAJO
 *
 * El resto de los documentos del sistema (boleta, informe, recibo) pasan por la cola y el worker
 * porque **necesitan Chromium**, y la regla 3 del gate impide que la web lo arrastre. Un XLSX no:
 * `exceljs` es JavaScript puro. Pero el motivo de fondo no es que se pueda, es que **corresponde**:
 * `documento_emitido`/`recibo_emitido` son el libro de emisiones append-only —`sha256`, `vista`,
 * `plantilla_hash`, numeración legal— porque guardan documentos **emitidos** a un tercero. Una
 * exportación es una lectura materializada al vuelo, sin número y sin destinatario formal. Meterla
 * en la cola crearía una cuarta clase de artefacto sin valor legal, que después hay que retener,
 * purgar y cubrir con RLS.
 *
 * Y hay una ganancia de seguridad concreta: **no queda nada en reposo**. Ningún objeto huérfano,
 * ninguna URL firmada que sobreviva a la sesión. Este archivo lleva el dinero completo de un barrio
 * y la PII de sus propietarios: una boleta filtrada es una unidad, esto filtrado es el barrio entero.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL ORDEN DE LAS COSAS, QUE ES DONDE VIVE LA SEGURIDAD
 *
 *  1. **Contar** (con `COUNT`, sin traer filas) y cortar con `413` si excede. `exceljs` arma el libro
 *     entero en memoria: contar para después descubrir que era demasiado ya habría pagado el costo.
 *  2. **Registrar la traza** — que es, además, **el gate de rol**: su policy de `insert` decide quién
 *     puede exportar (`0051`). Si acá no pasa, no hay planilla. No se puede exportar sin dejar
 *     rastro, ni dejar rastro sin tener el rol.
 *  3. **Leer** todo, en la MISMA transacción. Basta que una de las cinco consultas se resuelva fuera
 *     de la sesión con identidad para mezclar dos barrios adentro de un archivo — y eso no lo atrapa
 *     ninguna pantalla, porque el archivo se abre afuera.
 *  4. **Cerrar la transacción y recién entonces serializar.** Serializar adentro de `conSesion` es el
 *     bug que tumba la aplicación con diez clicks: el pool es de 10 conexiones y `db.ts` lo dice
 *     explícito — adentro de la transacción no se hace nada lento.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * `no-store` NO ES DECORATIVO
 *
 * Es un `GET` con querystring, que es exactamente la forma que un cache intermedio quiere guardar.
 * Un libro del barrio A servido al barrio B desde un cache sería el peor error posible de esta
 * feature. De ahí `no-store`, `force-dynamic` y `Vary: Cookie`.
 *
 * El `filename` se sanea: la razón social entra ahí y es texto que escribe un `admin_barrio`; un `"`
 * cierra el `filename="…"` y un CR/LF abre una cabecera nueva.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  consultaExportacionSchema,
  MAXIMO_FILAS_EXPORTACION,
} from "@admin-barrios/shared/consultas";
import {
  contarMovimientos,
  leerLibroDeMovimientos,
  registrarExportacion,
} from "@admin-barrios/data/servicios/exportaciones";
import { conSesionHttp } from "../../../../servidor/db.ts";
import { construirLibro } from "../../../../servidor/export/dataset.ts";
import { serializarLibro } from "../../../../servidor/export/xlsx.ts";
import { traducirFallo } from "../../../../acciones/resultado.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIPO_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function GET(pedido: Request): Promise<NextResponse> {
  const url = new URL(pedido.url);
  const parametros = consultaExportacionSchema.safeParse({
    barrioId: url.searchParams.get("barrio"),
    periodoDesde: url.searchParams.get("desde"),
    periodoHasta: url.searchParams.get("hasta"),
  });

  if (!parametros.success) {
    return NextResponse.json(
      { error: mensajeDeParametros(parametros.error) },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const resultado = await conSesionHttp(async (tx) => {
      const conteo = await contarMovimientos(tx, parametros.data);
      if (conteo.total > MAXIMO_FILAS_EXPORTACION) return { excede: true as const, conteo };

      // El libro se lee DESPUÉS de registrar, pero el encabezado necesita saber si el rango incluye
      // períodos no emitidos para que la traza lo registre. Se resuelve leyendo primero y
      // registrando antes de devolver: las dos cosas viven en la misma transacción, así que si el
      // registro falla, la lectura no llega a ninguna parte.
      const libro = await leerLibroDeMovimientos(tx, parametros.data);
      const { selloDeExtraccion } = await registrarExportacion(tx, {
        ...parametros.data,
        conteo,
        incluyoProvisorio: libro.cabecera.incluyeProvisorio,
      });
      return { excede: false as const, libro, selloDeExtraccion };
    });

    if (!resultado.ok) {
      return NextResponse.json(
        { error: "sin sesión" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (resultado.valor.excede) {
      return NextResponse.json(
        {
          error:
            `El rango pedido tiene ${resultado.valor.conteo.total} movimientos y el máximo por ` +
            `exportación es ${MAXIMO_FILAS_EXPORTACION}. Acotá el rango de períodos.`,
        },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Fuera de la transacción, a propósito: acá abajo no se toca la base.
    const { libro, selloDeExtraccion } = resultado.valor;
    const paraPlanilla = construirLibro(libro, parametros.data, selloDeExtraccion);
    const bytes = await serializarLibro(paraPlanilla);

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": TIPO_XLSX,
        "Content-Disposition": `attachment; filename="${paraPlanilla.nombreArchivo}"`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        Vary: "Cookie",
      },
    });
  } catch (e) {
    const fallo = traducirFallo(e);
    // Nunca una fila, un monto ni un nombre en el error: los `raise exception` del esquema
    // interpolan valores de filas que quien lee el error puede no tener derecho a ver. Sale el
    // mensaje traducido y la correlación, nada más.
    return NextResponse.json(
      { error: fallo.mensaje, correlacion: fallo.correlacion },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * El primer problema del parseo, en castellano. **Sin volcar el valor recibido**: un parámetro de
 * query puede traer cualquier cosa, y devolverlo tal cual es un reflejo de entrada del usuario en la
 * respuesta.
 */
function mensajeDeParametros(error: z.ZodError): string {
  return error.issues[0]?.message ?? "parámetros inválidos";
}
