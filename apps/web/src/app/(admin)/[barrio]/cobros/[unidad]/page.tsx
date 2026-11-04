import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import {
  estadoDeCuenta,
  listarSaldosUF,
  type MovimientoEstadoCuenta,
} from "@admin-barrios/data/servicios/cobros";
import { listarPagosDeUnidad, type PagoDeUnidad } from "@admin-barrios/data/servicios/pagos";
import {
  diasDeAtrasoPorUnidad,
  interesPendienteDeUnidad,
  puedeCondonarEnElBarrio,
  condonacionDeUnidad,
} from "@admin-barrios/data/servicios/deuda";
import { formatearMonto, sumarMontos } from "@admin-barrios/shared/dinero";
import { AccionDesplegable, FiltroDeLista, FiltrosDeLista } from "@admin-barrios/ui";
import { FormularioDeCondonacion } from "./condonacion.tsx";
import { BotonAnularPago } from "./anular-pago.tsx";
import {
  listoDeLaAnulacion,
  listoDeLaCondonacion,
  listoDelPago,
  resumenDeAnulacion,
} from "../../../../../componentes/textos-de-cobros.ts";
import { listarRecibosDeUnidad, type ReciboDeUnidad } from "@admin-barrios/data/servicios/documentos";
import { formatearFecha, formatearFechaHora, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { Boton } from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../../componentes/iconos.tsx";
import {
  Cifra,
  Dato,
  EncabezadoDePagina,
  MarcoTabla,
  Nota,
  Pagina,
  Panel,
  Tabla,
  Vacio,
  ui,
} from "../../../../../componentes/ui.tsx";
import { etiquetaOrigenPago } from "../../../../../componentes/etiquetas.tsx";
import {
  conListo,
  esIdValido,
  leerListo,
  migaDelBarrio,
  rutaDeFichaDelPadron,
  rutaDePagoDeUnidad,
  rutaDeUnidad,
  rutaDeUnidadConAnulados,
  rutasDeCobros,
} from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import estilos from "./unidad.module.css";

export const metadata: Metadata = { title: "Estado de cuenta" };

/**
 * El estado de cuenta de una unidad: sus movimientos, sus pagos registrados y sus recibos.
 *
 * **Tres paneles, cada uno respondiendo una pregunta distinta**, y las tres lecturas son servicios
 * distintos a propósito (ver los docstrings de `cobros.ts`/`pagos.ts`/`documentos.ts`):
 *
 * · "Movimientos" es el libro completo —débitos y créditos, en orden— vía `estadoDeCuenta()`, que lee
 *   `app.v_estado_cuenta_uf`. Para un crédito, esa vista expone el id de la **imputación**, no el del
 *   pago: no alcanza para saber si tiene comprobante.
 * · "Pagos registrados" es otra pregunta ("¿qué pagos entraron, con qué comprobante?") vía
 *   `listarPagosDeUnidad()`, que lee `pago` directo.
 * · "Recibos" es lo ya emitido vía `listarRecibosDeUnidad()`.
 *
 * **La etiqueta de la unidad no la devuelve ninguna de las tres.** Sale de `listarSaldosUF()` —la
 * misma consulta que ya arma la grilla de cobros y el selector del alta—, que de paso trae el saldo
 * actual para el `Dato` grande de arriba. Si la unidad no aparece ahí, no es de este barrio o no es
 * visible bajo RLS: mismo criterio de "no existe" que el resto del sistema, y ahí se corta antes de
 * pedir las otras tres lecturas (early-exit barato, ADR-0001 §5 punto 6).
 */
export default async function EstadoDeCuenta({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly unidad: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { barrio: barrioId, unidad: unidadFuncionalId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(unidadFuncionalId)) notFound();
  const crudos = await searchParams;
  // «Listo:» al volver de registrar un pago, condonar o anular (encargo 10). El texto sale de las filas
  // leídas bajo RLS, nunca de la URL.
  const listoPago = leerListo(crudos, "pago");
  const listoCondonacion = leerListo(crudos, "condonacion");
  const listoAnulacion = leerListo(crudos, "anulacion");
  // «Ver anulados» (BL-029): los pagos anulados, con su motivo, en lugar de los vigentes.
  const verAnulados = crudos["anulados"] === "1";

  const datos = await conSesion(async (tx) => {
    const barrio = await leerBarrio(tx, { barrioId });
    const vacio = {
      movimientos: [],
      pagos: [],
      recibos: [],
      atraso: null,
      interesPendiente: "0.00",
      puedeCondonar: false,
      puedeRegistrarPago: false,
      condonacion: null,
    };
    if (!barrio) return { barrio: null, saldo: null, ...vacio };

    const { saldos, puedeRegistrarPago } = await listarSaldosUF(tx, { barrioId });
    const saldo = saldos.find((s) => s.unidadFuncionalId === unidadFuncionalId) ?? null;
    if (!saldo) return { barrio, saldo: null, ...vacio };

    return {
      barrio,
      saldo,
      movimientos: await estadoDeCuenta(tx, { unidadFuncionalId }),
      // Con los anulados siempre: el filtro y el «Listo:» de una anulación los necesitan, y son pocos.
      pagos: await listarPagosDeUnidad(tx, { unidadFuncionalId, incluirAnulados: true }),
      recibos: await listarRecibosDeUnidad(tx, { unidadFuncionalId }),
      atraso: (await diasDeAtrasoPorUnidad(tx, { barrioId, unidadFuncionalId })).get(unidadFuncionalId) ?? null,
      interesPendiente: sumarMontos("0.00", ...(await interesPendienteDeUnidad(tx, { unidadFuncionalId })).map((i) => i.pendiente)),
      puedeCondonar: await puedeCondonarEnElBarrio(tx, { barrioId }),
      puedeRegistrarPago,
      condonacion: listoCondonacion?.id
        ? await condonacionDeUnidad(tx, { unidadFuncionalId, condonacionId: listoCondonacion.id })
        : null,
    };
  });

  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1). Las dos condiciones dan el
  // mismo 404: no se distingue "el barrio no existe" de "la unidad no está en ese barrio", mismo
  // criterio que el resto del sistema para no crear un oráculo de tenants.
  if (!datos.barrio || !datos.saldo) notFound();
  const barrio = datos.barrio;
  const saldo = datos.saldo;
  const rutas = rutasDeCobros(barrio.id);
  const textoListo = textoDelListo();

  function textoDelListo(): string | null {
    if (listoPago?.id) {
      const pago = datos.pagos.find((p) => p.id === listoPago.id && p.anulacion === null);
      if (pago) return listoDelPago(pago);
    }
    if (listoAnulacion?.id) {
      const pago = datos.pagos.find((p) => p.id === listoAnulacion.id && p.anulacion !== null);
      if (pago) return listoDeLaAnulacion(pago);
    }
    if (listoCondonacion?.id && datos.condonacion) return listoDeLaCondonacion(datos.condonacion.monto);
    return null;
  }

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio(barrio), { texto: "Cobros", href: rutas.grilla }, { texto: saldo.etiqueta }]}
        titulo={<span className={estilos.unidad}>{saldo.etiqueta}</span>}
        bajada={`${barrio.nombre} · estado de cuenta`}
        acciones={
          <>
            {/* La misma unidad, del lado del padrón: titulares, contactos y coeficiente (T1 §8). */}
            <Boton href={rutaDeFichaDelPadron(barrio.id, saldo.unidadFuncionalId)} variante="sutil">
              Ficha del padrón
            </Boton>
            <Boton href={rutas.grilla} variante="secundario">
              Volver a la grilla
            </Boton>
            {/* Ausente, no apagado, para quien no registra pagos (doc 06 §c.6.4). */}
            {datos.puedeRegistrarPago ? (
              <Boton href={rutaDePagoDeUnidad(barrio.id, saldo.unidadFuncionalId)} variante="primario">
                Registrar pago de esta unidad
              </Boton>
            ) : null}
          </>
        }
      />

      {textoListo ? <Nota tono="exito" titulo={textoListo} /> : null}

      <Panel
        titulo="Saldo actual"
        origen={
          saldo.fechaUltimoMovimiento
            ? `último movimiento el ${formatearFecha(saldo.fechaUltimoMovimiento)}`
            : "todavía no tuvo ningún movimiento: no hay fila en la cuenta corriente"
        }
      >
        <div className={estilos.datosDeDeuda}>
          <Dato etiqueta="Saldo" grande>
            <Cifra monto={saldo.saldoActual} nulo="—" />
          </Dato>
          <Dato
            etiqueta="Días de atraso"
            grande
            origen={
              datos.atraso
                ? `desde el vencimiento impago más antiguo, el ${formatearFecha(datos.atraso.desde)}`
                : "no hay capital vencido e impago"
            }
          >
            <span className="dinero">{datos.atraso?.dias ?? 0}</span>
          </Dato>
          <Dato etiqueta="Interés pendiente" grande origen="devengado y no pagado ni condonado">
            <Cifra monto={datos.interesPendiente} nulo="—" />
          </Dato>
        </div>
        {datos.puedeCondonar && datos.interesPendiente !== "0.00" ? (
          <AccionDesplegable texto="Condonar interés">
            <FormularioDeCondonacion
              // Se vuelve a montar cuando cambia lo pendiente: después de una condonación parcial, el
              // formulario vuelve vacío en vez de quedar en «Actualizando…» (code-reviewer).
              key={datos.interesPendiente}
              barrioId={barrio.id}
              unidadFuncionalId={unidadFuncionalId}
              pendiente={datos.interesPendiente}
              pendienteTexto={formatearMonto(datos.interesPendiente)}
            />
          </AccionDesplegable>
        ) : null}
      </Panel>

      <Movimientos movimientos={datos.movimientos} />
      <Pagos
        pagos={datos.pagos}
        verAnulados={verAnulados}
        barrioId={barrio.id}
        unidadFuncionalId={saldo.unidadFuncionalId}
        saldoActual={saldo.saldoActual}
        puedeAnular={datos.puedeRegistrarPago}
        puedeAnularConCondonacion={datos.puedeCondonar}
      />
      <Recibos recibos={datos.recibos} />
    </Pagina>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Movimientos
// ────────────────────────────────────────────────────────────────────────────────────────────────

const CONCEPTO_DE_MOVIMIENTO: Record<MovimientoEstadoCuenta["concepto"], string> = {
  liquidacion: "Liquidación",
  pago: "Pago a capital",
  interes: "Interés por mora",
  pago_interes: "Pago de interés",
  condonacion: "Interés condonado",
};

/**
 * La columna «Origen», en palabras (BL-024): de qué sale cada movimiento. Antes mostraba el id interno
 * de la fila, que no le dice nada a quien mira. El id sigue siendo la `key` de la fila.
 */
function origenDelMovimiento(m: MovimientoEstadoCuenta): string {
  switch (m.concepto) {
    case "liquidacion":
      return m.periodo ? `Liquidación ${formatearPeriodo(m.periodo)}` : "Liquidación";
    case "interes":
      return m.periodo ? `Mora de la liquidación ${formatearPeriodo(m.periodo)}` : "Mora";
    case "pago":
    case "pago_interes":
      return `Pago del ${formatearFecha(m.fecha).slice(0, 5)}`;
    case "condonacion":
      return "Condonación";
  }
}

function Movimientos({ movimientos }: { readonly movimientos: readonly MovimientoEstadoCuenta[] }) {
  return (
    <Panel
      titulo="Movimientos"
      origen="Débitos = liquidaciones (capital) e interés por mora; créditos = pagos aplicados (a capital o a interés) e interés condonado. Orden cronológico, con el saldo después de cada uno."
      sinRelleno
    >
      {movimientos.length === 0 ? (
        <Vacio icono={<IconoBorrador />} titulo="Todavía no hay movimientos en esta cuenta">
          Ni liquidaciones generadas contra esta unidad, ni pagos aplicados.
        </Vacio>
      ) : (
        <MarcoTabla etiqueta="Movimientos de la cuenta corriente">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Fecha
                </th>
                <th scope="col">Tipo</th>
                <th scope="col">Concepto</th>
                <th scope="col">Origen</th>
                <th scope="col" className={ui.numerica}>
                  Importe
                </th>
                <th scope="col" className={ui.numerica}>
                  Saldo
                </th>
              </tr>
            </thead>
            <tbody>
              {movimientos.map((m) => (
                <tr key={`${m.tipo}-${m.origenId}`}>
                  <th scope="row" className={ui.columnaAncla}>
                    {formatearFecha(m.fecha)}
                  </th>
                  <td>{m.tipo === "debito" ? "Débito" : "Crédito"}</td>
                  <td>{CONCEPTO_DE_MOVIMIENTO[m.concepto]}</td>
                  <td>{origenDelMovimiento(m)}</td>
                  <td className={ui.numerica}>
                    <Cifra monto={m.monto} nulo="—" />
                  </td>
                  <td className={ui.numerica}>
                    <Cifra monto={m.saldoCorriente} nulo="—" />
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

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Pagos registrados
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Los pagos de la unidad. Por defecto, los vigentes, con «Anular» para quien registra pagos (encargo
 * 10, BL-029); con «Ver anulados», los anulados, con la fecha y el motivo de la anulación.
 */
function Pagos({
  pagos,
  verAnulados,
  barrioId,
  unidadFuncionalId,
  saldoActual,
  puedeAnular,
  puedeAnularConCondonacion,
}: {
  readonly pagos: readonly PagoDeUnidad[];
  readonly verAnulados: boolean;
  readonly barrioId: string;
  readonly unidadFuncionalId: string;
  readonly saldoActual: string;
  readonly puedeAnular: boolean;
  /**
   * Si quien mira puede anular un pago con interés condonado: solo la administración (encargo 11,
   * `0070`). Un operador ve el motivo en lugar del botón; la base lo rechaza igual.
   */
  readonly puedeAnularConCondonacion: boolean;
}) {
  const vigentes = pagos.filter((p) => p.anulacion === null);
  const anulados = pagos.filter((p) => p.anulacion !== null);
  const visibles = verAnulados ? anulados : vigentes;
  const conAcciones = !verAnulados && puedeAnular;

  return (
    <Panel
      titulo="Pagos registrados"
      origen={
        verAnulados
          ? "Los pagos anulados de la unidad, con la fecha y el motivo de la anulación. Lo que imputaban se anuló con ellos."
          : "Los pagos vigentes de la unidad, más nuevo primero, con cómo se imputó cada uno. No es lo mismo que los movimientos: acá se ve el pago entero y su comprobante."
      }
      sinRelleno
    >
      <FiltrosDeLista etiqueta="Qué pagos ver">
        <FiltroDeLista href={rutaDeUnidad(barrioId, unidadFuncionalId)} activo={!verAnulados} cantidad={vigentes.length}>
          Vigentes
        </FiltroDeLista>
        <FiltroDeLista href={rutaDeUnidadConAnulados(barrioId, unidadFuncionalId)} activo={verAnulados} cantidad={anulados.length}>
          Ver anulados
        </FiltroDeLista>
      </FiltrosDeLista>
      {visibles.length === 0 ? (
        verAnulados ? (
          <Vacio icono={<IconoBorrador />} titulo="Esta unidad no tiene pagos anulados">
            Cuando se anula un pago, queda acá con su motivo.
          </Vacio>
        ) : (
          <Vacio icono={<IconoBorrador />} titulo="Todavía no hay ningún pago registrado">
            Se registran desde «Registrar pago», en la grilla de cobros.
          </Vacio>
        )
      ) : (
        <MarcoTabla etiqueta={verAnulados ? "Pagos anulados de la unidad" : "Pagos registrados de la unidad"}>
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Fecha
                </th>
                <th scope="col">Origen</th>
                <th scope="col" className={ui.numerica}>
                  Monto
                </th>
                <th scope="col" className={ui.numerica}>
                  A capital
                </th>
                <th scope="col" className={ui.numerica}>
                  A interés
                </th>
                {verAnulados ? <th scope="col">Anulación</th> : <th scope="col">Comprobante</th>}
                {conAcciones ? <th scope="col">Acciones</th> : null}
              </tr>
            </thead>
            <tbody>
              {visibles.map((p) => {
                const resumen = conAcciones ? resumenDeAnulacion(p, saldoActual) : null;
                return (
                  <tr key={p.id}>
                    <th scope="row" className={ui.columnaAncla}>
                      {formatearFecha(p.fecha)}
                    </th>
                    <td>{etiquetaOrigenPago(p.origen)}</td>
                    <td className={ui.numerica}>
                      <Cifra monto={p.monto} nulo="—" />
                    </td>
                    <td className={ui.numerica}>
                      <Cifra monto={p.aCapital} nulo="—" />
                    </td>
                    <td className={ui.numerica}>
                      <Cifra monto={p.aInteres} nulo="—" />
                      {p.interesCondonado !== "0.00" ? (
                        <span className={ui.secundaria}> · {formatearMonto(p.interesCondonado)} no cobrado</span>
                      ) : null}
                    </td>
                    {p.anulacion ? (
                      <td>
                        El {formatearFecha(p.anulacion.el)}: {p.anulacion.motivo}
                      </td>
                    ) : (
                      <td>
                        {p.tieneComprobante ? (
                          // Un enlace común, sin JavaScript: la ruta responde un 302 a una URL firmada de
                          // vida corta. El `pagoId` es lo único que viaja — nunca la clave del archivo
                          // (ver `api/comprobantes/[pagoId]/route.ts`).
                          <a href={`/api/comprobantes/${p.id}`} download>
                            Ver comprobante
                          </a>
                        ) : (
                          <span className={ui.secundaria}>sin comprobante</span>
                        )}
                      </td>
                    )}
                    {resumen && p.interesCondonado !== "0.00" && !puedeAnularConCondonacion ? (
                      <td>
                        <span className={ui.secundaria}>Lo anula un administrador porque tiene interés condonado</span>
                      </td>
                    ) : resumen ? (
                      <td>
                        <BotonAnularPago
                          pagoId={p.id}
                          etiqueta={`Anular el pago de $ ${formatearMonto(p.monto)} del ${formatearFecha(p.fecha)}`}
                          titulo={resumen.titulo}
                          lineas={resumen.lineas}
                          saldoAntes={`$ ${formatearMonto(resumen.saldoAntes)}`}
                          saldoDespues={`$ ${formatearMonto(resumen.saldoDespues)}`}
                          volverA={conListo(rutaDeUnidad(barrioId, unidadFuncionalId), "anulacion", p.id)}
                        />
                      </td>
                    ) : null}
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

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Recibos
// ────────────────────────────────────────────────────────────────────────────────────────────────

function Recibos({ recibos }: { readonly recibos: readonly ReciboDeUnidad[] }) {
  return (
    <Panel
      titulo="Recibos"
      origen="Los recibos ya emitidos de esta unidad, más nuevo primero."
      sinRelleno
    >
      {/*
        **Ausente, no apagado** (encargo 8, T1). `encolarEmisionDeRecibo()` (`servicios/cobros.ts`)
        ya existe y el worker tiene su handler (`emitir_recibo_pago` en `HANDLERS`), pero no hay
        acción ni pantalla que lo encolen: conectarlo es producto nuevo. Antes había acá un botón
        «Generar recibo» deshabilitado con una nota; se sacó porque un botón que no hace nada no
        le dice nada útil al administrador. Cuando exista la acción, el botón vuelve habilitado.
      */}
      {recibos.length === 0 ? (
        <Vacio icono={<IconoBorrador />} titulo="Todavía no hay ningún recibo emitido">
          Los recibos de los pagos de esta unidad van a aparecer acá a medida que se emitan.
        </Vacio>
      ) : (
        <MarcoTabla etiqueta="Recibos emitidos de la unidad">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Número
                </th>
                <th scope="col">Emitido</th>
                <th scope="col" className={ui.numerica}>
                  Monto del pago
                </th>
                <th scope="col">Descargar</th>
              </tr>
            </thead>
            <tbody>
              {recibos.map((r) => (
                <tr key={r.id}>
                  <th scope="row" className={ui.columnaAncla}>
                    <span className={ui.mono}>{r.numeroRecibo}</span>
                  </th>
                  <td>{formatearFechaHora(r.emitidoAt)}</td>
                  <td className={ui.numerica}>
                    <Cifra monto={r.montoPago} nulo="—" />
                  </td>
                  <td>
                    <a href={`/api/recibos/${r.id}`} download>
                      Descargar PDF
                    </a>
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
