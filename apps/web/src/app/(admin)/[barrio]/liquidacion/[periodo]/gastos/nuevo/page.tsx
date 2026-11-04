import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerPeriodo } from "@admin-barrios/data/servicios/periodos";
import { listarConceptos } from "@admin-barrios/data/servicios/gastos";
import { formatearPeriodo, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { Boton } from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../../../../componentes/iconos.tsx";
import { ESTADO_PERIODO_COMO_HECHO } from "../../../../../../../componentes/etiquetas.tsx";
import { Cifra, EncabezadoDePagina, Nota, Pagina, Panel, Vacio } from "../../../../../../../componentes/ui.tsx";
import { esIdValido, migaDelBarrio, rutasDelPeriodo, salidasDelPeriodo } from "../../../../../../../rutas.ts";
import { conSesion } from "../../../../../../../servidor/db.ts";
import { FormularioDeGasto } from "../formularios.tsx";

export const metadata: Metadata = { title: "Cargar un gasto" };

/** Cuántos de los últimos gastos se muestran al lado del formulario, para no cargar dos veces el mismo. */
const ULTIMOS = 5;

/**
 * La carga de un gasto, en su página (encargo 9, PR 1 §2): la lista de gastos con el botón en la
 * cabecera y acá el formulario, con «Cancelar» que vuelve a la lista y, al guardar, la lista con
 * «Listo:».
 *
 * **Lo que se perdía al sacar el formulario de la lista, se trae** (`relevamiento-liquidacion.md`
 * §8): cargando contra una pila de comprobantes hace falta ver lo último cargado —para no duplicar— y
 * el total acumulado. Van en un panel al lado del formulario, leídos en la misma transacción.
 *
 * **Si el período ya no es editable, el formulario no se dibuja** (mismo criterio que antes en la
 * lista): una nota dice por qué y lleva de vuelta.
 */
export default async function NuevoGasto({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();

  const datos = await conSesion(async (tx) => {
    const periodo = await leerPeriodo(tx, { periodoId });
    if (!periodo) return { periodo: null, conceptos: [] };
    return { periodo, conceptos: await listarConceptos(tx, { barrioId: periodo.barrioId }) };
  });
  if (!datos.periodo || datos.periodo.barrioId !== barrioId) notFound();
  const { periodo, conceptos } = datos;
  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const ultimos = periodo.gastos.slice(-ULTIMOS).reverse();

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[
          migaDelBarrio({ id: barrioId, nombre: periodo.barrioNombre }),
          { texto: "Liquidación", href: rutas.periodos },
          { texto: nombreDelPeriodo(periodo.periodo), href: rutas.resumen },
          { texto: "Gastos", href: rutas.gastos },
          { texto: "Cargar un gasto" },
        ]}
        titulo={`Cargar un gasto en ${formatearPeriodo(periodo.periodo)}`}
        bajada={
          periodo.modelo === "fija"
            ? "El monto se guarda tal cual se escribe, sin redondear: es el que después hay que poder conciliar contra la factura. Con cuota fija, solo los extraordinarios se reparten entre las unidades."
            : "El monto se guarda tal cual se escribe, sin redondear: es el que se va a repartir entre las unidades y el que después hay que poder conciliar contra la factura."
        }
      />

      {!periodo.editable ? (
        <Nota tono="info" titulo={`Este período ya ${ESTADO_PERIODO_COMO_HECHO[periodo.estado]}: no se le cargan más gastos.`}>
          Si hace falta corregir algo de un período emitido, se registra en el período siguiente.{" "}
          <Boton href={rutas.gastos} variante="sutil" tamano="sm">
            Volver a los gastos
          </Boton>
        </Nota>
      ) : conceptos.length === 0 ? (
        <Vacio icono={<IconoBorrador />} titulo="Este barrio no tiene conceptos de gasto cargados">
          Un gasto se imputa siempre a un concepto del catálogo del barrio, que es lo que define si es
          ordinario o extraordinario y cómo se encuadra fiscalmente.
        </Vacio>
      ) : (
        <>
          <Panel>
            <FormularioDeGasto
              periodoId={periodoId}
              conceptos={conceptos}
              cuotaFija={periodo.modelo === "fija"}
              volverA={rutas.gastos}
              salidas={salidasDelPeriodo(barrioId, periodoId)}
            />
          </Panel>
          <Panel
            titulo="Lo que ya está cargado"
            origen={
              <>
                {periodo.gastos.length} {periodo.gastos.length === 1 ? "gasto" : "gastos"} por{" "}
                <Cifra monto={periodo.totalGastosCargados} nulo="—" />
                {periodo.gastos.length > ULTIMOS ? ` · los ${ULTIMOS} últimos, para no cargar dos veces el mismo` : ""}.
              </>
            }
          >
            {ultimos.length === 0 ? (
              <p>Todavía no se cargó ningún gasto en este período.</p>
            ) : (
              <ul>
                {ultimos.map((g) => (
                  <li key={g.id}>
                    {g.descripcion} · {g.proveedorNombre ?? "sin proveedor"} · <Cifra monto={g.monto} nulo="—" />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </Pagina>
  );
}
