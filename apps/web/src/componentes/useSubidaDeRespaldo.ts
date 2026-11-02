"use client";

/**
 * El micro-flujo de subida (elegir → validar → pedir URL presignada → POST directo al storage →
 * `storageKey`) aplicado al **adjunto del respaldo** de un parámetro de mora: el reglamento o el acta
 * de donde sale una tasa.
 *
 * Es el mismo patrón que `useSubidaDeComprobanteDeOP.ts`, y por el mismo motivo que ese archivo deja
 * escrito no generaliza `iniciarSubida()`: cambia la acción y el campo que la identifica (`nodoId`,
 * que puede ser un barrio **o la administración**), y lo genérico —validar el archivo, armar el
 * `FormData` del POST, los estados— ya se reusa importado de `useSubidaDeComprobante.ts`.
 */

import { useCallback, useRef, useState } from "react";
import { prepararSubidaDeRespaldoAction, type SubidaDeRespaldoPreparada } from "../acciones/parametros.ts";
import { INICIAL, type ResultadoDeAccion } from "../acciones/resultado.ts";
import {
  armarFormDataDeSubida,
  validarArchivoDeComprobante,
  type ErrorDeSubida,
  type EstadoDeSubida,
} from "./useSubidaDeComprobante.ts";

export function useSubidaDeRespaldo(nodoId: string): {
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
      parametros.set("nodoId", nodoId);
      parametros.set("contentType", archivo.type);

      let preparada: ResultadoDeAccion<SubidaDeRespaldoPreparada>;
      try {
        preparada = await prepararSubidaDeRespaldoAction(INICIAL, parametros);
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
    [nodoId],
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
