import type { Metadata } from "next";
import { boletasDelMes, loQueFaltaDelMes, mesEnMisBarrios, type MesDeUnBarrio } from "@admin-barrios/data/servicios/circuito-del-mes";
import { listarAdministracionesVisibles } from "@admin-barrios/data/servicios/parametros";
import { formatearMonto } from "@admin-barrios/shared/dinero";
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
 * Para saber si un barrio está **listo para emitir** hace falta su vista previa (la emisión entera en
 * un punto de guardado: lo que bloquea es lo que la base rechazaría). Se calcula en paralelo, una por
 * barrio que está preparando; mientras tanto se ve `loading.tsx`.
 */
export default async function LiquidacionActual({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filtro = FILTROS.find((f) => f === sp["filtro"]) ?? "todos";
  const { meses, visibles } = await conSesion(async (tx) => ({
    meses: await mesEnMisBarrios(tx),
    visibles: await listarAdministracionesVisibles(tx),
  }));
  const filas = await Promise.all(meses.map(armarFila));
  const mesNombre = meses[0] ? nombreDelPeriodo(meses[0].periodo).split(" ")[0]! : "El mes";

  const cuenta = {
    todos: filas.length,
    preparando: filas.filter((f) => f.estado === "preparando" && !f.listo).length,
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
async function armarFila(m: MesDeUnBarrio): Promise<Fila> {
  const rutas = m.periodoId ? rutasDelPeriodo(m.barrioId, m.periodoId) : null;
  if (m.estado === "enviado") {
    return {
      ...m,
      listo: false,
      chip: { tono: "exito", texto: "Enviado" },
      motivo: m.enviadoEl ? `Enviado el ${formatearFecha(m.enviadoEl).slice(0, 5)}` : "Enviado",
      detalle: null,
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
      detalle: null,
      seguir: rutas!.envio,
    };
  }
  if (m.estado === "sin_abrir" || !m.periodoId) {
    return {
      ...m,
      listo: false,
      chip: { tono: "alerta", texto: "Preparando" },
      motivo: "El mes se abre al entrar",
      detalle: null,
      seguir: rutaDeLiquidacion(m.barrioId),
    };
  }
  // Preparando: la vista previa dice si está listo, y lo que falta el motivo.
  const periodoId = m.periodoId;
  const { vista, faltas } = await conSesion(async (tx) => {
    const vista = await boletasDelMes(tx, { periodoId });
    return { vista, faltas: await loQueFaltaDelMes(tx, { periodoId, vista }) };
  });
  const bloquean = faltas.filter((f) => f.tipo === "bloquea");
  if (vista.estado === "vista_previa" && bloquean.length === 0) {
    return {
      ...m,
      listo: true,
      chip: { tono: "info", texto: "Listo para emitir" },
      motivo: "Nada bloquea",
      detalle: `$ ${formatearMonto(vista.totales.total)} a la fecha`,
      seguir: rutas!.boletas,
    };
  }
  return {
    ...m,
    listo: false,
    chip: { tono: "alerta", texto: "Preparando" },
    motivo: bloquean.length > 0 ? `${bloquean.length === 1 ? "1 cosa bloquea" : `${bloquean.length} cosas bloquean`} la emisión` : "Preparando",
    detalle: faltas[0]?.titulo ?? null,
    seguir: rutas!.resumen,
  };
}
