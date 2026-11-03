import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import {
  coeficientesDelBarrio,
  leerBarrioDelPadron,
  puedeEditarPadron,
  type VersionDeCoeficientes,
} from "@admin-barrios/data/servicios/padron-edicion";
import { formatearDecimal } from "@admin-barrios/shared/dinero";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { AccionDesplegable, Chip, type Tono } from "@admin-barrios/ui";
import { etiquetaBaseCoeficiente } from "../../../../../componentes/etiquetas.tsx";
import { IconoAlerta, IconoCorrecto, IconoInfo } from "../../../../../componentes/iconos.tsx";
import {
  EncabezadoDePagina,
  MarcoTabla,
  Nota,
  Pagina,
  Panel,
  Tabla,
  Vacio,
  ui,
} from "../../../../../componentes/ui.tsx";
import { esIdValido, migaDelBarrio, rutaDelPadron } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import estilos from "./coeficientes.module.css";
import { FormularioDeNuevaVersion } from "./nueva-version.tsx";

export const metadata: Metadata = { title: "Coeficientes" };

/** Cuántas unidades sin coeficiente se nombran en la alerta; el resto se cuenta. */
const NOMBRADAS = 5;

/** `"2026-12"` → `["2026-12", "2027-01", "2027-02"]`. Aritmética de texto: sin `Date`. */
function periodosDesde(periodo: string, cuantos: number): string[] {
  const [anio = "0", mes = "1"] = periodo.split("-");
  const base = Number.parseInt(anio, 10) * 12 + (Number.parseInt(mes, 10) - 1);
  return Array.from({ length: cuantos }, (_, i) => {
    const n = base + i;
    return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
  });
}

const ESTADO: Record<VersionDeCoeficientes["estado"], { texto: string; tono: Tono; icono: ReactNode }> = {
  vigente: { texto: "Vigente", tono: "exito", icono: <IconoCorrecto /> },
  programada: { texto: "Programada", tono: "info", icono: <IconoInfo /> },
  historica: { texto: "Histórica", tono: "neutro", icono: <IconoInfo /> },
};

/**
 * Las versiones de coeficientes del barrio (T3, pantalla 6 de la maqueta aprobada).
 *
 * Lectura de servidor —la tabla cuesta cero JavaScript— y una isla para la versión nueva
 * (`nueva-version.tsx`), que solo se ofrece a quien puede editar el padrón (`puedeEditarPadron` es
 * dato para la UI; quien decide es la base).
 *
 * La suma se muestra con sus 9 decimales: es la prueba de que la versión reparte exactamente 1.
 */
export default async function Coeficientes({ params }: { readonly params: Promise<{ readonly barrio: string }> }) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => {
    const barrio = await leerBarrioDelPadron(tx, { barrioId });
    if (!barrio) return null;
    return {
      barrio,
      coeficientes: await coeficientesDelBarrio(tx, { barrioId }),
      puedeEditar: await puedeEditarPadron(tx, { barrioId }),
    };
  });
  if (!datos) notFound();
  const { barrio, coeficientes, puedeEditar } = datos;
  const { versiones, sinCoeficiente } = coeficientes;

  const periodos = periodosDesde(barrio.proximoPeriodo, 3).map((p, i) => ({
    valor: p,
    texto: i === 0 ? `${formatearPeriodo(p)} (próximo período)` : formatearPeriodo(p),
  }));

  const nombradas = sinCoeficiente.slice(0, NOMBRADAS);
  const resto = sinCoeficiente.length - nombradas.length;
  // El servicio corta la lista en 200: más allá de eso, el número es un piso.
  const cuantasSin = `${sinCoeficiente.length}${sinCoeficiente.length >= 200 ? " o más" : ""}`;

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[
          migaDelBarrio(barrio),
          { texto: "Padrón", href: rutaDelPadron(barrio.id) },
          { texto: "Coeficientes" },
        ]}
        titulo="Coeficientes"
        bajada={
          <>
            Cada versión rige desde un período y suma 1 exacto; una versión que ya se usó para liquidar no se modifica.
            {barrio.modelo === "variable" ? " En este barrio el gasto de cada período se reparte con la versión que rige." : ""}
          </>
        }
      />

      {puedeEditar ? (
        <div>
          <AccionDesplegable texto="Nueva versión" variante="primario">
            <FormularioDeNuevaVersion
              barrioId={barrio.id}
              periodos={periodos}
              unidadesActivas={coeficientes.unidadesActivas}
              conSuperficie={coeficientes.conSuperficie}
              superficieTotal={coeficientes.superficieTotal === null ? null : formatearDecimal(coeficientes.superficieTotal, 2)}
            />
          </AccionDesplegable>
        </div>
      ) : null}

      {sinCoeficiente.length > 0 ? (
        <Nota
          tono="alerta"
          titulo={`Hay ${cuantasSin} ${sinCoeficiente.length === 1 ? "unidad" : "unidades"} sin coeficiente (${nombradas.join(", ")}${
            resto > 0 ? ` y ${resto} más` : ""
          }).`}
        >
          No se puede generar el próximo período ({formatearPeriodo(barrio.proximoPeriodo)}) hasta que una versión nueva las incluya.
        </Nota>
      ) : null}

      <Panel
        titulo="Versiones"
        origen={
          <>
            La vigente es la que rige para el próximo período, {formatearPeriodo(barrio.proximoPeriodo)}. Suma: la de los
            coeficientes de todas las unidades de la versión, con los 9 decimales que se guardan.
          </>
        }
        sinRelleno
      >
        {versiones.length === 0 ? (
          <Vacio icono={<IconoAlerta />} titulo="El barrio todavía no tiene coeficientes">
            {puedeEditar
              ? "Creá la primera versión con «Nueva versión»: por superficie, iguales por lote o por planilla."
              : "Quien administra el barrio tiene que crear la primera versión."}
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Versiones de coeficientes">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col">Versión</th>
                  <th scope="col">Base</th>
                  <th scope="col">Rige desde</th>
                  <th scope="col" className={ui.numerica}>
                    Unidades
                  </th>
                  <th scope="col" className={ui.numerica}>
                    Suma
                  </th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                {versiones.map((v) => (
                  <FilaDeVersion key={v.id} version={v} />
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>
    </Pagina>
  );
}

function FilaDeVersion({ version: v }: { readonly version: VersionDeCoeficientes }) {
  const estado = ESTADO[v.estado];
  return (
    <tr>
      <th scope="row">
        <span className={estilos.estado}>
          <span className={ui.principal}>{v.numero}</span>
          {v.descripcion ? <span className={ui.secundaria}>{v.descripcion}</span> : null}
        </span>
      </th>
      <td>{etiquetaBaseCoeficiente(v.base)}</td>
      <td>
        <span className={estilos.estado}>
          <span className={ui.mono}>{formatearPeriodo(v.rigeDesde)}</span>
          {v.rigeHasta ? <span className={ui.secundaria}>reemplazada desde {formatearPeriodo(v.rigeHasta)}</span> : null}
        </span>
      </td>
      <td className={ui.numerica}>{v.unidades}</td>
      <td className={ui.numerica}>
        <span className={ui.mono}>{formatearDecimal(v.suma, 9)}</span>
      </td>
      <td>
        <span className={estilos.estado}>
          <Chip tono={estado.tono} icono={estado.icono}>
            {estado.texto}
          </Chip>
          {v.usadaParaLiquidar ? <span className={ui.secundaria}>usada para liquidar: no se modifica</span> : null}
        </span>
      </td>
    </tr>
  );
}
