import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { leerBarrio, type DetalleBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarPeriodos, type PeriodoDeLista } from "@admin-barrios/data/servicios/periodos";
import {
  faltantesParaViaEjecutiva,
  type Adecuacion2075,
  type FiguraJuridica,
} from "@admin-barrios/shared/barrio";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { IconoCorrecto, IconoFaltante, IconoFlecha, IconoInfo } from "../../../../componentes/iconos.tsx";
import {
  Cifra,
  Definicion,
  Definiciones,
  Desplegable,
  EncabezadoDePagina,
  Nota,
  Pagina,
  Panel,
} from "../../../../componentes/ui.tsx";
import {
  EstadoDelPeriodo,
  etiquetaAdecuacion,
  etiquetaEncuadre,
  etiquetaFigura,
  etiquetaModelo,
  etiquetaServiciosInternos,
  etiquetaTitularidad,
} from "../../../../componentes/etiquetas.tsx";
import { esIdValido } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import estilos from "./tablero.module.css";

export const metadata: Metadata = { title: "Tablero" };

/**
 * La ficha del barrio, ordenada alrededor de una sola pregunta: **¿este barrio está en condiciones
 * de liquidar el mes?**
 *
 * Por eso arriba de todo va un semáforo de tres puestos —coeficientes, tasa de mora, padrón— y no la
 * ficha jurídica: los diez campos del encuadre legal importan una vez por año y la versión de
 * coeficientes cerrada importa todos los meses. La ficha va abajo y colapsada, que es donde va lo
 * que se consulta y no se vigila.
 *
 * Las dos lecturas viajan en **una** transacción: el detalle del barrio y sus períodos.
 */
export default async function Tablero({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  // El layout hace el mismo chequeo, y hace falta en los dos: el App Router renderiza layout y página
  // **en paralelo**, así que un segmento sin forma de id llegaría igual al `parse()` del servicio.
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    periodos: await listarPeriodos(tx, { barrioId }),
  }));

  // `notFound()` afuera de la transacción, siempre: adentro dispararía un ROLLBACK (ADR-0002 §3.1).
  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const periodos = datos.periodos;
  const ultimo = periodos[0];

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Tablero"
        bajada={`${barrio.nombre} · ${etiquetaFigura(barrio.figuraJuridica)}. Lo que hay que mirar antes de liquidar el mes.`}
      />

      <Panel
        titulo="¿Se puede liquidar?"
        origen="tres condiciones que la base verifica al generar el borrador; acá se ven antes de intentarlo"
      >
        <div className={estilos.semaforo}>
          <Puesto
            etiqueta="Versión de coeficientes"
            estado={barrio.tieneCoeficientesVigentes ? "ok" : "falta"}
            valor={barrio.tieneCoeficientesVigentes ? "Cerrada y vigente" : "Sin versión cerrada"}
            porque={
              barrio.tieneCoeficientesVigentes
                ? "es la que se aplica al prorratear"
                : "sin una versión cerrada y vigente no se puede prorratear"
            }
          />
          <Puesto
            etiqueta="Tasa de mora"
            estado={barrio.tieneTasaMoraVigente ? "ok" : "falta"}
            valor={barrio.tieneTasaMoraVigente ? "Vigente" : "Sin tasa vigente"}
            porque={
              barrio.tieneTasaMoraVigente
                ? "el interés se calcula con esta tasa"
                : "la liquidación sale con la mora pendiente de definición; el sistema no inventa una tasa"
            }
          />
          <Puesto
            etiqueta="Padrón"
            estado="neutro"
            valor={`${barrio.unidadesActivas} activas · ${barrio.unidadesDeBaja} de baja`}
            porque={`${barrio.unidadesActivas + barrio.unidadesDeBaja} unidades en el padrón. Las de baja siguen porque su deuda sigue existiendo (art. 2049).`}
          />
        </div>
      </Panel>

      <Panel
        titulo="Último período"
        origen={`de ${periodos.length} ${periodos.length === 1 ? "período cargado" : "períodos cargados"} en este barrio`}
        acciones={
          <Link href={`/${barrio.id}/liquidacion`} className={estilos.verTodos}>
            Ver todos los períodos
          </Link>
        }
      >
        {ultimo ? <UltimoPeriodo barrioId={barrio.id} periodo={ultimo} barrio={barrio} /> : (
          <Nota tono="neutro" titulo="Todavía no hay períodos cargados.">
            El primer período se crea desde la liquidación, y para poder generarlo el barrio necesita
            una versión de coeficientes cerrada y vigente.
          </Nota>
        )}
      </Panel>

      <Panel titulo="Ficha del barrio" origen="datos de encuadre: se consultan, no se vigilan">
        <Desplegable resumen="Ver la ficha jurídica y catastral">
          <Definiciones>
            <Definicion termino="Figura jurídica">{etiquetaFigura(barrio.figuraJuridica)}</Definicion>
            <Definicion termino="Adecuación art. 2075">{etiquetaAdecuacion(barrio.adecuadoArt2075)}</Definicion>
            <Definicion termino="Encuadre urbanístico">{etiquetaEncuadre(barrio.encuadreUrbanistico)}</Definicion>
            <Definicion termino="Servicios internos">
              {etiquetaServiciosInternos(barrio.serviciosInternosACargoDe)}
            </Definicion>
            <Definicion termino="Espacios comunes">
              {barrio.titularidadEspaciosComunes
                ? etiquetaTitularidad(barrio.titularidadEspaciosComunes)
                : "sin dato cargado"}
            </Definicion>
            <Definicion termino="Reglamento inscripto">{siNoSinDato(barrio.reglamentoInscripto)}</Definicion>
            <Definicion termino="Pacto de ejecutividad">{siNoSinDato(barrio.pactoEjecutividad)}</Definicion>
            <Definicion termino="Consejo">{barrio.tieneConsejo ? "Sí" : "No"}</Definicion>
            <Definicion termino="Fondo de reserva">{barrio.tieneFondoReserva ? "Sí" : "No"}</Definicion>
            <Definicion termino="CUIT">
              <span className="dinero">{barrio.cuit ?? "sin dato cargado"}</span>
            </Definicion>
            <Definicion termino="Domicilio de sede">{barrio.domicilioSede ?? "sin dato cargado"}</Definicion>
            <Definicion termino="Administrado por">
              {barrio.administrador?.nombre ?? "no visible con tu rol"}
            </Definicion>
          </Definiciones>
          <ViaEjecutiva barrio={barrio} />
        </Desplegable>
      </Panel>
    </Pagina>
  );
}

/** Un puesto del semáforo: ícono con forma propia + palabra + por qué importa. Nunca solo color. */
function Puesto({
  etiqueta,
  estado,
  valor,
  porque,
}: {
  readonly etiqueta: string;
  readonly estado: "ok" | "falta" | "neutro";
  readonly valor: string;
  readonly porque: ReactNode;
}) {
  const clase =
    estado === "ok" ? estilos.puestoOk : estado === "falta" ? estilos.puestoFalta : estilos.puestoNeutro;
  const icono = estado === "ok" ? <IconoCorrecto /> : estado === "falta" ? <IconoFaltante /> : <IconoInfo />;

  return (
    <div className={`${estilos.puesto} ${clase}`}>
      <span className={estilos.puestoIcono}>{icono}</span>
      <span className={estilos.datoTexto}>
        <span className={estilos.datoEtiqueta}>{etiqueta}</span>
        <span className={estilos.datoValor}>{valor}</span>
        <span className={estilos.datoOrigen}>{porque}</span>
      </span>
    </div>
  );
}

function UltimoPeriodo({
  barrioId,
  periodo,
  barrio,
}: {
  readonly barrioId: string;
  readonly periodo: PeriodoDeLista;
  readonly barrio: DetalleBarrio;
}) {
  return (
    <>
      <div className={estilos.ultimoPeriodo}>
        <span className={estilos.mes}>{formatearPeriodo(periodo.periodo)}</span>
        <EstadoDelPeriodo estado={periodo.estado} editable={periodo.editable} />
        <span className={estilos.datoTexto}>
          <span className={estilos.datoEtiqueta}>Gastos liquidados</span>
          <span className={estilos.datoValor}>
            <Cifra monto={periodo.totalGastos} nulo="todavía sin liquidar" />
          </span>
          <span className={estilos.datoOrigen}>importe usado al generar el borrador</span>
        </span>
        <span className={estilos.datoTexto}>
          <span className={estilos.datoEtiqueta}>Liquidaciones</span>
          <span className={estilos.datoValor}>
            <span className="dinero">{periodo.liquidaciones}</span> de {barrio.unidadesActivas}
          </span>
          <span className={estilos.datoOrigen}>unidades activas del padrón</span>
        </span>
        <Link href={`/${barrioId}/liquidacion/${periodo.id}`} className={estilos.irA}>
          Abrir el período
          <IconoFlecha direccion="derecha" />
        </Link>
      </div>
      {periodo.primerVencimiento ? (
        <p className={estilos.datoOrigen}>
          Primer vencimiento {formatearFecha(periodo.primerVencimiento)}
          {periodo.segundoVencimiento ? ` · segundo ${formatearFecha(periodo.segundoVencimiento)}` : ""} ·{" "}
          {etiquetaModelo(periodo.modelo)}
        </p>
      ) : null}
    </>
  );
}

/**
 * Qué le falta al barrio para que el sistema pueda **siquiera sugerir** la vía ejecutiva de cobro.
 *
 * La lista la arma `faltantesParaViaEjecutiva()` de `@admin-barrios/shared/barrio` — o sea el
 * dominio, no esta pantalla. La pantalla no evalúa nada: muestra lo que la función devolvió y cierra
 * con el disclaimer, que es la regla dura del proyecto para todo lo que roce lo legal. El sistema
 * **nunca** afirma que una deuda sea ejecutable.
 */
function ViaEjecutiva({ barrio }: { readonly barrio: DetalleBarrio }) {
  // Las dos aserciones existen porque `DetalleBarrio` tipa estos campos como `string`: la consulta
  // los saca del enum de Postgres con `::text` y ahí se pierde la unión. `as never` —que estaba
  // acá— apaga el chequeo por completo, incluido el que atraparía un cambio de firma de la función
  // de dominio; con el tipo concreto, al menos se verifica que sea el que corresponde.
  // Lo que arreglaría esto de raíz es que el servicio devuelva las uniones: anotado, no es de acá.
  const faltantes = faltantesParaViaEjecutiva({
    figuraJuridica: barrio.figuraJuridica as FiguraJuridica,
    adecuadoArt2075: barrio.adecuadoArt2075 as Adecuacion2075,
    reglamentoInscripto: barrio.reglamentoInscripto,
    pactoEjecutividad: barrio.pactoEjecutividad,
  });

  return faltantes.length === 0 ? (
    <Nota tono="info" titulo="No quedan faltantes registrados para sugerir la vía ejecutiva.">
      <span className={estilos.disclaimer}>Validar con profesional matriculado.</span>
    </Nota>
  ) : (
    <Nota tono="info" titulo="Para poder siquiera sugerir la vía ejecutiva de cobro, falta acreditar:">
      <ul className={estilos.faltantes}>
        {faltantes.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <span className={estilos.disclaimer}>Validar con profesional matriculado.</span>
    </Nota>
  );
}

/** `null` es "no se cargó el dato", que no es lo mismo que "no". */
function siNoSinDato(valor: boolean | null): string {
  return valor === null ? "sin dato cargado" : valor ? "Sí" : "No";
}
