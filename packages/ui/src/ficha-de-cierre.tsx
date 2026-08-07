/**
 * **La ficha de cierre**: qué le falta a este mes, en una sola pieza.
 *
 * Reemplaza a la barra de cuatro pasos **y** al panel «Por dónde sigue el mes». Eran dos componentes
 * que contestaban la misma pregunta y se contradecían a cuarenta píxeles de distancia: el recorrido
 * dibujaba «② Cargos y descuentos» en pendiente mientras el panel de abajo mandaba a otro lado. Una
 * pieza, un lugar, contradicción imposible.
 *
 * **Por qué no es un stepper.** Un recorrido de pasos supone orden fijo, un paso a la vez, y que
 * todos se recorren. Liquidar un mes no cumple **ninguna** de las tres: los gastos y los cargos se
 * cargan todo el mes, en paralelo y por gente distinta, y la mayoría de los meses no lleva ningún
 * cargo. De ahí salía el defecto que el usuario encontró — un stepper tiene dos casillas, «hecho» y
 * «pendiente», y *«opcional, y este mes no hubo»* no entra en ninguna de las dos. Ver
 * `docs/producto/relevamiento-liquidacion.md`.
 *
 * **Vertical y sin flechas, a propósito.** Cuatro cajas en fila con `›` entre medio se leen como una
 * barra de progreso —algo que se mira—. Filas con casilla, evidencia y verbo se leen como una lista
 * de tareas —algo que se toca—. Sacar las flechas no es un detalle estético: es el arreglo.
 *
 * Cada fila lleva **el hecho, no una etiqueta**: no «Gastos del mes ✓» sino «12 gastos cargados ·
 * $ 6.520.250,00». El estado *es* el hecho.
 */

import type { ReactNode } from "react";
import { IconoCheck } from "./iconos.tsx";

/**
 * Los cuatro estados de un frente.
 *
 * **`sinNovedades` es el que faltaba.** Es el checkbox indeterminado de toda la vida, y existe
 * exactamente para esto: un frente opcional sin movimientos no está *hecho* (no se hizo nada) ni
 * *pendiente* (no hay nada que hacer). Obligado a elegir entre esas dos, el paso desaparecía.
 *
 * `falta` va en gris neutro a propósito: **faltar no es un error**. El ámbar y el rojo quedan libres
 * para los avisos de verdad.
 */
export type EstadoDeFrente = "listo" | "falta" | "sinNovedades" | "todaviaNo";

const GLIFO: Record<EstadoDeFrente, ReactNode> = {
  listo: <IconoCheck />,
  falta: "☐",
  sinNovedades: "–",
  todaviaNo: "·",
};

/** Tres señales por estado —glifo, palabra y color—, así se distinguen en escala de grises (§f.2). */
const PALABRA: Record<EstadoDeFrente, string> = {
  listo: "LISTO",
  falta: "FALTA",
  sinNovedades: "SIN NOVEDADES",
  todaviaNo: "TODAVÍA NO",
};

const MARCA: Record<EstadoDeFrente, string> = {
  listo: "border-success bg-success/15 text-text-primary",
  falta: "border-border-strong bg-bg text-text-primary",
  sinNovedades: "border-border bg-bg text-text-muted",
  todaviaNo: "border-transparent bg-transparent text-text-muted",
};

const PALABRA_COLOR: Record<EstadoDeFrente, string> = {
  listo: "text-text-secondary",
  falta: "text-text-primary",
  sinNovedades: "text-text-muted",
  todaviaNo: "text-text-muted",
};

export function FichaDeCierre({
  titulo,
  resumen,
  children,
}: {
  readonly titulo: ReactNode;
  /** El estado del mes en una línea: «1 de 3 obligatorios · falta emitir». */
  readonly resumen: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      data-admin-barrios-ui
      aria-label="Para cerrar el período"
      className="rounded-lg border border-border bg-surface shadow-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-base gap-y-xs border-b border-border px-base py-sm">
        <h2 className="text-base font-semibold">{titulo}</h2>
        <p className="text-xs text-text-secondary">{resumen}</p>
      </div>
      <ol className="flex flex-col">{children}</ol>
    </section>
  );
}

export function FrenteDeCierre({
  estado,
  numero,
  titulo,
  opcional,
  evidencia,
  accion,
}: {
  readonly estado: EstadoDeFrente;
  readonly numero: number;
  readonly titulo: ReactNode;
  /** Se dice con todas las letras. Un frente opcional que no se declara opcional se lee como olvido. */
  readonly opcional?: boolean;
  /** El hecho, con su cifra. Nunca una etiqueta genérica. */
  readonly evidencia: ReactNode;
  /** El verbo. Ausente —no apagado— cuando no se puede hacer nada (doc 06 §c.6.4). */
  readonly accion?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-base gap-y-sm border-b border-border px-base py-sm last:border-b-0">
      <span
        className={`grid h-control-sm w-control-sm shrink-0 place-items-center rounded-pill border text-sm font-semibold ${MARCA[estado]}`}
        aria-hidden
      >
        {GLIFO[estado]}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[0.1rem] leading-snug">
        <span className="flex flex-wrap items-baseline gap-x-sm">
          {/* La palabra de estado es **visible**, no solo para lectores: es lo que hace que la ficha
              funcione en escala de grises y para quien no distingue el verde. */}
          <span className={`font-mono text-[0.65rem] tracking-wide ${PALABRA_COLOR[estado]}`}>{PALABRA[estado]}</span>
          <span className="text-sm font-medium text-text-primary">
            {numero} · {titulo}
          </span>
          {opcional ? (
            <span className="rounded-pill border border-border px-xs font-mono text-[0.6rem] text-text-muted">
              OPCIONAL
            </span>
          ) : null}
        </span>
        <span className="text-xs text-text-secondary">{evidencia}</span>
      </span>
      {accion ? <span className="shrink-0">{accion}</span> : null}
    </li>
  );
}
