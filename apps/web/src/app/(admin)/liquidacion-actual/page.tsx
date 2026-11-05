import type { Metadata } from "next";
import { bloqueosALaVista, mesEnMisBarrios, type MesDeUnBarrio } from "@admin-barrios/data/servicios/circuito-del-mes";
import { listarAdministracionesVisibles } from "@admin-barrios/data/servicios/parametros";
import { formatearFecha, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { Boton, Chip, CuerpoConBarraLateral, FiltroDeLista, FiltrosDeLista, type Tono } from "@admin-barrios/ui";
import { EncabezadoDePagina, MarcoTabla, Pagina, Tabla, Vacio, ui } from "../../../componentes/ui.tsx";
import { IconoBarrio } from "../../../componentes/iconos.tsx";
import { hrefDeLista, RUTA_LIQUIDACION_ACTUAL, rutaDeLiquidacion, rutasDelPeriodo } from "../../../rutas.ts";
import { conSesion } from "../../../servidor/db.ts";
import { BarraDeLaAdministracion } from "../barra-del-barrio.tsx";
import estilosAdmin from "../admin.module.css";

export const metadata: Metadata = { title: "Liquidación actual" };

type Filtro = "todos" | "preparando" | "listos" | "sin_enviar" | "enviados";
const FILTROS: readonly Filtro[] = ["todos", "preparando", "listos", "sin_enviar", "enviados"];

type Fila = MesDeUnBarrio & {
  readonly listo: boolean;
  readonly chip: { readonly tono: Tono; readonly texto: string };
  readonly motivo: string;
  readonly detalle: string | null;
  readonly seguir: string;
};

/**
 * **«<Mes> en mis barrios»** (T2, ADR-0011; maqueta, pantalla 2): en qué está la liquidación del mes
 * en cada barrio y qué falta, para seguir donde quedó. Cada fila dice el estado y su motivo, y
 * «Seguir» lleva a la parte del mes que está pendiente.
 *
 * **Sin vista previa.** «Listo para emitir» sale de lo que bloquea **a la vista** (`bloqueosALaVista`:
 * lecturas cortas, sin candados), no de calcular el mes de cada barrio: una vista previa por barrio a la
 * vez agotaba las conexiones y trababa la carga de gastos de todo el estudio (security-engineer, B1).
 * La vista previa de la ficha del mes es la palabra final.
 */
export default async function LiquidacionActual({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filtro = FILTROS.find((f) => f === sp["filtro"]) ?? "todos";
  const { meses, visibles, bloqueos } = await conSesion(async (tx) => {
    const meses = await mesEnMisBarrios(tx);
    const bloqueos = new Map<string, string[]>();
    // De a uno y en la misma transacción: son lecturas cortas.
    for (const m of meses) {
      if (m.estado === "preparando" && m.periodoId) bloqueos.set(m.barrioId, await bloqueosALaVista(tx, { periodoId: m.periodoId }));
    }
    return { meses, visibles: await listarAdministracionesVisibles(tx), bloqueos };
  });
  const filas = meses.map((m) => armarFila(m, bloqueos.get(m.barrioId) ?? []));
  const mesNombre = meses[0] ? nombreDelPeriodo(meses[0].periodo).split(" ")[0]! : "El mes";

  const cuenta = {
    todos: filas.length,
    preparando: filas.filter((f) => (f.estado === "preparando" || f.estado === "sin_abrir") && !f.listo).length,
    listos: filas.filter((f) => f.listo).length,
    sin_enviar: filas.filter((f) => f.estado === "emitido").length,
    enviados: filas.filter((f) => f.estado === "enviado").length,
  };
  const visiblesEnFiltro = filas.filter((f) =>
    filtro === "todos"
      ? true
      : filtro === "preparando"
        ? (f.estado === "preparando" || f.estado === "sin_abrir") && !f.listo
        : filtro === "listos"
          ? f.listo
          : filtro === "sin_enviar"
            ? f.estado === "emitido"
            : f.estado === "enviado",
  );
  const enlace = (f: Filtro) => hrefDeLista(RUTA_LIQUIDACION_ACTUAL, { filtro: f === "todos" ? null : f });

  return (
    <CuerpoConBarraLateral
      barraLateral={
        <BarraDeLaAdministracion
          nombre={null}
          activo="liquidacion"
          conConfiguracionGeneral={visibles.length > 0}
          mesEnCurso={mesNombre.toLowerCase()}
        />
      }
    >
      <main id="contenido" className={estilosAdmin.contenido}>
        <Pagina>
          <EncabezadoDePagina
            migas={[{ texto: "Barrios", href: "/" }, { texto: "Liquidación actual" }]}
            titulo={`${mesNombre} en mis barrios`}
            bajada={`En qué está la liquidación de ${mesNombre.toLowerCase()} en cada barrio y qué falta, para seguir donde quedó.`}
          />
          <FiltrosDeLista etiqueta="Qué barrios ver">
            <FiltroDeLista href={enlace("todos")} activo={filtro === "todos"} cantidad={cuenta.todos}>
              Todos
            </FiltroDeLista>
            <FiltroDeLista href={enlace("preparando")} activo={filtro === "preparando"} cantidad={cuenta.preparando}>
              Preparando
            </FiltroDeLista>
            <FiltroDeLista href={enlace("listos")} activo={filtro === "listos"} cantidad={cuenta.listos}>
              Listos para emitir
            </FiltroDeLista>
            <FiltroDeLista href={enlace("sin_enviar")} activo={filtro === "sin_enviar"} cantidad={cuenta.sin_enviar}>
              Sin enviar
            </FiltroDeLista>
            <FiltroDeLista href={enlace("enviados")} activo={filtro === "enviados"} cantidad={cuenta.enviados}>
              Enviados
            </FiltroDeLista>
          </FiltrosDeLista>

          {visiblesEnFiltro.length === 0 ? (
            <Vacio icono={<IconoBarrio />} titulo="Ningún barrio en este estado">
              Probá con «Todos».
            </Vacio>
          ) : (
            <MarcoTabla etiqueta={`${mesNombre} en mis barrios`}>
              <Tabla>
                <thead>
                  <tr>
                    <th scope="col" className={ui.columnaAncla}>
                      Barrio
                    </th>
                    <th scope="col">{meses[0] ? nombreDelPeriodo(meses[0].periodo) : "El mes"}</th>
                    <th scope="col" className={ui.numerica}>
                      Boletas
                    </th>
                    <th scope="col">Vence</th>
                    <th scope="col">
                      <span className="sr-only">Seguir</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visiblesEnFiltro.map((f) => (
                    <tr key={f.barrioId}>
                      <th scope="row" className={ui.columnaAncla}>
                        <span className={ui.principal}>{f.nombre}</span>{" "}
                        <span className={ui.secundaria}>{f.modelo === "fija" ? "Cuota fija" : "Por coeficiente"}</span>
                      </th>
                      <td>
                        <Chip tono={f.chip.tono}>{f.chip.texto}</Chip> <span className={ui.principal}>{f.motivo}</span>
                        {f.detalle ? <span className={ui.secundaria}> · {f.detalle}</span> : null}
                      </td>
                      <td className={ui.numerica}>{f.estado === "emitido" || f.estado === "enviado" ? f.boletas : f.unidades}</td>
                      <td>{f.primerVencimiento ? formatearFecha(f.primerVencimiento).slice(0, 5) : "—"}</td>
                      <td>
                        <Boton href={f.seguir} tamano="sm">
                          Seguir
                        </Boton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Tabla>
            </MarcoTabla>
          )}
        </Pagina>
      </main>
    </CuerpoConBarraLateral>
  );
}

/** El estado de un barrio en palabras, con su motivo y a dónde lleva «Seguir». */
function armarFila(m: MesDeUnBarrio, bloqueos: readonly string[]): Fila {
  const rutas = m.periodoId ? rutasDelPeriodo(m.barrioId, m.periodoId) : null;
  const anteriores =
    m.anterioresPendientes > 0
      ? `${m.anterioresPendientes === 1 ? "1 mes anterior" : `${m.anterioresPendientes} meses anteriores`} sin emitir o sin enviar`
      : null;
  if (m.estado === "enviado") {
    return {
      ...m,
      listo: false,
      chip: { tono: "exito", texto: "Enviado" },
      motivo: m.enviadoEl ? `Enviado el ${formatearFecha(m.enviadoEl).slice(0, 5)}` : "Enviado",
      detalle: anteriores,
      seguir: rutas!.resumen,
    };
  }
  if (m.estado === "emitido") {
    const faltan = Math.max(0, m.boletas - m.enviadas);
    return {
      ...m,
      listo: false,
      chip: { tono: "exito", texto: "Emitido" },
      motivo: faltan > 0 ? `${faltan} ${faltan === 1 ? "boleta sin enviar" : "boletas sin enviar"}` : "Falta enviar",
      detalle: anteriores,
      seguir: rutas!.envio,
    };
  }
  if (m.estado === "sin_abrir" || !m.periodoId) {
    return {
      ...m,
      listo: false,
      chip: { tono: "alerta", texto: "Preparando" },
      motivo: "Todavía sin abrir",
      detalle: anteriores,
      seguir: rutaDeLiquidacion(m.barrioId),
    };
  }
  // Preparando: listo si nada bloquea a la vista. La cifra exacta la da la vista previa, en Boletas.
  if (bloqueos.length === 0) {
    return {
      ...m,
      listo: true,
      chip: { tono: "info", texto: "Listo para emitir" },
      motivo: "Nada bloquea a la vista",
      detalle: [m.ordenesSinAprobar > 0 ? `${m.ordenesSinAprobar} ${m.ordenesSinAprobar === 1 ? "orden de pago sin aprobar" : "órdenes de pago sin aprobar"}` : null, anteriores]
        .filter((x): x is string => x !== null)
        .join(" · ") || null,
      seguir: rutas!.boletas,
    };
  }
  return {
    ...m,
    listo: false,
    chip: { tono: "alerta", texto: "Preparando" },
    motivo: `${bloqueos.length === 1 ? "1 cosa bloquea" : `${bloqueos.length} cosas bloquean`} la emisión`,
    detalle: [bloqueos[0] ?? null, anteriores].filter((x): x is string => x !== null).join(" · ") || null,
    seguir: rutas!.resumen,
  };
}
