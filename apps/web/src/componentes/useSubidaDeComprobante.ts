"use client";

/**
 * El micro-flujo de subida del comprobante de un pago manual: elegir un archivo, pedir una URL de
 * subida presignada, mandarlo directo al storage, y terminar con la `storageKey` que
 * `registrarPagoAction` necesita.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO NO PASA POR `useFormulario`/`useActionState`
 *
 * `prepararSubidaDeComprobanteAction` **es** una Server Action, pero acá se llama como una función
 * async común, no a través de `useActionState`. `useActionState` está pensado para que un
 * `<form action>` lo dispare; acá el disparador es elegir un archivo (`onChange`), no un submit, y
 * forzarlo por esa vía exigiría invocar el `dispatch` a mano con un `FormData` armado a mano —una
 * técnica que hoy no existe en ningún otro lugar del kit— sin ganar nada: el `pendiente` que
 * devolvería igual habría que fusionarlo a mano con el de la subida real (que nunca puede pasar por
 * `useActionState`, porque no es una Server Action, es un POST directo contra el storage). Es más
 * simple tener a las tres etapas (validar, pedir URL, subir) bajo una sola máquina de estados local.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * CADA REINTENTO PIDE UNA URL NUEVA — NUNCA REUSA LA ANTERIOR
 *
 * `reintentar()` llama a `iniciarSubida()` desde cero, igual que `elegirArchivo()`: vuelve a llamar
 * a `prepararSubidaDeComprobanteAction`, que vuelve a firmar con un token nuevo. Si no fuera así, un
 * primer intento que falló tarde (a los 150 de los 180 segundos que dura la URL, por una conexión
 * lenta) reintentaría contra una URL ya vencida, y el segundo fallo —por política expirada— se vería
 * idéntico al primero sin serlo. El objeto huérfano que puede dejar un intento fallido a mitad de
 * camino ya es una decisión aceptada del lado del storage (ver el docstring de
 * `ObjectStorage.urlFirmadaDeSubida`, `packages/almacenamiento`): no hace falta —ni conviene—
 * intentar reusar la clave vieja para "ahorrar" ese huérfano.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ HAY UN GUARDA DE INTENTO (`intentoRef`)
 *
 * Si la persona elige un archivo, se arrepiente y elige otro antes de que el primero termine de
 * pedir su URL o de subir, la respuesta del primero **no puede pisar** el estado que ya avanzó con
 * el segundo. Cada llamada a `iniciarSubida` saca un número de intento; antes de cada `setEstado`
 * después de un `await` se verifica que ese número siga siendo el vigente. Mismo problema y misma
 * solución que el `let vivo = true` de `documentos/generacion.tsx`, adaptado a request-response en
 * vez de a un intervalo.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * DOS ORÍGENES DE ERROR, Y POR QUÉ NO SE MUESTRAN IGUAL
 *
 * Un rechazo de `prepararSubidaDeComprobanteAction` (`falla`/`confirmar`) ya viene traducido por
 * `traducirFallo` del lado del servidor: trae `mensaje`, `sugerencia` y un código de correlación que
 * conecta con el log. Un fallo del `fetch` directo contra S3/MinIO (red caída, política vencida,
 * archivo rechazado por el propio storage) **no pasó por ningún servicio nuestro** — no hay
 * correlación que buscar, porque no hay nada en nuestro log. Tratarlo como si fuera lo mismo sería
 * inventar un motivo que no ocurrió; por eso `ErrorDeSubida` distingue `"servicio"` (con el
 * `ErrorParaMostrar` real) de `"red"` (un mensaje genérico, sin correlación) — y de `"validacion"`,
 * que ni siquiera llegó a pedir nada: es el archivo elegido, antes de cualquier viaje de red.
 */

import { useCallback, useRef, useState } from "react";
import { CONTENT_TYPES_COMPROBANTE, TAMANO_MAXIMO_COMPROBANTE_BYTES } from "@admin-barrios/shared/cobros";
import type { ErrorParaMostrar } from "@admin-barrios/shared/errores";
import { prepararSubidaDeComprobanteAction, type SubidaComprobantePreparada } from "../acciones/cobros.ts";
import { INICIAL, type ResultadoDeAccion } from "../acciones/resultado.ts";

export type ErrorDeSubida =
  /** El archivo elegido no pasa el tipo o el tamaño — nunca se pidió nada al servidor. */
  | { readonly tipo: "validacion"; readonly mensaje: string }
  /** `prepararSubidaDeComprobanteAction` rechazó. Trae el `ErrorParaMostrar` real, con correlación. */
  | { readonly tipo: "servicio"; readonly error: ErrorParaMostrar }
  /** Falló el viaje de red — pidiendo la URL o subiendo el archivo. Sin correlación: no hay log nuestro. */
  | { readonly tipo: "red"; readonly mensaje: string };

export type EstadoDeSubida =
  | { readonly fase: "sinArchivo" }
  | { readonly fase: "pidiendoUrl"; readonly archivo: File }
  | { readonly fase: "subiendo"; readonly archivo: File }
  | { readonly fase: "lista"; readonly archivo: File; readonly storageKey: string }
  | { readonly fase: "error"; readonly archivo: File; readonly error: ErrorDeSubida };

/**
 * Tipo o tamaño inválido, o `null` si el archivo pasa. Función pura: nada de esto toca la red, así
 * que se puede probar sin mockear `fetch` ni la Server Action.
 */
export function validarArchivoDeComprobante(archivo: File): string | null {
  // `CONTENT_TYPES_COMPROBANTE` es una tupla de literales; `.includes` sobre `archivo.type` (un
  // `string` llano) necesita el ensanchamiento explícito, si no TS exige que el argumento ya sea uno
  // de los tres literales.
  const tiposAceptados: readonly string[] = CONTENT_TYPES_COMPROBANTE;
  if (!tiposAceptados.includes(archivo.type)) {
    return `"${archivo.type || "tipo desconocido"}" no se acepta. Subí un PDF o una foto (JPG o PNG).`;
  }
  if (archivo.size > TAMANO_MAXIMO_COMPROBANTE_BYTES) {
    return `El archivo pesa más de ${TAMANO_MAXIMO_COMPROBANTE_BYTES / (1024 * 1024)} MB.`;
  }
  return null;
}

/**
 * El `FormData` del POST multipart contra el storage. Los `campos` del presign **primero** y el
 * `file` **al final** — mismo orden que ya prueba `packages/almacenamiento/test/s3.test.ts` del lado
 * del servidor (`formularioDe()`): S3/MinIO arma el POST policy contra ese orden, y no es un detalle
 * cosmético.
 */
export function armarFormDataDeSubida(campos: Readonly<Record<string, string>>, archivo: File): FormData {
  const formData = new FormData();
  for (const [clave, valor] of Object.entries(campos)) {
    formData.append(clave, valor);
  }
  formData.append("file", archivo);
  return formData;
}

export function useSubidaDeComprobante(unidadFuncionalId: string): {
  readonly estado: EstadoDeSubida;
  /** Arranca el micro-flujo entero para un archivo recién elegido. */
  readonly elegirArchivo: (archivo: File) => void;
  /** Repite el micro-flujo entero sobre el ÚLTIMO archivo — pide una URL nueva, no reusa la vieja. */
  readonly reintentar: () => void;
  /** Vuelve a `sinArchivo`. Se llama cuando `registrarPagoAction` termina con éxito, nunca antes. */
  readonly reiniciar: () => void;
} {
  const [estado, setEstado] = useState<EstadoDeSubida>({ fase: "sinArchivo" });
  const intentoRef = useRef(0);

  const iniciarSubida = useCallback(
    async (archivo: File) => {
      const miIntento = ++intentoRef.current;
      const vigente = () => intentoRef.current === miIntento;

      const mensajeInvalido = validarArchivoDeComprobante(archivo);
      if (mensajeInvalido) {
        setEstado({ fase: "error", archivo, error: { tipo: "validacion", mensaje: mensajeInvalido } });
        return;
      }

      setEstado({ fase: "pidiendoUrl", archivo });

      const parametros = new FormData();
      parametros.set("unidadFuncionalId", unidadFuncionalId);
      parametros.set("contentType", archivo.type);

      let preparada: ResultadoDeAccion<SubidaComprobantePreparada>;
      try {
        preparada = await prepararSubidaDeComprobanteAction(INICIAL, parametros);
      } catch {
        // Fallo de RPC llamando a la Server Action (no un rechazo de negocio: ese vuelve como
        // `estado: "falla"` sin lanzar). Genuinamente raro, pero el `catch` tiene que decir algo.
        if (vigente()) {
          setEstado({
            fase: "error",
            archivo,
            error: { tipo: "red", mensaje: "No se pudo pedir la URL de subida. Probá de nuevo." },
          });
        }
        return;
      }
      if (!vigente()) return;

      if (preparada.estado !== "ok") {
        // `falla`/`confirmar` traen un `ErrorParaMostrar` real. `campos` es defensivo y no debería
        // ocurrir en la práctica (`unidadFuncionalId` es un valor fijo de la pantalla, y
        // `contentType` ya pasó `validarArchivoDeComprobante` con el mismo catálogo cerrado que el
        // esquema del servidor) — sin un campo visible al que atarlo, se muestra como un fallo de
        // red genérico en vez de inventarle un `ErrorParaMostrar` que nunca vino del servidor.
        const error: ErrorDeSubida =
          preparada.estado === "falla" || preparada.estado === "confirmar"
            ? { tipo: "servicio", error: preparada.error }
            : { tipo: "red", mensaje: "La subida no pudo prepararse. Probá de nuevo o elegí otro archivo." };
        setEstado({ fase: "error", archivo, error });
        return;
      }

      setEstado({ fase: "subiendo", archivo });

      try {
        const formularioDeSubida = armarFormDataDeSubida(preparada.valor.campos, archivo);
        const respuesta = await fetch(preparada.valor.url, { method: "POST", body: formularioDeSubida });
        if (!vigente()) return;
        if (!respuesta.ok) {
          setEstado({
            fase: "error",
            archivo,
            error: { tipo: "red", mensaje: "No se pudo subir el archivo. Probá de nuevo." },
          });
          return;
        }
      } catch {
        if (vigente()) {
          setEstado({
            fase: "error",
            archivo,
            error: { tipo: "red", mensaje: "No se pudo subir el archivo. Revisá tu conexión y probá de nuevo." },
          });
        }
        return;
      }

      setEstado({ fase: "lista", archivo, storageKey: preparada.valor.storageKey });
    },
    [unidadFuncionalId],
  );

  const elegirArchivo = useCallback((archivo: File) => void iniciarSubida(archivo), [iniciarSubida]);

  const reintentar = useCallback(() => {
    if (estado.fase !== "error") return;
    void iniciarSubida(estado.archivo);
  }, [estado, iniciarSubida]);

  const reiniciar = useCallback(() => {
    // Invalida cualquier pedido en vuelo antes de volver a "sinArchivo": sin esto, una respuesta
    // tardía de un intento anterior podría revivir un estado que ya se dio por cerrado.
    intentoRef.current += 1;
    setEstado({ fase: "sinArchivo" });
  }, []);

  return { estado, elegirArchivo, reintentar, reiniciar };
}
