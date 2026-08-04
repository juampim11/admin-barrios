"use client";

/**
 * Aplicar un cargo o un descuento a una unidad, y anular uno ya aplicado.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LAS TRES COSAS DEL DOMINIO QUE ESTA PANTALLA NO PUEDE ROMPER
 *
 * **1. El importe no se conoce al aplicar, y la pantalla no lo inventa.** `aplicarConceptoAUnidad`
 * devuelve `importeEstimado` **calculado por la base**, con `app.cbu_importe_bruto()` — la misma y
 * única definición de la aritmética que usa el cálculo real y el `CHECK`. En un descuento porcentual
 * vuelve **`null`**, no cero: ese importe sale de la base de cálculo de la liquidación de esa unidad,
 * que todavía no existe. Acá no hay una sola multiplicación: cuando no hay número, se dice que se
 * conoce al liquidar. Dos aritméticas distintas terminan siempre en un vecino reclamando (doc 08 §AC
 * punto 1).
 *
 * **2. Un cargo no se edita. Se anula con motivo y se carga de nuevo.** Editar destruiría la
 * evidencia de qué se aprobó, así que el registro es append-only y la anulación es irreversible. La
 * interfaz no ofrece un botón "editar" que no existe: ofrece "anular", con el motivo obligatorio y la
 * advertencia de que no se deshace.
 *
 * **3. Lo que se muestra después de aplicar es lo que la base congeló, no lo que se mandó.** El
 * nombre del concepto, la clase, el método y el tope los escribe `app.cbu_antes()` copiándolos del
 * catálogo y del valor vigente **a la fecha del hecho**. El formulario ni siquiera tiene esos campos
 * (`aplicarConceptoAUnidadSchema` tiene seis y ni uno más), así que no puede mandarlos.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ HAY ESTADO DE CLIENTE ACÁ Y EN NINGÚN OTRO FORMULARIO
 *
 * `cantidad` **solo la usa el método `precio_x_cantidad`**; en los demás la base la pisa con `null`.
 * Un campo siempre visible que en cuatro de cada cinco casos se ignora es un campo que se completa
 * por inercia y después confunde al que audita. El `useState` sirve para eso y para nada más: qué
 * concepto está elegido, para decidir qué campo se dibuja y qué dice el catálogo hoy de ese concepto.
 * **No calcula nada.**
 */

import { useEffect, useRef, useState } from "react";
import type { AplicacionEscrita } from "@admin-barrios/data/servicios/cargos";
import type { ConceptoBoletaDeLista } from "@admin-barrios/data/servicios/conceptos-boleta";
import { formatearDecimal, formatearMonto } from "@admin-barrios/shared/dinero";
import { fechaIsoSchema, formatearFecha } from "@admin-barrios/shared/fechas";
import {
  anularAplicacionAction,
  aplicarConceptoAction,
} from "../../../../../../acciones/liquidacion.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  AvisoDeFalloCompacto,
  BotonEnviar,
  CampoCantidad,
  CampoParrafo,
  CampoSeleccion,
  CampoTexto,
  Campos,
  Formulario,
  PedidoDeConfirmacion,
  SoloLectores,
  useFormulario,
  type Opcion,
  type Salidas,
} from "../../../../../../componentes/formulario.tsx";
import { Chip, Definicion, Definiciones } from "../../../../../../componentes/ui.tsx";
import { etiquetaMetodo } from "../../../../../../componentes/etiquetas.tsx";
import estilos from "./cargos.module.css";

export type UnidadParaElegir = {
  readonly id: string;
  readonly etiqueta: string;
  readonly destinatario: string | null;
};

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Aplicar
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function FormularioDeAplicacion({
  periodoId,
  unidades,
  conceptos,
  salidas,
}: {
  readonly periodoId: string;
  readonly unidades: readonly UnidadParaElegir[];
  readonly conceptos: readonly ConceptoBoletaDeLista[];
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion, volverACorregir } =
    useFormulario(aplicarConceptoAction);

  /*
   * Qué concepto está elegido. Sirve para dos cosas y para ninguna más: dibujar o no el campo
   * `cantidad` —que solo usa el método `precio_x_cantidad`— y mostrar lo que el catálogo dice de ese
   * concepto. **No calcula nada.**
   *
   * El `<select>` es **no controlado** (ver `CampoSeleccion`): React 19 hace `form.reset()` cuando la
   * acción termina, y a un campo controlado eso le borra el valor del DOM sin disparar ningún
   * re-render que lo reponga. No controlado, en cambio, el reset lo devuelve a su `defaultValue` —que
   * React ya actualizó con lo que la acción devolvió—, así que el desplegable se repone solo.
   *
   * Lo que **no** se repone solo es este estado, y por eso está el efecto. Sin él, el síntoma medido
   * el 2026-07-28 era una pantalla contradiciéndose: después de un reintento fallido mostraba el
   * panel del concepto elegido y el desplegable en «Elegí el concepto…» al mismo tiempo.
   */
  const [conceptoId, setConceptoId] = useState(previos["conceptoBoletaId"] ?? "");
  const ultimo = useRef<unknown>(resultado);

  useEffect(() => {
    if (ultimo.current === resultado) return;
    ultimo.current = resultado;
    setConceptoId(previos["conceptoBoletaId"] ?? "");
  }, [resultado, previos]);

  const elegido = conceptos.find((c) => c.id === conceptoId) ?? null;
  const porCantidad = elegido?.metodo === "precio_x_cantidad";

  const opcionesDeUnidad: readonly Opcion[] = unidades.map((u) => ({
    valor: u.id,
    texto: u.destinatario ? `${u.etiqueta} — ${u.destinatario}` : u.etiqueta,
  }));

  /*
   * Un concepto **sin valor vigente hoy no se deshabilita**, y esa es la decisión menos obvia de esta
   * pantalla. El valor que se congela es el vigente a la **fecha del hecho**, que puede ser anterior a
   * hoy: deshabilitar por "no tiene valor hoy" impediría cargar un cargo legítimo de la semana pasada.
   * Lo que sí se hace es decirlo en el renglón, para que el rechazo de `app.cbu_antes()` —si llega—
   * no sea una sorpresa.
   */
  const opcionesDeConcepto: readonly Opcion[] = conceptos.map((c) => ({
    valor: c.id,
    texto: `${c.nombre}${c.valorVigente ? "" : " (sin valor vigente hoy)"}${c.activo ? "" : " (inactivo)"}`,
    grupo: c.clase === "cargo" ? "Cargos" : "Descuentos",
    deshabilitada: !c.activo,
  }));

  return (
    <Formulario accion={enviar} etiqueta="Aplicar un cargo o descuento a una unidad">
      <input type="hidden" name="periodoId" value={periodoId} />

      {confirmacion && resultado.estado === "confirmar" ? (
        <PedidoDeConfirmacion onVolver={volverACorregir}
          error={resultado.error}
          confirmacion={confirmacion}
          valores={resultado.valores}
          pendiente={pendiente}
        >
          <ResumenDeLoQueSeConfirma valores={resultado.valores} unidades={unidades} conceptos={conceptos} />
        </PedidoDeConfirmacion>
      ) : (
        <>
          <Campos>
            <CampoSeleccion
              nombre="unidadFuncionalId"
              etiqueta="Unidad funcional"
              requerido
              opciones={opcionesDeUnidad}
              sinSeleccion="Elegí la unidad…"
              errores={campos["unidadFuncionalId"]}
              valorInicial={previos["unidadFuncionalId"]}
              ayuda="El cargo se cobra en la boleta de esta unidad y de ninguna otra."
            />
            <CampoSeleccion
              nombre="conceptoBoletaId"
              etiqueta="Concepto del catálogo"
              requerido
              opciones={opcionesDeConcepto}
              sinSeleccion="Elegí el concepto…"
              errores={campos["conceptoBoletaId"]}
              valorInicial={previos["conceptoBoletaId"]}
              alCambiar={setConceptoId}
              ayuda="El precio, el porcentaje y el tope salen del catálogo del barrio, no de este formulario."
            />
            <CampoTexto
              nombre="fechaHecho"
              tipo="date"
              etiqueta="Fecha del hecho"
              requerido
              errores={campos["fechaHecho"]}
              valorInicial={previos["fechaHecho"]}
              ayuda="Cuándo pasó: cuándo se usó el quincho, cuándo se cumplió la condición del descuento. No es un dato administrativo — decide qué valor del catálogo se congela, o sea fija el precio."
            />
            {porCantidad ? (
              <CampoCantidad
                nombre="cantidad"
                etiqueta="Cantidad"
                requerido
                errores={campos["cantidad"]}
                valorInicial={previos["cantidad"]}
                ayuda="Cuántas unidades de uso: cuántas reservas, cuántas jornadas. Hasta tres decimales."
              />
            ) : null}
            <CampoTexto
              nombre="detalle"
              etiqueta="Detalle"
              requerido
              maximo={500}
              ancho
              errores={campos["detalle"]}
              valorInicial={previos["detalle"]}
              ayuda="Sale impreso en la boleta, debajo del concepto. Es lo que va a leer el vecino cuando pregunte por qué le cobran esto."
            />
          </Campos>

          {elegido ? <LoQueDiceElCatalogo concepto={elegido} /> : null}

          <Avisos>
            {resultado.estado === "ok" ? <AcuseDeAplicacion aplicacion={resultado.valor} /> : null}
            {resultado.estado === "falla" ? (
              <AvisoDeFallo error={resultado.error} salidas={salidas} />
            ) : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>

          <Acciones ayuda="Un cargo aplicado no se edita: si algo sale mal, se anula con motivo y se aplica de nuevo. Conviene revisar la unidad y la fecha antes de aplicar.">
            <BotonEnviar pendiente={pendiente} cargando="Aplicando…">
              Aplicar a la unidad
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}

/**
 * Lo que el catálogo dice **hoy** del concepto elegido.
 *
 * Son datos del servidor, no una cuenta: precio unitario, porcentaje, monto fijo y tope, tal como los
 * devolvió `listarConceptosBoleta`. Y va con la advertencia que lo hace honesto: **el que se congela
 * es el vigente a la fecha del hecho**, que puede ser otro. Sin ese renglón, alguien carga un cargo
 * con fecha del mes pasado, ve el precio de hoy en pantalla y después no entiende la boleta.
 *
 * Lo que acá **no** hay, y es lo importante: ninguna multiplicación. Con `precio_x_cantidad` se ve el
 * precio unitario y se ve la cantidad, y el producto no se escribe en ningún lado — lo calcula la
 * base al insertar y vuelve en `importeEstimado`.
 */
function LoQueDiceElCatalogo({ concepto }: { readonly concepto: ConceptoBoletaDeLista }) {
  return (
    <div className={estilos.catalogo}>
      <p className={estilos.catalogoTitulo}>
        <Chip tono={concepto.clase === "cargo" ? "info" : "exito"}>
          {concepto.clase === "cargo" ? "Cargo" : "Descuento"}
        </Chip>{" "}
        {concepto.nombre} · {etiquetaMetodo(concepto.metodo)}
      </p>

      {concepto.valorVigente ? (
        <>
          <Definiciones>
            {concepto.valorVigente.precioUnitario ? (
              <Definicion termino="Precio unitario">
                <span className="dinero">$ {formatearMonto(concepto.valorVigente.precioUnitario)}</span>
              </Definicion>
            ) : null}
            {concepto.valorVigente.montoFijo ? (
              <Definicion termino="Monto fijo">
                <span className="dinero">$ {formatearMonto(concepto.valorVigente.montoFijo)}</span>
              </Definicion>
            ) : null}
            {concepto.valorVigente.porcentaje ? (
              <Definicion termino="Porcentaje">
                <span className="dinero">{formatearDecimal(concepto.valorVigente.porcentaje, 2)} %</span>
              </Definicion>
            ) : null}
            {concepto.valorVigente.tope ? (
              <Definicion termino="Tope del descuento">
                <span className="dinero">$ {formatearMonto(concepto.valorVigente.tope)}</span>
              </Definicion>
            ) : null}
          </Definiciones>
          <p className={estilos.catalogoNota}>
            Es el valor vigente <strong>hoy</strong>. El que queda congelado en el cargo es el vigente
            a la <strong>fecha del hecho</strong> que cargues arriba, que puede ser otro. El importe
            final lo calcula la base al aplicar, no esta pantalla.
          </p>
        </>
      ) : (
        <p className={estilos.catalogoNota}>
          Este concepto <strong>no tiene un valor vigente hoy</strong>. Si la fecha del hecho cae
          dentro de una vigencia anterior, se puede aplicar igual; si no, la base lo va a rechazar
          diciendo que no tiene valor cargado a esa fecha.
        </p>
      )}

      {concepto.requiereAdmin ? (
        <p className={estilos.catalogoNota}>
          Este concepto <strong>solo lo puede aplicar un administrador del barrio</strong>. Lo decide
          la base, no esta pantalla: si tu rol no alcanza, el rechazo lo vas a ver al aplicar.
        </p>
      ) : null}
    </div>
  );
}

/**
 * El acuse de la aplicación — **la pieza donde es más fácil mentir sin darse cuenta**.
 *
 * `importeEstimado` en `null` significa "todavía no se puede saber", y se dice con esas palabras.
 * Rellenarlo con `$ 0,00` sería afirmar que ese cargo no cuesta nada, que es un hecho distinto y
 * falso. La diferencia entre las dos cosas es exactamente la que `Cifra` protege en las pantallas de
 * lectura con su prop `nulo` obligatoria; acá se protege escribiendo la frase.
 */
function AcuseDeAplicacion({ aplicacion }: { readonly aplicacion: AplicacionEscrita }) {
  const esDescuento = aplicacion.clase === "descuento";
  return (
    <AvisoDeExito
      titulo={`Quedó aplicado: ${aplicacion.nombreConcepto} (${esDescuento ? "descuento" : "cargo"}).`}
    >
      <p>
        {aplicacion.importeEstimado === null ? (
          <>
            <strong>El importe se conoce al liquidar.</strong> Este concepto se calcula por{" "}
            {etiquetaMetodo(aplicacion.metodo).toLowerCase()}, o sea sobre la expensa de esa unidad,
            que todavía no existe: sale cuando se genere el borrador. No es cero — es que todavía no
            hay número.
          </>
        ) : (
          <>
            Importe congelado por la base:{" "}
            <span className="dinero">$ {formatearMonto(aplicacion.importeEstimado)}</span>. Salió del
            valor del catálogo vigente a la fecha del hecho, no de esta pantalla.
          </>
        )}
      </p>
      {aplicacion.confirmadoPorMontoInusual ? (
        <p>
          Quedó registrado que <strong>lo confirmaste vos</strong>: la base guardó que este importe se
          salía de lo habitual para esa unidad y que alguien lo autorizó igual. Es lo que va a
          contestar la pregunta si el mes que viene alguien reclama.
        </p>
      ) : null}
      {aplicacion.tope ? (
        <p>
          Tiene tope de <span className="dinero">$ {formatearMonto(aplicacion.tope)}</span>: si el
          cálculo lo supera, la boleta va a mostrar el tope y el importe sin recortar, uno al lado del
          otro.
        </p>
      ) : null}
    </AvisoDeExito>
  );
}

/**
 * Qué se está confirmando, con los valores del intento anterior traducidos a nombres.
 *
 * Los uuid de un `<select>` no son legibles: confirmar "aplicar el concepto
 * `e967ba81-…` a la unidad `4f2c…`" es firmar en blanco. La traducción sale de las mismas listas que
 * llenaron el formulario, así que no puede decir algo distinto de lo que se eligió.
 */
/**
 * La fecha del intento anterior, en el formato del resto del producto.
 *
 * Va con guarda porque el valor viene del formulario y puede ser cualquier cosa —`formatearFecha`
 * hace `parse()` y **lanza** si no matchea—: un texto raro en un campo no puede tumbar el pedido de
 * confirmación, que es justamente la pantalla donde hace falta que todo se vea.
 */
function fechaLegible(valor: string | undefined): string {
  if (!valor || !fechaIsoSchema.safeParse(valor).success) return "—";
  return formatearFecha(valor);
}

function ResumenDeLoQueSeConfirma({
  valores,
  unidades,
  conceptos,
}: {
  readonly valores: Readonly<Record<string, string>>;
  readonly unidades: readonly UnidadParaElegir[];
  readonly conceptos: readonly ConceptoBoletaDeLista[];
}) {
  const unidad = unidades.find((u) => u.id === valores["unidadFuncionalId"]);
  const concepto = conceptos.find((c) => c.id === valores["conceptoBoletaId"]);
  return (
    <Definiciones>
      <Definicion termino="Unidad">{unidad?.etiqueta ?? "—"}</Definicion>
      <Definicion termino="Concepto">{concepto?.nombre ?? "—"}</Definicion>
      <Definicion termino="Fecha del hecho">{fechaLegible(valores["fechaHecho"])}</Definicion>
      {valores["cantidad"] ? <Definicion termino="Cantidad">{valores["cantidad"]}</Definicion> : null}
      {/* Acá va tal cual: es lo que la persona tipeó recién, no lo que devolvió la base. */}
      <Definicion termino="Detalle">{valores["detalle"] ?? "—"}</Definicion>
    </Definiciones>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Anular
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Anular una aplicación.
 *
 * **Va adentro de un `<details>` y no detrás de un botón directo**, por dos motivos que se suman: el
 * motivo es obligatorio y necesita un campo de texto, y la operación es **irreversible**. El
 * despliegue es el paso deliberado que separa el click accidental del acto: hay que abrirlo, escribir
 * por qué, y recién ahí aparece el botón.
 *
 * Es `<details>` nativo y no un diálogo con estado: se abre con teclado, no atrapa el foco, no
 * necesita `Esc`, y funciona igual si el JavaScript se cayó.
 */
export function AnularAplicacion({
  aplicacionId,
  descripcion,
  salidas,
}: {
  readonly aplicacionId: string;
  readonly descripcion: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion } =
    useFormulario(anularAplicacionAction);

  return (
    <details className={estilos.anulacion}>
      <summary>
        Anular
        <SoloLectores> el cargo {descripcion}</SoloLectores>
      </summary>
      <form action={enviar} className={estilos.anulacionCuerpo}>
        <input type="hidden" name="aplicacionId" value={aplicacionId} />
        <p className={estilos.anulacionAviso}>
          Anular <strong>no se deshace</strong> y un cargo <strong>no se edita</strong>: si hay que
          cobrar otra cosa, se anula éste y se aplica uno nuevo. El motivo queda archivado como única
          explicación de por qué esa plata no se cobró.
        </p>
        <CampoParrafo
          nombre="motivo"
          etiqueta="Motivo de la anulación"
          requerido
          maximo={500}
          filas={2}
          errores={campos["motivo"]}
          ayuda="Mínimo cinco caracteres. Contá en una frase por qué se anula."
        />
        <div aria-live="polite">
          {resultado.estado === "falla" ? (
            <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} />
          ) : null}
        </div>
        <BotonEnviar tono="peligro" pendiente={pendiente} cargando="Anulando…">
          Anular definitivamente
        </BotonEnviar>
      </form>
    </details>
  );
}
