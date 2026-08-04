"use client";

/**
 * La navegación entre los frentes de un período, visible en las cuatro pantallas de trabajo.
 *
 * **Qué hace, y qué dejó de hacer.** Hace una sola cosa: decir a dónde se puede ir y marcar dónde
 * estás. **Cómo viene el mes ya no lo dice** —eso es la ficha de cierre, y vive solo en el resumen—.
 * Antes hacía las dos cosas y por eso el mismo componente aparecía como recorrido numerado en las
 * pantallas de trabajo y como tablero de estado en el resumen. El usuario lo marcó apenas se rehízo
 * el resumen: dos idiomas para lo mismo, en el mismo flujo.
 *
 * Es de cliente por una razón concreta del App Router: el `layout.tsx` del barrio **no se vuelve a
 * renderizar** al navegar entre sus páginas hijas, así que un activo calculado en el servidor
 * quedaría marcando la pantalla de la que se vino. `usePathname()` es lo único que resuelve acá.
 *
 * **La vuelta a Liquidación vive en `BarraDeVuelta`**, que está en las cinco pantallas —incluido el
 * resumen, que ya no dibuja esta barra— (observación A-1). Escrita una vez: si mañana nace una sexta
 * pantalla del período, nace con la salida puesta.
 */

import { usePathname } from "next/navigation";
import { BarraDeAcciones, BarraDeFrentes, Boton, FrenteEnBarra, IconoFlecha } from "@admin-barrios/ui";

const FRENTES = [
  { segmento: "gastos", texto: "Gastos del mes" },
  { segmento: "cargos", texto: "Cargos y descuentos" },
  { segmento: "revision", texto: "Revisar y emitir" },
  { segmento: "documentos", texto: "Documentos" },
] as const;

/**
 * La vuelta explícita, sola.
 *
 * Vive aparte porque el **resumen** no dibuja la barra de frentes —ahí manda la ficha de cierre— pero
 * sí necesita la salida. Sin esto, la única pantalla que se rehízo habría perdido la observación A-1,
 * que es justo la que costó encontrar.
 */
export function BarraDeVuelta({
  barrioId,
  periodoId,
}: {
  readonly barrioId: string;
  readonly periodoId: string;
}) {
  const ruta = usePathname();
  const base = `/${barrioId}/liquidacion/${periodoId}`;

  return (
    <BarraDeAcciones>
      <Boton
        href={`/${barrioId}/liquidacion`}
        variante="sutil"
        tamano="sm"
        icono={<IconoFlecha direccion="izquierda" />}
      >
        Volver a Liquidación
      </Boton>
      {ruta === base ? null : (
        <Boton href={base} variante="sutil" tamano="sm">
          Resumen del mes
        </Boton>
      )}
    </BarraDeAcciones>
  );
}

export function FrentesDelPeriodo({
  barrioId,
  periodoId,
}: {
  readonly barrioId: string;
  readonly periodoId: string;
}) {
  const ruta = usePathname();
  const base = `/${barrioId}/liquidacion/${periodoId}`;

  return (
    <>
      <BarraDeVuelta barrioId={barrioId} periodoId={periodoId} />
      <BarraDeFrentes etiqueta="Secciones del período">
        {FRENTES.map(({ segmento, texto }) => {
          const href = `${base}/${segmento}`;
          return (
            <FrenteEnBarra key={segmento} href={href} activo={ruta === href} titulo={texto} />
          );
        })}
      </BarraDeFrentes>
    </>
  );
}
