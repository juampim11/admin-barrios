import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { CuerpoConBarraLateral } from "@admin-barrios/ui";
import {
  leerBarrio,
  listarBarriosAccesibles,
} from "@admin-barrios/data/servicios/barrios";
import { esIdValido } from "../../../rutas.ts";
import { conSesion } from "../../../servidor/db.ts";
import { BarraDelBarrio } from "../barra-del-barrio.tsx";
import estilos from "../admin.module.css";

/**
 * Cabecera de todas las pantallas de un barrio.
 *
 * El uuid de la URL elige qué barrio mirar, pero no autoriza: `leerBarrio` corre bajo RLS. Si el
 * usuario no puede leerlo, el servicio devuelve `null` y esta capa responde igual que ante un id
 * inexistente, sin crear un oráculo de tenants.
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

  // Las dos lecturas van en UNA transacción y **secuenciales**: `node-postgres` encola las consultas
  // de un mismo client, así que un `Promise.all` acá no paralelizaría nada — solo daría a entender
  // que sí. Es la misma convención que explican `[periodo]/page.tsx` y `gastos/page.tsx`.
  const resultado = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    barrios: await listarBarriosAccesibles(tx),
  }));

  if (!resultado.barrio) notFound();

  return (
    <>
      <CuerpoConBarraLateral
        barraLateral={
          <BarraDelBarrio
            barrio={resultado.barrio}
            barrios={resultado.barrios}
            // Para el rótulo de «Todos los barrios»: el estudio con mandato vigente, que ya viene leído.
            administracion={resultado.barrio.administrador?.nombre ?? null}
          />
        }
      >
        <main id="contenido" className={estilos.contenido}>
          {children}
        </main>
      </CuerpoConBarraLateral>
    </>
  );
}
