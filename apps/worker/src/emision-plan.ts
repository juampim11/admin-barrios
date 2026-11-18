/**
 * Los trabajos `emitir_acuerdo_plan` y `emitir_anexo_plan` (encargo P2a-3): el PDF de UN plan de pagos,
 * por uno de sus dos caminos. Mismas reglas que el recibo (`emision-recibo.ts`):
 *
 * 1. **`conUsuario` con quien lo pidió**: el plan, el modelo y el titular se leen bajo su RLS.
 * 2. **`barrioId` es una aserción, no un filtro**: si el plan no es del barrio del trabajo, se corta.
 * 3. **El render va fuera de transacción**, y **el objeto primero, la fila después**: si el proceso muere
 *    en el medio queda un objeto huérfano, no una fila cuya descarga rompe.
 *
 * Sin guard de idempotencia, a diferencia del recibo: un plan puede tener varios PDF a propósito (se
 * vuelve a armar después de aprobarlo, con las cifras de la firma), y un reintento que deja dos iguales
 * no pisa nada. Cada uno queda con su SHA-256 y su evento.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { conUsuario } from "@admin-barrios/data/client";
import { esErrorDeNegocio } from "@admin-barrios/shared/errores";
import { armarVistaDeAcuerdoPlan, registrarDocumentoGeneradoDelPlan } from "@admin-barrios/data/servicios/planes-documentos";
import { solicitudDeAcuerdoPlan } from "@admin-barrios/documentos";
import { claveDeDocumentoDePlan, nuevoToken, ObjetoYaExiste } from "@admin-barrios/almacenamiento";
import type { CaminoDelAcuerdo } from "@admin-barrios/shared/planes-documentos";
import type { Contexto, ResultadoEmision } from "./emision.ts";
import { ErrorDeEmision } from "./emision.ts";
import type { TrabajoTomado } from "./servidor/cola.ts";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Un rechazo de negocio del servicio (sin modelo, plan retirado, sin permiso, el plan cambió mientras se
 * armaba) es permanente: queda como motivo de la falla, con su texto para la pantalla, y no se reintenta.
 * Se reconoce por el tipo, no por el texto del mensaje (code-reviewer).
 */
function comoFallaDeNegocio(e: unknown): never {
  if (esErrorDeNegocio(e)) throw new ErrorDeEmision(e.message, "plan_sin_documento");
  throw e;
}

function emitirDocumentoDelPlan(camino: CaminoDelAcuerdo) {
  return async (trabajo: TrabajoTomado, ctx: Contexto): Promise<ResultadoEmision> => {
    // ── 1. Leer y armar la vista, y cerrar la transacción ─────────────────────────────────────────
    const vista = await conUsuario(ctx.db, trabajo.solicitadoPor, async (tx) => {
      const fila = (await tx.execute<{ barrio_id: string }>(sql`select barrio_id from plan_pago where id = ${trabajo.referenciaId}`)).rows[0];
      if (!fila) {
        throw new ErrorDeEmision("El plan ya no está disponible para quien pidió el documento.", "plan_inaccesible");
      }
      // ── 2. La aserción de aislamiento. NO es un filtro ─────────────────────────────────────────
      if (fila.barrio_id !== trabajo.barrioId) {
        throw new ErrorDeEmision("La generación se detuvo por una comprobación de seguridad.", "barrio_no_coincide");
      }
      // Hoy, en la zona del barrio: la fecha que dice el PDF (en la misma transacción).
      const hoy = (await tx.execute<{ hoy: string }>(sql`select (now() at time zone zona_horaria)::date::text as hoy from barrio where barrio_id = ${trabajo.barrioId}`))
        .rows[0]?.hoy;
      if (!hoy) throw new ErrorDeEmision("La generación se detuvo por una comprobación de seguridad.", "barrio_no_coincide");
      return armarVistaDeAcuerdoPlan(tx, { planId: trabajo.referenciaId, camino, fechaIso: hoy }).catch(comoFallaDeNegocio);
    });

    // ── 3. Renderizar fuera de transacción ───────────────────────────────────────────────────────
    const solicitud = solicitudDeAcuerdoPlan(vista);
    const pdf = await ctx.generador.generar(solicitud, { timeoutMs: ctx.timeoutMs });
    const clave = claveDeDocumentoDePlan({
      barrioId: trabajo.barrioId,
      planId: trabajo.referenciaId,
      token: nuevoToken(),
      contentType: "application/pdf",
    });
    try {
      await ctx.almacenamiento.put(clave, Buffer.from(pdf), {
        contentType: "application/pdf",
        siNoExiste: true,
        descargarComo: camino === "modelo" ? "Acuerdo-del-plan.pdf" : "Anexo-del-plan.pdf",
      });
    } catch (e) {
      throw e instanceof ObjetoYaExiste
        ? new ErrorDeEmision("La generación se detuvo: la clave del objeto ya existía.", "clave_de_objeto_colisionada")
        : e;
    }

    // ── 4. La fila y su evento, en una transacción corta y nueva ─────────────────────────────────
    await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
      registrarDocumentoGeneradoDelPlan(tx, {
        planId: trabajo.referenciaId,
        camino,
        storageKey: clave,
        sha256: sha256(pdf),
        bytes: pdf.byteLength,
        vista,
        motor: ctx.generador.motor,
        plantillaHash: sha256(solicitud.estilos),
      }).catch(comoFallaDeNegocio),
    );
    return { escritos: 1, yaEstaban: 0 };
  };
}

/** Camino a: el modelo de cláusulas completado más el anexo. */
export const emitirAcuerdoDelPlan = emitirDocumentoDelPlan("modelo");
/** Camino b: solo el anexo, para acompañar el documento del estudio. */
export const emitirAnexoDelPlan = emitirDocumentoDelPlan("anexo");
