import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { leerPeriodo } from "@admin-barrios/data/servicios/periodos";
import type { EstadoPeriodo } from "@admin-barrios/shared/liquidacion";
import { listarLiquidaciones } from "@admin-barrios/data/servicios/liquidaciones";
import { listarAplicaciones } from "@admin-barrios/data/servicios/cargos";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { IconoBorrador } from "../../../../../../componentes/iconos.tsx";
import { EncabezadoDePagina, Nota, Pagina, Panel, PilaDeNotas, Vacio } from "../../../../../../componentes/ui.tsx";
import {
  ESTADO_PERIODO_COMO_HECHO,
  ESTADO_PERIODO_QUE_SIGNIFICA,
  EstadoDelPeriodo,
} from "../../../../../../componentes/etiquetas.tsx";
import { esIdValido, rutasDelPeriodo, salidasDelPeriodo } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { FrentesDelPeriodo } from "../pasos.tsx";
import { ColumnasOcultas, columnasDe, GrillaDeLiquidaciones, visiblesDe } from "../grilla.tsx";
import { BotonGenerarBorrador, FormularioDeEmision } from "./formularios.tsx";
import estilos from "./revision.module.css";

export const metadata: Metadata = { title: "Revisar y emitir" };

/** Techo de la grilla. Mismo criterio que el resumen del período: un barrio normal entra entero. */
const POR_PAGINA = 500;

/**
 * **Paso 3 del recorrido: cómo queda cada boleta, y recién después el botón que no se deshace.**
 *
 * El orden de la pantalla es el orden de la decisión, y no es negociable:
 *
 * 1. **generar el borrador** — hasta que no exista, no hay nada que revisar;
 * 2. **lo que hay que mirar antes de emitir** — lo que quedó marcado, cada cosa con su denominador;
 * 3. **la grilla por unidad** — una fila por boleta, en el mismo orden en que salen;
 * 4. **emitir** — al final de todo, después de haber pasado por lo anterior.
 *
 * El botón de emitir está **abajo a propósito**. Ponerlo arriba, al lado del título, lo dejaría al
 * alcance de un click antes de que la persona haya visto una sola cifra — y el error más caro del
 * dominio es emitir el período equivocado.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTA PANTALLA NO HACE: DICTAMINAR
 *
 * No dice "cierra" ni "no cierra", y no habilita ni deshabilita el botón según su propia cuenta. Esa
 * conclusión depende del modelo del período y de reglas que viven en `app.validar_emision`; una regla
 * de negocio escrita en un componente es exactamente lo que el ADR-0002 §5.2 prohíbe y lo que ningún
 * test puede detectar. Lo que hace es **poner las cifras y las marcas a la vista, con su origen**,
 * para que la persona que sabe pueda decidir — y dejar que la base rechace si algo no da.
 */
export default async function Revision({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();

  const datos = await conSesion(async (tx) => {
    const periodo = await leerPeriodo(tx, { periodoId });
    if (!periodo) return { periodo: null, grilla: null, unidadesActivas: 0, sinResolver: 0 };
    const grilla = await listarLiquidaciones(tx, { periodoId, limite: POR_PAGINA, desplazamiento: 0 });
    const barrio = await leerBarrio(tx, { barrioId: periodo.barrioId });
    const aplicaciones = await listarAplicaciones(tx, { periodoId });
    return {
      periodo,
      grilla,
      unidadesActivas: barrio?.unidadesActivas ?? 0,
      // Cargos vigentes a los que el cálculo todavía no les puso importe. Si quedan después de
      // generar el borrador, es una señal: el reparto no los alcanzó.
      sinResolver: aplicaciones.filter((a) => a.anuladoAt === null && a.importeResuelto === null).length,
    };
  });

  if (!datos.periodo || !datos.grilla || datos.periodo.barrioId !== barrioId) notFound();
  const { periodo, grilla, unidadesActivas, sinResolver } = datos;

  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const salidas = salidasDelPeriodo(barrioId, periodoId);
  const mes = formatearPeriodo(periodo.periodo);

  const hayLiquidaciones = grilla.total > 0;
  // Las mismas columnas que el resumen del período, de la misma definición: dos listas de columnas
  // para las mismas cifras divergen siempre, y la primera versión de esta pantalla lo demostró
  // mostrando una fila de ceros con un total de $9.562,10 (ver `grilla.tsx`).
  const { visibles, ocultasEnCero, ocultasSinDato } = visiblesDe(grilla, columnasDe(grilla, periodo.modelo));
  const sinActa = periodo.gastos.filter((g) => g.sinRespaldoAsamblea);
  const faltanUnidades = hayLiquidaciones && grilla.total !== unidadesActivas;
  const paginaCompleta = grilla.liquidaciones.length === grilla.total;

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo={
          <span className={estilos.identidad}>
            Revisar y emitir <span className={estilos.mes}>{mes}</span>
            <EstadoDelPeriodo estado={periodo.estado} editable={periodo.editable} />
          </span>
        }
        bajada={
          <>
            {periodo.barrioNombre} · {ESTADO_PERIODO_QUE_SIGNIFICA[periodo.estado]}. Cada fila de la
            grilla es una boleta: lo que se ve acá es lo que va a recibir esa unidad.
          </>
        }
      />

      <FrentesDelPeriodo barrioId={barrioId} periodoId={periodoId} />

      {/* ── 1 · Generar el borrador ────────────────────────────────────────────────────────── */}

      {periodo.editable ? (
        <Panel
          titulo={hayLiquidaciones ? "Volver a calcular" : "Generar el borrador"}
          origen="Reparte los gastos del período entre las unidades según la versión de coeficientes cerrada y vigente del barrio, y resuelve el importe de cada cargo y descuento."
        >
          <BotonGenerarBorrador
            periodoId={periodoId}
            yaHayLiquidaciones={hayLiquidaciones}
            salidas={salidas}
          />
        </Panel>
      ) : null}

      {/* ── 2 · Lo que hay que mirar antes ─────────────────────────────────────────────────── */}

      <PilaDeNotas>
        {/*
          Dos cosas que este aviso decía mal, las dos detectadas por el usuario mirando la pantalla:

          · **"en el paso anterior"** era lenguaje del recorrido numerado que ya no existe. Los
            frentes no tienen orden entre sí, así que "anterior" no señala nada.
          · **"esperando a que se reparta"** es falso en un barrio de **cuota fija**: los gastos no se
            reparten, no determinan lo que se cobra, y el borrador se genera igual sin ellos. Es el
            mismo error que el rótulo "Prorrateo del mes" — texto escrito pensando solo en el modelo
            variable.
        */}
        {!hayLiquidaciones ? (
          <Nota tono="alerta" titulo="Todavía no hay nada que revisar.">
            Este período no tiene liquidaciones generadas: nadie tiene su importe calculado.{" "}
            {periodo.modelo === "fija" ? (
              <>
                En este barrio cada unidad paga la <strong>cuota fija</strong> que fijó el directorio,
                así que el borrador se puede generar ya. Los {periodo.gastos.length} gastos{" "}
                <Link href={rutas.gastos}>cargados</Link> se registran para la rendición y para fijar
                la cuota siguiente — no cambian lo que se cobra este mes.
              </>
            ) : (
              <>
                Los {periodo.gastos.length} gastos <Link href={rutas.gastos}>cargados</Link> todavía no
                se repartieron entre las unidades.
              </>
            )}
          </Nota>
        ) : null}

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
            {sinActa.map((g) => g.descripcion).join(" · ")}.{" "}
            <Link href={rutas.gastos}>Ver los gastos</Link>.
          </Nota>
        ) : null}

        {sinResolver > 0 ? (
          <Nota tono="alerta" titulo={`${sinResolver} cargos vigentes quedaron sin importe resuelto.`}>
            Después de generar el borrador, un cargo sin importe significa que el cálculo no lo
            alcanzó — por ejemplo, porque su unidad no quedó liquidada.{" "}
            <Link href={rutas.cargos}>Ver los cargos</Link>.
          </Nota>
        ) : null}

        {faltanUnidades ? (
          <Nota
            tono="info"
            titulo={`Hay ${grilla.total} liquidaciones y ${unidadesActivas} unidades activas en el padrón.`}
          >
            La diferencia es esperable si el padrón cambió después de liquidar: el cálculo se hizo
            contra las unidades que estaban activas en ese momento. Si no cambió nada, volvé a generar
            el borrador.
          </Nota>
        ) : null}

        {!paginaCompleta ? (
          <Nota tono="info" titulo="La grilla muestra las primeras 500 liquidaciones del período.">
            Se están viendo {grilla.liquidaciones.length} de {grilla.total}. Los totales del pie son de
            lo que se ve, no del período entero.
          </Nota>
        ) : null}

        {hayLiquidaciones &&
        grilla.conMoraPendiente === 0 &&
        sinActa.length === 0 &&
        sinResolver === 0 &&
        !faltanUnidades ? (
          <Nota tono="exito" titulo="No quedan pendientes registrados en este período.">
            Ni unidades con la mora sin definir, ni gastos extraordinarios sin respaldo de asamblea, ni
            cargos sin resolver, ni diferencia entre las liquidaciones y las unidades activas del
            padrón.
          </Nota>
        ) : null}
      </PilaDeNotas>

      {/* ── 3 · La grilla ──────────────────────────────────────────────────────────────────── */}

      <Panel
        titulo="Cómo queda cada boleta"
        origen={
          <>
            Orden por manzana y lote — <strong>el mismo con el que salen las boletas</strong>: la fila
            37 de esta grilla es la boleta 37 del lote. Cada columna es un subtotal que el cálculo ya
            escribió en la liquidación —acá no se suma nada, se muestra— y están{" "}
            <strong>todas</strong>: si el total de una fila no se explicara con las columnas que se
            ven, es un bug. Para compararlo contra los gastos cargados está el{" "}
            <Link href={rutas.resumen}>resumen del período</Link>.
          </>
        }
        sinRelleno
        pie={
          hayLiquidaciones ? (
            <>
              <ColumnasOcultas enCero={ocultasEnCero} sinDato={ocultasSinDato} />
              El total de cada fila es el que la base escribió en esa liquidación, no la suma de las
              columnas de esta pantalla: si no coincidieran, gana el de la base y hay un bug para
              reportar.
            </>
          ) : undefined
        }
      >
        {!hayLiquidaciones ? (
          <Vacio icono={<IconoBorrador />} titulo="Todavía no se generó el borrador">
            Sin liquidaciones no hay boletas que revisar. El botón de arriba las genera.
          </Vacio>
        ) : (
          <GrillaDeLiquidaciones grilla={grilla} visibles={visibles} />
        )}
      </Panel>

      {/* ── 4 · Emitir ─────────────────────────────────────────────────────────────────────── */}

      {/*
        `totalACobrar` va en `null` cuando la página **no cubre el período entero**, y es la corrección
        más importante de esta pantalla.

        `grilla.totales` es de las liquidaciones traídas, no del período. Con más de 500 unidades, ese
        número al lado de "Boletas que quedan emitidas" —que sí es el conteo completo— presenta **dos
        hechos distintos como si fueran uno**, y lo hace arriba del botón que no se deshace. Antes que
        una cifra que puede ser falsa, no hay cifra: el formulario dice que no la puede mostrar desde
        acá y por qué.
      */}
      <Emision
        periodo={periodo}
        periodoId={periodoId}
        mes={mes}
        totalACobrar={hayLiquidaciones && paginaCompleta ? grilla.totales.total : null}
        totalIncompleto={hayLiquidaciones && !paginaCompleta}
        unidades={grilla.total}
        salidas={salidas}
      />
    </Pagina>
  );
}


/**
 * El panel de emisión, con **los cuatro desenlaces distintos** que hay que separar. Mostrar el mismo
 * cartel en los cuatro casos manda a buscar el problema donde no está:
 *
 * · ya emitido → no hay nada que apretar, se muestra la firma;
 * · sin liquidaciones → el botón no tendría qué emitir;
 * · rol de solo lectura → el botón existiría y rebotaría con "no tenés permiso", que es peor que no
 *   dibujarlo: `puedeEmitir` lo resuelve la base con `app.has_role_on`, no esta pantalla;
 * · todo lo demás → el formulario, con la ceremonia.
 */
function Emision({
  periodo,
  periodoId,
  mes,
  totalACobrar,
  totalIncompleto,
  unidades,
  salidas,
}: {
  readonly periodo: {
    readonly editable: boolean;
    readonly estado: EstadoPeriodo;
    readonly puedeEmitir: boolean;
    readonly barrioNombre: string;
    readonly emitidaAt: string | null;
  };
  readonly periodoId: string;
  readonly mes: string;
  readonly totalACobrar: string | null;
  /** La grilla no cubre el período entero, así que no hay un total del período que mostrar. */
  readonly totalIncompleto: boolean;
  readonly unidades: number;
  readonly salidas: ReturnType<typeof salidasDelPeriodo>;
}) {
  if (!periodo.editable) {
    return (
      <Panel titulo="Emisión" origen="El sello lo escribió la base al emitir, desde la identidad de la sesión.">
        <Nota tono="exito" titulo={`Este período ya ${ESTADO_PERIODO_COMO_HECHO[periodo.estado]}.`}>
          Quedó inmutable: no se le cargan más gastos, no se aplican ni se anulan cargos, y el
          borrador no se puede volver a generar. Si hace falta corregir algo, se registra en el
          período siguiente.
          {periodo.emitidaAt ? (
            <>
              {" "}
              Emitido el <code className={estilos.sello}>{periodo.emitidaAt}</code>.
            </>
          ) : null}
        </Nota>
      </Panel>
    );
  }

  if (unidades === 0) {
    return (
      <Panel titulo="Emisión">
        <Nota tono="info" titulo="Todavía no hay nada que emitir.">
          Primero hay que generar el borrador: emitir un período sin liquidaciones no produciría
          ninguna boleta.
        </Nota>
      </Panel>
    );
  }

  if (!periodo.puedeEmitir) {
    return (
      <Panel titulo="Emisión">
        <Nota tono="info" titulo="Tu rol en este barrio no emite.">
          Emitir es de un administrador del barrio o de un operador. Si tu rol es de solo lectura
          —contador o auditor— podés revisar todo lo de arriba, pero la emisión la tiene que hacer
          quien administra el barrio.
        </Nota>
      </Panel>
    );
  }

  return (
    <Panel
      titulo="Emitir el período"
      origen="Las cifras son las de la grilla de arriba, que es la que la base acaba de calcular. Al emitir, la base vuelve a validar el cierre antes de aceptar."
    >
      <FormularioDeEmision
        periodoId={periodoId}
        barrioNombre={periodo.barrioNombre}
        mes={mes}
        unidades={unidades}
        totalACobrar={totalACobrar}
        totalIncompleto={totalIncompleto}
        salidas={salidas}
      />
    </Panel>
  );
}
