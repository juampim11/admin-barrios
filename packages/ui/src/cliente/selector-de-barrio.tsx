"use client";

import { Menu } from "@base-ui/react/menu";
import type { BarrioParaSelector } from "../shell.tsx";
import { IconoCheck, IconoChevron } from "../iconos.tsx";

export function SelectorDeBarrio({
  actualId,
  barrios,
}: {
  readonly actualId: string;
  readonly barrios: readonly BarrioParaSelector[];
}) {
  const actual = barrios.find((barrio) => barrio.id === actualId) ?? barrios[0];

  return (
    <Menu.Root>
      <Menu.Trigger className="inline-flex min-h-[2.75rem] items-center gap-sm rounded-md border border-border-strong bg-surface px-base text-left text-text-primary shadow-sm hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <span className="h-[0.7rem] w-[0.7rem] shrink-0 rounded-pill bg-[var(--acento)]" aria-hidden />
        <span className="flex min-w-0 flex-col leading-snug">
          <span className="truncate text-sm font-semibold">{actual?.nombre ?? "Barrio"}</span>
          <span className="truncate text-xs text-text-secondary">{actual?.detalle ?? "Cambiar barrio"}</span>
        </span>
        <IconoChevron className="ml-xs shrink-0 text-text-muted" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} className="z-50">
          <Menu.Popup className="min-w-[18rem] rounded-md border border-border bg-surface p-xs shadow-lg">
            {barrios.map((barrio) => {
              const activo = barrio.id === actualId;
              return (
                <Menu.Item
                  key={barrio.id}
                  onClick={() => {
                    if (!activo) window.location.assign(destinoPara(barrio, actualId));
                  }}
                  className={[
                    "grid cursor-pointer grid-cols-[1rem_1fr] gap-sm rounded-sm px-sm py-sm text-sm outline-none",
                    "data-[highlighted]:bg-primary-subtle data-[highlighted]:text-text-primary",
                    activo ? "font-semibold text-text-primary" : "text-text-secondary",
                  ].join(" ")}
                >
                  <span className="pt-[0.15rem] text-primary">{activo ? <IconoCheck /> : null}</span>
                  <span className="min-w-0">
                    <span className="block truncate">{barrio.nombre}</span>
                    <span className="block truncate text-xs text-text-muted">{barrio.detalle ?? barrio.figura}</span>
                  </span>
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function destinoPara(barrio: BarrioParaSelector, actualId: string): string {
  const ruta = window.location.pathname;
  const prefijo = `/${actualId}`;
  if (ruta === prefijo || ruta.startsWith(`${prefijo}/`)) return `/${barrio.id}${ruta.slice(prefijo.length)}`;
  return barrio.href;
}