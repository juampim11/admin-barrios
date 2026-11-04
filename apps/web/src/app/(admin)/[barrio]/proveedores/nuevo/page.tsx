import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { EncabezadoDePagina, Pagina, Panel } from "../../../../../componentes/ui.tsx";
import { esIdValido, migaDelBarrio, rutasDeProveedores, salidasDeProveedores } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { FormularioDeProveedor } from "../formularios.tsx";

export const metadata: Metadata = { title: "Nuevo proveedor" };

/**
 * El alta de un proveedor, en su página (encargo 9, PR 1 §2) — el mismo patrón que «Nueva orden de
 * pago»: la lista con sus filtros y el botón en la cabecera; acá el formulario, con «Cancelar» que
 * vuelve a la lista y, al guardar, la lista con «Listo:». Quién puede dar de alta lo decide la RLS de
 * `insert` al guardar, como antes.
 */
export default async function NuevoProveedor({ params }: { readonly params: Promise<{ readonly barrio: string }> }) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const barrio = await conSesion((tx) => leerBarrio(tx, { barrioId }));
  if (!barrio) notFound();
  const rutas = rutasDeProveedores(barrio.id);

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio(barrio), { texto: "Proveedores", href: rutas.grilla }, { texto: "Nuevo proveedor" }]}
        titulo="Nuevo proveedor"
        bajada={`Alta contra el catálogo de ${barrio.nombre}. Un proveedor se desactiva, nunca se borra.`}
      />
      <Panel>
        <FormularioDeProveedor barrioId={barrio.id} volverA={rutas.grilla} salidas={salidasDeProveedores(barrio.id)} />
      </Panel>
    </Pagina>
  );
}
