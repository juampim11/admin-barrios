"use client";

/**
 * El selector de barrio: "estoy trabajando en X" (doc 06 §c.1 y §c.6).
 *
 * **Cambiar de barrio aterriza en la portada del barrio nuevo** *(regla del usuario, 2026-08-04;
 * revisa lo que decía el doc 06 §c.6.3 sobre conservar la sección)*. El porqué está escrito entero
 * en `destinoPara`, y se resume en una línea: una sección no significa lo mismo en dos barrios.
 *
 * **Atajo `Ctrl`/`⌘` + `K`** (§c.6.3), y se abre disparando el click del propio trigger en vez de
 * controlar el estado de apertura: así el foco, la navegación con flechas y el retorno de foco al
 * cerrar los sigue manejando Base UI por el mismo camino que un click de mouse. Abrir un menú por
 * fuera de su primitiva es la forma clásica de terminar con un popup que el teclado no puede
 * recorrer y del que el lector de pantalla no se entera.
 *
 * El atajo **no se roba las teclas mientras alguien escribe**: si el foco está en un campo o en algo
 * editable, la combinación sigue de largo. Un administrador cargando un gasto no puede perder lo
 * tipeado porque el chrome decidió que `Ctrl+K` es suyo.
 */

import { useEffect, useRef } from "react";
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
  const disparador = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const alTeclado = (evento: KeyboardEvent) => {
      if (evento.key.toLowerCase() !== "k" || !(evento.ctrlKey || evento.metaKey)) return;
      if (estaEscribiendo(evento.target)) return;
      evento.preventDefault();
      disparador.current?.click();
    };
    window.addEventListener("keydown", alTeclado);
    return () => window.removeEventListener("keydown", alTeclado);
  }, []);

  return (
    <Menu.Root>
      <Menu.Trigger
        ref={disparador}
        aria-keyshortcuts="Control+K"
        className="flex w-full min-h-control-base items-center gap-sm rounded-md border border-border-strong bg-surface px-sm py-xs text-left text-text-primary shadow-sm hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <span className="h-[0.7rem] w-[0.7rem] shrink-0 rounded-pill bg-[var(--acento)]" aria-hidden />
        {/*
          El nombre **envuelve, no se recorta**. En la barra lateral el ancho es fijo y un
          "Barrio Demo…" cortado deja al administrador sin la única respuesta que esta pieza existe
          para dar: en qué barrio está trabajando. Dos renglones cuestan menos que esa duda.
        */}
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="text-sm font-semibold">{actual?.nombre ?? "Barrio"}</span>
          <span className="text-xs text-text-secondary">{actual?.detalle ?? "Cambiar barrio"}</span>
        </span>
        {/*
          La pista del atajo se dibuja pero no se anuncia: `aria-keyshortcuts` ya se lo dice al lector
          de pantalla, y repetirlo como texto haría que lo lea dos veces con distinta forma.

          ⚠ Va sin variante responsive —lo suyo sería esconderla en pantalla angosta, donde no hay
          tecla `Ctrl`— porque **hoy el kit no tiene breakpoints**: el `@theme` generado apaga los de
          Tailwind (`--breakpoint-*: initial`) y no define otros, así que un `sm:` no compila y se
          pierde en silencio. No se arregla acá: los breakpoints tienen que nacer como token, y
          tienen la vuelta de que Tailwind los necesita como valor literal (un `@media` no acepta
          `var()`), o sea que son la primera excepción legítima al guardián UI-7. Anotado en HANDOFF.
        */}
        <kbd
          className="shrink-0 self-start rounded-sm border border-border px-[0.2rem] font-mono text-[0.65rem] leading-snug text-text-muted"
          aria-hidden
        >
          Ctrl K
        </kbd>
        <IconoChevron className="shrink-0 text-text-muted" />
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
                    if (!activo) window.location.assign(destinoPara(barrio));
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

/** Si el foco está en algo donde se escribe, el atajo no existe. */
function estaEscribiendo(destino: EventTarget | null): boolean {
  if (!(destino instanceof HTMLElement)) return false;
  if (destino.isContentEditable) return true;
  const etiqueta = destino.tagName;
  return etiqueta === "INPUT" || etiqueta === "TEXTAREA" || etiqueta === "SELECT";
}

/**
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * A DÓNDE VA EL CAMBIO DE BARRIO: **SIEMPRE A LA PORTADA DEL BARRIO NUEVO**
 *
 * *(Regla del usuario, 2026-08-04.)* Antes se conservaba la sección —"si estabas en Liquidación,
 * seguís en Liquidación"— con la excepción de las rutas que llevan un id de entidad. Sonaba a
 * herramienta de trabajo y en la práctica no lo era, porque **una sección no significa lo mismo en
 * dos barrios**:
 *
 * - `…/liquidacion/cuota` existe en un barrio de importe fijo y **no significa nada** en uno que
 *   prorratea: la persona aterrizaba en un formulario para definir un valor que ese barrio no usa.
 * - Y ese no es el único caso posible, es el primero que apareció. Cada sección que dependa del
 *   modelo, de la figura jurídica o de un módulo que un barrio tiene y otro no, vuelve a abrir el
 *   mismo agujero — y lo abre en silencio, porque la excepción de los ids no lo cubre.
 *
 * Mantener la regla exigía que el selector supiera qué secciones aplican a cada barrio. Eso es
 * conocimiento de dominio adentro de un componente de presentación (ADR-0003 §11: `packages/ui`
 * llega a tokens y a `shared`, y a nada más), y desactualizado sería peor que no tenerlo.
 *
 * **Cambiar de barrio es cambiar de contexto**, y el lugar honesto para empezar es la portada, que
 * es lo único que existe con seguridad en todos. El `href` de cada barrio lo arma el layout con
 * `portadaDelBarrio()`: un solo lugar decide cuál es, y hoy es el tablero.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
function destinoPara(barrio: BarrioParaSelector): string {
  return barrio.href;
}
