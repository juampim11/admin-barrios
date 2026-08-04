import type { CSSProperties, ReactNode } from "react";
import { acentoBarrio } from "@admin-barrios/design-tokens/barrio-accent";
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
            Demostracion
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

export function BotonSecundarioSubmit({ children }: { readonly children: ReactNode }) {
  return (
    <button
      type="submit"
      className="inline-flex min-h-[2.25rem] cursor-pointer items-center rounded-sm border border-border-strong bg-surface px-base text-sm text-text-primary hover:border-primary hover:text-marca-aa"
    >
      {children}
    </button>
  );
}

/**
 * La cabecera de un barrio: identidad, acento del tenant, chips de figura y rol, y la navegación.
 *
 * **El selector entra como prop y no se importa acá**, aunque el import fuera más corto. Dos motivos,
 * los dos con consecuencias medibles:
 *
 * 1. **Peso.** `index.ts` reexporta este archivo, así que una pantalla que solo quiere un `Boton`
 *    importaría —por el barril— la isla de cliente del selector y su primitiva. Se vio en el
 *    `pnpm build`: la lista de períodos, que es lectura pura, se llevaba ~50 kB de JavaScript que no
 *    ejecuta. El kit no puede tener un peso que dependa de qué reexporta su índice.
 * 2. **La frontera se ve en el import** (ADR-0003 §4). Es el layout el que escribe
 *    `@admin-barrios/ui/cliente/selector-de-barrio`, y ahí queda declarado que esa pantalla manda
 *    JavaScript al navegador. Escondido adentro del kit, no lo declara nadie.
 *
 * Con **un solo barrio** el layout pasa `selector` en `null` y acá va el título fijo: no se renderiza
 * un control que no tiene nada que elegir (doc 06 §c.6.2).
 */
export function CabeceraBarrio({
  barrio,
  selector,
  figura,
  roles,
  navegacion,
}: {
  readonly barrio: BarrioParaSelector;
  readonly selector: ReactNode;
  readonly figura: ReactNode;
  readonly roles: readonly ReactNode[];
  readonly navegacion: ReactNode;
}) {
  const style = {
    "--acento-claro": acentoBarrio(barrio.id, "light"),
    "--acento-oscuro": acentoBarrio(barrio.id, "dark"),
  } as CSSProperties;

  return (
    <div
      data-admin-barrios-ui
      style={style}
      className="border-b border-border bg-[linear-gradient(to_bottom,color-mix(in_srgb,var(--acento)_9%,var(--surface)),var(--surface))] [--acento:var(--acento-claro)] [box-shadow:inset_0_4px_0_0_var(--acento)] dark:[--acento:var(--acento-oscuro)]"
    >
      <div className="mx-auto flex max-w-[80rem] flex-wrap items-center gap-x-base gap-y-sm px-base pb-sm pt-base">
        {selector ?? (
          <h2 className="flex items-center gap-sm text-lg font-semibold">
            <span className="h-[0.7rem] w-[0.7rem] shrink-0 rounded-pill bg-[var(--acento)]" aria-hidden />
            {barrio.nombre}
          </h2>
        )}
        <div className="flex flex-wrap items-center gap-xs">
          <Chip tono="neutro">{figura}</Chip>
          {roles.map((rol, i) => (
            <Chip key={i} tono="marca">
              {rol}
            </Chip>
          ))}
        </div>
      </div>
      {navegacion}
    </div>
  );
}
