import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerPeriodo } from "@admin-barrios/data/servicios/periodos";
import { panoramaDeDistribucion } from "@admin-barrios/data/servicios/distribucion";
import { leerUltimoTrabajoDelPeriodoPorTipo } from "@admin-barrios/data/servicios/trabajos";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { EncabezadoDePagina, Nota, Pagina, Panel } from "../../../../../../componentes/ui.tsx";
import { EstadoDelPeriodo } from "../../../../../../componentes/etiquetas.tsx";
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
      // Los tres por separado: cada paso sigue su propio trabajo, y un seguimiento compartido haría
      // saltar la barra del informe al trabajo del ZIP en cuanto se encolara el segundo.
      trabajoInforme: await leerUltimoTrabajoDelPeriodoPorTipo(tx, periodoId, "emitir_informe_periodo"),
      trabajoPaquete: await leerUltimoTrabajoDelPeriodoPorTipo(tx, periodoId, "armar_paquete_periodo"),
      trabajoEnvio: await leerUltimoTrabajoDelPeriodoPorTipo(tx, periodoId, "distribuir_liquidaciones"),
    };
  });

  if (!datos) notFound();
  const { periodo, panorama, trabajoInforme, trabajoPaquete, trabajoEnvio } = datos;
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
            salidas={salidasDelPeriodo(barrioId, periodoId)}
          />
        </Panel>
      )}
    </Pagina>
  );
}
