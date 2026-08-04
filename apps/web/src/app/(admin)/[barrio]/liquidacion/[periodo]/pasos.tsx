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
 *
 * **La vuelta a Liquidación vive acá, y por eso está en las cinco pantallas** (observación A-1 del
 * recorrido: *"se sale por la solapa de arriba, que no se lee como volver"*). Escrita una vez, en el
 * único componente que las cinco comparten: si mañana nace una sexta pantalla del período, nace con
 * la salida puesta. Es un `<a>` del kit y no un `<Link>` porque el botón vive en `packages/ui`, que
 * no alcanza Next (cerrojo UI-2) — y estas pantallas se renderizan enteras en el servidor, así que
 * la diferencia no se ve.
 *
 * **El resumen ya no es el paso 5: es la casa del período** (observación A-3 + doc 06 §c.6.5). Entrar
 * a un mes cae en "cómo viene", no en una pantalla de carga; los cuatro pasos numerados son el
 * trabajo, y se llega a ellos desde el resumen. Numerar el resumen como último paso era el mismo
 * error que la observación describe, dibujado: el orden del motor, no el de la persona.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarraDeAcciones, Boton, IconoFlecha } from "@admin-barrios/ui";
import estilos from "./pasos.module.css";

const PASOS = [
  { segmento: "gastos", texto: "Gastos del mes", detalle: "qué se gastó" },
  { segmento: "cargos", texto: "Cargos y descuentos", detalle: "por unidad" },
  { segmento: "revision", texto: "Revisar y emitir", detalle: "cómo queda cada boleta" },
  { segmento: "documentos", texto: "Documentos", detalle: "generar y descargar" },
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
      <nav className={estilos.pasos} aria-label="Pasos de la liquidación del período">
        <ol className={estilos.lista}>
          {PASOS.map(({ segmento, texto, detalle }, i) => {
            const href = `${base}/${segmento}`;
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
    </>
  );
}
