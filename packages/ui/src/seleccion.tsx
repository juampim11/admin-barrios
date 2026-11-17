/**
 * Las piezas de una lista **en la que se eligen filas para hacer algo con ellas en lote** —hoy, derivar
 * unidades a un estudio jurídico desde la lista de mora (encargo E-a)— y de los diálogos que agrupan lo
 * elegido.
 *
 * Como el resto del kit, **no decide nada**: no sabe qué es una unidad, ni un barrio, ni un estudio.
 * Recibe texto ya armado y elige cómo se ve. Son componentes sin estado: los que llevan un `alCambiar`
 * se usan desde una isla de cliente de `apps/web`, que es la que guarda lo elegido.
 */

import type { ReactNode } from "react";
import { Boton } from "./boton.tsx";

const FOCO =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La lista
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * La casilla de una fila. **Controlada**: lo elegido es estado de la isla, no del formulario (no viaja en
 * ningún `FormData`; lo que se manda lo arma el diálogo). El nombre accesible dice qué fila es, porque
 * cuarenta casillas que dicen «Elegir» son cuarenta controles iguales para quien escucha.
 *
 * El objetivo táctil es la celda entera (doc 06 §f.6): el `<label>` la ocupa.
 */
export function CasillaDeFila({
  etiqueta,
  marcada,
  alCambiar,
}: {
  /** «Elegir Mza 3 · Lote 14 para derivar». */
  readonly etiqueta: string;
  readonly marcada: boolean;
  readonly alCambiar: () => void;
}) {
  return (
    <label data-admin-barrios-ui className="flex min-h-control-sm cursor-pointer items-center justify-center">
      <input
        type="checkbox"
        checked={marcada}
        onChange={alCambiar}
        aria-label={etiqueta}
        className={["size-base cursor-pointer accent-primary", FOCO].join(" ")}
      />
    </label>
  );
}

/**
 * La barra de lo elegido, **pegada al pie de la pantalla** mientras se recorre la lista (`.barra-derivar`
 * de la maqueta de mora): cuántas hay elegidas y los botones para elegir todas, quitar y actuar.
 *
 * `role="group"` con su nombre: es una región de controles relacionados. La cuenta va en `aria-live`
 * para que quien escucha sepa que la casilla que acaba de tocar sumó.
 */
export function BarraDeSeleccion({
  etiqueta,
  cuenta,
  children,
}: {
  /** El nombre del grupo («Derivar a un estudio»). */
  readonly etiqueta: string;
  /** «4 unidades elegidas · de 3 barrios», ya armado. */
  readonly cuenta: ReactNode;
  /** Los botones, el primario **último** (orden de lectura y de tabulación). */
  readonly children: ReactNode;
}) {
  return (
    <div
      data-admin-barrios-ui
      role="group"
      aria-label={etiqueta}
      className="sticky bottom-sm z-10 mt-md flex flex-wrap items-center gap-sm rounded-lg border-2 border-primary bg-surface-raised px-base py-sm shadow-md"
    >
      <p aria-live="polite" className="m-none min-w-0 flex-1 text-sm font-semibold text-text-primary">
        {cuenta}
      </p>
      {children}
    </div>
  );
}

/**
 * Un texto que se acorta en pantalla angosta («Elegir todas las del filtro (8)» → «Todas (8)»). El
 * corto es el visible en celular; el largo, desde `sm`. Quien escucha oye siempre el largo.
 */
export function TextoAdaptable({ corto, largo }: { readonly corto: ReactNode; readonly largo: ReactNode }) {
  return (
    <>
      <span aria-hidden className="sm:hidden">
        {corto}
      </span>
      <span className="sr-only sm:not-sr-only">{largo}</span>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El diálogo que agrupa lo elegido
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un grupo del diálogo: un título a la izquierda («Los Aromos · 2 unidades»), un dato a la derecha
 * («2 estudios trabajan acá»), una lista corta y lo que se elige para el grupo (`.grupo` de la maqueta).
 */
export function GrupoDelDialogo({
  titulo,
  detalle,
  items,
  children,
}: {
  readonly titulo: ReactNode;
  readonly detalle?: ReactNode;
  /** Los renglones de la lista, ya escritos («Mza 3 · Lote 14 · 5 meses»). */
  readonly items: readonly { readonly clave: string; readonly texto: ReactNode }[];
  /** El control del grupo (un selector) o el aviso de que falta algo. */
  readonly children?: ReactNode;
}) {
  return (
    <section data-admin-barrios-ui className="flex flex-col gap-sm rounded-md border border-border bg-surface p-md">
      <h3 className="m-none flex flex-wrap items-baseline justify-between gap-x-md gap-y-xs text-sm font-semibold text-text-primary">
        <span>{titulo}</span>
        {detalle ? <span className="text-xs font-regular text-text-secondary">{detalle}</span> : null}
      </h3>
      <ul className="m-none flex list-disc flex-col gap-xs pl-lg text-sm text-text-primary">
        {items.map((i) => (
          <li key={i.clave}>{i.texto}</li>
        ))}
      </ul>
      {children}
    </section>
  );
}

/**
 * Dos (o tres) bloques que explican **qué cambia y qué no** antes de confirmar («Qué ve el estudio» /
 * «Qué sigue igual»). Lado a lado en escritorio, apilados en pantalla angosta.
 */
export function BloquesDeExplicacion({
  bloques,
}: {
  readonly bloques: readonly { readonly titulo: string; readonly children: ReactNode }[];
}) {
  return (
    <div data-admin-barrios-ui className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-sm">
      {bloques.map((b) => (
        <div key={b.titulo} className="rounded-md bg-bg p-md text-sm text-text-secondary">
          <p className="m-none mb-xs font-semibold text-text-primary">{b.titulo}</p>
          {b.children}
        </div>
      ))}
    </div>
  );
}

const TONO_AVISO = {
  info: "border-info/45 border-l-info bg-info-subtle",
  exito: "border-success/45 border-l-success bg-success-subtle",
  alerta: "border-warning/45 border-l-warning bg-warning-subtle",
  peligro: "border-danger/45 border-l-danger bg-danger-subtle",
} as const;

/**
 * Un aviso de un renglón o dos dentro de un diálogo o un panel (`.aviso-at` / `.aviso-ok` de las
 * maquetas): el color va en el borde y el fondo tenue, y el texto en `text-primary` (AA). El tono **no
 * es lo único que lo distingue**: la pantalla lo empieza con su palabra («Ojo:», «Listo:»).
 */
export function AvisoEnLinea({
  tono,
  children,
}: {
  readonly tono: keyof typeof TONO_AVISO;
  readonly children: ReactNode;
}) {
  return (
    <div
      data-admin-barrios-ui
      className={["rounded-md border border-l-4 px-base py-sm text-sm text-text-primary", TONO_AVISO[tono]].join(" ")}
    >
      {children}
    </div>
  );
}

/**
 * Una tarjeta de un renglón con su acción **a la derecha, en la misma fila** («Hacer por defecto» junto
 * al estudio). En pantalla angosta la acción baja debajo, alineada a la derecha.
 */
export function TarjetaConAccion({ accion, children }: { readonly accion?: ReactNode; readonly children: ReactNode }) {
  return (
    <div
      data-admin-barrios-ui
      className="flex flex-wrap items-center justify-between gap-sm rounded-md border border-border bg-surface px-md py-sm"
    >
      <div className="min-w-0 flex-1">{children}</div>
      {accion ? <div className="ml-auto shrink-0">{accion}</div> : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Filtros por desplegable, sin JavaScript
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Filtros de una lista que son **desplegables** («Barrio», «Estudio»): un `<form method="get">` con un
 * `<select>` por filtro y un botón «Ver». Mismo mecanismo que `BusquedaDeLista`: sin JavaScript, el
 * navegador arma la URL y el servidor resuelve. `conservar` lleva los parámetros que no son de este
 * formulario (el chip activo), para no perderlos al filtrar.
 */
export function FiltrosDesplegables({
  accion,
  conservar = {},
  filtros,
}: {
  readonly accion: string;
  readonly conservar?: Readonly<Record<string, string>>;
  readonly filtros: readonly {
    readonly nombre: string;
    readonly etiqueta: string;
    readonly valor: string;
    readonly opciones: readonly { readonly valor: string; readonly texto: string }[];
  }[];
}) {
  return (
    <form
      // Los `<select>` no son controlados: al volver con «Atrás» o al cambiar de chip, el navegador puede
      // mostrar lo último que se eligió y no lo que se está filtrando. Con la `key` de los valores, el
      // formulario vuelve a nacer con lo que la URL dice.
      key={filtros.map((f) => `${f.nombre}=${f.valor}`).join("&")}
      data-admin-barrios-ui
      method="get"
      action={accion}
      className="flex flex-wrap items-end gap-sm"
    >
      {Object.entries(conservar).map(([nombre, v]) => (
        <input key={nombre} type="hidden" name={nombre} value={v} />
      ))}
      {filtros.map((f) => (
        <select
          key={f.nombre}
          name={f.nombre}
          defaultValue={f.valor}
          aria-label={f.etiqueta}
          className={[
            "min-h-control-base rounded-md border border-border-strong bg-surface px-sm text-sm text-text-primary",
            FOCO,
          ].join(" ")}
        >
          {f.opciones.map((o) => (
            <option key={o.valor} value={o.valor}>
              {o.texto}
            </option>
          ))}
        </select>
      ))}
      {/* `base`: la misma altura que los desplegables (`min-h-control-base`). */}
      <Boton tipo="submit" variante="secundario">
        Ver
      </Boton>
    </form>
  );
}
