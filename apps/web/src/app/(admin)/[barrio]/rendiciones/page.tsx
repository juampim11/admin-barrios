import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { rendicionesDelBarrio } from "@admin-barrios/data/servicios/planes-rendicion";
import { Chip } from "@admin-barrios/ui";
import { EncabezadoDePagina, MarcoTabla, Pagina, Panel, Tabla, Vacio, ui } from "../../../../componentes/ui.tsx";
import { NuevaRendicion } from "../../../../componentes/rendiciones/formularios.tsx";
import { esIdValido, migaDelBarrio, rutaDeRendicion } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";

export const metadata: Metadata = { title: "Rendiciones de estudios" };

/**
 * **Las rendiciones de los estudios del barrio** (encargo P2b; maqueta de planes de pago, pantalla 5).
 * Cuando un plan lo cobra el estudio, el estudio le rinde al barrio lo de las cuotas: qué cobró y cómo
 * llegó la plata. En la v1 la carga la administración.
 *
 * Una lectura bajo RLS (`rendicionesDelBarrio`). El barrio de la URL elige, no autoriza.
 */
export default async function RendicionesDelBarrio({ params }: { readonly params: Promise<{ readonly barrio: string }> }) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();
  const datos = await conSesion((tx) => rendicionesDelBarrio(tx, { barrioId }));
  if (!datos) notFound();
  const { barrio, rendiciones, estudios, puedeCargar, mesActual } = datos;

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio(barrio), { texto: "Rendiciones de estudios" }]}
        titulo="Rendiciones de estudios"
        bajada="Cuando un plan de pagos lo cobra el estudio, el estudio le rinde al barrio lo de las cuotas: qué cobró y cómo le llegó la plata. Los honorarios los retiene el estudio y no entran."
      />
      {puedeCargar && estudios.length > 0 ? (
        <Panel titulo="Nueva rendición" origen="Se carga en borrador y se confirma cuando las cuotas y los ingresos suman lo mismo.">
          <NuevaRendicion barrioId={barrio.id} estudios={estudios} mesSugerido={mesActual} />
        </Panel>
      ) : null}
      <Panel titulo="Rendiciones" origen="Del barrio, de la más nueva a la más vieja.">
        {rendiciones.length === 0 ? (
          <Vacio titulo="Todavía no hay rendiciones">Se abre una cuando el estudio manda lo que cobró de las cuotas.</Vacio>
        ) : (
          <MarcoTabla etiqueta="Rendiciones del barrio">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Mes
                  </th>
                  <th scope="col">Estudio</th>
                  <th scope="col">Cuotas</th>
                  <th scope="col" className={ui.numerica}>
                    Importe
                  </th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                {rendiciones.map((r) => (
                  <tr key={r.id}>
                    <th scope="row" className={ui.columnaAncla}>
                      <Link href={rutaDeRendicion(barrio.id, r.id)}>{r.periodo}</Link>
                    </th>
                    <td>{r.estudio}</td>
                    <td>{r.cuotas}</td>
                    <td className={ui.numerica}>{r.importe}</td>
                    <td>
                      {r.estado === "anulada" ? (
                        <>
                          <Chip tono="peligro">Anulada</Chip>
                          <br />
                          <span className={ui.secundaria}>{r.anulada}</span>
                        </>
                      ) : r.estado === "confirmada" ? (
                        <Chip tono="exito">{`Confirmada el ${r.confirmada ?? ""}`}</Chip>
                      ) : (
                        <Chip tono="alerta">Borrador</Chip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>
    </Pagina>
  );
}
