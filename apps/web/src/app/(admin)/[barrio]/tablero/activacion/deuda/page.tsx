import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { estadoDeLaActivacion } from "@admin-barrios/data/servicios/activacion";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { MAX_FILAS_DEUDA } from "@admin-barrios/shared/activacion";
import { formatearDecimal } from "@admin-barrios/shared/dinero";
import { nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { Boton } from "@admin-barrios/ui";
import { EncabezadoDePagina, Nota, Pagina, Panel } from "../../../../../../componentes/ui.tsx";
import { conListo, esIdValido, migaDelBarrio, rutasDeActivacion } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { COMO_SE_CORRIGE_LA_DEUDA_ANTERIOR, deudasEnPalabras, saldosAFavorEnPalabras } from "../textos.ts";
import { PlanillaDeDeuda } from "./planilla.tsx";

export const metadata: Metadata = { title: "Planilla de deuda anterior" };

/**
 * «Vista previa de la planilla» (encargo 17, pantalla 2 de la maqueta): subir la planilla de deuda
 * anterior, mirar lo que entraría y recién ahí confirmar.
 *
 * La página resuelve en el servidor si corresponde ofrecer la carga —quién mira, si el barrio ya
 * emitió, si la deuda cargada ya tiene cobros— con lo que dice `estadoDeLaActivacion`, y le pasa a la
 * isla solo lo serializable. La carga la decide la base; esto solo evita ofrecer un camino que va a
 * rechazar.
 */
export default async function PlanillaDeDeudaAnterior({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    estado: await estadoDeLaActivacion(tx, { barrioId }),
  }));
  // `notFound()` afuera de la transacción (ADR-0002 §3.1).
  if (!datos.barrio || !datos.estado) notFound();
  const { barrio, estado } = datos;
  const rutas = rutasDeActivacion(barrio.id);
  const yaNoSeReemplaza = estado.yaEmitio || estado.conCobros;

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio(barrio), { texto: "Activar el barrio", href: rutas.tablero }, { texto: "Planilla de deuda" }]}
        titulo="Vista previa de la planilla"
        bajada={`${barrio.nombre} · la deuda anterior, mes por mes: lo que cada unidad todavía debe de antes${
          estado.primerPeriodo ? ` de ${nombreDelPeriodo(estado.primerPeriodo).toLowerCase()}` : ""
        }.`}
        acciones={
          <Boton href={rutas.tablero} variante="secundario">
            Volver al tablero
          </Boton>
        }
      />

      {estado.deudaAnterior === "cargada" ? (
        <Nota tono="info" titulo="Ya hay una deuda anterior cargada.">
          {[...(estado.deudas > 0 ? [deudasEnPalabras(estado)] : []), ...(estado.saldosAFavor > 0 ? [saldosAFavorEnPalabras(estado)] : [])].join(
            " y ",
          )}
          . <a href={rutas.verificar}>Ver lo cargado</a>.
        </Nota>
      ) : null}

      {!estado.puedeActivar ? (
        <Nota tono="neutro" titulo="La deuda anterior la carga la administración del barrio.">
          Pedíselo a quien administra el barrio.
        </Nota>
      ) : yaNoSeReemplaza ? (
        <Nota tono="alerta" titulo="La planilla ya no se puede volver a subir.">
          {estado.yaEmitio ? "El barrio ya emitió su primer mes. " : "La deuda cargada ya tiene cobros o intereses registrados. "}
          {COMO_SE_CORRIGE_LA_DEUDA_ANTERIOR}
        </Nota>
      ) : (
        <Panel
          titulo="Subir la planilla de deuda"
          origen="Una fila por cada mes que una unidad todavía debe, con el concepto, su vencimiento y lo que falta pagar. Los conceptos tienen que estar en «Conceptos del barrio» y las unidades, en el padrón."
        >
          <PlanillaDeDeuda
            barrioId={barrio.id}
            rutaPlantilla={rutas.plantilla}
            maximoDeFilas={formatearDecimal(String(MAX_FILAS_DEUDA), 0)}
            volverA={conListo(rutas.tablero, "deuda_anterior")}
            salidas={{}}
          />
        </Panel>
      )}
    </Pagina>
  );
}
