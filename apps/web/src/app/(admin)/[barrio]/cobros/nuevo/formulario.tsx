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
 */

import { useEffect, useState } from "react";
import type { SaldoUF } from "@admin-barrios/data/servicios/cobros";
import { CONTENT_TYPES_COMPROBANTE } from "@admin-barrios/shared/cobros";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { registrarPagoAction } from "../../../../../acciones/cobros.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  BotonEnviar,
  CampoArchivo,
  CampoMonto,
  CampoSeleccion,
  CampoTexto,
  Campos,
  Formulario,
  useFormulario,
  type Opcion,
  type Salidas,
} from "../../../../../componentes/formulario.tsx";
import { useSubidaDeComprobante } from "../../../../../componentes/useSubidaDeComprobante.ts";
import { Cifra, Dato, Panel } from "../../../../../componentes/ui.tsx";
import estilos from "./nuevo.module.css";

/** `accept` del `<input type="file">`, armado desde el mismo catálogo cerrado que valida el servidor. */
const TIPOS_ACEPTADOS = CONTENT_TYPES_COMPROBANTE.join(",");

export function FormularioDePago({
  saldos,
  unidadPreseleccionada,
  denominacion,
  salidas,
}: {
  readonly saldos: readonly SaldoUF[];
  readonly unidadPreseleccionada: string | null;
  /** Cómo llama este barrio a lo que cobra — hoy solo se usa para el texto de ayuda del monto. */
  readonly denominacion: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(registrarPagoAction);

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
  const elegida = saldos.find((s) => s.unidadFuncionalId === unidadId) ?? null;

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

  return (
    <div className={estilos.layout}>
      <Panel
        titulo="Datos del pago"
        origen="Nada de lo que se carga acá se prorratea ni se imputa solo: el pago queda registrado contra la unidad, y a qué liquidación se aplica es un paso aparte."
      >
        <Formulario accion={enviar} etiqueta="Registrar un pago">
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
            <CampoTexto
              nombre="obligadoId"
              etiqueta="Obligado"
              errores={campos["obligadoId"]}
              valorInicial={previos["obligadoId"]}
              ayuda="El id del obligado a cuyo nombre se registra el cobro, si corresponde. Se puede dejar vacío: la unidad puede no tener uno vigente."
            />
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

          <Avisos>
            {resultado.estado === "ok" ? (
              <AvisoDeExito titulo="El pago quedó registrado.">
                <Cifra monto={resultado.valor.monto} nulo="—" /> el {formatearFecha(resultado.valor.fecha)}.
                Todavía no está imputado contra ninguna liquidación: eso es un paso aparte.
              </AvisoDeExito>
            ) : null}
            {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>

          <Acciones
            ayuda={
              subida.estado.fase !== "lista"
                ? "Esperando el comprobante: el botón se habilita apenas termine de subir."
                : "El pago se registra tal cual: no se prorratea ni se imputa solo contra ninguna liquidación."
            }
          >
            <BotonEnviar pendiente={pendiente} deshabilitado={subida.estado.fase !== "lista"} cargando="Registrando…">
              Registrar el pago
            </BotonEnviar>
          </Acciones>
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
