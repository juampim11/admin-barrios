import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { listarAplicaciones } from "@admin-barrios/data/servicios/cargos";
import { conceptosDelMes, totalDeConceptos, type ConceptoDelMes } from "@admin-barrios/data/servicios/conceptos-del-mes";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { MAX_FILAS_USOS } from "@admin-barrios/shared/conceptos";
import { formatearDecimal, formatearMonto } from "@admin-barrios/shared/dinero";
import { nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { BarraDeAcciones, Boton, Chip, CifraDelMes, CifrasDelMes, IconoMas, PanelDesplegable } from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../../../componentes/iconos.tsx";
import { Cifra, Desplegable, MarcoTabla, Nota, Pagina, Panel, PilaDeNotas, Tabla, Vacio, ui } from "../../../../../../componentes/ui.tsx";
import { esIdValido, leerListo, rutaDeConceptosDelBarrio, rutasDelPeriodo, salidasDelPeriodo } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { EncabezadoDelMes, mesOno404, vistaDelMes } from "../mes.tsx";
import { DetalleDelConcepto } from "./detalle.tsx";
import { PlanillaDeUsos } from "./planilla.tsx";
import { chipDeOrigen, cuantasUnidades, pieDelMes, SE_CALCULA_AL_EMITIR } from "./textos.ts";
import estilos from "./conceptos.module.css";

export const metadata: Metadata = { title: "Conceptos del mes" };

const pesos = (m: string) => `$ ${formatearMonto(m)}`;

/**
 * **Conceptos del mes** (encargo 16b; maqueta, pantalla 4). Reemplaza a «Cargos y descuentos».
 *
 * Lo que se le pide a cada unidad este mes además del importe del mes, **un renglón por concepto**:
 * la bonificación por pago en término, lo que el catálogo aplica solo, lo que entró por una planilla
 * de usos y lo que se aplicó a mano. Cada renglón dice a quién va, a cuántas unidades, cuánto suma y
 * de dónde sale; «Ver» abre el detalle por unidad.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTA PANTALLA NO HACE
 *
 * - **No calcula ningún importe.** Los renglones y sus sumas los arma `conceptosDelMes`. Un importe
 *   en `null` es «se calcula al emitir» (un porcentaje, antes de calcular el mes), nunca `$ 0,00`.
 * - **No decide quién puede cargar.** `puedeCargar` viene del servicio; a quien no puede, o con el mes
 *   emitido, se le muestra todo como lectura, sin botones.
 * - **No lee la planilla.** El archivo lo lee el servidor (`api/usos/planilla`) y lo valida el
 *   servicio; la isla muestra la vista previa que vuelve.
 *
 * Es una tabla de servidor (regla 8 del sistema de UI): no hay orden ni búsqueda en el navegador. El
 * JavaScript de la página son la planilla y el diálogo de «Ver».
 *
 * **El pie** («Devengado» y «Deuda de meses anteriores») sale de las boletas del mes, que es la
 * emisión entera calculada: va en `Suspense` para que la tabla no espere.
 */
export default async function ConceptosDelMes({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();
  const { periodo } = await mesOno404(barrioId, periodoId);
  const listo = leerListo(await searchParams, "cargo");

  // Secuenciales y en una transacción: `node-postgres` encola las consultas del mismo client.
  const { delMes, anuladas } = await conSesion(async (tx) => ({
    delMes: await conceptosDelMes(tx, { periodoId }),
    // Lo anulado sigue a la vista, con su motivo: es la explicación de por qué esa plata no se cobró.
    anuladas: (await listarAplicaciones(tx, { periodoId })).filter((a) => a.anuladoAt !== null),
  }));

  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const mes = nombreDelPeriodo(periodo.periodo).toLowerCase();
  const { conceptos, puedeCargar, emitido } = delMes;
  const sinImporte = conceptos.filter((c) => c.importe === null).length;

  // «Listo:» de lo recién aplicado a mano, con la fila releída bajo RLS (no con lo que dice la URL).
  const recien = listo?.id
    ? (conceptos.flatMap((c) => c.aplicaciones.map((a) => ({ c, a }))).find(({ a }) => a.aplicacionId === listo.id) ?? null)
    : null;

  return (
    <Pagina>
      <EncabezadoDelMes barrioId={barrioId} periodoId={periodoId} pestana="conceptos" />

      <BarraDeAcciones>
        <span className={ui.secundaria}>
          Lo que se le suma o se le resta al cupón de cada unidad este mes, concepto por concepto. Qué conceptos hay y a
          quién va cada uno se define en <a href={rutaDeConceptosDelBarrio(barrioId)}>Conceptos del barrio</a>.
        </span>
        {puedeCargar ? (
          <Boton href={rutas.aplicarConcepto} variante="primario" icono={<IconoMas />}>
            Aplicar un concepto
          </Boton>
        ) : null}
      </BarraDeAcciones>

      <PilaDeNotas>
        {listo ? (
          <Nota
            tono="exito"
            titulo={recien ? `Listo: quedó aplicado «${recien.c.nombre}» a ${recien.a.unidad}.` : "Listo: el concepto quedó aplicado."}
          >
            {recien && recien.a.importe === null ? "El importe se calcula al emitir: no es cero, es que todavía no hay número." : ""}
          </Nota>
        ) : null}
        {emitido ? (
          <Nota tono="info" titulo="El mes está emitido: esto es lo que quedó en las boletas.">
            Ya no se le cargan conceptos. Si hay que corregir algo, va en el mes siguiente.
          </Nota>
        ) : puedeCargar ? null : (
          <Nota tono="neutro" titulo="Estás viendo los conceptos del mes en modo de solo lectura.">
            Los cargan la administración del barrio o un operador.
          </Nota>
        )}
      </PilaDeNotas>

      {puedeCargar ? (
        <PanelDesplegable
          titulo="Subir planilla de usos"
          origen="Para lo que se cobra por uso (una cancha, un salón): una fila por uso, con la unidad, el concepto, la fecha y la cantidad. Antes de cargar nada vas a ver la vista previa."
        >
          <PlanillaDeUsos
            periodoId={periodoId}
            rutaPlantilla="/api/usos/planilla?tipo=plantilla"
            maximoDeFilas={formatearDecimal(String(MAX_FILAS_USOS), 0)}
            salidas={salidasDelPeriodo(barrioId, periodoId)}
          />
        </PanelDesplegable>
      ) : null}

      <Panel
        titulo={`Conceptos de ${mes}`}
        origen={
          emitido
            ? "Lo que quedó aplicado en las boletas emitidas."
            : "Lo aplicado hasta ahora y lo que se va a aplicar solo al emitir, con las unidades a las que va hoy."
        }
        sinRelleno
      >
        {conceptos.length === 0 ? (
          <Vacio icono={<IconoBorrador />} titulo="Este mes no tiene ningún concepto">
            {puedeCargar
              ? "Es lo normal si no hubo usos, multas ni bonificaciones. Si los hubo, subí la planilla de usos o aplicá un concepto."
              : "No se aplicó ningún cargo ni descuento a ninguna unidad."}
          </Vacio>
        ) : (
          <MarcoTabla etiqueta={`Conceptos de ${mes}`}>
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Concepto
                  </th>
                  <th scope="col">A quién</th>
                  <th scope="col" className={ui.numerica}>
                    Unidades
                  </th>
                  <th scope="col" className={ui.numerica}>
                    Importe
                  </th>
                  <th scope="col">De dónde sale</th>
                  <th scope="col">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {conceptos.map((c) => (
                  <FilaDeConcepto key={c.clave} concepto={c} mes={mes} puedeAnular={puedeCargar} rutaBoletas={rutas.boletas} />
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>

      {sinImporte > 0 ? (
        <p className={ui.secundaria}>
          {sinImporte === 1 ? "Un concepto todavía no tiene importe" : `${sinImporte} conceptos todavía no tienen importe`}: se calcula al
          emitir, porque depende de lo que le toque pagar a cada unidad. No es cero.
        </p>
      ) : null}

      {anuladas.length > 0 ? (
        <Desplegable resumen={`Anulados en el mes (${anuladas.length})`}>
          <MarcoTabla etiqueta="Conceptos anulados en el mes">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col">Unidad</th>
                  <th scope="col">Concepto</th>
                  <th scope="col">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {anuladas.map((a) => (
                  <tr key={a.id}>
                    <th scope="row">{etiquetaUnidad(a.manzana, a.lote)}</th>
                    <td>
                      <span className={estilos.apilado}>
                        <span>{a.nombreConcepto}</span>
                        <span className={ui.secundaria}>{a.detalle}</span>
                      </span>
                    </td>
                    <td>{a.motivoAnulacion ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        </Desplegable>
      ) : null}

      <Suspense
        fallback={
          <Nota tono="info" titulo="Calculando el devengado del mes…">
            Sale de las boletas del mes, con lo cargado hasta ahora. En un barrio grande tarda unos segundos.
          </Nota>
        }
      >
        <PieDelMes periodoId={periodoId} mes={mes} conceptos={conceptos} />
      </Suspense>
    </Pagina>
  );
}

function FilaDeConcepto({
  concepto: c,
  mes,
  puedeAnular,
  rutaBoletas,
}: {
  readonly concepto: ConceptoDelMes;
  readonly mes: string;
  readonly puedeAnular: boolean;
  readonly rutaBoletas: string;
}) {
  const chip = chipDeOrigen(c.origen);
  return (
    <tr>
      <th scope="row" className={ui.columnaAncla}>
        <span className={estilos.apilado}>
          <span className={ui.principal}>{c.nombre}</span>
          <span className={ui.secundaria}>{c.clase === "cargo" ? "Suma" : "Resta"}</span>
        </span>
      </th>
      <td>{c.aQuien}</td>
      <td className={ui.numerica}>{c.unidades}</td>
      <td className={ui.numerica}>
        {/* Con signo: un descuento se ve negativo, al lado de un cargo. */}
        <Cifra monto={c.importe} nulo={SE_CALCULA_AL_EMITIR} signo />
      </td>
      <td>
        <span className={estilos.apilado}>
          <span>
            <Chip tono={chip.tono}>{chip.texto}</Chip>
          </span>
          <span className={ui.secundaria}>{c.deDonde}</span>
        </span>
      </td>
      <td>
        <DetalleDelConcepto
          mes={mes}
          nombre={c.nombre}
          origen={c.origen}
          resumen={`${c.aQuien} · ${cuantasUnidades(c.unidades)} · ${c.importe === null ? SE_CALCULA_AL_EMITIR : pesos(c.importe)}`}
          deDonde={c.deDonde}
          // Solo lo aplicado a mano se anula desde acá: lo demás lo decide su regla o su planilla.
          puedeAnular={puedeAnular && c.origen === "mano"}
          rutaBoletas={rutaBoletas}
          // A la isla va solo lo que el diálogo muestra.
          aplicaciones={c.aplicaciones.map((a) => ({
            aplicacionId: a.aplicacionId,
            unidadFuncionalId: a.unidadFuncionalId,
            unidad: a.unidad,
            importe: a.importe === null ? null : pesos(a.importe),
            detalle: a.detalle,
            usos: a.usos.map((u) => ({ fecha: u.fecha, cantidad: u.cantidad })),
          }))}
        />
      </td>
    </tr>
  );
}

/**
 * «Devengado de <mes>» y, al lado, «Deuda de meses anteriores». Los dos números salen de las boletas
 * del mes (`boletasDelMes().totales`). Si la vista previa no se puede calcular —el mes está bloqueado
 * o quien mira no emite—, se muestra solo lo que suman los conceptos con importe, y se dice.
 */
async function PieDelMes({
  periodoId,
  mes,
  conceptos,
}: {
  readonly periodoId: string;
  readonly mes: string;
  readonly conceptos: readonly ConceptoDelMes[];
}) {
  const vista = await vistaDelMes(periodoId);

  if (vista.estado === "bloqueada" || vista.estado === "sin_permiso") {
    return (
      <>
        <CifrasDelMes>
          <CifraDelMes valor={pesos(totalDeConceptos(conceptos))} etiqueta="Conceptos del mes que ya tienen importe" />
        </CifrasDelMes>
        <p className={ui.secundaria}>
          {vista.estado === "sin_permiso"
            ? "El devengado del mes sale de la vista previa de las boletas, que la calcula la administración del barrio. Acá va solo lo que suman los conceptos de arriba que ya tienen importe."
            : `El devengado del mes todavía no se puede calcular: ${vista.motivo} Acá va solo lo que suman los conceptos de arriba que ya tienen importe.`}
        </p>
      </>
    );
  }

  const pie = pieDelMes(mes, vista.totales, vista.devengado.cuponCobra);
  return (
    <>
      <CifrasDelMes>
        <CifraDelMes valor={pie.devengado.valor} etiqueta={pie.devengado.etiqueta} />
        <CifraDelMes valor={pie.deuda.valor} etiqueta={pie.deuda.etiqueta} />
      </CifrasDelMes>
      <p className={ui.secundaria}>
        {pie.origen}
        {vista.estado === "vista_previa" ? " Es una vista previa con lo cargado hasta ahora: cambia hasta que se emita." : ""}
      </p>
    </>
  );
}
