import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { formatearFecha, formatearFechaHora, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { Chip, CifraDelMes, CifrasDelMes } from "@admin-barrios/ui";
import { Nota, Pagina, ui } from "../../../../../../componentes/ui.tsx";
import { esIdValido } from "../../../../../../rutas.ts";
import { EncabezadoDelMes, mesOno404, vistaDelMes } from "../mes.tsx";
import { TablaDeBoletas } from "./tabla.tsx";

export const metadata: Metadata = { title: "Boletas del mes" };

/**
 * **Boletas** (T2, D1; maqueta, pantalla 4). Reemplaza «Generar el borrador» y «Revisar y emitir».
 * Antes de emitir es una **vista previa al día**: se calcula al pedirla con lo cargado hasta ahora, con
 * el interés a hoy, y no se guarda. Después de emitir son las boletas emitidas, con su sello, sin
 * cambiar de pantalla.
 *
 * La vista previa se calcula **una vez**: arriba el total y la cantidad de boletas, y los filtros y la
 * boleta de ejemplo andan en el navegador sobre lo ya calculado (`tabla.tsx`; ensayo de T2).
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
        <Boletas barrioId={barrioId} periodoId={periodoId} unidad={unidad} />
      </Suspense>
    </Pagina>
  );
}

const pesos = (m: string) => `$ ${formatearMonto(m)}`;

async function Boletas({
  barrioId,
  periodoId,
  unidad,
}: {
  readonly barrioId: string;
  readonly periodoId: string;
  readonly unidad: string | null;
}) {
  const { periodo } = await mesOno404(barrioId, periodoId);
  const vista = await vistaDelMes(periodoId);

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

  const hora = vista.calculadaEl.slice(11, 16);
  const cuantas = `${vista.totales.boletas} ${vista.totales.boletas === 1 ? "boleta" : "boletas"}`;

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
            {periodo.emitidaPorNombre ? ` por ${periodo.emitidaPorNombre}` : ""}.
          </>
        )}
      </p>
      <CifrasDelMes>
        <CifraDelMes valor={pesos(vista.totales.total)} etiqueta={vista.estado === "vista_previa" ? "total a emitir" : "total emitido"} />
        <CifraDelMes valor={cuantas} etiqueta={vista.estado === "vista_previa" ? "a emitir" : "emitidas"} />
      </CifrasDelMes>

      <TablaDeBoletas
        boletas={vista.boletas}
        etiquetaTabla={vista.estado === "vista_previa" ? "Vista previa de las boletas" : "Boletas emitidas"}
        tituloBoleta={periodo.barrioNombre}
        origenBoleta={`${nombreDelPeriodo(periodo.periodo)} · elegí otra unidad en la tabla`}
        conceptoExpensa={periodo.modelo === "fija" ? "Cuota del mes" : "Expensa del mes"}
        conceptoTotal={periodo.primerVencimiento ? `Total al ${formatearFecha(periodo.primerVencimiento)}` : "Total"}
        unidadInicial={unidad}
      />
    </>
  );
}
