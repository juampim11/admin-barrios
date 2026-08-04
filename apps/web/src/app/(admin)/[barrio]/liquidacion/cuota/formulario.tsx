"use client";

/**
 * Definir la cuota del mes que viene.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EL PORCENTAJE ES LA FORMA PRINCIPAL Y EL IMPORTE LA EXCEPCIÓN
 *
 * Un directorio no decide "que la cuota sea $383.904": decide **"le damos el 3,2 %"**, casi siempre
 * atado a la paritaria del rubro que más pesa. Pedir el importe absoluto obliga a hacer la cuenta
 * afuera —en el Excel del que se trata de salir— y a tipear un número que ya estaba determinado, con
 * el error de tipeo multiplicado por todas las unidades del barrio.
 *
 * El importe directo **no desaparece**: es lo que se carga en el primer período, cuando no hay contra
 * qué aplicar un porcentaje, y cuando el ajuste se fija en pesos. Por eso son dos formas del mismo
 * acto y no dos pantallas.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LA VISTA PREVIA NO ES UNA SEGUNDA ARITMÉTICA
 *
 * La regla del proyecto es que la pantalla no calcula dinero (doc 08 §AC punto 1): dos aritméticas
 * distintas terminan siempre en un vecino reclamando. Acá se muestra el resultado **antes** de
 * confirmar, y no la contradice, porque no hay una segunda cuenta: se llama a `ajustarCuota`, la
 * misma función pura de `@admin-barrios/shared/liquidacion` que después ejecuta el servicio. Es la
 * misma línea de código corriendo dos veces, no dos implementaciones que pueden divergir.
 *
 * Y hace falta que se vea antes, por una razón que no es de comodidad: **el redondeo cambia lo que se
 * cobra**. Elegir "centena" sobre 510 unidades mueve plata real. Un control que decide eso sin
 * mostrar su efecto es un control que se completa por inercia.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTA PANTALLA NO HACE
 *
 * **No divide los gastos por las unidades.** Es el modelo de cuota fija: la cuota la fija el
 * directorio y el sistema avisa si alcanza (esa alerta vive en el resumen del período). Un campo que
 * dijera "total de gastos a repartir" sería el otro modelo, y este barrio no liquida así.
 */

import { useEffect, useRef, useState } from "react";
import type { CuotaFijaEscrita, CuotaFijaVigente } from "@admin-barrios/data/servicios/cuota-fija";
import {
  ajustarCuota,
  evaluarSuficienciaDeLaCuota,
  type RedondeoDeCuota,
} from "@admin-barrios/shared/liquidacion";
import { esPorcentajeDeAjusteValido } from "@admin-barrios/shared/escrituras";
import { definirCuotaFijaAction } from "../../../../../acciones/liquidacion.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  BotonEnviar,
  CampoMonto,
  CampoSeleccion,
  CampoTexto,
  Campos,
  Formulario,
  PedidoDeConfirmacion,
  useFormulario,
  type Opcion,
  type Salidas,
} from "../../../../../componentes/formulario.tsx";
import { Cifra, Nota } from "../../../../../componentes/ui.tsx";
import estilos from "./cuota.module.css";

/** Cómo se dice cada redondeo en la pantalla, con el ejemplo que lo hace entendible sin pensar. */
const REDONDEOS: readonly Opcion[] = [
  { valor: "peso", texto: "Al peso — 383.904,37 → 383.904" },
  { valor: "centena", texto: "A la centena — 383.904,37 → 383.900" },
  { valor: "mil", texto: "Al mil — 383.904,37 → 384.000" },
  { valor: "centavo", texto: "Al centavo — no redondear" },
] satisfies readonly { valor: RedondeoDeCuota; texto: string }[];

/**
 * Vista previa de lo que va a quedar. Solo aparece cuando hay **una sola cuota** en el barrio: con
 * importes distintos por unidad no hay un número que mostrar, y elegir uno sería mentir sobre las
 * demás. En ese caso la pantalla lo dice con palabras y muestra el efecto sobre el total.
 */
function VistaPrevia({
  vigente,
  porcentaje,
  redondeo,
}: {
  readonly vigente: CuotaFijaVigente;
  readonly porcentaje: string;
  readonly redondeo: RedondeoDeCuota | "";
}) {
  if (redondeo === "" || vigente.importeUnico === null) return null;
  /*
   * **El mismo predicado que usa el borde, no una copia.** La primera versión copiaba solo la regex,
   * y el resultado era que con `9999` la pantalla afirmaba "el barrio pasa a facturar
   * 19.674.871.800,00 por mes" y el servidor lo rechazaba. Una regla copiada es una regla que en
   * algún momento diverge; `esPorcentajeDeAjusteValido` se exporta justamente para que acá no haya
   * una segunda versión de nada.
   */
  if (!esPorcentajeDeAjusteValido(porcentaje)) return null;

  const a = ajustarCuota({ cuotaVigente: vigente.importeUnico, porcentaje: porcentaje.trim(), redondeo });
  // El total no se multiplica acá: sale de `evaluarSuficienciaDeLaCuota`, que es la misma función que
  // calcula el «total a devengar» del resumen del período. Dos lugares que muestran la misma cifra
  // tienen que salir de la misma cuenta, o uno de los dos va a mentir.
  const totalMensual = evaluarSuficienciaDeLaCuota({
    cuota: a.nueva,
    unidadesActivas: vigente.unidadesActivas,
    gastoDevengado: "0.00",
    moraEstimada: "0",
  }).totalADevengar;

  return (
    <div className={estilos.previa} aria-live="polite">
      <div className={estilos.previaCifras}>
        <div className={estilos.previaCelda}>
          <span className={estilos.previaEtiqueta}>Cuota de hoy</span>
          <Cifra monto={vigente.importeUnico} nulo="—" />
        </div>
        <span className={estilos.previaFlecha} aria-hidden="true">
          →
        </span>
        <div className={estilos.previaCelda}>
          <span className={estilos.previaEtiqueta}>Cuota nueva</span>
          <strong className={estilos.previaNueva}>
            <Cifra monto={a.nueva} nulo="—" />
          </strong>
        </div>
        <div className={estilos.previaCelda}>
          <span className={estilos.previaEtiqueta}>Diferencia</span>
          <Cifra monto={a.diferencia} nulo="—" signo />
        </div>
      </div>

      {a.nueva === "0.00" ? (
        <Nota tono="alerta" titulo="Con esto la cuota queda en cero.">
          El barrio deja de facturarles a las {vigente.unidadesActivas} unidades. Se puede hacer —hay
          que confirmarlo—, pero tené en cuenta que <strong>de cero no se sale con un porcentaje</strong>:
          cualquier aumento sobre cero sigue dando cero. Para volver, hay que cargar un importe.
        </Nota>
      ) : null}

      <p className={estilos.previaDetalle}>
        La cuenta exacta da <Cifra monto={a.sinRedondear} nulo="—" />
        {a.efectoDelRedondeo === "0.00" ? (
          <> y el redondeo elegido no la mueve.</>
        ) : (
          <>
            {" "}
            y el redondeo la mueve <Cifra monto={a.efectoDelRedondeo} nulo="—" signo /> por unidad —{" "}
            <strong>eso es plata</strong>: en {vigente.unidadesActivas} unidades no es un detalle de
            formato.
          </>
        )}{" "}
        Con esta cuota el barrio pasa a facturar <Cifra monto={totalMensual} nulo="—" /> por mes
        ({vigente.unidadesActivas} unidades).
      </p>
    </div>
  );
}

export function FormularioDeCuota({
  barrioId,
  vigente,
  proximoMes,
  salidas,
}: {
  readonly barrioId: string;
  readonly vigente: CuotaFijaVigente;
  /** Primer día del mes que viene: el valor por omisión de "desde cuándo rige". */
  readonly proximoMes: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion, volverACorregir } =
    useFormulario<CuotaFijaEscrita>(definirCuotaFijaAction);

  /*
   * Qué forma está elegida. Es lo único que este componente decide, y no calcula nada: qué campos se
   * dibujan. Sin cuota vigente **no hay elección posible** —un porcentaje sobre nada no existe—, así
   * que arranca (y se queda) en `importe`.
   */
  const puedeAjustarPorPorcentaje = vigente.versionId !== null && vigente.unidadesSinImporte === 0;
  const [forma, setForma] = useState<"porcentaje" | "importe">(
    puedeAjustarPorPorcentaje ? "porcentaje" : "importe",
  );
  const [porcentaje, setPorcentaje] = useState(previos["porcentaje"] ?? "");
  /*
   * Después de cada acción, React 19 hace `form.reset()`: el DOM vuelve a los `defaultChecked` /
   * `defaultValue` que el servidor acaba de devolver, pero **el estado de React no se entera**. Sin
   * esto, un reintento fallido dejaba los dos radios sin marcar mientras los campos del porcentaje
   * seguían dibujados — el formulario contradiciéndose sobre cómo se define la cuota. Es el mismo
   * efecto que ya tiene la pantalla de cargos con el concepto elegido.
   */
  const ultimo = useRef<unknown>(resultado);
  // `""` hasta que se elige: sin redondeo elegido no hay vista previa, y eso es correcto — la cifra
  // que se muestra depende de esa decisión.
  const [redondeo, setRedondeo] = useState<RedondeoDeCuota | "">(
    (previos["redondeo"] as RedondeoDeCuota | undefined) ?? "",
  );

  useEffect(() => {
    if (ultimo.current === resultado) return;
    ultimo.current = resultado;
    setPorcentaje(previos["porcentaje"] ?? "");
    setRedondeo((previos["redondeo"] as RedondeoDeCuota | undefined) ?? "");
    setForma(previos["forma"] === "importe" || !puedeAjustarPorPorcentaje ? "importe" : "porcentaje");
  }, [resultado, previos, puedeAjustarPorPorcentaje]);

  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo="La cuota quedó definida.">
        {resultado.valor.importeUnico !== null ? (
          <>
            Desde ahora cada una de las {resultado.valor.unidades} unidades paga{" "}
            <Cifra monto={resultado.valor.importeUnico} nulo="—" />, y el barrio factura{" "}
            <Cifra monto={resultado.valor.totalMensual} nulo="—" /> por mes.
          </>
        ) : (
          <>
            Quedaron {resultado.valor.unidades} unidades con importes distintos, que suman{" "}
            <Cifra monto={resultado.valor.totalMensual} nulo="—" /> por mes.
          </>
        )}{" "}
        La versión anterior se cerró sola: los períodos ya liquidados siguen mostrando la cuota que
        regía entonces.
      </AvisoDeExito>
    );
  }

  return (
    <Formulario accion={enviar} etiqueta="Definir la cuota del barrio">
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
          {/* Un alta no tiene fila de la que derivar el barrio. No autoriza nada: lo decide la RLS. */}
          <input type="hidden" name="barrioId" value={barrioId} />
          <input type="hidden" name="forma" value={forma} />

          {puedeAjustarPorPorcentaje ? (
            <fieldset className={estilos.formas}>
              <legend className={estilos.formasTitulo}>Cómo se define la cuota nueva</legend>
              <label className={estilos.forma}>
                {/*
                  `defaultChecked` **además** de `checked`: sin él, el `form.reset()` de React 19
                  devolvería los dos radios a "sin marcar" (que es el default de un radio sin
                  `defaultChecked`) y el estado quedaría diciendo otra cosa.
                */}
                <input
                  type="radio"
                  name="_forma"
                  checked={forma === "porcentaje"}
                  defaultChecked={forma === "porcentaje"}
                  onChange={() => setForma("porcentaje")}
                />
                <span className={estilos.formaTexto}>
                  <strong>Aumentarla un porcentaje</strong>
                  <span className={estilos.formaDetalle}>
                    Lo habitual: el directorio decide un %, el sistema hace la cuenta.
                  </span>
                </span>
              </label>
              <label className={estilos.forma}>
                <input
                  type="radio"
                  name="_forma"
                  checked={forma === "importe"}
                  defaultChecked={forma === "importe"}
                  onChange={() => setForma("importe")}
                />
                <span className={estilos.formaTexto}>
                  <strong>Cargar el importe</strong>
                  <span className={estilos.formaDetalle}>
                    Cuando el número se fijó en pesos y no como porcentaje.
                  </span>
                </span>
              </label>
            </fieldset>
          ) : null}

          <Campos>
            {forma === "porcentaje" ? (
              <>
                <CampoTexto
                  nombre="porcentaje"
                  etiqueta="Aumento (%)"
                  requerido
                  modoDeTeclado="decimal"
                  errores={campos["porcentaje"]}
                  valorInicial={previos["porcentaje"]}
                  alCambiar={setPorcentaje}
                  ayuda="Con punto decimal: 3.2 es tres coma dos por ciento. Puede ser negativo si la cuota baja, hasta −100."
                />
                {/*
                  Sin valor por omisión, igual que todo `CampoSeleccion` del kit y por un motivo que
                  acá es más fuerte que en ningún otro campo: **redondear cambia lo que se cobra**.
                  Que la primera opción quede elegida sola sería el sistema decidiendo, en silencio,
                  cuánta plata se mueve en quinientas boletas.
                */}
                <CampoSeleccion
                  nombre="redondeo"
                  etiqueta="Redondear la cuota nueva"
                  requerido
                  opciones={REDONDEOS}
                  sinSeleccion="Elegí cómo redondear…"
                  errores={campos["redondeo"]}
                  valorInicial={previos["redondeo"]}
                  alCambiar={(v) => setRedondeo(v as RedondeoDeCuota)}
                  ayuda="No es formato: cambia lo que se le cobra a cada unidad. Abajo se ve el efecto exacto."
                />
              </>
            ) : (
              <CampoMonto
                nombre="importe"
                etiqueta="Cuota mensual por unidad"
                requerido
                errores={campos["importe"]}
                valorInicial={previos["importe"]}
                ayuda={
                  vigente.importeUnico === null && vigente.versionId !== null
                    ? "Atención: este importe se le aplica a TODAS las unidades activas, e iguala las que hoy pagan distinto."
                    : "Lo que va a pagar cada unidad activa del barrio, todos los meses, hasta que se defina otra."
                }
              />
            )}

            <CampoTexto
              nombre="vigenteDesde"
              tipo="date"
              etiqueta="Rige desde"
              requerido
              errores={campos["vigenteDesde"]}
              valorInicial={previos["vigenteDesde"] ?? proximoMes}
              ayuda="Se aplica a los períodos que se liquiden desde esta fecha. Los ya emitidos no se tocan."
            />
            <CampoTexto
              nombre="descripcion"
              etiqueta="Qué la aprobó"
              maximo={300}
              errores={campos["descripcion"]}
              valorInicial={previos["descripcion"]}
              ayuda="«Acta de directorio 112», «Resolución del administrador». Es lo que se contesta cuando alguien pregunta de dónde salió el número."
            />
          </Campos>

          {forma === "porcentaje" ? (
            <VistaPrevia vigente={vigente} porcentaje={porcentaje} redondeo={redondeo} />
          ) : null}

          <Avisos>
            {forma === "importe" && vigente.importeUnico === null && vigente.versionId !== null ? (
              <Nota tono="alerta" titulo="Hoy no todas las unidades pagan lo mismo.">
                Cargar un importe las iguala a todas. Si lo que querés es mantener las diferencias,
                usá el aumento por porcentaje: se aplica sobre lo que paga cada una.
              </Nota>
            ) : null}
            {resultado.estado === "falla" ? (
              <AvisoDeFallo error={resultado.error} salidas={salidas} />
            ) : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>

          <Acciones ayuda="La cuota anterior se cierra sola con esta misma fecha. Nada de lo ya emitido cambia: cada período conserva la cuota que regía cuando se liquidó.">
            <BotonEnviar pendiente={pendiente} cargando="Definiendo la cuota…">
              Definir la cuota
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}
