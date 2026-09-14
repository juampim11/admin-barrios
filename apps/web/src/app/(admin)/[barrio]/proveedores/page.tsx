import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarProveedores } from "@admin-barrios/data/servicios/proveedores";
import { PanelDesplegable } from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../componentes/iconos.tsx";
import { EncabezadoDePagina, MarcoTabla, Pagina, Panel, Tabla, Vacio, ui } from "../../../../componentes/ui.tsx";
import { esIdValido, salidasDeProveedores } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import { FilaDeProveedor, FormularioDeProveedor } from "./formularios.tsx";

export const metadata: Metadata = { title: "Proveedores" };

/**
 * El catálogo de proveedores del barrio: alta, corrección, desactivación y reactivación.
 *
 * **Sin paginado, a propósito.** Es el mismo criterio que `liquidacion/page.tsx` con los períodos: un
 * catálogo de proveedores de un barrio no llega al volumen que justifica cortar la lista, y acá
 * además hace falta el total activo/inactivo, que con paginado dejaría de ser una cuenta simple.
 *
 * **Trae también los inactivos** (`listarProveedores`, activos primero): una orden de pago vieja
 * puede seguir necesitando nombrar a un proveedor que después se desactivó, y desde acá se lo puede
 * reactivar en cualquier momento — "se desactiva, nunca se borra" es reversible (`formularios.tsx`
 * tiene la nota completa sobre la regresión que esto corrigió, 2026-08-26).
 */
export default async function Proveedores({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    proveedores: await listarProveedores(tx, { barrioId }),
  }));

  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const proveedores = datos.proveedores;
  const activos = proveedores.filter((p) => p.activo).length;
  const salidas = salidasDeProveedores(barrio.id);

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Proveedores"
        bajada={`El catálogo de proveedores de ${barrio.nombre}. ${activos} activos de ${proveedores.length} — se desactivan, nunca se borran: una orden de pago vieja puede seguir necesitando nombrar a uno inactivo.`}
      />

      <PanelDesplegable
        titulo="Nuevo proveedor"
        origen="Alta contra el catálogo del barrio."
        abiertoPorDefecto={proveedores.length === 0}
      >
        <FormularioDeProveedor barrioId={barrio.id} salidas={salidas} />
      </PanelDesplegable>

      <Panel titulo="Catálogo del barrio" origen="Activos primero, después los desactivados." sinRelleno>
        {proveedores.length === 0 ? (
          <Vacio icono={<IconoBorrador />} titulo="Todavía no hay ningún proveedor cargado">
            Un gasto o una orden de pago se imputan siempre a un proveedor del catálogo. Se carga desde
            «Nuevo proveedor», arriba.
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Proveedores del barrio">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Razón social
                  </th>
                  <th scope="col">CUIT</th>
                  <th scope="col">Contacto</th>
                  <th scope="col">CBU / alias</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {proveedores.map((proveedor) => (
                  <FilaDeProveedor key={proveedor.id} proveedor={proveedor} salidas={salidas} />
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>
    </Pagina>
  );
}
