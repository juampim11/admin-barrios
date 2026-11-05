/**
 * Lo común a todas las páginas del mes (T2, ADR-0011, maqueta `mes-liquidacion.html`): la cabecera
 * —«Noviembre 2026», su estado, el modelo y los vencimientos con «Cambiar», «Meses anteriores» y
 * «Emitir N boletas»— y las pestañas Resumen · Gastos y pagos · Cargos y descuentos · Boletas · Envío.
 *
 * **Las lecturas se hacen una vez por pedido** (`cache` de React): la cabecera, las pestañas y el
 * cuerpo de la página piden lo mismo y la base lo responde una sola vez. La vista previa es la cara
 * (la emisión entera en un punto de guardado, ~7 s en un barrio de 460 unidades): lo que depende de
 * ella va en `Suspense`, así el resto de la página aparece enseguida.
 */

import { cache, Suspense, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { leerPeriodo } from "@admin-barrios/data/servicios/periodos";
import {
  boletasDelMes,
  conteosDelMes,
  estadoDelMes,
  loQueFaltaDelMes,
  type BoletasDelMes,
} from "@admin-barrios/data/servicios/circuito-del-mes";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { formatearFecha, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { Boton, Chip, PestanaDelMes, PestanasDelMes, type Tono } from "@admin-barrios/ui";
import { EncabezadoDePagina } from "../../../../../componentes/ui.tsx";
import { migaDelBarrio, rutaDeLiquidacion, rutaDeMesesAnteriores, rutasDelPeriodo } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { BotonEmitirMes } from "./emitir.tsx";
import { CambiarVencimientos } from "./vencimientos.tsx";

/** El período y sus conteos: corto, sin vista previa. */
export const leerDelMes = cache(async (periodoId: string) =>
  conSesion(async (tx) => {
    const periodo = await leerPeriodo(tx, { periodoId });
    if (!periodo) return null;
    return { periodo, conteos: await conteosDelMes(tx, { periodoId }) };
  }),
);

/** La vista previa (antes de emitir) o las boletas emitidas. Cara: va en `Suspense`. */
export const vistaDelMes = cache(async (periodoId: string): Promise<BoletasDelMes> =>
  conSesion((tx) => boletasDelMes(tx, { periodoId })),
);

/** Lo que falta, con la vista previa (lo que bloquea es su rechazo). */
export const faltasDelMes = cache(async (periodoId: string) => {
  const vista = await vistaDelMes(periodoId);
  return conSesion((tx) => loQueFaltaDelMes(tx, { periodoId, vista }));
});

/** El período del barrio, o 404 (no existe, no se ve, o la URL mezcla un barrio con otro). */
export async function mesOno404(barrioId: string, periodoId: string) {
  const datos = await leerDelMes(periodoId);
  if (!datos || datos.periodo.barrioId !== barrioId) notFound();
  return datos;
}

export type PestanaDelMesActiva = "resumen" | "gastos" | "cargos" | "boletas" | "envio";

/** «Preparando», «Listo para emitir», «Emitido», «Enviado»: el estado del mes en palabras (D3). */
export type ChipDeEstado = { readonly tono: Tono; readonly texto: string };

export function chipDelEstado(estado: string, listo: boolean): ChipDeEstado {
  const e = estadoDelMes(estado);
  if (e === "emitido") return { tono: "exito", texto: "Emitido" };
  if (e === "enviado") return { tono: "exito", texto: "Enviado" };
  return listo ? { tono: "info", texto: "Listo para emitir" } : { tono: "alerta", texto: "Preparando" };
}

const vencimientosEnPalabras = (primero: string | null, segundo: string | null): string =>
  primero === null
    ? "sin vencimiento"
    : segundo === null
      ? `vence el ${formatearFecha(primero)}`
      : `vence el ${formatearFecha(primero)} y el ${formatearFecha(segundo)}`;

/** Si nada bloquea: el mes está listo para emitir. */
async function estaListo(periodoId: string): Promise<boolean> {
  const vista = await vistaDelMes(periodoId);
  if (vista.estado !== "vista_previa") return false;
  return !(await faltasDelMes(periodoId)).some((f) => f.tipo === "bloquea");
}

async function ChipDelMes({ periodoId, estado }: { readonly periodoId: string; readonly estado: string }) {
  const sinEmitir = estadoDelMes(estado) === "preparando";
  const chip = chipDelEstado(estado, sinEmitir ? await estaListo(periodoId) : false);
  return <Chip tono={chip.tono}>{chip.texto}</Chip>;
}

async function EmitirDelMes({
  barrioId,
  periodoId,
  barrioNombre,
  mes,
  vencimientos,
}: {
  readonly barrioId: string;
  readonly periodoId: string;
  readonly barrioNombre: string;
  readonly mes: string;
  readonly vencimientos: string;
}) {
  const vista = await vistaDelMes(periodoId);
  if (vista.estado !== "vista_previa") {
    return (
      <Boton variante="primario" deshabilitado>
        Emitir
      </Boton>
    );
  }
  const bloquea = (await faltasDelMes(periodoId)).some((f) => f.tipo === "bloquea");
  if (bloquea) {
    return (
      <Boton variante="primario" deshabilitado>
        {`Emitir ${vista.totales.boletas} boletas`}
      </Boton>
    );
  }
  return (
    <BotonEmitirMes
      periodoId={periodoId}
      huellaVista={vista.huella}
      vistaCalculadaEl={vista.calculadaEl}
      boletas={vista.totales.boletas}
      total={`$ ${formatearMonto(vista.totales.total)}`}
      titulo={`Emitir ${mes.toLowerCase()} en ${barrioNombre}`}
      fechaDeHoy={formatearFecha(vista.calculadaEl.slice(0, 10))}
      vencimientos={vencimientos}
      volverA={rutasDelPeriodo(barrioId, periodoId).envio}
    />
  );
}

/**
 * La cabecera y las pestañas del mes. Cada página del mes la dibuja arriba con su pestaña activa.
 * `extra` va debajo de las pestañas (el «Listo:» de la página, por ejemplo).
 */
export async function EncabezadoDelMes({
  barrioId,
  periodoId,
  pestana,
  extra,
}: {
  readonly barrioId: string;
  readonly periodoId: string;
  readonly pestana: PestanaDelMesActiva;
  readonly extra?: ReactNode;
}) {
  const { periodo, conteos } = await mesOno404(barrioId, periodoId);
  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const mes = nombreDelPeriodo(periodo.periodo);
  const sinEmitir = estadoDelMes(periodo.estado) === "preparando";
  const vencimientos = vencimientosEnPalabras(periodo.primerVencimiento, periodo.segundoVencimiento);
  const nombreDePestana: Record<PestanaDelMesActiva, string | null> = {
    resumen: null,
    gastos: "Gastos y pagos",
    cargos: "Cargos y descuentos",
    boletas: "Boletas",
    envio: "Envío",
  };
  const ultima = nombreDePestana[pestana];

  return (
    <>
      <EncabezadoDePagina
        migas={
          ultima
            ? [
                migaDelBarrio({ id: barrioId, nombre: periodo.barrioNombre }),
                { texto: "Liquidación", href: rutaDeLiquidacion(barrioId) },
                { texto: mes, href: rutas.resumen },
                { texto: ultima },
              ]
            : [
                migaDelBarrio({ id: barrioId, nombre: periodo.barrioNombre }),
                { texto: "Liquidación", href: rutaDeLiquidacion(barrioId) },
                { texto: mes },
              ]
        }
        titulo={
          <>
            {mes}{" "}
            <Suspense fallback={<Chip tono="neutro">{sinEmitir ? "Preparando" : chipDelEstado(periodo.estado, false).texto}</Chip>}>
              <ChipDelMes periodoId={periodoId} estado={periodo.estado} />
            </Suspense>
          </>
        }
        bajada={
          <>
            {periodo.modelo === "fija" ? "Cuota fija" : "Por coeficiente"} · {vencimientos}
            {sinEmitir && periodo.puedeEmitir ? (
              <>
                {" "}
                <CambiarVencimientos
                  periodoId={periodoId}
                  mes={mes.toLowerCase()}
                  primero={periodo.primerVencimiento}
                  segundo={periodo.segundoVencimiento}
                />
              </>
            ) : null}
          </>
        }
        acciones={
          <>
            <Boton href={rutaDeMesesAnteriores(barrioId)} variante="sutil">
              Meses anteriores
            </Boton>
            {sinEmitir && periodo.puedeEmitir ? (
              <Suspense
                fallback={
                  <Boton variante="primario" deshabilitado>
                    Calculando…
                  </Boton>
                }
              >
                <EmitirDelMes
                  barrioId={barrioId}
                  periodoId={periodoId}
                  barrioNombre={periodo.barrioNombre}
                  mes={mes}
                  vencimientos={vencimientos}
                />
              </Suspense>
            ) : null}
          </>
        }
      />
      <PestanasDelMes>
        <PestanaDelMes href={rutas.resumen} activa={pestana === "resumen"}>
          Resumen
        </PestanaDelMes>
        <PestanaDelMes href={rutas.gastos} activa={pestana === "gastos"} cantidad={conteos.gastos}>
          Gastos y pagos
        </PestanaDelMes>
        <PestanaDelMes href={rutas.cargos} activa={pestana === "cargos"} cantidad={conteos.cargos}>
          Cargos y descuentos
        </PestanaDelMes>
        <PestanaDelMes
          href={rutas.boletas}
          activa={pestana === "boletas"}
          cantidad={sinEmitir ? conteos.unidades : conteos.boletasEmitidas}
        >
          Boletas
        </PestanaDelMes>
        <PestanaDelMes href={rutas.envio} activa={pestana === "envio"}>
          Envío
        </PestanaDelMes>
      </PestanasDelMes>
      {extra}
    </>
  );
}
