import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { cuotaFijaVigente } from "@admin-barrios/data/servicios/cuota-fija";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import {
  Cifra,
  Dato,
  Desplegable,
  EncabezadoDePagina,
  MarcoTabla,
  Nota,
  Pagina,
  Panel,
  PilaDeNotas,
  Tabla,
} from "../../../../../componentes/ui.tsx";
import { esIdValido, rutasDelPeriodo } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { FormularioDeCuota } from "./formulario.tsx";
import estilos from "./cuota.module.css";

export const metadata: Metadata = { title: "Valor de la expensa" };

/**
 * Cómo llama este barrio a lo que cobra. Sale de `denominacion_concepto` —lo que va impreso en la
 * boleta— y cae a "expensa", que es el término del Código Civil y el que entiende todo el mundo.
 *
 * **La pantalla no dice "cuota" en ninguna parte.** Un PH cobra expensas, una asociación civil una
 * cuota social o un aporte, un fideicomiso una contribución. Si el sistema usara una palabra y la
 * boleta otra, el administrador tendría que traducir mentalmente en cada pantalla. Las tablas sí se
 * llaman `cuota_fija`: ese es el nombre del **modelo de cálculo**, no el de lo que se cobra.
 */
const comoSeLlama = (denominacion: string | null): string =>
  denominacion?.trim() ? denominacion.trim() : "expensa";

/**
 * **La cuota mensual de un barrio que no prorratea.**
 *
 * Existía un agujero concreto: el modelo `fija` se podía liquidar, pero la cuota solo entraba por el
 * script de siembra. O sea que la decisión más importante del mes —cuánto paga cada vecino— no tenía
 * pantalla, y la única forma de cambiarla era tocar la base. Esta es esa pantalla.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * NO ES UNA PANTALLA "DEL BARRIO PILOTO"
 *
 * El piloto tiene una sola cuota para todas las unidades, y ese es el caso fácil. La pantalla no lo
 * asume en ninguna parte (regla dura 6 de `CLAUDE.md`): cuando hay importes distintos por unidad,
 * `importeUnico` viene en `null`, la vista previa se calla en vez de inventar un número que
 * describiría a unas y no a otras, y el aumento por porcentaje se aplica **sobre lo que paga cada
 * una**. Un barrio con cocheras que pagan la mitad usa la misma pantalla sin que nadie le empareje
 * nada por sorpresa.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ VIVE BAJO `liquidacion/` Y NO EN UNA SECCIÓN NUEVA
 *
 * La cuota es un parámetro del barrio, no de un período —de ahí que no cuelgue de `[periodo]`—, pero
 * lo único que hace es determinar lo que se liquida. Una sección propia en la barra lateral la
 * mostraría en barrios que prorratean, donde no significa nada. Se entra desde el resumen del
 * período de cuota fija, que es donde la pregunta aparece.
 *
 * La ruta es estática (`cuota`) y convive con `[periodo]` igual que `nuevo`: un segmento estático
 * gana sobre uno dinámico en el App Router.
 */
export default async function CuotaDelBarrio({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    vigente: await cuotaFijaVigente(tx, barrioId),
  }));

  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  if (!datos.barrio) notFound();
  const { barrio, vigente } = datos;
  const rutas = rutasDelPeriodo(barrio.id, "");
  const denominacion = comoSeLlama(barrio.denominacionConcepto);

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo={`Valor de ${denominacion === "expensa" ? "la expensa" : denominacion}`}
        bajada={
          <>
            Lo que paga cada unidad de <strong>{barrio.nombre}</strong> todos los meses. Lo fija el
            directorio o la administración: <strong>no sale de dividir los gastos</strong>. Si alcanza
            o no para cubrirlos se ve en el resumen de cada período.
          </>
        }
      />

      <PilaDeNotas>
        {vigente.unidadesActivas === 0 ? (
          <Nota tono="alerta" titulo="Este barrio no tiene unidades activas.">
            No hay a quién cobrarle todavía. Eso se resuelve en el padrón, no acá.{" "}
            <Link href={rutas.padron}>Ir al padrón</Link>.
          </Nota>
        ) : null}

        {vigente.unidadesSinImporte > 0 ? (
          <Nota
            tono="alerta"
            titulo={`Hay ${vigente.unidadesSinImporte} unidad(es) activas sin valor asignado.`}
          >
            Son altas posteriores a la última versión del valor. Mientras estén así{" "}
            <strong>no se les factura nada</strong>, y el aumento por porcentaje no se puede aplicar:
            no hay sobre qué calcularlo. Cargá un importe para dejarlas a todas con un valor.
          </Nota>
        ) : null}
      </PilaDeNotas>

      <Panel
        titulo="Lo que rige hoy"
        origen={
          vigente.vigenteDesde
            ? `Rige desde el período ${formatearPeriodo(vigente.vigenteDesde.slice(0, 7))}. Los períodos ya emitidos conservan el valor que regía cuando se liquidaron.`
            : "Todavía no hay ningún valor definido en este barrio."
        }
      >
        <div className={estilos.cifras}>
          <Dato
            etiqueta="Por unidad"
            grande
            origen={
              vigente.importeUnico === null && vigente.versionId !== null
                ? "Las unidades pagan importes distintos: está el detalle más abajo."
                : "Lo mismo para todas las unidades activas."
            }
          >
            <Cifra monto={vigente.importeUnico} nulo="varias" />
          </Dato>
          <Dato
            etiqueta="Total mensual del barrio"
            origen={`${vigente.unidadesActivas} unidades activas. Es lo que se factura, no lo que se cobra: la mora se descuenta aparte.`}
          >
            <Cifra monto={vigente.totalMensual} nulo="—" />
          </Dato>
          {vigente.ajustePorcentaje !== null ? (
            <Dato
              etiqueta="Último ajuste"
              origen={vigente.descripcion ?? "Sin referencia del acto que la aprobó."}
            >
              {vigente.ajustePorcentaje} %
            </Dato>
          ) : vigente.descripcion !== null ? (
            <Dato etiqueta="Qué la aprobó">{vigente.descripcion}</Dato>
          ) : null}
        </div>
      </Panel>

      {vigente.unidadesActivas > 0 ? (
        <Panel
          titulo="Definir el valor nuevo"
          origen="El anterior se cierra solo con el mes que se elija. Nada de lo ya emitido cambia."
        >
          <FormularioDeCuota
            barrioId={barrio.id}
            vigente={vigente}
            proximoMes={vigente.proximoMes}
            denominacion={denominacion}
            /*
              `sin_cuota_anterior` y `cuota_retroactiva` NO tienen salida, y es la decisión correcta:
              la salida de los dos es corregir un campo de este mismo formulario. Un enlace ahí
              mandaría a la persona a otra pantalla a resolver algo que tiene delante.
            */
            salidas={{
              sin_unidades: { texto: "Ir al padrón del barrio", href: rutas.padron },
              unidades_sin_cuota: { texto: "Ver el padrón del barrio", href: rutas.padron },
              sin_permiso: { texto: "Volver a los períodos", href: rutas.periodos },
            }}
          />
        </Panel>
      ) : null}

      {/*
        Quinientas filas no se muestran abiertas: el usuario ya marcó ese problema en la grilla de
        revisión. Colapsado, el detalle está disponible para quien lo necesite —que es quien tiene
        importes distintos— sin obligar a nadie a hacer scroll hasta el final para ver un botón.
      */}
      {vigente.cuotas.length > 0 ? (
        <Panel titulo="Lo que paga cada unidad" origen="La versión vigente, unidad por unidad.">
          <Desplegable resumen={`Ver las ${vigente.cuotas.length} unidades`}>
            <MarcoTabla etiqueta="Valor vigente por unidad">
              <Tabla>
                <thead>
                  <tr>
                    <th scope="col">Unidad</th>
                    <th scope="col" className={estilos.montoCelda}>
                      Importe mensual
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {vigente.cuotas.map((c) => (
                    <tr key={c.unidadFuncionalId}>
                      <td>{c.etiqueta}</td>
                      <td className={estilos.montoCelda}>
                        {c.importe === null ? (
                          <span className={estilos.sinCuota}>sin valor asignado</span>
                        ) : (
                          <Cifra monto={c.importe} nulo="—" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Tabla>
            </MarcoTabla>
          </Desplegable>
        </Panel>
      ) : null}
    </Pagina>
  );
}
