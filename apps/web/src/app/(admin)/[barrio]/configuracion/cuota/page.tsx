import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { cuotaFijaVigente, historialDeCuota } from "@admin-barrios/data/servicios/cuota-fija";
import { listarPeriodos } from "@admin-barrios/data/servicios/periodos";
import { puedeGestionarElMes } from "@admin-barrios/data/servicios/circuito-del-mes";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { Chip, CifraDelMes, CifrasDelMes } from "@admin-barrios/ui";
import {
  Cifra,
  Desplegable,
  EncabezadoDePagina,
  MarcoTabla,
  Nota,
  Pagina,
  Panel,
  PilaDeNotas,
  Tabla,
  ui,
} from "../../../../../componentes/ui.tsx";
import { comoSeLlama } from "../../../../../componentes/etiquetas.tsx";
import { esIdValido, migaDelBarrio, rutaDeLiquidacion, rutaDelPadron, rutasDelPeriodo } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { FormularioDeCuota } from "./formulario.tsx";
import estilos from "./cuota.module.css";

export const metadata: Metadata = { title: "Cuota del barrio" };

/**
 * **La cuota del barrio, en Configuración** (T2, D4; maqueta, pantalla 7). Mismo patrón que los
 * parámetros de mora de T1: el valor vigente, desde cuándo rige, a quién alcanza, lo programado, el
 * historial y «Aplicar un aumento» (por porcentaje con redondeo, o un importe, con «rige desde» y el
 * acta). Cada cambio rige desde un mes y nunca toca boletas emitidas.
 *
 * Desde el mes, «Aplicar aumento desde este mes» llega acá con `?aumento=AAAA-MM`: el formulario viene
 * abierto y con ese mes elegido.
 *
 * Reemplaza «Valor de la expensa» de Liquidación (`/liquidacion/cuota` redirige acá).
 */
export default async function CuotaDelBarrio({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();
  const sp = await searchParams;
  const aumento = typeof sp["aumento"] === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp["aumento"]) ? sp["aumento"] : null;
  // El mes del que se vino («Aplicar aumento desde este mes»): «Cancelar» vuelve a ese, no al en curso.
  const desde = typeof sp["desde"] === "string" && esIdValido(sp["desde"]) ? sp["desde"] : null;

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    // La cifra y la tabla muestran la que rige hoy; el aumento se calcula sobre la última cargada, que
    // con un cambio programado es la programada (encargo 14, BL-035 c; ver `cuotaFijaVigente`).
    vigente: await cuotaFijaVigente(tx, barrioId, { aHoy: true }),
    ultima: await cuotaFijaVigente(tx, barrioId),
    historial: await historialDeCuota(tx, barrioId),
    periodos: await listarPeriodos(tx, { barrioId }),
    puede: await puedeGestionarElMes(tx, { barrioId }),
  }));
  if (!datos.barrio) notFound();
  const { barrio, vigente, ultima, historial, periodos, puede } = datos;
  const denominacion = comoSeLlama(barrio.denominacionConcepto);
  const usaCuotaFija = barrio.modelo === "fija" || ultima.versionId !== null || periodos.some((p) => p.modelo === "fija");
  const programado = historial.find((h) => h.programado) ?? null;
  // Programada (rige más adelante), Vigente (la que se cobra hoy) o Anterior (ensayo de T2). El
  // historial viene de la más nueva a la más vieja: la vigente es la primera que no está programada.
  // No se compara con `vigente.versionId`, que con un cambio programado ya apunta al programado (el
  // trigger de `0007` cierra la anterior al cargarlo; code-reviewer).
  const idVigente = historial.find((h) => !h.programado)?.versionId ?? null;
  const estadoDe = (h: (typeof historial)[number]): keyof typeof ESTADO_DE_CUOTA =>
    h.programado ? "programada" : h.versionId === idVigente ? "vigente" : "anterior";
  const migas = [
    migaDelBarrio(barrio),
    { texto: "Configuración del barrio", href: `/${barrio.id}/configuracion` },
    { texto: "Cuota" },
  ] as const;

  if (!usaCuotaFija) {
    return (
      <Pagina>
        <EncabezadoDePagina migas={migas} titulo="Cuota del barrio" />
        <Nota tono="info" titulo="Este barrio reparte los gastos del mes por coeficiente, no cobra una cuota fija.">
          En <strong>{barrio.nombre}</strong>, lo que paga cada unidad sale de los gastos del mes por su coeficiente: no hay
          una cuota que definir. <Link href={rutaDeLiquidacion(barrio.id)}>Ir al mes en curso</Link>.
        </Nota>
      </Pagina>
    );
  }

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={migas}
        titulo="Cuota del barrio"
        bajada="El valor que paga cada unidad en un barrio de cuota fija. Cada cambio rige desde un mes, con su acta, y nunca toca boletas emitidas."
      />

      <PilaDeNotas>
        {ultima.unidadesSinImporte > 0 ? (
          <Nota
            tono="alerta"
            titulo={
              ultima.unidadesSinImporte === 1
                ? "Hay 1 unidad activa sin cuota asignada."
                : `Hay ${ultima.unidadesSinImporte} unidades activas sin cuota asignada.`
            }
          >
            Son altas posteriores a la última versión. Mientras estén así <strong>no se les factura nada</strong>, y el aumento
            por porcentaje no se puede aplicar: cargá un importe para dejarlas a todas con un valor.
          </Nota>
        ) : null}
      </PilaDeNotas>

      <CifrasDelMes>
        <CifraDelMes
          valor={vigente.importeUnico ? `$ ${formatearMonto(vigente.importeUnico)}` : vigente.versionId ? "varía por unidad" : "—"}
          etiqueta={vigente.vigenteDesde ? `vigente desde ${formatearPeriodo(vigente.vigenteDesde.slice(0, 7))}` : "todavía sin cuota"}
        />
        <CifraDelMes valor={String(vigente.unidadesActivas - vigente.unidadesSinImporte)} etiqueta="unidades alcanzadas" />
        <CifraDelMes
          valor={programado ? formatearPeriodo(programado.rigeDesde) : "—"}
          etiqueta={programado ? "cambio programado" : "ningún cambio programado"}
        />
      </CifrasDelMes>

      {ultima.unidadesActivas > 0 && puede ? (
        <Panel
          titulo="Aplicar un aumento"
          origen={
            programado
              ? `Sobre la última cuota cargada, la que rige desde ${formatearPeriodo(programado.rigeDesde)}, por porcentaje con redondeo, o un importe. Rige desde el mes que se elija; nada de lo ya emitido cambia.`
              : "Sobre la cuota vigente, por porcentaje con redondeo, o un importe. Rige desde el mes que se elija; nada de lo ya emitido cambia."
          }
        >
          <div id="aumento">
            <FormularioDeCuota
              barrioId={barrio.id}
              vigente={ultima}
              proximoMes={aumento ?? ultima.proximoMes}
              denominacion={denominacion}
              volverA={desde ? rutasDelPeriodo(barrio.id, desde).resumen : aumento ? rutaDeLiquidacion(barrio.id) : `/${barrio.id}/configuracion`}
              salidas={{
                sin_unidades: { texto: "Ir al padrón del barrio", href: rutaDelPadron(barrio.id) },
                unidades_sin_cuota: { texto: "Ver el padrón del barrio", href: rutaDelPadron(barrio.id) },
              }}
            />
          </div>
        </Panel>
      ) : null}

      <Panel titulo="Historial" origen="Cada cambio con el mes desde el que rige, el acta y quién lo cargó." sinRelleno>
        {historial.length === 0 ? (
          <p className={ui.secundaria}>Todavía no se cargó ninguna cuota.</p>
        ) : (
          <MarcoTabla etiqueta="Historial de la cuota">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Rige desde
                  </th>
                  <th scope="col" className={ui.numerica}>
                    Cuota
                  </th>
                  <th scope="col" className={ui.numerica}>
                    Cambio
                  </th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acta</th>
                  <th scope="col">Cargó</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((h) => (
                  <tr key={h.versionId}>
                    <th scope="row" className={ui.columnaAncla}>
                      {formatearPeriodo(h.rigeDesde)}
                    </th>
                    <td className={ui.numerica}>
                      {h.importeUnico ? <Cifra monto={h.importeUnico} nulo="—" /> : <span className={ui.secundaria}>varía</span>}
                    </td>
                    <td className={ui.numerica}>{h.ajustePorcentaje ? `${conSigno(formatearPorcentaje(h.ajustePorcentaje))} %` : "—"}</td>
                    <td>
                      <Chip tono={ESTADO_DE_CUOTA[estadoDe(h)].tono}>{ESTADO_DE_CUOTA[estadoDe(h)].texto}</Chip>
                    </td>
                    <td>{h.acta ?? "—"}</td>
                    <td>
                      {/* Las versiones sembradas o importadas no tienen quién las aprobó: son la carga inicial. */}
                      {h.cargoNombre ?? "Carga inicial"} · {formatearFecha(h.cargadoEl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>

      {vigente.versionId !== null && vigente.cuotas.length > 0 ? (
        <Panel titulo="Lo que paga cada unidad" origen="La versión vigente, unidad por unidad.">
          <Desplegable resumen={`Ver las ${vigente.cuotas.length} unidades`}>
            <MarcoTabla etiqueta="Cuota vigente por unidad">
              <Tabla>
                <thead>
                  <tr>
                    <th scope="col">Unidad</th>
                    <th scope="col" className={estilos.montoCelda}>
                      Importe mensual
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {vigente.cuotas.map((c) => (
                    <tr key={c.unidadFuncionalId}>
                      <td>{c.etiqueta}</td>
                      <td className={estilos.montoCelda}>
                        {c.importe === null ? <span className={estilos.sinCuota}>sin valor asignado</span> : <Cifra monto={c.importe} nulo="—" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Tabla>
            </MarcoTabla>
          </Desplegable>
        </Panel>
      ) : null}
    </Pagina>
  );
}

const ESTADO_DE_CUOTA = {
  programada: { tono: "info", texto: "Programada" },
  vigente: { tono: "exito", texto: "Vigente" },
  anterior: { tono: "neutro", texto: "Anterior" },
} as const;

/** «12,0» → «+ 12,0»; «-5,0» → «− 5,0»: un aumento o una baja, con su signo (code-reviewer). */
const conSigno = (p: string): string => (p.startsWith("-") ? `− ${p.slice(1)}` : `+ ${p}`);

/** «12.0000» → «12,0»; «7.5000» → «7,5». Sin `Intl`: es un texto que ya viene de la base. */
function formatearPorcentaje(p: string): string {
  const [entero, decimales = ""] = p.split(".");
  const d = decimales.replace(/0+$/, "");
  return `${entero},${d === "" ? "0" : d}`;
}
