import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerConfiguracionGeneral, type ParametroGeneral } from "@admin-barrios/data/servicios/parametros";
import {
  AccionDesplegable,
  Chip,
  DatoEnLinea,
  FiltroDeLista,
  FiltrosDeLista,
  GrupoDeParametros,
  TarjetaDeParametro,
  TextoDeOrigen,
} from "@admin-barrios/ui";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { definicionDe } from "@admin-barrios/shared/parametros-mora";
import { EncabezadoDePagina, Nota, Pagina, Vacio } from "../../../../../componentes/ui.tsx";
import { esIdValido } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { FormularioDeAnulacion, FormularioDeCambio } from "../formularios.tsx";
import {
  anclaDe,
  barrios as cuantosBarrios,
  ChipDeProgramado,
  desdeCuandoSeAplica,
  filtroDe,
  GRUPOS,
  HistorialDeVigencias,
  RigeDesde,
  textoDelValor,
  unidadDe,
  valorParaFormulario,
} from "../vista.tsx";

export const metadata: Metadata = { title: "Configuración general" };

const FILTROS = ["todos", "propios", "programados"] as const;
type Filtro = (typeof FILTROS)[number];

const ETIQUETA_FILTRO: Record<Filtro, string> = {
  todos: "Todos",
  propios: "Con valor propio en algún barrio",
  programados: "Con cambio programado",
};

function cumple(filtro: Filtro, p: ParametroGeneral): boolean {
  switch (filtro) {
    case "todos":
      return true;
    case "propios":
      return p.barriosConPropio.length > 0;
    case "programados":
      return p.programados.length > 0;
  }
}

/** «A y B», «A, B y C». */
function enumerar(nombres: readonly string[]): string {
  if (nombres.length <= 1) return nombres.join("");
  return `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
}

/**
 * **La configuración general de la administración** (maqueta T1, pantalla 1; ADR-0006).
 *
 * Los valores de mora e imputación que valen para **todos los barrios** de la administración, salvo
 * los que tengan uno propio. Se entra desde la barra de un barrio —así se navega— pero lo que se ve y
 * se cambia es de la administración; por eso cada cambio dice antes de guardarse **en cuántos barrios
 * cambia y en cuáles no**.
 *
 * Mismo criterio que la pantalla del barrio: servidor de punta a punta, filtros por link, historial en
 * `<details>`, y los formularios solo para quien puede editar.
 */
export default async function ConfiguracionGeneral({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();
  const filtro = filtroDe((await searchParams)["filtro"], FILTROS, "todos");

  const cfg = await conSesion((tx) => leerConfiguracionGeneral(tx, { barrioId }));
  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  if (!cfg) notFound();

  const ruta = `/${barrioId}/configuracion/general`;
  const hrefFiltro = (f: Filtro) => (f === "todos" ? ruta : `${ruta}?filtro=${f}`);
  const visibles = cfg.parametros.filter((p) => cumple(filtro, p));
  const ordenVisible = visibles.some((p) => p.clave === "imputacion.orden");
  const hrefOrden = `${ordenVisible ? "" : ruta}#${anclaDe("imputacion.orden")}`;
  const total = cfg.barrios.length;

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Configuración general"
        bajada={
          <>
            Interés por mora e imputación de pagos para <strong>todos los barrios</strong> de{" "}
            <strong>{cfg.administracion.nombre}</strong>; cada barrio puede tener un valor propio. Cada
            valor rige desde una fecha: un cambio <strong>nunca es retroactivo</strong> ni mueve boletas
            emitidas, cobros imputados ni intereses ya liquidados.
          </>
        }
        acciones={cfg.puedeEditar ? undefined : <Chip tono="neutro">Solo lectura</Chip>}
      />

      {cfg.puedeEditar ? null : (
        <Nota tono="neutro" titulo="Estás viendo la configuración general en modo de solo lectura.">
          Podés ver cada valor, qué barrios tienen uno propio y su historial. Los cambia la
          administración.
        </Nota>
      )}

      <FiltrosDeLista etiqueta="Filtrar los parámetros">
        {FILTROS.map((f) => (
          <FiltroDeLista
            key={f}
            href={hrefFiltro(f)}
            activo={f === filtro}
            cantidad={cfg.parametros.filter((p) => cumple(f, p)).length}
          >
            {ETIQUETA_FILTRO[f]}
          </FiltroDeLista>
        ))}
      </FiltrosDeLista>

      {visibles.length === 0 ? (
        <Vacio titulo="Ningún parámetro con este filtro.">
          <Link href={ruta}>Ver todos los parámetros</Link>.
        </Vacio>
      ) : null}

      {GRUPOS.map((grupo) => {
        const delGrupo = visibles.filter((p) => definicionDe(p.clave).grupo === grupo);
        if (delGrupo.length === 0) return null;
        return (
          <GrupoDeParametros key={grupo} titulo={grupo}>
            {delGrupo.map((p) => {
              const def = definicionDe(p.clave);
              const valorHoy = p.vigente ? textoDelValor(p.clave, p.vigente.valor) : "sin definir";
              const conPropio = p.barriosConPropio;
              const heredan = total - conPropio.length;

              const marcas = (
                <>
                  {p.vigente === null ? (
                    <>
                      <Chip tono="alerta">Sin definir</Chip>
                      <TextoDeOrigen>
                        {p.clave === "imputacion.orden"
                          ? "Hasta que se fije, los pagos que no cubren todo el saldo se imputan a mano."
                          : "Todavía no tiene un valor."}
                      </TextoDeOrigen>
                    </>
                  ) : (
                    <RigeDesde vigente={p.vigente} />
                  )}
                  {p.programados.map((f) => (
                    <ChipDeProgramado key={f.filaId} clave={p.clave} fila={f} />
                  ))}
                  {conPropio.length > 0 ? (
                    <TextoDeOrigen>
                      {cuantosBarrios(conPropio.length)} con valor propio:{" "}
                      {conPropio.map((b, i) => (
                        <span key={b.id}>
                          {i > 0 ? ", " : ""}
                          <Link href={`/${b.id}/configuracion#${anclaDe(p.clave)}`}>{b.nombre}</Link>
                        </span>
                      ))}
                    </TextoDeOrigen>
                  ) : null}
                </>
              );

              const acciones = cfg.puedeEditar ? (
                <>
                  <AccionDesplegable texto="Cambiar">
                    <FormularioDeCambio
                      nodoId={cfg.administracion.id}
                      clave={p.clave}
                      hoy={cfg.hoy}
                      valorActual={valorParaFormulario(p.clave, p.vigente?.valor)}
                      hrefOrdenDeImputacion={hrefOrden}
                      rige={
                        <>
                          Hoy rige <DatoEnLinea>{valorHoy}</DatoEnLinea> (configuración general). Cambia para los
                          barrios que heredan; los que tienen un valor propio no cambian.
                        </>
                      }
                      impacto={
                        <>
                          cambia en <strong>{heredan} de {cuantosBarrios(total)}</strong>
                          {conPropio.length > 0 ? (
                            <>
                              {" "}
                              (no en {enumerar(conPropio.map((b) => b.nombre))}:{" "}
                              {conPropio.length === 1 ? "tiene" : "tienen"} valor propio)
                            </>
                          ) : null}
                          . {desdeCuandoSeAplica(p.clave)}
                        </>
                      }
                    />
                  </AccionDesplegable>
                  {p.programados.map((f) => (
                    <AccionDesplegable key={f.filaId} texto={`Anular el cambio programado del ${formatearFecha(f.vigenteDesde)}`}>
                      <FormularioDeAnulacion
                        filaId={f.filaId}
                        descripcion={
                          <>
                            el cambio a{" "}
                            <DatoEnLinea>{f.valor === null ? "sin definir" : textoDelValor(p.clave, f.valor)}</DatoEnLinea>{" "}
                            programado desde el {formatearFecha(f.vigenteDesde)}, para todos los barrios que heredan
                          </>
                        }
                      />
                    </AccionDesplegable>
                  ))}
                </>
              ) : undefined;

              return (
                <TarjetaDeParametro
                  key={p.clave}
                  id={anclaDe(p.clave)}
                  nombre={def.nombre}
                  ayuda={def.ayuda}
                  valor={valorHoy}
                  unidad={p.vigente ? unidadDe(p.clave) : undefined}
                  marcas={marcas}
                  historial={
                    <HistorialDeVigencias
                      titulo="Historial de vigencias"
                      clave={p.clave}
                      filas={p.historial}
                      vigenteFilaId={p.vigente?.filaId ?? null}
                    />
                  }
                  acciones={acciones}
                />
              );
            })}
          </GrupoDeParametros>
        );
      })}
    </Pagina>
  );
}
