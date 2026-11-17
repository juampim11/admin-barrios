/**
 * **La lista de mora** (encargo E-a; maqueta de mora, pantallas 1 y 2): la misma en «Mora · todos los
 * barrios» y en la mora de cada barrio. En el barrio va filtrada y sin la columna ni el filtro Barrio.
 *
 * Servidor de punta a punta: las cifras, los filtros (links y un `<form method="get">`) y la tabla
 * cuestan cero JavaScript. Lo único de cliente es la elección para derivar (`seleccion-de-mora.tsx`),
 * que envuelve la tabla y pone la casilla de cada fila y la barra de abajo.
 *
 * Nada se calcula acá: meses, capital, interés y situación vienen de `moraDeLaAdministracion`, que lee
 * la deuda con `deudaALaFecha` —la misma cuenta del estado de cuenta y de la boleta—. Acá se filtran
 * (`filtro.ts`) y se nombran (`textos.ts`). Y cada cifra dice de dónde sale: el criterio de cada barrio
 * va escrito debajo de la tabla.
 */

import Link from "next/link";
import { MOTIVOS_DERIVACION, TEXTO_MOTIVO_DERIVACION } from "@admin-barrios/shared/mora";
import type { Mora } from "@admin-barrios/data/servicios/mora";
import { BarraDeFiltros, Chip, CifraDeLaFila, FilaDeCifras, FiltroDeLista, FiltrosDeLista, FiltrosDesplegables } from "@admin-barrios/ui";
import { Cifra, Desplegable, MarcoTabla, Panel, Tabla, Vacio, ui } from "../ui.tsx";
import { IconoBorrador } from "../iconos.tsx";
import { hrefDeLista, rutaDeMoraYEstudios, rutaDeUnidad } from "../../rutas.ts";
import {
  contarVistas,
  filtrarMora,
  parametrosDelFiltro,
  SIN_DERIVAR,
  TEXTO_VISTA,
  VISTAS_MORA,
  type FiltroMora,
  type VistaMora,
} from "./filtro.ts";
import { chipsDeSituacion, criterioEnPalabras, ORIGEN_DEL_CRITERIO, ultimaGestionEnPalabras } from "./textos.ts";
import { claveDeFiltro } from "./seleccion.ts";
import { BarraDeDerivar, CasillaDeMora, ResultadoDeLaDerivacion, SeleccionDeMora, type BarrioDeLaIsla } from "./seleccion-de-mora.tsx";

/** Qué se dice cuando un chip no tiene filas. */
const VACIO_DE_LA_VISTA: Record<VistaMora, string> = {
  con_deuda: "Ninguna unidad con deuda vencida",
  para_derivar: "Ninguna unidad cumple el criterio para derivar",
  derivadas: "Ninguna unidad derivada",
  promesa_vencida: "Ninguna promesa de pago vencida",
};

export function ListaDeMora({
  mora,
  filtro,
  ruta,
  conservar = {},
  conBarrio,
}: {
  readonly mora: Mora;
  readonly filtro: FiltroMora;
  /** La ruta de la lista, sin consulta: `/mora` o `/{barrio}/mora`. */
  readonly ruta: string;
  /** Parámetros que viajan siempre (el `?administracion=` con más de una a la vista). */
  readonly conservar?: Readonly<Record<string, string>>;
  /** «Todos los barrios»: columna y filtro Barrio. */
  readonly conBarrio: boolean;
}) {
  const hrefDe = (f: FiltroMora) => hrefDeLista(ruta, { ...conservar, ...parametrosDelFiltro(f) });

  // Las cifras de arriba son las del barrio elegido (o de todos): no cambian con el estudio ni el chip.
  const delAlcance = mora.filas.filter((f) => filtro.barrio === null || f.barrioId === filtro.barrio);
  const cifras = contarVistas(delAlcance, { barrio: null, estudio: null, ver: filtro.ver });
  const cuenta = contarVistas(mora.filas, filtro);
  const visibles = filtrarMora(mora.filas, filtro);

  const barrioDe = new Map(mora.barrios.map((b) => [b.id, b]));
  const elegibles = visibles
    .filter((f) => f.derivacion === null && f.meses > 0 && barrioDe.get(f.barrioId)?.puedeDerivar === true)
    .map((f) => ({ id: f.unidadFuncionalId, barrioId: f.barrioId, unidad: f.unidad, meses: f.meses, conIntimacion: f.conIntimacion }));
  const idsElegibles = new Set(elegibles.map((e) => e.id));
  const conCasillas = mora.barrios.some((b) => b.puedeDerivar);
  const barriosDelCriterio = mora.barrios.filter((b) => filtro.barrio === null || b.id === filtro.barrio);
  const barriosDeLaIsla: BarrioDeLaIsla[] = mora.barrios.map((b) => ({
    id: b.id,
    nombre: b.nombre,
    pedirIntimacion: b.criterio.pedirIntimacion,
    estudios: b.estudios,
    hrefEstudios: rutaDeMoraYEstudios(b.id),
  }));

  // El filtro de estudio: los que trabajan en algún barrio, más los que tienen derivadas aunque ya no.
  const estudios = new Map<string, string>();
  for (const b of mora.barrios) for (const e of b.estudios) estudios.set(e.id, e.nombre);
  for (const f of mora.filas) if (f.derivacion) estudios.set(f.derivacion.estudioId, f.derivacion.estudio);
  const filtrosDesplegables = [
    ...(conBarrio
      ? [
          {
            nombre: "barrio",
            etiqueta: "Barrio",
            valor: filtro.barrio ?? "",
            opciones: [{ valor: "", texto: "Todos los barrios" }, ...mora.barrios.map((b) => ({ valor: b.id, texto: b.nombre }))],
          },
        ]
      : []),
    {
      nombre: "estudio",
      etiqueta: "Estudio",
      valor: filtro.estudio ?? "",
      opciones: [
        { valor: "", texto: "Todos los estudios" },
        ...[...estudios].sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([valor, texto]) => ({ valor, texto })),
        { valor: SIN_DERIVAR, texto: "Sin derivar" },
      ],
    },
  ];

  return (
    <>
      <FilaDeCifras>
        <CifraDeLaFila etiqueta="con deuda vencida" origen="unidades con algún mes vencido e impago">
          {cifras.con_deuda}
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="para derivar" origen="cumplen el criterio de su barrio">
          {cifras.para_derivar}
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="derivadas" origen="las trabaja un estudio hoy">
          {cifras.derivadas}
        </CifraDeLaFila>
        <CifraDeLaFila etiqueta="promesas vencidas" origen="pasó la fecha sin el pago prometido">
          {cifras.promesa_vencida}
        </CifraDeLaFila>
      </FilaDeCifras>

      <BarraDeFiltros>
        <FiltrosDesplegables
          accion={ruta}
          conservar={{ ...conservar, ...(parametrosDelFiltro(filtro).ver ? { ver: filtro.ver } : {}) }}
          filtros={filtrosDesplegables}
        />
        <FiltrosDeLista etiqueta="Qué unidades ver">
          {VISTAS_MORA.map((v) => (
            <FiltroDeLista key={v} href={hrefDe({ ...filtro, ver: v })} activo={filtro.ver === v} cantidad={cuenta[v]}>
              {TEXTO_VISTA[v]}
            </FiltroDeLista>
          ))}
        </FiltrosDeLista>
      </BarraDeFiltros>

      <SeleccionDeMora
        clave={claveDeFiltro(parametrosDelFiltro(filtro))}
        elegibles={elegibles}
        barrios={barriosDeLaIsla}
        motivos={MOTIVOS_DERIVACION.map((m) => ({ valor: m, texto: TEXTO_MOTIVO_DERIVACION[m] }))}
        conBarrio={conBarrio}
      >
        <ResultadoDeLaDerivacion />
        <Panel
          titulo="Unidades"
          origen={
            <>
              Más meses primero. «Para derivar» usa el criterio {conBarrio ? "de cada barrio" : "del barrio"}: más de
              cierta cantidad de meses de deuda vencida y desde un monto (capital vencido más interés a hoy).
            </>
          }
          sinRelleno
          pie={
            // En el barrio, el criterio va en la bajada de la página; acá, el de cada barrio, plegado.
            conBarrio ? (
              <Desplegable resumen={`Ver el criterio de cada barrio (${barriosDelCriterio.length})`}>
                <ul>
                  {barriosDelCriterio.map((b) => (
                    <li key={b.id}>
                      {b.nombre}: {criterioEnPalabras(b.criterio)} ({ORIGEN_DEL_CRITERIO[b.origenCriterio]}).
                    </li>
                  ))}
                </ul>
              </Desplegable>
            ) : undefined
          }
        >
          {visibles.length === 0 ? (
            <Vacio icono={<IconoBorrador />} titulo={VACIO_DE_LA_VISTA[filtro.ver]}>
              {filtro.ver === "con_deuda" ? (
                "Con este filtro, ninguna unidad debe nada vencido."
              ) : (
                <>
                  Con este filtro no hay ninguna. <Link href={hrefDe({ ...filtro, ver: "con_deuda" })}>Ver las que tienen deuda</Link>.
                </>
              )}
            </Vacio>
          ) : (
            <MarcoTabla etiqueta="Unidades con deuda vencida">
              <Tabla>
                <thead>
                  <tr>
                    {conCasillas ? (
                      <th scope="col">
                        <span className={ui.soloLectores}>Elegir para derivar</span>
                      </th>
                    ) : null}
                    {conBarrio ? <th scope="col">Barrio</th> : null}
                    <th scope="col" className={ui.columnaAncla}>
                      Unidad
                    </th>
                    <th scope="col">Titular</th>
                    <th scope="col" className={ui.numerica}>
                      Meses
                    </th>
                    <th scope="col" className={ui.numerica}>
                      Capital
                    </th>
                    <th scope="col" className={ui.numerica}>
                      Interés a hoy
                    </th>
                    <th scope="col">Situación</th>
                    <th scope="col">Última gestión</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((f) => {
                    const elegible = idsElegibles.has(f.unidadFuncionalId);
                    const gestion = ultimaGestionEnPalabras(f);
                    return (
                      <tr key={f.unidadFuncionalId}>
                        {conCasillas ? <td>{elegible ? <CasillaDeMora unidadId={f.unidadFuncionalId} unidad={f.unidad} /> : null}</td> : null}
                        {conBarrio ? <td>{f.barrio}</td> : null}
                        <th scope="row" className={ui.columnaAncla}>
                          {/* La ficha de mora llega en otra entrega: por ahora, el estado de cuenta de Cobros. */}
                          <Link href={rutaDeUnidad(f.barrioId, f.unidadFuncionalId)}>{f.unidad}</Link>
                        </th>
                        <td>{f.titular ?? <span className={ui.secundaria}>sin titular</span>}</td>
                        <td className={ui.numerica}>{f.meses}</td>
                        <td className={ui.numerica}>
                          <Cifra monto={f.capital} nulo="—" />
                        </td>
                        <td className={ui.numerica}>
                          <Cifra monto={f.interes} nulo="—" />
                        </td>
                        <td>
                          {chipsDeSituacion(f).map((c, i) => (
                            <span key={c.texto}>
                              {i > 0 ? " " : null}
                              <Chip tono={c.tono}>{c.texto}</Chip>
                            </span>
                          ))}
                        </td>
                        <td>
                          {gestion ? (
                            <>
                              <span className={ui.principal}>{gestion.principal}</span>
                              {gestion.resultado ? <span className={ui.secundaria}> · {gestion.resultado}</span> : null}
                            </>
                          ) : (
                            <span className={ui.secundaria}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Tabla>
            </MarcoTabla>
          )}
        </Panel>
        <BarraDeDerivar />
      </SeleccionDeMora>
    </>
  );
}
