"use client";

/**
 * El micro-flujo de subida (elegir → validar → pedir URL presignada → POST directo al storage →
 * `storageKey`) aplicado al **adjunto de una gestión de cobranza**: la carta documento, la nota
 * firmada, un acuse (encargo E-a2).
 *
 * Es el mismo patrón que `useSubidaDeRespaldo.ts` y `useSubidaDeComprobanteDeOP.ts`, y por el mismo
 * motivo no generaliza `iniciarSubida()`: cambia la acción. Lo genérico —validar el archivo (tipo y
 * tamaño, los del comprobante), armar el `FormData` del POST, los estados— se reusa importado de
 * `useSubidaDeComprobante.ts`. El porqué de cada guarda (un intento vigente, una URL nueva por
 * reintento, dos orígenes de error) está escrito ahí.
 */

import { useCallback, useRef, useState } from "react";
import { prepararSubidaDeAdjuntoDeGestionAction, type SubidaDeAdjuntoPreparada } from "../acciones/gestiones.ts";
import { INICIAL, type ResultadoDeAccion } from "../acciones/resultado.ts";
import {
  armarFormDataDeSubida,
  validarArchivoDeComprobante,
  type ErrorDeSubida,
  type EstadoDeSubida,
} from "./useSubidaDeComprobante.ts";

export function useSubidaDeAdjuntoDeGestion(unidadFuncionalId: string): {
  readonly estado: EstadoDeSubida;
  readonly elegirArchivo: (archivo: File) => void;
  readonly reintentar: () => void;
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

      let preparada: ResultadoDeAccion<SubidaDeAdjuntoPreparada>;
      try {
        preparada = await prepararSubidaDeAdjuntoDeGestionAction(INICIAL, parametros);
      } catch {
        if (vigente()) {
          setEstado({ fase: "error", archivo, error: { tipo: "red", mensaje: "No se pudo pedir la URL de subida. Probá de nuevo." } });
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
        const respuesta = await fetch(preparada.valor.url, { method: "POST", body: armarFormDataDeSubida(preparada.valor.campos, archivo) });
        if (!vigente()) return;
        if (!respuesta.ok) {
          setEstado({ fase: "error", archivo, error: { tipo: "red", mensaje: "No se pudo subir el archivo. Probá de nuevo." } });
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
    intentoRef.current += 1;
    setEstado({ fase: "sinArchivo" });
  }, []);

  return { estado, elegirArchivo, reintentar, reiniciar };
}
