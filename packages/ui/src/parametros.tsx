/**
 * Las piezas de las pantallas de configuración (parámetros de mora e imputación, ADR-0006).
 *
 * Todas son de servidor y cuestan **cero JavaScript**: los filtros son links, lo que se abre es
 * `<details>` nativo, y el control Sí/No es un par de radios con cara de botón segmentado. Lo único
 * que viaja al navegador en esas pantallas es el formulario que escribe, que es una isla aparte en
 * `apps/web`.
 *
 * El kit **no decide nada**: no sabe qué es un parámetro, ni cuál es propio, ni cómo se formatea una
 * tasa. Recibe texto ya armado (con `@admin-barrios/shared/dinero` y `shared/fechas` del lado de la
 * pantalla) y elige cómo se ve.
 */

import type { ReactNode } from "react";
import { clasesDeBoton, type VarianteBoton } from "./boton.tsx";
import { IconoCheck, IconoChevron } from "./iconos.tsx";

const FOCO =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Filtros por link
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Una fila de filtros que son **links**, no botones: el filtro vive en la URL (`?filtro=…`), lo
 * resuelve el servidor y se puede compartir o volver atrás. Cada uno lleva su conteo, para que se
 * sepa antes de apretar si hay algo del otro lado.
 */
export function FiltrosDeLista({ etiqueta, children }: { readonly etiqueta: string; readonly children: ReactNode }) {
  return (
    <nav data-admin-barrios-ui aria-label={etiqueta}>
      <ul className="flex flex-wrap gap-sm">{children}</ul>
    </nav>
  );
}

/** Un filtro. El activo se marca con borde, fondo, peso **y** `aria-current`: nunca solo el color. */
export function FiltroDeLista({
  href,
  activo,
  cantidad,
  children,
}: {
  readonly href: string;
  readonly activo: boolean;
  readonly cantidad: number;
  readonly children: ReactNode;
}) {
  return (
    <li>
      <a
        href={href}
        aria-current={activo ? "page" : undefined}
        className={[
          "inline-flex min-h-control-sm items-center gap-sm rounded-pill border px-md text-sm no-underline transition-colors",
          FOCO,
          activo
            ? "border-primary bg-primary-subtle font-semibold text-text-primary"
            : "border-border-strong bg-surface text-text-secondary hover:border-primary hover:text-text-primary",
        ].join(" ")}
      >
        {children}
        <span className="rounded-pill border border-border bg-bg px-sm font-ab-numeric text-xs text-text-primary">
          {cantidad}
        </span>
      </a>
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La lista de parámetros
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Un grupo de parámetros con su título («Interés por mora», «Imputación de pagos»). */
export function GrupoDeParametros({ titulo, children }: { readonly titulo: ReactNode; readonly children: ReactNode }) {
  return (
    <section data-admin-barrios-ui className="flex flex-col gap-sm">
      <h2 className="mt-md text-xs font-semibold uppercase text-text-secondary">{titulo}</h2>
      {children}
    </section>
  );
}

/**
 * Un parámetro: qué es, cuánto vale hoy y de dónde sale.
 *
 * El valor va **grande y a la derecha** porque es lo que se viene a mirar; las marcas de abajo
 * (propio, heredado, programado, valor inicial) son el **origen** de ese valor, que en este sistema
 * nunca va suelto. El `id` es el ancla: la confirmación de «Cobra interés» manda a «Orden de
 * imputación» por ahí.
 */
export function TarjetaDeParametro({
  id,
  nombre,
  ayuda,
  valor,
  unidad,
  marcas,
  historial,
  acciones,
}: {
  readonly id: string;
  readonly nombre: ReactNode;
  readonly ayuda: ReactNode;
  /** Ya formateado por la pantalla. */
  readonly valor: ReactNode;
  /** «mensual» para una tasa. */
  readonly unidad?: ReactNode;
  readonly marcas?: ReactNode;
  readonly historial?: ReactNode;
  readonly acciones?: ReactNode;
}) {
  const idNombre = `${id}-nombre`;
  return (
    <article
      id={id}
      aria-labelledby={idNombre}
      data-admin-barrios-ui
      className="scroll-mt-lg rounded-lg border border-border bg-surface px-base py-md shadow-sm"
    >
      <div className="grid grid-cols-1 gap-x-base gap-y-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="flex flex-col gap-xs">
          <h3 id={idNombre} className="text-base font-semibold text-text-primary">
            {nombre}
          </h3>
          <p className="max-w-prose text-sm text-text-secondary">{ayuda}</p>
        </div>
        <p className="font-ab-numeric text-xl font-semibold whitespace-nowrap text-text-primary sm:text-right">
          {valor}
          {unidad ? <span className="ml-xs text-sm font-regular text-text-secondary">{unidad}</span> : null}
        </p>
      </div>
      {marcas ? (
        <div className="mt-sm flex flex-wrap items-center gap-x-sm gap-y-xs text-sm text-text-secondary">{marcas}</div>
      ) : null}
      {historial ? <div className="mt-sm flex flex-col items-start gap-xs">{historial}</div> : null}
      {acciones ? <div className="mt-sm flex flex-wrap items-start gap-sm">{acciones}</div> : null}
    </article>
  );
}

/**
 * Un renglón de origen dentro de las marcas: «Rige desde el 01/10/2026», «en la configuración
 * general: 3 %». Es texto, no un chip: los chips son estados, esto es la explicación.
 */
export function TextoDeOrigen({ children }: { readonly children: ReactNode }) {
  return <span className="text-sm text-text-secondary">{children}</span>;
}

/** Un valor o una fecha dentro de un texto de origen: en la tipografía de las cifras. */
export function DatoEnLinea({ children }: { readonly children: ReactNode }) {
  return <span className="font-ab-numeric font-semibold text-text-primary">{children}</span>;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lo que se abre para editar
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un botón que **abre lo que tiene debajo**, sin JavaScript: `<details>` nativo con el `<summary>`
 * vestido de botón. Lo mismo que `PanelDesplegable` y por el mismo motivo —el pedido de confirmación
 * vive adentro del formulario y un diálogo lo degradaría—, pero chico, porque hay varios por
 * parámetro. Abierto ocupa todo el ancho de la fila; nunca se cierra solo.
 */
export function AccionDesplegable({
  texto,
  variante = "sutil",
  children,
}: {
  readonly texto: ReactNode;
  readonly variante?: VarianteBoton;
  readonly children: ReactNode;
}) {
  return (
    <details data-admin-barrios-ui className="group open:basis-full">
      <summary
        className={[
          clasesDeBoton({ variante, tamano: "sm" }),
          "w-fit list-none marker:content-none [&::-webkit-details-marker]:hidden",
        ].join(" ")}
      >
        {texto}
        <IconoChevron className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-sm rounded-md border border-dashed border-border-strong bg-bg px-base py-base">{children}</div>
    </details>
  );
}

/**
 * A quién alcanza el cambio, **antes** de guardarlo. Es la pregunta que el administrador se hace con
 * el dedo sobre el botón —«¿esto cambia en todos los barrios?»— y la respuesta la arma la pantalla
 * con lo que leyó de la base, no este componente.
 */
export function BloqueDeImpacto({ children }: { readonly children: ReactNode }) {
  return (
    <p
      data-admin-barrios-ui
      className="rounded-md border border-info/45 border-l-4 border-l-info bg-info-subtle px-base py-sm text-sm text-text-primary"
    >
      <span className="font-semibold">A quién alcanza: </span>
      {children}
    </p>
  );
}

/**
 * Dos o tres opciones cortas que se ven todas a la vez, con cara de botón segmentado («Sí» / «No»).
 *
 * Por dentro son **radios nativos**: el grupo se nombra con `<fieldset>` + `<legend>`, las flechas
 * navegan, y el valor viaja en el `FormData` sin una línea de JavaScript. La opción elegida se marca
 * con fondo, peso **y** un tilde — nunca solo con el color.
 *
 * Son **no controlados** (`defaultChecked`). Si quien lo usa necesita que vuelva con lo que devolvió
 * la acción después de un `form.reset()`, le pasa un `key` nuevo por intento: el kit no puede
 * escuchar el formulario porque es de servidor.
 */
export function Segmentado({
  id,
  nombre,
  etiqueta,
  opciones,
  valorInicial,
  requerido,
  ayuda,
  error,
}: {
  /** Base de los `id` de la ayuda y del error. Lo da la isla (`useId`). */
  readonly id: string;
  readonly nombre: string;
  readonly etiqueta: ReactNode;
  readonly opciones: readonly { readonly valor: string; readonly texto: string }[];
  readonly valorInicial?: string | undefined;
  readonly requerido?: boolean;
  readonly ayuda?: ReactNode;
  readonly error?: string | undefined;
}) {
  const idAyuda = ayuda ? `${id}-ayuda` : undefined;
  const idError = error ? `${id}-error` : undefined;
  const describe = [idAyuda, idError].filter(Boolean).join(" ") || undefined;
  return (
    <fieldset data-admin-barrios-ui id={id} aria-describedby={describe} className="m-none flex flex-col gap-xs border-0 p-none">
      <legend className="mb-xs p-none text-sm font-medium text-text-primary">
        {etiqueta}
        {requerido ? (
          <span className="ml-xs text-danger">
            <span aria-hidden>*</span>
            <span className="sr-only"> (obligatorio)</span>
          </span>
        ) : null}
      </legend>
      <div
        className={[
          "inline-flex w-fit overflow-hidden rounded-sm border",
          error ? "border-danger" : "border-border-strong",
        ].join(" ")}
      >
        {opciones.map((o) => (
          <label key={o.valor} className="group relative border-l border-border-strong first:border-l-0">
            <input
              type="radio"
              name={nombre}
              value={o.valor}
              defaultChecked={valorInicial === o.valor}
              required={requerido}
              aria-invalid={error ? true : undefined}
              className="peer sr-only"
            />
            <span
              className={[
                "flex min-h-control-base cursor-pointer items-center gap-xs bg-surface px-lg text-sm text-text-secondary transition-colors",
                "peer-checked:bg-marca-aa peer-checked:font-semibold peer-checked:text-primary-fg",
                "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-focus-ring",
              ].join(" ")}
            >
              <IconoCheck className="hidden shrink-0 group-has-checked:inline-block" />
              {o.texto}
            </span>
          </label>
        ))}
      </div>
      {ayuda ? (
        <p id={idAyuda} className="text-xs text-text-secondary">
          {ayuda}
        </p>
      ) : null}
      {error ? (
        <p id={idError} className="border-l-2 border-danger pl-sm text-sm text-text-primary">
          <span className="sr-only">Error: </span>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
