import type { ReactNode } from "react";
import { clasesDeBoton } from "./boton.tsx";
import { Chip } from "./chip.tsx";
import { IconoHerramienta } from "./iconos.tsx";

export type BarrioParaSelector = {
  readonly id: string;
  readonly nombre: string;
  readonly figura: string;
  readonly detalle?: string | null;
  readonly href: string;
};

export function ShellAdministrador({
  marca,
  marcaHref,
  demo,
  usuario,
  origen,
  accionSesion,
  children,
}: {
  readonly marca: ReactNode;
  readonly marcaHref: string;
  readonly demo?: boolean;
  readonly usuario: ReactNode;
  readonly origen: ReactNode;
  readonly accionSesion: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div data-admin-barrios-ui className="flex min-h-dvh flex-col bg-bg text-text-primary">
      <header className="flex flex-wrap items-center gap-sm border-b border-border bg-surface px-base py-sm">
        <a
          href={marcaHref}
          className="inline-flex items-baseline gap-xs text-lg font-bold text-marca-aa no-underline"
        >
          {marca}
        </a>
        {demo ? (
          <Chip tono="alerta" icono={<IconoHerramienta />} punteado>
            Demostración
          </Chip>
        ) : null}
        <div className="ml-auto flex items-center gap-sm text-sm">
          <span className="flex flex-col items-end leading-snug">
            <span className="font-medium">{usuario}</span>
            <span className="font-mono text-xs text-text-muted">{origen}</span>
          </span>
          {accionSesion}
        </div>
      </header>
      {children}
    </div>
  );
}

/**
 * El botón de "Salir" del encabezado. Vive acá y no en `boton.tsx` porque es un `submit` sin más
 * atributos y está pegado al shell; comparte las clases del botón secundario a través de
 * `clasesDeBoton()`, así que no se despinta cuando el botón cambie.
 */
export function BotonSecundarioSubmit({ children }: { readonly children: ReactNode }) {
  return (
    <button type="submit" className={clasesDeBoton({ variante: "secundario", tamano: "sm" })}>
      {children}
    </button>
  );
}
