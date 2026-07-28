"use client";

/**
 * El recorrido del período, visible en las cuatro pantallas que lo componen.
 *
 * **Por qué esto existe y no alcanza con las solapas del barrio.** Liquidar un mes no es navegar: es
 * una secuencia con orden —cargar los gastos, aplicar los cargos, revisar, emitir— donde el paso
 * siguiente solo tiene sentido si el anterior está hecho. Sin la secuencia dibujada, la persona tiene
 * que reconstruirla de memoria cada mes, y el primer síntoma de que no la reconstruyó bien es un
 * período emitido al que le faltaba un gasto.
 *
 * Es de cliente por la misma razón que `navegacion.tsx`: el layout del barrio no se vuelve a
 * renderizar al navegar entre sus hijas, así que un paso activo calculado en el servidor quedaría
 * marcando la pantalla de la que se vino. `usePathname()` es lo que hace que la marca corresponda a
 * dónde se está.
 *
 * Tres señales para el paso activo, nunca solo el color (doc 06 §f.2): fondo, número en negativo y
 * `aria-current="step"`. Y la numeración es texto de verdad, no un `::before` decorativo — un lector
 * de pantalla anuncia "paso 2 de 4".
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import estilos from "./pasos.module.css";

const PASOS = [
  { segmento: "gastos", texto: "Gastos del mes", detalle: "qué se gastó" },
  { segmento: "cargos", texto: "Cargos y descuentos", detalle: "por unidad" },
  { segmento: "revision", texto: "Revisar y emitir", detalle: "cómo queda cada boleta" },
  { segmento: "", texto: "Resumen", detalle: "las cifras del mes" },
] as const;

export function PasosDelPeriodo({
  barrioId,
  periodoId,
}: {
  readonly barrioId: string;
  readonly periodoId: string;
}) {
  const ruta = usePathname();
  const base = `/${barrioId}/liquidacion/${periodoId}`;

  return (
    <nav className={estilos.pasos} aria-label="Pasos de la liquidación del período">
      <ol className={estilos.lista}>
        {PASOS.map(({ segmento, texto, detalle }, i) => {
          const href = segmento === "" ? base : `${base}/${segmento}`;
          const activo = ruta === href;
          return (
            <li key={texto}>
              <Link
                href={href}
                className={activo ? `${estilos.paso} ${estilos.pasoActivo}` : estilos.paso}
                aria-current={activo ? "step" : undefined}
              >
                <span className={estilos.numero}>{i + 1}</span>
                <span className={estilos.textos}>
                  <span className={estilos.nombre}>{texto}</span>
                  <span className={estilos.detalle}>{detalle}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
