import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import {
  estadoDeCuenta,
  listarSaldosUF,
  type MovimientoEstadoCuenta,
} from "@admin-barrios/data/servicios/cobros";
import { listarPagosDeUnidad, type PagoDeUnidad } from "@admin-barrios/data/servicios/pagos";
import { listarRecibosDeUnidad, type ReciboDeUnidad } from "@admin-barrios/data/servicios/documentos";
import { formatearFecha } from "@admin-barrios/shared/fechas";
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
import { esIdValido, rutasDeCobros } from "../../../../../rutas.ts";
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
}: {
  readonly params: Promise<{ readonly barrio: string; readonly unidad: string }>;
}) {
  const { barrio: barrioId, unidad: unidadFuncionalId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(unidadFuncionalId)) notFound();

  const datos = await conSesion(async (tx) => {
    const barrio = await leerBarrio(tx, { barrioId });
    if (!barrio) return { barrio: null, saldo: null, movimientos: [], pagos: [], recibos: [] };

    const { saldos } = await listarSaldosUF(tx, { barrioId });
    const saldo = saldos.find((s) => s.unidadFuncionalId === unidadFuncionalId) ?? null;
    if (!saldo) return { barrio, saldo: null, movimientos: [], pagos: [], recibos: [] };

    return {
      barrio,
      saldo,
      movimientos: await estadoDeCuenta(tx, { unidadFuncionalId }),
      pagos: await listarPagosDeUnidad(tx, { unidadFuncionalId }),
      recibos: await listarRecibosDeUnidad(tx, { unidadFuncionalId }),
    };
  });

  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1). Las dos condiciones dan el
  // mismo 404: no se distingue "el barrio no existe" de "la unidad no está en ese barrio", mismo
  // criterio que el resto del sistema para no crear un oráculo de tenants.
  if (!datos.barrio || !datos.saldo) notFound();
  const barrio = datos.barrio;
  const saldo = datos.saldo;
  const rutas = rutasDeCobros(barrio.id);

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo={<span className={estilos.unidad}>{saldo.etiqueta}</span>}
        bajada={`${barrio.nombre} · estado de cuenta`}
        acciones={
          <Boton href={rutas.grilla} variante="secundario">
            Volver a la grilla
          </Boton>
        }
      />

      <Panel
        titulo="Saldo actual"
        origen={
          saldo.fechaUltimoMovimiento
            ? `último movimiento el ${formatearFecha(saldo.fechaUltimoMovimiento)}`
            : "todavía no tuvo ningún movimiento: no hay fila en la cuenta corriente"
        }
      >
        <Dato etiqueta="Saldo" grande>
          <Cifra monto={saldo.saldoActual} nulo="—" />
        </Dato>
      </Panel>

      <Movimientos movimientos={datos.movimientos} />
      <Pagos pagos={datos.pagos} />
      <Recibos recibos={datos.recibos} />
    </Pagina>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Movimientos
// ────────────────────────────────────────────────────────────────────────────────────────────────

function Movimientos({ movimientos }: { readonly movimientos: readonly MovimientoEstadoCuenta[] }) {
  return (
    <Panel
      titulo="Movimientos"
      origen="Débitos = liquidaciones que se generaron contra la unidad; créditos = pagos aplicados. Orden cronológico, con el saldo después de cada uno."
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
                  <td>
                    <span className={ui.mono}>{m.origenId}</span>
                  </td>
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

function Pagos({ pagos }: { readonly pagos: readonly PagoDeUnidad[] }) {
  return (
    <Panel
      titulo="Pagos registrados"
      origen="Los pagos vivos de la unidad, más nuevo primero. No es lo mismo que los movimientos: acá se ve el comprobante, no la imputación."
      sinRelleno
    >
      {pagos.length === 0 ? (
        <Vacio icono={<IconoBorrador />} titulo="Todavía no hay ningún pago registrado">
          Se registran desde «Registrar pago», en la grilla de cobros.
        </Vacio>
      ) : (
        <MarcoTabla etiqueta="Pagos registrados de la unidad">
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
                <th scope="col">Comprobante</th>
              </tr>
            </thead>
            <tbody>
              {pagos.map((p) => (
                <tr key={p.id}>
                  <th scope="row" className={ui.columnaAncla}>
                    {formatearFecha(p.fecha)}
                  </th>
                  <td>{etiquetaOrigenPago(p.origen)}</td>
                  <td className={ui.numerica}>
                    <Cifra monto={p.monto} nulo="—" />
                  </td>
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
        **Visible y deshabilitado, no ausente — y es la excepción al criterio de "ausente, no
        apagado" que usa el resto del sistema.** Acá no es un permiso de rol: `encolarEmisionDeRecibo()`
        (`servicios/cobros.ts`) ya existe y está probada del lado del backend, pero
        `apps/worker/src/main.ts` todavía no tiene un handler para el tipo `emitir_recibo_pago` — su
        `Record` `HANDLERS` solo resuelve `emitir_documentos_periodo`. Encolar hoy dejaría un trabajo
        que un worker sin handler no puede tomar, y que terminaría fallando con un mensaje genérico del
        sistema en vez de uno que explique lo que en realidad pasó. Es un hecho del estado del sistema,
        no algo que dependa de quién mira la pantalla, y por eso se muestra explicado en vez de
        ocultarse (mismo criterio que `puedeEmitir`/`puedeRegistrarPago`, pero por un hecho del sistema
        y no por un rol).
      */}
      <div className={estilos.recibos}>
        <Boton deshabilitado etiqueta="Generar recibo (todavía no disponible)">
          Generar recibo
        </Boton>
        <Nota tono="info">La emisión de recibos en PDF todavía no está disponible en esta versión.</Nota>
      </div>

      {recibos.length === 0 ? (
        <Vacio icono={<IconoBorrador />} titulo="Todavía no hay ningún recibo emitido">
          Cuando la emisión esté disponible, van a aparecer acá.
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
                  <td>{r.emitidoAt.slice(0, 16).replace("T", " ")}</td>
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
