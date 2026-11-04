import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerBarrioDelPadron, puedeEditarPadron } from "@admin-barrios/data/servicios/padron-edicion";
import { Boton } from "@admin-barrios/ui";
import { EncabezadoDePagina, Nota, Pagina, Panel } from "../../../../../componentes/ui.tsx";
import { esIdValido, migaDelBarrio, rutaDelPadron } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { FormularioAgregarUnidad } from "../agregar-unidad.tsx";

export const metadata: Metadata = { title: "Agregar unidad" };

/**
 * «Agregar unidad», en su página (encargo 9, PR 1 §2): el padrón con el botón en la cabecera y acá
 * el formulario, con «Cancelar» que vuelve al padrón y, al guardar, el padrón con «Listo:». A quien no
 * puede editar el padrón no se le dibuja el formulario (el botón tampoco se le muestra); la base
 * igual lo vuelve a mirar al escribir.
 */
export default async function NuevaUnidad({ params }: { readonly params: Promise<{ readonly barrio: string }> }) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => {
    const barrio = await leerBarrioDelPadron(tx, { barrioId });
    if (!barrio) return null;
    return { barrio, puedeEditar: await puedeEditarPadron(tx, { barrioId }) };
  });
  if (!datos) notFound();
  const { barrio, puedeEditar } = datos;
  const ruta = rutaDelPadron(barrio.id);

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio(barrio), { texto: "Padrón", href: ruta }, { texto: "Agregar unidad" }]}
        titulo="Agregar unidad"
        bajada={`Una unidad nueva de ${barrio.nombre}, con sus titulares. El código de pago lo asigna el sistema.`}
      />
      {puedeEditar ? (
        <Panel>
          <FormularioAgregarUnidad
            barrioId={barrio.id}
            cuentaPorUnidad={barrio.cuentaPorUnidad}
            modelo={barrio.modelo}
            proximoPeriodo={barrio.proximoPeriodo}
            volverA={ruta}
          />
        </Panel>
      ) : (
        <Nota tono="info" titulo="Tu rol no carga unidades en el padrón de este barrio.">
          Lo hace un administrador del barrio.{" "}
          <Boton href={ruta} variante="sutil" tamano="sm">
            Volver al padrón
          </Boton>
        </Nota>
      )}
    </Pagina>
  );
}
