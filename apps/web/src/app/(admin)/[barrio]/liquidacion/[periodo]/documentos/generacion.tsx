"use client";

/**
 * El botón que encola la generación y el seguimiento de cómo va.
 *
 * **El polling vive en `../seguimiento.ts`**, compartido con la pantalla de distribución: ahí está
 * la cadencia (2 · 4 · 6 · 8 y de ahí cada 10, techo de cinco minutos) y el porqué de que sea
 * polling y no una conexión abierta. Acá quedó solo lo que es de esta pantalla.
 */

import type { Trabajo } from "@admin-barrios/data/servicios/trabajos";
import { generarDocumentosAction } from "../../../../../../acciones/liquidacion.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  Formulario,
  useFormulario,
  type Salidas,
} from "../../../../../../componentes/formulario.tsx";
import { Nota } from "../../../../../../componentes/ui.tsx";
import { terminado, useSeguimientoDeTrabajo, useTranscurrido } from "../seguimiento.ts";
import estilos from "./documentos.module.css";

export function GeneracionDeDocumentos({
  periodoId,
  trabajoInicial,
  documentosYaEmitidos,
  salidas,
}: {
  readonly periodoId: string;
  readonly trabajoInicial: Trabajo | null;
  readonly documentosYaEmitidos: number;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado } = useFormulario(generarDocumentosAction);

  // El trabajo que se está mirando: el que había al cargar la página, o el que acaba de encolarse.
  const { trabajo, seRindio, enCurso } = useSeguimientoDeTrabajo(
    trabajoInicial,
    resultado.estado === "ok" ? resultado.valor : null,
  );


  return (
    <>
      {trabajo ? <EstadoDelTrabajo trabajo={trabajo} seRindio={seRindio} /> : null}

      <Formulario accion={enviar} etiqueta="Generar los documentos del período">
        <input type="hidden" name="periodoId" value={periodoId} />

        <Avisos>
          {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
          {resultado.estado === "campos" ? (
            <AvisoDeCamposSueltos mensajes={Object.values(resultado.campos).flatMap((m) => m ?? [])} />
          ) : null}
        </Avisos>

        <Acciones
          ayuda={
            documentosYaEmitidos > 0
              ? "Genera solo las boletas que falten: las que ya están emitidas no se tocan ni se vuelven a hacer. Si no falta ninguna, no hace nada."
              : "Los documentos se generan en un proceso aparte, no en esta pantalla: son unos segundos por cada cien boletas. Podés irte y volver — el estado queda guardado."
          }
        >
          <BotonEnviar tono="primario" pendiente={pendiente || enCurso} cargando="Encolando…">
            {documentosYaEmitidos > 0 ? "Generar los que falten" : "Generar los documentos"}
          </BotonEnviar>
        </Acciones>
      </Formulario>
    </>
  );
}

function EstadoDelTrabajo({ trabajo, seRindio }: { readonly trabajo: Trabajo; readonly seRindio: boolean }) {
  // El hook va acá arriba, antes de cualquier `return` temprano: las reglas de hooks no admiten que
  // se llame condicionalmente. Devuelve `null` solo si el trabajo todavía no arrancó.
  const transcurrido = useTranscurrido(terminado(trabajo) ? null : trabajo.iniciadoAt);
  if (trabajo.estado === "fallado") {
    return (
      <Nota tono="peligro" titulo="La generación no terminó.">
        <p>{trabajo.error ?? "No quedó registrado el motivo."}</p>
        <p>
          Volver a generar es seguro: los documentos que ya se escribieron no se tocan y se completan
          los que faltan.
        </p>
      </Nota>
    );
  }

  if (trabajo.estado === "terminado") {
    // "Los N documentos del período están listos" y no "se generaron N": cuando el período ya estaba
    // completo no se generó ninguno, y la nota decía que se habían hecho 50 mientras el registro del
    // proceso decía "0 documentos (50 ya estaban)". Lo que ve la persona tiene que ser lo que pasó.
    return (
      <Nota tono="exito" titulo={`Los ${trabajo.hechos} documentos del período están listos.`}>
        <p>Quedan guardados tal como se emitieron. Descargarlos no los vuelve a generar.</p>
      </Nota>
    );
  }

  if (seRindio) {
    return (
      <Nota tono="alerta" titulo="La generación está tardando más de lo normal.">
        <p>
          Dejé de consultar para no seguir pidiendo cada diez segundos. Recargá la pantalla para ver
          cómo quedó.
        </p>
        <p>
          Si el proceso que genera los documentos se interrumpió, el período <strong>se libera solo</strong>{" "}
          en unos minutos y vas a poder volver a generar. No hay nada que arreglar a mano.
        </p>
      </Nota>
    );
  }

  // `total` es `null` hasta que el proceso leyó cuántas liquidaciones hay: mientras tanto, decirlo,
  // en vez de dibujar una barra sobre un denominador que todavía no existe.
  const preparando = trabajo.total === null;

  return (
    <Nota tono="info" titulo={preparando ? "Preparando la generación…" : "Generando los documentos…"}>
      {preparando ? (
        <p>Leyendo las liquidaciones del período.</p>
      ) : (
        <p className={estilos.progreso}>
          <progress value={trabajo.hechos} max={trabajo.total ?? undefined} />
          {/*
            Cada cifra en su propia caja con `flex: 0 0 auto`. Antes eran un `<span>` suelto y la
            barra —`flex: 1 1 auto`— se le encimaba: el `gap` que tenían que separarlos apuntaba a un
            token inexistente (`--space-3`) y la declaración se descartaba en silencio. Así lo
            encontró el usuario: la barra pisando el "50 de 510".
          */}
          <span className={estilos.progresoCuenta}>
            {trabajo.hechos} de {trabajo.total}
          </span>
          {transcurrido ? <span className={estilos.progresoReloj}>{transcurrido}</span> : null}
        </p>
      )}
      <p>Se actualiza sola. Podés irte de esta pantalla y volver.</p>
    </Nota>
  );
}
