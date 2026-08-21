/**
 * El trabajo `emitir_recibo_pago`: el recibo de UN pago, no un lote — mismas tres reglas que
 * `emision.ts` (`conUsuario`, `barrioId` como aserción y no como filtro, render fuera de
 * transacción), con una cuarta que no tiene la boleta:
 *
 * 4. **El número se reserva ANTES de renderizar, en la misma transacción que lee el pago.** El
 *    número tiene que estar impreso DENTRO del PDF, y el PDF se renderiza fuera de transacción — no
 *    hay forma de tenerlo antes sin separar la reserva del `insert` (`app.reservar_numero_recibo()`,
 *    migración `0042`). Es la pieza que abrió el panel arquitecto-software/dba-data/security-engineer
 *    + legal-ph/contador del 2026-08-20: ver el comentario de cabecera de esa migración para el
 *    riesgo aceptado (Nivel 1) y por qué no hace falta la garantía de cero huecos (Nivel 2).
 *
 * **Idempotencia ante reintento**: antes de reservar nada, se chequea si el pago YA tiene un recibo
 * (`reciboYaEmitido`). `recibo_emitido` usa numeración secuencial por barrio — un reintento que no
 * chequeara esto generaría un SEGUNDO recibo válido para el mismo pago, con otro número.
 */

import { createHash } from "node:crypto";
import { conUsuario } from "@admin-barrios/data/client";
import {
  reciboYaEmitido,
  registrarReciboEmitido,
  reservarNumeroDeRecibo,
} from "@admin-barrios/data/servicios/documentos";
import { armarVistaDeRecibo } from "@admin-barrios/data/servicios/vista-recibo";
import { solicitudDeRecibo, VERSION_VISTA_RECIBO, type VistaRecibo } from "@admin-barrios/documentos";
import { claveDeRecibo, nuevoToken, ObjetoYaExiste } from "@admin-barrios/almacenamiento";
import type { Contexto, ResultadoEmision } from "./emision.ts";
import { ErrorDeEmision } from "./emision.ts";
import type { TrabajoTomado } from "./servidor/cola.ts";
import { sql } from "drizzle-orm";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `ctx: Contexto` es la misma que recibe `emitirDocumentosDelPeriodo` — `HANDLERS` (`main.ts`) es un
 * `Record` cerrado y despacha a los dos handlers con el mismo objeto. `chunk`, `registroDeMedios` y
 * `alAvanzar` no se usan acá: un recibo es un documento, no un lote con barra de progreso.
 *
 * Devuelve `ResultadoEmision` por el mismo motivo — `bombear()` (`main.ts`) loguea
 * `resultado.escritos`/`resultado.yaEstaban` sin distinguir de qué tipo vino el trabajo. `escritos`
 * es 0 o 1; `yaEstaban` es el corto-circuito de idempotencia.
 */
export async function emitirReciboDePago(trabajo: TrabajoTomado, ctx: Contexto): Promise<ResultadoEmision> {
  // ── 1. Leer, reservar el número si hace falta, y cerrar la transacción ────────────────────────
  const contexto = await conUsuario(ctx.db, trabajo.solicitadoPor, async (tx) => {
    const fila = (
      await tx.execute<{ barrio_id: string }>(sql`select barrio_id from pago where id = ${trabajo.referenciaId}`)
    ).rows[0];
    // Cero filas = el pago no existe **o** quien pidió la emisión ya no lo puede leer. Los dos casos
    // terminan igual, mismo criterio que `emision.ts`.
    if (!fila) {
      throw new ErrorDeEmision(
        "El pago ya no está disponible para quien pidió la emisión del recibo.",
        "pago_inaccesible",
      );
    }
    // ── 2. La aserción de aislamiento. NO es un filtro (mismo criterio que `emision.ts`) ─────────
    if (fila.barrio_id !== trabajo.barrioId) {
      throw new ErrorDeEmision(
        "La generación se detuvo por una comprobación de seguridad.",
        "barrio_no_coincide",
      );
    }

    // El guard de idempotencia: se chequea ANTES de reservar, porque reservar consume un número.
    const existente = await reciboYaEmitido(tx, trabajo.referenciaId);
    if (existente) return { yaEmitido: true as const, reciboId: existente.id };

    const numeroRecibo = await reservarNumeroDeRecibo(tx, trabajo.referenciaId);
    const vista = await armarVistaDeRecibo(tx, trabajo.referenciaId, {
      numeroRecibo,
      fechaEmisionIso: new Date().toISOString(),
    });
    return { yaEmitido: false as const, numeroRecibo, vista };
  });

  if (contexto.yaEmitido) {
    return { escritos: 0, yaEstaban: 1 };
  }

  // ── 3. Renderizar fuera de transacción ─────────────────────────────────────────────────────────
  const solicitud = solicitudDeRecibo(contexto.vista as VistaRecibo);
  const pdf = await ctx.generador.generar(solicitud, { timeoutMs: ctx.timeoutMs });
  const plantillaHash = sha256(solicitud.estilos);

  const clave = claveDeRecibo({
    barrioId: trabajo.barrioId,
    pagoId: trabajo.referenciaId,
    token: nuevoToken(),
  });

  // **El objeto primero, la fila después** — mismo orden que `emision.ts` y por el mismo motivo: si
  // el proceso muere en el medio, lo que queda es un objeto huérfano, no una fila cuya descarga rompe.
  try {
    await ctx.almacenamiento.put(clave, Buffer.from(pdf), {
      contentType: "application/pdf",
      siNoExiste: true,
      descargarComo: `Recibo-${contexto.numeroRecibo}.pdf`,
    });
  } catch (e) {
    // Con token aleatorio de 128 bits esto es, en la práctica, imposible — igual que en `emision.ts`.
    // Pero acá SÍ importa distinguirlo: la fila de `recibo_emitido` todavía no existe, así que no hay
    // un "ya estaba" al que replegarse. Si el objeto ya existía con ese token, es un bug real —
    // no un reintento— y se deja propagar.
    throw e instanceof ObjetoYaExiste
      ? new ErrorDeEmision(
          "La generación se detuvo: la clave del objeto ya existía.",
          "clave_de_objeto_colisionada",
        )
      : e;
  }

  // ── 4. La fila, en una transacción corta y nueva, con el número YA reservado en el paso 1 ──────
  await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
    registrarReciboEmitido(tx, {
      barrioId: trabajo.barrioId,
      pagoId: trabajo.referenciaId,
      numeroRecibo: contexto.numeroRecibo,
      storageKey: clave,
      sha256: sha256(pdf),
      bytes: pdf.byteLength,
      vista: contexto.vista,
      vistaVersion: VERSION_VISTA_RECIBO,
      motor: ctx.generador.motor,
      plantillaHash,
    }),
  );

  return { escritos: 1, yaEstaban: 0 };
}
