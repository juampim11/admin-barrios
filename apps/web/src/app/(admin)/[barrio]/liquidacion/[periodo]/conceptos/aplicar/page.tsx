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
import { esIdValido, migaDelBarrio, rutaDeConceptosDelBarrio, rutasDelPeriodo, salidasDelPeriodo } from "../../../../../../../rutas.ts";
import { conSesion } from "../../../../../../../servidor/db.ts";
import { FormularioDeAplicacion } from "../formularios.tsx";

export const metadata: Metadata = { title: "Aplicar un concepto" };

/**
 * «Aplicar un concepto» a una unidad, en su página (encargo 16b; antes `cargos/nuevo`): el formulario,
 * con «Cancelar» que vuelve a «Conceptos del mes» y, al guardar, esa pestaña con «Listo:».
 *
 * **No se ofrecen los conceptos que entran solos**: los que el catálogo aplica al calcular el mes y la
 * bonificación por pago en término, que la aplica su regla. Cargarlos a mano los duplicaría (y el
 * servicio lo rechaza): se sacan de la lista en vez de dejar que el rechazo llegue al aplicar.
 */
export default async function AplicarUnConcepto({
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
      // búsqueda en vez de un desplegable: anotado, no disimulado.
      unidades: (await listarPadron(tx, { barrioId: periodo.barrioId, limite: 500 })).unidades,
    };
  });
  if (!datos.periodo || datos.periodo.barrioId !== barrioId) notFound();
  const { periodo } = datos;
  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const conceptos = datos.conceptos.filter((c) => !c.deLaRegla && c.modoMes !== "sola");
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
          { texto: "Conceptos del mes", href: rutas.conceptos },
          { texto: "Aplicar un concepto" },
        ]}
        titulo={`Aplicar un concepto en ${formatearPeriodo(periodo.periodo)}`}
        bajada="El valor de cada concepto lo pone el catálogo del barrio, con el que regía a la fecha del hecho. Solo en un concepto de «importe a cargar cada vez» el importe se escribe acá."
      />

      {!periodo.editable ? (
        <Nota tono="info" titulo={`Este período ya ${ESTADO_PERIODO_COMO_HECHO[periodo.estado]}: no admite cambios.`}>
          Si hay que corregir algo, se registra en el período siguiente.{" "}
          <Boton href={rutas.conceptos} variante="sutil" tamano="sm">
            Volver a los conceptos del mes
          </Boton>
        </Nota>
      ) : conceptos.length === 0 || unidades.length === 0 ? (
        <Vacio
          icono={<IconoBorrador />}
          titulo={
            conceptos.length === 0 ? "Este barrio no tiene conceptos para aplicar a mano" : "Este barrio no tiene unidades activas en el padrón"
          }
        >
          {conceptos.length === 0 ? (
            <>
              Un concepto se aplica siempre desde el catálogo del barrio, que define cómo se calcula. Se cargan en{" "}
              <a href={rutaDeConceptosDelBarrio(barrioId)}>Conceptos del barrio</a>.
            </>
          ) : (
            "Sin unidades no hay a quién aplicarle nada. Eso se resuelve en el padrón del barrio."
          )}
        </Vacio>
      ) : (
        <Panel>
          <FormularioDeAplicacion
            periodoId={periodoId}
            unidades={unidades}
            conceptos={conceptos}
            volverA={rutas.conceptos}
            salidas={salidasDelPeriodo(barrioId, periodoId)}
          />
        </Panel>
      )}
    </Pagina>
  );
}
