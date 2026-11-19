import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { consecuenciasDeAnularRendicion, rendicion as leerRendicion } from "@admin-barrios/data/servicios/planes-rendicion";
import { Chip } from "@admin-barrios/ui";
import { Definicion, Definiciones, EncabezadoDePagina, MarcoTabla, Nota, Pagina, Panel, Tabla, Vacio, ui } from "../../../../../componentes/ui.tsx";
import { AdjuntarPdf, AgregarCuota, AgregarIngreso, AnularRendicion, Confirmar, Quitar } from "../../../../../componentes/rendiciones/formularios.tsx";
import { esIdValido, migaDelBarrio, rutaDelArchivoDeRendicion, rutaDeRendiciones } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { subidaConfigurada } from "../../../../../servidor/almacenamiento.ts";

export const metadata: Metadata = { title: "Rendición del estudio" };

const TEXTO_DEL_PAGO = {
  pagada: "Pagada · rendición",
  parcial: "Pago parcial · rendición",
  reimputado: "Reimputado por la caída del plan",
  anulado: "Pago anulado con la rendición",
} as const;
const TONO_DEL_PAGO = { pagada: "exito", parcial: "alerta", reimputado: "neutro", anulado: "neutro" } as const;

/**
 * **Una rendición del estudio** (encargo P2b; maqueta de planes de pago, pantalla 5): las cuotas que
 * cobró (unidad, cuota, cómo le pagó el vecino e importe), cómo le llegó la plata al barrio (uno o
 * varios ingresos a su cuenta, con su comprobante), el PDF firmado y el cuadre. Se confirma cuando las
 * cuotas y los ingresos suman lo mismo; al confirmarla, cada ingreso queda como pago de sus cuotas.
 *
 * Una lectura bajo RLS (`rendicion`); las islas escriben con sus acciones. El barrio de la URL elige,
 * no autoriza.
 */
export default async function RendicionDelEstudio({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly rendicion: string }>;
}) {
  const { barrio: barrioId, rendicion: rendicionId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(rendicionId)) notFound();
  const datos = await conSesion(async (tx) => {
    const r = await leerRendicion(tx, { rendicionId });
    // [F4 tramo 3] Lo que el diálogo de «Anular la rendición» muestra antes de confirmar.
    const consecuencias = r.puedeAnular ? await consecuenciasDeAnularRendicion(tx, { rendicionId }) : [];
    return { r, consecuencias };
  });
  const r = datos.r;
  if (!r || r.barrioId !== barrioId) notFound();
  const subir = subidaConfigurada();
  const editar = r.puedeEditar && subir;
  // [F4 tramo 3] Cuatro ojos primero: si la cargó quien mira, no la confirma aunque cuadre.
  const motivo = r.laConfirmaOtraPersona
    ? "La confirma otra persona de la administración."
    : !r.documento
      ? "Falta adjuntar la rendición firmada por el estudio (PDF)."
      : !r.cuadra
        ? "Se confirma cuando las cuotas y los ingresos suman lo mismo."
        : null;

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio({ id: r.barrioId, nombre: r.barrioNombre }), { texto: "Rendiciones de estudios", href: rutaDeRendiciones(r.barrioId) }, { texto: r.periodo }]}
        titulo={`Rendición de ${r.estudio} · ${r.periodo}`}
        etiquetas={
          r.estado === "anulada" ? (
            <Chip tono="peligro">Anulada</Chip>
          ) : r.estado === "confirmada" ? (
            <Chip tono="exito">{`Confirmada el ${r.confirmada ?? ""}`}</Chip>
          ) : (
            <Chip tono="alerta">Borrador</Chip>
          )
        }
        bajada="La rendición es el informe del estudio: qué cuotas cobró, a quién y cuándo. La plata le puede llegar al barrio en una o varias transferencias o depósitos. Los honorarios los retiene el estudio y no entran."
      />

      {r.anulada ? (
        <Nota tono="alerta" titulo={r.anulada}>
          Sus pagos quedaron anulados y las cuotas volvieron a deber lo que debían antes. No se borró nada: abajo sigue lo que se había
          imputado. Una rendición anulada no se modifica ni se vuelve a confirmar.
        </Nota>
      ) : null}

      <Panel titulo="Rendición firmada por el estudio" origen="El PDF que mandó el estudio, con su código de control (SHA-256).">
        {r.documento ? (
          <Definiciones>
            <Definicion termino="Archivo">
              <a href={rutaDelArchivoDeRendicion(r.id)} aria-label={`Ver ${r.documento.nombre}`}>
                {r.documento.nombre}
              </a>
            </Definicion>
            <Definicion termino="Código de control">
              <code>{r.documento.codigoDeControl}</code>
            </Definicion>
          </Definiciones>
        ) : (
          <p>Todavía no se adjuntó.</p>
        )}
        {editar ? <AdjuntarPdf rendicionId={r.id} hayUno={r.documento !== null} /> : null}
      </Panel>

      <Panel titulo="1 · Cuotas que cobró el estudio" origen="De los planes que cobra este estudio en el barrio. Cómo le pagó el vecino se anota como información: es entre el vecino y el estudio.">
        {r.cuotas.length === 0 ? (
          <Vacio titulo="Todavía no hay cuotas">Agregá cada cuota que cobró el estudio. Si cobró parte, va como pago parcial.</Vacio>
        ) : (
          <MarcoTabla etiqueta="Cuotas que cobró el estudio">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Unidad
                  </th>
                  <th scope="col">Plan y cuota</th>
                  <th scope="col">El vecino le pagó al estudio</th>
                  <th scope="col" className={ui.numerica}>
                    Importe
                  </th>
                  {r.puedeEditar ? <th scope="col">Quitar</th> : null}
                </tr>
              </thead>
              <tbody>
                {r.cuotas.map((c) => (
                  <tr key={c.id}>
                    <th scope="row" className={ui.columnaAncla}>
                      {c.unidad}
                    </th>
                    <td>
                      {c.plan} · {c.cuota}
                      {c.parcial ? " · pago parcial" : ""}
                    </td>
                    <td>{c.cobro}</td>
                    <td className={ui.numerica}>{c.importe}</td>
                    {r.puedeEditar ? (
                      <td>
                        <Quitar id={c.id} que="cuota" etiqueta={`Quitar ${c.cuota} de ${c.unidad}`} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" className={ui.columnaAncla}>
                    {r.cuotas.length === 1 ? "1 cuota" : `${r.cuotas.length} cuotas`}
                  </th>
                  <td />
                  <td />
                  <td className={ui.numerica}>{r.totalCuotas}</td>
                  {r.puedeEditar ? <td /> : null}
                </tr>
              </tfoot>
            </Tabla>
          </MarcoTabla>
        )}
        {r.puedeEditar ? (
          r.paraRendir.length > 0 ? (
            <AgregarCuota rendicionId={r.id} paraRendir={r.paraRendir} />
          ) : (
            <p>No quedan cuotas emitidas con saldo en los planes que cobra este estudio.</p>
          )
        ) : null}
      </Panel>

      <Panel titulo="2 · Cómo le llegó la plata al barrio" origen="Por banco, a la cuenta del barrio, para que aparezca en el extracto. Cada ingreso con su comprobante.">
        {r.ingresos.length === 0 ? (
          <Vacio titulo="Todavía no hay ingresos">Agregá cada transferencia o depósito con su comprobante.</Vacio>
        ) : (
          <MarcoTabla etiqueta="Ingresos al barrio">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Fecha
                  </th>
                  <th scope="col">Medio</th>
                  <th scope="col">Comprobante</th>
                  <th scope="col" className={ui.numerica}>
                    Importe
                  </th>
                  {r.puedeEditar ? <th scope="col">Quitar</th> : null}
                </tr>
              </thead>
              <tbody>
                {r.ingresos.map((i) => (
                  <tr key={i.id}>
                    <th scope="row" className={ui.columnaAncla}>
                      {i.fecha}
                    </th>
                    <td>
                      {i.medio} a la cuenta del barrio ({i.cuenta})
                    </td>
                    <td>
                      <a href={rutaDelArchivoDeRendicion(r.id, i.id)} aria-label={`Ver el comprobante del ${i.fecha}`}>
                        {i.comprobante}
                      </a>
                    </td>
                    <td className={ui.numerica}>{i.importe}</td>
                    {r.puedeEditar ? (
                      <td>
                        <Quitar id={i.id} que="ingreso" etiqueta={`Quitar el ingreso del ${i.fecha}`} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" className={ui.columnaAncla}>
                    {r.ingresos.length === 1 ? "1 ingreso" : `${r.ingresos.length} ingresos`}
                  </th>
                  <td />
                  <td />
                  <td className={ui.numerica}>{r.totalIngresos}</td>
                  {r.puedeEditar ? <td /> : null}
                </tr>
              </tfoot>
            </Tabla>
          </MarcoTabla>
        )}
        {editar ? (
          r.cuentaDelBarrio ? (
            <AgregarIngreso rendicionId={r.id} cuenta={`CBU terminado en ${r.cuentaDelBarrio.slice(-4)}`} />
          ) : (
            <p>El barrio no tiene cargada su cuenta bancaria: cargala en la configuración del barrio para registrar ingresos.</p>
          )
        ) : null}
      </Panel>

      <Panel titulo="El cuadre" origen="Cuotas cobradas contra ingresos al barrio.">
        <Definiciones>
          <Definicion termino="Cuotas cobradas">{r.totalCuotas}</Definicion>
          <Definicion termino="Ingresos al barrio">{r.totalIngresos}</Definicion>
          <Definicion termino="Diferencia">{r.diferencia}</Definicion>
        </Definiciones>
        {r.puedeEditar ? <Confirmar rendicionId={r.id} habilitado={motivo === null} motivo={motivo} /> : null}
        {r.puedeEditar && !subir ? <p>Por ahora no se pueden subir archivos desde acá: el PDF y los comprobantes se agregan cuando esté habilitado.</p> : null}
      </Panel>

      {r.estado !== "borrador" ? (
        <Panel titulo="Lo que quedó imputado" origen="Cada pedazo de ingreso es un pago imputado a su cuota, con la fecha del ingreso.">
          <MarcoTabla etiqueta="Pagos de la rendición">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Unidad
                  </th>
                  <th scope="col">Cuota</th>
                  <th scope="col">Fecha del pago</th>
                  <th scope="col" className={ui.numerica}>
                    Importe
                  </th>
                  <th scope="col">Estado de la cuota</th>
                </tr>
              </thead>
              <tbody>
                {r.pagos.map((p, n) => (
                  <tr key={n}>
                    <th scope="row" className={ui.columnaAncla}>
                      {p.unidad}
                    </th>
                    <td>{p.cuota}</td>
                    <td>{p.fecha}</td>
                    <td className={ui.numerica}>{p.importe}</td>
                    <td>
                      <Chip tono={TONO_DEL_PAGO[p.estado]}>{TEXTO_DEL_PAGO[p.estado]}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
          {r.puedeAnular ? (
            <AnularRendicion
              rendicionId={r.id}
              consecuencias={datos.consecuencias.map((c) => c.texto)}
              bloqueo={datos.consecuencias.find((c) => c.bloquea)?.texto ?? null}
            />
          ) : null}
        </Panel>
      ) : null}
    </Pagina>
  );
}
