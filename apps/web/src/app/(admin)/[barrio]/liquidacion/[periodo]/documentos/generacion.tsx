"use client";

/**
 * El botón que encola la generación y el seguimiento de cómo va.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO ES POLLING Y NO UNA CONEXIÓN ABIERTA
 *
 * Una conexión de tiempo real por administrador es un canal más que operar y que sobrevivir a un
 * balanceador, para un proceso que dura quince segundos y ocurre doce veces al año por barrio. La
 * regla §4 del presupuesto de recursos es explícita: tiempo real solo si el negocio lo exige.
 *
 * Y el polling **es espaciado**, no de dos segundos: 2 · 4 · 6 · 8 y de ahí cada 10, con techo de
 * cinco minutos. Una emisión típica son ~5 pedidos. Al terminar hace **un** `router.refresh()`, no
 * una cascada.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import estilos from "./documentos.module.css";

/** Los intervalos, en milisegundos. El último se repite hasta el techo. */
const ESPERAS = [2_000, 4_000, 6_000, 8_000, 10_000] as const;
/** Cinco minutos. Pasado esto, la pantalla deja de preguntar y ofrece recargar a mano. */
const TECHO_MS = 5 * 60_000;

function terminado(t: Trabajo): boolean {
  return t.estado === "terminado" || t.estado === "fallado";
}

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
  const router = useRouter();

  // El trabajo que se está mirando: el que había al cargar la página, o el que acaba de encolarse.
  const encolado = resultado.estado === "ok" ? resultado.valor : null;
  const [trabajo, setTrabajo] = useState<Trabajo | null>(trabajoInicial);
  const [seRindio, setSeRindio] = useState(false);
  const yaRefresco = useRef(false);

  useEffect(() => {
    if (encolado) {
      setTrabajo(encolado);
      setSeRindio(false);
      yaRefresco.current = false;
    }
  }, [encolado]);

  const seguir = useCallback(
    (id: string) => {
      let vivo = true;
      let vuelta = 0;
      const arranque = Date.now();

      async function preguntar(): Promise<void> {
        if (!vivo) return;
        if (Date.now() - arranque > TECHO_MS) {
          setSeRindio(true);
          return;
        }
        try {
          const respuesta = await fetch(`/api/trabajos/${id}`, { cache: "no-store" });
          if (respuesta.ok) {
            const nuevo = (await respuesta.json()) as Trabajo;
            if (!vivo) return;
            setTrabajo(nuevo);
            if (terminado(nuevo)) {
              // UNA vez, al final. Es lo que trae la lista de documentos ya escrita.
              if (!yaRefresco.current) {
                yaRefresco.current = true;
                router.refresh();
              }
              return;
            }
          }
        } catch {
          // Un pedido que falla no corta el seguimiento: se reintenta en la próxima vuelta.
        }
        // `vuelta` se incrementa ANTES de leer la espera: si no, la segunda consulta repetía los 2 s
        // de la primera y el backoff real era 2 · 2 · 4 · 6 · 8 · 10, no el que dice el docstring.
        vuelta += 1;
        const espera = ESPERAS[Math.min(vuelta, ESPERAS.length - 1)] ?? 10_000;
        setTimeout(() => void preguntar(), espera);
      }

      setTimeout(() => void preguntar(), ESPERAS[0]);
      return () => {
        vivo = false;
      };
    },
    [router],
  );

  useEffect(() => {
    if (!trabajo || terminado(trabajo)) return;
    return seguir(trabajo.id);
    // Solo el id: si dependiera del objeto entero, cada respuesta del polling arrancaría otro ciclo.
  }, [trabajo?.id, seguir]); // eslint-disable-line react-hooks/exhaustive-deps

  const enCurso = trabajo !== null && !terminado(trabajo);

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
          <span>
            {trabajo.hechos} de {trabajo.total}
          </span>
        </p>
      )}
      <p>Se actualiza sola. Podés irte de esta pantalla y volver.</p>
    </Nota>
  );
}
