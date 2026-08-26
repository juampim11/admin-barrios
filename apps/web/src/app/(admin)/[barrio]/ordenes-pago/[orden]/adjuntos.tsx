"use client";

/**
 * Los dos adjuntos de una orden de pago, en dos secciones separadas y nunca combinadas.
 *
 * **Por qué dos paneles y no una lista genérica de "adjuntos":** son dos documentos con dueño y
 * significado distintos. El **comprobante de pago** prueba que el BARRIO pagó (mirror de
 * `pago.comprobante_adjunto`, mismo hook/acción que `cobros/nuevo`); la **factura** es el documento
 * que el PROVEEDOR entregó — puede no existir nunca (proveedor informal, sin CUIT) y por eso tiene su
 * propio control de "esta orden no va a tener factura", que el comprobante no necesita.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * AUSENTE, NO DESHABILITADO — el control que corresponde según el estado del dato
 *
 * Una vez que un adjunto está cargado (`comprobanteAdjunto`/`facturaAdjunta` no nulos), es
 * **inmutable** (`0044`/`0048`): la pantalla no ofrece un control para reemplazarlo, ofrece el enlace
 * de descarga. Mientras la factura no está ni adjunta ni declarada "no disponible", se ofrecen los
 * DOS caminos a la vez (subir, o declarar que no va a haber). Una vez declarada "no disponible", el
 * botón de declarar desaparece (ya está declarada) pero el de subir **sigue** — `adjuntarFacturaDeOP`
 * acepta llegar después y limpia la declaración en el mismo `UPDATE` (panel
 * `administrador-consorcios`/`contador`, 2026-08-21).
 */

import { useState } from "react";
import type { OrdenPago } from "@admin-barrios/data/servicios/ordenes-pago";
import { CONTENT_TYPES_COMPROBANTE } from "@admin-barrios/shared/cobros";
import { BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import {
  adjuntarComprobanteDeOPAction,
  adjuntarFacturaDeOPAction,
  marcarFacturaNoDisponibleDeOPAction,
} from "../../../../../acciones/ordenes-pago.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeFallo,
  BotonEnviar,
  CampoArchivo,
  CampoParrafo,
  Formulario,
  useFormulario,
  type Salidas,
} from "../../../../../componentes/formulario.tsx";
import { useSubidaDeComprobanteDeOP } from "../../../../../componentes/useSubidaDeComprobanteDeOP.ts";
import { useSubidaDeFacturaDeOP } from "../../../../../componentes/useSubidaDeFacturaDeOP.ts";
import { Nota, Panel } from "../../../../../componentes/ui.tsx";
import estilos from "./orden.module.css";

const TIPOS_ACEPTADOS = CONTENT_TYPES_COMPROBANTE.join(",");

export function Adjuntos({ orden, salidas }: { readonly orden: OrdenPago; readonly salidas: Salidas }) {
  return (
    <>
      <SeccionComprobante orden={orden} salidas={salidas} />
      <SeccionFactura orden={orden} salidas={salidas} />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Comprobante de pago
// ────────────────────────────────────────────────────────────────────────────────────────────────

function SeccionComprobante({ orden, salidas }: { readonly orden: OrdenPago; readonly salidas: Salidas }) {
  const subida = useSubidaDeComprobanteDeOP(orden.id);
  const { enviar, pendiente, resultado } = useFormulario(adjuntarComprobanteDeOPAction);

  const yaAdjunto = orden.comprobanteAdjunto ?? (resultado.estado === "ok" ? resultado.valor.comprobanteAdjunto : null);

  return (
    <Panel
      titulo="Comprobante de pago"
      origen="Prueba que el barrio pagó. Se puede adjuntar en cualquier estado; una vez adjunto, no se reemplaza."
    >
      {yaAdjunto ? (
        <a href={`/api/ordenes-pago/${orden.id}/comprobante`} download className={estilos.enlaceAdjunto}>
          Descargar comprobante
        </a>
      ) : (
        <Formulario accion={enviar} etiqueta="Adjuntar el comprobante de pago">
          <input type="hidden" name="ordenPagoId" value={orden.id} />
          <CampoArchivo
            nombre="storageKey"
            etiqueta="Archivo"
            requerido
            aceptar={TIPOS_ACEPTADOS}
            estado={subida.estado}
            onElegirArchivo={subida.elegirArchivo}
            onReintentar={subida.reintentar}
            ayuda="PDF o foto (JPG o PNG), hasta 10 MB. Se sube apenas lo elegís."
          />
          <Avisos>
            {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
          </Avisos>
          <Acciones
            ayuda={subida.estado.fase !== "lista" ? "Elegí un archivo para poder guardarlo." : undefined}
          >
            <BotonEnviar pendiente={pendiente} deshabilitado={subida.estado.fase !== "lista"} cargando="Guardando…">
              Guardar comprobante
            </BotonEnviar>
          </Acciones>
        </Formulario>
      )}
    </Panel>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Factura del proveedor
// ────────────────────────────────────────────────────────────────────────────────────────────────

function SeccionFactura({ orden, salidas }: { readonly orden: OrdenPago; readonly salidas: Salidas }) {
  const subida = useSubidaDeFacturaDeOP(orden.id);
  const adjuntar = useFormulario(adjuntarFacturaDeOPAction);
  const declarar = useFormulario(marcarFacturaNoDisponibleDeOPAction);
  const [mostrarDeclarar, setMostrarDeclarar] = useState(false);

  const yaAdjunta = orden.facturaAdjunta ?? (adjuntar.resultado.estado === "ok" ? adjuntar.resultado.valor.facturaAdjunta : null);
  const yaNoDisponible =
    !yaAdjunta &&
    (orden.facturaNoDisponible ||
      (declarar.resultado.estado === "ok" && declarar.resultado.valor.facturaNoDisponible));
  const motivoNoDisponible =
    orden.motivoFacturaNoDisponible ??
    (declarar.resultado.estado === "ok" ? declarar.resultado.valor.motivoFacturaNoDisponible : null);

  return (
    <Panel
      titulo="Factura del proveedor"
      origen="El documento que entregó el proveedor — distinto del comprobante de pago. Puede declararse que esta orden no va a tener."
    >
      {yaAdjunta ? (
        <a href={`/api/ordenes-pago/${orden.id}/factura`} download className={estilos.enlaceAdjunto}>
          Descargar factura
        </a>
      ) : (
        <div className={estilos.pilaFactura}>
          {yaNoDisponible ? (
            <Nota tono="info" titulo="Se declaró que esta orden no va a tener factura.">
              {motivoNoDisponible ?? "Sin motivo registrado."} Si la factura llega más adelante, se
              puede adjuntar igual: reemplaza la declaración.
            </Nota>
          ) : null}

          <Formulario accion={adjuntar.enviar} etiqueta="Adjuntar la factura del proveedor">
            <input type="hidden" name="ordenPagoId" value={orden.id} />
            <CampoArchivo
              nombre="storageKey"
              etiqueta="Archivo"
              requerido
              aceptar={TIPOS_ACEPTADOS}
              estado={subida.estado}
              onElegirArchivo={subida.elegirArchivo}
              onReintentar={subida.reintentar}
              ayuda="PDF o foto (JPG o PNG), hasta 10 MB. Se sube apenas lo elegís."
            />
            <Avisos>
              {adjuntar.resultado.estado === "falla" ? (
                <AvisoDeFallo error={adjuntar.resultado.error} salidas={salidas} />
              ) : null}
            </Avisos>
            <Acciones
              ayuda={subida.estado.fase !== "lista" ? "Elegí un archivo para poder guardarla." : undefined}
            >
              <BotonEnviar
                pendiente={adjuntar.pendiente}
                deshabilitado={subida.estado.fase !== "lista"}
                cargando="Guardando…"
              >
                Guardar factura
              </BotonEnviar>
            </Acciones>
          </Formulario>

          {!yaNoDisponible ? (
            mostrarDeclarar ? (
              <Formulario accion={declarar.enviar} etiqueta="Declarar que esta orden no va a tener factura">
                <input type="hidden" name="ordenPagoId" value={orden.id} />
                <CampoParrafo
                  nombre="motivo"
                  etiqueta="Motivo"
                  requerido
                  maximo={500}
                  filas={2}
                  errores={declarar.campos["motivo"]}
                  ayuda="Ej: proveedor informal, sin CUIT. Mínimo cinco caracteres."
                />
                <Avisos>
                  {declarar.resultado.estado === "falla" ? (
                    <AvisoDeFallo error={declarar.resultado.error} salidas={salidas} />
                  ) : null}
                  {declarar.campos[""] ? <AvisoDeCamposSueltos mensajes={declarar.campos[""]} /> : null}
                </Avisos>
                <Acciones>
                  <BotonEnviar tono="secundario" pendiente={declarar.pendiente} cargando="Guardando…">
                    Declarar sin factura
                  </BotonEnviar>
                </Acciones>
              </Formulario>
            ) : (
              <BotonDeAccion variante="sutil" tamano="sm" onClick={() => setMostrarDeclarar(true)}>
                Esta orden no va a tener factura
              </BotonDeAccion>
            )
          ) : null}
        </div>
      )}
    </Panel>
  );
}
