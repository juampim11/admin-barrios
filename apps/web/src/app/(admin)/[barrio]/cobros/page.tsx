import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import {
  deudaVencidaPorUnidad,
  listarSaldosUF,
  unidadesQueCoincidenConLaBusqueda,
  type SaldoUF,
} from "@admin-barrios/data/servicios/cobros";
import { resumirSaldosPendientes } from "@admin-barrios/shared/cobros";
import { restarMontos, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
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

/**
 * «Con deuda vencida» y «Al día» (encargo 10, BL-030 e): lo que importa al cobrar es si la unidad debe
 * algo **vencido**, no si tiene saldo — una unidad que recibió la boleta del mes y todavía no venció
 * tiene saldo y está al día. Reemplazan a «Con saldo», que mezclaba las dos cosas.
 */
const FILTROS_COBROS = ["todas", "vencida", "al_dia"] as const;
type FiltroCobros = (typeof FILTROS_COBROS)[number];
const NOMBRE_DEL_FILTRO: Record<FiltroCobros, string> = { todas: "Todas", vencida: "Con deuda vencida", al_dia: "Al día" };

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
 * **Filtros y búsqueda, como el padrón** (encargo 8, T1): «Todas», «Con deuda vencida» y «Al día» (encargo 10) son links
 * (`?filtro=`) con su conteo, y la búsqueda es un `<form method="get">` (`?q=`) — cero JavaScript.
 * Los conteos son del barrio entero (las mismas filas que ya trae `listarSaldosUF`), no del resultado
 * de la búsqueda: lo mismo que hace el padrón. La búsqueda es **la del padrón** (manzana y lote,
 * código de pago, titular por nombre o documento) y se resuelve en la base: la pantalla recibe solo
 * los ids que coinciden, así que buscar por titular no pone ningún nombre en esta grilla.
 *
 * Antes la lista venía partida en un panel «Con saldo pendiente» y un desplegable «Al día o sin
 * movimientos». Los filtros reemplazan esa partición: una sola tabla, y el filtro dice qué parte se
 * mira. «Al día» es el complemento exacto de «Con deuda vencida» (encargo 10, BL-030 e).
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
    // Lo vencido sale de la cuenta que ya hace la base para el tablero: el mismo fragmento SQL que
    // `deudaVencidaDelBarrio`, por unidad. Una sola consulta (code-reviewer).
    vencidoPorUnidad: await deudaVencidaPorUnidad(tx, { barrioId }),
    coinciden: await unidadesQueCoincidenConLaBusqueda(tx, { barrioId, busqueda: consulta.q }),
  }));

  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const { puedeRegistrarPago, saldos } = datos.saldos;

  // La misma cifra que el panel «Saldo pendiente» del tablero: sale del mismo helper.
  const { total: deudaTotal } = resumirSaldosPendientes(saldos);
  const { vencidoPorUnidad } = datos;
  // El total y la cantidad, sumando lo de cada unidad (cada valor ya viene con dos decimales exactos):
  // da lo mismo que `deudaVencidaDelBarrio`, y lo verifica `confirmaciones-cobros.db.test.ts`.
  const vencida = { unidades: vencidoPorUnidad.size, total: sumarMontos("0.00", ...vencidoPorUnidad.values()) };
  // «Con deuda vencida»: las que la base dice que deben algo vencido. «Al día» es el complemento exacto.
  const conVencida = saldos.filter((s) => vencidoPorUnidad.has(s.unidadFuncionalId));
  const alDia = saldos.filter((s) => !vencidoPorUnidad.has(s.unidadFuncionalId));
  // Lo que se debe y todavía no venció: la deuda total menos la vencida, las dos cifras de la base.
  const aVencer = restarMontos(deudaTotal, vencida.total);

  const rutas = rutasDeCobros(barrio.id);
  const filtro = consulta.filtro;
  const hrefFiltro = (f: FiltroCobros, q: string = consulta.q): string =>
    hrefDeLista(rutas.grilla, { filtro: f === "todas" ? null : f, q });
  const delFiltro = { todas: saldos, vencida: conVencida, al_dia: alDia }[filtro];
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
        origen={`${saldos.length} unidades. Vencido es lo de boletas cuyo primer vencimiento ya pasó, más el interés no pagado ni condonado; lo demás es la boleta que todavía no venció. Un saldo a favor no es deuda.`}
      >
        <FilaDeCifras>
          <CifraDeLaFila etiqueta="Deuda vencida" origen={`de ${vencida.unidades} unidades; la misma cifra que el tablero`}>
            <Cifra monto={vencida.total} nulo="—" />
          </CifraDeLaFila>
          <CifraDeLaFila etiqueta="Saldo a vencer" origen="deuda total menos la vencida: boletas que todavía no vencieron">
            <Cifra monto={aVencer} nulo="—" />
          </CifraDeLaFila>
          <CifraDeLaFila etiqueta="Deuda total" origen="suma de los saldos mayores a cero">
            <Cifra monto={deudaTotal} nulo="—" />
          </CifraDeLaFila>
          <CifraDeLaFila
            etiqueta="Sin movimientos"
            origen="todavía no tienen ni un pago ni una liquidación registrada"
          >
            {saldos.filter((s) => s.fechaUltimoMovimiento === null).length}
          </CifraDeLaFila>
        </FilaDeCifras>
      </Panel>

      <BarraDeFiltros>
        <FiltrosDeLista etiqueta="Filtrar las unidades por saldo">
          <FiltroDeLista href={hrefFiltro("todas")} activo={filtro === "todas"} cantidad={saldos.length}>
            Todas
          </FiltroDeLista>
          <FiltroDeLista href={hrefFiltro("vencida")} activo={filtro === "vencida"} cantidad={conVencida.length}>
            Con deuda vencida
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
            "Orden por manzana y lote. «Con deuda vencida» es la que debe algo de una boleta ya vencida o interés; «Al día» es el resto, aunque tenga la boleta del mes sin vencer. Cada fila lleva al estado de cuenta completo de la unidad."
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
                {filtro === "vencida"
                  ? `Ninguna unidad de ${barrio.nombre} debe nada vencido.`
                  : "Todas las unidades del barrio tienen deuda vencida."}{" "}
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
                    Vencido
                  </th>
                  <th scope="col" className={ui.numerica}>
                    Saldo
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((saldo) => (
                  <FilaDeSaldo
                    key={saldo.unidadFuncionalId}
                    saldo={saldo}
                    vencido={vencidoPorUnidad.get(saldo.unidadFuncionalId) ?? null}
                    barrioId={barrio.id}
                  />
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>
    </Pagina>
  );
}

function FilaDeSaldo({
  saldo,
  vencido,
  barrioId,
}: {
  readonly saldo: SaldoUF;
  /** `null` = no debe nada vencido. */
  readonly vencido: Monto | null;
  readonly barrioId: string;
}) {
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
        {vencido ? <Cifra monto={vencido} nulo="—" /> : <span className={ui.secundaria}>—</span>}
      </td>
      <td className={ui.numerica}>
        <Cifra monto={saldo.saldoActual} nulo="—" />
      </td>
    </tr>
  );
}
