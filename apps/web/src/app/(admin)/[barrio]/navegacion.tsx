"use client";

/**
 * Las secciones del barrio en la barra lateral.
 *
 * Existe por una razón concreta del App Router: el `layout.tsx` del barrio **no se vuelve a
 * renderizar** al navegar entre sus páginas hijas, así que un ítem activo calculado en el servidor
 * quedaría marcando la pantalla de la que se vino. `usePathname()` es lo que hace que la marca
 * corresponda a dónde se está. Es lo único que hace este archivo: **quién está activo**.
 *
 * Cómo se ve un ítem lo decide `packages/ui`; acá no hay una sola clase ni un solo color. Y no
 * importa nada de `servidor/*` —no podría: `server-only` haría fallar el build— ni toca datos.
 *
 * **La lista es la de las secciones que existen.** El día que haya Cobros o Conciliación, se agrega
 * una línea acá. Mostrarlas antes sería un menú lleno de promesas que la aplicación no puede cumplir
 * (doc 06 §c.6.4).
 */

import { usePathname } from "next/navigation";
import {
  ItemDeSeccion,
  IconoAdministracion,
  IconoAjustes,
  IconoCobros,
  IconoLiquidacion,
  IconoOrdenesPago,
  IconoPadron,
  IconoTablero,
  SeparadorDeSecciones,
} from "@admin-barrios/ui";

const SECCIONES = [
  { segmento: "tablero", texto: "Tablero", icono: <IconoTablero /> },
  { segmento: "padron", texto: "Padrón", icono: <IconoPadron /> },
  { segmento: "liquidacion", texto: "Liquidación", icono: <IconoLiquidacion /> },
  { segmento: "cobros", texto: "Cobros", icono: <IconoCobros /> },
  // Sin entrada propia para "Proveedores": se llega desde acá, mismo criterio que `cobros/nuevo`.
  { segmento: "ordenes-pago", texto: "Órdenes de pago", icono: <IconoOrdenesPago /> },
  { segmento: "configuracion", texto: "Configuración del barrio", icono: <IconoAjustes /> },
] as const;

/**
 * La configuración general **no es una sección del barrio**: es de la administración y alcanza a
 * todos sus barrios. Va separada por una línea y con su alcance escrito abajo, y vive en una ruta
 * hija de la del barrio (`configuracion/general`) solo porque se navega desde la barra del barrio.
 * Por eso el activo de «Configuración del barrio» no puede ser "todo lo que empiece con
 * `configuracion/`": las dos quedarían marcadas a la vez.
 */
const GENERAL = "configuracion/general";

export function NavegacionDelBarrio({ barrioId }: { readonly barrioId: string }) {
  const ruta = usePathname();

  const general = `/${barrioId}/${GENERAL}`;
  const enGeneral = ruta === general || ruta.startsWith(`${general}/`);

  return (
    <>
      {SECCIONES.map(({ segmento, texto, icono }) => {
        const href = `/${barrioId}/${segmento}`;
        return (
          <ItemDeSeccion
            key={segmento}
            href={href}
            activo={!enGeneral && (ruta === href || ruta.startsWith(`${href}/`))}
            icono={icono}
          >
            {texto}
          </ItemDeSeccion>
        );
      })}
      <SeparadorDeSecciones />
      <ItemDeSeccion href={general} activo={enGeneral} icono={<IconoAdministracion />} subtitulo="todos los barrios">
        Configuración general
      </ItemDeSeccion>
    </>
  );
}
