import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarPeriodos } from "@admin-barrios/data/servicios/periodos";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { EncabezadoDePagina, Nota, Pagina, Panel, PilaDeNotas } from "../../../../../componentes/ui.tsx";
import { esIdValido, rutasDelPeriodo } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { FormularioDePeriodo } from "./formulario.tsx";
import estilos from "./nuevo.module.css";

export const metadata: Metadata = { title: "Nuevo período" };

/**
 * El primer paso del recorrido: **crear el mes que se va a liquidar**.
 *
 * El ADR-0002 §7 lista el alta como una acción y no como una pantalla, y acá tiene ruta propia. El
 * motivo es concreto: el formulario tiene cuatro campos con validación por campo y un camino de
 * error con salida, y eso adentro de un `<details>` en el listado de períodos significa que el
 * mensaje de error aparece dentro de un bloque que se puede cerrar. Con ruta propia hay una sola cosa
 * en pantalla, el botón "Atrás" del navegador hace lo que se espera, y en el celular el formulario no
 * pelea por el espacio con una tabla.
 *
 * **Antes del formulario van los dos datos que hacen falta para decidir**: si el barrio está en
 * condiciones de liquidar (necesita una versión de coeficientes cerrada y vigente) y qué períodos ya
 * existen — porque el error más común de esta pantalla es intentar crear un mes que ya está creado, y
 * es mucho mejor verlo antes que rebotar contra un `periodo_ya_existe`.
 */
export default async function NuevoPeriodo({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    periodos: await listarPeriodos(tx, { barrioId }),
  }));

  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  if (!datos.barrio) notFound();
  const { barrio, periodos } = datos;

  const ultimos = periodos.slice(0, 6);
  // El segundo argumento no se usa en las dos rutas que esta pantalla necesita (`periodos` y
  // `padron`), que son las únicas que no dependen de un período.
  const rutas = rutasDelPeriodo(barrio.id, "");

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Nuevo período"
        bajada={
          <>
            Un período es el mes que se liquida en <strong>{barrio.nombre}</strong>. Nace en borrador:
            se le cargan los gastos, se le aplican los cargos de cada unidad y recién después se emite.
          </>
        }
      />

      <PilaDeNotas>
        {!barrio.tieneCoeficientesVigentes ? (
          <Nota
            tono="alerta"
            titulo="Este barrio no tiene una versión de coeficientes cerrada y vigente."
          >
            El período se puede crear igual y los gastos se pueden cargar, pero el borrador no se va a
            poder generar: el prorrateo necesita coeficientes cerrados. Eso se resuelve en el padrón,
            no acá. <Link href={`/${barrio.id}/padron`}>Ir al padrón</Link>.
          </Nota>
        ) : null}

        {ultimos.length > 0 ? (
          <Nota tono="info" titulo="Los períodos que ya existen en este barrio">
            <span className={estilos.existentes}>
              {ultimos.map((p) => (
                <Link key={p.id} href={`/${barrio.id}/liquidacion/${p.id}`} className={estilos.existente}>
                  {formatearPeriodo(p.periodo)}
                </Link>
              ))}
              {periodos.length > ultimos.length ? (
                <span className={estilos.masExistentes}>y {periodos.length - ultimos.length} más</span>
              ) : null}
            </span>
            No puede haber dos períodos del mismo mes en el mismo barrio: si el que buscás está en esa
            lista, entrá ahí en vez de crearlo de nuevo.
          </Nota>
        ) : null}
      </PilaDeNotas>

      <Panel
        titulo="Datos del período"
        origen="Nada de lo que se carga acá es una cifra de dinero: el importe del mes sale de los gastos que se carguen después, y el de cada unidad, del prorrateo."
      >
        {/*
          Las salidas de esta pantalla son dos, y no las de un período: todavía no hay período al que
          mandar a nadie. `salidasDelPeriodo()` no sirve acá justamente por eso — armaría enlaces con
          el segmento vacío en el medio.
        */}
        <FormularioDePeriodo
          barrioId={barrio.id}
          salidas={{
            periodo_ya_existe: { texto: "Ver los períodos del barrio", href: rutas.periodos },
            barrio_sin_coeficientes: { texto: "Ir al padrón del barrio", href: rutas.padron },
            coeficientes_sin_cerrar: { texto: "Ir al padrón del barrio", href: rutas.padron },
          }}
        />
      </Panel>
    </Pagina>
  );
}
