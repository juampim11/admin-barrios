import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerPeriodo } from "@admin-barrios/data/servicios/periodos";
import { listarConceptosBoleta } from "@admin-barrios/data/servicios/conceptos-boleta";
import { listarPadron } from "@admin-barrios/data/servicios/padron";
import { formatearPeriodo, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { Boton } from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../../../../componentes/iconos.tsx";
import { ESTADO_PERIODO_COMO_HECHO } from "../../../../../../../componentes/etiquetas.tsx";
import { EncabezadoDePagina, Nota, Pagina, Panel, Vacio } from "../../../../../../../componentes/ui.tsx";
import { esIdValido, migaDelBarrio, rutasDelPeriodo, salidasDelPeriodo } from "../../../../../../../rutas.ts";
import { conSesion } from "../../../../../../../servidor/db.ts";
import { FormularioDeAplicacion } from "../formularios.tsx";

export const metadata: Metadata = { title: "Aplicar un cargo o descuento" };

/**
 * Aplicar un cargo o un descuento a una unidad, en su página (encargo 9, PR 1 §2): la lista con el
 * botón en la cabecera y acá el formulario, con «Cancelar» que vuelve a la lista y, al guardar, la
 * lista con «Listo:». Las lecturas son las que antes hacía la lista para el desplegable.
 */
export default async function NuevoCargo({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();

  const datos = await conSesion(async (tx) => {
    const periodo = await leerPeriodo(tx, { periodoId });
    if (!periodo) return { periodo: null, conceptos: [], unidades: [] };
    return {
      periodo,
      conceptos: await listarConceptosBoleta(tx, { barrioId: periodo.barrioId }),
      // El padrón entero para el desplegable (techo del esquema: 500). Un barrio más grande pide una
      // búsqueda en vez de un desplegable — anotado, no disimulado (estaba igual en la lista).
      unidades: (await listarPadron(tx, { barrioId: periodo.barrioId, limite: 500 })).unidades,
    };
  });
  if (!datos.periodo || datos.periodo.barrioId !== barrioId) notFound();
  const { periodo, conceptos } = datos;
  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const unidades = datos.unidades
    .filter((u) => !u.dadaDeBaja)
    .map((u) => ({
      id: u.id,
      etiqueta: u.etiqueta,
      destinatario: u.obligados.find((o) => o.esNotificado)?.nombre ?? u.obligados[0]?.nombre ?? null,
    }));

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[
          migaDelBarrio({ id: barrioId, nombre: periodo.barrioNombre }),
          { texto: "Liquidación", href: rutas.periodos },
          { texto: nombreDelPeriodo(periodo.periodo), href: rutas.resumen },
          { texto: "Cargos y descuentos", href: rutas.cargos },
          { texto: "Aplicar a una unidad" },
        ]}
        titulo={`Aplicar un cargo o descuento en ${formatearPeriodo(periodo.periodo)}`}
        bajada="El precio, el porcentaje y el tope los pone el catálogo del barrio, congelados al valor vigente a la fecha del hecho. Este formulario no manda ni un importe."
      />

      {!periodo.editable ? (
        <Nota tono="info" titulo={`Este período ya ${ESTADO_PERIODO_COMO_HECHO[periodo.estado]}: no admite cambios.`}>
          Si hay que corregir algún cargo, se registra en el período siguiente.{" "}
          <Boton href={rutas.cargos} variante="sutil" tamano="sm">
            Volver a los cargos
          </Boton>
        </Nota>
      ) : conceptos.length === 0 || unidades.length === 0 ? (
        <Vacio
          icono={<IconoBorrador />}
          titulo={
            conceptos.length === 0 ? "Este barrio no tiene conceptos de boleta cargados" : "Este barrio no tiene unidades activas en el padrón"
          }
        >
          {conceptos.length === 0
            ? "Un cargo se aplica siempre desde un concepto del catálogo, que es lo que define el precio, el encuadre fiscal y quién financia el descuento."
            : "Sin unidades no hay a quién cobrarle. Eso se resuelve en el padrón del barrio."}
        </Vacio>
      ) : (
        <Panel>
          <FormularioDeAplicacion
            periodoId={periodoId}
            unidades={unidades}
            conceptos={conceptos}
            volverA={rutas.cargos}
            salidas={salidasDelPeriodo(barrioId, periodoId)}
          />
        </Panel>
      )}
    </Pagina>
  );
}
