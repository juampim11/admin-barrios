import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { panoramaDeDistribucion } from "@admin-barrios/data/servicios/distribucion";
import { leerUltimoTrabajoDelPeriodoPorTipo, type Trabajo } from "@admin-barrios/data/servicios/trabajos";
import { estadoDelMes } from "@admin-barrios/data/servicios/circuito-del-mes";
import { formatearFecha, formatearFechaHora } from "@admin-barrios/shared/fechas";
import { Boton, CadenaDeEnvio, PasoDeEnvio } from "@admin-barrios/ui";
import { Nota, Pagina } from "../../../../../../componentes/ui.tsx";
import { esIdValido, rutasDeCobros, rutasDelPeriodo } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { EncabezadoDelMes, mesOno404 } from "../mes.tsx";
import { EncolarAMano, EnviarBoletas, RefrescarMientrasCorre } from "./acciones.tsx";

export const metadata: Metadata = { title: "Envío del mes" };

/**
 * **Envío** (T2, D5; maqueta, pantalla 5). Lo que antes eran cuatro botones con esperas pasa solo al
 * emitir: las boletas en PDF y el informe se encolan con la emisión, y el paquete cuando terminan las
 * boletas. Enviar por correo es **la única acción**, con su diálogo. Si algo de la cadena no arrancó
 * (lo emitió alguien que no puede armar el paquete, o un trabajo falló), queda el botón para hacerlo.
 *
 * Mientras un trabajo corre, la página se refresca sola cada pocos segundos (`RefrescarMientrasCorre`).
 */
export default async function EnvioDelMes({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();
  const { periodo, conteos } = await mesOno404(barrioId, periodoId);
  const estado = estadoDelMes(periodo.estado);
  const rutas = rutasDelPeriodo(barrioId, periodoId);

  if (estado === "preparando") {
    return (
      <Pagina>
        <EncabezadoDelMes barrioId={barrioId} periodoId={periodoId} pestana="envio" />
        <Nota tono="info" titulo="Todavía no hay nada que enviar.">
          Al emitir se arman solos los PDF de las boletas, el informe del mes y el paquete. Después, el envío por correo
          es lo único que se hace a mano.
        </Nota>
      </Pagina>
    );
  }

  const datos = await conSesion(async (tx) => ({
    panorama: await panoramaDeDistribucion(tx, { periodoId }),
    boletas: await leerUltimoTrabajoDelPeriodoPorTipo(tx, periodoId, "emitir_documentos_periodo"),
    informe: await leerUltimoTrabajoDelPeriodoPorTipo(tx, periodoId, "emitir_informe_periodo"),
    paquete: await leerUltimoTrabajoDelPeriodoPorTipo(tx, periodoId, "armar_paquete_periodo"),
    envio: await leerUltimoTrabajoDelPeriodoPorTipo(tx, periodoId, "distribuir_liquidaciones"),
  }));
  const { panorama } = datos;
  const corre = (t: Trabajo | null) => t !== null && (t.estado === "encolado" || t.estado === "corriendo");
  const boletasListas = panorama.boletas >= conteos.boletasEmitidas && conteos.boletasEmitidas > 0;
  const fallado = (t: Trabajo | null) => t?.estado === "fallado";
  // Sigue refrescando también en el hueco entre que terminan las boletas y el worker encola el paquete
  // (code-reviewer, T2): si no, la página quedaba quieta en «Se arma solo cuando terminen los PDF».
  const esperaElPaquete = estado === "emitido" && boletasListas && panorama.paquete === null && !fallado(datos.paquete);
  const algoCorre = [datos.boletas, datos.informe, datos.paquete, datos.envio].some(corre) || esperaElPaquete;
  const paqueteViejo = panorama.paquete !== null && panorama.paquete.boletasFaltantes > 0;
  const puede = periodo.puedeEmitir;
  const progreso = (t: Trabajo | null) =>
    t && t.total && t.estado === "corriendo" && !t.sinLatido ? Math.round((t.hechos / t.total) * 100) : null;
  /*
   * **Lo que dice cada paso es lo que hizo el worker** (ensayo de T2): en cola, corriendo con su avance,
   * interrumpido (sin latido: se reencola solo) o fallado con su motivo. Antes «Preparando… 0 de 340»
   * se quedaba quieto aunque nadie estuviera generando nada.
   */
  const comoVa = (t: Trabajo | null, corriendo: (t: Trabajo) => string): string | null => {
    if (!t) return null;
    if (t.estado === "fallado") return t.error ?? "Falló.";
    if (t.estado === "encolado")
      return t.demorado
        ? "En cola hace más de un minuto: el generador de documentos todavía no lo tomó. ¿Está andando el worker?"
        : "En cola: arranca en unos segundos.";
    if (t.estado === "corriendo") return t.sinLatido ? "Se interrumpió: se retoma solo en un minuto." : corriendo(t);
    return null;
  };
  // Mientras un paso corre, los botones de los otros esperan y dicen por qué.
  const QUE_CORRE = [
    [datos.boletas, "las boletas en PDF"],
    [datos.informe, "el informe"],
    [datos.paquete, "el paquete"],
    [datos.envio, "el envío"],
  ] as const;
  const esperaA = (propio: Trabajo | null): string | null => {
    const otro = QUE_CORRE.find(([t]) => t !== propio && corre(t));
    return otro ? `Esperá a que termine ${otro[1]}.` : null;
  };
  const conMail = panorama.destinatarios;
  const enviadas = panorama.envios.aceptados;

  return (
    <Pagina>
      <EncabezadoDelMes barrioId={barrioId} periodoId={periodoId} pestana="envio" />
      <RefrescarMientrasCorre activo={algoCorre} />
      <p>
        Emitido el {periodo.emitidaAtBarrio ? formatearFechaHora(periodo.emitidaAtBarrio) : ""}
        {periodo.emitidaPorNombre ? ` por ${periodo.emitidaPorNombre}` : ""} · {conteos.boletasEmitidas} boletas
      </p>

      <CadenaDeEnvio>
        <PasoDeEnvio
          numero={1}
          titulo="Boletas en PDF"
          hecho={boletasListas}
          detalle={
            boletasListas
              ? `Listas: ${panorama.boletas} de ${conteos.boletasEmitidas}.`
              : (comoVa(datos.boletas, (t) => `Preparando… ${t.hechos} de ${t.total ?? conteos.boletasEmitidas}`) ?? "Todavía no arrancó.")
          }
          progreso={boletasListas ? null : progreso(datos.boletas)}
          accion={
            puede && !boletasListas && !corre(datos.boletas) ? (
              <EncolarAMano periodoId={periodoId} que="boletas" texto="Preparar los PDF" esperaA={esperaA(datos.boletas)} />
            ) : undefined
          }
        />
        <PasoDeEnvio
          numero={2}
          titulo="Informe del mes"
          hecho={panorama.informeEmitido}
          detalle={
            panorama.informeEmitido
              ? "Listo: es el segundo adjunto de cada correo."
              : (comoVa(datos.informe, () => "Armándose…") ?? "Se arma solo al emitir.")
          }
          accion={
            puede && !panorama.informeEmitido && !corre(datos.informe) ? (
              <EncolarAMano periodoId={periodoId} que="informe" texto="Armar el informe" esperaA={esperaA(datos.informe)} />
            ) : undefined
          }
        />
        <PasoDeEnvio
          numero={3}
          titulo="Paquete para el contador"
          hecho={panorama.paquete !== null && !paqueteViejo}
          detalle={
            paqueteViejo
              ? `Quedó desactualizado: le faltan ${panorama.paquete!.boletasFaltantes} boletas emitidas después de armarlo. Hay que rearmarlo.`
              : panorama.paquete
              ? "Planilla y PDF, listos para archivar."
              : (comoVa(datos.paquete, (t) => (t.total ? `Armándose… ${t.hechos} de ${t.total}` : "Armándose…")) ??
                (boletasListas ? "Se arma solo cuando terminan los PDF." : "Se arma cuando terminen los PDF."))
          }
          accion={
            panorama.paquete && !paqueteViejo ? (
              <a href={`/api/paquetes/${periodoId}`} download>
                Descargar
              </a>
            ) : boletasListas && !corre(datos.paquete) && panorama.puedeDistribuir ? (
              <EncolarAMano
                periodoId={periodoId}
                que="paquete"
                texto={paqueteViejo ? "Rearmar el paquete" : "Armar el paquete"}
                esperaA={esperaA(datos.paquete)}
              />
            ) : undefined
          }
        />
        <PasoDeEnvio
          numero={4}
          titulo="Enviar por correo"
          hecho={estado === "enviado"}
          detalle={
            <>
              Lo único que se hace a mano, con confirmación.
              {enviadas > 0 ? ` ${enviadas} enviadas.` : ""}
              {panorama.envios.fallados > 0 ? ` ${panorama.envios.fallados} no llegaron.` : ""}
              {panorama.unidadesSinContacto > 0 ? (
                <>
                  {" "}
                  {panorama.unidadesSinContacto} {panorama.unidadesSinContacto === 1 ? "unidad no tiene" : "unidades no tienen"} mail:{" "}
                  <a href={rutas.padron}>ver el padrón</a>.
                </>
              ) : null}
            </>
          }
          progreso={progreso(datos.envio)}
          accion={
            estado === "emitido" && panorama.puedeDistribuir && !corre(datos.envio) ? (
              <EnviarBoletas
                periodoId={periodoId}
                cantidad={conMail}
                sinMail={panorama.unidadesSinContacto}
                mes={periodo.periodo}
                listo={boletasListas && panorama.informeEmitido && panorama.paquete !== null && !paqueteViejo}
                esperaA={esperaA(datos.envio)}
              />
            ) : undefined
          }
        />
        <PasoDeEnvio
          numero="$"
          titulo="Cobrar y conciliar"
          hecho={false}
          detalle={`${conteos.pagadas} de ${conteos.boletasEmitidas} pagadas${
            periodo.primerVencimiento ? ` · vence el ${formatearFecha(periodo.primerVencimiento)}` : ""
          }.`}
          accion={<Boton href={rutasDeCobros(barrioId).grilla}>Ir a Cobros</Boton>}
        />
      </CadenaDeEnvio>
    </Pagina>
  );
}
