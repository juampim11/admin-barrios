/**
 * La pantalla de ingreso (pieza 4 del inventario, ADR-0003 §4).
 *
 * **Es la primera pantalla que ve alguien a quien se le está mostrando el sistema**, así que carga
 * con más trabajo del que parece: tiene que verse terminada, y tiene que dejar claro —sin que nadie
 * lo pregunte— que esto es una demostración con datos ficticios. Por eso la franja de arriba no es
 * decorativa: es parte del diseño (ADR-0002 §2.3).
 *
 * Acá no hay nada de sesión ni de autenticación: son cajas. Quién se puede elegir, qué pasa al
 * elegirlo y por qué en producción esta pantalla no existe lo decide `apps/web`.
 */

import type { ReactNode } from "react";
import { IconoFlecha } from "./iconos.tsx";

export function PanelDeIngreso({
  aviso,
  marca,
  bajada,
  children,
}: {
  /** La franja de contexto de arriba. Sin ella la pantalla miente por omisión. */
  readonly aviso: ReactNode;
  readonly marca: ReactNode;
  readonly bajada: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div data-admin-barrios-ui className="flex min-h-dvh flex-col bg-bg text-text-primary">
      <div className="flex flex-wrap items-center justify-center gap-sm border-b border-warning/45 bg-warning/10 px-base py-sm text-center text-sm">
        {aviso}
      </div>
      <div className="mx-auto flex w-full max-w-[34rem] flex-col gap-lg px-base py-2xl">
        <div className="flex flex-col gap-xs">
          <p className="text-2xl font-bold text-marca-aa">{marca}</p>
          <p className="text-sm text-text-secondary">{bajada}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Una persona del elenco, como botón de un formulario.
 *
 * El botón envuelve **toda** la tarjeta y no una flecha al costado: el objetivo táctil es la fila
 * entera (doc 06 §f.6), y es la misma lección de la observación A-2 —una fila que se puede clickear
 * tiene que parecer que se puede clickear—.
 *
 * Las iniciales son decorativas (`aria-hidden`): **nunca reemplazan al nombre**, lo acompañan. Un
 * lector de pantalla anuncia el nombre, el rol y el correo, que es lo que distingue a una persona de
 * otra; deletrear "VR" no le sirve a nadie.
 */
export function TarjetaDePersona({
  iniciales,
  nombre,
  descripcion,
  correo,
}: {
  readonly iniciales: string;
  readonly nombre: ReactNode;
  readonly descripcion: ReactNode;
  readonly correo: ReactNode;
}) {
  return (
    <button
      type="submit"
      className="flex w-full cursor-pointer items-center gap-base rounded-md border border-border bg-surface p-base text-left text-text-primary shadow-sm transition-colors hover:border-primary hover:bg-primary-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      <span
        className="grid h-control-base w-control-base shrink-0 place-items-center rounded-pill bg-primary-subtle font-semibold text-marca-aa"
        aria-hidden
      >
        {iniciales}
      </span>
      <span className="flex min-w-0 flex-col gap-[0.1rem] leading-snug">
        <span className="font-semibold">{nombre}</span>
        <span className="text-sm text-text-secondary">{descripcion}</span>
        <span className="font-mono text-xs text-text-muted">{correo}</span>
      </span>
      <span className="ml-auto shrink-0 text-text-muted" aria-hidden>
        <IconoFlecha direccion="derecha" />
      </span>
    </button>
  );
}
