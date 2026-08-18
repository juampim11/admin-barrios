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
 * EL COMPROBANTE: EL CAMPO ES UN PLACEHOLDER HONESTO, Y HAY QUE SABERLO ANTES DE USAR ESTA PANTALLA
 *
 * `registrarPagoSchema` exige `comprobanteAdjunto` cuando `origen = 'manual'` (que acá es siempre). El
 * valor que tiene que viajar es una **storage key ya subida** — la subida en sí es un paso aparte, de
 * `packages/almacenamiento`.
 *
 * Ese paso aparte **no está resuelto en esta tanda, y no se inventó acá.** Dos hechos del repo lo
 * explican y ninguno de los dos es una elección de esta pantalla:
 *
 *  1. `packages/almacenamiento` es `server-only` (usa `node:crypto` y `node:stream`): no se puede
 *     importar desde un componente `"use client"`, así que este archivo no puede llamar a `put()`
 *     directamente aunque quisiera.
 *  2. `acciones/resultado.ts` → `valoresDe()` **descarta los `File` del `FormData`** a propósito
 *     ("no hay subida de archivos en este incremento", dice su propio comentario). Una Server Action
 *     de este kit no recibe un archivo aunque el `<input type="file">` lo capture en el navegador.
 *
 * Conectar los dos —un endpoint de subida que devuelva una storage key, y recién ahí este campo— es
 * una pieza con superficie propia (URL presignada de subida, límites de tamaño y de tipo de archivo,
 * quién puede escribir en qué prefijo del bucket) y su propia revisión; no es "cambiar un input". Por
 * eso el campo de acá es un `CampoTexto` liso para la storage key, útil para quien ya la tenga (por
 * ejemplo, subida por fuera de esta pantalla), y no un `<input type="file">` que fingiría subir algo.
 */

import { useState } from "react";
import type { SaldoUF } from "@admin-barrios/data/servicios/cobros";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { registrarPagoAction } from "../../../../../acciones/cobros.ts";
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
  useFormulario,
  type Opcion,
  type Salidas,
} from "../../../../../componentes/formulario.tsx";
import { Cifra, Dato, Panel } from "../../../../../componentes/ui.tsx";
import estilos from "./nuevo.module.css";

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
            <CampoTexto
              nombre="comprobanteAdjunto"
              etiqueta="Comprobante (clave de almacenamiento)"
              requerido
              maximo={300}
              ancho
              errores={campos["comprobanteAdjunto"]}
              valorInicial={previos["comprobanteAdjunto"]}
              ayuda="Un pago de carga manual necesita un comprobante. Esta versión todavía no sube el archivo desde acá: si ya tenés la clave de un comprobante subido, pegala aquí."
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

          <Acciones ayuda="El pago se registra tal cual: no se prorratea ni se imputa solo contra ninguna liquidación.">
            <BotonEnviar pendiente={pendiente} cargando="Registrando…">
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
