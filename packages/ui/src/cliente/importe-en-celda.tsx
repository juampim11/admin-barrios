"use client";

/**
 * **Un importe adentro de una celda de tabla** (encargo 16c, «Presupuesto del mes»): el mismo
 * `EntradaDeImporte` de siempre, con el rótulo escondido a la vista y presente para el lector de
 * pantalla. En una tabla el rótulo visible es el encabezado de la columna y el nombre de la fila;
 * repetirlo arriba de cada campo rompería la grilla de la maqueta.
 *
 * No agrega ni una regla de formato: todo lo del importe lo decide `EntradaDeImporte`.
 */

import { useId } from "react";
import { EntradaDeImporte } from "./entrada-de-importe.tsx";

export function ImporteEnCelda({
  rotulo,
  nombre,
  valorInicial,
  invalido,
  descritoPor,
  alCambiar,
}: {
  /** El nombre accesible: «Presupuesto de diciembre para Vigilancia». */
  readonly rotulo: string;
  readonly nombre: string;
  readonly valorInicial?: string | undefined;
  readonly invalido?: boolean | undefined;
  readonly descritoPor?: string | undefined;
  readonly alCambiar?: ((canonico: string) => void) | undefined;
}) {
  const id = useId();
  return (
    <span className="block w-full min-w-[9rem] max-w-[12rem]">
      <label htmlFor={id} className="sr-only">
        {rotulo}
      </label>
      <EntradaDeImporte
        id={id}
        nombre={nombre}
        valorInicial={valorInicial}
        invalido={invalido}
        descritoPor={descritoPor}
        alCambiar={alCambiar}
      />
    </span>
  );
}
