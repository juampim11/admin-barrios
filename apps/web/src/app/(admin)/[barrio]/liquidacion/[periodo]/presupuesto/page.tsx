import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { presupuestoDelMes, type PresupuestoDelMes } from "@admin-barrios/data/servicios/presupuesto";
import { DosColumnas } from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../../../componentes/iconos.tsx";
import { comoSeLlama, mayus } from "../../../../../../componentes/etiquetas.tsx";
import { Cifra, MarcoTabla, Nota, Pagina, Panel, PilaDeNotas, Tabla, Vacio, ui } from "../../../../../../componentes/ui.tsx";
import { esIdValido, rutasDelPeriodo, salidasDelPeriodo } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { EncabezadoDelMes, mesOno404 } from "../mes.tsx";
import { EditorDelPresupuesto } from "./editor.tsx";
import { cuentaDelImporte, elMes, enElMesAnterior, rotuloDelImporte } from "./textos.ts";

export const metadata: Metadata = { title: "Presupuesto del mes" };

/**
 * **Presupuesto del mes** (encargo 16c; maqueta `devengado-conceptos.html`, pantalla 3).
 *
 * Lo que el barrio espera gastar, rubro por rubro, contra lo que gastó el mes anterior; el margen; el
 * total a pedir; y, si el barrio define el importe del mes, el panel «Importe del mes» con «Usar este
 * importe», que graba por la cuota del barrio.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTA PANTALLA NO HACE
 *
 * - **No calcula el cupón.** El presupuesto no entra al cálculo de nada: propone un importe y después
 *   se compara contra los gastos («Gastos y pagos»).
 * - **No decide quién edita.** `editable` viene del servicio (la administración, con el mes en
 *   preparación). Si no, todo se ve como lectura y la página no manda JavaScript: la isla se monta
 *   solo cuando se puede editar.
 * - **No inventa un importe en un barrio por gastos.** Ahí `importe` es `null` y no hay panel.
 */
export default async function PresupuestoDelMesPagina({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();
  const { periodo } = await mesOno404(barrioId, periodoId);
  // Secuenciales y en una transacción: `node-postgres` encola las consultas del mismo client.
  const { presupuesto, barrio } = await conSesion(async (tx) => ({
    presupuesto: await presupuestoDelMes(tx, { periodoId }),
    // Cómo llama el barrio a lo que cobra hoy («Cuota social por unidad»): es lo que dice el panel.
    barrio: await leerBarrio(tx, { barrioId }),
  }));
  const denominacion = mayus(comoSeLlama(barrio?.denominacionConcepto ?? periodo.denominacionConcepto));
  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const mes = elMes(presupuesto.periodo);
  // El panel del importe solo mientras el mes se prepara: en un mes emitido el importe ya se cobró.
  const importe = presupuesto.enPreparacion ? presupuesto.importe : null;

  return (
    <Pagina>
      <EncabezadoDelMes barrioId={barrioId} periodoId={periodoId} pestana="presupuesto" />

      <PilaDeNotas>
        {!presupuesto.enPreparacion ? (
          <Nota tono="info" titulo={`El mes está emitido: esto es lo que se presupuestó para ${mes}.`}>
            Cómo viene el gasto contra este presupuesto está en <a href={rutas.gastos}>Gastos y pagos</a>.
          </Nota>
        ) : !presupuesto.editable ? (
          <Nota tono="neutro" titulo="Estás viendo el presupuesto en modo de solo lectura.">
            Lo carga la administración del barrio.
          </Nota>
        ) : null}
      </PilaDeNotas>

      {presupuesto.editable ? (
        <EditorDelPresupuesto
          periodoId={periodoId}
          barrioId={barrioId}
          periodo={presupuesto.periodo}
          mesAnterior={presupuesto.mesAnterior}
          huella={huellaDelPresupuesto(presupuesto)}
          rubros={presupuesto.rubros}
          paraAgregar={presupuesto.paraAgregar}
          margen={presupuesto.margen}
          gastoMesAnterior={presupuesto.gastoMesAnterior}
          sePuedeCopiar={presupuesto.sePuedeCopiar}
          importe={importe}
          denominacion={denominacion}
          salidas={salidasDelPeriodo(barrioId, periodoId)}
        />
      ) : (
        <DosColumnas
          principal={<PresupuestoEnLectura presupuesto={presupuesto} />}
          lateral={importe ? <ImporteEnLectura presupuesto={presupuesto} denominacion={denominacion} /> : undefined}
        />
      )}
    </Pagina>
  );
}

/** Cambia cuando cambia lo guardado: la isla repone sus filas (al guardar o al copiar). */
function huellaDelPresupuesto(p: PresupuestoDelMes): string {
  return `${p.rubros.map((r) => `${r.conceptoId}=${r.presupuesto ?? ""}`).join("|")}|margen=${p.margen}`;
}

/** El presupuesto sin campos: un mes emitido, o quien no lo carga. Cero JavaScript. */
function PresupuestoEnLectura({ presupuesto: p }: { readonly presupuesto: PresupuestoDelMes }) {
  const mes = elMes(p.periodo);
  const anterior = elMes(p.mesAnterior);
  const presupuestados = p.rubros.filter((r) => r.presupuesto !== null);
  return (
    <Panel
      titulo="Lo que el barrio espera gastar"
      origen="Los rubros son los conceptos con los que se cargan los gastos. El presupuesto no cambia lo que se cobra: se compara contra lo gastado, en «Gastos y pagos»."
      sinRelleno
    >
      {presupuestados.length === 0 ? (
        <Vacio icono={<IconoBorrador />} titulo={`${mes.charAt(0).toUpperCase()}${mes.slice(1)} no tiene presupuesto cargado`}>
          {p.enPreparacion ? "Lo carga la administración del barrio mientras se prepara el mes." : "Se emitió sin presupuesto: no hay contra qué comparar los gastos."}
        </Vacio>
      ) : (
        <MarcoTabla etiqueta={`Presupuesto de ${mes}`}>
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Rubro
                </th>
                <th scope="col" className={ui.numerica}>
                  Gastado en {anterior}
                </th>
                <th scope="col" className={ui.numerica}>
                  Presupuesto de {mes}
                </th>
              </tr>
            </thead>
            <tbody>
              {presupuestados.map((r) => (
                <tr key={r.conceptoId}>
                  <th scope="row" className={ui.columnaAncla}>
                    <span className={ui.principal}>{r.nombre}</span>
                  </th>
                  <td className={ui.numerica}>
                    <Cifra monto={r.gastadoMesAnterior} nulo="—" />
                  </td>
                  <td className={ui.numerica}>
                    <Cifra monto={r.presupuesto} nulo="—" />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className={ui.columnaAncla}>
                  Gasto esperado
                </th>
                <td className={ui.numerica}>
                  <Cifra monto={p.gastoMesAnterior} nulo="—" />
                </td>
                <td className={ui.numerica}>
                  <Cifra monto={p.gastoEsperado} nulo="—" />
                </td>
              </tr>
              <tr>
                <th scope="row" className={ui.columnaAncla}>
                  Margen sobre el gasto
                  <br />
                  <span className={ui.secundaria}>Para imprevistos y para lo que no se cobre a tiempo</span>
                </th>
                <td className={ui.numerica}>—</td>
                <td className={ui.numerica}>
                  <Cifra monto={p.margen} nulo="—" />
                </td>
              </tr>
              <tr>
                <th scope="row" className={ui.columnaAncla}>
                  Total a pedir
                </th>
                <td className={ui.numerica}>—</td>
                <td className={ui.numerica}>
                  <Cifra monto={p.totalAPedir} nulo="—" />
                </td>
              </tr>
            </tfoot>
          </Tabla>
        </MarcoTabla>
      )}
    </Panel>
  );
}

/** El importe del mes para quien no lo define: el que rige y si cubre el presupuesto, sin botón. */
function ImporteEnLectura({ presupuesto: p, denominacion }: { readonly presupuesto: PresupuestoDelMes; readonly denominacion: string }) {
  const importe = p.importe;
  if (!importe) return null;
  const cuenta = importe.vigente
    ? cuentaDelImporte({ modo: importe.modo, unidades: importe.unidades, importe: importe.vigente, totalAPedir: p.totalAPedir })
    : null;
  const antes = enElMesAnterior(importe.modo, p.mesAnterior, importe.mesAnterior);
  return (
    <Panel titulo="Importe del mes" origen="El presupuesto propone; decide la administración.">
      <p className={ui.secundaria}>{rotuloDelImporte(importe.modo, denominacion)}</p>
      <p className={ui.principal}>
        <Cifra monto={importe.vigente} nulo="Todavía no está definido" />
      </p>
      {cuenta ? (
        <p>
          {cuenta.cuenta}. {cuenta.lectura}
        </p>
      ) : null}
      {antes ? <p className={ui.secundaria}>{antes}</p> : null}
    </Panel>
  );
}
