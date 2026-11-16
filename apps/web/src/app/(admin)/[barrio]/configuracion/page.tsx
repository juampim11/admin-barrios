import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { leerBarrio, type DetalleBarrio } from "@admin-barrios/data/servicios/barrios";
import { leerComoSeDevenga } from "@admin-barrios/data/servicios/devengado";
import { leerBarrioDelPadron, puedeEditarPadron, type BarrioDelPadron } from "@admin-barrios/data/servicios/padron-edicion";
import { leerConfiguracionDelBarrio, type ParametroDelBarrio } from "@admin-barrios/data/servicios/parametros";
import {
  AccionDesplegable,
  Boton,
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
import { Definicion, Definiciones, EncabezadoDePagina, Nota, Pagina, Panel, Vacio } from "../../../../componentes/ui.tsx";
import {
  CARACTER_REPRESENTANTE,
  etiquetaAdecuacion,
  etiquetaEncuadre,
  etiquetaServiciosInternos,
} from "../../../../componentes/etiquetas.tsx";
import { esIdValido, migaDelBarrio, rutaDeConfiguracionGeneralDesde, rutaDeCuota } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import { FormularioDeAnulacion, FormularioDeCambio, FormularioVolverAlGeneral } from "./formularios.tsx";
import { FormularioDeVencimientos } from "./vencimientos.tsx";
import { ComoSeDevengaDelBarrio } from "./devengado.tsx";
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

  // Secuenciales y en una transacción: `node-postgres` encola las consultas del mismo client.
  const { cfg, detalle, cobro, editaDatos, devengado } = await conSesion(async (tx) => ({
    cfg: await leerConfiguracionDelBarrio(tx, { barrioId }),
    detalle: await leerBarrio(tx, { barrioId }),
    cobro: await leerBarrioDelPadron(tx, { barrioId }),
    // Los vencimientos del barrio los cambia la administración del barrio (como el padrón), no
    // quien edita los parámetros de mora: por eso es otro permiso que `cfg.puedeEditar`.
    editaDatos: await puedeEditarPadron(tx, { barrioId }),
    // «Cómo se devenga» (encargo 16): lo que rige, lo programado, el historial y si quien mira puede cambiarlo.
    devengado: await leerComoSeDevenga(tx, { barrioId }),
  }));
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
        migas={[migaDelBarrio(cfg.barrio), { texto: "Configuración del barrio" }]}
        titulo="Configuración del barrio"
        bajada={
          <>
            Interés por mora e imputación de pagos de <strong>{cfg.barrio.nombre}</strong>. Lo que no se
            cambia acá se hereda de la <Link href={rutaDeConfiguracionGeneralDesde(cfg.barrio.id)}>configuración general</Link> de la
            administración. Un valor propio rige desde una fecha y queda en el historial: un cambio
            nunca es retroactivo.
          </>
        }
        acciones={
          <>
            {/* T2, D4: la cuota fija vive en Configuración del barrio, con su historial. */}
            {/* También si el importe lo define la administración según «Cómo se devenga» (encargo 16). */}
            {detalle?.modelo === "fija" || devengado?.vigente.origen === "administracion" ? (
              <Boton href={rutaDeCuota(cfg.barrio.id)} variante="secundario">
                Cuota del barrio
              </Boton>
            ) : null}
            {cfg.puedeEditar ? null : <Chip tono="neutro">Solo lectura</Chip>}
          </>
        }
      />

      {cfg.puedeEditar ? null : (
        <Nota tono="neutro" titulo="Estás viendo la configuración en modo de solo lectura.">
          Podés ver cada valor, de dónde sale y su historial. Los cambia la administración del barrio.
        </Nota>
      )}

      {detalle && cobro ? <DatosDelBarrio detalle={detalle} cobro={cobro} edita={editaDatos} /> : null}

      {devengado ? <ComoSeDevengaDelBarrio panel={devengado} /> : null}

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

/** «A confirmar»: el barrio se dio de alta sin el dato (T3, `0065`). Punteado = todavía pendiente. */
const A_CONFIRMAR = (
  <Chip tono="alerta" punteado>
    A confirmar
  </Chip>
);

const siNo = (v: boolean | null): ReactNode => (v === null ? A_CONFIRMAR : v ? "Sí" : "No");
const legal = (v: string | null, etiqueta: (v: string) => string): ReactNode => (v === null ? A_CONFIRMAR : etiqueta(v));

const dias = (n: number): string => (n === 1 ? "1 día" : `${n} días`);

/**
 * **Datos del barrio** (T3): los cuatro datos legales, cómo se identifica el pago y los vencimientos
 * (`0078`). Un dato en `null` se dio de alta como «A confirmar» y se muestra pendiente, nunca rellenado
 * con un valor supuesto. Lo único editable acá son los vencimientos, y solo para la administración del
 * barrio (`edita`); el resto se carga en el alta.
 */
function DatosDelBarrio({
  detalle,
  cobro,
  edita,
}: {
  readonly detalle: DetalleBarrio;
  readonly cobro: BarrioDelPadron;
  readonly edita: boolean;
}) {
  const porUnidad = cobro.identificacionPago === "cuenta_por_unidad";
  const v = detalle.vencimientos;
  return (
    <>
      <Panel
        titulo="Datos del barrio"
        origen="Los que se cargaron en el alta. Los «A confirmar» quedaron pendientes: se dio de alta sin el dato."
      >
        <Definiciones>
          {/* Solo un barrio sin entidad constituida tiene representante (`0078`). */}
          {detalle.representante ? (
            <Definicion termino={CARACTER_REPRESENTANTE[detalle.representante.caracter]}>{detalle.representante.nombre}</Definicion>
          ) : null}
          <Definicion termino="Adecuado al art. 2075">{legal(detalle.adecuadoArt2075, etiquetaAdecuacion)}</Definicion>
          <Definicion termino="Encuadre urbanístico">{legal(detalle.encuadreUrbanistico, etiquetaEncuadre)}</Definicion>
          <Definicion termino="Servicios internos">
            {legal(detalle.serviciosInternosACargoDe, etiquetaServiciosInternos)}
          </Definicion>
          <Definicion termino="Reglamento inscripto">{siNo(detalle.reglamentoInscripto)}</Definicion>
          <Definicion termino="Cómo se identifica el pago">
            {cobro.identificacionPago === null ? (
              <Chip tono="neutro">Sin definir</Chip>
            ) : porUnidad ? (
              "Una cuenta por unidad"
            ) : (
              "Una cuenta para todo el barrio"
            )}
          </Definicion>
          {porUnidad ? <Definicion termino="Recaudador">{cobro.recaudador ?? "—"}</Definicion> : null}
          {cobro.identificacionPago === null ? null : (
            <Definicion termino={porUnidad ? "Cuenta padre (CBU)" : "Cuenta de cobro (CBU)"}>
              {cobro.cuentaCbu ? <DatoEnLinea>{cobro.cuentaCbu}</DatoEnLinea> : "—"}
            </Definicion>
          )}
          {cobro.identificacionPago === "cuenta_unica" ? (
            <Definicion termino="Alias">{cobro.cuentaAlias ?? "—"}</Definicion>
          ) : null}
        </Definiciones>
      </Panel>

      <Panel
        titulo="Vencimientos"
        origen="Se proponen al abrir cada mes. Un mes abierto se cambia en sus propios vencimientos, hasta emitirlo."
      >
        <Definiciones>
          <Definicion termino="Primer vencimiento">
            {v.diaVencimiento === null ? <Chip tono="neutro">Sin definir</Chip> : `Día ${v.diaVencimiento} de cada mes`}
          </Definicion>
          <Definicion termino="Segundo vencimiento">
            {v.diasSegundoVencimiento === null ? "No usa" : `${dias(v.diasSegundoVencimiento)} después del primero, con el mismo importe`}
          </Definicion>
          <Definicion termino="Corte">
            {v.diasCorte === null ? "Sin corte" : `${dias(v.diasCorte)} después del último vencimiento`}
          </Definicion>
        </Definiciones>
        {edita ? (
          <AccionDesplegable texto="Cambiar los vencimientos">
            <FormularioDeVencimientos
              barrioId={detalle.id}
              diaVencimiento={v.diaVencimiento}
              diasSegundoVencimiento={v.diasSegundoVencimiento}
              diasCorte={v.diasCorte}
            />
          </AccionDesplegable>
        ) : null}
      </Panel>
    </>
  );
}
