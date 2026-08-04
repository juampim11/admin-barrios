import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { leerPeriodo, type DetallePeriodo, type GastoDelPeriodo } from "@admin-barrios/data/servicios/periodos";
import { listarLiquidaciones, type GrillaLiquidaciones } from "@admin-barrios/data/servicios/liquidaciones";
import { listarAplicaciones, type AplicacionDeLista } from "@admin-barrios/data/servicios/cargos";
import { restarMontos, sumarMontos } from "@admin-barrios/shared/dinero";
import {
  estadoDelCierre,
  type DestinoDeAccion,
  type EstadoDelCierre,
  type SituacionDelCierre,
} from "@admin-barrios/shared/liquidacion";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { Boton, FichaDeCierre, FrenteDeCierre, IconoFlecha, IconoMas } from "@admin-barrios/ui";
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
import { esIdValido, rutasDelPeriodo } from "../../../../../rutas.ts";
import {
  ColumnasOcultas,
  columnasDe,
  delGrupo,
  GRUPOS,
  GrillaDeLiquidaciones,
  tituloDelReparto,
  visiblesDe,
  type Columna,
} from "./grilla.tsx";
import { conSesion } from "../../../../../servidor/db.ts";
import { BarraDeVuelta } from "./pasos.tsx";
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
  // Llega de `crearPeriodoAction`, que ahora aterriza acá y no en el paso 1 (observación A-3).
  const recienCreado = crudos["creado"] === "1";

  // Las tres lecturas van en UNA transacción y secuenciales: `node-postgres` encola las consultas de
  // un mismo client, así que un `Promise.all` acá no paralelizaría nada — solo daría a entender que
  // sí. El barrio se lee para tener el denominador (cuántas unidades activas hay) contra el que
  // comparar la cantidad de liquidaciones.
  const datos = await conSesion(async (tx) => {
    const periodo = await leerPeriodo(tx, { periodoId });
    if (!periodo) return { periodo: null, grilla: null, barrio: null, aplicaciones: [] };
    const grilla = await listarLiquidaciones(tx, {
      periodoId,
      limite: POR_PAGINA,
      desplazamiento: (pagina - 1) * POR_PAGINA,
    });
    const barrio = await leerBarrio(tx, { barrioId: periodo.barrioId });
    // Las aplicaciones de cargo/descuento se leen acá y no en la pantalla de cargos: son la mitad de
    // la preparación del mes, y sin ellas el resumen no puede contestar si se puede emitir — una
    // aplicación sin resolver es el bloqueo más frecuente y hoy era **invisible** hasta el error de
    // Postgres. Ver `docs/producto/relevamiento-liquidacion.md` §2.
    const aplicaciones = await listarAplicaciones(tx, { periodoId });
    return { periodo, grilla, barrio, aplicaciones };
  });

  // `notFound()` afuera de la transacción (ADR-0002 §3.1). La segunda condición no es autorización
  // —ésa la hizo la RLS— sino coherencia de la URL: un período de otro barrio bajo este segmento
  // mostraría una cabecera que no corresponde a lo que se está mirando.
  if (!datos.periodo || !datos.grilla || !datos.barrio || datos.periodo.barrioId !== barrioId) notFound();
  const periodo = datos.periodo;
  const grilla = datos.grilla;
  const barrio = datos.barrio;
  const unidadesActivas = barrio.unidadesActivas;
  const aplicaciones = datos.aplicaciones;

  const paginas = Math.max(1, Math.ceil(grilla.total / POR_PAGINA));
  if (pagina > paginas) redirect(`/${barrioId}/liquidacion/${periodoId}?pagina=${paginas}`);

  // Una sola definición de las columnas para el panel de cierre y para la grilla (ver `columnasDe`).
  const columnas = columnasDe(grilla);

  const rutas = rutasDelPeriodo(barrioId, periodoId);

  const vigentes = aplicaciones.filter((a) => a.anuladoAt === null);
  /**
   * En qué punto está el cierre del mes, qué lo bloquea y qué se puede hacer.
   *
   * **Toda la decisión vive en `@admin-barrios/shared/liquidacion`**, con sus tests. Acá solo se
   * juntan los hechos y se los muestra. Es la corrección de fondo del relevamiento del 2026-08-04:
   * la versión anterior devolvía "el paso siguiente" desde la pantalla, y por eso podía ofrecer
   * emitir cuando la emisión estaba garantizada a fallar.
   */
  const cierre = estadoDelCierre({
    estado: periodo.estado,
    editable: periodo.editable,
    modelo: periodo.modelo,
    puedeEmitir: periodo.puedeEmitir,
    cantidadGastos: periodo.gastos.length,
    cantidadLiquidaciones: grilla.total,
    unidadesActivas,
    aplicacionesVigentes: vigentes.length,
    aplicacionesSinResolver: vigentes.filter((a) => a.importeResuelto === null).length,
    tieneCoeficientesVigentes: barrio.tieneCoeficientesVigentes,
    cuotaFijaVersionId: periodo.cuotaFijaVersionId,
    // El borrador es un nodo **derivado**: si lo cargado hoy no coincide con lo que se escribió al
    // generarlo, las liquidaciones están calculadas con el importe viejo.
    gastosCambiaronDespuesDelBorrador:
      periodo.totalGastos !== null && restarMontos(periodo.totalGastosCargados, periodo.totalGastos) !== "0.00",
  });

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

      <BarraDeVuelta barrioId={barrioId} periodoId={periodoId} />

      <ParaCerrar
        cierre={cierre}
        mes={formatearPeriodo(periodo.periodo)}
        periodo={periodo}
        grilla={grilla}
        aplicacionesVigentes={vigentes.length}
        rutas={rutas}
        padronHref={`/${barrioId}/padron`}
      />

      {recienCreado ? (
        <Nota tono="exito" titulo={`El período ${formatearPeriodo(periodo.periodo)} quedó creado.`}>
          Nació en borrador: se puede editar, cargar gastos y regenerar el cálculo tantas veces como
          haga falta. Esta pantalla es el resumen del mes; el trabajo empieza en{" "}
          <Link href={`/${barrioId}/liquidacion/${periodoId}/gastos`}>cargar los gastos</Link>.
        </Nota>
      ) : null}

      <Cierre periodo={periodo} grilla={grilla} columnas={columnas} />
      <Pendientes periodo={periodo} grilla={grilla} hayBloqueos={cierre.bloqueos.length > 0} />
      <Gastos periodo={periodo} rutas={rutas} />
      <CargosDelPeriodo aplicaciones={aplicaciones} editable={periodo.editable} rutas={rutas} />
      <Liquidaciones
        periodo={periodo}
        grilla={grilla}
        todas={columnas}
        rutas={rutas}
        ruta={`/${barrioId}/liquidacion/${periodoId}`}
        pagina={pagina}
        paginas={paginas}
      />
    </Pagina>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 1.bis · Por dónde sigue el mes
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** El estado del mes en una línea, para la cabecera de la ficha. */
const RESUMEN_DE_SITUACION: Record<SituacionDelCierre, string> = {
  preparando: "todavía falta preparar el mes",
  listoParaGenerar: "listo para generar el borrador",
  borradorDesactualizado: "el borrador quedó desactualizado",
  listoParaEmitir: "listo para revisar y emitir",
  emitido: "emitido · ya no se edita",
  distribuido: "emitido y distribuido",
};

/**
 * **La ficha de cierre: qué le falta a este mes.**
 *
 * Reemplaza al recorrido de cuatro cajas y al panel «Por dónde sigue el mes», que eran dos
 * componentes contestando la misma pregunta y contradiciéndose a la vista. El relevamiento del
 * 2026-08-04 (`docs/producto/relevamiento-liquidacion.md`) lo desarmó: el mes no es una escalera de
 * cuatro escalones sino dos frentes que se llenan todo el mes y un cierre de tres momentos.
 *
 * **Los dos frentes se ofrecen siempre** mientras el período admita cambios, incluso cuando ya está
 * todo listo para emitir. Es lo que el usuario pedía textual: *"no me ofrece o me dice que el paso
 * natural también es cargar un «Cargo o descuento»"*. Nunca son la acción principal —no son un
 * paso— y nunca están ausentes —son frentes abiertos—.
 *
 * Acá no se decide nada: la situación, los bloqueos y la acción vienen resueltos de
 * `@admin-barrios/shared/liquidacion`.
 */
function ParaCerrar({
  cierre,
  mes,
  periodo,
  grilla,
  aplicacionesVigentes,
  rutas,
  padronHref,
}: {
  readonly cierre: EstadoDelCierre;
  readonly mes: string;
  readonly periodo: DetallePeriodo;
  readonly grilla: GrillaLiquidaciones;
  readonly aplicacionesVigentes: number;
  readonly rutas: ReturnType<typeof rutasDelPeriodo>;
  readonly padronHref: string;
}) {
  const destinoHref = (destino: DestinoDeAccion): string => (destino === "padron" ? padronHref : rutas[destino]);
  const abierto = (frente: "gastos" | "cargos") => cierre.frentesAbiertos.includes(frente);

  /** El botón grande de la pantalla. Va en la fila del frente al que manda, no suelto arriba. */
  const principal = (
    <Boton
      href={destinoHref(cierre.accion.destino)}
      variante="primario"
      iconoAlFinal={<IconoFlecha direccion="derecha" />}
    >
      {cierre.accion.verbo}
    </Boton>
  );
  const principalEn = (destino: DestinoDeAccion) => (cierre.accion.destino === destino ? principal : undefined);

  return (
    <>
      <FichaDeCierre titulo={`Para cerrar ${mes}`} resumen={RESUMEN_DE_SITUACION[cierre.situacion]}>
        <FrenteDeCierre
          estado={cierre.frentes.gastos}
          numero={1}
          titulo="Gastos del mes"
          evidencia={
            periodo.gastos.length > 0 ? (
              <>
                {periodo.gastos.length} {periodo.gastos.length === 1 ? "gasto cargado" : "gastos cargados"} ·{" "}
                <Cifra monto={periodo.totalGastosCargados} nulo="—" />
              </>
            ) : periodo.modelo === "fija" ? (
              "Este barrio cobra cuota fija: los gastos se registran para el libro, no determinan lo que se cobra."
            ) : (
              "Todavía no se cargó ninguno. Sin gastos no hay nada que prorratear."
            )
          }
          accion={
            principalEn("gastos") ??
            (abierto("gastos") ? (
              <Boton href={rutas.gastos} tamano="sm" icono={<IconoMas />}>
                Cargar un gasto
              </Boton>
            ) : undefined)
          }
        />

        <FrenteDeCierre
          estado={cierre.frentes.cargos}
          numero={2}
          titulo="Cargos y descuentos"
          opcional
          evidencia={
            aplicacionesVigentes > 0
              ? `${aplicacionesVigentes} ${aplicacionesVigentes === 1 ? "aplicado" : "aplicados"} a unidades de este período.`
              : "Ninguno aplicado este mes — la mayoría de los meses no lleva."
          }
          accion={
            abierto("cargos") ? (
              <Boton href={rutas.cargos} tamano="sm" icono={<IconoMas />}>
                Aplicar un cargo
              </Boton>
            ) : undefined
          }
        />

        <FrenteDeCierre
          estado={cierre.frentes.revision}
          numero={3}
          titulo="Revisar y emitir"
          evidencia={
            grilla.total === 0
              ? "Todavía no se generó el borrador: nadie tiene su importe calculado."
              : `Borrador generado con ${grilla.total} ${grilla.total === 1 ? "liquidación" : "liquidaciones"}.`
          }
          accion={
            principalEn("revision") ??
            (grilla.total > 0 ? (
              <Boton href={rutas.revision} tamano="sm">
                Ver la revisión
              </Boton>
            ) : undefined)
          }
        />

        <FrenteDeCierre
          estado={cierre.frentes.documentos}
          numero={4}
          titulo="Boletas"
          evidencia={
            periodo.editable
              ? "Se generan cuando el período esté emitido."
              : "El período está emitido: las boletas se pueden generar y descargar."
          }
          accion={principalEn("documentos")}
        />

        {cierre.accion.destino === "padron" ? (
          <FrenteDeCierre
            estado="falta"
            numero={0}
            titulo="El padrón del barrio"
            evidencia={cierre.accion.porque}
            accion={principal}
          />
        ) : null}
      </FichaDeCierre>

      {/*
        Los bloqueos, con la cifra concreta y qué los levanta. Cada uno es la contracara de una
        verificación de `app.validar_emision`: antes de esto, la persona los descubría como un error
        de Postgres **después** de apretar Emitir.
      */}
      {cierre.bloqueos.length > 0 ? (
        <PilaDeNotas>
          {cierre.bloqueos.map((bloqueo) => (
            <Nota key={bloqueo.clave} tono="alerta" titulo={bloqueo.que}>
              {bloqueo.como}
            </Nota>
          ))}
        </PilaDeNotas>
      ) : null}

      <p className={ui.secundaria}>{cierre.accion.porque}</p>
    </>
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
          etiqueta={tituloDelReparto(periodo.modelo)}
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
          origen={`${tituloDelReparto(periodo.modelo).toLowerCase()} más los ajustes de cada unidad y lo que viene de antes`}
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
 * Los **avisos**: cosas que condicionan el mes y **no** bloquean la emisión.
 *
 * `conMoraPendiente` sale de un `count(*) filter` sobre el período entero y no de contar el arreglo
 * devuelto: una alerta que solo mira la página subcuenta en silencio justo en el barrio grande, que
 * es donde más caro sale.
 *
 * **La diferencia entre liquidaciones y unidades activas dejó de estar acá**, y no es un movimiento
 * cosmético: **es un bloqueo duro de la emisión** —`app.validar_emision` lo rechaza— y estaba escrito
 * como una nota `info` que decía *"la diferencia es esperable"*. El texto era correcto sobre la causa
 * y falso sobre la consecuencia. Ahora vive con los demás bloqueos, arriba, y esta pila se queda
 * únicamente con lo que **no** impide emitir.
 */
function Pendientes({
  periodo,
  grilla,
  hayBloqueos,
}: {
  readonly periodo: DetallePeriodo;
  readonly grilla: GrillaLiquidaciones;
  /** Si hay algo que impide emitir, la nota verde no puede aparecer. */
  readonly hayBloqueos: boolean;
}) {
  const sinActa = periodo.gastos.filter((g) => g.sinRespaldoAsamblea);

  // Sin liquidaciones no hay nada que declarar en orden: los controles miran liquidaciones y dan
  // cero por vacío. Un período recién creado mostraba en verde "no quedan pendientes", que es falso
  // de forma verificable.
  if (grilla.total === 0) return null;

  /*
    La nota verde solo aparece **sin bloqueos y sin avisos**. Antes cubría 3 de las ~12 condiciones
    que la base verifica antes de emitir y se leía como "podés emitir": seguridad falsa sobre una
    acción irreversible. Y por eso ahora dice lo que mira, con esas palabras — un cartel verde que no
    declara su alcance es un cartel que promete de más.
  */
  if (!hayBloqueos && grilla.conMoraPendiente === 0 && sinActa.length === 0) {
    return (
      <Nota tono="exito" titulo="No hay nada que impida emitir este período.">
        Ni unidades con la mora sin definir, ni gastos extraordinarios sin respaldo de asamblea, ni
        nada de lo que la base verifica antes de emitir. Emitir sigue siendo irreversible.
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

    </PilaDeNotas>
  );
}

/**
 * **Los cargos y descuentos del período.** Este panel no existía, y su ausencia era la mitad del
 * problema que el usuario marcó: el resumen mostraba los gastos con su acción al lado y de los
 * cargos no decía nada. Un frente cuyo resultado no aparece en el resumen del mes es un frente que
 * el resumen no reconoce como parte del mes.
 *
 * **El vacío no se disculpa: explica.** «Ninguno este mes» es lo normal y así se dice, con ejemplos
 * de qué entra acá — porque quien no sabe qué es un cargo, al leer "quincho, invitados, bonificación"
 * ya sabe si le toca.
 */
function CargosDelPeriodo({
  aplicaciones,
  editable,
  rutas,
}: {
  readonly aplicaciones: readonly AplicacionDeLista[];
  readonly editable: boolean;
  readonly rutas: ReturnType<typeof rutasDelPeriodo>;
}) {
  const vigentes = aplicaciones.filter((a) => a.anuladoAt === null);
  const sinResolver = vigentes.filter((a) => a.importeResuelto === null).length;

  return (
    <Panel
      titulo="Cargos y descuentos del período"
      origen={
        <>
          Se cobran o se descuentan a <strong>una</strong> unidad, no al barrio. El importe se resuelve
          al generar el borrador: hasta entonces la fila existe y su monto todavía no.
        </>
      }
      acciones={
        editable ? (
          <Boton href={rutas.cargos} tamano="sm" icono={<IconoMas />}>
            Aplicar un cargo
          </Boton>
        ) : undefined
      }
      sinRelleno
      pie={
        sinResolver > 0
          ? `${sinResolver} sin resolver contra el borrador: hasta que se regenere, el período no se puede emitir.`
          : undefined
      }
    >
      {vigentes.length === 0 ? (
        <Vacio icono={<IconoBorrador />} titulo="Este mes no se aplicó ninguno — es lo normal">
          Acá van las cosas que se le cobran o se le descuentan a una unidad en particular: el uso del
          quincho, invitados de más, una multa del reglamento, o una bonificación por pago en término.
        </Vacio>
      ) : (
        <MarcoTabla etiqueta="Cargos y descuentos aplicados en el período">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Unidad
                </th>
                <th scope="col">Concepto</th>
                <th scope="col">Fecha del hecho</th>
                <th scope="col" className={ui.numerica}>
                  Importe
                </th>
              </tr>
            </thead>
            <tbody>
              {vigentes.map((aplicacion) => (
                <tr key={aplicacion.id}>
                  <th scope="row" className={ui.columnaAncla}>
                    MZ {aplicacion.manzana} — LOTE {aplicacion.lote}
                  </th>
                  <td>
                    <span className={estilos.gasto}>
                      <span>{aplicacion.nombreConcepto}</span>
                      <span className={ui.secundaria}>
                        {aplicacion.clase === "cargo" ? "Cargo" : "Descuento"} · {aplicacion.detalle}
                      </span>
                    </span>
                  </td>
                  <td>{formatearFecha(aplicacion.fechaHecho)}</td>
                  <td className={ui.numerica}>
                    <Cifra monto={aplicacion.montoResuelto} nulo="al generar el borrador" signo />
                  </td>
                </tr>
              ))}
            </tbody>
          </Tabla>
        </MarcoTabla>
      )}
    </Panel>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 4 · Los gastos
// ────────────────────────────────────────────────────────────────────────────────────────────────

function Gastos({
  periodo,
  rutas,
}: {
  readonly periodo: DetallePeriodo;
  readonly rutas: ReturnType<typeof rutasDelPeriodo>;
}) {
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
      /*
        La acción vive **al lado de lo que muestra**. Ver los gastos acá y tener que subir al
        recorrido para cargar uno era el hueco que marcó el usuario: la pantalla enseñaba algo sobre
        lo que no dejaba actuar. Si el período ya no admite cambios, el botón no está —no apagado,
        ausente (doc 06 §c.6.4)—.
      */
      acciones={
        periodo.editable ? (
          <Boton href={rutas.gastos} tamano="sm" icono={<IconoMas />}>
            Cargar un gasto
          </Boton>
        ) : undefined
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
  rutas,
  ruta,
  pagina,
  paginas,
}: {
  readonly periodo: DetallePeriodo;
  readonly grilla: GrillaLiquidaciones;
  readonly todas: readonly Columna[];
  readonly rutas: ReturnType<typeof rutasDelPeriodo>;
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
      acciones={
        <Boton href={rutas.revision} tamano="sm" iconoAlFinal={<IconoFlecha direccion="derecha" />}>
          {periodo.editable ? "Revisar y emitir" : "Ver la revisión"}
        </Boton>
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
