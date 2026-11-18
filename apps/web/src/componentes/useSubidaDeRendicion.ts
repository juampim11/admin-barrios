"use client";

/**
 * El micro-flujo de subida (elegir → validar → pedir URL presignada → POST directo al storage →
 * `storageKey`) aplicado a **una rendición del estudio** (encargo P2b): el PDF firmado (`para: "pdf"`)
 * o el comprobante de un ingreso (`para: "ingreso"`). Mismo patrón que `useSubidaDeDocumentoDelPlan.ts`;
 * cambia la acción y los campos que identifican a qué va. Lo genérico se reusa de
 * `useSubidaDeComprobante.ts`.
 */

import { useCallback, useRef, useState } from "react";
import { prepararSubidaDeRendicionAction, type SubidaDeRendicionPreparada } from "../acciones/planes-rendicion.ts";
import { INICIAL, type ResultadoDeAccion } from "../acciones/resultado.ts";
import { armarFormDataDeSubida, validarArchivoDeComprobante, type ErrorDeSubida, type EstadoDeSubida } from "./useSubidaDeComprobante.ts";

export function useSubidaDeRendicion(
  rendicionId: string,
  para: "pdf" | "ingreso",
): {
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

      const mensajeInvalido =
        para === "pdf" && archivo.type !== "application/pdf" ? "La rendición firmada va en PDF." : validarArchivoDeComprobante(archivo);
      if (mensajeInvalido) {
        setEstado({ fase: "error", archivo, error: { tipo: "validacion", mensaje: mensajeInvalido } });
        return;
      }

      setEstado({ fase: "pidiendoUrl", archivo });
      const parametros = new FormData();
      parametros.set("rendicionId", rendicionId);
      parametros.set("para", para);
      parametros.set("contentType", archivo.type);

      let preparada: ResultadoDeAccion<SubidaDeRendicionPreparada>;
      try {
        preparada = await prepararSubidaDeRendicionAction(INICIAL, parametros);
      } catch {
        if (vigente()) setEstado({ fase: "error", archivo, error: { tipo: "red", mensaje: "No se pudo pedir la URL de subida. Probá de nuevo." } });
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
        if (vigente()) setEstado({ fase: "error", archivo, error: { tipo: "red", mensaje: "No se pudo subir el archivo. Revisá tu conexión y probá de nuevo." } });
        return;
      }
      setEstado({ fase: "lista", archivo, storageKey: preparada.valor.storageKey });
    },
    [rendicionId, para],
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
