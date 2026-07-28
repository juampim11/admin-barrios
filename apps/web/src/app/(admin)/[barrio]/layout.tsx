import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { acentoBarrio } from "@admin-barrios/design-tokens/barrio-accent";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { Chip } from "../../../componentes/ui.tsx";
import { IconoFlecha } from "../../../componentes/iconos.tsx";
import { etiquetaFiguraCorta, ROL } from "../../../componentes/etiquetas.tsx";
import { esIdValido } from "../../../rutas.ts";
import { conSesion } from "../../../servidor/db.ts";
import { NavegacionDelBarrio } from "./navegacion.tsx";
import estilos from "../admin.module.css";

/**
 * La cabecera que acompaña a **todas** las pantallas de un barrio.
 *
 * Dos cosas que no son cosméticas:
 *
 * **1. El uuid de la URL no autoriza nada** (ADR-0002 §3.4, que corrige la nota `[fe]` del doc 06
 * §c.1). Dice qué barrio mirar. Si el usuario no lo puede leer, `leerBarrio` devuelve `null` porque
 * la policy no devolvió filas, y acá se hace `notFound()` — **afuera** de la transacción, que ya
 * cerró: `notFound()` funciona lanzando y adentro dispararía un `ROLLBACK`.
 *
 * **2. "No existe" y "no tenés acceso" se ven igual, a propósito.** Si se distinguieran, el uuid de
 * un barrio ajeno sería un oráculo de existencia.
 *
 * Y el refuerzo de aislamiento del doc 06 §c.5: nombre y figura jurídica **sin scroll** en el 100 %
 * de las pantallas, más el punto y la franja de acento determinístico del barrio.
 */
export default async function LayoutDelBarrio({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  // `/{barrio}` es el segmento dinámico de primer nivel: le cae todo lo que no matchee otra ruta,
  // empezando por `/favicon.ico`. Sin esto, ese pedido llega al `parse()` de Zod del servicio y sale
  // un 500 en vez de un 404. No autoriza nada: ver `rutas.ts`.
  if (!esIdValido(barrioId)) notFound();

  const barrio = await conSesion((tx) => leerBarrio(tx, { barrioId }));
  if (!barrio) notFound();

  const acento = {
    "--acento-claro": acentoBarrio(barrio.id, "light"),
    "--acento-oscuro": acentoBarrio(barrio.id, "dark"),
  } as CSSProperties;

  return (
    <>
      <div className={estilos.cabeceraBarrio} style={acento}>
        <div className={estilos.identidadBarrio}>
          <Link href="/" className={estilos.volver}>
            <span aria-hidden style={{ transform: "rotate(180deg)", display: "inline-flex" }}>
              <IconoFlecha direccion="derecha" />
            </span>
            Mis barrios
          </Link>
          <h2 className={estilos.nombreBarrio}>
            <span className={estilos.puntoBarrio} aria-hidden />
            {barrio.nombre}
          </h2>
          <div className={estilos.datosBarrio}>
            <Chip tono="neutro">{etiquetaFiguraCorta(barrio.figuraJuridica)}</Chip>
            {barrio.roles.map((rol) => (
              <Chip key={rol} tono="marca">
                {ROL[rol]}
              </Chip>
            ))}
          </div>
        </div>
        <NavegacionDelBarrio barrioId={barrio.id} />
      </div>
      <main id="contenido">{children}</main>
    </>
  );
}
