/**
 * La fila de cifras: los números que resumen una pantalla, cada uno en su caja (`.kpis`/`.kpi` de
 * las maquetas aprobadas). Valor grande en monoespaciada, etiqueta chica en muted debajo.
 *
 * **Componente de servidor.** No formatea nada: el valor llega ya escrito por la pantalla
 * (`formatearMonto`, un entero, `<Cifra>`), porque el kit no formatea (UI-6).
 *
 * **`origen` es parte de la firma a propósito.** La regla dura del proyecto es que ninguna cifra va
 * suelta; las maquetas no muestran ese renglón, pero las pantallas ya lo tenían ("de 50 unidades
 * del barrio") y sacarlo sería perder trazabilidad. Va en muted y más chico que la etiqueta.
 *
 * Semántica: `<dl>`, con `dt` (la etiqueta) antes que `dd` (el valor) como pide HTML; el orden
 * visual (valor arriba) lo da `flex-col-reverse`, así un lector de pantalla lee "Barrios: 5".
 */

import type { ReactNode } from "react";

export function FilaDeCifras({ children }: { readonly children: ReactNode }) {
  return (
    <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-md">{children}</dl>
  );
}

export function CifraDeLaFila({
  etiqueta,
  origen,
  children,
}: {
  readonly etiqueta: ReactNode;
  readonly origen?: ReactNode;
  /** El valor, ya formateado por la pantalla. */
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col-reverse justify-end gap-xs rounded-md border border-border bg-surface p-md">
      <dt className="text-sm text-text-muted">
        {etiqueta}
        {origen ? <span className="block text-xs text-text-muted">{origen}</span> : null}
      </dt>
      <dd className="m-0 font-ab-mono text-2xl font-semibold leading-tight text-text-primary">{children}</dd>
    </div>
  );
}
