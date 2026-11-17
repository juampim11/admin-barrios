"use client";

/**
 * **Una fecha adentro de una celda de tabla** (encargo P2a-2, el cronograma de un plan a medida): el
 * selector de fecha del navegador, con el rótulo escondido a la vista y presente para el lector de
 * pantalla, igual que `ImporteEnCelda`. En la tabla el rótulo visible es el encabezado de la columna.
 *
 * Controlada: la fila es estado de la isla (no viaja por su `name`; la tabla manda el cronograma
 * entero). El formato que se ve lo pone el navegador; el valor es siempre `AAAA-MM-DD`.
 */

import { useId } from "react";

export function FechaEnCelda({
  rotulo,
  valor,
  minimo,
  invalido,
  alCambiar,
}: {
  /** El nombre accesible: «Vencimiento de la cuota 3». */
  readonly rotulo: string;
  /** `AAAA-MM-DD`, o vacío. */
  readonly valor: string;
  readonly minimo?: string | undefined;
  readonly invalido?: boolean | undefined;
  readonly alCambiar: (valor: string) => void;
}) {
  const id = useId();
  return (
    <span data-admin-barrios-ui className="block w-full min-w-[9rem] max-w-[11rem]">
      <label htmlFor={id} className="sr-only">
        {rotulo}
      </label>
      <input
        id={id}
        type="date"
        value={valor}
        min={minimo}
        aria-invalid={invalido || undefined}
        onChange={(e) => alCambiar(e.currentTarget.value)}
        className={[
          "min-h-control-base w-full rounded-sm bg-surface px-md py-sm font-ab-numeric text-sm tabular-nums text-text-primary",
          invalido ? "border-2 border-danger" : "border border-border-strong hover:border-primary",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
        ].join(" ")}
      />
    </span>
  );
}
