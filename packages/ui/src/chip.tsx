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
