import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { estadoDeLaActivacion, verificacionDeDeudaAnterior } from "@admin-barrios/data/servicios/activacion";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { porcentajeDeTasa, tasaDePorcentaje } from "@admin-barrios/shared/activacion";
import { sumarMontos } from "@admin-barrios/shared/dinero";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { AccionDesplegable, Boton } from "@admin-barrios/ui";
import { CampoTexto } from "../../../../../../componentes/formulario.tsx";
import { Cifra, Dato, EncabezadoDePagina, MarcoTabla, Nota, Pagina, Panel, Tabla, ui } from "../../../../../../componentes/ui.tsx";
import { conListo, esIdValido, migaDelBarrio, rutasDeActivacion } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import {
  COMO_SE_CORRIGE_LA_DEUDA_ANTERIOR,
  comoSeCorrigeYaActivado,
  consecuenciasDeActivar,
  DEUDA_ANTERIOR_A_LA_ACTIVACION,
  lineaDeActivado,
  sePuedeVerificar,
  tasaEnPalabras,
} from "../textos.ts";
import { BotonActivarBarrio } from "./activar.tsx";
import { CompararConElSistemaAnterior } from "./comparar.tsx";
import estilos from "../activacion.module.css";

export const metadata: Metadata = { title: "Verificar antes de activar" };

/**
 * «Verificar antes de activar» (encargo 17, pantalla 3 de la maqueta): lo que quedó cargado de la
 * deuda anterior —capital e interés a hoy, por unidad y mes por mes—, para compararlo con el sistema
 * anterior antes de activar el barrio.
 *
 * **Cero JavaScript en la lectura**: la tabla es de servidor y el detalle mes por mes es un
 * `<details>`. Las únicas islas son los dos campos «Según el sistema anterior» (que no guardan ni
 * envían nada) y el diálogo de activación.
 *
 * **La tasa se prueba por la URL** (`?tasa=3,5`, porcentaje mensual): la página la valida con
 * `tasaDePorcentaje` y se la pasa al servicio en fracción; el interés lo calcula el servicio. Una tasa
 * que no se entiende se ignora y se avisa. En un barrio ya activado la tasa es la que quedó guardada.
 *
 * **Con el barrio ya activado es de solo lectura** (encargo 17b, punto 6) y se llama «Deuda anterior a
 * la activación»: a ella lleva el enlace del tablero. No hay «Cambiar la tasa», ni los campos «Según
 * el sistema anterior», ni «Activar el barrio»; muestra con qué tasa se activó, cuándo y quién, la
 * deuda que queda mes por mes y cómo se corrige con un ajuste. «Subir otra planilla» sigue solo
 * mientras el servicio diga que no se emitió ni hay cobros, y para quien administra el barrio.
 */
export default async function VerificarAntesDeActivar({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();
  const crudos = await searchParams;
  const tasaTipeada = typeof crudos["tasa"] === "string" && crudos["tasa"].trim() !== "" ? crudos["tasa"] : null;
  const tasaPedida = tasaTipeada === null ? null : tasaDePorcentaje(tasaTipeada);
  const tasaInvalida = tasaTipeada !== null && tasaPedida === null;

  const datos = await conSesion(async (tx) => {
    const barrio = await leerBarrio(tx, { barrioId });
    const estado = barrio ? await estadoDeLaActivacion(tx, { barrioId }) : null;
    if (!barrio || !estado) return null;
    return {
      barrio,
      estado,
      verificacion: await verificacionDeDeudaAnterior(tx, { barrioId, ...(tasaPedida !== null ? { tasa: tasaPedida } : {}) }),
    };
  });
  // `notFound()` afuera de la transacción (ADR-0002 §3.1).
  if (!datos) notFound();
  const { barrio, estado, verificacion } = datos;
  const rutas = rutasDeActivacion(barrio.id);

  const sinActivar = estado.activacion === "sin_activar";
  const esLaVigente = porcentajeDeTasa(verificacion.tasa) === porcentajeDeTasa(verificacion.tasaVigente);
  const yaNoSeReemplaza = estado.yaEmitio || estado.conCobros;
  // Activado pasando por la activación: la pantalla es de solo lectura.
  const soloLectura = !sinActivar;
  const activado = lineaDeActivado(estado);
  const diaDelInteres = formatearFecha(verificacion.fecha);

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={
          soloLectura
            ? [migaDelBarrio(barrio), { texto: DEUDA_ANTERIOR_A_LA_ACTIVACION }]
            : [migaDelBarrio(barrio), { texto: "Activar el barrio", href: rutas.tablero }, { texto: "Verificar" }]
        }
        titulo={soloLectura ? DEUDA_ANTERIOR_A_LA_ACTIVACION : "Verificar antes de activar"}
        bajada={
          soloLectura
            ? `${barrio.nombre} · lo que el barrio trajo de antes de activarse y todavía se debe, mes por mes.`
            : `${barrio.nombre} · lo que quedó cargado de la deuda anterior, para comparar con el sistema anterior.`
        }
        acciones={
          <Boton href={rutas.tablero} variante="secundario">
            Volver al tablero
          </Boton>
        }
      />

      {activado ? <Nota tono="info" titulo={`${activado}.`} /> : null}
      {tasaInvalida ? (
        <Nota tono="alerta" titulo="La tasa pedida no se entiende.">
          Tiene que ser un porcentaje mensual entre 0 y 100, con hasta cuatro decimales (3 o 3,5). Se muestra con{" "}
          {tasaEnPalabras(verificacion.tasa)}.
        </Nota>
      ) : null}

      {estado.deudaAnterior === null && soloLectura ? (
        // Un barrio que ya estaba activo de antes: no pasó por la activación y no hay nada que mostrar.
        <Nota tono="neutro" titulo="Este barrio no tiene deuda anterior cargada.">
          No pasó por la activación: lo que cada unidad debe está en <a href={`/${barrio.id}/cobros`}>los cobros del barrio</a>.
        </Nota>
      ) : estado.deudaAnterior === null ? (
        <Nota tono="alerta" titulo="Falta resolver la deuda anterior.">
          Subí la planilla de deuda o decí que el barrio no trae deuda, desde <a href={rutas.tablero}>el tablero</a>.
        </Nota>
      ) : estado.deudaAnterior === "sin_deuda" ? (
        <Nota tono="neutro" titulo={soloLectura ? "El barrio no trajo deuda." : "El barrio no trae deuda."}>
          {soloLectura
            ? "Al activar quedó dicho que ninguna unidad debía meses anteriores ni tenía saldo a favor."
            : "Quedó dicho que ninguna unidad debe meses anteriores ni tiene saldo a favor al activar."}
        </Nota>
      ) : (
        <>
          <Panel
            titulo={soloLectura ? "Lo que queda de la deuda anterior" : "Lo que quedó cargado"}
            origen={
              soloLectura
                ? `Capital: lo que todavía falta pagar de cada mes de la planilla. Interés: el que lleva devengado al ${diaDelInteres}.`
                : `Capital: lo que falta pagar de cada mes de la planilla. Interés: de cada vencimiento al ${diaDelInteres}, con la tasa de abajo. Lo que escribas para comparar no se guarda.`
            }
          >
            <div className={estilos.cifras}>
              <div className={estilos.cifraParaComparar}>
                <Dato etiqueta="Capital adeudado" grande origen={`${verificacion.unidades.length === 1 ? "1 unidad" : `${verificacion.unidades.length} unidades`} con deuda anterior`}>
                  <Cifra monto={verificacion.capital} nulo="—" />
                </Dato>
                {soloLectura ? null : (
                  <CompararConElSistemaAnterior nombre="comparar-capital" delSistema={verificacion.capital} queSeCompara="el capital adeudado" />
                )}
              </div>
              <div className={estilos.cifraParaComparar}>
                <Dato
                  etiqueta={`Interés al ${diaDelInteres.slice(0, 5)}`}
                  grande
                  origen={
                    soloLectura
                      ? "hasta el día de la activación, con la tasa de abajo; desde el día siguiente, con los parámetros del barrio"
                      : `con una tasa del ${tasaEnPalabras(verificacion.tasa)}`
                  }
                >
                  <Cifra monto={verificacion.interes} nulo="—" />
                </Dato>
                {soloLectura ? null : (
                  <CompararConElSistemaAnterior nombre="comparar-interes" delSistema={verificacion.interes} queSeCompara="el interés" />
                )}
              </div>
            </div>
          </Panel>

          <Panel
            titulo="Tasa para la deuda anterior"
            origen={
              soloLectura
                ? "Con esta tasa devengó la deuda anterior de cada vencimiento al día de la activación. Desde el día siguiente, con los parámetros del barrio. Se eligió al activar y no se vuelve a tocar."
                : "Con esta tasa devenga la deuda anterior de cada vencimiento al día de la activación. Desde el día siguiente, con los parámetros del barrio. Se elige al activar y no se vuelve a tocar."
            }
          >
            <div className={estilos.tasa}>
              <Dato
                etiqueta={sinActivar ? "Tasa en uso en esta pantalla" : "Tasa con que se activó"}
                grande
                origen={
                  esLaVigente
                    ? "es la tasa vigente del barrio"
                    : `no es la vigente del barrio (${tasaEnPalabras(verificacion.tasaVigente)})${
                        sinActivar ? ": al activar se pide el motivo" : estado.motivoDeLaTasa ? ` · motivo: ${estado.motivoDeLaTasa}` : ""
                      }`
                }
              >
                <span className="dinero">{tasaEnPalabras(verificacion.tasa)}</span>
              </Dato>
              {sinActivar && estado.puedeActivar ? (
                <AccionDesplegable texto="Cambiar la tasa">
                  {/* Un GET a esta misma pantalla: recalcula con la otra tasa, sin escribir nada. */}
                  <form method="get" action={rutas.verificar} className={estilos.formularioDeTasa}>
                    <CampoTexto
                      nombre="tasa"
                      etiqueta="Tasa mensual (%)"
                      requerido
                      maximo={9}
                      modoDeTeclado="decimal"
                      valorInicial={porcentajeDeTasa(verificacion.tasa)}
                      ayuda={`Porcentaje mensual: 3 o 3,5. La vigente del barrio es ${tasaEnPalabras(verificacion.tasaVigente)}.`}
                    />
                    <Boton tipo="submit" variante="secundario">
                      Recalcular con esta tasa
                    </Boton>
                    {esLaVigente ? null : (
                      <Boton href={rutas.verificar} variante="sutil">
                        Volver a la vigente
                      </Boton>
                    )}
                  </form>
                </AccionDesplegable>
              ) : null}
            </div>
          </Panel>

          <Panel
            titulo="Por unidad"
            origen={
              soloLectura
                ? `Debe = capital + interés al ${diaDelInteres}. El detalle mes por mes es lo que vino en la planilla y todavía se debe.`
                : `Debe = capital + interés al ${diaDelInteres}. El detalle mes por mes es lo que vino en la planilla.`
            }
            sinRelleno
          >
            <MarcoTabla etiqueta="Deuda anterior por unidad">
              <Tabla>
                <thead>
                  <tr>
                    <th scope="col" className={ui.columnaAncla}>
                      Unidad
                    </th>
                    <th scope="col" className={ui.numerica}>
                      Debe
                    </th>
                    <th scope="col" className={ui.numerica}>
                      Capital
                    </th>
                    <th scope="col" className={ui.numerica}>
                      Interés
                    </th>
                    <th scope="col">Mes por mes</th>
                  </tr>
                </thead>
                <tbody>
                  {verificacion.unidades.map((u) => (
                    <tr key={u.unidadFuncionalId}>
                      <th scope="row" className={ui.columnaAncla}>
                        {u.unidad}
                      </th>
                      <td className={ui.numerica}>
                        <Cifra monto={sumarMontos(u.capital, u.interes)} nulo="—" />
                      </td>
                      <td className={ui.numerica}>
                        <Cifra monto={u.capital} nulo="—" />
                      </td>
                      <td className={ui.numerica}>
                        <Cifra monto={u.interes} nulo="—" />
                      </td>
                      <td>
                        <details className={estilos.detalleDeUnidad}>
                          <summary>{u.meses.length === 1 ? "Ver 1 mes" : `Ver ${u.meses.length} meses`}</summary>
                          <ul className={estilos.mesesDeLaUnidad}>
                            {u.meses.map((m) => (
                              <li key={m.liquidacionId}>
                                {formatearPeriodo(m.periodo)} · {m.concepto} · venció el {formatearFecha(m.vencimiento)} · capital{" "}
                                <Cifra monto={m.capital} nulo="—" /> · interés <Cifra monto={m.interes} nulo="—" />
                              </li>
                            ))}
                          </ul>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    <td className={ui.numerica}>
                      <Cifra monto={sumarMontos(verificacion.capital, verificacion.interes)} nulo="—" />
                    </td>
                    <td className={ui.numerica}>
                      <Cifra monto={verificacion.capital} nulo="—" />
                    </td>
                    <td className={ui.numerica}>
                      <Cifra monto={verificacion.interes} nulo="—" />
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </Tabla>
            </MarcoTabla>
          </Panel>

          {verificacion.saldosAFavor.length > 0 ? (
            <Panel
              titulo="Saldos a favor"
              origen="Lo que cada unidad trae a favor al activar. Queda registrado en su cuenta como un cobro sin imputar: todavía no se descuenta solo del cupón."
              sinRelleno
            >
              <MarcoTabla etiqueta="Saldos a favor al activar">
                <Tabla>
                  <thead>
                    <tr>
                      <th scope="col" className={ui.columnaAncla}>
                        Unidad
                      </th>
                      <th scope="col" className={ui.numerica}>
                        Saldo a favor
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {verificacion.saldosAFavor.map((s) => (
                      <tr key={s.unidadFuncionalId}>
                        <th scope="row" className={ui.columnaAncla}>
                          {s.unidad}
                        </th>
                        <td className={ui.numerica}>
                          <Cifra monto={s.importe} nulo="—" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Tabla>
              </MarcoTabla>
            </Panel>
          ) : null}
        </>
      )}

      {soloLectura && estado.deudaAnterior === null ? null : soloLectura ? (
        // Activado: la explicación la lee cualquiera que vea la pantalla; el botón, solo quien puede
        // y mientras el servicio diga que la planilla todavía se reemplaza.
        <Panel titulo="Cómo se corrige la deuda anterior">
          <p className={estilos.pasoDetalle}>{comoSeCorrigeYaActivado(!yaNoSeReemplaza && estado.puedeActivar)}</p>
          {!yaNoSeReemplaza && estado.puedeActivar ? (
            <div className={estilos.acciones}>
              <Boton href={rutas.deuda} variante="secundario">
                {estado.deudaAnterior === "cargada" ? "Subir otra planilla" : "Subir la planilla de deuda"}
              </Boton>
            </div>
          ) : null}
        </Panel>
      ) : estado.puedeActivar ? (
        // Sin activar: lo que se puede hacer desde acá. Ausente, no apagado, para quien no administra.
        <Panel titulo="Si coincide, activá el barrio">
          {yaNoSeReemplaza ? <p className={estilos.pasoDetalle}>{COMO_SE_CORRIGE_LA_DEUDA_ANTERIOR}</p> : null}
          <div className={estilos.acciones}>
            {yaNoSeReemplaza ? null : (
              <Boton href={rutas.deuda} variante="secundario">
                {estado.deudaAnterior === "cargada" ? "Subir otra planilla" : "Subir la planilla de deuda"}
              </Boton>
            )}
            {sePuedeVerificar(estado) ? (
              <BotonActivarBarrio
                barrioId={barrio.id}
                tasa={porcentajeDeTasa(verificacion.tasa)}
                pideMotivo={!esLaVigente}
                consecuencias={consecuenciasDeActivar({ ...estado, tasa: verificacion.tasa })}
                volverA={conListo(rutas.tablero, "barrio_activado")}
              />
            ) : null}
          </div>
          {!sePuedeVerificar(estado) ? (
            <p className={estilos.pasoDetalle}>
              Para activar faltan pasos anteriores: el padrón, los conceptos o la deuda anterior. Se ven en <a href={rutas.tablero}>el tablero</a>.
            </p>
          ) : null}
        </Panel>
      ) : null}
    </Pagina>
  );
}
