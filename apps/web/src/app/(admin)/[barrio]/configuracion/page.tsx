import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerConfiguracionDelBarrio, type ParametroDelBarrio } from "@admin-barrios/data/servicios/parametros";
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
import { EncabezadoDePagina, Nota, Pagina, Vacio } from "../../../../componentes/ui.tsx";
import { esIdValido } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import { FormularioDeAnulacion, FormularioDeCambio, FormularioVolverAlGeneral } from "./formularios.tsx";
import {
  anclaDe,
  ChipDeProgramado,
  desdeCuandoSeAplica,
  filtroDe,
  GRUPOS,
  HistorialDeVigencias,
  RigeDesde,
  textoDelValor,
  unidadDe,
  unidades,
  valorParaFormulario,
} from "./vista.tsx";

export const metadata: Metadata = { title: "Configuración del barrio" };

const FILTROS = ["todos", "propios", "heredados", "programados"] as const;
type Filtro = (typeof FILTROS)[number];

const ETIQUETA_FILTRO: Record<Filtro, string> = {
  todos: "Todos",
  propios: "Propios de este barrio",
  heredados: "Heredados",
  programados: "Con cambio programado",
};

/** Lo que la pantalla necesita saber de cada parámetro para dibujarlo y filtrarlo. Nada se recalcula: se lee. */
function clasificar(p: ParametroDelBarrio) {
  const propio = p.vigente?.origen === "barrio";
  // «Volver al valor general» programado: una fila propia con valor `null` que todavía no rige.
  const vuelta = p.historialPropio.find((h) => h.programada && h.valor === null) ?? null;
  const programado = p.programadosPropios.length > 0 || vuelta !== null || (!propio && p.programadosGenerales.length > 0);
  return { propio, vuelta, programado };
}

function cumple(filtro: Filtro, c: ReturnType<typeof clasificar>): boolean {
  switch (filtro) {
    case "todos":
      return true;
    case "propios":
      return c.propio;
    case "heredados":
      return !c.propio;
    case "programados":
      return c.programado;
  }
}

/**
 * **La configuración de mora e imputación de un barrio** (maqueta T1, pantalla 2; ADR-0006).
 *
 * Lo que no se cambia acá se hereda de la configuración general de la administración. Cada valor
 * dice de dónde sale —propio o heredado, desde cuándo, con qué respaldo— porque una tasa de interés
 * que no se puede explicar no se puede cobrar.
 *
 * Es servidor de punta a punta: los filtros son links (`?filtro=`), el historial es `<details>`, y lo
 * que se abre para editar también. El único JavaScript son los formularios, y **solo se dibujan si
 * quien mira puede editar** (ADR-0003 §6.4): a un rol de solo lectura no se le ofrece un botón que la
 * base va a rechazar, y la pantalla lleva su sello.
 */
export default async function ConfiguracionDelBarrio({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();
  const filtro = filtroDe((await searchParams)["filtro"], FILTROS, "todos");

  const cfg = await conSesion((tx) => leerConfiguracionDelBarrio(tx, { barrioId }));
  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  if (!cfg) notFound();

  const ruta = `/${cfg.barrio.id}/configuracion`;
  const hrefFiltro = (f: Filtro) => (f === "todos" ? ruta : `${ruta}?filtro=${f}`);
  const filas = cfg.parametros.map((p) => ({ p, c: clasificar(p) }));
  const visibles = filas.filter(({ c }) => cumple(filtro, c));
  const ordenVisible = visibles.some(({ p }) => p.clave === "imputacion.orden");
  const hrefOrden = `${ordenVisible ? "" : ruta}#${anclaDe("imputacion.orden")}`;

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Configuración del barrio"
        bajada={
          <>
            Interés por mora e imputación de pagos de <strong>{cfg.barrio.nombre}</strong>. Lo que no se
            cambia acá se hereda de la <Link href={`${ruta}/general`}>configuración general</Link> de la
            administración. Un valor propio rige desde una fecha y queda en el historial: un cambio
            nunca es retroactivo.
          </>
        }
        acciones={cfg.puedeEditar ? undefined : <Chip tono="neutro">Solo lectura</Chip>}
      />

      {cfg.puedeEditar ? null : (
        <Nota tono="neutro" titulo="Estás viendo la configuración en modo de solo lectura.">
          Podés ver cada valor, de dónde sale y su historial. Los cambia la administración del barrio.
        </Nota>
      )}

      <FiltrosDeLista etiqueta="Filtrar los parámetros">
        {FILTROS.map((f) => (
          <FiltroDeLista
            key={f}
            href={hrefFiltro(f)}
            activo={f === filtro}
            cantidad={filas.filter(({ c }) => cumple(f, c)).length}
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
        const delGrupo = visibles.filter(({ p }) => definicionDe(p.clave).grupo === grupo);
        if (delGrupo.length === 0) return null;
        return (
          <GrupoDeParametros key={grupo} titulo={grupo}>
            {delGrupo.map(({ p, c }) => {
              const def = definicionDe(p.clave);
              const valorHoy = p.vigente ? textoDelValor(p.clave, p.vigente.valor) : "sin definir";
              const general = p.general ? textoDelValor(p.clave, p.general.valor) : "sin definir";
              const proximoGeneral = p.programadosGenerales[0] ?? null;
              // Un cambio general programado alcanza a este barrio solo si para entonces ya volvió a heredar.
              const generalNoLoAlcanza =
                proximoGeneral !== null && (c.vuelta === null || c.vuelta.vigenteDesde > proximoGeneral.vigenteDesde);

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
                  ) : c.propio ? (
                    <>
                      <Chip tono="marca" icono={<span aria-hidden>●</span>}>
                        Propio de este barrio
                      </Chip>
                      <RigeDesde vigente={p.vigente} />
                      <TextoDeOrigen>
                        En la configuración general: <DatoEnLinea>{general}</DatoEnLinea>
                        {proximoGeneral ? (
                          <>
                            {" "}
                            (pasa a{" "}
                            <DatoEnLinea>
                              {proximoGeneral.valor === null ? "sin definir" : textoDelValor(p.clave, proximoGeneral.valor)}
                            </DatoEnLinea>{" "}
                            el {formatearFecha(proximoGeneral.vigenteDesde)}
                            {generalNoLoAlcanza ? "; no afecta a este barrio" : ""})
                          </>
                        ) : null}
                      </TextoDeOrigen>
                    </>
                  ) : (
                    <>
                      <Chip tono="neutro" icono={<span aria-hidden>↳</span>}>
                        Heredado de la configuración general
                      </Chip>
                      <RigeDesde vigente={p.vigente} />
                      {p.programadosGenerales.map((f) => (
                        <ChipDeProgramado key={f.filaId} clave={p.clave} fila={f} />
                      ))}
                    </>
                  )}
                  {p.programadosPropios.map((f) => (
                    <ChipDeProgramado key={f.filaId} clave={p.clave} fila={f} sufijo="(propio de este barrio)" />
                  ))}
                  {c.vuelta ? (
                    <Chip tono="info" icono={<span aria-hidden>◷</span>}>
                      Vuelve al valor general · desde {formatearFecha(c.vuelta.vigenteDesde)}
                    </Chip>
                  ) : null}
                </>
              );

              const historial = (
                <>
                  <HistorialDeVigencias
                    titulo="Historial de este barrio"
                    clave={p.clave}
                    filas={p.historialPropio}
                    vigenteFilaId={c.propio ? (p.vigente?.filaId ?? null) : null}
                  />
                  <HistorialDeVigencias
                    titulo="Historial de la configuración general"
                    clave={p.clave}
                    filas={p.historialGeneral}
                    vigenteFilaId={p.general?.filaId ?? null}
                  />
                </>
              );

              const anulables = [...p.programadosPropios, ...(c.vuelta ? [c.vuelta] : [])];
              const acciones = cfg.puedeEditar ? (
                <>
                  <AccionDesplegable texto={c.propio ? "Cambiar" : "Fijar un valor propio"}>
                    <FormularioDeCambio
                      nodoId={cfg.barrio.id}
                      clave={p.clave}
                      hoy={cfg.hoy}
                      valorActual={valorParaFormulario(p.clave, p.vigente?.valor)}
                      hrefOrdenDeImputacion={hrefOrden}
                      rige={
                        <>
                          Hoy rige <DatoEnLinea>{valorHoy}</DatoEnLinea> (
                          {c.propio ? "propio de este barrio" : "heredado de la configuración general"}). El valor
                          nuevo queda <strong>propio de este barrio</strong>.
                        </>
                      }
                      impacto={
                        <>
                          solo <strong>{cfg.barrio.nombre}</strong> ({unidades(cfg.barrio.unidades)}).{" "}
                          {desdeCuandoSeAplica(p.clave)}
                        </>
                      }
                    />
                  </AccionDesplegable>
                  {c.propio ? (
                    <AccionDesplegable texto="Volver al valor general">
                      <FormularioVolverAlGeneral
                        barrioId={cfg.barrio.id}
                        clave={p.clave}
                        hoy={cfg.hoy}
                        aviso={
                          <>
                            Desde la fecha que elijas, <strong>{cfg.barrio.nombre}</strong> vuelve a heredar «
                            {def.nombre}» de la configuración general (<DatoEnLinea>{general}</DatoEnLinea>) y
                            sigue sus cambios. <strong>Los valores propios programados para después de esa fecha
                            también se cancelan.</strong> Lo propio queda en el historial.
                          </>
                        }
                      />
                    </AccionDesplegable>
                  ) : null}
                  {anulables.map((f) => (
                    <AccionDesplegable key={f.filaId} texto={`Anular el cambio programado del ${formatearFecha(f.vigenteDesde)}`}>
                      <FormularioDeAnulacion
                        filaId={f.filaId}
                        descripcion={
                          <>
                            el cambio a{" "}
                            <DatoEnLinea>
                              {f.valor === null ? "valor general" : textoDelValor(p.clave, f.valor)}
                            </DatoEnLinea>{" "}
                            programado desde el {formatearFecha(f.vigenteDesde)}
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
                  historial={historial}
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
