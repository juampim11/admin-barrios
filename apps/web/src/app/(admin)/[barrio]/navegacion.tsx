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
import { ItemDeSeccion, IconoLiquidacion, IconoPadron, IconoTablero } from "@admin-barrios/ui";

const SECCIONES = [
  { segmento: "tablero", texto: "Tablero", icono: <IconoTablero /> },
  { segmento: "padron", texto: "Padrón", icono: <IconoPadron /> },
  { segmento: "liquidacion", texto: "Liquidación", icono: <IconoLiquidacion /> },
] as const;

export function NavegacionDelBarrio({ barrioId }: { readonly barrioId: string }) {
  const ruta = usePathname();

  return (
    <>
      {SECCIONES.map(({ segmento, texto, icono }) => {
        const href = `/${barrioId}/${segmento}`;
        return (
          <ItemDeSeccion
            key={segmento}
            href={href}
            activo={ruta === href || ruta.startsWith(`${href}/`)}
            icono={icono}
          >
            {texto}
          </ItemDeSeccion>
        );
      })}
    </>
  );
}
