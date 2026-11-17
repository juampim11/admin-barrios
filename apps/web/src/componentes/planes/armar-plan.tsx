"use client";

/**
 * **Armar un plan de pagos** (P2a-2; maqueta de planes, pantallas 2 y 3): la isla de la pantalla. Dos
 * vistas de la misma unidad, con los mismos meses elegidos:
 *
 *   · **Del catálogo** (pantalla 2): se elige un plan acordado y el cronograma se ve en vivo mientras se
 *     arma. Al registrarlo queda vigente. Si los números se salen del plan (más cuotas, otro anticipo,
 *     una deuda sobre el tope), la pantalla lo dice y ofrece seguir **a medida** con ese cronograma.
 *   · **A medida** (pantalla 3): las fechas y los importes los carga la persona; el sistema solo suma,
 *     compara con la deuda y muestra cuánto se perdona, en pesos y en %. El motivo es obligatorio y el
 *     acta, solo si el barrio la exige para una quita. Queda pendiente de aprobación.
 *
 * Las dos formas viven montadas (la otra, oculta): pasar de una a otra no borra lo cargado.
 *
 * **Las cuentas no son de la pantalla:** el cronograma y el cuadre los hacen las funciones puras de
 * `@admin-barrios/shared/planes`, las mismas que usa el servidor. Al registrar, el servidor las vuelve a
 * hacer con la deuda de ese momento: esto es una vista previa.
 */

import { useMemo, useRef, useState } from "react";
import type { DatosParaArmarPlan } from "@admin-barrios/data/servicios/planes-armar";
import { aCentavos, restarMontos, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import { formatearFecha, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { CONTENT_TYPES_COMPROBANTE } from "@admin-barrios/shared/cobros";
import {
  CUOTAS_MAXIMAS_PLAN,
  cronogramaDeCatalogo,
  cuadreAMedida,
  fueraDelCatalogo,
  PlanInvalido,
  textoDePorcentaje,
  validarCronograma,
  type CronogramaDePlan,
} from "@admin-barrios/shared/planes";
import {
  AvisoEnLinea,
  Boton,
  BotonesDeVista,
  CasillaDeFila,
  DosColumnas,
  RenglonDelResultado,
  TarjetaDelResultado,
} from "@admin-barrios/ui";
import { FechaEnCelda } from "@admin-barrios/ui/cliente/fecha-en-celda";
import { ImporteEnCelda } from "@admin-barrios/ui/cliente/importe-en-celda";
import { proponerPlanAMedidaAction, registrarPlanDelCatalogoAction } from "../../acciones/planes.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoArchivo,
  CampoMonto,
  CampoParrafo,
  CampoSeleccion,
  Campos,
  CampoTexto,
  Formulario,
  useFormulario,
} from "../formulario.tsx";
import { MarcoTabla, Panel, Tabla, ui } from "../ui.tsx";
import { useSubidaDeRespaldo } from "../useSubidaDeRespaldo.ts";
import {
  cronogramaDeLasFilas,
  filasCompletas,
  numerarFilas,
  opcionDelCatalogo,
  opcionesDeCuotas,
  pesos,
  rangoDeVencimientos,
  repartirLoQueFalta,
  resumenDelCatalogo,
  vencimientoDeLaSiguiente,
  type FilaAMedida,
} from "./armar.ts";

type Modo = "catalogo" | "medida";

const TIPOS_ACEPTADOS = CONTENT_TYPES_COMPROBANTE.join(",");

/** «17,3 %»: el porcentaje de la quita (`cuadreAMedida`), para leer. */
const porcentaje = (decimal: string) => `${textoDePorcentaje(decimal)} %`;

export function ArmarPlan({ datos, subidaConfigurada }: { readonly datos: DatosParaArmarPlan; readonly subidaConfigurada: boolean }) {
  const { catalogo, meses, reglas, hoy } = datos;
  // Las claves de las filas, por instancia: un contador de módulo daría una en el servidor y otra en el
  // navegador (el `name` de la celda no coincidiría al hidratar).
  const contador = useRef(0);
  const nuevaClave = () => `fila-${++contador.current}`;
  const [modo, setModo] = useState<Modo>(catalogo.length > 0 ? "catalogo" : "medida");
  const [elegidos, setElegidos] = useState<ReadonlySet<string>>(() => new Set(meses.map((m) => m.liquidacionId)));

  // ── La deuda que entra (los meses elegidos) ──────────────────────────────────────────────────
  const seleccion = meses.filter((m) => elegidos.has(m.liquidacionId));
  const capital = sumarMontos("0.00", ...seleccion.map((m) => m.capital));
  const interes = sumarMontos("0.00", ...seleccion.map((m) => m.interes));
  const deuda = sumarMontos(capital, interes);
  const cuantos = seleccion.length === 1 ? "1 mes" : `${seleccion.length} meses`;
  const alternar = (id: string) =>
    setElegidos((antes) => {
      const despues = new Set(antes);
      if (despues.has(id)) despues.delete(id);
      else despues.add(id);
      return despues;
    });

  // ── Del catálogo: copias de los campos (los campos siguen no controlados) ──────────────────
  const primero = catalogo[0] ?? null;
  const [catalogoId, setCatalogoId] = useState(primero?.id ?? "");
  const plan = catalogo.find((c) => c.id === catalogoId) ?? null;
  const [cuotas, setCuotas] = useState(String(primero?.cuotasMax ?? 1));
  const [anticipo, setAnticipo] = useState("");
  const [vencimientoAnticipo, setVencimientoAnticipo] = useState(datos.vencimientoAnticipo);
  const [primerVencimiento, setPrimerVencimiento] = useState(datos.primerVencimiento);
  const [cobra, setCobra] = useState<string>(primero?.modoCobro ?? "barrio");
  const elegirPlan = (id: string) => {
    setCatalogoId(id);
    const nuevo = catalogo.find((c) => c.id === id);
    if (nuevo) {
      setCuotas(String(nuevo.cuotasMax));
      setCobra(nuevo.modoCobro);
    }
  };

  const anticipoMonto = anticipo !== "" && aCentavos(anticipo) > 0n ? (anticipo as Monto) : null;
  // Un entero de un desplegable de 1 a 60, no un importe (la regla 5 de arquitectura es sobre dinero).
  const cantidad = Number.parseInt(cuotas, 10) || 0;
  const vista = useMemo((): { readonly cronograma: CronogramaDePlan } | { readonly error: string } | null => {
    if (!plan || seleccion.length === 0) return null;
    try {
      const cronograma = cronogramaDeCatalogo({
        deuda,
        anticipo: anticipoMonto,
        cuotas: cantidad,
        primerVencimiento,
        ...(anticipoMonto ? { vencimientoAnticipo } : {}),
        sistema: plan.sistema,
        tasaMensual: plan.tasaMensual,
        mora: interes,
        financiaMora: reglas.financiaMora,
      });
      if (cronograma.cuotas.some((c) => c.vencimiento <= hoy)) return { error: "Las cuotas tienen que vencer después de hoy." };
      return { cronograma };
    } catch (e) {
      if (e instanceof PlanInvalido) return { error: `${e.message}.` };
      throw e;
    }
  }, [plan, seleccion.length, deuda, anticipoMonto, cantidad, primerVencimiento, vencimientoAnticipo, interes, reglas.financiaMora, hoy]);
  const fuera = plan && seleccion.length > 0 ? fueraDelCatalogo(plan, { deuda, cuotas: cantidad, anticipo: anticipoMonto }) : [];

  // ── A medida: las filas son estado de la isla ────────────────────────────────────────────────
  const [filas, setFilas] = useState<readonly FilaAMedida[]>(() => [
    { clave: nuevaClave(), anticipo: false, vencimiento: datos.primerVencimiento, importe: "" },
  ]);
  // Cambia cuando la isla reescribe los importes (repartir, pasar desde el catálogo): remonta las
  // celdas de importe, que son no controladas.
  const [version, setVersion] = useState(0);
  const cambiarFila = (clave: string, cambio: Partial<FilaAMedida>) => setFilas((fs) => fs.map((f) => (f.clave === clave ? { ...f, ...cambio } : f)));
  const quitarFila = (clave: string) => setFilas((fs) => fs.filter((f) => f.clave !== clave));
  const agregarCuota = () =>
    setFilas((fs) => [...fs, { clave: nuevaClave(), anticipo: false, vencimiento: vencimientoDeLaSiguiente(fs, datos.primerVencimiento), importe: "" }]);
  const agregarAnticipo = () =>
    setFilas((fs) => (fs.some((f) => f.anticipo) ? fs : [{ clave: nuevaClave(), anticipo: true, vencimiento: datos.vencimientoAnticipo, importe: "" }, ...fs]));
  const repartir = () => {
    setFilas((fs) => repartirLoQueFalta(fs, deuda));
    setVersion((v) => v + 1);
  };
  const pasarAMedida = () => {
    if (vista && "cronograma" in vista) {
      setFilas(vista.cronograma.cuotas.map((c) => ({ clave: nuevaClave(), anticipo: c.numero === 0, vencimiento: c.vencimiento, importe: c.importe })));
      setVersion((v) => v + 1);
    }
    setModo("medida");
  };

  const completas = filasCompletas(filas);
  const numeros = numerarFilas(filas);
  const cantidadDeCuotas = filas.filter((f) => !f.anticipo).length;
  const tieneAnticipo = filas.some((f) => f.anticipo);
  const cuadre = seleccion.length > 0 && completas.length > 0 ? cuadreAMedida({ capital, interes }, completas) : null;
  const problemaDelCronograma = (() => {
    if (completas.length < filas.length) return "Completá la fecha y el importe de cada cuota.";
    try {
      validarCronograma(completas);
    } catch (e) {
      if (e instanceof PlanInvalido) return `${e.message}.`;
      throw e;
    }
    // `<=`: la firma exige que cada cuota venza después del día en que se firma (también hoy).
    return completas.some((c) => c.vencimiento <= hoy) ? "Las cuotas tienen que vencer después de hoy." : null;
  })();
  const hayQuita = cuadre !== null && aCentavos(cuadre.quitaTotal) > 0n;
  const pideActa = reglas.quitaRequiereActa && hayQuita;

  // ── Los dos formularios ──────────────────────────────────────────────────────────────────────
  // Al registrar, la acción lleva a la ficha desde el servidor (`redirect`): no hay que navegar acá.
  const delCatalogo = useFormulario(registrarPlanDelCatalogoAction);
  const aMedida = useFormulario(proponerPlanAMedidaAction);
  const subida = useSubidaDeRespaldo(datos.barrio.id);
  const subiendo = subida.estado.fase === "pidiendoUrl" || subida.estado.fase === "subiendo";

  const mesesOcultos = seleccion.map((m) => <input key={m.liquidacionId} type="hidden" name="liquidacionIds" value={m.liquidacionId} />);
  const erroresDeMeses = delCatalogo.campos["liquidacionIds"] ?? aMedida.campos["liquidacionIds"];
  const erroresDelCronograma = Object.entries(aMedida.campos)
    .filter(([k]) => k.startsWith("cronograma"))
    .flatMap(([, v]) => v ?? []);

  const queEntra = (
    <Panel
      titulo="1 · Qué entra"
      origen={`Capital e interés por mora de cada mes vencido, al ${formatearFecha(hoy)}. El interés sigue corriendo hasta que se registra el plan.`}
      sinRelleno
      pie={
        <>
        {datos.sinVencer.length > 0
          ? `${datos.sinVencer.map((p) => nombreDelPeriodo(p)).join(", ")} todavía no ${datos.sinVencer.length === 1 ? "venció" : "vencieron"}: sigue en la boleta como expensa del mes. `
          : ""}
        Los honorarios del estudio no entran.
      </>
      }
    >
      <MarcoTabla etiqueta="Meses que entran al plan">
        <Tabla>
          <thead>
            <tr>
              <th scope="col">
                <span className={ui.soloLectores}>Incluir</span>
              </th>
              <th scope="col" className={ui.columnaAncla}>
                Mes
              </th>
              <th scope="col" className={ui.numerica}>
                Capital
              </th>
              <th scope="col" className={ui.numerica}>
                Interés al {formatearFecha(hoy).slice(0, 5)}
              </th>
              <th scope="col" className={ui.numerica}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {meses.map((m) => (
              <tr key={m.liquidacionId}>
                <td>
                  <CasillaDeFila
                    etiqueta={`Incluir ${nombreDelPeriodo(m.periodo)} en el plan`}
                    marcada={elegidos.has(m.liquidacionId)}
                    alCambiar={() => alternar(m.liquidacionId)}
                  />
                </td>
                <th scope="row" className={ui.columnaAncla}>
                  {nombreDelPeriodo(m.periodo)}
                </th>
                <td className={ui.numerica}>{pesos(m.capital)}</td>
                <td className={ui.numerica}>{pesos(m.interes)}</td>
                <td className={ui.numerica}>{pesos(sumarMontos(m.capital, m.interes))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <th scope="row" className={ui.columnaAncla}>
                {cuantos}
              </th>
              <td className={ui.numerica}>{pesos(capital)}</td>
              <td className={ui.numerica}>{pesos(interes)}</td>
              <td className={ui.numerica}>{pesos(deuda)}</td>
            </tr>
          </tfoot>
        </Tabla>
      </MarcoTabla>

      {erroresDeMeses ? <AvisoDeCamposSueltos mensajes={erroresDeMeses} /> : null}
    </Panel>
  );

  // ── Pantalla 2: del catálogo ─────────────────────────────────────────────────────────────────
  const opcionesDeCobro = plan?.estudio
    ? [
        { valor: "estudio", texto: `${plan.estudio.nombre}, y le rinde al barrio` },
        { valor: "barrio", texto: "El barrio, en la boleta" },
      ]
    : [{ valor: "barrio", texto: "El barrio, en la boleta" }];

  const formularioDelCatalogo = (
    <Formulario accion={delCatalogo.enviar} etiqueta="Registrar un plan del catálogo">
      <input type="hidden" name="unidadFuncionalId" value={datos.unidad.id} />
      {mesesOcultos}
      <DosColumnas
        principal={
          <>
            <Panel titulo="2 · Plan" origen={plan ? resumenDelCatalogo(plan) : undefined}>
              <Campos>
                <CampoSeleccion
                  nombre="catalogoId"
                  etiqueta="Plan del catálogo"
                  requerido
                  ancho
                  opciones={catalogo.map((c) => ({ valor: c.id, texto: opcionDelCatalogo(c) }))}
                  sinSeleccion="Elegí un plan…"
                  valorInicial={catalogoId}
                  alCambiar={elegirPlan}
                  errores={delCatalogo.campos["catalogoId"]}
                />
                {plan ? (
                  <CampoSeleccion
                    key={`cuotas-${plan.id}`}
                    nombre="cuotas"
                    etiqueta="Cuotas"
                    requerido
                    opciones={opcionesDeCuotas(plan)}
                    sinSeleccion="Cuántas…"
                    valorInicial={cuotas}
                    alCambiar={setCuotas}
                    errores={delCatalogo.campos["cuotas"]}
                  />
                ) : null}
                <CampoMonto
                  nombre="anticipo"
                  etiqueta="Anticipo"
                  valorInicial={anticipo}
                  alCambiar={setAnticipo}
                  errores={delCatalogo.campos["anticipo"]}
                  ayuda={plan?.anticipo === "no" ? "Este plan no lleva anticipo: con uno, pasa a ser a medida." : "Dejalo vacío si no hay anticipo."}
                />
                {anticipoMonto ? (
                  <CampoTexto
                    nombre="vencimientoAnticipo"
                    etiqueta="El anticipo vence"
                    tipo="date"
                    requerido
                    minimo={datos.manana}
                    valorInicial={vencimientoAnticipo}
                    alCambiar={setVencimientoAnticipo}
                    errores={delCatalogo.campos["vencimientoAnticipo"]}
                  />
                ) : null}
                <CampoTexto
                  nombre="primerVencimiento"
                  etiqueta="Primera cuota vence"
                  tipo="date"
                  requerido
                  minimo={datos.manana}
                  valorInicial={primerVencimiento}
                  alCambiar={setPrimerVencimiento}
                  errores={delCatalogo.campos["primerVencimiento"]}
                  ayuda="Se propone con la boleta del mes que viene. Las demás, el mismo día de cada mes."
                />
                {plan ? (
                  <CampoSeleccion
                    key={`cobra-${plan.id}`}
                    nombre="modoCobro"
                    etiqueta="Quién cobra"
                    requerido
                    opciones={opcionesDeCobro}
                    sinSeleccion="Elegí…"
                    valorInicial={cobra}
                    alCambiar={setCobra}
                    errores={delCatalogo.campos["modoCobro"]}
                    ayuda={plan.estudio ? `El plan dice: ${plan.modoCobro === "estudio" ? "cobra el estudio" : "cobra el barrio"}.` : undefined}
                  />
                ) : null}
              </Campos>
            </Panel>
            <Panel titulo="3 · Cronograma" origen="Se arma solo con lo que elegiste, y cambia en vivo." sinRelleno>
              {vista && "cronograma" in vista ? (
                <MarcoTabla etiqueta="Cuotas del plan">
                  <Tabla>
                    <thead>
                      <tr>
                        <th scope="col" className={ui.columnaAncla}>
                          Cuota
                        </th>
                        <th scope="col">Vence</th>
                        <th scope="col" className={ui.numerica}>
                          Capital
                        </th>
                        <th scope="col" className={ui.numerica}>
                          Interés
                        </th>
                        <th scope="col" className={ui.numerica}>
                          Importe
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {vista.cronograma.cuotas.map((c) => (
                        <tr key={c.numero}>
                          <th scope="row" className={ui.columnaAncla}>
                            {c.numero === 0 ? "Anticipo" : `${c.numero} de ${vista.cronograma.cuotas.filter((x) => x.numero > 0).length}`}
                          </th>
                          <td>{formatearFecha(c.vencimiento)}</td>
                          <td className={ui.numerica}>{pesos(c.capital)}</td>
                          <td className={ui.numerica}>{pesos(c.interes)}</td>
                          <td className={ui.numerica}>{pesos(c.importe)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Tabla>
                </MarcoTabla>
              ) : (
                <p className={ui.secundaria}>
                  {seleccion.length === 0
                    ? "Elegí al menos un mes."
                    : !plan
                      ? "Elegí un plan del catálogo."
                      : vista && "error" in vista
                        ? vista.error
                        : "Completá los datos del plan."}
                </p>
              )}
            </Panel>
          </>
        }
        lateral={
          <>
            {vista && "cronograma" in vista ? (
              <TarjetaDelResultado
                titulo="Total del plan"
                resultado={pesos(vista.cronograma.total)}
                lectura={`${vista.cronograma.cuotas.filter((c) => c.numero > 0).length} cuotas de ${pesos(vista.cronograma.cuotas.find((c) => c.numero > 0)?.importe ?? "0.00")}; la última ajusta los centavos. ${rangoDeVencimientos(vista.cronograma.cuotas)}`}
              >
                <RenglonDelResultado etiqueta={`Deuda que entra (${cuantos})`} valor={pesos(deuda)} />
                {vista.cronograma.cuotas[0]?.numero === 0 ? (
                  <RenglonDelResultado etiqueta="Anticipo" valor={pesos(vista.cronograma.cuotas[0].importe)} />
                ) : null}
                <RenglonDelResultado
                  etiqueta={plan?.sistema === "frances" ? `Interés de financiación (${plan.tasaPorcentaje} % mensual)` : "Interés de financiación"}
                  valor={pesos(vista.cronograma.interesFinanciacion)}
                  origen={
                    plan?.sistema === "frances"
                      ? reglas.financiaMora
                        ? "Sobre el capital y el interés por mora: el barrio financia el interés por mora."
                        : "Solo sobre el capital: el interés por mora entra en partes iguales, sin recargo."
                      : "Cuota fija, sin interés."
                  }
                />
              </TarjetaDelResultado>
            ) : null}
            <div role="status">
            {plan && seleccion.length > 0 ? (
              fuera.length === 0 ? (
                <AvisoEnLinea tono="exito">
                  Está dentro del plan acordado{plan.estudio ? ` con ${plan.estudio.nombre}` : ""}: queda vigente al registrarlo.
                </AvisoEnLinea>
              ) : (
                <AvisoEnLinea tono="alerta">
                  <strong>Fuera del plan del catálogo.</strong> {fuera.join(" ")} Así pasa a ser un plan a medida: queda pendiente
                  hasta que lo apruebe la administración.
                  <br />
                  <Boton tipo="button" tamano="sm" alTocar={pasarAMedida} deshabilitado={!vista || "error" in vista}>
                    Seguir a medida con estas cuotas
                  </Boton>
                </AvisoEnLinea>
              )
            ) : null}
            </div>
            <Panel titulo="Al registrar">
              <ul className={ui.secundaria}>
                <li>{seleccion.length === 1 ? "El mes pasa al plan y deja de generar mora." : "Los meses elegidos pasan al plan y dejan de generar mora."}</li>
                {datos.derivadaA ? <li>La unidad sale de {datos.derivadaA} (motivo «plan de pagos») y de «para derivar».</li> : null}
              </ul>
              <Avisos>{delCatalogo.resultado.estado === "falla" ? <AvisoDeFallo error={delCatalogo.resultado.error} /> : null}</Avisos>
              <Acciones ayuda={fuera.length > 0 ? "Está fuera del plan del catálogo: seguí a medida para mandarlo a aprobar." : undefined}>
                <BotonEnviar pendiente={delCatalogo.pendiente} deshabilitado={fuera.length > 0 || !vista || "error" in vista} cargando="Registrando…">
                  Registrar el plan
                </BotonEnviar>
              </Acciones>
            </Panel>
          </>
        }
      />
    </Formulario>
  );

  // ── Pantalla 3: a medida ─────────────────────────────────────────────────────────────────────
  const formularioAMedida = (
    <Formulario accion={aMedida.enviar} etiqueta="Proponer un plan a medida">
      <input type="hidden" name="unidadFuncionalId" value={datos.unidad.id} />
      <input type="hidden" name="cronograma" value={JSON.stringify(cronogramaDeLasFilas(filas))} />
      {mesesOcultos}
      <DosColumnas
        principal={
          <>
            <Panel
              titulo="2 · Cronograma"
              origen="Las fechas y los importes los cargás vos: cualquier cantidad de cuotas, con o sin anticipo."
              sinRelleno
              pie={
                <>
                  <Boton tipo="button" tamano="sm" alTocar={agregarCuota} deshabilitado={cantidadDeCuotas >= CUOTAS_MAXIMAS_PLAN}>
                    Agregar una cuota
                  </Boton>{" "}
                  {tieneAnticipo ? null : (
                    <Boton tipo="button" tamano="sm" variante="sutil" alTocar={agregarAnticipo}>
                      Agregar un anticipo
                    </Boton>
                  )}{" "}
                  <Boton tipo="button" tamano="sm" variante="sutil" alTocar={repartir} deshabilitado={seleccion.length === 0}>
                    Repartir lo que falta en cuotas iguales
                  </Boton>
                </>
              }
            >
              <MarcoTabla etiqueta="Cronograma a medida">
                <Tabla>
                  <thead>
                    <tr>
                      <th scope="col" className={ui.columnaAncla}>
                        Cuota
                      </th>
                      <th scope="col">Vence</th>
                      <th scope="col" className={ui.numerica}>
                        Importe
                      </th>
                      <th scope="col">
                        <span className={ui.soloLectores}>Quitar</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filas.map((f, i) => {
                      const nombre = f.anticipo ? "el anticipo" : `la cuota ${numeros[i]}`;
                      return (
                        <tr key={f.clave}>
                          <th scope="row" className={ui.columnaAncla}>
                            {f.anticipo ? "Anticipo" : numeros[i]}
                          </th>
                          <td>
                            <FechaEnCelda
                              rotulo={`Vencimiento de ${nombre}`}
                              valor={f.vencimiento}
                              minimo={datos.manana}
                              alCambiar={(v) => cambiarFila(f.clave, { vencimiento: v })}
                            />
                          </td>
                          <td className={ui.numerica}>
                            <ImporteEnCelda
                              key={`${f.clave}-${version}`}
                              rotulo={`Importe de ${nombre}`}
                              nombre={`importe-${f.clave}`}
                              valorInicial={f.importe}
                              alCambiar={(v) => cambiarFila(f.clave, { importe: v })}
                            />
                          </td>
                          <td>
                            {filas.length > 1 ? (
                              <Boton tipo="button" variante="sutil" tamano="sm" alTocar={() => quitarFila(f.clave)} etiqueta={`Quitar ${nombre}`}>
                                Quitar
                              </Boton>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Tabla>
              </MarcoTabla>
            </Panel>
            {erroresDelCronograma.length > 0 ? <AvisoDeCamposSueltos mensajes={erroresDelCronograma} /> : null}
            <Panel titulo="3 · El acuerdo">
              <Campos>
                <CampoSeleccion
                  nombre="cobro"
                  etiqueta="Quién cobra"
                  requerido
                  ancho
                  opciones={[
                    { valor: "barrio", texto: "El barrio, en la boleta" },
                    ...datos.estudios.map((e) => ({ valor: e.id, texto: `${e.nombre}, y le rinde al barrio` })),
                  ]}
                  sinSeleccion="Elegí…"
                  valorInicial={aMedida.previos["cobro"] ?? "barrio"}
                  errores={aMedida.campos["cobro"]}
                />
                <CampoParrafo
                  nombre="motivo"
                  etiqueta="Motivo del acuerdo"
                  requerido
                  ancho
                  maximo={1000}
                  filas={3}
                  valorInicial={aMedida.previos["motivo"]}
                  errores={aMedida.campos["motivo"]}
                  ayuda="Por qué se acepta este acuerdo. Queda en el plan y lo lee quien lo aprueba."
                />
              </Campos>
            </Panel>
          </>
        }
        lateral={
          <>
            <TarjetaDelResultado
              titulo={cuadre && cuadre.excede ? "Interés pactado" : "Se perdona"}
              resultado={
                cuadre
                  ? cuadre.excede
                    ? pesos(restarMontos(cuadre.financiado, deuda))
                    : `${pesos(cuadre.quitaTotal)} · ${porcentaje(cuadre.porcentajeQuita)}`
                  : "—"
              }
              negativo={hayQuita}
              lectura={
                cuadre
                  ? cuadre.excede
                    ? "El cronograma suma más que la deuda: lo de más es interés de financiación pactado."
                    : hayQuita
                      ? `Es el ${porcentaje(cuadre.porcentajeQuita)} de la deuda que entra. Se perdona primero la mora y después el capital.`
                      : "El cronograma cubre toda la deuda: no se perdona nada."
                  : "Cargá las cuotas para ver el cuadre."
              }
            >
              <RenglonDelResultado etiqueta={`Deuda que entra (${cuantos})`} valor={pesos(deuda)} origen={`Capital ${pesos(capital)} y mora ${pesos(interes)}.`} />
              <RenglonDelResultado
                etiqueta={`Suma del cronograma (${tieneAnticipo ? `anticipo + ${cantidadDeCuotas}` : `${cantidadDeCuotas} ${cantidadDeCuotas === 1 ? "cuota" : "cuotas"}`})`}
                valor={cuadre ? pesos(cuadre.financiado) : "—"}
              />
              {hayQuita && cuadre ? (
                <>
                  <RenglonDelResultado etiqueta="· de interés" valor={pesos(cuadre.quitaInteres)} />
                  <RenglonDelResultado etiqueta="· de capital" valor={pesos(cuadre.quitaCapital)} />
                </>
              ) : null}
            </TarjetaDelResultado>
            <div role="status">
              {hayQuita && cuadre ? (
                pideActa ? (
                  <AvisoEnLinea tono="alerta">
                    {aCentavos(cuadre.quitaCapital) > 0n ? "Se perdona parte del capital" : "Se perdona parte del interés"}: {datos.barrio.nombre}{" "}
                    exige el acta de aprobación (de la comisión directiva, el directorio o la asamblea). Cargala ahora o al aprobar; sin
                    ella el plan queda pendiente.
                  </AvisoEnLinea>
                ) : (
                  <AvisoEnLinea tono="info">Se perdona una parte: lo aprueba la administración (el barrio no exige acta).</AvisoEnLinea>
                )
              ) : null}
            </div>
            {pideActa ? (
              <Panel titulo="Acta de aprobación">
                <Campos>
                  <CampoTexto
                    nombre="actaReferencia"
                    etiqueta="Referencia del acta"
                    maximo={300}
                    ancho
                    valorInicial={aMedida.previos["actaReferencia"]}
                    errores={aMedida.campos["actaReferencia"]}
                    ayuda="Número y fecha, o dónde se encuentra. Opcional ahora."
                  />
                  {subidaConfigurada ? (
                    <CampoArchivo
                      nombre="actaAdjunto"
                      etiqueta="El acta"
                      ancho
                      aceptar={TIPOS_ACEPTADOS}
                      estado={subida.estado}
                      onElegirArchivo={subida.elegirArchivo}
                      onReintentar={subida.reintentar}
                      errores={aMedida.campos["actaAdjunto"]}
                      ayuda="PDF o foto (JPG o PNG). Opcional."
                    />
                  ) : null}
                </Campos>
              </Panel>
            ) : null}
            <AvisoEnLinea tono="info">
              Queda marcado <strong>«A medida»</strong> y pendiente de aprobación. Hasta que se apruebe,
              {datos.derivadaA ? ` la unidad sigue derivada a ${datos.derivadaA} y` : ""} no cambia nada de su deuda.
            </AvisoEnLinea>
            <Avisos>{aMedida.resultado.estado === "falla" ? <AvisoDeFallo error={aMedida.resultado.error} /> : null}</Avisos>
            <Acciones
              ayuda={subiendo ? "Esperando que termine de subir el acta." : seleccion.length === 0 ? "Elegí al menos un mes." : (problemaDelCronograma ?? undefined)}
            >
              <BotonEnviar
                pendiente={aMedida.pendiente}
                deshabilitado={subiendo || seleccion.length === 0 || problemaDelCronograma !== null}
                cargando="Enviando…"
              >
                Enviar a aprobación
              </BotonEnviar>
            </Acciones>
          </>
        }
      />
    </Formulario>
  );

  return (
    <>
      <div>
        <BotonesDeVista
          etiqueta="Cómo se arma el plan"
          opciones={[
            { valor: "catalogo", texto: "Del catálogo", deshabilitada: catalogo.length === 0 },
            { valor: "medida", texto: "A medida" },
          ]}
          valor={modo}
          alCambiar={setModo}
        />
      </div>
      {catalogo.length === 0 ? <p className={ui.secundaria}>Este barrio no tiene planes del catálogo: se arma a medida.</p> : null}
      {/*
        Los meses van una sola vez y AFUERA de los dos formularios: la casilla es controlada, y el
        `form.reset()` de React 19 al terminar una acción la devolvería a marcada sin re-render (se vería
        marcado un mes que no entra). Adentro de cada formulario viajan solo los ocultos.
      */}
      {queEntra}
      <div hidden={modo !== "catalogo" || catalogo.length === 0}>{formularioDelCatalogo}</div>
      <div hidden={modo !== "medida"}>{formularioAMedida}</div>
    </>
  );
}
