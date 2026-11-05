/**
 * **La bomba de la cola**: toma un trabajo, lo corre con su latido, lo cierra, y sigue con el próximo
 * hasta que no queda ninguno.
 *
 * Vivía adentro de `main.ts`, y por eso no había forma de probar la cadena del mes entera (emitir →
 * boletas en PDF → informe → paquete) sin levantar el proceso. Ahora `main.ts` la arma con la cola de
 * verdad y el test de integración (`test/cadena-del-mes.db.test.ts`) con la misma cola y un generador
 * de PDF falso.
 *
 * **No nombra la conexión de la cola** (regla 11 del gate): recibe cuatro funciones (`Cola`) que
 * `main.ts` arma sobre `servidor/cola.ts`. Lo que corre los trabajos usa `DbConIdentidad`, bajo RLS.
 */

import { conUsuario } from "@admin-barrios/data/client";
import { encadenarElPaquete } from "@admin-barrios/data/servicios/trabajos";
import type { TipoTrabajo, TrabajoTomado } from "./servidor/cola.ts";
import type { ContextoDeTrabajo, ManejadorDeTrabajo } from "./servidor/contexto.ts";
import { ErrorDeEmision } from "./emision.ts";
import { ErrorDeDistribucion } from "./distribucion.ts";

/** Lo que la bomba necesita de la cola. `main.ts` lo arma con `servidor/cola.ts`. */
export type Cola = {
  readonly tomar: () => Promise<TrabajoTomado | null>;
  readonly avanzar: (trabajoId: string, avance: { hechos?: number; total?: number }) => Promise<void>;
  readonly latir: (trabajoId: string) => Promise<void>;
  readonly terminar: (trabajoId: string, resultado: { ok: true } | { ok: false; mensajeDeError: string }) => Promise<void>;
};

/**
 * Cómo se llama en el log lo que contó cada trabajo. **No es cosmética**: sin esto, la corrida que
 * mandó 510 correos quedaba registrada como "510 documentos". Record cerrado, como los handlers.
 */
const SUSTANTIVO: Record<TipoTrabajo, string> = {
  emitir_documentos_periodo: "documentos",
  emitir_informe_periodo: "informes",
  armar_paquete_periodo: "boletas empaquetadas",
  distribuir_liquidaciones: "correos aceptados",
  emitir_recibo_pago: "documentos",
};

export type Bomba = {
  /** Corre trabajos hasta que la cola queda vacía. Reentrante: si ya está corriendo, anota y vuelve. */
  readonly bombear: () => Promise<void>;
  readonly corriendo: () => boolean;
  /** Deja de tomar trabajo nuevo (apagado ordenado). El que está en vuelo termina. */
  readonly detener: () => void;
};

export function crearBomba(opciones: {
  readonly cola: Cola;
  readonly handlers: Record<TipoTrabajo, ManejadorDeTrabajo>;
  readonly contexto: Omit<ContextoDeTrabajo, "alAvanzar">;
  readonly latidoMs: number;
  readonly log?: Pick<Console, "log" | "warn" | "error">;
}): Bomba {
  const { cola, handlers, contexto, latidoMs } = opciones;
  const log = opciones.log ?? console;
  let corriendo = false;
  let pendiente = false;
  let detenida = false;

  async function correrUno(trabajo: TrabajoTomado): Promise<void> {
    const arranque = Date.now();
    // El latido: mientras el handler trabaja, la fila dice que el proceso sigue vivo. Si el proceso
    // muere, el latido se corta y el barrido reencola el trabajo al minuto (`caducarRezagados`).
    const latido = setInterval(() => {
      void cola.latir(trabajo.id).catch(() => undefined);
    }, latidoMs);
    try {
      const resultado = await handlers[trabajo.tipo](trabajo, {
        ...contexto,
        alAvanzar: (avance) => cola.avanzar(trabajo.id, avance),
      });
      await cola.terminar(trabajo.id, { ok: true });
      // D5 (ADR-0011): terminadas las boletas en PDF, el paquete se encola solo, con la identidad de
      // quien emitió. Si no puede (no es de la administración), queda el botón: no es un fallo.
      if (trabajo.tipo === "emitir_documentos_periodo") {
        await conUsuario(contexto.db, trabajo.solicitadoPor, (tx) =>
          encadenarElPaquete(tx, { periodoId: trabajo.referenciaId }),
        ).catch((e: unknown) =>
          log.warn(`trabajo ${trabajo.id}: el paquete no se encadenó solo:`, e instanceof Error ? e.name : "desconocido"),
        );
      }
      // Sin barrio, sin período y sin identidad: un log es un almacén que se envía afuera.
      log.log(
        `trabajo ${trabajo.id}: ${resultado.escritos} ${SUSTANTIVO[trabajo.tipo]} en ${Date.now() - arranque} ms` +
          (resultado.yaEstaban > 0 ? ` (${resultado.yaEstaban} ya estaban)` : "") +
          (resultado.fallados !== undefined && resultado.fallados > 0 ? ` — ${resultado.fallados} fallaron` : ""),
      );
    } catch (e) {
      // Lo que se escribe en `trabajo.error` lo lee después una pantalla: nunca un `e.message` crudo,
      // porque los `raise exception` del esquema interpolan valores de filas que quien mira el trabajo
      // puede no tener derecho a ver (ADR-0002 §4.2).
      const mensaje =
        e instanceof ErrorDeEmision || e instanceof ErrorDeDistribucion
          ? e.message
          : "La generación falló por un problema del sistema y no se completó.";
      await cola.terminar(trabajo.id, { ok: false, mensajeDeError: mensaje });
      log.error(`trabajo ${trabajo.id} falló:`, e instanceof Error ? e.name : "desconocido", e);
    } finally {
      clearInterval(latido);
    }
  }

  async function bombear(): Promise<void> {
    // Reentrada: si llega un aviso mientras se está trabajando, se anota y se vuelve al terminar.
    if (corriendo) {
      pendiente = true;
      return;
    }
    corriendo = true;
    try {
      for (;;) {
        // Durante el apagado no se toma trabajo nuevo: tomar uno para abandonarlo es cómo se fabrica
        // una fila `corriendo` huérfana.
        if (detenida) break;
        const trabajo = await cola.tomar();
        if (!trabajo) break;
        await correrUno(trabajo);
      }
    } finally {
      corriendo = false;
      if (pendiente && !detenida) {
        pendiente = false;
        await bombear();
      }
    }
  }

  return {
    bombear,
    corriendo: () => corriendo,
    detener: () => {
      detenida = true;
    },
  };
}
