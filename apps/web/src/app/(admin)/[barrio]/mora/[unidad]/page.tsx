import type { Metadata } from "next";
import { Fragment, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { fichaDeMora, type DerivacionDeLaFicha, type GestionDeLaFicha } from "@admin-barrios/data/servicios/gestiones";
import { formatearFecha, formatearFechaHora, formatearPeriodo } from "@admin-barrios/shared/fechas";
import {
  CANAL_DE_CONTACTO,
  CANALES_CON_ADJUNTO,
  CANALES_REGISTRABLES,
  MOTIVOS_RETIRO,
  PLAZO_MAXIMO_PROMESA_DIAS,
  RESULTADOS_GESTION,
  TEXTO_CANAL,
  TEXTO_MOTIVO_DERIVACION,
  TEXTO_MOTIVO_RETIRO,
  TEXTO_RESULTADO,
  type CanalRegistrable,
} from "@admin-barrios/shared/mora";
import { Boton, Chip, CifraDeLaFila, FilaDeCifras, PestanaDelMes, PestanasDelMes, TextoDeOrigen } from "@admin-barrios/ui";
import { IconoAdjunto, IconoBorrador } from "../../../../../componentes/iconos.tsx";
import { Cifra, Definicion, Definiciones, EncabezadoDePagina, MarcoTabla, Pagina, Panel, Tabla, Vacio, ui } from "../../../../../componentes/ui.tsx";
import {
  BotonAnularGestion,
  BotonesDeContacto,
  BotonRegistrarGestion,
  BotonRetirarDelEstudio,
  FranjaDeGestion,
  IslaDeLaFicha,
  ListoDeLaFicha,
  type ContactoDeLaIsla,
  type FranjaDeLaIsla,
} from "../../../../../componentes/mora/ficha-de-mora.tsx";
import {
  boletasVencidas,
  botonesDeContacto,
  etiquetasDeLaFicha,
  fechaDeMarca,
  motivosDeContacto,
  textoDeLaFranja,
  textoDeLaPromesa,
} from "../../../../../componentes/mora/ficha.ts";
import { diaYMes } from "../../../../../componentes/mora/textos.ts";
import {
  esIdValido,
  migaDelBarrio,
  rutaDeFichaDeMora,
  rutaDeMoraDelBarrio,
  rutaDelAdjuntoDeGestion,
  rutaDeUnidad,
  volverALaMora,
} from "../../../../../rutas.ts";
import { subidaConfigurada } from "../../../../../servidor/almacenamiento.ts";
import { conSesion } from "../../../../../servidor/db.ts";

export const metadata: Metadata = { title: "Ficha de mora" };

/**
 * **La ficha de mora de una unidad** (encargo E-a2; maqueta de mora, pantalla 3): cuánto debe y desde
 * cuándo, quién la gestiona, las gestiones de la administración y del estudio juntas, y cada
 * derivación con la foto de la deuda de ese día.
 *
 * Una lectura: `fichaDeMora`, bajo RLS. El barrio de la URL elige, no autoriza: si la unidad no es de
 * ese barrio, es un 404 igual que si no existiera. Las cifras salen de `deudaALaFecha` (la cuenta del
 * estado de cuenta y de la boleta) y cada una dice de dónde sale.
 *
 * Servidor de punta a punta; lo único de cliente es la isla (`ficha-de-mora.tsx`): los botones de
 * contacto con su franja y los diálogos de registrar, anular y retirar.
 *
 * **Desvío de la maqueta:** la maqueta tiene cinco pestañas; acá van las dos que son de la mora
 * (Gestiones y Derivaciones). «Estado de cuenta», «Boletas» y «Titulares» ya existen en Cobros y en
 * el padrón: el botón «Estado de cuenta» lleva ahí, en vez de duplicar esas pantallas adentro de esta.
 */
export default async function FichaDeMoraDeLaUnidad({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly unidad: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId, unidad: unidadId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(unidadId)) notFound();
  const crudos = await searchParams;
  const ver = crudos["ver"] === "derivaciones" ? "derivaciones" : "gestiones";
  // La lista de la que se vino, con sus filtros (para la miga «Mora»). Solo una ruta interna de mora.
  const volver = volverALaMora(crudos["volver"], rutaDeMoraDelBarrio(barrioId));
  const volverCrudo = volver === rutaDeMoraDelBarrio(barrioId) ? null : volver;

  const ficha = await conSesion((tx) => fichaDeMora(tx, { unidadFuncionalId: unidadId }));
  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  if (!ficha || ficha.barrio.id !== barrioId) notFound();

  const unidad = ficha.unidad.etiqueta;
  const vigente = ficha.derivacionVigente;
  // Los botones de contacto —y con ellos el `tel:` y el `mailto:`— solo para quien registra gestiones
  // (security-engineer): el contador o el auditor no reciben el teléfono ni el mail en la página.
  const contactos = ficha.puedeRegistrar ? botonesDeContacto(ficha.titular) : [];
  const motivos = motivosDeContacto(contactos);
  const contactosDeLaIsla: ContactoDeLaIsla[] = contactos.map((c) => ({
    canal: CANAL_DE_CONTACTO[c.accion],
    texto: c.texto,
    href: c.href,
    motivo: c.motivo,
    nuevaPestana: c.accion === "whatsapp",
  }));
  const etiquetas = etiquetasDeLaFicha(ficha);
  const aQuien = ficha.titular?.nombre ?? unidad;
  const franjas: Record<string, FranjaDeLaIsla> = Object.fromEntries(
    Object.values(CANAL_DE_CONTACTO).map((canal: CanalRegistrable) => [canal, textoDeLaFranja(canal, aQuien)]),
  );

  return (
    <IslaDeLaFicha
      unidadId={ficha.unidad.id}
      unidad={unidad}
      hoy={ficha.hoy}
      puedeRegistrar={ficha.puedeRegistrar}
      subidaConfigurada={subidaConfigurada()}
      canales={CANALES_REGISTRABLES.map((c) => ({ valor: c, texto: TEXTO_CANAL[c] }))}
      canalesConAdjunto={CANALES_CON_ADJUNTO}
      resultados={RESULTADOS_GESTION.map((r) => ({ valor: r, texto: TEXTO_RESULTADO[r] }))}
      promesaDeAyuda={`Hasta ${PLAZO_MAXIMO_PROMESA_DIAS} días desde hoy (el ${formatearFecha(ficha.promesaMaxima)}).`}
      promesaMaxima={ficha.promesaMaxima}
      franjas={franjas}
      motivosDeRetiro={MOTIVOS_RETIRO.map((m) => ({ valor: m, texto: TEXTO_MOTIVO_RETIRO[m] }))}
    >
      <Pagina>
        <EncabezadoDePagina
          migas={[migaDelBarrio(ficha.barrio), { texto: "Mora", href: volver }, { texto: unidad }]}
          titulo={unidad}
          etiquetas={
            etiquetas.length > 0
              ? etiquetas.map((e) => (
                  <Chip key={e.texto} tono={e.tono}>
                    {e.texto}
                  </Chip>
                ))
              : null
          }
          bajada={
            <>
              {ficha.titular?.nombre ?? "Sin titular cargado en el padrón"}.
              {vigente ? ` Derivada por: ${TEXTO_MOTIVO_DERIVACION[vigente.motivo]}.` : null}
              {vigente?.nota ? ` Nota para el estudio: «${vigente.nota}»` : null}
            </>
          }
          acciones={
            <>
              {contactosDeLaIsla.length > 0 ? <BotonesDeContacto contactos={contactosDeLaIsla} /> : null}
              <Boton href={rutaDeUnidad(barrioId, unidadId)} tamano="sm">
                Estado de cuenta
              </Boton>
              {vigente && ficha.puedeRetirar ? <BotonRetirarDelEstudio derivacionId={vigente.id} estudio={vigente.estudio} /> : null}
              {ficha.puedeRegistrar ? <BotonRegistrarGestion /> : null}
            </>
          }
        />
        {motivos.length > 0 ? (
          <p>
            <TextoDeOrigen>{motivos.join(" ")}</TextoDeOrigen>
          </p>
        ) : null}

        <FranjaDeGestion />
        <ListoDeLaFicha />

        <FilaDeCifras>
          <CifraDeLaFila etiqueta="capital vencido" origen={boletasVencidas(ficha.periodosVencidos)}>
            <Cifra monto={ficha.capitalVencido} nulo="—" />
          </CifraDeLaFila>
          <CifraDeLaFila etiqueta="interés a hoy" origen={`tasa del barrio · al ${diaYMes(ficha.hoy)}`}>
            <Cifra monto={ficha.interes} nulo="—" />
          </CifraDeLaFila>
          <CifraDeLaFila
            etiqueta="días de atraso"
            origen={ficha.atraso ? `desde el ${formatearFecha(ficha.atraso.desde)}` : "ninguna boleta vencida sin cubrir"}
          >
            {ficha.atraso ? ficha.atraso.dias : "—"}
          </CifraDeLaFila>
        </FilaDeCifras>

        <PestanasDelMes etiqueta="Partes de la ficha">
          <PestanaDelMes href={rutaDeFichaDeMora(barrioId, unidadId, { volver: volverCrudo })} activa={ver === "gestiones"} cantidad={ficha.gestiones.length}>
            Gestiones
          </PestanaDelMes>
          <PestanaDelMes
            href={rutaDeFichaDeMora(barrioId, unidadId, { ver: "derivaciones", volver: volverCrudo })}
            activa={ver === "derivaciones"}
            cantidad={ficha.derivaciones.length}
          >
            Derivaciones
          </PestanaDelMes>
        </PestanasDelMes>

        {ver === "gestiones" ? (
          <Gestiones
            gestiones={ficha.gestiones}
            puedeRegistrar={ficha.puedeRegistrar}
            estudios={new Set(ficha.derivaciones.map((d) => d.estudio))}
          />
        ) : (
          <Derivaciones derivaciones={ficha.derivaciones} />
        )}
      </Pagina>
    </IslaDeLaFicha>
  );
}

/** Lo que dice una gestión en una línea: para el diálogo de anular («¿cuál es?»). */
function descripcionDe(g: GestionDeLaFicha): string {
  return [formatearFechaHora(g.registradoAt), TEXTO_CANAL[g.canal], g.resultado ? TEXTO_RESULTADO[g.resultado] : null, g.nota]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

/** El contenido de una celda: tachado si la gestión está anulada (`<del>`, que además se anuncia). */
function Tachable({ anulada, children }: { readonly anulada: boolean; readonly children: ReactNode }) {
  return anulada ? <del>{children}</del> : <>{children}</>;
}

/** El Resultado de una gestión; el renglón de una derivación que después se retiró dice el retiro. */
function resultadoDe(g: GestionDeLaFicha): string {
  if (g.canal === "derivacion" && g.retiradaEl) return `Retirada del estudio el ${formatearFecha(g.retiradaEl)}`;
  return g.resultado ? TEXTO_RESULTADO[g.resultado] : "—";
}

function Gestiones({
  gestiones,
  puedeRegistrar,
  estudios,
}: {
  readonly gestiones: readonly GestionDeLaFicha[];
  readonly puedeRegistrar: boolean;
  /** Los nombres de los estudios de la unidad: si `quien` es uno, el chip ya lo dice. */
  readonly estudios: ReadonlySet<string>;
}) {
  return (
    <Panel
      titulo="Gestiones"
      origen="Las de la administración y las del estudio, juntas, las más nuevas primero. Una gestión no se edita: se anula con motivo y queda tachada."
      sinRelleno
    >
      {gestiones.length === 0 ? (
        <Vacio icono={<IconoBorrador />} titulo="Todavía no hay gestiones">
          {puedeRegistrar ? "Registrá la primera con «Registrar gestión»." : "Cuando la administración o el estudio registren una, aparece acá."}
        </Vacio>
      ) : (
        <MarcoTabla etiqueta="Gestiones de la unidad">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Fecha
                </th>
                <th scope="col">Quién</th>
                <th scope="col">Canal</th>
                <th scope="col">Resultado</th>
                <th scope="col">Promesa</th>
                <th scope="col">Nota</th>
                <th scope="col">
                  <span className={ui.soloLectores}>Anular o anulada</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {gestiones.map((g) => {
                const anulada = g.anulacion !== null;
                const promesa = g.promesa ? textoDeLaPromesa(g.promesa) : null;
                return (
                  <tr key={g.id}>
                    <th scope="row" className={ui.columnaAncla}>
                      <Tachable anulada={anulada}>{formatearFechaHora(g.registradoAt)}</Tachable>
                    </th>
                    <td>
                      {g.autor === "estudio" && g.quien && estudios.has(g.quien) ? (
                        // La cargó «el estudio» sin una persona conocida: el chip con su nombre alcanza.
                        <Chip tono="derivada">{g.quien}</Chip>
                      ) : (
                        <>
                          <Chip tono={g.autor === "estudio" ? "derivada" : "marca"}>{g.autor === "estudio" ? "Estudio" : "Administración"}</Chip>
                          {g.quien ? <span className={ui.secundaria}> {g.quien}</span> : null}
                        </>
                      )}
                    </td>
                    <td>
                      <Tachable anulada={anulada}>{TEXTO_CANAL[g.canal]}</Tachable>
                    </td>
                    <td>
                      <Tachable anulada={anulada}>{resultadoDe(g)}</Tachable>
                    </td>
                    <td>
                      {promesa ? (
                        <>
                          {anulada ? null : <Chip tono={promesa.chip.tono}>{promesa.chip.texto}</Chip>}{" "}
                          <Tachable anulada={anulada}>{promesa.detalle}</Tachable>
                          {promesa.pagado && !anulada ? <span className={ui.secundaria}> · {promesa.pagado}</span> : null}
                        </>
                      ) : null}
                    </td>
                    <td>
                      <Tachable anulada={anulada}>{g.nota ?? ""}</Tachable>
                      {g.adjunto ? (
                        <>
                          {g.nota ? " " : null}
                          <a href={rutaDelAdjuntoDeGestion(g.id)} aria-label={`Descargar el adjunto ${g.adjunto.nombre}`}>
                            <IconoAdjunto /> {g.adjunto.nombre}
                          </a>
                        </>
                      ) : null}
                      {g.anulacion ? (
                        <span className={ui.secundaria}>
                          {" "}
                          Anulada el {diaYMes(g.anulacion.at.slice(0, 10))}: {g.anulacion.motivo}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {anulada ? <Chip tono="neutro">Anulada</Chip> : null}
                      {g.anulable ? (
                        <BotonAnularGestion
                          gestion={{ id: g.id, descripcion: descripcionDe(g) }}
                          etiqueta={`Anular la gestión del ${formatearFechaHora(g.registradoAt)} (${TEXTO_CANAL[g.canal]})`}
                        />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Tabla>
        </MarcoTabla>
      )}
    </Panel>
  );
}

function Derivaciones({ derivaciones }: { readonly derivaciones: readonly DerivacionDeLaFicha[] }) {
  if (derivaciones.length === 0) {
    return (
      <Panel titulo="Derivaciones">
        <Vacio icono={<IconoBorrador />} titulo="La unidad nunca se derivó a un estudio">
          Se deriva desde la mora del barrio, eligiendo la unidad.
        </Vacio>
      </Panel>
    );
  }
  return (
    <>
      {derivaciones.map((d) => (
        <Fragment key={d.id}>
          <Panel
            titulo={`Derivada a ${d.estudio}`}
            origen={`El ${fechaDeMarca(d.derivadaAt)}${d.retiro ? "." : "; la trabaja hoy."}`}
            acciones={d.retiro ? <Chip tono="neutro">Retirada</Chip> : <Chip tono="derivada">Vigente</Chip>}
          >
            <Definiciones>
              <Definicion termino="Motivo">{TEXTO_MOTIVO_DERIVACION[d.motivo]}</Definicion>
              {d.nota ? <Definicion termino="Nota">{d.nota}</Definicion> : null}
              {d.retiro ? (
                <Definicion termino="Retiro">
                  {TEXTO_MOTIVO_RETIRO[d.retiro.motivo]}, el {fechaDeMarca(d.retiro.at)}
                  {d.retiro.nota ? `: «${d.retiro.nota}»` : ""}
                </Definicion>
              ) : null}
            </Definiciones>
          </Panel>
          <FotoDeLaDerivacion derivacion={d} />
        </Fragment>
      ))}
    </>
  );
}

function FotoDeLaDerivacion({ derivacion: d }: { readonly derivacion: DerivacionDeLaFicha }) {
  const foto = d.foto;
  if (!foto) {
    return (
      <Panel titulo="Foto de la deuda">
        <Vacio titulo="Esta derivación no tiene foto guardada" />
      </Panel>
    );
  }
  return (
    <Panel
      titulo={`Foto de la deuda al ${formatearFecha(foto.fecha)}`}
      origen="Lo que debía la unidad el día de la derivación, mes por mes, tal como se guardó. No se recalcula: lo que pasó después (pagos, interés nuevo) está en el estado de cuenta."
      sinRelleno
      pie={
        <FilaDeCifras>
          <CifraDeLaFila etiqueta="capital" origen="vencido y a vencer">
            <Cifra monto={foto.capital} nulo="—" />
          </CifraDeLaFila>
          <CifraDeLaFila etiqueta="capital vencido" origen="solo los meses vencidos">
            <Cifra monto={foto.capitalVencido} nulo="—" />
          </CifraDeLaFila>
          <CifraDeLaFila etiqueta="interés" origen={`tasa del barrio · al ${formatearFecha(foto.fecha)}`}>
            <Cifra monto={foto.interes} nulo="—" />
          </CifraDeLaFila>
          <CifraDeLaFila etiqueta="total" origen="capital más interés">
            <Cifra monto={foto.total} nulo="—" />
          </CifraDeLaFila>
        </FilaDeCifras>
      }
    >
      {foto.meses.length === 0 ? (
        <Vacio titulo="Ese día no debía ningún mes" />
      ) : (
        <MarcoTabla etiqueta={`Foto de la deuda al ${formatearFecha(foto.fecha)}`}>
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Período
                </th>
                <th scope="col">Vencimiento</th>
                <th scope="col">Estado</th>
                <th scope="col" className={ui.numerica}>
                  Capital
                </th>
                <th scope="col" className={ui.numerica}>
                  Interés
                </th>
              </tr>
            </thead>
            <tbody>
              {foto.meses.map((m, i) => (
                <tr key={`${m.periodo}-${i}`}>
                  <th scope="row" className={ui.columnaAncla}>
                    {formatearPeriodo(m.periodo)}
                  </th>
                  <td>{formatearFecha(m.vencimiento)}</td>
                  <td>{m.vencido ? <Chip tono="peligro">Vencido</Chip> : <Chip tono="neutro">A vencer</Chip>}</td>
                  <td className={ui.numerica}>
                    <Cifra monto={m.capital} nulo="—" />
                  </td>
                  <td className={ui.numerica}>
                    <Cifra monto={m.interes} nulo="—" />
                  </td>
                </tr>
              ))}
            </tbody>
          </Tabla>
        </MarcoTabla>
      )}
    </Panel>
  );
}
