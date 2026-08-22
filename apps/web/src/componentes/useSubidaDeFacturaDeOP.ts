"use client";

/**
 * El mismo micro-flujo que `useSubidaDeComprobanteDeOP.ts`, para la FACTURA de una orden de pago en
 * vez del comprobante de pago — mismo argumento de por qué es un hook paralelo y no uno generalizado
 * con tres usos (ver el docstring de cabecera de ese archivo, que no se repite acá). Lo único que
 * cambia es el Server Action que llama (`prepararSubidaDeFacturaDeOPAction`, `acciones/ordenes-pago.ts`).
 */

import { useCallback, useRef, useState } from "react";
import { prepararSubidaDeFacturaDeOPAction, type SubidaComprobanteDeOPPreparada } from "../acciones/ordenes-pago.ts";
import { INICIAL, type ResultadoDeAccion } from "../acciones/resultado.ts";
import {
  armarFormDataDeSubida,
  validarArchivoDeComprobante,
  type ErrorDeSubida,
  type EstadoDeSubida,
} from "./useSubidaDeComprobante.ts";

export function useSubidaDeFacturaDeOP(ordenPagoId: string): {
  readonly estado: EstadoDeSubida;
  /** Arranca el micro-flujo entero para un archivo recién elegido. */
  readonly elegirArchivo: (archivo: File) => void;
  /** Repite el micro-flujo entero sobre el ÚLTIMO archivo — pide una URL nueva, no reusa la vieja. */
  readonly reintentar: () => void;
  /** Vuelve a `sinArchivo`. */
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
      parametros.set("ordenPagoId", ordenPagoId);
      parametros.set("contentType", archivo.type);

      let preparada: ResultadoDeAccion<SubidaComprobanteDeOPPreparada>;
      try {
        preparada = await prepararSubidaDeFacturaDeOPAction(INICIAL, parametros);
      } catch {
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
    [ordenPagoId],
  );

  const elegirArchivo = useCallback((archivo: File) => void iniciarSubida(archivo), [iniciarSubida]);

  const reintentar = useCallback(() => {
    if (estado.fase !== "error") return;
    void iniciarSubida(estado.archivo);
  }, [estado, iniciarSubida]);

  const reiniciar = useCallback(() => {
    intentoRef.current += 1;
    setEstado({ fase: "sinArchivo" });
  }, []);

  return { estado, elegirArchivo, reintentar, reiniciar };
}
