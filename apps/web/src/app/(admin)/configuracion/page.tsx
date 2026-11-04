import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import {
  administracionDelBarrio,
  leerConfiguracionGeneral,
  listarAdministracionesVisibles,
  type AdministracionVisible,
  type ParametroGeneral,
} from "@admin-barrios/data/servicios/parametros";
import { listarBarriosAccesibles } from "@admin-barrios/data/servicios/barrios";
import {
  AccionDesplegable,
  Chip,
  CuerpoConBarraLateral,
  DatoEnLinea,
  FiltroDeLista,
  FiltrosDeLista,
  GrupoDeParametros,
  TarjetaDeParametro,
  TextoDeOrigen,
} from "@admin-barrios/ui";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { definicionDe } from "@admin-barrios/shared/parametros-mora";
import { EncabezadoDePagina, Nota, Pagina, Vacio } from "../../../componentes/ui.tsx";
import { COOKIE_ULTIMO_BARRIO, esIdValido, rutaDeConfiguracionGeneral, RUTA_CONFIGURACION_GENERAL } from "../../../rutas.ts";
import { conSesion } from "../../../servidor/db.ts";
import { BarraDelBarrio } from "../barra-del-barrio.tsx";
import { FormularioDeAnulacion, FormularioDeCambio } from "../[barrio]/configuracion/formularios.tsx";
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
} from "../[barrio]/configuracion/vista.tsx";
import estilos from "../admin.module.css";

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

/** Un valor de la URL que puede venir repetido: se toma el primero, y solo si es texto. */
const primero = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * **Qué administración se muestra** (encargo 8, T1 §4). En orden:
 *
 * 1. La del `?administracion=`, si es una de las que esta persona ve. Un id ajeno o inventado se
 *    ignora (no es un 404: no se confirma ni se niega que exista).
 * 2. Si ve una sola, esa.
 * 3. La del último barrio visitado (cookie `httpOnly` que escribe `/configuracion/desde/[barrio]`).
 * 4. La primera por nombre. No hay pantalla para elegir: el selector de barrio cambia de contexto.
 *
 * Nada de esto autoriza: `leerConfiguracionGeneral` vuelve a decidir la visibilidad bajo RLS.
 */
function elegirAdministracion(
  visibles: readonly AdministracionVisible[],
  pedida: string | undefined,
  delUltimoBarrio: AdministracionVisible | null,
): AdministracionVisible | null {
  const entre = (id: string | undefined) => (id ? (visibles.find((a) => a.id === id) ?? null) : null);
  return (
    entre(pedida) ??
    (visibles.length === 1 ? (visibles[0] ?? null) : null) ??
    entre(delUltimoBarrio?.id) ??
    visibles[0] ??
    null
  );
}

/**
 * **La configuración general de la administración** (maqueta T1, pantalla 1; ADR-0006).
 *
 * Los valores de mora e imputación que valen para **todos los barrios** de la administración, salvo
 * los que tengan uno propio. **Es una pantalla de la administración, fuera de todo barrio**: vive en
 * `/configuracion` y no en `/[barrio]/…` (encargo 8, T1 §4; la ruta vieja redirige acá). Cada cambio
 * dice antes de guardarse **en cuántos barrios cambia y en cuáles no**.
 *
 * La barra lateral es la misma de siempre (maqueta `mora-parametros.html`): las secciones son las del
 * último barrio visitado —salir de acá es volver a él—, el ítem marcado es «Configuración general ·
 * todos los barrios» y el selector dice «{administración} · todos los barrios».
 *
 * Mismo criterio que la pantalla del barrio: servidor de punta a punta, filtros por link, historial en
 * `<details>`, y los formularios solo para quien puede editar.
 */
export default async function ConfiguracionGeneral({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const consulta = await searchParams;
  const filtro = filtroDe(consulta["filtro"], FILTROS, "todos");
  const pedidaCruda = primero(consulta["administracion"]);
  const pedida = pedidaCruda && esIdValido(pedidaCruda) ? pedidaCruda : undefined;
  const ultimoCrudo = (await cookies()).get(COOKIE_ULTIMO_BARRIO)?.value;
  const ultimoBarrioId = ultimoCrudo && esIdValido(ultimoCrudo) ? ultimoCrudo : null;

  // Secuenciales y en una transacción: `node-postgres` encola las consultas del mismo client.
  const datos = await conSesion(async (tx) => {
    const visibles = await listarAdministracionesVisibles(tx);
    const barrios = await listarBarriosAccesibles(tx);
    // El último barrio solo cuenta si sigue siendo visible: la RLS decide, la cookie no.
    const ultimo = ultimoBarrioId ? (barrios.find((b) => b.id === ultimoBarrioId) ?? null) : null;
    const delUltimo = ultimo ? await administracionDelBarrio(tx, { barrioId: ultimo.id }) : null;
    const elegida = elegirAdministracion(visibles, pedida, delUltimo);
    const cfg = elegida ? await leerConfiguracionGeneral(tx, { administracionId: elegida.id }) : null;
    return { visibles, barrios, ultimo, cfg };
  });
  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  const cfg = datos.cfg;
  if (!cfg) notFound();

  /*
   * El barrio de la barra: el último visitado, solo si es de esta administración (con `?administracion=`
   * puede no serlo); si no hay (se entró directo, o ese barrio ya no se ve),
   * el primero de esta administración que se vea; y si tampoco, el primero que se vea.
   */
  const barrioDeLaBarra =
    (datos.ultimo && cfg.barrios.some((delAdmin) => delAdmin.id === datos.ultimo?.id) ? datos.ultimo : null) ??
    datos.barrios.find((b) => cfg.barrios.some((delAdmin) => delAdmin.id === b.id)) ??
    datos.barrios[0] ??
    null;

  // Con más de una administración a la vista, los enlaces de la pantalla fijan cuál es.
  const ruta =
    datos.visibles.length > 1 ? rutaDeConfiguracionGeneral(cfg.administracion.id) : RUTA_CONFIGURACION_GENERAL;
  const hrefFiltro = (f: Filtro) =>
    f === "todos" ? ruta : `${ruta}${ruta.includes("?") ? "&" : "?"}filtro=${f}`;
  const visibles = cfg.parametros.filter((p) => cumple(filtro, p));
  const ordenVisible = visibles.some((p) => p.clave === "imputacion.orden");
  const hrefOrden = `${ordenVisible ? "" : ruta}#${anclaDe("imputacion.orden")}`;
  const total = cfg.barrios.length;

  const pantalla = (
    <Pagina>
      <EncabezadoDePagina
        migas={[{ texto: cfg.administracion.nombre }, { texto: "Configuración general" }]}
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

  if (!barrioDeLaBarra) return <main id="contenido">{pantalla}</main>;
  return (
    <CuerpoConBarraLateral
      barraLateral={
        <BarraDelBarrio
          barrio={barrioDeLaBarra}
          barrios={datos.barrios}
          administracion={cfg.administracion.nombre}
          enConfiguracionGeneral
        />
      }
    >
      <main id="contenido" className={estilos.contenido}>
        {pantalla}
      </main>
    </CuerpoConBarraLateral>
  );
}
