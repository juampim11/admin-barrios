"use client";

/**
 * La isla de «Presupuesto del mes» (encargo 16c, pantalla 3 de la maqueta): la tabla de rubros con
 * sus importes, el margen y los totales, que se recalculan mientras se escribe, y el panel «Importe
 * del mes» al costado.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTA ISLA NO HACE
 *
 * - **No calcula plata con `number`.** Los totales se suman en centavos (`totalesDelPresupuesto`, con
 *   `sumarMontos`), y si el importe cubre el presupuesto lo dice `cubreElPresupuesto`, la misma función
 *   que usa el servicio.
 * - **No graba el importe del mes por un camino propio.** «Usar este importe» manda el formulario a
 *   `definirCuotaFijaAction`, la acción de Configuración → Cuota, con la misma confirmación
 *   (`PedidoDeConfirmacion`). El presupuesto propone; la cuota decide.
 * - **No decide quién puede.** La página solo monta la isla si el servicio dijo `editable`.
 *
 * Los campos de importe son NO controlados (como en todo el kit): el estado de acá es una copia para
 * mirar, que se repone desde lo que devolvió la acción después de cada envío.
 */

import { useEffect, useRef, useState } from "react";
import type { ImporteDelMes, RubroDelPresupuesto } from "@admin-barrios/data/servicios/presupuesto";
import { BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import { ImporteEnCelda } from "@admin-barrios/ui/cliente/importe-en-celda";
import type { CuotaFijaEscrita } from "@admin-barrios/data/servicios/cuota-fija";
import { DosColumnas, IconoMas } from "@admin-barrios/ui";
import { definirCuotaFijaAction } from "../../../../../../acciones/liquidacion.ts";
import { copiarPresupuestoAction, guardarPresupuestoAction } from "../../../../../../acciones/presupuesto.ts";
import { campoDelRubro } from "../../../../../../acciones/presupuesto-formulario.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  AvisoDeFalloCompacto,
  Avisos,
  BotonEnviar,
  CampoMonto,
  CampoSeleccion,
  CampoTexto,
  Campos,
  Formulario,
  PedidoDeConfirmacion,
  SoloLectores,
  useFormulario,
  type Salidas,
} from "../../../../../../componentes/formulario.tsx";
import { Cifra, MarcoTabla, Panel, Tabla, ui } from "../../../../../../componentes/ui.tsx";
import {
  cuentaDelImporte,
  descripcionDelImporte,
  elMes,
  enElMesAnterior,
  importePrecargado,
  rotuloDelImporte,
  totalesDelPresupuesto,
} from "./textos.ts";

type Fila = { readonly conceptoId: string; readonly nombre: string; readonly gastadoMesAnterior: string | null; readonly inicial: string };

const filasDe = (rubros: readonly RubroDelPresupuesto[]): Fila[] =>
  rubros.map((r) => ({ conceptoId: r.conceptoId, nombre: r.nombre, gastadoMesAnterior: r.gastadoMesAnterior, inicial: r.presupuesto ?? "" }));

export function EditorDelPresupuesto({
  periodoId,
  barrioId,
  periodo,
  mesAnterior,
  huella,
  rubros,
  paraAgregar,
  margen,
  gastoMesAnterior,
  sePuedeCopiar,
  importe,
  denominacion,
  salidas,
}: {
  readonly periodoId: string;
  readonly barrioId: string;
  /** `YYYY-MM` del mes y del anterior. */
  readonly periodo: string;
  readonly mesAnterior: string;
  /** Cambia cuando cambia el presupuesto guardado (al guardar o al copiar): repone las filas. */
  readonly huella: string;
  readonly rubros: readonly RubroDelPresupuesto[];
  readonly paraAgregar: readonly { readonly conceptoId: string; readonly nombre: string }[];
  readonly margen: string;
  readonly gastoMesAnterior: string;
  readonly sePuedeCopiar: boolean;
  /** `null` en un barrio cuyo importe sale de los gastos: ahí no hay panel. */
  readonly importe: ImporteDelMes | null;
  /** Cómo llama el barrio a lo que cobra, con mayúscula («Expensa», «Cuota social»). */
  readonly denominacion: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario<null>(guardarPresupuestoAction);

  const [filas, setFilas] = useState<Fila[]>(() => filasDe(rubros));
  const [montos, setMontos] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(rubros.map((r) => [r.conceptoId, r.presupuesto ?? ""])),
  );
  const [margenTipeado, setMargenTipeado] = useState(margen);
  const [sucio, setSucio] = useState(false);
  const [agregando, setAgregando] = useState(false);
  const [generacionDelSelector, setGeneracionDelSelector] = useState(0);

  // Lo guardado cambió (se guardó o se copió del mes anterior): las filas vuelven a ser las del servidor.
  const ultimaHuella = useRef(huella);
  useEffect(() => {
    if (ultimaHuella.current === huella) return;
    ultimaHuella.current = huella;
    setFilas(filasDe(rubros));
    setMontos(Object.fromEntries(rubros.map((r) => [r.conceptoId, r.presupuesto ?? ""])));
    setMargenTipeado(margen);
  }, [huella, rubros, margen]);

  // Después de cada envío React resetea el formulario a lo que volvió de la acción: la copia de los
  // importes se repone desde ahí, para que los totales digan lo mismo que los campos.
  const ultimo = useRef<unknown>(resultado);
  useEffect(() => {
    if (ultimo.current === resultado) return;
    ultimo.current = resultado;
    setSucio(false);
    if (resultado.estado === "ok" || resultado.estado === "inicial") return;
    setMontos((antes) =>
      Object.fromEntries(Object.keys(antes).map((id) => [id, previos[campoDelRubro(id)] ?? antes[id] ?? ""])),
    );
    setMargenTipeado(previos["margen"] ?? margen);
  }, [resultado, previos, margen]);

  const { gastoEsperado, totalAPedir } = totalesDelPresupuesto(
    filas.map((f) => montos[f.conceptoId] ?? ""),
    margenTipeado,
  );
  const disponibles = paraAgregar.filter((c) => !filas.some((f) => f.conceptoId === c.conceptoId));
  const mes = elMes(periodo);
  const anterior = elMes(mesAnterior);

  const cambiar = (conceptoId: string, valor: string) => {
    setMontos((antes) => ({ ...antes, [conceptoId]: valor }));
    setSucio(true);
  };
  const quitar = (conceptoId: string) => {
    setFilas((antes) => antes.filter((f) => f.conceptoId !== conceptoId));
    setSucio(true);
  };
  const agregar = (conceptoId: string) => {
    const concepto = paraAgregar.find((c) => c.conceptoId === conceptoId);
    if (!concepto) return;
    setFilas((antes) => [...antes, { conceptoId, nombre: concepto.nombre, gastadoMesAnterior: null, inicial: "" }]);
    setMontos((antes) => ({ ...antes, [conceptoId]: "" }));
    setGeneracionDelSelector((g) => g + 1);
    setAgregando(false);
    setSucio(true);
  };

  // Los errores de los rubros, con el nombre del rubro adelante: el campo en sí se marca en rojo.
  const erroresDeRubros = filas.flatMap((f) => (campos[campoDelRubro(f.conceptoId)] ?? []).map((m) => `${f.nombre}: ${m}`));
  const erroresSueltos = [...(campos[""] ?? []), ...(campos["rubros"] ?? []), ...erroresDeRubros];

  const tabla = (
    <Panel
      titulo="Lo que el barrio espera gastar"
      origen="Los rubros son los conceptos con los que se cargan los gastos. El presupuesto no cambia lo que se cobra: después se compara contra lo gastado, en «Gastos y pagos»."
      acciones={sePuedeCopiar ? <CopiarDelMesAnterior periodoId={periodoId} mesAnterior={anterior} salidas={salidas} /> : undefined}
      sinRelleno
    >
      <Formulario accion={enviar} etiqueta={`Presupuesto de ${mes}`}>
        <input type="hidden" name="periodoId" value={periodoId} />
        <MarcoTabla etiqueta={`Presupuesto de ${mes}`}>
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Rubro
                </th>
                <th scope="col" className={ui.numerica}>
                  Gastado en {anterior}
                </th>
                <th scope="col" className={ui.numerica}>
                  Presupuesto de {mes}
                </th>
                <th scope="col">
                  <SoloLectores>Quitar</SoloLectores>
                </th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <tr key={`${huella}:${f.conceptoId}`}>
                  <th scope="row" className={ui.columnaAncla}>
                    <span className={ui.principal}>{f.nombre}</span>
                  </th>
                  <td className={ui.numerica}>
                    <Cifra monto={f.gastadoMesAnterior} nulo="—" />
                  </td>
                  <td className={ui.numerica}>
                    <ImporteEnCelda
                      rotulo={`Presupuesto de ${mes} para ${f.nombre}`}
                      nombre={campoDelRubro(f.conceptoId)}
                      valorInicial={previos[campoDelRubro(f.conceptoId)] ?? f.inicial}
                      invalido={(campos[campoDelRubro(f.conceptoId)]?.length ?? 0) > 0}
                      alCambiar={(v) => cambiar(f.conceptoId, v)}
                    />
                  </td>
                  <td>
                    <BotonDeAccion variante="sutil" tamano="sm" etiqueta={`Quitar ${f.nombre} del presupuesto`} onClick={() => quitar(f.conceptoId)}>
                      Quitar
                    </BotonDeAccion>
                  </td>
                </tr>
              ))}
              {filas.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <span className={ui.secundaria}>Todavía no hay rubros. Agregá uno o copiá el presupuesto de {anterior}.</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className={ui.columnaAncla}>
                  Gasto esperado
                </th>
                <td className={ui.numerica}>
                  <Cifra monto={gastoMesAnterior} nulo="—" />
                </td>
                <td className={ui.numerica} aria-live="polite">
                  <Cifra monto={gastoEsperado} nulo="—" />
                </td>
                <td />
              </tr>
              <tr>
                <th scope="row" className={ui.columnaAncla}>
                  Margen sobre el gasto
                  <br />
                  <span className={ui.secundaria}>Para imprevistos y para lo que no se cobre a tiempo</span>
                </th>
                <td className={ui.numerica}>—</td>
                <td className={ui.numerica}>
                  <ImporteEnCelda
                    key={huella}
                    rotulo={`Margen sobre el gasto de ${mes}`}
                    nombre="margen"
                    valorInicial={previos["margen"] ?? margen}
                    invalido={(campos["margen"]?.length ?? 0) > 0}
                    alCambiar={(v) => {
                      setMargenTipeado(v);
                      setSucio(true);
                    }}
                  />
                </td>
                <td />
              </tr>
              <tr>
                <th scope="row" className={ui.columnaAncla}>
                  Total a pedir
                </th>
                <td className={ui.numerica}>—</td>
                <td className={ui.numerica} aria-live="polite">
                  <Cifra monto={totalAPedir} nulo="—" />
                </td>
                <td />
              </tr>
            </tfoot>
          </Tabla>
        </MarcoTabla>

        <Avisos>
          {resultado.estado === "ok" && !sucio ? <AvisoDeExito titulo={`Listo: el presupuesto de ${mes} quedó guardado.`} /> : null}
          {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
          {erroresSueltos.length > 0 ? <AvisoDeCamposSueltos mensajes={erroresSueltos} /> : null}
          {campos["margen"] ? <AvisoDeCamposSueltos mensajes={campos["margen"].map((m) => `Margen: ${m}`)} /> : null}
        </Avisos>

        <Acciones ayuda="Un rubro con el importe vacío no queda en el presupuesto. Guardar no cambia lo que se cobra.">
          {agregando && disponibles.length > 0 ? (
            <CampoSeleccion
              key={generacionDelSelector}
              nombre="_agregar"
              etiqueta="Rubro para agregar"
              opciones={disponibles.map((c) => ({ valor: c.conceptoId, texto: c.nombre }))}
              sinSeleccion="Elegí un rubro…"
              alCambiar={agregar}
            />
          ) : disponibles.length > 0 ? (
            <BotonDeAccion variante="sutil" onClick={() => setAgregando(true)}>
              <IconoMas /> Agregar un rubro
            </BotonDeAccion>
          ) : null}
          <BotonEnviar pendiente={pendiente} cargando="Guardando…">
            Guardar
          </BotonEnviar>
        </Acciones>
      </Formulario>
    </Panel>
  );

  return (
    <DosColumnas
      principal={tabla}
      lateral={
        importe ? (
          <PanelDelImporte
            barrioId={barrioId}
            periodo={periodo}
            mesAnterior={mesAnterior}
            importe={importe}
            totalAPedir={totalAPedir}
            denominacion={denominacion}
            salidas={salidas}
          />
        ) : undefined
      }
    />
  );
}

/** «Copiar de <mes anterior>»: un formulario aparte (no se puede anidar en el de guardar). */
function CopiarDelMesAnterior({
  periodoId,
  mesAnterior,
  salidas,
}: {
  readonly periodoId: string;
  readonly mesAnterior: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado } = useFormulario<{ readonly rubros: number }>(copiarPresupuestoAction);
  return (
    <Formulario accion={enviar} etiqueta={`Copiar el presupuesto de ${mesAnterior}`}>
      <input type="hidden" name="periodoId" value={periodoId} />
      <BotonEnviar tono="secundario" pendiente={pendiente} cargando="Copiando…">
        Copiar de {mesAnterior}
      </BotonEnviar>
      {resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} /> : null}
    </Formulario>
  );
}

/**
 * El panel «Importe del mes». Graba por **el mismo camino que la cuota del barrio**
 * (`definirCuotaFijaAction`), desde este mes, con la misma confirmación.
 */
function PanelDelImporte({
  barrioId,
  periodo,
  mesAnterior,
  importe,
  totalAPedir,
  denominacion,
  salidas,
}: {
  readonly barrioId: string;
  readonly periodo: string;
  readonly mesAnterior: string;
  readonly importe: ImporteDelMes;
  readonly totalAPedir: string;
  readonly denominacion: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion, volverACorregir } =
    useFormulario<CuotaFijaEscrita>(definirCuotaFijaAction);
  const porUnidad = importe.modo === "por_unidad";
  const campo = porUnidad ? "importe" : "total";
  const precargado = importePrecargado(importe);
  const [tipeado, setTipeado] = useState(previos[campo] ?? precargado);

  const ultimo = useRef<unknown>(resultado);
  useEffect(() => {
    if (ultimo.current === resultado) return;
    ultimo.current = resultado;
    if (resultado.estado === "ok" || resultado.estado === "inicial") return;
    setTipeado(previos[campo] ?? precargado);
  }, [resultado, previos, campo, precargado]);

  const cuenta = cuentaDelImporte({ modo: importe.modo, unidades: importe.unidades, importe: tipeado, totalAPedir });
  const antes = enElMesAnterior(importe.modo, mesAnterior, importe.mesAnterior);
  const mes = elMes(periodo);

  if (resultado.estado === "ok") {
    return (
      <Panel titulo="Importe del mes">
        <AvisoDeExito titulo={`Listo: el importe de ${mes} quedó definido.`}>
          {porUnidad && resultado.valor.importeUnico !== null ? (
            <>
              Desde {mes} cada una de las {resultado.valor.unidades} unidades paga <Cifra monto={resultado.valor.importeUnico} nulo="—" />, y el
              barrio factura <Cifra monto={resultado.valor.totalMensual} nulo="—" /> por mes.
            </>
          ) : (
            <>
              Desde {mes} el barrio pide <Cifra monto={resultado.valor.totalMensual} nulo="—" /> por mes en total.
            </>
          )}{" "}
          Quedó en la cuota del barrio, en Configuración, como cualquier otro cambio.
        </AvisoDeExito>
      </Panel>
    );
  }

  return (
    <Panel titulo="Importe del mes" origen="El presupuesto propone; decide la administración.">
      <Formulario accion={enviar} etiqueta={`Definir el importe de ${mes}`}>
        {confirmacion && resultado.estado === "confirmar" ? (
          <PedidoDeConfirmacion
            onVolver={volverACorregir}
            error={resultado.error}
            confirmacion={confirmacion}
            valores={resultado.valores}
            pendiente={pendiente}
          />
        ) : (
          <>
            {/* Los mismos campos que Configuración → Cuota: rige desde este mes, por unidad o en total. */}
            <input type="hidden" name="barrioId" value={barrioId} />
            <input type="hidden" name="forma" value={porUnidad ? "importe" : "total"} />
            <input type="hidden" name="rigeDesde" value={periodo} />
            <Campos>
              <CampoMonto
                nombre={campo}
                etiqueta={rotuloDelImporte(importe.modo, denominacion)}
                requerido
                ancho
                errores={campos[campo]}
                valorInicial={previos[campo] ?? precargado}
                alCambiar={setTipeado}
                ayuda={
                  importe.vigente === null
                    ? "Arranca con el importe que cubre el total a pedir."
                    : `Arranca con el que rige para ${mes}.`
                }
              />
              <CampoTexto
                nombre="descripcion"
                etiqueta="Qué lo aprobó"
                maximo={300}
                ancho
                errores={campos["descripcion"]}
                valorInicial={previos["descripcion"] ?? descripcionDelImporte(periodo)}
                ayuda="Es lo que se contesta cuando alguien pregunta de dónde salió el número."
              />
            </Campos>
            <div aria-live="polite">
              {cuenta ? (
                <p className={ui.principal}>
                  {cuenta.cuenta}. {cuenta.lectura}
                </p>
              ) : null}
              {antes ? <p className={ui.secundaria}>{antes}</p> : null}
            </div>
            <Avisos>
              {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
              {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
            </Avisos>
            <Acciones ayuda={`Rige desde ${mes}, igual que si se cargara en Configuración → Cuota. Nada de lo ya emitido cambia.`}>
              <BotonEnviar pendiente={pendiente} cargando="Guardando…">
                Usar este importe
              </BotonEnviar>
            </Acciones>
          </>
        )}
      </Formulario>
    </Panel>
  );
}
