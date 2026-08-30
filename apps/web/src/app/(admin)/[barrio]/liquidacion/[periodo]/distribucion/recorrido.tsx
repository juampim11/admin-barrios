"use client";

/**
 * El recorrido de tres pasos, con el seguimiento de cada trabajo.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL POLLING ES EL MISMO QUE EL DE `documentos/generacion.tsx`, Y ESTÁ ESCRITO UNA SOLA VEZ
 *
 * `useSeguimientoDeTrabajo` vive en `../seguimiento.ts` y lo usan las dos pantallas. Antes de
 * extraerlo eran el mismo backoff, el mismo techo y el mismo `router.refresh()` copiados; acá
 * habrían quedado copiados **tres veces más**, y una cadencia que se cambia en un lugar y no en los
 * otros es un pedido cada dos segundos que nadie sabe de dónde sale.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LOS TRES PASOS SE SIGUEN A LA VEZ, PERO CADA UNO CON SU PROPIO TRABAJO
 *
 * Tres componentes y no uno con un array: la cantidad de pasos es fija y conocida, y un array de
 * hooks es exactamente lo que las reglas de hooks prohíben.
 */

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { PanoramaDeDistribucion } from "@admin-barrios/data/servicios/distribucion";
import type { Trabajo } from "@admin-barrios/data/servicios/trabajos";
import {
  armarPaqueteAction,
  distribuirAction,
  emitirInformeAction,
} from "../../../../../../acciones/distribucion.ts";
import {
  Acciones,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  Formulario,
  useFormulario,
  type Salidas,
} from "../../../../../../componentes/formulario.tsx";
import { Nota } from "../../../../../../componentes/ui.tsx";
import { useSeguimientoDeTrabajo } from "../seguimiento.ts";
import estilos from "./distribucion.module.css";

/** Cuántos kilobytes, para que el peso se lea sin hacer cuentas. Igual que en `documentos/`. */
function enKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

export function RecorridoDeDistribucion({
  periodoId,
  panorama,
  trabajoInforme,
  trabajoPaquete,
  trabajoEnvio,
  rutaDocumentos,
  rutaPadron,
  salidas,
}: {
  readonly periodoId: string;
  readonly panorama: PanoramaDeDistribucion;
  readonly trabajoInforme: Trabajo | null;
  readonly trabajoPaquete: Trabajo | null;
  readonly trabajoEnvio: Trabajo | null;
  readonly rutaDocumentos: string;
  readonly rutaPadron: string;
  readonly salidas: Salidas;
}) {
  return (
    <ol className={estilos.pasos}>
      <PasoInforme
        periodoId={periodoId}
        panorama={panorama}
        trabajoInicial={trabajoInforme}
        salidas={salidas}
      />
      <PasoPaquete
        periodoId={periodoId}
        panorama={panorama}
        trabajoInicial={trabajoPaquete}
        rutaDocumentos={rutaDocumentos}
        salidas={salidas}
      />
      <PasoEnvio
        periodoId={periodoId}
        panorama={panorama}
        trabajoInicial={trabajoEnvio}
        rutaPadron={rutaPadron}
        salidas={salidas}
      />
    </ol>
  );
}

/** El marco de un paso: número, título, sello y cuerpo. Los tres se dibujan igual. */
function Paso({
  numero,
  titulo,
  hecho,
  children,
}: {
  readonly numero: number;
  readonly titulo: string;
  /** Pinta el paso como cumplido. Es **estado real leído de la base**, no "ya lo apreté". */
  readonly hecho: boolean;
  readonly children: ReactNode;
}) {
  return (
    <li className={estilos.paso}>
      <div className={estilos.pasoCabecera}>
        {/*
          El número va en un `aria-hidden`: la lista ordenada ya lo anuncia, y sin esto un lector de
          pantalla lee "1 1 Emitir el informe mensual".
        */}
        <span className={estilos.pasoNumero} aria-hidden="true">
          {numero}
        </span>
        <h3 className={estilos.pasoTitulo}>{titulo}</h3>
        <span className={hecho ? estilos.selloHecho : estilos.selloPendiente}>
          {hecho ? "Hecho" : "Pendiente"}
        </span>
      </div>
      <div className={estilos.pasoCuerpo}>{children}</div>
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Paso 1 · El informe mensual
// ────────────────────────────────────────────────────────────────────────────────────────────────

function PasoInforme({
  periodoId,
  panorama,
  trabajoInicial,
  salidas,
}: {
  readonly periodoId: string;
  readonly panorama: PanoramaDeDistribucion;
  readonly trabajoInicial: Trabajo | null;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado } = useFormulario(emitirInformeAction);
  const { trabajo, seRindio, enCurso } = useSeguimientoDeTrabajo(
    trabajoInicial,
    resultado.estado === "ok" ? resultado.valor : null,
  );

  return (
    <Paso numero={1} titulo="Emitir el informe mensual" hecho={panorama.informeEmitido}>
      <p className={estilos.pasoTexto}>
        Es el <strong>segundo adjunto</strong> de cada correo: el resultado del período y la
        composición del gasto del barrio. Va igual para todos, y no lleva información de morosidad.
      </p>

      {trabajo ? (
        <EstadoDelTrabajo
          trabajo={trabajo}
          seRindio={seRindio}
          hecho="El informe del período está emitido."
        />
      ) : null}

      {panorama.informeEmitido && !enCurso ? null : (
        <Formulario accion={enviar} etiqueta="Emitir el informe mensual del período">
          <input type="hidden" name="periodoId" value={periodoId} />
          <Avisos>
            {resultado.estado === "falla" ? (
              <AvisoDeFallo error={resultado.error} salidas={salidas} />
            ) : null}
          </Avisos>
          <Acciones ayuda="Se emite en un proceso aparte. Podés irte de la pantalla y volver.">
            <BotonEnviar tono="primario" pendiente={pendiente || enCurso} cargando="Encolando…">
              Emitir el informe
            </BotonEnviar>
          </Acciones>
        </Formulario>
      )}
    </Paso>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Paso 2 · El paquete
// ────────────────────────────────────────────────────────────────────────────────────────────────

function PasoPaquete({
  periodoId,
  panorama,
  trabajoInicial,
  rutaDocumentos,
  salidas,
}: {
  readonly periodoId: string;
  readonly panorama: PanoramaDeDistribucion;
  readonly trabajoInicial: Trabajo | null;
  readonly rutaDocumentos: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado } = useFormulario(armarPaqueteAction);
  const { trabajo, seRindio, enCurso } = useSeguimientoDeTrabajo(
    trabajoInicial,
    resultado.estado === "ok" ? resultado.valor : null,
  );
  const paquete = panorama.paquete;
  const superado = paquete !== null && paquete.boletasFaltantes > 0;

  return (
    <Paso numero={2} titulo="Armar el paquete del período" hecho={paquete !== null && !superado}>
      <p className={estilos.pasoTexto}>
        Un ZIP con las boletas del período, para archivar y para quien prefiera los archivos sueltos.{" "}
        <strong>No se le manda a ningún vecino</strong>: el correo de cada unidad lleva solo la suya.
      </p>

      {trabajo ? (
        <EstadoDelTrabajo
          trabajo={trabajo}
          seRindio={seRindio}
          hecho="El paquete del período está armado."
        />
      ) : null}

      {paquete ? (
        <>
          {/*
            **Acá NO se dice una palabra sobre cuánto vive este archivo.** La carpeta `/paquetes/`
            está separada del resto justamente para poder colgarle una regla de expiración del
            bucket, pero esa regla **no está aprovisionada en ninguna infra**: no existe en el
            `docker-compose`, no hay infraestructura como código, y ni la web ni el worker tienen
            permiso de borrado —`ObjectStorage` ni siquiera expone un `remove()`—. Un cartel que
            dijera "se elimina a los N días" sería una promesa que nada en el sistema cumple, y
            alguien podría no guardar su copia confiando en ella. Ver el docstring de `page.tsx`.
          */}
          <p className={estilos.fichaPaquete}>
            {paquete.documentos} boleta(s) empaquetadas · {enKb(paquete.bytes)} · armado el{" "}
            {paquete.armadoAt.slice(0, 16).replace("T", " ")}
          </p>
          <p>
            {/*
              Un enlace común, sin JavaScript: la ruta responde un 302 a una URL firmada de vida
              corta. Viaja el `periodoId`, nunca la clave del archivo.
            */}
            <a className={estilos.descarga} href={`/api/paquetes/${periodoId}`} download>
              Descargar el ZIP
            </a>
          </p>
        </>
      ) : null}

      {superado && paquete ? (
        <Nota tono="alerta" titulo="El paquete quedó desactualizado.">
          <p>
            Se emitieron {paquete.boletasFaltantes} boleta(s) después de armarlo, así que el ZIP que
            se descarga hoy <strong>no las tiene</strong>. Armalo de nuevo antes de distribuir.
          </p>
          <p>
            <Link href={rutaDocumentos}>Ver los documentos del período</Link>
          </p>
        </Nota>
      ) : null}

      {paquete !== null && !superado && !enCurso ? null : (
        <Formulario accion={enviar} etiqueta="Armar el paquete del período">
          <input type="hidden" name="periodoId" value={periodoId} />
          <Avisos>
            {resultado.estado === "falla" ? (
              <AvisoDeFallo error={resultado.error} salidas={salidas} />
            ) : null}
          </Avisos>
          <Acciones ayuda="Rearmarlo es seguro: escribe un archivo nuevo y no toca ningún correo.">
            <BotonEnviar tono="primario" pendiente={pendiente || enCurso} cargando="Encolando…">
              {paquete ? "Rearmar el paquete" : "Armar el paquete"}
            </BotonEnviar>
          </Acciones>
        </Formulario>
      )}
    </Paso>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Paso 3 · Los correos — el único que no se deshace
// ────────────────────────────────────────────────────────────────────────────────────────────────

function PasoEnvio({
  periodoId,
  panorama,
  trabajoInicial,
  rutaPadron,
  salidas,
}: {
  readonly periodoId: string;
  readonly panorama: PanoramaDeDistribucion;
  readonly trabajoInicial: Trabajo | null;
  readonly rutaPadron: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado } = useFormulario(distribuirAction);
  const { trabajo, seRindio, enCurso } = useSeguimientoDeTrabajo(
    trabajoInicial,
    resultado.estado === "ok" ? resultado.valor : null,
  );

  /*
   * **La confirmación es de dos tiempos, y vive acá.**
   *
   * No valida ningún dato —no hay nada que tipear—, así que no es de las que el ADR-0003 §9 manda a
   * un esquema Zod: eso es sobre la validación de los campos de un formulario, y esto no lo es. Lo
   * que hace es obligar a **leer los dos conteos antes de mandar**: a cuántos les llega y a cuántos
   * no. El segundo es el que nadie mira si el botón manda a la primera, y es el que después explica
   * por qué tres vecinos llamaron diciendo que no recibieron nada.
   */
  const [confirmando, setConfirmando] = useState(false);
  const envios = panorama.envios;
  const yaSeEscribio =
    envios.aceptados + envios.fallados + envios.pendientes + envios.enviando > 0;

  if (!panorama.puedeDistribuir) {
    // **No se le ofrece la acción a quien la base va a rechazar.** Mismo criterio que la pantalla de
    // documentos: el control real está en el trigger de `0053` y funciona; esto es honestidad.
    return (
      <Paso numero={3} titulo="Enviar el correo a cada unidad" hecho={envios.aceptados > 0}>
        <Nota tono="info" titulo="La distribución la hace quien administra el barrio.">
          <p>
            Con tu rol podés emitir el informe y armar el paquete, pero{" "}
            <strong>no mandar los correos</strong>: la distribución envía datos personales fuera del
            sistema, y eso no se hereda de poder generar los documentos.
          </p>
        </Nota>
      </Paso>
    );
  }

  return (
    <Paso numero={3} titulo="Enviar el correo a cada unidad" hecho={envios.aceptados > 0}>
      <p className={estilos.pasoTexto}>
        Un correo por unidad, con <strong>su</strong> boleta y el informe del barrio. Cada mensaje
        lleva únicamente la unidad de quien lo recibe.
      </p>

      {trabajo ? (
        <EstadoDelTrabajo
          trabajo={trabajo}
          seRindio={seRindio}
          hecho="Los correos del período salieron."
        />
      ) : null}

      {yaSeEscribio ? (
        <dl className={estilos.recuento}>
          <div>
            <dt>Aceptados</dt>
            <dd>{envios.aceptados}</dd>
          </div>
          <div>
            <dt>Pendientes</dt>
            <dd>{envios.pendientes}</dd>
          </div>
          <div>
            <dt>En vuelo</dt>
            <dd>{envios.enviando}</dd>
          </div>
          <div>
            <dt>Fallados</dt>
            <dd>{envios.fallados}</dd>
          </div>
        </dl>
      ) : null}

      {confirmando ? (
        <Nota tono="alerta" titulo="Un correo enviado no se puede retirar.">
          <p>
            Se le va a escribir a <strong>{panorama.destinatarios} unidad(es)</strong> con casilla
            cargada.
          </p>
          {panorama.unidadesSinContacto > 0 ? (
            <p>
              <strong>
                {panorama.unidadesSinContacto} unidad(es) no van a recibir nada
              </strong>{" "}
              porque no tienen ninguna casilla activa en el padrón. Su boleta está emitida igual y se
              puede descargar. <Link href={rutaPadron}>Revisar los contactos del padrón</Link>
            </p>
          ) : null}
          <p>
            Volver a mandar es seguro en un sentido: a quien ya recibió el correo{" "}
            <strong>no se le escribe dos veces</strong> — lo impide el registro por destinatario.
          </p>
        </Nota>
      ) : null}

      <Formulario accion={enviar} etiqueta="Enviar las liquidaciones del período">
        <input type="hidden" name="periodoId" value={periodoId} />
        <Avisos>
          {resultado.estado === "falla" ? (
            <AvisoDeFallo error={resultado.error} salidas={salidas} />
          ) : null}
        </Avisos>
        <Acciones
          ayuda={
            confirmando
              ? "Este es el único paso del recorrido que no se puede deshacer."
              : "Antes de mandar vas a ver a cuántas unidades les llega y a cuántas no."
          }
        >
          {confirmando ? (
            <>
              <BotonEnviar tono="peligro" pendiente={pendiente || enCurso} cargando="Encolando…">
                Sí, enviar a {panorama.destinatarios} unidad(es)
              </BotonEnviar>
              {/*
                `type="button"`: adentro de un `<form>`, un botón sin tipo es `submit` — y éste
                cancela. Es el modo de falla que convertiría "Volver" en "mandar igual".
              */}
              <button
                type="button"
                className={estilos.cancelar}
                onClick={() => setConfirmando(false)}
              >
                Volver
              </button>
            </>
          ) : (
            <button
              type="button"
              className={estilos.avanzar}
              onClick={() => setConfirmando(true)}
              disabled={enCurso || panorama.destinatarios === 0}
            >
              {envios.aceptados > 0 ? "Enviar a los que faltan" : "Preparar el envío"}
            </button>
          )}
        </Acciones>
      </Formulario>

      {panorama.destinatarios === 0 ? (
        <Nota tono="alerta" titulo="No hay a quién escribirle.">
          <p>
            Ninguna de las {panorama.unidadesSinContacto} unidad(es) con boleta emitida tiene una
            casilla activa cargada. <Link href={rutaPadron}>Cargar contactos en el padrón</Link>
          </p>
        </Nota>
      ) : null}
    </Paso>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El estado de un trabajo, compartido por los tres pasos
// ────────────────────────────────────────────────────────────────────────────────────────────────

function EstadoDelTrabajo({
  trabajo,
  seRindio,
  hecho,
}: {
  readonly trabajo: Trabajo;
  readonly seRindio: boolean;
  readonly hecho: string;
}) {
  if (trabajo.estado === "fallado") {
    return (
      <Nota tono="peligro" titulo="El paso no terminó.">
        <p>{trabajo.error ?? "No quedó registrado el motivo."}</p>
        <p>
          Reintentarlo <strong>no repite los otros dos pasos</strong>: son trabajos separados, y por
          eso un fallo acá no vuelve a escribirle a nadie.
        </p>
      </Nota>
    );
  }

  if (trabajo.estado === "terminado") {
    return (
      <Nota tono="exito" titulo={hecho}>
        <p>Quedó registrado con quién lo pidió y cuándo.</p>
      </Nota>
    );
  }

  if (seRindio) {
    return (
      <Nota tono="alerta" titulo="Está tardando más de lo normal.">
        <p>
          Dejé de consultar para no seguir pidiendo cada diez segundos. Recargá la pantalla para ver
          cómo quedó.
        </p>
        <p>
          Si el proceso se interrumpió, el trabajo <strong>se libera solo</strong> en unos minutos.
          No hay nada que arreglar a mano.
        </p>
      </Nota>
    );
  }

  // `total` es `null` hasta que el worker leyó cuánto hay que hacer: mientras tanto, decirlo, en vez
  // de dibujar una barra sobre un denominador que todavía no existe.
  const preparando = trabajo.total === null;

  return (
    <Nota tono="info" titulo={preparando ? "Preparando…" : "En curso…"}>
      {preparando ? (
        <p>Leyendo lo que hay que procesar.</p>
      ) : (
        <p className={estilos.progreso}>
          <progress value={trabajo.hechos} max={trabajo.total ?? undefined} />
          <span className={estilos.progresoCuenta}>
            {trabajo.hechos} de {trabajo.total}
          </span>
        </p>
      )}
      <p>Se actualiza sola. Podés irte de esta pantalla y volver.</p>
    </Nota>
  );
}
