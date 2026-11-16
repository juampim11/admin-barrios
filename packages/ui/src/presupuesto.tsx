/**
 * Las piezas del presupuesto y del resultado del mes (encargo 16c), portadas de la maqueta aprobada
 * `devengado-conceptos.html`, pantallas 3, 6 y 7: las dos columnas del presupuesto (la tabla y el
 * panel del importe), la barra de avance de «Gastos contra presupuesto» y las tarjetas de «Resultado
 * del mes».
 *
 * Son de servidor y no traen datos: reciben lo que la pantalla ya leyó, con las cifras ya formateadas
 * por `@admin-barrios/shared/dinero`. Ninguna calcula plata: la barra recibe el porcentaje que dio el
 * servicio, y la tarjeta, el signo que ya resolvió la pantalla.
 */

import type { ReactNode } from "react";

// ── Dos columnas: lo principal y un panel al costado ──────────────────────────────────────────────

/**
 * La maqueta pone la tabla del presupuesto a la izquierda (1,6 partes) y el panel «Importe del mes» a
 * la derecha (1 parte). En angosto, uno abajo del otro.
 */
export function DosColumnas({ principal, lateral }: { readonly principal: ReactNode; readonly lateral?: ReactNode }) {
  if (!lateral) return <div data-admin-barrios-ui className="mb-base">{principal}</div>;
  return (
    <div
      data-admin-barrios-ui
      className="mb-base grid grid-cols-1 items-start gap-base lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"
    >
      <div className="min-w-0">{principal}</div>
      <div className="min-w-0">{lateral}</div>
    </div>
  );
}

// ── La barra de avance de un rubro ────────────────────────────────────────────────────────────────

/**
 * Cuánto se gastó de lo presupuestado. La barra llega como mucho al 100 %; pasado eso se pinta de
 * peligro (el número exacto está en la columna «Diferencia»). Sin presupuesto no hay barra.
 *
 * Para quien no ve la barra, el porcentaje se dice en palabras.
 */
export function BarraDeAvance({ avance, excedido }: { readonly avance: number | null; readonly excedido: boolean }) {
  if (avance === null) return <span className="text-sm text-text-muted">—</span>;
  const lleno = Math.max(0, Math.min(100, avance));
  return (
    <span className="block min-w-[5.5rem]">
      <span className="sr-only">{`${avance} % de lo presupuestado`}</span>
      <span
        aria-hidden
        className="mt-xs block h-1.5 overflow-hidden rounded-pill bg-[color-mix(in_srgb,var(--text-muted)_18%,transparent)]"
      >
        <span className={`block h-full ${excedido ? "bg-danger" : "bg-primary"}`} style={{ width: `${lleno}%` }} />
      </span>
    </span>
  );
}

/** Un importe escrito con su signo («− $ 270.000,00»), en peligro cuando es negativo. */
export function ImporteConSigno({ texto, negativo }: { readonly texto: ReactNode; readonly negativo: boolean }) {
  return <span className={`font-ab-numeric tabular-nums ${negativo ? "text-danger" : ""}`}>{texto}</span>;
}

// ── Las tarjetas del resultado del mes ────────────────────────────────────────────────────────────

export function TarjetasDelResultado({ etiqueta, children }: { readonly etiqueta: string; readonly children: ReactNode }) {
  return (
    <section
      data-admin-barrios-ui
      aria-label={etiqueta}
      className="mb-base grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-sm"
    >
      {children}
    </section>
  );
}

/**
 * Una tarjeta: el título, los renglones de la cuenta, el resultado grande y su lectura en palabras
 * («Se pidió más de lo que se gastó»). `pie` es para el enlace («5 unidades · Ver en Cobros»).
 */
export function TarjetaDelResultado({
  titulo,
  children,
  resultado,
  negativo,
  lectura,
}: {
  readonly titulo: ReactNode;
  /** Los renglones de la cuenta (`RenglonDelResultado`). */
  readonly children?: ReactNode;
  /** El número grande, ya formateado. */
  readonly resultado: ReactNode;
  readonly negativo?: boolean;
  /** Qué quiere decir el número, en palabras, y de dónde sale. */
  readonly lectura: ReactNode;
}) {
  return (
    <article className="flex flex-col rounded-xl border border-border bg-surface p-base shadow-sm">
      <h2 className="mb-sm text-lg font-semibold text-text-primary">{titulo}</h2>
      {children ? <dl className="m-0 flex flex-col">{children}</dl> : null}
      <p
        className={`mb-xs mt-sm font-ab-numeric text-xl font-semibold tabular-nums ${negativo ? "text-danger" : "text-text-primary"}`}
      >
        {resultado}
      </p>
      <div className="text-sm text-text-secondary">{lectura}</div>
    </article>
  );
}

/** Un renglón de la cuenta: «Devengado $ 8.760.000,00», con su origen en letra chica abajo. */
export function RenglonDelResultado({
  etiqueta,
  valor,
  origen,
}: {
  readonly etiqueta: ReactNode;
  readonly valor: ReactNode;
  /** De dónde sale la cifra (regla 4 de `CLAUDE.md`). */
  readonly origen?: ReactNode;
}) {
  return (
    <div className="border-b border-dashed border-border py-xs last:border-b-0">
      <div className="flex items-baseline justify-between gap-sm text-sm">
        <dt className="text-text-secondary">{etiqueta}</dt>
        <dd className="m-0 whitespace-nowrap font-ab-numeric tabular-nums text-text-primary">{valor}</dd>
      </div>
      {origen ? <p className="m-0 text-xs text-text-muted">{origen}</p> : null}
    </div>
  );
}
