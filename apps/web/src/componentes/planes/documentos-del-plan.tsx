"use client";

/**
 * Los documentos de un plan, en la ficha de la unidad (encargo P2a-3): «Ver el acuerdo (PDF)», armar el
 * PDF por uno de los dos caminos, subir el firmado o el documento del estudio, y la historia.
 *
 * Sin regla de negocio: quién puede, qué plan lleva documentos, si hay modelo de cláusulas, que la clave
 * sea del plan y el SHA-256 lo deciden el servicio y la base. El PDF lo arma el worker: mientras se
 * arma, la ficha se refresca sola (`RefrescarMientrasCorre`, el de la pantalla de envío).
 */

import { useEffect, useState } from "react";
import type { DocumentosDelPlan } from "@admin-barrios/data/servicios/planes-documentos";
import type { EstadoPlan } from "@admin-barrios/shared/planes";
import { formatearFechaHora } from "@admin-barrios/shared/fechas";
import { LEYENDA_TEXTO_A_VALIDAR, TEXTO_CLASE_DOCUMENTO_PLAN } from "@admin-barrios/shared/planes-documentos";
import { AvisoEnLinea } from "@admin-barrios/ui";
import { agregarDocumentoDelPlanAction, armarDocumentoDelPlanAction } from "../../acciones/planes-documentos.ts";
import { RefrescarMientrasCorre } from "../refrescar-mientras-corre.tsx";
import { useSubidaDeDocumentoDelPlan } from "../useSubidaDeDocumentoDelPlan.ts";
import {
  Acciones,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoArchivo,
  CampoOpciones,
  Campos,
  Formulario,
  useFormulario,
} from "../formulario.tsx";
import { TEXTO_ESTADO_DEL_PLAN } from "./textos.ts";

const TIPOS_ACEPTADOS = "application/pdf,image/jpeg,image/png";

/** El último PDF que armó el sistema (acuerdo o anexo), para decir con qué estado del plan se armó. */
function ultimoArmado(d: Pick<DocumentosDelPlan, "documentos">) {
  return d.documentos.find((x) => x.clase === "acuerdo" || x.clase === "anexo") ?? null;
}

export function DocumentosDelPlanIsla({
  planId,
  estadoPlan,
  documentos,
  subidaConfigurada,
  rutaDeLosModelos,
}: {
  readonly planId: string;
  readonly estadoPlan: EstadoPlan;
  readonly documentos: DocumentosDelPlan;
  readonly subidaConfigurada: boolean;
  /** Configuración general › Estudios jurídicos, donde se crea y se edita el modelo. */
  readonly rutaDeLosModelos: string;
}) {
  const armar = useFormulario(armarDocumentoDelPlanAction);
  const agregar = useFormulario(agregarDocumentoDelPlanAction);
  const subida = useSubidaDeDocumentoDelPlan(planId);
  const [clase, setClase] = useState("firmado");
  const ultimo = ultimoArmado(documentos);
  const armando = documentos.armando.modelo || documentos.armando.anexo;
  const subiendo = subida.estado.fase === "pidiendoUrl" || subida.estado.fase === "subiendo";
  const listo = subida.estado.fase === "lista";
  const nombreDelArchivo = subida.estado.fase === "lista" ? subida.estado.archivo.name : "";
  const fallo = documentos.fallo;
  // Agregado el documento, el archivo elegido se suelta (el formulario lo resetea React; la subida, acá).
  const { reiniciar } = subida;
  useEffect(() => {
    if (agregar.resultado.estado === "ok") reiniciar();
  }, [agregar.resultado, reiniciar]);

  return (
    <>
      <RefrescarMientrasCorre activo={armando} />

      {/* El botón para abrirlo está en la cabecera de la ficha y en la tabla de abajo; acá, el estado (UX). */}
      {ultimo ? (
        <p>
          Último PDF: {TEXTO_CLASE_DOCUMENTO_PLAN[ultimo.clase].toLowerCase()}, armado el {formatearFechaHora(ultimo.registradoEl)} con el plan{" "}
          {TEXTO_ESTADO_DEL_PLAN[ultimo.estadoPlan].toLowerCase()}.
        </p>
      ) : null}
      {ultimo && ultimo.estadoPlan === "pendiente" && estadoPlan !== "pendiente" ? (
        <AvisoEnLinea tono="alerta">
          Ese PDF se armó con la propuesta. Al aprobarse, las cifras se recalcularon con la deuda de ese día: armalo de nuevo para que diga
          las del plan aprobado.
        </AvisoEnLinea>
      ) : null}
      {armando ? <AvisoEnLinea tono="info">Armando el PDF… La ficha se actualiza sola cuando está listo.</AvisoEnLinea> : null}
      {fallo && !armando ? (
        <AvisoEnLinea tono="alerta">
          No se pudo armar el PDF. {fallo} Probá de nuevo con «Armar el PDF»; si vuelve a fallar, avisá a soporte.
        </AvisoEnLinea>
      ) : null}

      {documentos.puedeAgregar ? (
        <Formulario accion={armar.enviar} etiqueta="Armar el PDF del plan">
          <input type="hidden" name="planId" value={planId} />
          <Campos>
            <CampoOpciones
              nombre="camino"
              etiqueta={ultimo ? "Armar otro PDF" : "Armar el PDF"}
              ancho
              valorInicial={armar.previos["camino"] ?? (documentos.hayModelo ? "modelo" : "anexo")}
              errores={armar.campos["camino"]}
              opciones={[
                {
                  valor: "modelo",
                  titulo: "El acuerdo con el modelo de cláusulas",
                  detalle: documentos.hayModelo ? (
                    <>
                      Las cláusulas completadas con las cifras del plan, las firmas y el anexo.
                      {documentos.modeloSinValidar ? ` Va con la leyenda «${LEYENDA_TEXTO_A_VALIDAR}».` : null}
                    </>
                  ) : (
                    <>
                      Todavía no hay un modelo de cláusulas: se crea en <a href={rutaDeLosModelos}>Estudios jurídicos</a>.
                    </>
                  ),
                  deshabilitada: !documentos.hayModelo,
                },
                {
                  valor: "anexo",
                  titulo: "Solo el anexo",
                  detalle: "Las cifras del plan, para acompañar el documento que redactó el estudio.",
                },
              ]}
            />
          </Campos>
          <Acciones ayuda={armando ? "Esperando que termine el PDF anterior." : undefined}>
            <BotonEnviar tono="secundario" pendiente={armar.pendiente} deshabilitado={armando} cargando="Pidiendo el PDF…">
              Armar el PDF
            </BotonEnviar>
          </Acciones>
          <Avisos>{armar.resultado.estado === "falla" ? <AvisoDeFallo error={armar.resultado.error} /> : null}</Avisos>
        </Formulario>
      ) : null}

      {documentos.puedeAgregar && subidaConfigurada ? (
        <Formulario accion={agregar.enviar} etiqueta="Agregar un documento al plan">
          <input type="hidden" name="planId" value={planId} />
          <input type="hidden" name="nombre" value={nombreDelArchivo} />
          <Campos>
            <CampoOpciones
              nombre="clase"
              etiqueta="Agregar un documento"
              enFila
              valorInicial={agregar.previos["clase"] ?? clase}
              alCambiar={setClase}
              errores={agregar.campos["clase"]}
              opciones={[
                { valor: "firmado", titulo: "El acuerdo firmado" },
                { valor: "del_estudio", titulo: "El documento del estudio" },
              ]}
            />
            <CampoArchivo
              nombre="clave"
              etiqueta="El archivo"
              aceptar={TIPOS_ACEPTADOS}
              estado={subida.estado}
              onElegirArchivo={subida.elegirArchivo}
              onReintentar={subida.reintentar}
              errores={agregar.campos["clave"] ?? agregar.campos["nombre"]}
              ayuda="PDF o foto (JPG o PNG). Un documento no reemplaza a otro: se agrega y queda la historia."
            />
          </Campos>
          <Acciones>
            <BotonEnviar tono="secundario" pendiente={agregar.pendiente} deshabilitado={!listo || subiendo} cargando="Agregando…">
              Agregar el documento
            </BotonEnviar>
          </Acciones>
          <Avisos>{agregar.resultado.estado === "falla" ? <AvisoDeFallo error={agregar.resultado.error} /> : null}</Avisos>
        </Formulario>
      ) : documentos.puedeAgregar ? (
        <AvisoEnLinea tono="info">Por ahora no se pueden subir archivos desde acá: el acuerdo firmado se agrega cuando esté habilitado.</AvisoEnLinea>
      ) : null}
    </>
  );
}
