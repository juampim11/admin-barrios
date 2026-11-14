import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarConceptosBoleta, type ConceptoBoletaDeLista } from "@admin-barrios/data/servicios/conceptos-boleta";
import { leerComoSeDevenga } from "@admin-barrios/data/servicios/devengado";
import { listarConceptos } from "@admin-barrios/data/servicios/gastos";
import { listarGruposDeUnidades } from "@admin-barrios/data/servicios/grupos";
import { listarPadron } from "@admin-barrios/data/servicios/padron";
import { puedeEditarPadron } from "@admin-barrios/data/servicios/padron-edicion";
import { METODOS_CONCEPTO_BOLETA, type MetodoConceptoBoleta } from "@admin-barrios/shared/conceptos";
import { origenDeModelo } from "@admin-barrios/shared/devengado";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { Boton, Chip, GrupoDeParametros, PanelDesplegable } from "@admin-barrios/ui";
import { comoSeLlama } from "../../../../../componentes/etiquetas.tsx";
import { EncabezadoDePagina, MarcoTabla, Nota, Pagina, Panel, Tabla, TiraDeChips, Vacio, ui } from "../../../../../componentes/ui.tsx";
import { esIdValido, hrefDeLista, migaDelBarrio, rutaDeConceptosDelBarrio } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { ANCLA_COMO_SE_DEVENGA } from "../devengado.tsx";
import {
  BorrarGrupo,
  FormularioDeConceptoNuevo,
  FormularioDeEdicionDeConcepto,
  FormularioDeEdicionDeGrupo,
  FormularioDeGrupoNuevo,
  FormularioDeValor,
} from "./formularios.tsx";
import { aQuienVa, cadaMes, comoSeCalcula, comoSeReparteElGasto, cuantasUnidades, resumenDeUnidades, sumaOResta } from "./textos.ts";
import estilos from "./conceptos.module.css";

export const metadata: Metadata = { title: "Conceptos del barrio" };

/** Las anclas de los dos paneles de edición: el enlace «Editar» lleva la pantalla hasta ahí. */
const ANCLA_EDITAR = "editar-concepto";
const ANCLA_GRUPO = "editar-grupo";

const esMetodo = (m: string): m is MetodoConceptoBoleta => (METODOS_CONCEPTO_BOLETA as readonly string[]).includes(m);

/**
 * **Conceptos del barrio** (encargo 16b; maqueta, pantalla 2): todo lo que puede aparecer en el cupón
 * de una unidad, y los grupos de unidades.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * DOS CATÁLOGOS, UNA PANTALLA
 *
 * Por dentro son dos catálogos y no se unen: los **conceptos de boleta** (lo que suma o resta en el
 * cupón de una unidad: un uso, una multa, una bonificación) y los **conceptos de gasto** (lo que el
 * barrio gasta y se reparte entre las unidades). La pantalla los muestra juntos, cada uno en su
 * tabla. Los de gasto son de solo lectura: hoy no hay alta de ese catálogo desde la aplicación, y la
 * pantalla no la inventa. Se muestran **todos** —no solo los extraordinarios— porque el título dice
 * «todo lo que puede aparecer en el cupón»; el extraordinario va marcado con que pide acta.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTA PANTALLA NO DECIDE
 *
 * - **Quién edita.** El catálogo y los grupos los define la administración del barrio; lo hacen
 *   cumplir el servicio y la base. Acá se pregunta (`puedeEditarPadron`: el mismo permiso) para no
 *   ofrecer un botón que se va a rechazar: a quien no puede se le muestran las tablas, sin acciones.
 * - **Qué combinaciones valen.** Lo dice `revisarComoEntraElConcepto`, que consultan el formulario,
 *   el esquema y el servicio.
 * - **Ningún texto asume un modelo.** Lo que se dice de los gastos depende de dónde sale el importe
 *   del mes en este barrio («Cómo se devenga»), y lo que se cobra se nombra como lo llama el barrio.
 *
 * Es servidor de punta a punta: «Editar» es un enlace (`?editar=`, `?grupo=`) y lo que se abre para
 * cargar es `<details>`. El único JavaScript son los formularios, y solo para quien puede editar.
 * Las tablas son de servidor (regla 8); la única pieza con estado es la lista de unidades de un
 * grupo, que junta búsqueda instantánea y selección múltiple (ver `SelectorDeUnidades`).
 */
export default async function ConceptosDelBarrio({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();
  const sp = await searchParams;
  const idDe = (clave: string): string | null => {
    const v = sp[clave];
    return typeof v === "string" && esIdValido(v) ? v : null;
  };

  // Secuenciales y en una transacción: `node-postgres` encola las consultas del mismo client.
  const datos = await conSesion(async (tx) => {
    const barrio = await leerBarrio(tx, { barrioId });
    if (!barrio) return null;
    const puede = await puedeEditarPadron(tx, { barrioId });
    return {
      barrio,
      puede,
      deBoleta: await listarConceptosBoleta(tx, { barrioId }),
      deGasto: await listarConceptos(tx, { barrioId }),
      grupos: await listarGruposDeUnidades(tx, { barrioId }),
      devengado: await leerComoSeDevenga(tx, { barrioId }),
      // El padrón para armar grupos (techo del esquema: 500). Solo lo necesita quien puede editar.
      padron: puede ? await listarPadron(tx, { barrioId, limite: 500 }) : null,
    };
  });
  if (!datos) notFound();
  const { barrio, puede, deBoleta, deGasto, grupos, devengado, padron } = datos;

  const ruta = rutaDeConceptosDelBarrio(barrio.id);
  const denominacion = comoSeLlama(barrio.denominacionConcepto);
  // Si el barrio todavía no cargó «Cómo se devenga», rige lo de siempre según su modelo.
  const origen = devengado?.vigente.origen ?? (barrio.modelo ? origenDeModelo(barrio.modelo) : null);
  const modoDeLaBonificacion = devengado?.vigente.bonificacion.modo ?? "a_mano";
  const hrefComoSeDevenga = `/${barrio.id}/configuracion#${ANCLA_COMO_SE_DEVENGA}`;

  const enEdicion = puede ? (deBoleta.find((c) => c.id === idDe("editar") && !c.deLaRegla) ?? null) : null;
  const grupoEnEdicion = puede ? (grupos.find((g) => g.id === idDe("grupo")) ?? null) : null;
  const gruposParaElegir = grupos.map((g) => ({ id: g.id, nombre: g.nombre, unidades: g.unidades.length }));

  /*
   * Las unidades que se ofrecen para un grupo: las activas del padrón y, además, las que el grupo ya
   * tiene. Editar manda la lista COMPLETA: si una unidad del grupo no estuviera entre las casillas
   * (un barrio de más de 500), guardar la sacaría sin que nadie lo decidiera.
   */
  const unidadesDelPadron = (padron?.unidades ?? []).filter((u) => !u.dadaDeBaja).map((u) => ({ id: u.id, etiqueta: u.etiqueta }));
  const unidadesPara = (grupo: (typeof grupos)[number] | null) => {
    const yaEstan = new Set(unidadesDelPadron.map((u) => u.id));
    return [...unidadesDelPadron, ...(grupo?.unidades ?? []).filter((u) => !yaEstan.has(u.id))];
  };
  const padronRecortado = padron !== null && padron.total > padron.unidades.length;

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio(barrio), { texto: "Configuración del barrio", href: `/${barrio.id}/configuracion` }, { texto: "Conceptos" }]}
        titulo="Conceptos del barrio"
        bajada="Todo lo que puede aparecer en el cupón de una unidad. Cada concepto dice a quién va y cómo se calcula. Se cargan una vez."
        acciones={puede ? null : <Chip tono="neutro">Solo lectura</Chip>}
      />

      {puede ? null : (
        <Nota tono="neutro" titulo="Estás viendo los conceptos en modo de solo lectura.">
          Los define la administración del barrio.
        </Nota>
      )}

      <Panel
        titulo="Lo que suma o resta en el cupón de una unidad"
        origen="Con el valor que rige hoy. Lo ya aplicado en un mes conserva el valor que tenía cuando se aplicó."
        sinRelleno
      >
        {deBoleta.length === 0 ? (
          <Vacio titulo="Este barrio todavía no tiene conceptos">
            {puede ? "Cargá el primero con «Nuevo concepto», acá abajo." : "Los carga la administración del barrio."}
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Conceptos que suman o restan en el cupón de una unidad">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Concepto
                  </th>
                  <th scope="col">A quién va</th>
                  <th scope="col">Cómo se calcula</th>
                  <th scope="col">Cada mes</th>
                  {puede ? <th scope="col">Acción</th> : null}
                </tr>
              </thead>
              <tbody>
                {deBoleta.map((c) => (
                  <FilaDeConcepto
                    key={c.id}
                    concepto={c}
                    denominacion={denominacion}
                    modoDeLaBonificacion={modoDeLaBonificacion}
                    puede={puede}
                    hrefEditar={`${hrefDeLista(ruta, { editar: c.id })}#${ANCLA_EDITAR}`}
                    hrefComoSeDevenga={hrefComoSeDevenga}
                    enEdicion={enEdicion?.id === c.id}
                  />
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>

      {enEdicion && esMetodo(enEdicion.metodo) ? (
        <GrupoDeParametros id={ANCLA_EDITAR} titulo={`Editar «${enEdicion.nombre}»`}>
          <Panel
            titulo="Nombre, a quién va y cómo entra cada mes"
            origen={`${sumaOResta(enEdicion.clase)} · ${comoSeCalcula(enEdicion, denominacion)}. Si suma o resta y cómo se calcula no se cambian: son lo que el concepto es.`}
          >
            <FormularioDeEdicionDeConcepto
              concepto={{
                id: enEdicion.id,
                nombre: enEdicion.nombre,
                activo: enEdicion.activo,
                clase: enEdicion.clase,
                metodo: enEdicion.metodo,
                destinatario: enEdicion.destinatario,
                grupoId: enEdicion.grupoId,
                modoMes: enEdicion.modoMes,
                unidadUso: enEdicion.unidadUso,
              }}
              grupos={gruposParaElegir}
              volverA={ruta}
            />
          </Panel>
          {enEdicion.metodo === "importe_libre" ? (
            <Nota tono="info" titulo="Este concepto no tiene un valor que cambiar.">
              El importe se escribe cada vez que se aplica a una unidad.
            </Nota>
          ) : (
            <Panel
              titulo="Cambiar el valor"
              origen={
                enEdicion.valorVigente
                  ? `Hoy rige ${comoSeCalcula(enEdicion, denominacion)}, desde el ${formatearFecha(enEdicion.valorVigente.vigenteDesde)}.`
                  : "Hoy no rige ningún valor: con fecha de hoy, este concepto no se puede aplicar."
              }
            >
              <FormularioDeValor
                conceptoBoletaId={enEdicion.id}
                nombre={enEdicion.nombre}
                metodo={enEdicion.metodo}
                denominacion={denominacion}
                vigente={
                  enEdicion.valorVigente
                    ? {
                        montoFijo: enEdicion.valorVigente.montoFijo,
                        porcentaje: enEdicion.valorVigente.porcentaje,
                        precioUnitario: enEdicion.valorVigente.precioUnitario,
                        tope: enEdicion.valorVigente.tope,
                      }
                    : null
                }
              />
            </Panel>
          )}
        </GrupoDeParametros>
      ) : null}

      {puede && devengado ? (
        <PanelDesplegable
          titulo="Nuevo concepto"
          origen="Un concepto se carga con su primer valor. Después se le puede cambiar el nombre, a quién va, cómo entra cada mes y el valor."
        >
          <FormularioDeConceptoNuevo
            barrioId={barrio.id}
            grupos={gruposParaElegir}
            rigeDesde={`${devengado.mesEnCurso}-01`}
            denominacion={denominacion}
          />
        </PanelDesplegable>
      ) : null}

      <Panel
        titulo="Gastos que se reparten"
        origen={
          <>
            Lo que el barrio gasta y se carga en el mes, en «Gastos y pagos». Qué pasa con cada uno en el cupón depende de{" "}
            <Link href={hrefComoSeDevenga}>cómo se devenga</Link> en este barrio. Este catálogo todavía no se edita desde acá.
          </>
        }
        sinRelleno
      >
        {deGasto.length === 0 ? (
          <Vacio titulo="Este barrio no tiene conceptos de gasto cargados" />
        ) : (
          <MarcoTabla etiqueta="Conceptos de gasto del barrio">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Concepto
                  </th>
                  <th scope="col">A quién va</th>
                  <th scope="col">Cómo se calcula</th>
                  <th scope="col">Cada mes</th>
                </tr>
              </thead>
              <tbody>
                {deGasto.map((g) => (
                  <tr key={g.id}>
                    <th scope="row" className={ui.columnaAncla}>
                      <span className={estilos.apilado}>
                        <span className={ui.principal}>{g.nombre}</span>
                        <span className={ui.secundaria}>
                          {g.tipo === "extraordinaria"
                            ? "Suma · pide acta de asamblea"
                            : g.esFondoReserva
                              ? "Fondo de reserva"
                              : "Gasto de todos los meses"}
                        </span>
                        {g.activo ? null : (
                          <span>
                            <Chip tono="neutro">Desactivado</Chip>
                          </span>
                        )}
                      </span>
                    </th>
                    <td>Todas las unidades</td>
                    <td>{comoSeReparteElGasto(g.tipo, origen)}</td>
                    <td>A mano: se carga como gasto del mes</td>
                  </tr>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>

      <Panel
        titulo="Grupos de unidades"
        origen="Una lista de unidades con nombre, para un concepto que va solo a algunas. Las unidades del grupo se toman al calcular cada mes."
        sinRelleno
      >
        {grupos.length === 0 ? (
          <Vacio titulo="Todavía no hay grupos">
            {puede ? "Armá uno con «Nuevo grupo», acá abajo, eligiendo unidades del padrón." : "Los arma la administración del barrio."}
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Grupos de unidades del barrio">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Grupo
                  </th>
                  <th scope="col">Unidades</th>
                  <th scope="col">Lo usan</th>
                  {puede ? <th scope="col">Acción</th> : null}
                </tr>
              </thead>
              <tbody>
                {grupos.map((g) => (
                  <tr key={g.id}>
                    <th scope="row" className={ui.columnaAncla}>
                      <span className={ui.principal}>{g.nombre}</span>
                    </th>
                    <td>
                      <span className={estilos.apilado}>
                        <span>{cuantasUnidades(g.unidades.length)}</span>
                        <span className={ui.secundaria}>{resumenDeUnidades(g.unidades.map((u) => u.etiqueta))}</span>
                      </span>
                    </td>
                    <td>{g.usadoPor.length === 0 ? <span className={ui.secundaria}>Ningún concepto</span> : g.usadoPor.join(", ")}</td>
                    {puede ? (
                      <td>
                        {grupoEnEdicion?.id === g.id ? (
                          <span className={ui.secundaria}>Editando, más abajo</span>
                        ) : (
                          <Boton href={`${hrefDeLista(ruta, { grupo: g.id })}#${ANCLA_GRUPO}`} variante="sutil" tamano="sm">
                            Editar unidades
                          </Boton>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>

      {padronRecortado ? (
        <Nota tono="alerta" titulo="El padrón de este barrio tiene más unidades de las que se pueden listar acá.">
          Para armar un grupo se ofrecen las primeras {padron?.unidades.length}. Las que un grupo ya tiene no se pierden al guardar.
        </Nota>
      ) : null}

      {grupoEnEdicion ? (
        <GrupoDeParametros id={ANCLA_GRUPO} titulo={`Editar el grupo «${grupoEnEdicion.nombre}»`}>
          <Panel titulo="Nombre y unidades">
            <FormularioDeEdicionDeGrupo
              grupo={{ id: grupoEnEdicion.id, nombre: grupoEnEdicion.nombre, unidades: grupoEnEdicion.unidades.map((u) => u.id) }}
              unidades={unidadesPara(grupoEnEdicion)}
              volverA={ruta}
            />
          </Panel>
          {grupoEnEdicion.usadoPor.length === 0 ? (
            <Panel titulo="Borrar el grupo">
              <BorrarGrupo grupoId={grupoEnEdicion.id} nombre={grupoEnEdicion.nombre} volverA={ruta} />
            </Panel>
          ) : (
            <p className={ui.secundaria}>
              Este grupo no se puede borrar mientras lo use {grupoEnEdicion.usadoPor.length === 1 ? "el concepto" : "los conceptos"}{" "}
              {grupoEnEdicion.usadoPor.map((n) => `«${n}»`).join(", ")}. Cambiá primero a quién va.
            </p>
          )}
        </GrupoDeParametros>
      ) : null}

      {puede ? (
        <PanelDesplegable titulo="Nuevo grupo" origen="Poné un nombre y marcá las unidades del padrón que lo forman.">
          <FormularioDeGrupoNuevo barrioId={barrio.id} unidades={unidadesPara(null)} />
        </PanelDesplegable>
      ) : null}
    </Pagina>
  );
}

function FilaDeConcepto({
  concepto: c,
  denominacion,
  modoDeLaBonificacion,
  puede,
  hrefEditar,
  hrefComoSeDevenga,
  enEdicion,
}: {
  readonly concepto: ConceptoBoletaDeLista;
  readonly denominacion: string;
  readonly modoDeLaBonificacion: "sola" | "a_mano" | "no";
  readonly puede: boolean;
  readonly hrefEditar: string;
  readonly hrefComoSeDevenga: string;
  readonly enEdicion: boolean;
}) {
  return (
    <tr>
      <th scope="row" className={ui.columnaAncla}>
        <span className={estilos.apilado}>
          <span className={ui.principal}>{c.nombre}</span>
          <TiraDeChips>
            <Chip tono={c.clase === "cargo" ? "info" : "exito"}>{sumaOResta(c.clase)}</Chip>
            {c.activo ? null : <Chip tono="neutro">Desactivado</Chip>}
          </TiraDeChips>
        </span>
      </th>
      <td>{aQuienVa(c, modoDeLaBonificacion)}</td>
      <td>
        {c.deLaRegla && c.valorVigente === null ? (
          // El valor de la bonificación se carga con su regla, con vigencia por mes.
          <span className={ui.secundaria}>Se define en «Cómo se devenga»</span>
        ) : c.valorVigente === null && c.metodo !== "importe_libre" ? (
          <span className={ui.secundaria}>{comoSeCalcula(c, denominacion)}</span>
        ) : (
          comoSeCalcula(c, denominacion)
        )}
      </td>
      <td>{cadaMes(c, modoDeLaBonificacion)}</td>
      {puede ? (
        <td>
          {c.deLaRegla ? (
            <Link href={hrefComoSeDevenga}>Cómo se devenga</Link>
          ) : enEdicion ? (
            <span className={ui.secundaria}>Editando, más abajo</span>
          ) : (
            <Boton href={hrefEditar} variante="sutil" tamano="sm">
              Editar
            </Boton>
          )}
        </td>
      ) : null}
    </tr>
  );
}
