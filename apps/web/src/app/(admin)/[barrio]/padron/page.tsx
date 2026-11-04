import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import {
  FILTROS_PADRON,
  fichaDeUnidad,
  leerBarrioDelPadron,
  listarPadronEditable,
  puedeEditarPadron,
  type FilaDelPadron,
  type FiltroPadron,
} from "@admin-barrios/data/servicios/padron-edicion";
import { formatearDecimal } from "@admin-barrios/shared/dinero";
import { Boton, Chip, CifraDeLaFila, FiltroDeLista, FiltrosDeLista, FilaDeCifras, IconoMas } from "@admin-barrios/ui";
import { IconoBarrio } from "../../../../componentes/iconos.tsx";
import {
  EncabezadoDePagina,
  MarcoTabla,
  Nota,
  Pagina,
  Paginado,
  Panel,
  Tabla,
  Vacio,
  ui,
} from "../../../../componentes/ui.tsx";
import { comoEntraLaUnidad, etiquetaEstadoUnidad } from "../../../../componentes/etiquetas.tsx";
import { esIdValido, leerListo, migaDelBarrio, rutaDeFichaDelPadron, rutaDeNuevaUnidad } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import estilos from "./padron.module.css";

export const metadata: Metadata = { title: "Padrón" };

/** 50 filas: lo que entra en una pantalla. El techo del servicio (500) es un techo, no un tamaño. */
const POR_PAGINA = 50;

/** Filtro, búsqueda y página llegan por la URL, o sea del cliente: se validan con Zod. */
const consultaSchema = z.object({
  pagina: z.coerce.number().int().min(1).catch(1),
  filtro: z.enum(FILTROS_PADRON).catch("todas"),
  q: z.string().trim().max(80).catch(""),
});

/**
 * El padrón editable (pantalla 3 de la maqueta aprobada `alta-barrio-padron.html`, T3 / ADR-0010).
 *
 * Todo se resuelve en el servidor: filtros y búsqueda son links y un `<form method="get">`, así que
 * leer el padrón cuesta cero JavaScript. La única isla es «Agregar unidad», que se abre en el lugar
 * (`AccionDesplegable`) y solo se manda a quien puede escribir.
 *
 * **Los datos personales a la vista son los de la maqueta aprobada**: titular con su documento y el
 * mail de contacto. Reemplaza el criterio anterior de esta pantalla (identificadores detrás de un
 * `<details>`), que era el del padrón de solo lectura; quién lee estas filas lo sigue decidiendo la
 * RLS de `obligado` y `unidad_contacto`, no la pantalla.
 *
 * **Lo que depende del barrio, no se hornea** (CLAUDE.md §1.6): «Sin cuenta propia» existe solo en
 * los barrios que cobran con una cuenta por unidad, y «Coeficientes» solo en los que prorratean.
 */
export default async function Padron({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const crudos = await searchParams;
  const unico = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const consulta = consultaSchema.parse({ pagina: unico(crudos["pagina"]), filtro: unico(crudos["filtro"]), q: unico(crudos["q"]) });
  const listo = leerListo(crudos, "unidad");

  const datos = await conSesion(async (tx) => {
    const barrio = await leerBarrioDelPadron(tx, { barrioId });
    if (!barrio) return null;
    // «Sin cuenta propia» no significa nada en un barrio con una cuenta para todos: vuelve a «Todas».
    const filtro: FiltroPadron = consulta.filtro === "sin_cuenta" && !barrio.cuentaPorUnidad ? "todas" : consulta.filtro;
    return {
      barrio,
      filtro,
      puedeEditar: await puedeEditarPadron(tx, { barrioId }),
      padron: await listarPadronEditable(tx, {
        barrioId,
        filtro,
        busqueda: consulta.q,
        limite: POR_PAGINA,
        desplazamiento: (consulta.pagina - 1) * POR_PAGINA,
      }),
      // «Listo:» de un alta recién guardada: la unidad releída bajo RLS, no lo que dice la URL.
      recienAgregada: listo?.id ? await fichaDeUnidad(tx, { unidadFuncionalId: listo.id }) : null,
    };
  });

  if (!datos) notFound();
  const { barrio, filtro, puedeEditar, padron } = datos;
  const recienAgregada = datos.recienAgregada?.barrioId === barrio.id ? datos.recienAgregada : null;
  const { indicadores } = padron;
  const ruta = `/${barrio.id}/padron`;

  // Los parámetros que se conservan al paginar y al cambiar de filtro.
  const parametros: Record<string, string> = {
    ...(filtro !== "todas" ? { filtro } : {}),
    ...(consulta.q !== "" ? { q: consulta.q } : {}),
  };
  const hrefFiltro = (f: FiltroPadron, q: string = consulta.q): string => {
    const texto = new URLSearchParams({ ...(f !== "todas" ? { filtro: f } : {}), ...(q !== "" ? { q } : {}) }).toString();
    return texto === "" ? ruta : `${ruta}?${texto}`;
  };

  const paginas = Math.max(1, Math.ceil(padron.total / POR_PAGINA));
  // Una página fuera de rango (escrita a mano, o vieja después de un filtro) se manda a la última real.
  if (consulta.pagina > paginas) {
    redirect(`${ruta}?${new URLSearchParams({ ...parametros, pagina: `${paginas}` }).toString()}`);
  }
  const desde = padron.total === 0 ? 0 : (consulta.pagina - 1) * POR_PAGINA + 1;
  const hasta = (consulta.pagina - 1) * POR_PAGINA + padron.filas.length;

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio(barrio), { texto: "Padrón" }]}
        titulo="Padrón"
        bajada="Las unidades del barrio, sus titulares y sus contactos. Se cargan a mano o con una planilla; la planilla también sirve para corregir en bloque."
        acciones={
          // El alta en su página, como «Nueva orden de pago» (encargo 9, PR 1 §2).
          puedeEditar ? (
            <Boton href={rutaDeNuevaUnidad(barrio.id)} variante="primario" icono={<IconoMas />}>
              Agregar unidad
            </Boton>
          ) : null
        }
      />

      {listo ? (
        <Nota
          tono="exito"
          titulo={
            recienAgregada
              ? `Listo: ${recienAgregada.etiqueta} quedó agregada con el código de pago ${recienAgregada.codigoPago}.`
              : "Listo: la unidad quedó agregada."
          }
        >
          {recienAgregada ? (
            <>
              {comoEntraLaUnidad(barrio.modelo, barrio.proximoPeriodo)}{" "}
              <Link href={rutaDeFichaDelPadron(barrio.id, recienAgregada.id)}>Ver la ficha de la unidad</Link>
            </>
          ) : null}
        </Nota>
      ) : null}

      <div className={estilos.acciones}>
        {barrio.modelo === "variable" ? (
          <Boton href={`${ruta}/coeficientes`} variante="sutil" tamano="sm">
            Coeficientes
          </Boton>
        ) : null}
        {puedeEditar ? (
          <>
            {/* Un link común: la ruta responde el Excel como adjunto y deja la traza de quién lo bajó. */}
            <Boton href={`/api/padron/planilla?barrio=${barrio.id}&tipo=exportar`} variante="sutil" tamano="sm">
              Exportar planilla
            </Boton>
            <Boton href={`${ruta}/importar`} variante="secundario" tamano="sm">
              Importar planilla
            </Boton>
          </>
        ) : null}
      </div>

      <FilaDeCifras>
        <CifraDeLaFila etiqueta="Unidades activas" origen="las que no están dadas de baja">
          <span className="dinero">{indicadores.activas}</span>
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="Dadas de baja" origen="siguen en el padrón con su historia">
          <span className="dinero">{indicadores.bajas}</span>
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="Sin titular" origen="activas sin titular vigente">
          <span className="dinero">{indicadores.sinTitular}</span>
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="Sin mail" origen="activas sin un mail de contacto">
          <span className="dinero">{indicadores.sinMail}</span>
        </CifraDeLaFila>
      </FilaDeCifras>

      <div className={estilos.filtros}>
        <FiltrosDeLista etiqueta="Filtrar el padrón">
          <FiltroDeLista href={hrefFiltro("todas")} activo={filtro === "todas"} cantidad={indicadores.activas}>
            Todas
          </FiltroDeLista>
          <FiltroDeLista href={hrefFiltro("sin_titular")} activo={filtro === "sin_titular"} cantidad={indicadores.sinTitular}>
            Sin titular
          </FiltroDeLista>
          <FiltroDeLista href={hrefFiltro("sin_mail")} activo={filtro === "sin_mail"} cantidad={indicadores.sinMail}>
            Sin mail
          </FiltroDeLista>
          {barrio.cuentaPorUnidad ? (
            <FiltroDeLista href={hrefFiltro("sin_cuenta")} activo={filtro === "sin_cuenta"} cantidad={indicadores.sinCuenta}>
              Sin cuenta propia
            </FiltroDeLista>
          ) : null}
          <FiltroDeLista href={hrefFiltro("bajas")} activo={filtro === "bajas"} cantidad={indicadores.bajas}>
            Dadas de baja
          </FiltroDeLista>
        </FiltrosDeLista>

        {/* Sin JavaScript: el navegador arma `?filtro=…&q=…` y el servidor resuelve. */}
        <form method="get" action={ruta} role="search" className={estilos.busqueda}>
          {filtro !== "todas" ? <input type="hidden" name="filtro" value={filtro} /> : null}
          <input
            type="search"
            name="q"
            defaultValue={consulta.q}
            maxLength={80}
            placeholder="Buscar por manzana, lote, titular, CUIT o código de pago"
            aria-label="Buscar por manzana, lote, titular, CUIT o código de pago"
            className={estilos.campoBusqueda}
          />
          <Boton tipo="submit" variante="secundario" tamano="sm">
            Buscar
          </Boton>
        </form>
      </div>

      <Panel
        titulo="Unidades"
        origen={
          consulta.q !== "" ? (
            <>
              Resultado de buscar «{consulta.q}». <Link href={hrefFiltro(filtro, "")}>Ver sin la búsqueda</Link>
            </>
          ) : (
            "Ordenadas por manzana y lote. El código de pago es el que se imprime en la boleta."
          )
        }
        sinRelleno
      >
        {padron.filas.length === 0 ? (
          <Vacio icono={<IconoBarrio />} titulo={consulta.q !== "" ? "Ninguna unidad coincide con la búsqueda" : "No hay unidades en este filtro"}>
            {consulta.q !== ""
              ? "Probá con la manzana y el lote («12 3»), el apellido, el CUIT o el código de pago."
              : filtro === "todas"
                ? puedeEditar
                  ? "Todavía no se cargaron unidades: agregalas de a una o importá la planilla."
                  : "Todavía no se cargaron unidades en este barrio."
                : "No hay unidades que cumplan este filtro."}
          </Vacio>
        ) : (
          <>
            <MarcoTabla etiqueta="Padrón de unidades">
              <Tabla>
                <thead>
                  <tr>
                    <th scope="col" className={ui.columnaAncla}>
                      Unidad
                    </th>
                    <th scope="col">Código de pago</th>
                    <th scope="col">Titular</th>
                    <th scope="col">Estado</th>
                    <th scope="col" className={ui.numerica}>
                      Superficie
                    </th>
                    <th scope="col">Contacto</th>
                    <th scope="col">
                      <span className={ui.soloLectores}>Acción</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {padron.filas.map((fila) => (
                    <Fila key={fila.id} fila={fila} ruta={ruta} puedeEditar={puedeEditar} />
                  ))}
                </tbody>
              </Tabla>
            </MarcoTabla>
            <Paginado
              ruta={ruta}
              parametros={parametros}
              pagina={consulta.pagina}
              paginas={paginas}
              rango={
                <>
                  Mostrando {desde}–{hasta} de {padron.total} {filtro === "bajas" ? "unidades dadas de baja" : "unidades"}
                </>
              }
            />
          </>
        )}
      </Panel>

      <Nota tono="info">
        Las unidades dadas de baja siguen en el padrón con su historia y su deuda; no reciben boleta desde el período siguiente
        a la baja.
      </Nota>
    </Pagina>
  );
}

function Fila({ fila, ruta, puedeEditar }: { readonly fila: FilaDelPadron; readonly ruta: string; readonly puedeEditar: boolean }) {
  const ficha = `${ruta}/${fila.id}`;
  // «Completar» invita a cargar lo que falta; solo a quien puede escribir y en una unidad activa.
  const accion = puedeEditar && !fila.dadaDeBaja && (fila.titulares.length === 0 || fila.mails.length === 0) ? "Completar" : "Ver";
  const unico = fila.titulares.length === 1 ? fila.titulares[0] : undefined;

  return (
    <tr className={fila.dadaDeBaja ? estilos.filaDeBaja : undefined}>
      <th scope="row" className={ui.columnaAncla}>
        <Link href={ficha} className={estilos.unidad}>
          {fila.etiqueta}
        </Link>
      </th>
      <td>
        <span className={ui.mono}>{fila.codigoPago}</span>
      </td>
      <td>
        {fila.titulares.length === 0 ? (
          <Chip tono="alerta">Sin titular</Chip>
        ) : unico ? (
          <span className={estilos.titularCelda}>
            <span>{unico.nombre}</span>
            {unico.documento ? <small className={`${ui.mono} ${ui.secundaria}`}>{unico.documento}</small> : null}
          </span>
        ) : (
          <span className={estilos.titularCelda}>
            <span>{fila.titulares.map((t) => t.nombre).join(" y ")}</span>
            <small className={ui.secundaria}>{fila.titulares.length} titulares</small>
          </span>
        )}
      </td>
      <td>
        <span className={estilos.chips}>
          <Chip tono="neutro">{etiquetaEstadoUnidad(fila.estado)}</Chip>
          {fila.dadaDeBaja ? <Chip tono="alerta">Dada de baja</Chip> : null}
        </span>
      </td>
      <td className={ui.numerica}>
        {fila.superficie === null ? <span className={ui.secundaria}>—</span> : `${formatearDecimal(fila.superficie, 2)} m²`}
      </td>
      <td>
        {fila.mails.length === 0 ? (
          fila.titulares.length === 0 ? (
            <span className={ui.secundaria}>—</span>
          ) : (
            <Chip tono="alerta">Sin mail</Chip>
          )
        ) : fila.mails.length === 1 ? (
          fila.mails[0]
        ) : (
          `${fila.mails.length} mails`
        )}
      </td>
      <td>
        <Boton href={ficha} variante="sutil" tamano="sm" etiqueta={`${accion} ${fila.etiqueta}`}>
          {accion}
        </Boton>
      </td>
    </tr>
  );
}
