"use client";

/**
 * Aplicar un concepto a una unidad (un cargo o un descuento). Anular uno ya aplicado está en el
 * detalle del concepto (`detalle.tsx`).
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
import type { ConceptoBoletaDeLista } from "@admin-barrios/data/servicios/conceptos-boleta";
import { TEXTO_METODO } from "@admin-barrios/shared/conceptos";
import { formatearDecimal, formatearMonto } from "@admin-barrios/shared/dinero";
import { fechaIsoSchema, formatearFecha } from "@admin-barrios/shared/fechas";
import { Boton, Chip } from "@admin-barrios/ui";
import { aplicarConceptoAction } from "../../../../../../acciones/liquidacion.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  BotonEnviar,
  CampoCantidad,
  CampoMonto,
  CampoSeleccion,
  CampoTexto,
  Campos,
  Formulario,
  PedidoDeConfirmacion,
  useFormulario,
  useVolverAlGuardar,
  type Opcion,
  type Salidas,
} from "../../../../../../componentes/formulario.tsx";
import { conListo } from "../../../../../../rutas.ts";
import { Definicion, Definiciones } from "../../../../../../componentes/ui.tsx";
import estilos from "./conceptos.module.css";

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
  volverA,
  salidas,
}: {
  readonly periodoId: string;
  readonly unidades: readonly UnidadParaElegir[];
  readonly conceptos: readonly ConceptoBoletaDeLista[];
  /** La lista de cargos del período (encargo 9, PR 1 §2): a donde llevan «Cancelar» y el guardado. */
  readonly volverA: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion, volverACorregir } =
    useFormulario(aplicarConceptoAction);
  useVolverAlGuardar(resultado, (aplicacion) => conListo(volverA, "cargo", aplicacion.id));

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

  // Con el cargo aplicado, el formulario se va: un segundo clic mientras vuelve no aplica otro.
  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo={`Listo: quedó aplicado ${resultado.valor.nombreConcepto}. Volviendo a la lista…`}>
        <a href={conListo(volverA, "cargo", resultado.valor.id)}>Ir a los conceptos del mes</a>
      </AvisoDeExito>
    );
  }

  const elegido = conceptos.find((c) => c.id === conceptoId) ?? null;
  const porCantidad = elegido?.metodo === "precio_x_cantidad";
  // «Importe a cargar cada vez» (una multa): el catálogo no guarda ningún valor, se escribe acá.
  const importeLibre = elegido?.metodo === "importe_libre";
  /**
   * **A un descuento no se le pide la fecha del hecho**, porque no hay tal hecho: la bonificación por
   * pago en término se evalúa al cierre del período. Pedirla obligaba a inventar un dato que además
   * decide, en silencio, qué valor del catálogo se congela — o sea el importe. Sin ella, el servicio
   * usa el primer día del período, que es cuando en la práctica se definen los valores del mes.
   */
  const pideFecha = elegido !== null && elegido.clase !== "descuento";

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
    texto: `${c.nombre}${c.valorVigente || c.metodo === "importe_libre" ? "" : " (sin valor vigente hoy)"}${c.activo ? "" : " (inactivo)"}`,
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
            {pideFecha ? (
              <CampoTexto
                nombre="fechaHecho"
                tipo="date"
                etiqueta="Fecha del hecho"
                requerido
                errores={campos["fechaHecho"]}
                valorInicial={previos["fechaHecho"]}
                ayuda="Cuándo se usó: el día de la reserva del quincho, de la cancha. No es un dato administrativo — decide qué valor del catálogo se congela, o sea fija el precio."
              />
            ) : null}
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
            {importeLibre ? (
              <CampoMonto
                nombre="importe"
                etiqueta="Importe"
                requerido
                errores={campos["importe"]}
                valorInicial={previos["importe"]}
                ayuda="Lo que se le cobra a esta unidad esta vez. Este concepto no tiene un valor fijo: el importe se escribe cada vez que se aplica."
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
            {resultado.estado === "falla" ? (
              <AvisoDeFallo error={resultado.error} salidas={salidas} />
            ) : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>

          <Acciones ayuda="Un cargo aplicado no se edita: si algo sale mal, se anula con motivo y se aplica de nuevo. Conviene revisar la unidad y la fecha antes de aplicar.">
            <Boton href={volverA} variante="sutil" deshabilitado={pendiente}>
              Cancelar
            </Boton>
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
        {concepto.nombre} · {TEXTO_METODO[concepto.metodo as keyof typeof TEXTO_METODO] ?? concepto.metodo}
      </p>

      {concepto.metodo === "importe_libre" ? (
        <p className={estilos.catalogoNota}>
          Este concepto <strong>no tiene un valor fijo</strong>: el importe es el que escribas arriba. Si supera lo
          habitual para esa unidad, el sistema te lo va a hacer confirmar.
        </p>
      ) : concepto.valorVigente ? (
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
            final lo calcula el sistema al aplicar, no esta pantalla.
          </p>
        </>
      ) : (
        <p className={estilos.catalogoNota}>
          Este concepto <strong>no tiene un valor vigente hoy</strong>. Si la fecha del hecho cae
          dentro de una vigencia anterior, se puede aplicar igual; si no, el sistema lo va a
          rechazar diciendo que no tiene valor cargado a esa fecha.
        </p>
      )}

      {concepto.requiereAdmin ? (
        <p className={estilos.catalogoNota}>
          Este concepto <strong>solo lo puede aplicar un administrador del barrio</strong>. Lo decide
          el sistema, no esta pantalla: si tu rol no alcanza, el rechazo lo vas a ver al aplicar.
        </p>
      ) : null}
    </div>
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
      {valores["fechaHecho"] ? (
        <Definicion termino="Fecha del hecho">{fechaLegible(valores["fechaHecho"])}</Definicion>
      ) : (
        <Definicion termino="Valor congelado al">primer día del período</Definicion>
      )}
      {valores["cantidad"] ? <Definicion termino="Cantidad">{valores["cantidad"]}</Definicion> : null}
      {valores["importe"] ? (
        <Definicion termino="Importe">
          <span className="dinero">$ {formatearMonto(valores["importe"])}</span>
        </Definicion>
      ) : null}
      {/* Acá va tal cual: es lo que la persona tipeó recién, no lo que devolvió la base. */}
      <Definicion termino="Detalle">{valores["detalle"] ?? "—"}</Definicion>
    </Definiciones>
  );
}
