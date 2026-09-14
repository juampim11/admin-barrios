"use client";

/**
 * El mismo micro-flujo que `useSubidaDeComprobante.ts` (elegir → validar → pedir URL presignada →
 * POST directo al storage → `storageKey`), aplicado al comprobante de una **orden de pago** en vez
 * del de un `pago`.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ES UN HOOK PARALELO Y NO `useSubidaDeComprobante()` GENERALIZADO
 *
 * Se evaluaron las dos opciones (encargo explícito del cierre de gaps de la UI de Proveedores/OP,
 * 2026-08-21) y se optó por duplicar la orquestación, no generalizarla. El argumento:
 *
 * Lo genuinamente genérico de `useSubidaDeComprobante.ts` —`validarArchivoDeComprobante()`,
 * `armarFormDataDeSubida()`, `EstadoDeSubida`, `ErrorDeSubida`— **ya no está acoplado a `pago`** y se
 * reusa tal cual, importado de ahí (ver abajo). Lo que sí está acoplado, y es la única parte que este
 * archivo duplica, es la función `iniciarSubida()`: hardcodea el nombre del Server Action
 * (`prepararSubidaDeComprobanteAction`, de `acciones/cobros.ts`) y el nombre del campo del `FormData`
 * (`unidadFuncionalId`) — que para una orden de pago es literalmente otro Server Action
 * (`prepararSubidaDeComprobanteDeOPAction`, `acciones/ordenes-pago.ts`) contra otro esquema
 * (`prepararSubidaDeComprobanteDeOPSchema`, que exige `ordenPagoId`, no `unidadFuncionalId`).
 *
 * Generalizar esa función exigiría inyectar el Server Action y el nombre del campo desde cada
 * llamador —un objeto de configuración en vez de un `string`— y **tocar el único punto de llamada
 * que hoy está en producción y probado**: `cobros/nuevo/formulario.tsx:103` y sus 8 tests en
 * `useSubidaDeComprobante.test.ts`. El beneficio de esa generalización es evitar ~90 líneas
 * duplicadas; el costo es reabrir y volver a verificar una pantalla que ya funciona, por una feature
 * que todavía no tiene ni una pantalla propia. Mismo criterio que ya aplica este repo en
 * `packages/data/src/servicios/roles.ts` entre `ROLES_QUE_EMITEN`/`ROLES_QUE_REGISTRAN_PAGO`: dos
 * operaciones de dominio distintas que hoy coinciden se dejan como dos definiciones, para que tocar
 * una no le cambie el comportamiento a la otra sin que nadie lo haya decidido.
 *
 * Si el día de mañana aparece una TERCERA subida de comprobante (o esta y la de `pago` divergen en
 * validación), ahí sí generalizar paga: ya no sería "una abstracción para dos usos que hoy son
 * iguales", sería una que **N** usos necesitan de verdad.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useRef, useState } from "react";
import { prepararSubidaDeComprobanteDeOPAction, type SubidaComprobanteDeOPPreparada } from "../acciones/ordenes-pago.ts";
import { INICIAL, type ResultadoDeAccion } from "../acciones/resultado.ts";
import {
  armarFormDataDeSubida,
  validarArchivoDeComprobante,
  type ErrorDeSubida,
  type EstadoDeSubida,
} from "./useSubidaDeComprobante.ts";

export function useSubidaDeComprobanteDeOP(ordenPagoId: string): {
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
        preparada = await prepararSubidaDeComprobanteDeOPAction(INICIAL, parametros);
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
