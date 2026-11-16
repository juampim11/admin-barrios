/**
 * **Gastos contra presupuesto** (encargo 16c; maqueta `devengado-conceptos.html`, pantalla 6): el
 * cuadro que va arriba de la lista de gastos, con el aviso del rubro que se pasó encima.
 *
 * Tabla de servidor, cero JavaScript (regla 8 del sistema de UI). Las cifras, la diferencia, el avance
 * y si un rubro se pasó los resuelve `gastosContraPresupuesto`; acá solo se dicen. Vale igual en un mes
 * en preparación que en uno emitido: el gasto se sigue cargando después de emitir.
 */

import { avisosDelMes } from "@admin-barrios/data/servicios/circuito-del-mes";
import { gastosContraPresupuesto } from "@admin-barrios/data/servicios/presupuesto";
import { BarraDeAvance, Chip, ImporteConSigno } from "@admin-barrios/ui";
import { Cifra, MarcoTabla, Nota, Panel, PilaDeNotas, Tabla, ui } from "../../../../../../componentes/ui.tsx";
import { conSesion } from "../../../../../../servidor/db.ts";
import { avisosDeRubrosExcedidos, conSigno, FUERA_DEL_PRESUPUESTO, marcaDelRubro } from "./textos.ts";

export async function GastosContraPresupuesto({ periodoId, rutaPresupuesto }: { readonly periodoId: string; readonly rutaPresupuesto: string }) {
  // Secuenciales y en una transacción: `node-postgres` encola las consultas del mismo client.
  const { cuadro, avisos } = await conSesion(async (tx) => ({
    cuadro: await gastosContraPresupuesto(tx, { periodoId }),
    avisos: await avisosDelMes(tx, { periodoId }),
  }));
  if (!cuadro.hayPresupuesto) return null;

  const excedidos = avisosDeRubrosExcedidos(avisos);
  const total = conSigno(cuadro.totalDiferencia);

  return (
    <>
      {excedidos.length > 0 ? (
        <PilaDeNotas>
          {excedidos.map((a) => (
            <Nota key={a.titulo} tono="alerta" titulo={`${a.titulo}.`}>
              {a.detalle}
            </Nota>
          ))}
        </PilaDeNotas>
      ) : null}

      <Panel
        titulo="Gastos contra presupuesto"
        origen={
          <>
            Lo gastado es la suma de los gastos cargados en el mes en cada rubro (un ajuste negativo resta); el presupuesto es el
            que se cargó en <a href={rutaPresupuesto}>Presupuesto</a>. Diferencia = presupuesto − gastado. El total compara solo los
            rubros presupuestados.
          </>
        }
        sinRelleno
      >
        <MarcoTabla etiqueta="Gastos contra presupuesto">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Rubro
                </th>
                <th scope="col" className={ui.numerica}>
                  Presupuesto
                </th>
                <th scope="col" className={ui.numerica}>
                  Gastado
                </th>
                <th scope="col" className={ui.numerica}>
                  Diferencia
                </th>
                <th scope="col">Avance</th>
              </tr>
            </thead>
            <tbody>
              {cuadro.rubros.map((r) => {
                const marca = marcaDelRubro(r);
                const diferencia = r.diferencia === null ? null : conSigno(r.diferencia);
                return (
                  <tr key={r.conceptoId}>
                    <th scope="row" className={ui.columnaAncla}>
                      <span className={ui.principal}>{r.nombre}</span>{" "}
                      {marca ? <Chip tono={marca.tono}>{marca.texto}</Chip> : null}
                      {r.presupuesto === null ? <span className={ui.secundaria}> · {FUERA_DEL_PRESUPUESTO}</span> : null}
                    </th>
                    <td className={ui.numerica}>
                      <Cifra monto={r.presupuesto} nulo="—" />
                    </td>
                    <td className={ui.numerica}>
                      <Cifra monto={r.gastado} nulo="—" />
                    </td>
                    <td className={ui.numerica}>
                      {diferencia ? <ImporteConSigno texto={diferencia.texto} negativo={diferencia.negativo} /> : "—"}
                    </td>
                    <td>
                      <BarraDeAvance avance={r.avance} excedido={r.excedido} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className={ui.columnaAncla}>
                  Total
                </th>
                <td className={ui.numerica}>
                  <Cifra monto={cuadro.totalPresupuesto} nulo="—" />
                </td>
                <td className={ui.numerica}>
                  <Cifra monto={cuadro.totalGastado} nulo="—" />
                </td>
                <td className={ui.numerica}>
                  <ImporteConSigno texto={total.texto} negativo={total.negativo} />
                </td>
                <td />
              </tr>
            </tfoot>
          </Tabla>
        </MarcoTabla>
      </Panel>
    </>
  );
}
