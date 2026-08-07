"use client";

/**
 * El alta de un período.
 *
 * **Cinco campos, y dos que no están.** No hay `estado` —un período nace en `borrador` por trigger
 * (`app.periodo_nace_en_borrador`), y ofrecer el campo sería dibujar un control que la base pisa— ni
 * versión de coeficientes, que la fija el borrador con la versión cerrada y vigente del barrio.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL MODELO AHORA SE ELIGE ACÁ, Y ANTES NO SE ELEGÍA EN NINGÚN LADO
 *
 * Este comentario decía que no había campo `modelo` porque *"la cuota fija necesita una versión de
 * cuotas cargada que en este incremento no tiene pantalla"*. Esa pantalla existe desde el
 * 2026-08-04, y mientras tanto el descarte había dejado un defecto: sin campo, la columna se quedaba
 * con su `default 'variable'` y **todo mes creado desde acá nacía repartiendo gastos**, aunque el
 * barrio cobrara un valor fijo. En un barrio de valor fijo eso además escondía el acceso al valor,
 * porque el listado lo muestra según el modelo de los períodos que existen. Estaba tapado porque los
 * períodos del barrio de demostración los sembraba un script.
 *
 * **Por qué se ofrece el modelo aunque el barrio no tenga un valor cargado** —y por qué el que venga
 * después no lo "arregle" bloqueando el alta—: el acceso a la pantalla del valor aparece solo cuando
 * el barrio ya tiene algún período de valor fijo. Bloquear el alta hasta que haya valor cargado
 * dejaría al barrio sin forma de empezar: no podría crear el período porque falta el valor, y no
 * podría cargar el valor porque falta el período. Se avisa, no se impide. Quien de verdad frena esto
 * es la base, más adelante y donde la pregunta se puede contestar bien: `generarLiquidaciones()`
 * rechaza con `periodo_incompleto` y `app.validar_emision` lo vuelve a mirar al emitir.
 *
 * **Tampoco es un pedido de confirmación.** Acá no falla nada: el mes se crea bien. La confirmación
 * explícita (`acciones/confirmacion.ts`) existe para lo que el servidor descubre recién al ejecutar
 * sobre una cifra que se multiplica por todas las unidades. Ponerle esa ceremonia a algo repetible
 * enseña a apretar "sí" sin leer, y esa costumbre después llega al botón de emitir.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * **Los vencimientos no tienen valor por omisión, y eso es a propósito.** En la operatoria real se
 * cargan después, cuando el barrio decide la fecha, y un período sin vencimiento se puede liquidar
 * igual. Poner "el 10 del mes que viene" por default sería que el sistema decida una fecha que
 * después sale impresa en la boleta de doscientas familias.
 */

import { useEffect, useRef, useState } from "react";
import type { ModeloExpensa } from "@admin-barrios/shared/liquidacion";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { crearPeriodoAction } from "../../../../../acciones/liquidacion.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeFallo,
  BotonEnviar,
  CampoOpciones,
  CampoParrafo,
  CampoTexto,
  Campos,
  Formulario,
  PedidoDeConfirmacion,
  useFormulario,
  type OpcionExtensa,
  type Salidas,
} from "../../../../../componentes/formulario.tsx";
import { deLaX } from "../../../../../componentes/etiquetas.tsx";
import { Nota } from "../../../../../componentes/ui.tsx";

export function FormularioDePeriodo({
  barrioId,
  denominacion,
  ultimoPeriodo,
  tieneCuotaFijaDefinida,
  salidas,
}: {
  readonly barrioId: string;
  /** Cómo llama este barrio a lo que cobra: "expensa", "cuota social", "aporte". */
  readonly denominacion: string;
  /** El período más reciente, de donde sale la marca inicial. `null` en el primer período. */
  readonly ultimoPeriodo: { readonly periodo: string; readonly modelo: ModeloExpensa } | null;
  /** El barrio definió alguna vez un valor fijo. Hecho del barrio, no regla de vigencia. */
  readonly tieneCuotaFijaDefinida: boolean;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion, volverACorregir } =
    useFormulario(crearPeriodoAction);

  /*
   * **Copia de lo elegido, para mirar.** La fuente de verdad sigue siendo el DOM del radio, que es no
   * controlado (ver `CampoOpciones`). Esto existe solo para decidir si se dibuja el aviso de "todavía
   * no hay valor cargado", y se repone cuando la acción responde: el remonte del `<fieldset>` devuelve
   * el DOM a lo que trajo el servidor, pero no toca este estado.
   */
  const marcaInicial = (previos["modelo"] as ModeloExpensa | undefined) ?? ultimoPeriodo?.modelo ?? "";
  const [modelo, setModelo] = useState<ModeloExpensa | "">(marcaInicial);
  const ultimoResultado = useRef<unknown>(resultado);
  useEffect(() => {
    if (ultimoResultado.current === resultado) return;
    ultimoResultado.current = resultado;
    setModelo(marcaInicial);
  }, [resultado, marcaInicial]);

  /*
   * Las dos opciones, con el renglón que dice qué implica cada una. Las palabras salen de la pantalla
   * del valor de la expensa —"reparte los gastos del mes, no cobra un valor fijo"— para no inventar
   * un tercer vocabulario, y se dice **valor** y nunca "cuota": `cuota_fija` es el nombre del modelo
   * de cálculo, no el de lo que se cobra.
   */
  const opciones: readonly OpcionExtensa[] = [
    {
      valor: "variable",
      titulo: "Repartir los gastos del mes",
      detalle:
        "Lo que paga cada unidad sale de los gastos que se carguen en ese mes, repartidos por su " +
        "coeficiente. Sin gastos cargados no hay nada que repartir.",
    },
    {
      valor: "fija",
      titulo: "Cobrar un valor fijo por unidad",
      detalle:
        `Cada unidad paga el valor ${deLaX(denominacion)} que rige para ese mes, el que fijó el ` +
        "directorio o la administración. Los gastos se registran igual, pero no cambian lo que se cobra.",
    },
  ];

  return (
    <Formulario accion={enviar} etiqueta="Crear un período de liquidación">
      {confirmacion && resultado.estado === "confirmar" ? (
        <PedidoDeConfirmacion onVolver={volverACorregir}
          error={resultado.error}
          confirmacion={confirmacion}
          valores={resultado.valores}
          pendiente={pendiente}
        />
      ) : (
        <>
          {/*
            El barrio va acá porque un alta no tiene ninguna fila de la que derivarlo. No autoriza
            nada: quién puede crear períodos en ese barrio lo decide la policy de `insert` de
            `periodo_expensa`, que exige rol de gestión (ADR-0002 §3.4).

            Va **adentro de esta rama** y no afuera: en el pedido de confirmación lo reemite
            `PedidoDeConfirmacion` desde los valores, y con los dos presentes había dos campos con el
            mismo nombre. `valoresDe` se queda con el último, así que ganaba el del intento anterior
            en vez del que acaba de renderizar el servidor — lo contrario de lo que este comentario
            promete.
          */}
          <input type="hidden" name="barrioId" value={barrioId} />

          {/*
            El modelo va **arriba de todo y afuera de `<Campos>`**: es lo que le da sentido a los
            demás campos, no uno más de la lista. Sin período anterior no viene marcado nada —el
            campo es obligatorio y el servidor lo exige igual—, porque ahí no hay criterio del que
            tomarlo y elegir por la persona sería el sistema decidiendo cómo se cobra un barrio que
            recién empieza.
          */}
          <CampoOpciones
            nombre="modelo"
            etiqueta="Cómo se calcula lo que paga cada unidad"
            requerido
            opciones={opciones}
            errores={campos["modelo"]}
            valorInicial={marcaInicial || undefined}
            alCambiar={(v) => setModelo(v as ModeloExpensa)}
            ayuda={
              ultimoPeriodo
                ? `Viene marcado el modelo con el que se liquidó ${formatearPeriodo(ultimoPeriodo.periodo)}. Se puede cambiar: se guarda en este período, no en el barrio, y los meses ya liquidados no se tocan.`
                : "Es el primer período de este barrio: no hay uno anterior del que tomar el criterio. Se guarda en este período, no en el barrio."
            }
          />

          {/*
            Aparece por interacción, así que va con `aria-live`: quien usa lector de pantalla tiene
            que enterarse de que eligió una opción que necesita un dato que falta.

            ⚠ **El contenedor existe SIEMPRE, aunque esté vacío**, y la condición va adentro. Un
            `aria-live` que nace junto con su contenido **no lo anuncia**: el navegador tiene que
            haber visto la región antes de que cambie. Es la misma razón por la que `Avisos` está
            construido así, y la primera versión de esto lo tenía al revés — el comentario prometía
            un anuncio que el código no hacía.

            Tono informativo y no de alerta —no falló nada y el mes se crea igual— y **sin enlace a
            la pantalla del valor**: hoy esa pantalla, en un barrio sin valor y sin ningún período de
            valor fijo, muestra el estado vacío del otro modelo. El camino correcto se cierra solo al
            revés — una vez creado el período, el resumen ya ofrece "Ver o ajustar el valor".
          */}
          <div aria-live="polite">
            {modelo === "fija" && !tieneCuotaFijaDefinida ? (
              <Nota
                tono="info"
                titulo={`Este barrio todavía no tiene un valor ${deLaX(denominacion)} cargado.`}
              >
                El mes se crea igual, pero el borrador no se va a poder generar hasta que haya un
                valor que rija para ese período: en este modelo lo que se cobra sale de ese valor, no
                de los gastos. Se carga desde el período, apenas quede creado.
              </Nota>
            ) : null}
          </div>

          <Campos>
            <CampoTexto
              nombre="periodo"
              tipo="month"
              etiqueta="Mes que se liquida"
              requerido
              errores={campos["periodo"]}
              valorInicial={previos["periodo"]}
              ayuda={
                /*
                 * **Los dos textos dicen cosas distintas porque el mes significa cosas distintas.**
                 *
                 * El texto único decía *"el mes al que corresponden los gastos, **no el mes en que se
                 * cobra**"*, y el usuario marcó el 2026-08-05 que en su barrio eso es falso: se
                 * liquida abril, en abril, con vencimiento en abril. Y no es una particularidad del
                 * piloto — se desprende del modelo. Prorrateando no se puede saber cuánto paga cada
                 * unidad hasta que el mes cerró, así que el cobro cae después; con un valor fijo el
                 * importe ya estaba decidido y el mes se factura dentro de sí mismo.
                 *
                 * O sea que la aclaración "no el mes en que se cobra" **solo corresponde en el modelo
                 * variable**. Es exactamente el error de la regla 6: un texto que explica *cuándo* se
                 * cobra, escrito mirando un solo modelo.
                 */
                modelo === "fija"
                  ? "El mes que se está cobrando. Es lo que sale impreso en la boleta, lo que ordena el listado, y lo que decide qué valor se aplica: se toma el que rige para ese mes. El vencimiento puede caer dentro del mismo mes."
                  : "El mes al que corresponden los gastos, no el mes en que se cobra: prorrateando, el mes se liquida una vez que cerró. Es lo que sale impreso en la boleta y lo que ordena el listado."
              }
            />
            <CampoTexto
              nombre="primerVencimiento"
              tipo="date"
              etiqueta="Primer vencimiento"
              errores={campos["primerVencimiento"]}
              valorInicial={previos["primerVencimiento"]}
              ayuda="Se puede dejar vacío y cargarlo después: un período sin vencimiento se liquida igual."
            />
            <CampoTexto
              nombre="segundoVencimiento"
              tipo="date"
              etiqueta="Segundo vencimiento"
              errores={campos["segundoVencimiento"]}
              valorInicial={previos["segundoVencimiento"]}
              ayuda="El de recargo, si el barrio lo usa. No puede ser anterior al primero."
            />
            <CampoParrafo
              nombre="notas"
              etiqueta="Notas internas"
              maximo={2000}
              ancho
              errores={campos["notas"]}
              valorInicial={previos["notas"]}
              ayuda="Para el equipo de administración. No sale en la boleta."
            />
          </Campos>

          <Avisos>
            {resultado.estado === "falla" ? (
              <AvisoDeFallo error={resultado.error} salidas={salidas} />
            ) : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>

          {/*
            La segunda oración es un hecho verificado, no una advertencia de estilo: `periodos.ts`
            exporta una sola escritura (`crearPeriodo`) y no hay pantalla ni servicio que edite un
            período. Va al lado del botón porque es el último momento en que sirve saberlo. El día
            que exista editar el modelo en borrador, esta oración se cae — y esa caída es la señal
            de que hay que volver a mirar este texto.
          */}
          <Acciones ayuda="El período nace en borrador: se puede editar, cargar gastos y volver a calcularlo tantas veces como haga falta hasta que se emita. El modelo es la excepción: una vez creado el período, hoy no hay dónde cambiarlo.">
            <BotonEnviar pendiente={pendiente} cargando="Creando el período…">
              Crear el período
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}
