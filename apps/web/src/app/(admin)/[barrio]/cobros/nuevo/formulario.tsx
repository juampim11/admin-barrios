"use client";

/**
 * El alta de un pago — carga manual, contra una unidad.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * `origen` NO ES UN CAMPO DEL FORMULARIO
 *
 * `registrarPagoSchema` admite `"extracto"` y `"manual"`, pero `extracto` todavía no lo produce nadie
 * — es el enganche para una ingesta automática de resúmenes bancarios que no existe en esta tanda (ver
 * `@admin-barrios/shared/cobros`). Ofrecer un desplegable con una opción que ningún flujo real usa
 * sería el mismo error que un botón que promete lo que la aplicación no puede cumplir (doc 06 §c.6.4).
 * Por eso `origen` viaja **fijo** en un `<input type="hidden">`, y el título de la pantalla lo dice:
 * "carga manual".
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL PANEL DE CONTEXTO (OPCIÓN B) NO HACE UN FETCH NUEVO
 *
 * `saldos` es la MISMA lista que ya trajo el servidor para el `<select>` de unidades —
 * `listarSaldosUF`, sin PII, sin paginar—. El panel de la derecha no vuelve a pedirle nada al
 * servidor: cuando cambia la unidad elegida, busca en este mismo array el saldo que ya estaba ahí. Es
 * reactivo del lado del cliente y cuesta cero round-trips.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL COMPROBANTE SE SUBE DESDE ACÁ — `useSubidaDeComprobante`, `componentes/useSubidaDeComprobante.ts`
 *
 * `registrarPagoSchema` exige `comprobanteAdjunto` cuando `origen = 'manual'` (que acá es siempre), y
 * lo que viaja es una **storage key ya subida**, nunca el archivo — mismo motivo de siempre:
 * `acciones/resultado.ts` → `valoresDe()` descarta cualquier `File` del `FormData` de una Server
 * Action de este kit. El micro-flujo que arma esa `storageKey` (elegir → validar → pedir URL
 * presignada → POST directo al storage) vive en el hook, no acá: esta pantalla solo lo conecta con
 * `<CampoArchivo>` y con el gate del submit real.
 *
 * **El submit del pago queda deshabilitado hasta que `subida.estado.fase === "lista"`.** No alcanza
 * con `pendiente` (que solo cubre el envío de `registrarPagoAction` en sí): sin este gate se podría
 * registrar un pago con `comprobanteAdjunto=""` mientras el archivo todavía está subiendo.
 *
 * **El estado de la subida se reinicia SOLO cuando el pago se registra con éxito**, nunca en
 * `falla`/`campos`/`confirmar`. Si el pago se rechaza por, por ejemplo, un monto mal tipeado, la
 * persona no tiene por qué volver a elegir y resubir el comprobante — ya está subido y sigue
 * sirviendo para el reintento.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL PAGO SE IMPUTA AL REGISTRARLO (ADR-0009)
 *
 * Si llega fuera de término y devengó interés, el servidor no escribe nada la primera vez: devuelve
 * el interés, los días y cómo se reparte, y el formulario lo muestra como pedido de confirmación
 * (`PedidoDeConfirmacion`, el mismo de la tasa de T1). «No cobrar el interés» es una condonación en
 * ese momento, con motivo y respaldo opcional; solo lo ve quien puede condonar (la base lo vuelve a
 * verificar).
 *
 * Condona dos cosas, en dos renglones con su importe, y cada uno se puede destildar (encargo 11,
 * BL-030 j): **el interés de este atraso** (lo que devenga este pago) y **el interés anterior** que la
 * unidad todavía debe (de boletas y pagos anteriores). Los importes los calcula el servidor al elegir
 * la unidad y la fecha (`interesQueSePuedeNoCobrarAction`, solo lectura); al registrar se vuelven a
 * calcular y la confirmación los muestra otra vez.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { SaldoUF, TitularVigente } from "@admin-barrios/data/servicios/cobros";
import { CONTENT_TYPES_COMPROBANTE } from "@admin-barrios/shared/cobros";
import { ETIQUETA_MOTIVO_CONDONACION, MOTIVOS_CONDONACION } from "@admin-barrios/shared/escrituras";
import { ETIQUETA_RESPALDO, TIPOS_RESPALDO } from "@admin-barrios/shared/parametros-mora";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { interesQueSePuedeNoCobrarAction, registrarPagoAction } from "../../../../../acciones/cobros.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  BotonEnviar,
  CampoArchivo,
  CampoMonto,
  CampoParrafo,
  CampoSeleccion,
  Casilla,
  PedidoDeConfirmacion,
  CampoTexto,
  Campos,
  Formulario,
  useFormulario,
  useVolverAlGuardar,
  type Opcion,
  type Salidas,
} from "../../../../../componentes/formulario.tsx";
import { Boton } from "@admin-barrios/ui";
import { useSubidaDeComprobante } from "../../../../../componentes/useSubidaDeComprobante.ts";
import { useSubidaDeRespaldo } from "../../../../../componentes/useSubidaDeRespaldo.ts";
import { Cifra, Dato, Nota, Panel } from "../../../../../componentes/ui.tsx";
import { listoDelPago } from "../../../../../componentes/textos-de-cobros.ts";
import { conListo, rutaDeUnidad } from "../../../../../rutas.ts";
import estilos from "./nuevo.module.css";

/** `accept` del `<input type="file">`, armado desde el mismo catálogo cerrado que valida el servidor. */
const TIPOS_ACEPTADOS = CONTENT_TYPES_COMPROBANTE.join(",");

/** «Propietario», «Poseedor»…: el carácter del vínculo con mayúscula, para el desplegable. */
const caracterLegible = (c: string) => (c ? c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, " ") : c);

export function FormularioDePago({
  saldos,
  titulares,
  unidadPreseleccionada,
  denominacion,
  salidas,
  volverA,
  barrioId,
  puedeCondonar,
}: {
  readonly saldos: readonly SaldoUF[];
  /** Los titulares vigentes de cada unidad (`titularesVigentesDelBarrio`), para «A nombre de». */
  readonly titulares: Readonly<Record<string, readonly TitularVigente[]>>;
  readonly unidadPreseleccionada: string | null;
  /** Cómo llama este barrio a lo que cobra — hoy solo se usa para el texto de ayuda del monto. */
  readonly denominacion: string;
  readonly salidas: Salidas;
  /** A dónde lleva «Cancelar»: el estado de cuenta de la unidad o la grilla (encargo 8, T1 §2). */
  readonly volverA: string;
  /** Para subir el respaldo de «No cobrar interés» (va contra el barrio, como el de la tasa). */
  readonly barrioId: string;
  /** Si quien mira puede condonar: si no, la sección no se dibuja (la base decide igual). */
  readonly puedeCondonar: boolean;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion, volverACorregir } = useFormulario(registrarPagoAction);
  // Al registrar, al estado de cuenta de la unidad con el «Listo:» (encargo 10, BL-030 b): la cuenta
  // es lo que la persona quiere ver después de cobrar, no un formulario vacío.
  const alEstadoDeCuenta = (pago: { readonly id: string; readonly unidadFuncionalId: string }) =>
    conListo(rutaDeUnidad(barrioId, pago.unidadFuncionalId), "pago", pago.id);
  useVolverAlGuardar(resultado, alEstadoDeCuenta);
  const respaldo = useSubidaDeRespaldo(barrioId);

  const opciones: readonly Opcion[] = saldos.map((s) => ({ valor: s.unidadFuncionalId, texto: s.etiqueta }));

  /*
   * Copia de la unidad elegida, para el panel de contexto — igual que `modelo` en el alta de período:
   * la fuente de verdad sigue siendo el `<select>` no controlado, esto es solo para saber qué mostrar
   * a la derecha. `previos` gana sobre la preselección de la URL: si el servidor ya respondió un
   * intento (con o sin error), lo que la persona tipeó es más reciente que el querystring con el que
   * entró.
   */
  const inicial = previos["unidadFuncionalId"] ?? unidadPreseleccionada ?? "";
  const [unidadId, setUnidadId] = useState(inicial);
  // Copia de la fecha, para pedir los importes de los dos renglones de «No cobrar el interés».
  const [fecha, setFecha] = useState(previos["fecha"] ?? "");
  const interes = useInteresQueSePuedeNoCobrar(puedeCondonar, unidadId, fecha);
  const sinUnidadYFecha = !unidadId || !/^\d{4}-\d{2}-\d{2}$/.test(fecha);
  // Los dos renglones nacen marcados; si ya hubo un intento, vuelven como la persona los dejó.
  const huboIntento = previos["fecha"] !== undefined;
  // Si en el intento anterior la casilla principal estaba desmarcada, los renglones iban deshabilitados y
  // no viajaron: vuelven marcados, como al principio (code-reviewer, T2).
  // Tampoco viajaron si faltaban la unidad o la fecha (los renglones van deshabilitados sin ellas):
  // también ahí vuelven marcados (code-reviewer, ensayo de T2).
  const renglonesViajaron =
    previos["noCobrarInteres"] === "1" && !!previos["unidadFuncionalId"] && /^\d{4}-\d{2}-\d{2}$/.test(previos["fecha"] ?? "");
  const renglonMarcado = (campo: string) => (huboIntento && renglonesViajaron ? previos[campo] === "1" : true);
  // BL-031 a: con «No cobrar el interés» desmarcada, sus dos renglones se ven atenuados y no se tocan.
  // Copia de la casilla (que sigue no controlada); vuelve a lo que el servidor devolvió en cada intento.
  const [noCobrar, setNoCobrar] = useState(previos["noCobrarInteres"] === "1");
  useEffect(() => {
    setNoCobrar(previos["noCobrarInteres"] === "1");
  }, [previos]);
  const elegida = saldos.find((s) => s.unidadFuncionalId === unidadId) ?? null;
  const titularesDeLaUnidad = unidadId ? (titulares[unidadId] ?? []) : [];
  // Preseleccionado: el que recibe la boleta (o el que se había elegido en el intento anterior, si sigue
  // siendo titular de esta unidad).
  // siendo titular de esta unidad). Un «Sin titular» elegido a propósito (`""`) se respeta al volver:
  // no se reemplaza en silencio por quien recibe la boleta (revisión de código).
  const obligadoInicial =
    previos["obligadoId"] === ""
      ? ""
      : (titularesDeLaUnidad.find((t) => t.obligadoId === previos["obligadoId"])?.obligadoId ??
        titularesDeLaUnidad.find((t) => t.recibeBoleta)?.obligadoId ??
        titularesDeLaUnidad[0]?.obligadoId);

  // `prepararSubidaDeComprobanteAction` deriva el barrio de `unidadId` bajo RLS: sin una unidad
  // elegida no hay contra qué pedir la URL, así que `CampoArchivo` queda deshabilitado hasta que
  // haya una (ver el `deshabilitado` que se le pasa más abajo).
  const subida = useSubidaDeComprobante(unidadId);

  // Se reinicia SOLO cuando el pago se registra con éxito — nunca en `falla`/`campos`/`confirmar`,
  // para que un reintento del pago no obligue a resubir un comprobante que ya está subido y sirve
  // igual. `subida.reiniciar` es estable (sin dependencias en su `useCallback`).
  useEffect(() => {
    if (resultado.estado === "ok") subida.reiniciar();
  }, [resultado, subida.reiniciar]);

  // Con el pago registrado, el formulario no se vuelve a dibujar: un segundo clic mientras navega
  // registraría el pago dos veces.
  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo={`${listoDelPago(resultado.valor)} Volviendo al estado de cuenta…`}>
        <a href={alEstadoDeCuenta(resultado.valor)}>Ir al estado de cuenta</a>
      </AvisoDeExito>
    );
  }

  return (
    <div className={estilos.layout}>
      <Panel
        titulo="Datos del pago"
        origen="El pago se imputa al registrarlo, en el orden de imputación del barrio. Si llega fuera de término, antes de registrarlo se muestra el interés que devengó."
      >
        <Formulario accion={enviar} etiqueta="Registrar un pago">
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
          <input type="hidden" name="origen" value="manual" />

          <Campos>
            <CampoSeleccion
              nombre="unidadFuncionalId"
              etiqueta="Unidad"
              requerido
              opciones={opciones}
              sinSeleccion="Elegí la unidad…"
              errores={campos["unidadFuncionalId"]}
              valorInicial={inicial || undefined}
              alCambiar={setUnidadId}
              ayuda="Contra quién queda registrado el pago."
            />
            {/*
              «A nombre de»: los titulares VIGENTES de la unidad elegida, con el que recibe la boleta
              preseleccionado (BL-024: antes pedía un identificador interno). El `key` por unidad remonta
              el desplegable al cambiar de unidad, para que tome el preseleccionado de la nueva.
            */}
            {unidadId && titularesDeLaUnidad.length > 0 ? (
              <CampoSeleccion
                key={unidadId}
                nombre="obligadoId"
                etiqueta="A nombre de"
                opciones={titularesDeLaUnidad.map((t) => ({
                  valor: t.obligadoId,
                  texto: `${t.nombre} · ${caracterLegible(t.caracter)}${t.recibeBoleta ? " · recibe la boleta" : ""}`,
                }))}
                sinSeleccion="Sin titular (solo la unidad)"
                errores={campos["obligadoId"]}
                valorInicial={obligadoInicial}
                ayuda="El titular a cuyo nombre se registra el cobro. El pago se imputa a la unidad igual."
              />
            ) : unidadId ? (
              <Nota tono="alerta" titulo="Esta unidad no tiene titular cargado.">
                El pago se registra igual, a nombre de la unidad. Para cargar el titular, andá a{" "}
                <Link href={`/${barrioId}/padron/${unidadId}`}>la ficha de la unidad</Link>.
              </Nota>
            ) : null}
            <CampoMonto
              nombre="monto"
              etiqueta="Monto pagado"
              requerido
              errores={campos["monto"]}
              valorInicial={previos["monto"]}
              ayuda={`Lo que efectivamente entró, no lo que la ${denominacion} del mes valía.`}
            />
            <CampoTexto
              nombre="fecha"
              tipo="date"
              etiqueta="Fecha del pago"
              requerido
              errores={campos["fecha"]}
              valorInicial={previos["fecha"]}
              alCambiar={setFecha}
              ayuda="Cuándo se cobró, no cuándo se carga acá."
            />
            <CampoArchivo
              nombre="comprobanteAdjunto"
              etiqueta="Comprobante"
              requerido
              ancho
              aceptar={TIPOS_ACEPTADOS}
              errores={campos["comprobanteAdjunto"]}
              deshabilitado={!unidadId}
              estado={subida.estado}
              onElegirArchivo={subida.elegirArchivo}
              onReintentar={subida.reintentar}
              ayuda={
                unidadId
                  ? "PDF o foto (JPG o PNG), hasta 10 MB. Se sube apenas lo elegís."
                  : "Elegí primero la unidad: el comprobante se sube contra ese barrio."
              }
            />
          </Campos>

          {puedeCondonar ? (
            <details
              className={estilos.noCobrar}
              open={
                previos["noCobrarInteres"] === "1" ||
                [
                  "noCobrarInteres", "noCobrarInteresDelPago", "noCobrarInteresAnterior",
                  "motivo", "detalle", "respaldoTipo", "respaldoReferencia", "respaldoAdjunto",
                ].some((c) => campos[c])
              }
            >
              <summary>No cobrar el interés</summary>
              <p className={estilos.noCobrarAyuda}>
                Condona el interés de este atraso y el interés anterior que la unidad todavía debe; cada uno se puede
                destildar. El interés queda registrado igual, las boletas emitidas no cambian y lo condonado se anula si
                se anula el pago. Se ve el importe antes de confirmar.
              </p>
              <Casilla
                nombre="noCobrarInteres"
                valor="1"
                errores={campos["noCobrarInteres"]}
                marcadaInicial={previos["noCobrarInteres"] === "1"}
                alCambiar={setNoCobrar}
              >
                No cobrar el interés
              </Casilla>
              {/*
                Ensayo de T2: sin unidad y fecha no hay interés que mostrar. Los dos renglones van
                deshabilitados y un solo texto dice qué falta, en vez de un «elegí…» por renglón que
                destellaba a «calculando…» con cada tecla de la fecha. Con las dos, se habilitan con su
                importe; mientras se recalcula queda el importe anterior.
              */}
              {sinUnidadYFecha ? <p className={estilos.noCobrarAyuda}>Elegí la unidad y la fecha del pago para ver el interés.</p> : null}
              <div className={estilos.renglonesDeInteres} role="group" aria-label="Qué interés no se cobra">
                <Casilla
                  nombre="noCobrarInteresDelPago"
                  valor="1"
                  errores={campos["noCobrarInteresDelPago"]}
                  marcadaInicial={renglonMarcado("noCobrarInteresDelPago")}
                  deshabilitada={!noCobrar || sinUnidadYFecha}
                >
                  Interés de este atraso{sinUnidadYFecha ? null : <>: <ImporteDelRenglon estado={interes} parte="delPago" /></>}
                </Casilla>
                <Casilla
                  nombre="noCobrarInteresAnterior"
                  valor="1"
                  errores={campos["noCobrarInteresAnterior"]}
                  marcadaInicial={renglonMarcado("noCobrarInteresAnterior")}
                  deshabilitada={!noCobrar || sinUnidadYFecha}
                >
                  Interés anterior que la unidad todavía debe
                  {sinUnidadYFecha ? null : <>: <ImporteDelRenglon estado={interes} parte="anterior" /></>}
                </Casilla>
              </div>
              <Campos>
                <CampoSeleccion
                  nombre="motivo"
                  etiqueta="Motivo"
                  opciones={MOTIVOS_CONDONACION.map((m) => ({ valor: m, texto: ETIQUETA_MOTIVO_CONDONACION[m] }))}
                  sinSeleccion="Elegí el motivo…"
                  errores={campos["motivo"]}
                  valorInicial={previos["motivo"]}
                />
                <CampoParrafo
                  nombre="detalle"
                  etiqueta="Detalle"
                  ancho
                  maximo={500}
                  errores={campos["detalle"]}
                  valorInicial={previos["detalle"]}
                  ayuda="Por qué no se cobra. Al menos 10 caracteres: queda en el registro."
                />
                <CampoSeleccion
                  nombre="respaldoTipo"
                  etiqueta="Respaldo (opcional)"
                  opciones={TIPOS_RESPALDO.map((t) => ({ valor: t, texto: ETIQUETA_RESPALDO[t] }))}
                  sinSeleccion="Sin respaldo"
                  errores={campos["respaldoTipo"]}
                  valorInicial={previos["respaldoTipo"]}
                  ayuda="Si lo resolvió la comisión o la asamblea, conviene el acta."
                />
                <CampoTexto
                  nombre="respaldoReferencia"
                  etiqueta="Referencia del respaldo"
                  maximo={300}
                  errores={campos["respaldoReferencia"]}
                  valorInicial={previos["respaldoReferencia"]}
                  ayuda="Dónde se encuentra: el acta con su fecha, o el artículo."
                />
                <CampoArchivo
                  nombre="respaldoAdjunto"
                  etiqueta="Adjunto del respaldo"
                  ancho
                  aceptar={TIPOS_ACEPTADOS}
                  estado={respaldo.estado}
                  onElegirArchivo={respaldo.elegirArchivo}
                  onReintentar={respaldo.reintentar}
                  errores={campos["respaldoAdjunto"]}
                  ayuda="PDF o foto (JPG o PNG). Opcional."
                />
              </Campos>
            </details>
          ) : null}

          <Avisos>
            {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>

          <Acciones
            ayuda={
              subida.estado.fase !== "lista"
                ? "Esperando el comprobante: el botón se habilita apenas termine de subir."
                : "El pago se imputa al registrarlo, en el orden de imputación del barrio."
            }
          >
            <Boton href={volverA} variante="sutil" deshabilitado={pendiente}>
              Cancelar
            </Boton>
            <BotonEnviar
              pendiente={pendiente}
              deshabilitado={
                subida.estado.fase !== "lista" || respaldo.estado.fase === "pidiendoUrl" || respaldo.estado.fase === "subiendo"
              }
              cargando="Registrando…"
            >
              Registrar el pago
            </BotonEnviar>
          </Acciones>
          </>
          )}
        </Formulario>
      </Panel>

      <div className={estilos.contexto}>
        <Panel titulo="Unidad elegida">
          {elegida ? (
            <>
              <Dato etiqueta="Unidad" grande>
                {elegida.etiqueta}
              </Dato>
              <Dato
                etiqueta="Saldo actual"
                grande
                origen={
                  elegida.fechaUltimoMovimiento
                    ? `último movimiento el ${formatearFecha(elegida.fechaUltimoMovimiento)}`
                    : "sin movimientos todavía: no hay fila en la cuenta corriente"
                }
              >
                <Cifra monto={elegida.saldoActual} nulo="—" />
              </Dato>
            </>
          ) : (
            <p className={estilos.sinUnidad}>Elegí una unidad para ver su saldo actual.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

/** Lo que se sabe de los importes de los dos renglones de «No cobrar el interés». */
type EstadoDelInteres =
  | { readonly fase: "sinDatos" }
  /** Recalculando: si ya había importes (otra fecha de la misma unidad), se siguen viendo. */
  | { readonly fase: "calculando"; readonly previo: { readonly unidad: string; readonly delPago: string; readonly anterior: string } | null }
  | { readonly fase: "listo"; readonly unidad: string; readonly delPago: string; readonly anterior: string }
  | { readonly fase: "error" };

/**
 * Pide al servidor los importes de los dos renglones cuando cambian la unidad o la fecha (encargo 11,
 * BL-030 j). Solo lee. Una respuesta vieja (de una unidad o fecha que ya no está elegida) se descarta.
 */
function useInteresQueSePuedeNoCobrar(puedeCondonar: boolean, unidadId: string, fecha: string): EstadoDelInteres {
  const [estado, setEstado] = useState<EstadoDelInteres>({ fase: "sinDatos" });
  useEffect(() => {
    if (!puedeCondonar || !unidadId || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      setEstado({ fase: "sinDatos" });
      return;
    }
    let vigente = true;
    setEstado((antes) => ({
      fase: "calculando",
      // Solo de la misma unidad: el importe de otra unidad, aunque sea un instante, sería un dato falso.
      previo:
        antes.fase === "listo" && antes.unidad === unidadId
          ? { unidad: antes.unidad, delPago: antes.delPago, anterior: antes.anterior }
          : antes.fase === "calculando" && antes.previo?.unidad === unidadId
            ? antes.previo
            : null,
    }));
    const datos = new FormData();
    datos.set("unidadFuncionalId", unidadId);
    datos.set("fecha", fecha);
    interesQueSePuedeNoCobrarAction({ estado: "inicial" }, datos).then(
      (r) => {
        if (!vigente) return;
        setEstado(r.estado === "ok" ? { fase: "listo", unidad: unidadId, ...r.valor } : { fase: "error" });
      },
      () => {
        if (vigente) setEstado({ fase: "error" });
      },
    );
    return () => {
      vigente = false;
    };
  }, [puedeCondonar, unidadId, fecha]);
  return estado;
}

/** El importe de un renglón, o por qué todavía no está. */
function ImporteDelRenglon({ estado, parte }: { readonly estado: EstadoDelInteres; readonly parte: "delPago" | "anterior" }) {
  if (estado.fase === "listo") return <Cifra monto={estado[parte]} nulo="—" />;
  if (estado.fase === "calculando")
    return estado.previo ? (
      // El de la fecha anterior, mientras llega el nuevo: sin destello, pero se avisa que se recalcula.
      <span aria-busy="true">
        <Cifra monto={estado.previo[parte]} nulo="—" />
      </span>
    ) : (
      <span className={estilos.noCobrarAyuda}>…</span>
    );
  if (estado.fase === "error") return <span className={estilos.noCobrarAyuda}>se ve al confirmar</span>;
  return null;
}
