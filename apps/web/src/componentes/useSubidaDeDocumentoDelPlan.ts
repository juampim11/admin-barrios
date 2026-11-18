"use client";

/**
 * El micro-flujo de subida (elegir → validar → pedir URL presignada → POST directo al storage →
 * `storageKey`) aplicado a **un documento de un plan de pagos**: el acuerdo firmado o el documento del
 * estudio (encargo P2a-3). Mismo patrón que `useSubidaDeRespaldo.ts`; cambia la acción y el campo que
 * identifica a qué va (`planId`). Lo genérico se reusa de `useSubidaDeComprobante.ts`.
 */

import { useCallback, useRef, useState } from "react";
import { prepararSubidaDeDocumentoDelPlanAction, type SubidaDeDocumentoPreparada } from "../acciones/planes-documentos.ts";
import { INICIAL, type ResultadoDeAccion } from "../acciones/resultado.ts";
import {
  armarFormDataDeSubida,
  validarArchivoDeComprobante,
  type ErrorDeSubida,
  type EstadoDeSubida,
} from "./useSubidaDeComprobante.ts";

export function useSubidaDeDocumentoDelPlan(planId: string): {
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
      parametros.set("planId", planId);
      parametros.set("contentType", archivo.type);

      let preparada: ResultadoDeAccion<SubidaDeDocumentoPreparada>;
      try {
        preparada = await prepararSubidaDeDocumentoDelPlanAction(INICIAL, parametros);
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
    [planId],
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
