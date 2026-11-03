import type { ReactNode } from "react";

export type Tono = "neutro" | "marca" | "info" | "exito" | "alerta" | "peligro";

const TONO: Record<Tono, string> = {
  neutro: "border-text-muted/45 bg-text-muted/10 text-text-primary",
  marca: "border-primary/45 bg-primary/10 text-text-primary",
  info: "border-info/45 bg-info/10 text-text-primary",
  exito: "border-success/45 bg-success/10 text-text-primary",
  alerta: "border-warning/45 bg-warning/10 text-text-primary",
  peligro: "border-danger/45 bg-danger/10 text-text-primary",
};

/**
 * Chip de estado: **color + ícono + texto**, los tres siempre (doc 06 §f.2). Es el único chip del
 * sistema: el duplicado con CSS Module de `apps/web/src/componentes/ui.tsx` se borró (encargo 8, T1).
 *
 * El texto va en `text-primary` y el color vive en el borde y el fondo tenue: varios tokens de
 * estado no llegan a 4,5:1 sobre superficie clara, así que teñir la palabra rompería AA.
 * `punteado` = **provisorio** (un período editable, la sesión de demostración); siempre viene de un
 * dato, nunca se decide acá.
 */
export function Chip({
  tono = "neutro",
  icono,
  punteado,
  children,
}: {
  readonly tono?: Tono;
  readonly icono?: ReactNode;
  readonly punteado?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={[
        "inline-flex items-center gap-xs whitespace-nowrap rounded-pill border px-sm py-[0.15rem] text-xs font-medium leading-snug",
        punteado ? "border-dashed" : "",
        TONO[tono],
      ].join(" ")}
    >
      {icono ? <span className="shrink-0 text-[1.05em] text-current">{icono}</span> : null}
      {children}
    </span>
  );
}
