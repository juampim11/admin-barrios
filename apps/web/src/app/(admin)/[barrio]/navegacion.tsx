"use client";

/**
 * Las solapas del barrio. **El único componente de cliente de toda la tanda**, y son diez líneas.
 *
 * Existe por una razón concreta del App Router: el `layout.tsx` del barrio **no se vuelve a
 * renderizar** al navegar entre sus páginas hijas, así que una solapa activa calculada en el
 * servidor quedaría marcando la pantalla de la que se vino. `usePathname()` es lo que hace que la
 * marca corresponda a dónde se está.
 *
 * No importa nada de `servidor/*` —no podría: `server-only` haría fallar el build— ni toca datos.
 * Recibe el id del barrio y arma links.
 *
 * La solapa activa se marca con **tres** señales: color, borde inferior y `aria-current="page"`. El
 * color solo no alcanza (doc 06 §f.2), y `aria-current` es lo que la anuncia a un lector de pantalla.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import estilos from "../admin.module.css";

const SOLAPAS = [
  { segmento: "tablero", texto: "Tablero" },
  { segmento: "padron", texto: "Padrón" },
  { segmento: "liquidacion", texto: "Liquidación" },
] as const;

export function NavegacionDelBarrio({ barrioId }: { readonly barrioId: string }) {
  const ruta = usePathname();

  return (
    <nav className={estilos.navegacion} aria-label="Secciones del barrio">
      {SOLAPAS.map(({ segmento, texto }) => {
        const href = `/${barrioId}/${segmento}`;
        const activa = ruta === href || ruta.startsWith(`${href}/`);
        return (
          <Link
            key={segmento}
            href={href}
            className={activa ? `${estilos.solapa} ${estilos.solapaActiva}` : estilos.solapa}
            aria-current={activa ? "page" : undefined}
          >
            {texto}
          </Link>
        );
      })}
    </nav>
  );
}
