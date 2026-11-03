import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarSaldosUF, unidadesQueCoincidenConLaBusqueda, type SaldoUF } from "@admin-barrios/data/servicios/cobros";
import { resumirSaldosPendientes } from "@admin-barrios/shared/cobros";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import {
  BarraDeFiltros,
  Boton,
  BusquedaDeLista,
  CifraDeLaFila,
  FilaDeCifras,
  FiltroDeLista,
  FiltrosDeLista,
  IconoMas,
} from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../componentes/iconos.tsx";
import {
  Cifra,
  EncabezadoDePagina,
  MarcoTabla,
  Pagina,
  Panel,
  Tabla,
  Vacio,
  ui,
} from "../../../../componentes/ui.tsx";
import { esIdValido, hrefDeLista, migaDelBarrio, rutaDeUnidad, rutasDeCobros } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import estilos from "./cobros.module.css";

export const metadata: Metadata = { title: "Cobros" };

const FILTROS_COBROS = ["todas", "con_saldo", "al_dia"] as const;
type FiltroCobros = (typeof FILTROS_COBROS)[number];
const NOMBRE_DEL_FILTRO: Record<FiltroCobros, string> = { todas: "Todas", con_saldo: "Con saldo", al_dia: "Al día" };

/** Filtro y búsqueda llegan por la URL, o sea del cliente: se validan con Zod. Un filtro desconocido es «Todas». */
const consultaSchema = z.object({
  filtro: z.enum(FILTROS_COBROS).catch("todas"),
  q: z.string().trim().max(80).catch(""),
});

/**
 * La grilla de cobros: cuánto debe cada unidad del barrio, de un vistazo.
 *
 * Lee `listarSaldosUF`, que a propósito consulta `saldo_uf` (mantenida incremental por trigger) y no
 * `app.v_estado_cuenta_uf` — esa vista reordena el historial completo y está pensada para el detalle
 * de UNA unidad (`cobros/[unidad]/page.tsx`), no para "todas las unidades del barrio" (ver el
 * docstring de `listarSaldosUF` en `servicios/cobros.ts`).
 *
 * **Sin paginado, a propósito.** El mismo servicio ya trae el barrio entero sin cortar —lo necesita
 * para que "unidades con deuda" sea un conteo real y no el de una página— y es la misma cifra con la
 * que ya convive `padron/page.tsx` en su versión sin paginar sobre `unidad_funcional`. No hay PII acá
 * (solo unidad, código de pago y saldo), así que el argumento que sí justifica paginar el padrón no
 * aplica.
 *
 * **Filtros y búsqueda, como el padrón** (encargo 8, T1): «Todas», «Con saldo» y «Al día» son links
 * (`?filtro=`) con su conteo, y la búsqueda es un `<form method="get">` (`?q=`) — cero JavaScript.
 * Los conteos son del barrio entero (las mismas filas que ya trae `listarSaldosUF`), no del resultado
 * de la búsqueda: lo mismo que hace el padrón. La búsqueda es **la del padrón** (manzana y lote,
 * código de pago, titular por nombre o documento) y se resuelve en la base: la pantalla recibe solo
 * los ids que coinciden, así que buscar por titular no pone ningún nombre en esta grilla.
 *
 * Antes la lista venía partida en un panel «Con saldo pendiente» y un desplegable «Al día o sin
 * movimientos». Los filtros reemplazan esa partición: una sola tabla, y el filtro dice qué parte se
 * mira. «Al día» sigue siendo el complemento exacto de «Con saldo» (un saldo a favor no es deuda).
 *
 * **Botón "Registrar pago" ausente y no apagado si `!puedeRegistrarPago`** (doc 06 §c.6.4): a un rol
 * de solo lectura no se le muestra un botón que la base va a rechazar.
 */
export default async function Cobros({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId } = await params;
  // Ídem el layout: se renderizan en paralelo, así que el chequeo va en los dos (ver `rutas.ts`).
  if (!esIdValido(barrioId)) notFound();

  const crudos = await searchParams;
  const unico = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const consulta = consultaSchema.parse({ filtro: unico(crudos["filtro"]), q: unico(crudos["q"]) });

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    saldos: await listarSaldosUF(tx, { barrioId }),
    coinciden: await unidadesQueCoincidenConLaBusqueda(tx, { barrioId, busqueda: consulta.q }),
  }));

  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const { puedeRegistrarPago, saldos } = datos.saldos;

  // La misma cifra que el panel «Saldo pendiente» del tablero: sale del mismo helper.
  const { conSaldo: conDeuda, total: deudaTotal } = resumirSaldosPendientes(saldos);
  // El complemento exacto de `conDeuda`: un saldo a favor no es deuda, y está al día.
  const alDia = saldos.filter((s) => !conDeuda.includes(s));
  const sinMovimientos = saldos.filter((s) => s.fechaUltimoMovimiento === null);

  const rutas = rutasDeCobros(barrio.id);
  const filtro = consulta.filtro;
  const hrefFiltro = (f: FiltroCobros, q: string = consulta.q): string =>
    hrefDeLista(rutas.grilla, { filtro: f === "todas" ? null : f, q });
  const delFiltro = { todas: saldos, con_saldo: conDeuda, al_dia: alDia }[filtro];
  const coinciden = datos.coinciden;
  const visibles = coinciden === null ? delFiltro : delFiltro.filter((s) => coinciden.has(s.unidadFuncionalId));

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio(barrio), { texto: "Cobros" }]}
        titulo="Cobros"
        bajada={
          saldos.length === 0
            ? undefined
            : `El saldo de cada una de las ${saldos.length} unidades de ${barrio.nombre}, según los pagos y liquidaciones registrados.`
        }
        acciones={
          puedeRegistrarPago ? (
            <Boton href={rutas.nuevo} variante="primario" icono={<IconoMas />}>
              Registrar pago
            </Boton>
          ) : null
        }
      />

      <Panel
        titulo="Resumen del barrio"
        origen={`${saldos.length} unidades. "Con deuda" es saldo mayor a $ 0,00: un saldo a favor no es deuda.`}
      >
        <FilaDeCifras>
          <CifraDeLaFila etiqueta="Deuda total" origen="suma de los saldos mayores a cero">
            <Cifra monto={deudaTotal} nulo="—" />
          </CifraDeLaFila>
          <CifraDeLaFila etiqueta="Unidades con deuda" origen={`de ${saldos.length} unidades del barrio`}>
            {conDeuda.length}
          </CifraDeLaFila>
          <CifraDeLaFila
            etiqueta="Sin movimientos"
            origen="todavía no tienen ni un pago ni una liquidación registrada"
          >
            {sinMovimientos.length}
          </CifraDeLaFila>
        </FilaDeCifras>
      </Panel>

      <BarraDeFiltros>
        <FiltrosDeLista etiqueta="Filtrar las unidades por saldo">
          <FiltroDeLista href={hrefFiltro("todas")} activo={filtro === "todas"} cantidad={saldos.length}>
            Todas
          </FiltroDeLista>
          <FiltroDeLista href={hrefFiltro("con_saldo")} activo={filtro === "con_saldo"} cantidad={conDeuda.length}>
            Con saldo
          </FiltroDeLista>
          <FiltroDeLista href={hrefFiltro("al_dia")} activo={filtro === "al_dia"} cantidad={alDia.length}>
            Al día
          </FiltroDeLista>
        </FiltrosDeLista>
        {/* Sin JavaScript: el navegador arma `?filtro=…&q=…` y el servidor resuelve. */}
        <BusquedaDeLista
          accion={rutas.grilla}
          valor={consulta.q}
          etiqueta="Buscar por manzana, lote, titular o código de pago"
          conservar={filtro !== "todas" ? { filtro } : {}}
        />
      </BarraDeFiltros>

      <Panel
        titulo="Unidades"
        origen={
          consulta.q !== "" ? (
            <>
              Resultado de buscar «{consulta.q}». <Link href={hrefFiltro(filtro, "")}>Ver sin la búsqueda</Link>
            </>
          ) : (
            "Orden por manzana y lote. «Con saldo» es saldo mayor a $ 0,00; «Al día» incluye las que tienen saldo a favor o todavía no tuvieron movimientos. Cada fila lleva al estado de cuenta completo de la unidad."
          )
        }
        sinRelleno
      >
        {visibles.length === 0 ? (
          <Vacio
            icono={<IconoBorrador />}
            titulo={
              consulta.q !== ""
                ? "Ninguna unidad coincide con la búsqueda"
                : saldos.length === 0
                  ? "Este barrio todavía no tiene unidades"
                  : `No hay unidades en el filtro «${NOMBRE_DEL_FILTRO[filtro]}»`
            }
          >
            {consulta.q !== "" ? (
              <>
                Se buscó «{consulta.q}»{filtro !== "todas" ? ` con el filtro «${NOMBRE_DEL_FILTRO[filtro]}»` : ""}. Probá
                con la manzana y el lote («12 3»), el apellido o el código de pago, o{" "}
                <Link href={hrefFiltro("todas", "")}>mirá todas las unidades</Link>.
              </>
            ) : saldos.length === 0 ? (
              "Las unidades se cargan en el padrón del barrio."
            ) : (
              <>
                {filtro === "con_saldo"
                  ? `Todas las unidades de ${barrio.nombre} están al día o todavía no tuvieron ningún movimiento.`
                  : "Todas las unidades del barrio tienen saldo pendiente."}{" "}
                Para sacar el filtro, <Link href={hrefFiltro("todas")}>mirá todas las unidades</Link>.
              </>
            )}
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Saldo de las unidades del barrio">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Unidad
                  </th>
                  <th scope="col">Código de pago</th>
                  <th scope="col">Último movimiento</th>
                  <th scope="col" className={ui.numerica}>
                    Saldo
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((saldo) => (
                  <FilaDeSaldo key={saldo.unidadFuncionalId} saldo={saldo} barrioId={barrio.id} />
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>
    </Pagina>
  );
}

function FilaDeSaldo({ saldo, barrioId }: { readonly saldo: SaldoUF; readonly barrioId: string }) {
  return (
    <tr>
      <th scope="row" className={ui.columnaAncla}>
        <Link href={rutaDeUnidad(barrioId, saldo.unidadFuncionalId)} className={estilos.unidad}>
          {saldo.etiqueta}
        </Link>
      </th>
      <td>
        <span className={ui.mono}>{saldo.codigoPago}</span>
      </td>
      <td>
        {saldo.fechaUltimoMovimiento ? (
          formatearFecha(saldo.fechaUltimoMovimiento)
        ) : (
          <span className={ui.secundaria}>sin movimientos</span>
        )}
      </td>
      <td className={ui.numerica}>
        <Cifra monto={saldo.saldoActual} nulo="—" />
      </td>
    </tr>
  );
}
