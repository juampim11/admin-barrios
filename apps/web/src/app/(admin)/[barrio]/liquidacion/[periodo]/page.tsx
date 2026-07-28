import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { leerPeriodo, type DetallePeriodo, type GastoDelPeriodo } from "@admin-barrios/data/servicios/periodos";
import { listarLiquidaciones, type GrillaLiquidaciones } from "@admin-barrios/data/servicios/liquidaciones";
import { restarMontos, sumarMontos } from "@admin-barrios/shared/dinero";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { IconoBorrador } from "../../../../../componentes/iconos.tsx";
import {
  Cifra,
  Chip,
  EncabezadoDePagina,
  MarcoTabla,
  Nota,
  Pagina,
  Paginado,
  Panel,
  PilaDeNotas,
  Tabla,
  Vacio,
  ui,
} from "../../../../../componentes/ui.tsx";
import {
  ESTADO_PERIODO_QUE_SIGNIFICA,
  EstadoDelPeriodo,
  etiquetaModelo,
  etiquetaOrigenSaldo,
  etiquetaTipoConcepto,
} from "../../../../../componentes/etiquetas.tsx";
import { esIdValido } from "../../../../../rutas.ts";
import {
  ColumnasOcultas,
  columnasDe,
  delGrupo,
  GRUPOS,
  GrillaDeLiquidaciones,
  visiblesDe,
  type Columna,
} from "./grilla.tsx";
import { conSesion } from "../../../../../servidor/db.ts";
import { PasosDelPeriodo } from "./pasos.tsx";
import estilos from "./periodo.module.css";

export const metadata: Metadata = { title: "Período" };

/**
 * Cuántas liquidaciones por página.
 *
 * **Es el techo del esquema (500) a propósito, y es la única pantalla donde eso corresponde.** Los
 * `totales` que devuelve `listarLiquidaciones` son de la página, no del período, y esta pantalla
 * existe para contestar si el mes cierra: con un tamaño de página chico, el administrador estaría
 * mirando la suma de 50 unidades de un barrio de 200 y creyendo que es el total del mes. Con 500, un
 * barrio normal entra entero y la cifra significa lo que dice. Cuando no entra, hay paginado y una
 * nota que lo declara — que es lo que faltaba y por lo que el número quedaba sin salida.
 */
const POR_PAGINA = 500;

/** La página llega por la URL, o sea del cliente: se valida, como todo lo que cruza el borde. */
const paginaSchema = z.coerce.number().int().min(1).catch(1);

/**
 * Un período: sus gastos, sus liquidaciones y los totales. **La pantalla donde se mira si el mes
 * cierra.**
 *
 * Está ordenada para contestar esa pregunta de arriba abajo, sin scrollear:
 *
 * 1. **qué mes es y en qué estado está** — el estado decide si todavía se puede tocar algo;
 * 2. **las cifras del cierre**, con la diferencia entre lo cargado y lo liquidado escrita, no
 *    insinuada;
 * 3. **lo que quedó pendiente** (mora sin tasa, extraordinarias sin acta, unidades sin liquidar);
 * 4. recién ahí el detalle: los gastos y la grilla por unidad.
 *
 * **Lo que esta pantalla NO hace: dictaminar.** No dice "cierra" ni "no cierra". Esa conclusión
 * depende del modelo del período —en `fija` los gastos no se prorratean igual que en `variable`— y
 * eso es una regla de negocio; una regla de negocio escrita en un componente es exactamente lo que
 * el ADR-0002 §5.2 prohíbe y lo que ningún test puede detectar. Lo que hace es poner las cifras
 * comparables una al lado de la otra, nombradas y con su origen, para que la persona que sabe pueda
 * verlo de un vistazo.
 *
 * La única aritmética es `sumarMontos` / `restarMontos` de `@admin-barrios/shared/dinero`, que
 * trabaja en centavos con `bigint`. Nunca `Number()`: el dinero llega como string a propósito.
 */
export default async function Periodo({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  // Ídem el layout: se renderizan en paralelo, así que el chequeo va en los dos (ver `rutas.ts`).
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();

  const crudos = await searchParams;
  const pagina = paginaSchema.parse(crudos["pagina"]);

  // Las tres lecturas van en UNA transacción y secuenciales: `node-postgres` encola las consultas de
  // un mismo client, así que un `Promise.all` acá no paralelizaría nada — solo daría a entender que
  // sí. El barrio se lee para tener el denominador (cuántas unidades activas hay) contra el que
  // comparar la cantidad de liquidaciones.
  const datos = await conSesion(async (tx) => {
    const periodo = await leerPeriodo(tx, { periodoId });
    if (!periodo) return { periodo: null, grilla: null, unidadesActivas: 0 };
    const grilla = await listarLiquidaciones(tx, {
      periodoId,
      limite: POR_PAGINA,
      desplazamiento: (pagina - 1) * POR_PAGINA,
    });
    const barrio = await leerBarrio(tx, { barrioId: periodo.barrioId });
    return { periodo, grilla, unidadesActivas: barrio?.unidadesActivas ?? 0 };
  });

  // `notFound()` afuera de la transacción (ADR-0002 §3.1). La segunda condición no es autorización
  // —ésa la hizo la RLS— sino coherencia de la URL: un período de otro barrio bajo este segmento
  // mostraría una cabecera que no corresponde a lo que se está mirando.
  if (!datos.periodo || !datos.grilla || datos.periodo.barrioId !== barrioId) notFound();
  const periodo = datos.periodo;
  const grilla = datos.grilla;
  const unidadesActivas = datos.unidadesActivas;

  const paginas = Math.max(1, Math.ceil(grilla.total / POR_PAGINA));
  if (pagina > paginas) redirect(`/${barrioId}/liquidacion/${periodoId}?pagina=${paginas}`);

  // Una sola definición de las columnas para el panel de cierre y para la grilla (ver `columnasDe`).
  const columnas = columnasDe(grilla);

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo={
          <span className={estilos.identidad}>
            <span className={estilos.mes}>{formatearPeriodo(periodo.periodo)}</span>
            <EstadoDelPeriodo estado={periodo.estado} editable={periodo.editable} />
          </span>
        }
        bajada={
          <>
            {periodo.barrioNombre} · {etiquetaModelo(periodo.modelo)} ·{" "}
            {ESTADO_PERIODO_QUE_SIGNIFICA[periodo.estado]}
            {periodo.primerVencimiento ? (
              <>
                {" · "}
                <span className={estilos.sinCorte}>
                  vence el {formatearFecha(periodo.primerVencimiento)}
                </span>
                {periodo.segundoVencimiento ? (
                  <>
                    {" · "}
                    <span className={estilos.sinCorte}>
                      2.º vto. {formatearFecha(periodo.segundoVencimiento)}
                    </span>
                  </>
                ) : null}
              </>
            ) : null}
          </>
        }
      />

      <PasosDelPeriodo barrioId={barrioId} periodoId={periodoId} />

      <Cierre periodo={periodo} grilla={grilla} columnas={columnas} />
      <Pendientes periodo={periodo} grilla={grilla} unidadesActivas={unidadesActivas} />
      <Gastos periodo={periodo} />
      <Liquidaciones
        periodo={periodo}
        grilla={grilla}
        todas={columnas}
        ruta={`/${barrioId}/liquidacion/${periodoId}`}
        pagina={pagina}
        paginas={paginas}
      />
    </Pagina>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 2 · Las cifras del cierre
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Las cuatro cifras que hay que poder comparar, y la diferencia entre las dos que **son** el mismo
 * concepto medido en dos momentos.
 *
 * `totalGastosCargados` lo recalcula el servicio sumando los gastos de ahora; `totalGastos` es la
 * columna que se escribió al generar el borrador. Que no coincidan no es un error: significa que se
 * cargaron o anularon gastos después. Mostrar las dos y su resta es lo que convierte esa diferencia
 * en un dato en vez de en un misterio.
 *
 * "Repartido a las unidades" **sale de las mismas columnas que agrupa la grilla de abajo** —el grupo
 * `reparto`— y la fórmula se imprime a partir de sus títulos, no escrita a mano. Antes eran dos
 * listas independientes y se contradecían: acá la cifra decía que cargos y descuentos no son reparto
 * y trescientas líneas más abajo el encabezado los ponía adentro de "Del período". Los ajustes por
 * unidad y el arrastre entran en el total a cobrar, que por eso va aparte y no al lado.
 */
function Cierre({
  periodo,
  grilla,
  columnas,
}: {
  readonly periodo: DetallePeriodo;
  readonly grilla: GrillaLiquidaciones;
  readonly columnas: readonly Columna[];
}) {
  const reparto = delGrupo(columnas, "reparto");
  const repartido = sumarMontos(...reparto.map((c) => c.total));
  const diferencia = periodo.totalGastos === null ? null : restarMontos(periodo.totalGastosCargados, periodo.totalGastos);
  const hayDiferencia = diferencia !== null && diferencia !== "0.00";
  const paginaCompleta = grilla.liquidaciones.length === grilla.total;

  return (
    <Panel
      titulo="Las cifras del mes"
      origen={`${periodo.barrioNombre} · período ${formatearPeriodo(periodo.periodo)} · ${etiquetaModelo(periodo.modelo)}`}
    >
      <div className={estilos.cierre}>
        <Celda
          etiqueta="Gastos cargados"
          origen={`suma de los ${periodo.gastos.length} gastos que hay cargados ahora`}
        >
          <Cifra monto={periodo.totalGastosCargados} nulo="—" />
        </Celda>

        <Celda etiqueta="Gastos al liquidar" origen="el importe que quedó escrito al generar el borrador">
          <Cifra monto={periodo.totalGastos} nulo="todavía sin liquidar" />
        </Celda>

        <Celda
          etiqueta={GRUPOS.reparto}
          origen={
            <>
              suma de {grilla.liquidaciones.length} liquidaciones
              <br />
              <span className={estilos.formula}>
                {reparto.map((c) => c.titulo.toLowerCase()).join(" + ")}
              </span>
            </>
          }
        >
          <Cifra monto={grilla.total === 0 ? null : repartido} nulo="sin liquidaciones" />
        </Celda>

        <Celda
          destacada
          etiqueta="Total a cobrar"
          origen={`el ${GRUPOS.reparto.toLowerCase()} más los ajustes de cada unidad y lo que viene de antes`}
        >
          <Cifra monto={grilla.total === 0 ? null : grilla.totales.total} nulo="sin liquidaciones" />
        </Celda>
      </div>

      {hayDiferencia ? (
        <Nota tono="alerta" titulo="Lo cargado y lo liquidado no coinciden.">
          Hay <Cifra monto={diferencia} nulo="—" /> de diferencia entre los gastos cargados hoy y el
          importe con el que se generó el borrador. Se cargaron o se anularon gastos después de
          liquidar: la liquidación de cada unidad sigue calculada con el importe viejo.
        </Nota>
      ) : null}

      {!paginaCompleta ? (
        <Nota tono="info" titulo="Los totales son de esta página, no del período entero.">
          Se están mostrando {grilla.liquidaciones.length} de {grilla.total} liquidaciones. Para
          conciliar el mes hace falta el período completo.
        </Nota>
      ) : null}
    </Panel>
  );
}

function Celda({
  etiqueta,
  origen,
  destacada,
  children,
}: {
  readonly etiqueta: string;
  readonly origen: ReactNode;
  readonly destacada?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className={`${estilos.celda} ${destacada ? estilos.celdaDestacada : ""}`}>
      <span className={estilos.celdaEtiqueta}>{etiqueta}</span>
      <span className={estilos.celdaCifra}>{children}</span>
      <span className={estilos.celdaOrigen}>{origen}</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 3 · Lo que quedó pendiente
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Las tres cosas que hay que ver antes de decidir nada, **cada una con su denominador**.
 *
 * `conMoraPendiente` sale de un `count(*) filter` sobre el período entero y no de contar el arreglo
 * devuelto: una alerta que solo mira la página subcuenta en silencio justo en el barrio grande, que
 * es donde más caro sale.
 */
function Pendientes({
  periodo,
  grilla,
  unidadesActivas,
}: {
  readonly periodo: DetallePeriodo;
  readonly grilla: GrillaLiquidaciones;
  readonly unidadesActivas: number;
}) {
  const sinActa = periodo.gastos.filter((g) => g.sinRespaldoAsamblea);
  const faltanUnidades = grilla.total > 0 && grilla.total !== unidadesActivas;

  // Sin liquidaciones no hay nada que declarar en orden: los tres controles miran liquidaciones, y
  // dos de ellos dan cero por vacío. Un período recién creado —0 gastos, 0 liquidaciones, 50
  // unidades activas— mostraba en verde "ni diferencia entre las liquidaciones y las unidades
  // activas del padrón", que es falso de forma verificable. El estado vacío lo explica más abajo.
  if (grilla.total === 0) return null;

  if (grilla.conMoraPendiente === 0 && sinActa.length === 0 && !faltanUnidades) {
    return (
      <Nota tono="exito" titulo="No quedan pendientes registrados en este período.">
        Ni unidades con la mora sin definir, ni gastos extraordinarios sin respaldo de asamblea, ni
        diferencia entre las liquidaciones y las unidades activas del padrón.
      </Nota>
    );
  }

  return (
    <PilaDeNotas>
      {grilla.conMoraPendiente > 0 ? (
        <Nota
          tono="alerta"
          titulo={`${grilla.conMoraPendiente} de ${grilla.total} unidades quedaron con la mora pendiente de definición.`}
        >
          El barrio no tenía tasa de mora vigente al liquidar, y el sistema no inventa una: esas
          liquidaciones salieron sin interés calculado y la boleta lo dice.
        </Nota>
      ) : null}

      {sinActa.length > 0 ? (
        <Nota
          tono="alerta"
          titulo={`${sinActa.length} de ${periodo.gastos.length} gastos son extraordinarios sin respaldo de asamblea.`}
        >
          No bloquea la emisión —pasa en la operatoria real— pero condiciona el reclamo de la deuda:{" "}
          {sinActa.map((g) => g.descripcion).join(" · ")}.
        </Nota>
      ) : null}

      {faltanUnidades ? (
        <Nota
          tono="info"
          titulo={`Hay ${grilla.total} liquidaciones y ${unidadesActivas} unidades activas en el padrón.`}
        >
          La diferencia es esperable si el padrón cambió después de liquidar: la liquidación se generó
          contra las unidades que estaban activas en ese momento.
        </Nota>
      ) : null}
    </PilaDeNotas>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 4 · Los gastos
// ────────────────────────────────────────────────────────────────────────────────────────────────

function Gastos({ periodo }: { readonly periodo: DetallePeriodo }) {
  return (
    <Panel
      titulo="Gastos del período"
      origen={
        <>
          El total es la suma de estas filas, recalculada ahora — se puede auditar sumando la columna
          a mano. Las <strong>extraordinarias</strong> (art. 2048) van marcadas: son las que necesitan
          respaldo de asamblea.
        </>
      }
      sinRelleno
    >
      {periodo.gastos.length === 0 ? (
        <Vacio icono={<IconoBorrador />} titulo="Todavía no se cargó ningún gasto">
          Sin gastos cargados no hay nada que prorratear entre las unidades.
        </Vacio>
      ) : (
        <MarcoTabla etiqueta="Gastos cargados en el período">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Gasto
                </th>
                <th scope="col">Concepto</th>
                <th scope="col">Proveedor</th>
                <th scope="col">Comprobante</th>
                <th scope="col" className={ui.numerica}>
                  Monto
                </th>
              </tr>
            </thead>
            <tbody>
              {periodo.gastos.map((gasto) => (
                <FilaDeGasto key={gasto.id} gasto={gasto} />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={4} className={ui.columnaAncla}>
                  Total cargado · {periodo.gastos.length} gastos
                </th>
                <td className={ui.numerica}>
                  <Cifra monto={periodo.totalGastosCargados} nulo="—" />
                </td>
              </tr>
            </tfoot>
          </Tabla>
        </MarcoTabla>
      )}
    </Panel>
  );
}

function FilaDeGasto({ gasto }: { readonly gasto: GastoDelPeriodo }) {
  return (
    <tr>
      <th scope="row" className={ui.columnaAncla}>
        <span className={estilos.gasto}>
          <span className={ui.principal}>{gasto.descripcion}</span>
          {gasto.sinRespaldoAsamblea ? (
            <span>
              <Chip tono="alerta">Sin respaldo de asamblea</Chip>
            </span>
          ) : gasto.actaTitulo ? (
            <span className={ui.secundaria}>Acta: {gasto.actaTitulo}</span>
          ) : null}
          {gasto.motivoSinRespaldo ? (
            <span className={ui.secundaria}>{gasto.motivoSinRespaldo}</span>
          ) : null}
        </span>
      </th>
      <td>
        <span className={estilos.gasto}>
          <span>{gasto.conceptoNombre}</span>
          <span className={ui.secundaria}>
            {etiquetaTipoConcepto(gasto.conceptoTipo)}
            {gasto.esFondoReserva ? (
              <span className={estilos.marcaFondoReserva}> · fondo de reserva</span>
            ) : null}
          </span>
        </span>
      </td>
      <td>{gasto.proveedorNombre ?? <span className={ui.secundaria}>—</span>}</td>
      <td className={ui.mono}>{gasto.comprobante ?? <span className={ui.secundaria}>—</span>}</td>
      <td className={ui.numerica}>
        <Cifra monto={gasto.monto} nulo="—" />
      </td>
    </tr>
  );
}
// ────────────────────────────────────────────────────────────────────────────────────────────────
// 5 · La grilla por unidad
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * La grilla de revisión: una fila por unidad, con los subtotales que explican su total.
 *
 * Tres decisiones que hacen que se lea:
 *
 * **1. Encabezado de dos niveles.** Las columnas se agrupan en "Del período" —lo que se repartió
 * este mes— y "Arrastre" —lo que viene de antes—. El agrupado *es* la explicación: sin él, saldo
 * anterior e interés parecen parte del reparto y no lo son.
 *
 * **2. Las columnas cuyo total es cero se ocultan, y se dicen.** En un barrio con modelo variable y
 * sin cargos, la grilla pasa de once columnas a seis. Lo que se oculta queda escrito al pie: nada
 * desaparece en silencio.
 *
 * **3. La fila de totales es la suma de lo que se ve**, no una agregación aparte. Que el
 * administrador pueda sumar la columna a mano y llegar al mismo número es la forma barata de que la
 * cifra sea auditable.
 */
function Liquidaciones({
  periodo,
  grilla,
  todas,
  ruta,
  pagina,
  paginas,
}: {
  readonly periodo: DetallePeriodo;
  readonly grilla: GrillaLiquidaciones;
  readonly todas: readonly Columna[];
  readonly ruta: string;
  readonly pagina: number;
  readonly paginas: number;
}) {
  const { visibles, ocultasEnCero, ocultasSinDato } = visiblesDe(grilla, todas);

  // De dónde sale el saldo anterior. Es la cifra que más miente sin su origen: un `$ 0,00` con
  // "sin cuenta corriente todavía" NO significa "está al día", significa que el módulo de cobros
  // todavía no existe.
  const origenes = new Map<string, number>();
  for (const l of grilla.liquidaciones) {
    origenes.set(l.saldoAnteriorOrigen, (origenes.get(l.saldoAnteriorOrigen) ?? 0) + 1);
  }

  return (
    <Panel
      titulo="Liquidación por unidad"
      origen={
        <>
          Orden por manzana y lote — <strong>el mismo con el que salen las boletas</strong>: la fila 37
          de esta grilla es la boleta 37 del lote. Los totales del pie son la suma de las{" "}
          {grilla.liquidaciones.length} filas que se ven.
        </>
      }
      sinRelleno
      pie={
        <>
          <ColumnasOcultas enCero={ocultasEnCero} sinDato={ocultasSinDato} />
          {origenes.size > 0 ? (
            <>
              Origen del saldo anterior:{" "}
              {[...origenes].map(([clave, n]) => `${etiquetaOrigenSaldo(clave)} (${n})`).join(" · ")}.
            </>
          ) : null}
        </>
      }
    >
      {grilla.liquidaciones.length === 0 ? (
        <Vacio icono={<IconoBorrador />} titulo="Todavía no se generó el borrador">
          Este período está en {ESTADO_PERIODO_QUE_SIGNIFICA[periodo.estado]} y no tiene liquidaciones
          generadas. Los {periodo.gastos.length} gastos cargados están arriba, esperando a que se
          reparta. Se genera en <Link href={`${ruta}/revision`}>revisar y emitir</Link>.
        </Vacio>
      ) : (
        <GrillaDeLiquidaciones grilla={grilla} visibles={visibles} />
      )}
      {/*
        El paginado aparece **solo cuando hace falta**. Con el tamaño de página de 500 un barrio
        normal entra entero y no hay nada que paginar; el día que no entre, el panel de cierre avisa
        que los totales son de esta página y acá está la forma de llegar al resto. Antes la nota
        avisaba del recorte y no ofrecía ninguna salida.
      */}
      {paginas > 1 ? (
        <Paginado
          ruta={ruta}
          parametros={{}}
          pagina={pagina}
          paginas={paginas}
          rango={
            <>
              Mostrando {grilla.desplazamiento + 1}–
              {grilla.desplazamiento + grilla.liquidaciones.length} de {grilla.total} liquidaciones
            </>
          }
        />
      ) : null}
    </Panel>
  );
}
