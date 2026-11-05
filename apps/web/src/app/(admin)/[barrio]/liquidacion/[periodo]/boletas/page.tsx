import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { formatearFecha, formatearFechaHora, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { BoletaDeEjemplo, Chip, FiltroDeLista, FiltrosDeLista } from "@admin-barrios/ui";
import { MarcoTabla, Nota, Pagina, Panel, Tabla, ui } from "../../../../../../componentes/ui.tsx";
import { esIdValido, rutasDelPeriodo } from "../../../../../../rutas.ts";
import { EncabezadoDelMes, mesOno404, vistaDelMes } from "../mes.tsx";
import estilos from "./boletas.module.css";

export const metadata: Metadata = { title: "Boletas del mes" };

type Filtro = "todas" | "interes" | "cargos";
const FILTROS: readonly Filtro[] = ["todas", "interes", "cargos"];

/**
 * **Boletas** (T2, D1; maqueta, pantalla 4). Reemplaza «Generar el borrador» y «Revisar y emitir».
 * Antes de emitir es una **vista previa al día**: se calcula al pedirla con lo cargado hasta ahora, con
 * el interés a hoy, y no se guarda. Después de emitir son las boletas emitidas, con su sello, sin
 * cambiar de pantalla.
 *
 * Tabla server, cero JavaScript (ADR-0003 §8): los filtros son enlaces.
 */
export default async function BoletasDelMes({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();
  await mesOno404(barrioId, periodoId);
  const sp = await searchParams;
  const filtro = FILTROS.find((f) => f === sp["filtro"]) ?? "todas";
  const unidad = typeof sp["unidad"] === "string" && esIdValido(sp["unidad"]) ? sp["unidad"] : null;

  return (
    <Pagina>
      <EncabezadoDelMes barrioId={barrioId} periodoId={periodoId} pestana="boletas" />
      <Suspense
        fallback={
          <Nota tono="info" titulo="Calculando la vista previa…">
            Con lo cargado hasta ahora y el interés a hoy. En un barrio grande tarda unos segundos.
          </Nota>
        }
      >
        <Boletas barrioId={barrioId} periodoId={periodoId} filtro={filtro} unidad={unidad} />
      </Suspense>
    </Pagina>
  );
}

const pesos = (m: string) => `$ ${formatearMonto(m)}`;
const oGuion = (m: string) => (m === "0.00" ? "—" : pesos(m));

async function Boletas({
  barrioId,
  periodoId,
  filtro,
  unidad,
}: {
  readonly barrioId: string;
  readonly periodoId: string;
  readonly filtro: Filtro;
  readonly unidad: string | null;
}) {
  const { periodo } = await mesOno404(barrioId, periodoId);
  const vista = await vistaDelMes(periodoId);
  const rutas = rutasDelPeriodo(barrioId, periodoId);

  if (vista.estado === "sin_permiso") {
    return (
      <Nota tono="info" titulo="La vista previa la calcula la administración del barrio.">
        Es la emisión entera, con el interés a hoy: la ven quienes emiten. Cuando el mes se emita, las boletas aparecen acá.
      </Nota>
    );
  }
  if (vista.estado === "bloqueada") {
    return (
      <Nota tono="peligro" titulo="Así no se puede emitir.">
        <p>{vista.motivo}</p>
        <p>{vista.sugerencia}</p>
      </Nota>
    );
  }

  const conInteres = vista.boletas.filter((b) => b.interes !== "0.00");
  const conCargos = vista.boletas.filter((b) => b.cargos !== "0.00");
  const visibles = filtro === "interes" ? conInteres : filtro === "cargos" ? conCargos : vista.boletas;
  const ejemplo = vista.boletas.find((b) => b.unidadFuncionalId === unidad) ?? visibles[0] ?? null;
  const enlace = (f: Filtro) => (f === "todas" ? rutas.boletas : `${rutas.boletas}?filtro=${f}`);
  const conUnidad = (id: string) => `${rutas.boletas}?${filtro === "todas" ? "" : `filtro=${filtro}&`}unidad=${id}`;
  const hora = vista.calculadaEl.slice(11, 16);

  return (
    <>
      <p className={ui.secundaria}>
        {vista.estado === "vista_previa" ? (
          <>
            <Chip tono="info">Vista previa</Chip> Calculada hoy {formatearFecha(vista.calculadaEl.slice(0, 10))} {hora} con lo cargado
            hasta ahora. Se actualiza sola: no hay que generar nada.
          </>
        ) : (
          <>
            <Chip tono="exito">Emitidas</Chip> Emitidas el {formatearFechaHora(vista.calculadaEl.slice(0, 16))}
            {periodo.emitidaPorNombre ? ` por ${periodo.emitidaPorNombre}` : ""} · {vista.totales.boletas} boletas ·{" "}
            {pesos(vista.totales.total)}
          </>
        )}
      </p>

      <FiltrosDeLista etiqueta="Qué boletas ver">
        <FiltroDeLista href={enlace("todas")} activo={filtro === "todas"} cantidad={vista.boletas.length}>
          Todas
        </FiltroDeLista>
        <FiltroDeLista href={enlace("interes")} activo={filtro === "interes"} cantidad={conInteres.length}>
          Con interés
        </FiltroDeLista>
        <FiltroDeLista href={enlace("cargos")} activo={filtro === "cargos"} cantidad={conCargos.length}>
          Con cargos
        </FiltroDeLista>
      </FiltrosDeLista>

      <div className={estilos.dos}>
        <MarcoTabla etiqueta={vista.estado === "vista_previa" ? "Vista previa de las boletas" : "Boletas emitidas"}>
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Unidad
                </th>
                <th scope="col" className={ui.numerica}>
                  Expensa
                </th>
                <th scope="col" className={ui.numerica}>
                  Cargos
                </th>
                <th scope="col" className={ui.numerica}>
                  Interés
                </th>
                <th scope="col" className={ui.numerica}>
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((b) => (
                <tr key={b.unidadFuncionalId}>
                  <th scope="row" className={ui.columnaAncla}>
                    <a href={conUnidad(b.unidadFuncionalId)}>{b.etiqueta}</a>
                  </th>
                  <td className={ui.numerica}>{pesos(b.expensa)}</td>
                  <td className={ui.numerica}>{oGuion(b.cargos)}</td>
                  <td className={ui.numerica}>{oGuion(b.interes)}</td>
                  <td className={ui.numerica}>{pesos(b.total)}</td>
                </tr>
              ))}
            </tbody>
          </Tabla>
        </MarcoTabla>

        {ejemplo ? (
          <Panel titulo={`Boleta de ${ejemplo.etiqueta}`} origen={`${nombreDelPeriodo(periodo.periodo)} · elegí otra unidad en la tabla`}>
            <BoletaDeEjemplo
              titulo={periodo.barrioNombre}
              renglones={[
                { concepto: periodo.modelo === "fija" ? "Cuota del mes" : "Expensa del mes", importe: pesos(ejemplo.expensa) },
                ...(ejemplo.cargos !== "0.00" ? [{ concepto: "Cargos y descuentos", importe: pesos(ejemplo.cargos) }] : []),
                { concepto: "Saldo anterior", importe: pesos(ejemplo.saldoAnterior) },
                ...(ejemplo.interes !== "0.00" ? [{ concepto: "Interés por mora", importe: pesos(ejemplo.interes) }] : []),
              ]}
              total={{
                concepto: periodo.primerVencimiento ? `Total al ${formatearFecha(periodo.primerVencimiento)}` : "Total",
                importe: pesos(ejemplo.total),
              }}
            />
          </Panel>
        ) : null}
      </div>
    </>
  );
}
