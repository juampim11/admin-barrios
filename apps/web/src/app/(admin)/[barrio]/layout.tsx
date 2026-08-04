import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { CabeceraBarrio, type BarrioParaSelector } from "@admin-barrios/ui";
import {
  leerBarrio,
  listarBarriosAccesibles,
} from "@admin-barrios/data/servicios/barrios";
import { etiquetaFiguraCorta, ROL } from "../../../componentes/etiquetas.tsx";
import { esIdValido } from "../../../rutas.ts";
import { conSesion } from "../../../servidor/db.ts";
import { NavegacionDelBarrio } from "./navegacion.tsx";
import estilos from "../admin.module.css";

/**
 * Cabecera de todas las pantallas de un barrio.
 *
 * El uuid de la URL elige que barrio mirar, pero no autoriza: `leerBarrio` corre bajo RLS. Si el
 * usuario no puede leerlo, el servicio devuelve `null` y esta capa responde igual que ante un id
 * inexistente, sin crear un oraculo de tenants.
 */
export default async function LayoutDelBarrio({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const resultado = await conSesion(async (tx) => {
    const [barrio, barrios] = await Promise.all([
      leerBarrio(tx, { barrioId }),
      listarBarriosAccesibles(tx),
    ]);
    return { barrio, barrios };
  });

  if (!resultado.barrio) notFound();

  const barrios: BarrioParaSelector[] = resultado.barrios.map((barrio) => ({
    id: barrio.id,
    nombre: barrio.nombre,
    figura: etiquetaFiguraCorta(barrio.figuraJuridica),
    detalle: barrio.denominacionConcepto,
    href: `/${barrio.id}/tablero`,
  }));

  const actual: BarrioParaSelector = {
    id: resultado.barrio.id,
    nombre: resultado.barrio.nombre,
    figura: etiquetaFiguraCorta(resultado.barrio.figuraJuridica),
    detalle: resultado.barrio.denominacionConcepto,
    href: `/${resultado.barrio.id}/tablero`,
  };

  return (
    <>
      <CabeceraBarrio
        barrio={actual}
        barrios={barrios}
        figura={etiquetaFiguraCorta(resultado.barrio.figuraJuridica)}
        roles={resultado.barrio.roles.map((rol) => ROL[rol])}
        navegacion={<NavegacionDelBarrio barrioId={resultado.barrio.id} />}
      />
      <main id="contenido" className={estilos.contenido}>
        {children}
      </main>
    </>
  );
}
