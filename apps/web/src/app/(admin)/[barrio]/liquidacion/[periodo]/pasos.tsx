"use client";

/**
 * El recorrido del período, visible en las cinco pantallas que lo componen.
 *
 * **Por qué esto existe y no alcanza con las secciones del barrio.** Liquidar un mes no es navegar:
 * es una secuencia con orden —cargar los gastos, aplicar los cargos, revisar, emitir— donde el paso
 * siguiente solo tiene sentido si el anterior está hecho. Sin la secuencia dibujada, la persona tiene
 * que reconstruirla de memoria cada mes, y el primer síntoma de que no la reconstruyó bien es un
 * período emitido al que le faltaba un gasto.
 *
 * Es de cliente por la misma razón que `navegacion.tsx`: el layout del barrio no se vuelve a
 * renderizar al navegar entre sus hijas, así que un paso activo calculado en el servidor quedaría
 * marcando la pantalla de la que se vino. `usePathname()` es lo que hace que la marca corresponda a
 * dónde se está. **Es lo único que este archivo decide**: cómo se ve un paso vive en `packages/ui`.
 *
 * **La vuelta a Liquidación vive acá, y por eso está en las cinco pantallas** (observación A-1 del
 * recorrido: *"se sale por la solapa de arriba, que no se lee como volver"*). Escrita una vez, en el
 * único componente que las cinco comparten: si mañana nace una sexta pantalla del período, nace con
 * la salida puesta.
 *
 * **El resumen no es el paso 5: es la casa del período** (observación A-3 + doc 06 §c.6.5). Entrar a
 * un mes cae en "cómo viene", no en una pantalla de carga; los cuatro pasos numerados son el trabajo.
 *
 * **Qué pasos están hechos lo dice el período, no esta pantalla.** `hechos` llega como prop desde el
 * servidor, que es quien leyó los gastos y las liquidaciones. Acá no se deduce nada del negocio.
 */

import { usePathname } from "next/navigation";
import { BarraDeAcciones, Boton, IconoFlecha, Paso, Pasos } from "@admin-barrios/ui";
import type { PasoDelPeriodo } from "@admin-barrios/shared/liquidacion";

const PASOS = [
  { segmento: "gastos", texto: "Gastos del mes", detalle: "qué se gastó" },
  { segmento: "cargos", texto: "Cargos y descuentos", detalle: "por unidad" },
  { segmento: "revision", texto: "Revisar y emitir", detalle: "cómo queda cada boleta" },
  { segmento: "documentos", texto: "Documentos", detalle: "generar y descargar" },
] as const;

export function PasosDelPeriodo({
  barrioId,
  periodoId,
  hechos = [],
}: {
  readonly barrioId: string;
  readonly periodoId: string;
  /** Los pasos que ya no tienen trabajo pendiente. Lo resuelve el servidor. */
  readonly hechos?: readonly PasoDelPeriodo[];
}) {
  const ruta = usePathname();
  const base = `/${barrioId}/liquidacion/${periodoId}`;
  const enElResumen = ruta === base;

  return (
    <>
      <BarraDeAcciones>
        <Boton
          href={`/${barrioId}/liquidacion`}
          variante="sutil"
          tamano="sm"
          icono={<IconoFlecha direccion="izquierda" />}
        >
          Volver a Liquidación
        </Boton>
        {enElResumen ? null : (
          <Boton href={base} variante="sutil" tamano="sm">
            Resumen del mes
          </Boton>
        )}
      </BarraDeAcciones>
      <Pasos etiqueta="Pasos de la liquidación del período">
        {PASOS.map(({ segmento, texto, detalle }, i) => {
          const href = `${base}/${segmento}`;
          return (
            <Paso
              key={segmento}
              href={href}
              numero={i + 1}
              estado={ruta === href ? "activo" : hechos.includes(segmento) ? "hecho" : "pendiente"}
              titulo={texto}
              detalle={detalle}
              ultimo={i === PASOS.length - 1}
            />
          );
        })}
      </Pasos>
    </>
  );
}
