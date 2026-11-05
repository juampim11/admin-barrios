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
  IconoProveedores,
  IconoTablero,
  SeparadorDeSecciones,
} from "@admin-barrios/ui";

const SECCIONES = [
  { segmento: "tablero", texto: "Tablero", icono: <IconoTablero /> },
  { segmento: "padron", texto: "Padrón", icono: <IconoPadron /> },
  { segmento: "liquidacion", texto: "Liquidación", icono: <IconoLiquidacion /> },
  { segmento: "cobros", texto: "Cobros", icono: <IconoCobros /> },
  { segmento: "ordenes-pago", texto: "Órdenes de pago", icono: <IconoOrdenesPago /> },
  // Junto a «Órdenes de pago», que es desde donde se usa el catálogo (encargo 8, T1 §5).
  { segmento: "proveedores", texto: "Proveedores", icono: <IconoProveedores /> },
  { segmento: "configuracion", texto: "Configuración del barrio", icono: <IconoAjustes /> },
] as const;

/**
 * La configuración general **no es una sección del barrio**: es de la administración y alcanza a
 * todos sus barrios. Va separada por una línea y con su alcance escrito abajo, y vive fuera de todo
 * barrio, en `/configuracion` (encargo 8, T1 §4). El enlace pasa por `/configuracion/desde/{barrio}`,
 * que recuerda este barrio para volver a él al salir.
 *
 * En `/configuracion` esta misma lista se muestra con las secciones del último barrio visitado: el
 * activo de las secciones sale de comparar contra `/{barrio}/…`, así que ahí ninguna queda marcada.
 *
 * Las dos rutas de la configuración general llegan como props y no importando `rutas.ts`: ese módulo
 * arrastra el esquema de ids (Zod), y esto es una isla de cliente — sería payload para nada.
 */
export function NavegacionDelBarrio({
  barrioId,
  rutaGeneral,
  hrefGeneral,
  rutaLiquidacionActual,
}: {
  readonly barrioId: string;
  /**
   * `/liquidacion-actual`: el mes en todos los barrios. Sigue a la vista dentro de un barrio (ensayo de
   * T2: el titular lo perdía al entrar a uno), como la configuración general, debajo de la línea.
   */
  readonly rutaLiquidacionActual: string;
  /** `/configuracion`: dónde vive la configuración general (marca el ítem activo). */
  readonly rutaGeneral: string;
  /** `/configuracion/desde/{barrio}`: el enlace del ítem. */
  readonly hrefGeneral: string;
}) {
  const ruta = usePathname();

  const enGeneral = ruta === rutaGeneral || ruta.startsWith(`${rutaGeneral}/`);

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
      <ItemDeSeccion href={rutaLiquidacionActual} activo={false} icono={<IconoLiquidacion />} subtitulo="todos los barrios">
        Liquidación actual
      </ItemDeSeccion>
      <ItemDeSeccion href={hrefGeneral} activo={enGeneral} icono={<IconoAdministracion />} subtitulo="todos los barrios">
        Configuración general
      </ItemDeSeccion>
    </>
  );
}
