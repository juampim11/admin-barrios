"use client";

/**
 * Las dos acciones del final del recorrido: **generar el borrador** y **emitir**.
 *
 * Están en el mismo archivo porque la diferencia entre las dos es la lección de la pantalla, y
 * separarlas la escondería:
 *
 * | | Generar el borrador | Emitir |
 * |---|---|---|
 * | ¿se puede repetir? | **sí**, borra y recalcula | **no**, nunca |
 * | ¿qué queda después? | el período sigue editable | el período queda **inmutable** |
 * | ceremonia | ninguna | casilla de acuse + verbo explícito |
 *
 * **Por eso generar no lleva confirmación y emitir sí.** Ponerle un diálogo a algo repetible enseña a
 * apretar "sí" sin leer, y esa costumbre después llega al botón que no tiene vuelta atrás. La
 * ceremonia vale justamente porque es escasa.
 *
 * Y la ceremonia de emitir **no duplica ninguna regla de negocio**: quién puede emitir, en qué estado
 * y con qué condiciones lo decide `app.validar_emision` en la base. La casilla es una condición de la
 * interfaz, sobre un campo que no existe en el dominio.
 */

import { useActionState } from "react";
import type { PeriodoEmitido, ResumenLiquidacion } from "@admin-barrios/data/servicios/liquidacion";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { emitirPeriodoAction, generarBorradorAction } from "../../../../../../acciones/liquidacion.ts";
import { confirmacionDe } from "../../../../../../acciones/confirmacion.ts";
import { INICIAL } from "../../../../../../acciones/resultado.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  BotonEnviar,
  Casilla,
  Formulario,
  PedidoDeConfirmacion,
  type Salidas,
} from "../../../../../../componentes/formulario.tsx";
import { Definicion, Definiciones } from "../../../../../../componentes/ui.tsx";
import estilos from "./revision.module.css";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Generar el borrador
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function BotonGenerarBorrador({
  periodoId,
  yaHayLiquidaciones,
  salidas,
}: {
  readonly periodoId: string;
  readonly yaHayLiquidaciones: boolean;
  readonly salidas: Salidas;
}) {
  const [resultado, enviar, pendiente] = useActionState(generarBorradorAction, INICIAL);

  return (
    <Formulario accion={enviar} etiqueta="Generar el borrador de liquidación del período">
      <input type="hidden" name="periodoId" value={periodoId} />

      <Avisos>
        {resultado.estado === "ok" ? <AcuseDelBorrador resumen={resultado.valor} /> : null}
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
        {resultado.estado === "campos" ? (
          <AvisoDeCamposSueltos mensajes={Object.values(resultado.campos).flatMap((m) => m ?? [])} />
        ) : null}
      </Avisos>

      <Acciones
        ayuda={
          yaHayLiquidaciones
            ? "Volver a generarlo borra las liquidaciones que están y las vuelve a calcular con los gastos y los cargos de ahora. Es seguro y se puede repetir todas las veces que haga falta."
            : "Reparte los gastos entre las unidades según su coeficiente, resuelve el importe de cada cargo y descuento, y deja una liquidación por unidad. Es reversible: se puede volver a generar."
        }
      >
        <BotonEnviar tono="primario" pendiente={pendiente} cargando="Calculando…">
          {yaHayLiquidaciones ? "Volver a generar el borrador" : "Generar el borrador"}
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

/**
 * El acuse del cálculo, con **las cifras que devolvió el servicio**, no con las que la pantalla ya
 * tenía en la mano. Es la diferencia entre "esto es lo que acaba de pasar" y "esto es lo que creo que
 * pasó": si el cálculo hizo algo distinto de lo esperado, acá se ve.
 */
function AcuseDelBorrador({ resumen }: { readonly resumen: ResumenLiquidacion }) {
  return (
    <AvisoDeExito titulo={`Se generaron ${resumen.unidadesLiquidadas} liquidaciones.`}>
      <Definiciones>
        <Definicion termino="Gastos del período">
          <span className="dinero">$ {formatearMonto(resumen.totalGastos)}</span>
        </Definicion>
        <Definicion termino="Repartido a las unidades">
          <span className="dinero">$ {formatearMonto(resumen.totalRepartido)}</span>
        </Definicion>
        <Definicion termino="Cargos aplicados">
          <span className="dinero">$ {formatearMonto(resumen.totalCargos)}</span>
        </Definicion>
        <Definicion termino="Descuentos aplicados">
          <span className="dinero">$ {formatearMonto(resumen.totalDescuentos)}</span>
        </Definicion>
      </Definiciones>
      {resumen.conMoraPendiente > 0 ? (
        <p>
          <strong>
            {resumen.conMoraPendiente} unidades quedaron con la mora pendiente de definición.
          </strong>{" "}
          El barrio no tenía tasa de mora vigente al liquidar y el sistema no inventa una: esas
          liquidaciones salieron sin interés calculado, y la boleta lo dice.
        </p>
      ) : null}
      {resumen.extraordinariasSinRespaldo > 0 ? (
        <p>
          <strong>
            {resumen.extraordinariasSinRespaldo} gastos extraordinarios entraron sin respaldo de
            asamblea.
          </strong>{" "}
          No bloquean la emisión, pero condicionan el reclamo de la deuda.
        </p>
      ) : null}
      <p>La grilla de abajo ya muestra el resultado. Recargá la pantalla si no la ves actualizada.</p>
    </AvisoDeExito>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Emitir
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Emitir. **Irreversible, y la pantalla lo dice antes y no después.**
 *
 * Tres cosas que están acá a propósito:
 *
 * **1. El objeto se nombra completo antes del botón** — barrio, mes, cuántas unidades, cuánto se va a
 * cobrar. El error más caro del dominio es emitir el período equivocado o el barrio equivocado, y la
 * defensa barata es que el botón esté al lado del nombre de lo que va a tocar (doc 06 §e.5).
 *
 * **2. La casilla de acuse.** No es ceremonia decorativa: la valida el servidor, y sin ella la acción
 * devuelve un error de campo. Un `required` de HTML no alcanza — es una sugerencia que cualquier POST
 * se saltea.
 *
 * **3. El botón peligroso no es el default del `Enter`.** Es el único control del formulario y está
 * después de la casilla, así que no hay ningún campo de texto desde donde un `Enter` distraído lo
 * dispare.
 */
export function FormularioDeEmision({
  periodoId,
  barrioNombre,
  mes,
  unidades,
  totalACobrar,
  salidas,
}: {
  readonly periodoId: string;
  readonly barrioNombre: string;
  readonly mes: string;
  readonly unidades: number;
  readonly totalACobrar: string | null;
  readonly salidas: Salidas;
}) {
  const [resultado, enviar, pendiente] = useActionState(emitirPeriodoAction, INICIAL);
  const campos = resultado.estado === "campos" ? resultado.campos : {};
  const confirmacion = resultado.estado === "confirmar" ? confirmacionDe(resultado.error.codigo) : null;

  if (resultado.estado === "ok") return <AcuseDeEmision emitido={resultado.valor} mes={mes} barrioNombre={barrioNombre} />;

  return (
    <Formulario accion={enviar} etiqueta="Emitir el período">
      <input type="hidden" name="periodoId" value={periodoId} />

      {confirmacion && resultado.estado === "confirmar" ? (
        <PedidoDeConfirmacion
          error={resultado.error}
          confirmacion={confirmacion}
          valores={resultado.valores}
          pendiente={pendiente}
        />
      ) : (
        <>
          <div className={estilos.loQueVaAPasar}>
            <p className={estilos.loQueVaAPasarTitulo}>
              Vas a emitir la liquidación de <strong>{barrioNombre}</strong> ·{" "}
              <strong className={estilos.mes}>{mes}</strong>.
            </p>
            <Definiciones>
              <Definicion termino="Boletas que quedan emitidas">{unidades}</Definicion>
              <Definicion termino="Total a cobrar">
                {totalACobrar === null ? (
                  <span className={estilos.sinDato}>sin liquidaciones</span>
                ) : (
                  <span className="dinero">$ {formatearMonto(totalACobrar)}</span>
                )}
              </Definicion>
            </Definiciones>
            <ul className={estilos.consecuencias}>
              <li>
                <strong>No se deshace.</strong> No hay botón de "desemitir" ni lo va a haber: si hace
                falta corregir algo, se registra en el período siguiente.
              </li>
              <li>
                El período queda <strong>inmutable</strong>: no se le cargan más gastos, no se aplican
                ni se anulan cargos, y el borrador no se puede volver a generar.
              </li>
              <li>
                La base valida el cierre antes de aceptar: que el mes cuadre, que estén todas las
                unidades, que la versión de coeficientes esté cerrada. Si algo no da, rechaza y no
                pasa nada.
              </li>
              <li>
                Queda firmado con <strong>tu identidad</strong> y la hora del servidor. La firma la
                escribe la base, no esta pantalla.
              </li>
            </ul>
          </div>

          <Casilla nombre="entiendo" valor="si" errores={campos["entiendo"]}>
            Entiendo que la emisión no se deshace y que el período queda inmutable.
          </Casilla>

          <Avisos>
            {resultado.estado === "falla" ? (
              <AvisoDeFallo error={resultado.error} salidas={salidas} />
            ) : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>

          <Acciones ayuda="Antes de apretar, conviene mirar la grilla de abajo: es exactamente lo que va a salir en cada boleta.">
            <BotonEnviar tono="peligro" pendiente={pendiente} cargando="Emitiendo…">
              Emitir {mes} definitivamente
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}

/**
 * La firma, con lo que devolvió `emitirPeriodo` y **sin volver a consultar**: el dato que se muestra
 * es el que la base acaba de escribir.
 *
 * `emitidaAt` va **tal como lo entrega Postgres**, en monoespaciada y sin reformatear. No es dejadez:
 * es un `timestamptz`, y recortarlo a una fecha para imprimirla bonita es exactamente el error que
 * la regla 7 del test de arquitectura existe para evitar — después de las 21:00 ART el día ya cambió
 * en UTC. Para una firma de auditoría, el sello crudo vale más que la versión linda.
 */
function AcuseDeEmision({
  emitido,
  mes,
  barrioNombre,
}: {
  readonly emitido: PeriodoEmitido;
  readonly mes: string;
  readonly barrioNombre: string;
}) {
  return (
    <AvisoDeExito titulo={`${barrioNombre} · ${mes} quedó emitido.`}>
      <Definiciones>
        <Definicion termino="Momento de la emisión">
          <code className={estilos.sello}>{emitido.emitidaAt}</code>
        </Definicion>
        <Definicion termino="Firmado por">
          <code className={estilos.sello}>{emitido.emitidaPor}</code>
        </Definicion>
      </Definiciones>
      <p>
        El período ya no se edita. Recargá la pantalla para verlo en su estado nuevo. La generación de
        los PDF todavía no está en esta versión: el estado del período no depende de que esos
        documentos existan.
      </p>
    </AvisoDeExito>
  );
}
