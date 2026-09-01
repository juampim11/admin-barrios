import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerPeriodo } from "@admin-barrios/data/servicios/periodos";
import { enviosFallados, panoramaDeDistribucion, type EnvioFallado } from "@admin-barrios/data/servicios/distribucion";
import { leerUltimoTrabajoDelPeriodoPorTipo } from "@admin-barrios/data/servicios/trabajos";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import {
  Desplegable,
  EncabezadoDePagina,
  MarcoTabla,
  Nota,
  Pagina,
  Panel,
  Tabla,
} from "../../../../../../componentes/ui.tsx";
import { EstadoDelPeriodo, textoDeFalla } from "../../../../../../componentes/etiquetas.tsx";
import { esIdValido, rutasDelPeriodo, salidasDelPeriodo } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { FrentesDelPeriodo } from "../pasos.tsx";
import { RecorridoDeDistribucion } from "./recorrido.tsx";

export const metadata: Metadata = { title: "Distribución del período" };

/**
 * **Paso 5 del recorrido: la distribución.**
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTA PANTALLA ENSEÑA
 *
 * **Que son tres pasos y no un botón.** El informe mensual, el ZIP y los correos son tres trabajos
 * separados (`0053`), y la pantalla los muestra separados porque **fallan por separado**: si el ZIP
 * se rompe, reintentar el ZIP no vuelve a escribirle a nadie. Un único botón "Distribuir" escondería
 * justamente la distinción que hace que un reintento sea seguro.
 *
 * **Y que el tercer paso no se deshace.** Todo lo demás en este sistema es repetible sin costo: un
 * PDF se regenera, un ZIP se rearma, una URL firmada vence. Un correo que salió está en la bandeja
 * de un vecino para siempre. Por eso el tercer paso pide una confirmación escrita y muestra, antes
 * de mandar, **a cuántos les va a llegar y a cuántos no**.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTA PANTALLA NO DICE, Y ES DELIBERADO
 *
 * **No promete nada sobre la expiración del ZIP.** La carpeta `/paquetes/` del bucket existe
 * separada justamente para poder colgarle una regla de expiración (`SUFIJO_PATRON_CLAVE_PAQUETE`,
 * `packages/almacenamiento`), pero **esa regla todavía no está aprovisionada en ninguna infra**: no
 * hay `mc ilm` en el `docker-compose`, no hay infraestructura como código, y ni la web ni el worker
 * tienen `s3:DeleteObject` — la interfaz de almacenamiento ni siquiera expone un `remove()`.
 *
 * Decir "se elimina a los N días" sería una promesa que **nada en el sistema cumple**: el archivo
 * seguiría ahí para siempre, y alguien habría decidido, confiando en ese cartel, no borrar su copia.
 * Un cartel de retención que miente es peor que no tener ninguno. Cuando la regla exista de verdad,
 * este comentario y el texto de `recorrido.tsx` se cambian juntos.
 */
export default async function Distribucion({
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
      panorama: await panoramaDeDistribucion(tx, { periodoId }),
      fallados: await enviosFallados(tx, { periodoId }),
      // Los tres por separado: cada paso sigue su propio trabajo, y un seguimiento compartido haría
      // saltar la barra del informe al trabajo del ZIP en cuanto se encolara el segundo.
      trabajoInforme: await leerUltimoTrabajoDelPeriodoPorTipo(tx, periodoId, "emitir_informe_periodo"),
      trabajoPaquete: await leerUltimoTrabajoDelPeriodoPorTipo(tx, periodoId, "armar_paquete_periodo"),
      trabajoEnvio: await leerUltimoTrabajoDelPeriodoPorTipo(tx, periodoId, "distribuir_liquidaciones"),
    };
  });

  if (!datos) notFound();
  const { periodo, panorama, fallados, trabajoInforme, trabajoPaquete, trabajoEnvio } = datos;
  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const emitido = periodo.estado === "emitida" || periodo.estado === "distribuida";

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo={`Distribución de ${formatearPeriodo(periodo.periodo)}`}
        acciones={<EstadoDelPeriodo estado={periodo.estado} editable={periodo.editable} />}
        bajada={
          <>
            {periodo.barrioNombre} · el informe del mes, el paquete para archivar y el correo a cada
            unidad. Son tres pasos separados: cada uno se reintenta sin repetir los otros.
          </>
        }
      />

      <FrentesDelPeriodo barrioId={barrioId} periodoId={periodoId} />

      {!emitido ? (
        <Nota tono="alerta" titulo="Todavía no hay nada que distribuir.">
          <p>
            Lo que se distribuye sale de lo que quedó <strong>emitido</strong>. Mientras el período se
            pueda seguir editando, dos vecinos con la misma boleta podrían tener cifras distintas.
          </p>
          <p>
            <Link href={rutas.revision}>Ir a revisar y emitir el período</Link>
          </p>
        </Nota>
      ) : panorama.boletas === 0 ? (
        // El paso 0. No es uno de los tres: sin boletas no arranca ninguno, y el trigger de `0053`
        // rechaza tanto el ZIP como el envío. Se dice acá en vez de dejar que fallen los dos.
        <Nota tono="alerta" titulo="El período todavía no tiene boletas emitidas.">
          <p>
            Las boletas son el adjunto principal de cada correo y el contenido del paquete: sin ellas
            no hay ni ZIP ni envío.
          </p>
          <p>
            <Link href={rutas.documentos}>Ir a generar los documentos del período</Link>
          </p>
        </Nota>
      ) : (
        <Panel
          titulo="Los tres pasos de la distribución"
          origen="Se hacen en orden: el informe es el segundo adjunto del correo, y el paquete queda como copia de lo que se envió."
        >
          <RecorridoDeDistribucion
            periodoId={periodoId}
            panorama={panorama}
            trabajoInforme={trabajoInforme}
            trabajoPaquete={trabajoPaquete}
            trabajoEnvio={trabajoEnvio}
            rutaDocumentos={rutas.documentos}
            rutaPadron={rutas.padron}
            listaDeFallados={<ListaDeFallados fallados={fallados} />}
            salidas={salidasDelPeriodo(barrioId, periodoId)}
          />
        </Panel>
      )}
    </Pagina>
  );
}

/**
 * **Las unidades que no recibieron su liquidación, una por fila.**
 *
 * Existe porque `fallado` es terminal (`0055`): reencolar la distribución **no** resucita estas
 * filas, así que el número agregado del recuento no es un diagnóstico sino una tarea abierta, y sin
 * la lista es exactamente el callejón que el ADR prohíbe — no dice ni quién, ni por qué, ni qué hacer.
 *
 * **Tabla server, cero JavaScript** (ADR-0003 §8): no cumple ninguno de los cuatro criterios de
 * `TablaInteractiva` —con tres filas no hay nada que ordenar ni buscar—, y lo único interactivo es un
 * `<details>` nativo. Se renderiza acá y entra a la isla como prop: `recorrido.tsx` es `"use client"`
 * entero, y esto es lectura.
 *
 * **La dirección no es columna.** Va adentro del desplegable, mismo corte que ya tomó la pantalla de
 * padrón con los canales de contacto. Y es `email_snapshot` —la congelada, a la que se intentó— y
 * nunca la vigente del contacto: mostrar la vigente le haría creer al administrador que ya lo
 * arregló, cuando este envío no la usa y no vuelve a intentarse.
 */
function ListaDeFallados({ fallados }: { readonly fallados: readonly EnvioFallado[] }) {
  // Sin fallas no hay tarea: no se dibuja nada. Ni tabla vacía ni `Vacio` — no hay nada que decir.
  if (fallados.length === 0) return null;

  return (
    <Nota tono="alerta" titulo={`${fallados.length} unidad(es) no recibieron su liquidación.`}>
      <p>
        Un correo que falló <strong>no se reintenta solo</strong>, y volver a mandar la distribución
        tampoco lo recupera: el registro de ese destinatario ya está escrito y no vuelve a la cola. Es
        la misma regla que impide que a un vecino le lleguen dos boletas.
      </p>
      <p>
        Lo que se puede hacer hoy es <strong>bajar la boleta de cada una y hacerla llegar por otro
        medio</strong>. Corregir la casilla en el padrón arregla el mes que viene, no éste.
      </p>
      <MarcoTabla etiqueta="Unidades que no recibieron su liquidación">
        <Tabla>
          <thead>
            <tr>
              <th scope="col">Unidad</th>
              <th scope="col">Qué pasó</th>
              <th scope="col">Su boleta</th>
            </tr>
          </thead>
          <tbody>
            {fallados.map((f) => (
              <tr key={f.id}>
                <td>{f.unidadEtiqueta}</td>
                <td>
                  {/* El texto manda; el código crudo queda adentro del desplegable, para leerlo por teléfono. */}
                  {textoDeFalla(f.errorCodigo)}
                  <Desplegable resumen="Ver el detalle">
                    <p>
                      Se le iba a escribir a <strong>{f.emailIntentado}</strong>, que es la dirección
                      que estaba cargada cuando se armó el envío. Si la cambiaste después, este envío
                      igual no la usa.
                    </p>
                    <p>Código que devolvió el servidor: {f.errorCodigo ?? "no quedó registrado"}.</p>
                  </Desplegable>
                </td>
                <td>
                  {/* Un enlace común: la ruta responde un 302 a una URL firmada de vida corta. */}
                  <a href={`/api/documentos/${f.documentoId}`} download>
                    Descargar su boleta
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      </MarcoTabla>
    </Nota>
  );
}
