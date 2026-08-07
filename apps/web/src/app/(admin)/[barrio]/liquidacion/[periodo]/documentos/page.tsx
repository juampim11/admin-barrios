import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerPeriodo } from "@admin-barrios/data/servicios/periodos";
import { listarDocumentosDePeriodo } from "@admin-barrios/data/servicios/documentos";
import { leerUltimoTrabajoDelPeriodo } from "@admin-barrios/data/servicios/trabajos";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import {
  EncabezadoDePagina,
  MarcoTabla,
  Nota,
  Pagina,
  Panel,
  Tabla,
  Vacio,
} from "../../../../../../componentes/ui.tsx";
import { EstadoDelPeriodo } from "../../../../../../componentes/etiquetas.tsx";
import { esIdValido, rutasDelPeriodo, salidasDelPeriodo } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { FrentesDelPeriodo } from "../pasos.tsx";
import { GeneracionDeDocumentos } from "./generacion.tsx";
import estilos from "./documentos.module.css";

export const metadata: Metadata = { title: "Documentos del período" };

/** Cuántos kilobytes, para que el peso se lea sin hacer cuentas. */
function enKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * **Paso 4 del recorrido: los documentos.**
 *
 * Lo que esta pantalla enseña, y por eso el texto es explícito: **emitir el período y generar sus
 * documentos son dos cosas distintas**. Emitir congela las cifras; generar produce los papeles. Un
 * período puede quedar emitido sin documentos —si el proceso que los genera está caído— y eso es un
 * estado recuperable y visible, no un período a medias.
 *
 * Y la otra: **los documentos se guardan, no se regeneran**. Descargar una boleta emitida sirve el
 * archivo que se guardó, no uno nuevo hecho ahora. Regenerar produciría un documento **distinto del
 * que se envió** —la plantilla, las fuentes, la marca del barrio y hasta la versión del motor
 * cambian con el tiempo— y lo que un vecino reclama es el papel que recibió (ADR-0001 §6).
 */
export default async function Documentos({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();

  const datos = await conSesion(async (tx) => {
    const periodo = await leerPeriodo(tx, { periodoId });
    if (!periodo) return null;
    return {
      periodo,
      documentos: await listarDocumentosDePeriodo(tx, { periodoId }),
      trabajo: await leerUltimoTrabajoDelPeriodo(tx, periodoId),
    };
  });

  if (!datos) notFound();
  const { periodo, documentos, trabajo } = datos;
  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const emitido = periodo.estado === "emitida" || periodo.estado === "distribuida";

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo={`Documentos de ${formatearPeriodo(periodo.periodo)}`}
        acciones={<EstadoDelPeriodo estado={periodo.estado} editable={periodo.editable} />}
        bajada={
          <>
            {periodo.barrioNombre} · las boletas de este período, para descargar. Se guardan tal como
            se emitieron: descargarlas no las vuelve a generar.
          </>
        }
      />

      <FrentesDelPeriodo barrioId={barrioId} periodoId={periodoId} />

      {!emitido ? (
        <Nota tono="alerta" titulo="Todavía no hay documentos que generar.">
          <p>
            Los documentos salen de lo que quedó <strong>emitido</strong>, no del borrador: si el
            período se pudiera seguir editando, dos vecinos con la misma boleta impresa podrían tener
            cifras distintas.
          </p>
          <p>
            <Link href={rutas.revision}>Ir a revisar y emitir el período</Link>
          </p>
        </Nota>
      ) : !periodo.puedeEmitir ? (
        // **No se le ofrece la acción a quien la base va a rechazar.** No es un control de seguridad
        // —ese está en la policy de `insert` de `trabajo`, y funciona— sino de honestidad: ofrecerle
        // un botón primario a un rol de solo lectura y después contestarle con un código de soporte
        // es tratar como un incidente algo que el sistema ya sabía de antemano.
        <Nota tono="info" titulo="Los documentos los genera quien administra el barrio.">
          <p>
            Con tu rol podés <strong>ver y descargar</strong> lo que ya está emitido, pero no disparar
            la generación.
          </p>
        </Nota>
      ) : (
        <Panel
          titulo="Generar los documentos"
          origen="Una boleta por unidad, con el mismo contenido que quedó emitido al cerrar el período."
        >
          <GeneracionDeDocumentos
            periodoId={periodoId}
            trabajoInicial={trabajo}
            documentosYaEmitidos={documentos.length}
            salidas={salidasDelPeriodo(barrioId, periodoId)}
          />
        </Panel>
      )}

      <Panel
        titulo="Documentos emitidos"
        origen={
          documentos.length > 0
            ? `${documentos.length} archivo(s) guardados al emitirse. Cada descarga queda registrada con quién la pidió y cuándo.`
            : undefined
        }
      >
        {documentos.length === 0 ? (
          <Vacio titulo="Todavía no hay ningún documento emitido.">
            Cuando se generen van a aparecer acá, una fila por unidad.
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Documentos emitidos del período">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col">Unidad</th>
                  <th scope="col">Emitido</th>
                  <th scope="col">Peso</th>
                  <th scope="col">Descargar</th>
                </tr>
              </thead>
              <tbody>
                {documentos.map((d) => (
                  <tr key={d.id}>
                    <td>{d.unidad ?? "Todo el período"}</td>
                    <td>{d.emitidoAt.slice(0, 16).replace("T", " ")}</td>
                    <td className={estilos.peso}>{enKb(d.bytes)}</td>
                    <td>
                      {/*
                        Un enlace común, sin JavaScript: la ruta responde un 302 a una URL firmada de
                        vida corta. El `documentoId` es lo único que viaja — nunca la clave del
                        archivo, que convertiría la credencial de esta aplicación en una llave
                        maestra sobre todo el almacenamiento.
                      */}
                      <a className={estilos.descarga} href={`/api/documentos/${d.id}`} download>
                        Descargar PDF
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>
    </Pagina>
  );
}
