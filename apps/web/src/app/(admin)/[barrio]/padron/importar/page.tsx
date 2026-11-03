import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerBarrioDelPadron, puedeEditarPadron } from "@admin-barrios/data/servicios/padron-edicion";
import { formatearDecimal } from "@admin-barrios/shared/dinero";
import { MAX_FILAS_PADRON, columnasDelPadron } from "@admin-barrios/shared/padron";
import { Boton } from "@admin-barrios/ui";
import { EncabezadoDePagina, Nota, Pagina, Panel } from "../../../../../componentes/ui.tsx";
import { esIdValido } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { ImportadorDePadron } from "./importador.tsx";
import estilos from "./importar.module.css";

export const metadata: Metadata = { title: "Importar planilla del padrón" };

/**
 * Importar la planilla del padrón (T3, pantalla 4 de la maqueta aprobada).
 *
 * La página resuelve en el servidor **quién puede** y **qué columnas tiene la planilla de este
 * barrio** (sin `cbu_unidad`/`alias_unidad` si cobra con una cuenta única), y deja el ida y vuelta
 * del archivo a la isla `importador.tsx`. El panel de columnas es de servidor: cero JavaScript.
 *
 * `puedeEditarPadron` es dato para la UI, no la autorización: el route handler la vuelve a pedir
 * antes de leer el archivo, y la base decide al escribir (`0065`).
 */
export default async function ImportarPlanilla({ params }: { readonly params: Promise<{ readonly barrio: string }> }) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => {
    const barrio = await leerBarrioDelPadron(tx, { barrioId });
    if (!barrio) return null;
    return { barrio, puedeEditar: await puedeEditarPadron(tx, { barrioId }) };
  });
  if (!datos) notFound();
  const { barrio, puedeEditar } = datos;
  const rutaPadron = `/${barrio.id}/padron`;

  if (!puedeEditar) {
    return (
      <Pagina>
        <EncabezadoDePagina titulo="Importar planilla del padrón" />
        <Nota tono="info" titulo="La planilla del padrón la importa quien administra el barrio.">
          Con tu rol podés ver el padrón, pero no cargarlo ni corregirlo.
        </Nota>
        <div>
          <Boton variante="secundario" href={rutaPadron}>
            Volver al padrón
          </Boton>
        </div>
      </Pagina>
    );
  }

  const columnas = columnasDelPadron(barrio.cuentaPorUnidad);

  return (
    <Pagina>
      <ImportadorDePadron
        barrioId={barrio.id}
        rutaPadron={rutaPadron}
        rutaPlantilla={`/api/padron/planilla?barrio=${barrio.id}&tipo=plantilla`}
        maximoDeFilas={formatearDecimal(String(MAX_FILAS_PADRON), 0)}
      />

      <Panel titulo="Columnas de la planilla">
        <p className={estilos.columnas}>{columnas.join(" · ")}</p>
        <p>
          Obligatorias: manzana y lote. <strong>Varios titulares:</strong> una fila por persona con la misma manzana y lote; los datos
          de la unidad (superficie, estado{barrio.cuentaPorUnidad ? ", cuenta" : ""}, saldo) van en la primera, y una sola marca{" "}
          <span className={estilos.columnas}>recibe_boleta</span>.{" "}
          <a href={`/api/padron/planilla?barrio=${barrio.id}&tipo=plantilla`}>Bajar la plantilla</a>
        </p>
        <ul className={estilos.reglas}>
          <li>
            Una unidad que no existe es un <strong>alta</strong>; una que ya existe se <strong>corrige</strong> (superficie, estado,
            contacto).
          </li>
          <li>
            Un <strong>cambio de titular</strong> no se hace por planilla: tiene fecha e historial y se hace desde la ficha de la
            unidad.
          </li>
          <li>
            El <strong>saldo inicial</strong> es la deuda que la unidad trae de antes del sistema. Se carga una sola vez.
          </li>
          <li>Un mismo CUIT en varias unidades no es un error: la misma persona puede tener varios lotes.</li>
        </ul>
      </Panel>
    </Pagina>
  );
}
