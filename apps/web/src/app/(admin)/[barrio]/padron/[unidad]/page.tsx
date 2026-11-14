import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  fichaDeUnidad,
  leerBarrioDelPadron,
  puedeEditarPadron,
  type EventoDeFicha,
  type FichaDeUnidad,
  type TitularDeFicha,
} from "@admin-barrios/data/servicios/padron-edicion";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { formatearDecimal } from "@admin-barrios/shared/dinero";
import { formatearFecha, formatearFechaHora } from "@admin-barrios/shared/fechas";
import {
  ETIQUETA_MOTIVO_BAJA,
  ETIQUETA_MOTIVO_CAMBIO_TITULAR,
  ETIQUETA_RESPALDO_TITULAR,
} from "@admin-barrios/shared/escrituras";
import { AccionDesplegable, Boton, Chip, IconoCheck } from "@admin-barrios/ui";
import {
  Cifra,
  Definicion,
  Definiciones,
  EncabezadoDePagina,
  MarcoTabla,
  Pagina,
  Panel,
  Tabla,
  ui,
} from "../../../../../componentes/ui.tsx";
import { CARACTER_RESIDENTE, etiquetaEstadoUnidad, etiquetaTipoObligado, ROL } from "../../../../../componentes/etiquetas.tsx";
import { SoloLectores } from "../../../../../componentes/formulario.tsx";
import { esIdValido, migaDelBarrio, rutaDelPadron } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { FormularioCambiarTitular } from "./cambiar-titular.tsx";
import { FormularioDarDeBaja } from "./dar-de-baja.tsx";
import { FormularioEditarUnidad } from "./editar-unidad.tsx";
import estilos from "./ficha.module.css";

export const metadata: Metadata = { title: "Ficha de la unidad" };

/** Qué pasó, en palabras (`padron_evento.tipo`). Un tipo nuevo sin rótulo se muestra tal cual. */
const TIPO_DE_EVENTO: Readonly<Record<string, string>> = {
  alta: "Alta",
  alta_planilla: "Alta por planilla",
  edicion: "Edición",
  correccion_planilla: "Corrección por planilla",
  cambio_titular: "Cambio de titular",
  baja: "Baja",
};

/** Los motivos de un evento de la unidad: los del cambio de titular y los de la baja. */
const MOTIVO_DE_EVENTO: Readonly<Record<string, string>> = { ...ETIQUETA_MOTIVO_CAMBIO_TITULAR, ...ETIQUETA_MOTIVO_BAJA };

const rotulo = (tabla: Readonly<Record<string, string>>, valor: string): string => tabla[valor] ?? valor;

/** El respaldo viene como «tipo · referencia»: el tipo se dice con su rótulo. */
function respaldoLegible(respaldo: string): string {
  const [tipo, ...resto] = respaldo.split(" · ");
  return [rotulo(ETIQUETA_RESPALDO_TITULAR, tipo ?? ""), ...resto].join(" · ");
}

const superficieLegible = (s: string | null): string | null => (s === null ? null : `${formatearDecimal(s, 2)} m²`);

/**
 * La ficha de la unidad (pantalla 5 de la maqueta aprobada `alta-barrio-padron.html`, T3 / ADR-0010).
 *
 * Es de lectura y se resuelve entera en el servidor. Las cuatro escrituras —editar, cambiar titular,
 * dar de baja— son islas que se abren en el lugar (`AccionDesplegable`) y **solo se mandan a quien
 * puede escribir** (`puedeEditarPadron`, que es dato para la UI: la autorización la hace la base).
 * Una unidad dada de baja ya no se edita ni cambia de titular: la ficha queda de consulta, con su
 * historia y su deuda (el servicio también lo rechaza).
 */
export default async function FichaDeLaUnidad({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly unidad: string }>;
}) {
  const { barrio: barrioId, unidad: unidadFuncionalId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(unidadFuncionalId)) notFound();

  const datos = await conSesion(async (tx) => {
    const barrio = await leerBarrioDelPadron(tx, { barrioId });
    if (!barrio) return null;
    const ficha = await fichaDeUnidad(tx, { unidadFuncionalId });
    // Una unidad de otro barrio en la URL es el mismo 404 que una que no existe (sin oráculo de tenants).
    if (!ficha || ficha.barrioId !== barrio.id) return null;
    return { barrio, ficha, puedeEditar: await puedeEditarPadron(tx, { barrioId }) };
  });

  if (!datos) notFound();
  const { barrio, ficha, puedeEditar } = datos;
  const escribe = puedeEditar && ficha.baja === null;
  const superficie = superficieLegible(ficha.superficie);
  const bajada = [etiquetaEstadoUnidad(ficha.estado), superficie, `alta el ${formatearFecha(ficha.altaAt)}`]
    .filter((p): p is string => p !== null)
    .join(" · ");

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[
          migaDelBarrio(barrio),
          { texto: "Padrón", href: rutaDelPadron(barrio.id) },
          { texto: ficha.etiqueta },
        ]}
        titulo={<span className={estilos.etiqueta}>{ficha.etiqueta}</span>}
        bajada={
          <>
            {bajada}
            {ficha.baja ? (
              <>
                {" "}
                <Chip tono="alerta">
                  Dada de baja el {formatearFecha(ficha.baja.at)}
                  {ficha.baja.motivo ? ` · ${rotulo(ETIQUETA_MOTIVO_BAJA, ficha.baja.motivo)}` : ""}
                </Chip>
              </>
            ) : null}
          </>
        }
      />

      <div className={estilos.acciones}>
        <Boton href={`/${barrio.id}/cobros/${ficha.id}`} variante="sutil" tamano="sm">
          Estado de cuenta
        </Boton>
        {escribe ? (
          <>
            <AccionDesplegable texto="Editar" variante="secundario">
              <FormularioEditarUnidad
                unidadFuncionalId={ficha.id}
                cuentaPorUnidad={barrio.cuentaPorUnidad}
                superficie={ficha.superficie === null ? "" : formatearDecimal(ficha.superficie, 2)}
                estado={ficha.estado}
                nomenclatura={ficha.nomenclatura ?? ""}
                cbu={ficha.cbu ?? ""}
                alias={ficha.alias ?? ""}
                saldoInicial={ficha.saldoInicial}
                saldoInicialEditable={ficha.saldoInicialEditable}
                mailPrincipal={ficha.contactos.find((c) => c.principal)?.email ?? ficha.titulares.find((t) => t.recibeBoleta)?.email ?? ""}
                numeroAccion={ficha.numeroAccion ?? ""}
                residente={{
                  nombre: ficha.residente?.nombre ?? "",
                  caracter: ficha.residente?.caracter ?? "",
                  telefono: ficha.residente?.telefono ?? "",
                  mail: ficha.residente?.mail ?? "",
                }}
              />
            </AccionDesplegable>
            <AccionDesplegable texto="Dar de baja" variante="peligro">
              <FormularioDarDeBaja unidadFuncionalId={ficha.id} etiqueta={ficha.etiqueta} proximoPeriodo={barrio.proximoPeriodo} />
            </AccionDesplegable>
          </>
        ) : null}
      </div>

      <div className={estilos.ficha}>
        <div className={estilos.columna}>
          <Panel titulo="Código de pago">
            <p className={estilos.codigo}>{ficha.codigoPago}</p>
            <p className={estilos.ayuda}>
              Se imprime en la boleta y es la referencia de la transferencia. No cambia aunque cambie el titular.
            </p>
            <h3 className={estilos.subtitulo}>Unidad</h3>
            <DatosDeLaUnidad ficha={ficha} superficie={superficie} cuentaPorUnidad={barrio.cuentaPorUnidad} />
            <h3 className={estilos.subtitulo}>Residente o inquilino (solo informativo)</h3>
            <Residente ficha={ficha} />
          </Panel>
        </div>

        <div className={estilos.columna}>
          <Panel titulo="Titulares" origen="Los vigentes hoy. Todos responden por la deuda de la unidad; uno solo recibe la boleta.">
            {escribe ? (
              <div className={estilos.desplegable}>
                <AccionDesplegable texto="Cambiar titular" variante="secundario">
                  <FormularioCambiarTitular
                    barrioId={barrio.id}
                    unidadFuncionalId={ficha.id}
                    etiqueta={ficha.etiqueta}
                    hoy={barrio.hoy}
                    deuda={ficha.deuda}
                  />
                </AccionDesplegable>
              </div>
            ) : null}
            {ficha.titulares.length === 0 ? (
              <p className={ui.secundaria}>
                Sin titular.{escribe ? " Cargalo con «Cambiar titular»." : ""}
              </p>
            ) : (
              <TablaDeTitulares titulares={ficha.titulares} etiqueta="Titulares vigentes" vigentes />
            )}

            {ficha.anteriores.length > 0 ? (
              <>
                <h3 className={estilos.subtitulo}>Titulares anteriores</h3>
                <TablaDeTitulares titulares={ficha.anteriores} etiqueta="Titulares anteriores" />
              </>
            ) : null}

            <h3 className={estilos.subtitulo}>Contactos</h3>
            <Contactos ficha={ficha} />

            <h3 className={estilos.subtitulo}>Historial</h3>
            <Historial eventos={ficha.historial} />
          </Panel>
        </div>
      </div>
    </Pagina>
  );
}

function DatosDeLaUnidad({
  ficha,
  superficie,
  cuentaPorUnidad,
}: {
  readonly ficha: FichaDeUnidad;
  readonly superficie: string | null;
  readonly cuentaPorUnidad: boolean;
}) {
  return (
    <Definiciones>
      <Definicion termino="Manzana y lote">{etiquetaUnidad(ficha.manzana, ficha.lote)}</Definicion>
      {/* Solo en los barrios que numeran acciones (`0078`): una fila «sin cargar» en los demás confunde. */}
      {ficha.numeroAccion ? (
        <Definicion termino="N.º de acción">
          <span className={ui.mono}>{ficha.numeroAccion}</span>
        </Definicion>
      ) : null}
      <Definicion termino="Superficie">{superficie ?? <span className={ui.secundaria}>Sin cargar</span>}</Definicion>
      <Definicion termino="Estado">{etiquetaEstadoUnidad(ficha.estado)}</Definicion>
      <Definicion termino="Nomenclatura">
        {ficha.nomenclatura ? <span className={ui.mono}>{ficha.nomenclatura}</span> : <span className={ui.secundaria}>Sin cargar</span>}
      </Definicion>
      <Definicion termino="Saldo inicial">
        <Cifra monto={ficha.saldoInicial} nulo="—" />
      </Definicion>
      {cuentaPorUnidad ? (
        <Definicion termino="Cuenta de la unidad">
          {ficha.cbu || ficha.alias ? (
            <>
              {ficha.cbu ? <span className={ui.mono}>{ficha.cbu}</span> : null}
              {ficha.cbu && ficha.alias ? <br /> : null}
              {ficha.alias ? <span>alias {ficha.alias}</span> : null}
            </>
          ) : (
            <span className={ui.secundaria}>Sin cuenta propia: la boleta imprime la cuenta padre con el código de pago.</span>
          )}
        </Definicion>
      ) : null}
    </Definiciones>
  );
}

/**
 * Quién vive en la unidad cuando no es el propietario (`0078`). Es **solo un dato**: la boleta, el
 * envío y la deuda siguen siendo del propietario, y la ficha lo dice para que nadie lo lea al revés.
 */
function Residente({ ficha }: { readonly ficha: FichaDeUnidad }) {
  const r = ficha.residente;
  return (
    <>
      {r ? (
        <Definiciones>
          <Definicion termino="Nombre">{r.nombre}</Definicion>
          <Definicion termino="Carácter">
            {r.caracter ? CARACTER_RESIDENTE[r.caracter] : <span className={ui.secundaria}>Sin cargar</span>}
          </Definicion>
          <Definicion termino="Teléfono">
            {r.telefono ? <span className={ui.mono}>{r.telefono}</span> : <span className={ui.secundaria}>Sin cargar</span>}
          </Definicion>
          <Definicion termino="Mail">{r.mail ?? <span className={ui.secundaria}>Sin cargar</span>}</Definicion>
        </Definiciones>
      ) : (
        <p className={ui.secundaria}>Sin cargar.</p>
      )}
      <p className={estilos.ayuda}>
        La boleta, el envío y la deuda van siempre al propietario: el residente o inquilino no recibe nada del sistema.
      </p>
    </>
  );
}

function TablaDeTitulares({
  titulares,
  etiqueta,
  vigentes,
}: {
  readonly titulares: readonly TitularDeFicha[];
  readonly etiqueta: string;
  readonly vigentes?: boolean;
}) {
  return (
    <MarcoTabla etiqueta={etiqueta}>
      <Tabla>
        <thead>
          <tr>
            <th scope="col">Persona</th>
            <th scope="col">Carácter</th>
            <th scope="col">{vigentes ? "Desde" : "Desde – hasta"}</th>
            {vigentes ? <th scope="col">Recibe la boleta</th> : null}
          </tr>
        </thead>
        <tbody>
          {titulares.map((t) => (
            <tr key={`${t.obligadoId}-${t.desde}`}>
              <th scope="row">
                <span className={estilos.persona}>
                  <span>{t.nombre}</span>
                  {t.documento ? <small className={`${ui.mono} ${ui.secundaria}`}>{t.documento}</small> : null}
                </span>
              </th>
              <td>{etiquetaTipoObligado(t.caracter)}</td>
              <td>
                <span className={ui.mono}>
                  {formatearFecha(t.desde)}
                  {t.hasta ? ` – ${formatearFecha(t.hasta)}` : ""}
                </span>
              </td>
              {vigentes ? (
                <td>
                  {t.recibeBoleta ? (
                    <>
                      <span aria-hidden>
                        <IconoCheck />
                      </span>
                      <SoloLectores>Sí</SoloLectores>
                    </>
                  ) : (
                    <SoloLectores>No</SoloLectores>
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </Tabla>
    </MarcoTabla>
  );
}

function Contactos({ ficha }: { readonly ficha: FichaDeUnidad }) {
  const telefonos = [...new Set(ficha.titulares.flatMap((t) => (t.telefono ? [t.telefono] : [])))];
  if (ficha.contactos.length === 0 && telefonos.length === 0) {
    return <p className={ui.secundaria}>Sin contactos: la boleta no se puede mandar por mail.</p>;
  }
  return (
    <Definiciones>
      {ficha.contactos.map((c) => (
        <Definicion key={c.email} termino={c.principal ? "Mail principal" : "Otro mail"}>
          {c.email}
        </Definicion>
      ))}
      {telefonos.map((t) => (
        <Definicion key={t} termino="Teléfono">
          <span className={ui.mono}>{t}</span>
        </Definicion>
      ))}
    </Definiciones>
  );
}

function Historial({ eventos }: { readonly eventos: readonly EventoDeFicha[] }) {
  if (eventos.length === 0) return <p className={ui.secundaria}>Sin movimientos en el padrón.</p>;
  return (
    <ol className={estilos.lineaDeTiempo}>
      {eventos.map((e, i) => (
        <li key={`${e.fecha}-${i}`} className={estilos.evento}>
          <span className={estilos.eventoFecha}>{formatearFechaHora(e.fecha)}</span>
          <span className={estilos.eventoCuerpo}>
            <span>
              {rotulo(TIPO_DE_EVENTO, e.tipo)}
              {e.archivo ? ` (${e.archivo})` : ""}
              {e.vigenteDesde ? ` · rige desde el ${formatearFecha(e.vigenteDesde)}` : ""}
              {` · ${ROL[e.rol as keyof typeof ROL] ?? e.rol}`}
            </span>
            {e.detalle ? <span className={estilos.eventoDetalle}>{e.detalle}</span> : null}
            {e.motivo ? <span className={estilos.eventoDetalle}>Motivo: {rotulo(MOTIVO_DE_EVENTO, e.motivo)}</span> : null}
            {e.respaldo ? <span className={estilos.eventoDetalle}>Respaldo: {respaldoLegible(e.respaldo)}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
