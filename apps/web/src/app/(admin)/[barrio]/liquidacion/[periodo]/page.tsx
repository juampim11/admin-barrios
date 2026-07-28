import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { leerPeriodo, type DetallePeriodo, type GastoDelPeriodo } from "@admin-barrios/data/servicios/periodos";
import {
  listarLiquidaciones,
  type GrillaLiquidaciones,
  type LiquidacionDeGrilla,
} from "@admin-barrios/data/servicios/liquidaciones";
import { restarMontos, sumarMontos } from "@admin-barrios/shared/dinero";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { IconoBorrador } from "../../../../../componentes/iconos.tsx";
import {
  Cifra,
  Chip,
  Coeficiente,
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
import { conSesion } from "../../../../../servidor/db.ts";
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
 * Los tres grupos de columnas, y **son los mismos tres que usa el panel de cierre**.
 *
 * Antes eran dos —"Del período" y "Arrastre"— con cargos y descuentos metidos en el primero,
 * mientras que la cifra "Repartido a las unidades" de arriba los dejaba afuera. Dos clasificaciones
 * distintas de las mismas seis columnas, en el mismo archivo, a trescientas líneas de distancia. Con
 * tres grupos, `reparto` es exactamente el primero y la pantalla no puede contradecirse.
 */
const GRUPOS = {
  reparto: "Prorrateo del mes",
  ajustes: "Ajustes de la unidad",
  arrastre: "Viene de antes",
} as const;

type Grupo = keyof typeof GRUPOS;

type Columna = {
  readonly clave: string;
  readonly titulo: string;
  readonly grupo: Grupo;
  readonly valor: (l: LiquidacionDeGrilla) => string | null;
  readonly total: string;
  readonly nulo: string;
  readonly signo?: boolean;
  /** Se muestra aunque esté en cero: sin ella la grilla dejaría de explicar el reparto. */
  readonly siempre?: boolean;
};

/**
 * Las ocho columnas de subtotales, con su grupo y su total. **Se arman una sola vez por pantalla** y
 * las usan las dos piezas que tienen que coincidir: el panel de cierre (que suma el grupo `reparto`)
 * y la grilla (que agrupa los encabezados). Que salgan del mismo lugar es lo que hace imposible la
 * contradicción que había antes.
 */
function columnasDe(grilla: GrillaLiquidaciones): readonly Columna[] {
  const t = grilla.totales;
  return [
    { clave: "cuotaFija", titulo: "Cuota fija", grupo: "reparto", valor: (l) => l.subtotalCuotaFija, total: t.cuotaFija, nulo: "—" },
    { clave: "ordinarias", titulo: "Ordinarias", grupo: "reparto", valor: (l) => l.subtotalOrdinarias, total: t.ordinarias, nulo: "—", siempre: true },
    { clave: "extraordinarias", titulo: "Extraordinarias", grupo: "reparto", valor: (l) => l.subtotalExtraordinarias, total: t.extraordinarias, nulo: "—" },
    { clave: "fondoReserva", titulo: "Fondo de reserva", grupo: "reparto", valor: (l) => l.subtotalFondoReserva, total: t.fondoReserva, nulo: "—" },
    { clave: "cargos", titulo: "Cargos", grupo: "ajustes", valor: (l) => l.subtotalCargos, total: t.cargos, nulo: "—", signo: true },
    { clave: "descuentos", titulo: "Descuentos", grupo: "ajustes", valor: (l) => l.subtotalDescuentos, total: t.descuentos, nulo: "—", signo: true },
    { clave: "saldoAnterior", titulo: "Saldo anterior", grupo: "arrastre", valor: (l) => l.saldoAnterior, total: t.saldoAnterior, nulo: "—" },
    { clave: "interesMora", titulo: "Interés por mora", grupo: "arrastre", valor: (l) => l.interesMora, total: t.interesMora, nulo: "pendiente" },
  ];
}

/** Las columnas de un grupo, en el orden en que se muestran. */
const delGrupo = (columnas: readonly Columna[], grupo: Grupo): readonly Columna[] =>
  columnas.filter((c) => c.grupo === grupo);

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
  /*
   * Una columna se oculta solo si **ninguna fila** tiene algo ahí — no si su total da cero.
   *
   * La diferencia no es teórica y es plata: `saldo_anterior` es `numeric(14,2)` sin check de signo,
   * así que un saldo a favor es negativo. Con el criterio "el total da cero", una unidad con
   * +180.000 y otra con −180.000 hacen desaparecer la columna entera, y el pie de la grilla declara
   * "columnas en cero, ocultas: saldo anterior" — o sea, la pantalla donde se decide emitir afirma
   * que no hay arrastre cuando hay 360.000 pesos de arrastre. Con `some()` eso no puede pasar: una
   * columna oculta es una columna donde todas las filas dicen cero.
   */
  const enCero = (c: Columna) => grilla.liquidaciones.every((l) => (c.valor(l) ?? "0.00") === "0.00");
  const visibles = todas.filter((c) => c.siempre === true || !enCero(c));
  const ocultas = todas.filter((c) => !visibles.includes(c));
  // Los grupos que quedaron con al menos una columna visible, en orden. Un grupo entero en cero no
  // deja un encabezado vacío colgando.
  const gruposVisibles = (Object.keys(GRUPOS) as Grupo[])
    .map((grupo) => ({ grupo, columnas: delGrupo(visibles, grupo) }))
    .filter(({ columnas }) => columnas.length > 0);

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
          {ocultas.length > 0 ? (
            <>
              Columnas ocultas porque <strong>todas</strong> las liquidaciones las tienen en cero:{" "}
              {ocultas.map((c) => c.titulo.toLowerCase()).join(" · ")}.{" "}
            </>
          ) : null}
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
          reparta.
        </Vacio>
      ) : (
        <MarcoTabla etiqueta="Liquidaciones del período por unidad funcional">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" rowSpan={2} className={ui.columnaAncla}>
                  Unidad
                </th>
                <th scope="col" rowSpan={2} className={ui.numerica}>
                  Coeficiente
                </th>
                {gruposVisibles.map(({ grupo, columnas }) => (
                  <th key={grupo} scope="colgroup" colSpan={columnas.length} className={ui.grupoDeColumnas}>
                    {GRUPOS[grupo]}
                  </th>
                ))}
                <th scope="col" rowSpan={2} className={`${ui.numerica} ${ui.columnaTotal}`}>
                  Total
                </th>
              </tr>
              <tr>
                {visibles.map((c, i) => (
                  <th
                    key={c.clave}
                    scope="col"
                    className={`${ui.numerica} ${i === 0 || c.grupo !== visibles[i - 1]?.grupo ? ui.separadorIzquierdo : ""}`}
                  >
                    {c.titulo}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grilla.liquidaciones.map((l) => (
                <tr key={l.id}>
                  <th scope="row" className={ui.columnaAncla}>
                    <span className={estilos.unidadEnGrilla}>
                      <span className={estilos.etiquetaUnidad}>{l.etiqueta}</span>
                      <span className={ui.secundaria}>
                        {l.destinatario ?? "sin obligado notificado"}
                      </span>
                      {l.numeroComprobante ? (
                        <span className={`${ui.secundaria} ${ui.mono}`}>{l.numeroComprobante}</span>
                      ) : null}
                    </span>
                  </th>
                  <td className={ui.numerica}>
                    <Coeficiente valor={l.coeficienteAplicado} nulo="—" />
                  </td>
                  {visibles.map((c, i) => (
                    <td
                      key={c.clave}
                      className={`${ui.numerica} ${i === 0 || c.grupo !== visibles[i - 1]?.grupo ? ui.separadorIzquierdo : ""}`}
                    >
                      <Cifra monto={c.valor(l)} nulo={c.nulo} signo={c.signo === true} />
                      {c.clave === "interesMora" && l.moraPendienteDefinicion ? (
                        <>
                          <br />
                          <span className={estilos.pendiente}>sin tasa</span>
                        </>
                      ) : null}
                      {c.clave === "interesMora" && l.diasAtraso !== null ? (
                        <>
                          <br />
                          <span className={ui.secundaria}>{l.diasAtraso} días</span>
                        </>
                      ) : null}
                    </td>
                  ))}
                  <td className={`${ui.numerica} ${ui.columnaTotal} ${ui.principal}`}>
                    <Cifra monto={l.total} nulo="—" />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className={ui.columnaAncla}>
                  {grilla.liquidaciones.length} unidades
                </th>
                <td className={ui.numerica}>
                  <span className={ui.secundaria}>no se suma</span>
                </td>
                {visibles.map((c, i) => (
                  <td
                    key={c.clave}
                    className={`${ui.numerica} ${i === 0 || c.grupo !== visibles[i - 1]?.grupo ? ui.separadorIzquierdo : ""}`}
                  >
                    <Cifra monto={c.total} nulo="—" signo={c.signo === true} />
                  </td>
                ))}
                <td className={`${ui.numerica} ${ui.columnaTotal}`}>
                  <Cifra monto={grilla.totales.total} nulo="—" />
                </td>
              </tr>
            </tfoot>
          </Tabla>
        </MarcoTabla>
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
