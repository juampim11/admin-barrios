import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarPeriodos } from "@admin-barrios/data/servicios/periodos";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { comoSeLlama } from "../../../../../componentes/etiquetas.tsx";
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
 * motivo es concreto: el formulario tiene cinco campos con validación por campo y un camino de
 * error con salida, y eso adentro de un `<details>` en el listado de períodos significa que el
 * mensaje de error aparece dentro de un bloque que se puede cerrar. Con ruta propia hay una sola cosa
 * en pantalla, el botón "Atrás" del navegador hace lo que se espera, y en el celular el formulario no
 * pelea por el espacio con una tabla. Con el grupo de opciones del modelo —dos tarjetas con su
 * explicación— el argumento solo se refuerza.
 *
 * **Antes del formulario van los dos datos que hacen falta para decidir**: si el barrio está en
 * condiciones de liquidar (necesita una versión de coeficientes cerrada y vigente) y qué períodos ya
 * existen — porque el error más común de esta pantalla es intentar crear un mes que ya está creado, y
 * es mucho mejor verlo antes que rebotar contra un `periodo_ya_existe`.
 *
 * **Y desde el 2026-08-04, el modelo del último período**, que es con lo que viene marcado el grupo
 * de opciones. Sale de `listarPeriodos`, que ya se llamaba acá y ya devolvía la columna: cero
 * consultas nuevas. Un barrio sin ningún período no tiene de dónde tomar el criterio y **no se
 * preselecciona nada** — el `default 'variable'` de la columna es una decisión de esquema, no de
 * producto, y el doc 08 §B es explícito en que el criterio de reparto viene del instrumento del
 * barrio y no se sugiere por omisión.
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
        {/*
          **El aviso corresponde con los dos modelos, y el motivo NO es el que decía.** Decía "el
          prorrateo necesita coeficientes cerrados", que es falso en un mes de valor fijo: ahí lo
          ordinario no se prorratea. Pero la conclusión seguía siendo verdadera, por otras dos
          razones que se verificaron antes de reescribir el texto: `generarLiquidaciones()` rechaza
          con `barrio_sin_coeficientes` **antes** de mirar el modelo, y las unidades que se liquidan
          salen del `join` con la tabla `coeficiente` — sin versión cerrada no hay ni a quién
          emitirle. Y en el modelo de valor fijo las extraordinarias sí se reparten por coeficiente.
          Es exactamente el error que la regla 6 de CLAUDE.md describe: un rótulo que explica *cómo*
          se calcula, escrito mirando un solo modelo.
        */}
        {!barrio.tieneCoeficientesVigentes ? (
          <Nota
            tono="alerta"
            titulo="Este barrio no tiene una versión de coeficientes cerrada y vigente."
          >
            El período se puede crear igual y los gastos se pueden cargar, pero el borrador no se va a
            poder generar con ninguno de los dos modelos: la versión cerrada es la que define qué
            unidades entran en la liquidación y con qué coeficiente. También hace falta cobrando un
            valor fijo, porque las extraordinarias se reparten igual. Eso se resuelve en el padrón, no
            acá. <Link href={`/${barrio.id}/padron`}>Ir al padrón</Link>.
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

      {/*
        El `origen` decía "el de cada unidad, del prorrateo", y con el modelo elegible pasó a ser
        falso la mitad de las veces. Además el modelo todavía no está elegido cuando esto se
        renderiza, así que el texto tiene que ser neutral **y** decir que de eso depende.
      */}
      <Panel
        titulo="Datos del período"
        origen="Nada de lo que se carga acá es una cifra de dinero. Cuánto va a pagar cada unidad lo determina el modelo que se elige abajo, y se calcula después, al generar el borrador."
      >
        {/*
          Las salidas de esta pantalla son dos, y no las de un período: todavía no hay período al que
          mandar a nadie. `salidasDelPeriodo()` no sirve acá justamente por eso — armaría enlaces con
          el segmento vacío en el medio.
        */}
        <FormularioDePeriodo
          barrioId={barrio.id}
          denominacion={comoSeLlama(barrio.denominacionConcepto)}
          /*
            El período más reciente, del que sale la marca inicial del modelo. `listarPeriodos`
            ordena `periodo desc`, así que es el primero. `null` en el barrio sin períodos: ahí no
            hay criterio anterior y no se elige por nadie.
          */
          ultimoPeriodo={periodos[0] ? { periodo: periodos[0].periodo, modelo: periodos[0].modelo } : null}
          tieneCuotaFijaDefinida={barrio.tieneCuotaFijaDefinida}
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
