import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { configuracionDePlanes, type PlanDelCatalogo } from "@admin-barrios/data/servicios/planes-configuracion";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { TEXTO_MODO_DE_COBRO, TEXTO_ORDEN_DE_IMPUTACION } from "@admin-barrios/shared/planes";
import { Chip, CuerpoConBarraLateral } from "@admin-barrios/ui";
import { EncabezadoDePagina, MarcoTabla, Nota, Pagina, Panel, Tabla, Vacio, ui } from "../../../../componentes/ui.tsx";
import { rutaDeConfiguracionGeneral } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import { BarraDeLaAdministracion, BarraDelBarrio } from "../../barra-del-barrio.tsx";
import { barrioDeLaBarra, pedidoDeAdministracion, resolverAdministracion } from "../../administracion-elegida.ts";
import { AgregarPlan, DarDeBajaPlan, EditarPlan, EditarReglas } from "./formularios.tsx";
import estilos from "../../admin.module.css";

export const metadata: Metadata = { title: "Planes de pago" };

/** «2 a 6 cuotas» / «3 cuotas». */
const textoCuotas = (p: PlanDelCatalogo): string =>
  p.cuotasMin === p.cuotasMax ? `${p.cuotasMax} ${p.cuotasMax === 1 ? "cuota" : "cuotas"}` : `${p.cuotasMin} a ${p.cuotasMax} cuotas`;

const textoAnticipo = (p: PlanDelCatalogo): string =>
  p.anticipo === "no"
    ? "Sin anticipo"
    : `Anticipo ${p.anticipo === "opcional" ? "opcional" : "obligatorio"}, hasta ${p.anticipoMaxPorcentaje ?? "—"} %`;

const textoFinanciacion = (p: PlanDelCatalogo): string =>
  p.sistema === "frances" ? `Francés, ${p.tasaPorcentaje ?? "—"} % mensual` : "Cuota fija, sin interés";

/**
 * **Configuración general › Planes de pago** (P2a-1; maqueta de planes, pantalla 1): los planes estándar
 * que la administración acordó con cada estudio —al elegir uno, el sistema arma las cuotas solo— y las
 * reglas de los planes en cada barrio.
 *
 * Misma elección de administración y misma barra lateral que la configuración general y los estudios.
 * Los botones, solo para quien puede editar (`puedeEditar`); la RLS lo vuelve a decidir al escribir.
 * Las tablas no tienen scroll lateral a 1280 px: cada celda va en renglones (principal y secundario),
 * como en Estudios jurídicos.
 */
export default async function PlanesDePago({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const pedido = await pedidoDeAdministracion(await searchParams);
  const datos = await conSesion(async (tx) => {
    const resuelta = await resolverAdministracion(tx, pedido);
    const cfg = resuelta.elegida ? await configuracionDePlanes(tx, { administracionId: resuelta.elegida.id }) : null;
    return { resuelta, cfg };
  });
  const { resuelta, cfg } = datos;
  if (!cfg) notFound();

  const unaSola = resuelta.visibles.length <= 1;
  const admin = cfg.administracion;
  const opciones = {
    administracionId: admin.id,
    estudios: cfg.estudios.map((e) => ({ valor: e.id, texto: e.nombre })),
    barrios: cfg.barrios,
  };
  const todos = cfg.barrios.length;

  const pantalla = (
    <Pagina>
      <EncabezadoDePagina
        migas={[
          { texto: admin.nombre, href: "/" },
          { texto: "Configuración general", href: unaSola ? rutaDeConfiguracionGeneral() : rutaDeConfiguracionGeneral(admin.id) },
          { texto: "Planes de pago" },
        ]}
        titulo="Planes de pago"
        bajada="Los planes estándar que la administración acordó con cada estudio. Al elegir uno, el sistema arma las cuotas solo y lo aprueba la administración. Lo que no entra acá se arma a medida."
        acciones={cfg.puedeEditar ? <AgregarPlan opciones={opciones} /> : <Chip tono="neutro">Solo lectura</Chip>}
      />

      {cfg.planes.length === 0 ? (
        <Vacio titulo="Todavía no hay ningún plan estándar">
          {cfg.puedeEditar ? "Agregá el primero con «Agregar un plan». Mientras tanto, los planes se arman a medida." : "Los agrega la administración."}
        </Vacio>
      ) : (
        <MarcoTabla etiqueta="Planes de pago estándar de la administración">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Plan
                </th>
                <th scope="col">Cuotas y anticipo</th>
                <th scope="col">Financiación</th>
                <th scope="col">Para</th>
                <th scope="col">Quién cobra</th>
                {cfg.puedeEditar ? (
                  <th scope="col">
                    <span className={ui.soloLectores}>Acciones</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {cfg.planes.map((p) => (
                <tr key={p.id}>
                  <th scope="row" className={ui.columnaAncla}>
                    <span className={ui.principal}>{p.nombre}</span>
                    <br />
                    <span className={ui.secundaria}>
                      {p.deudaMaxima ? `Deuda de hasta $ ${formatearMonto(p.deudaMaxima)}` : "Sin tope de deuda"}
                    </span>
                    {p.activo ? null : (
                      <>
                        <br />
                        <Chip tono="neutro">De baja</Chip>
                      </>
                    )}
                  </th>
                  <td>
                    <span className={ui.principal}>{textoCuotas(p)}</span>
                    <br />
                    <span className={ui.secundaria}>{textoAnticipo(p)}</span>
                  </td>
                  <td>{textoFinanciacion(p)}</td>
                  <td>
                    <span className={ui.principal}>
                      {p.barrios.length === todos && todos > 1 ? "Todos los barrios" : p.barrios.map((b) => b.nombre).join(" · ")}
                    </span>
                    <br />
                    <span className={ui.secundaria}>{p.estudio ? `${p.estudio.nombre} y la administración` : "Solo la administración"}</span>
                  </td>
                  <td>{TEXTO_MODO_DE_COBRO[p.modoCobro]}</td>
                  {cfg.puedeEditar ? (
                    <td>
                      {p.activo ? (
                        <>
                          <EditarPlan
                            opciones={opciones}
                            plan={{
                              id: p.id,
                              nombre: p.nombre,
                              sistema: p.sistema,
                              tasaPorcentaje: p.tasaPorcentaje,
                              cuotasMin: p.cuotasMin,
                              cuotasMax: p.cuotasMax,
                              anticipo: p.anticipo,
                              anticipoMaxPorcentaje: p.anticipoMaxPorcentaje,
                              deudaMaxima: p.deudaMaxima,
                              estudioId: p.estudio?.id ?? null,
                              modoCobro: p.modoCobro,
                              barrioIds: p.barrios.map((b) => b.id),
                            }}
                          />{" "}
                          <DarDeBajaPlan administracionId={admin.id} plan={{ id: p.id, nombre: p.nombre, usos: p.usos }} />
                        </>
                      ) : (
                        <span className={ui.secundaria}>No se ofrece más.</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Tabla>
        </MarcoTabla>
      )}

      <Panel titulo="Reglas de cada barrio" origen="Rigen para los planes de ese barrio, del catálogo y a medida.">
        <MarcoTabla etiqueta="Reglas de los planes en cada barrio">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Barrio
                </th>
                <th scope="col">El plan cae con</th>
                <th scope="col">Si el pago no dice a qué va</th>
                <th scope="col">Interés y quita</th>
                {cfg.puedeEditar ? (
                  <th scope="col">
                    <span className={ui.soloLectores}>Acciones</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {cfg.reglas.map((r) => (
                <tr key={r.barrioId}>
                  <th scope="row" className={ui.columnaAncla}>
                    <span className={ui.principal}>{r.barrio}</span>
                    {r.cargadas ? null : (
                      <>
                        <br />
                        <span className={ui.secundaria}>Las de por defecto</span>
                      </>
                    )}
                  </th>
                  <td>{r.cuotasParaCaer === 1 ? "1 cuota impaga" : `${r.cuotasParaCaer} cuotas impagas`}</td>
                  <td>{TEXTO_ORDEN_DE_IMPUTACION[r.ordenImputacion]}</td>
                  <td>
                    <span className={ui.principal}>
                      {r.financiaMora ? "La mora que entra se financia" : "La mora que entra no genera interés"}
                    </span>
                    <br />
                    <span className={ui.secundaria}>
                      {r.quitaRequiereActa ? "Una quita necesita el acta del barrio" : "Una quita la aprueba la administración"}
                    </span>
                  </td>
                  {cfg.puedeEditar ? (
                    <td>
                      <EditarReglas reglas={r} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Tabla>
        </MarcoTabla>
      </Panel>

      <Nota tono="neutro" titulo="Si el plan cae, vuelve la deuda original menos lo pagado, con la mora recalculada.">
        El acuerdo no reemplaza la deuda original. «Quién cobra» se elige en cada plan: si cobra el barrio, la cuota sale en
        la boleta; si cobra el estudio, la cobra él y le rinde al barrio. Los honorarios nunca entran en el plan.
      </Nota>
    </Pagina>
  );

  const deLaBarra = barrioDeLaBarra(resuelta, resuelta.barrios.map((b) => b.id));
  return (
    <CuerpoConBarraLateral
      barraLateral={
        deLaBarra ? (
          <BarraDelBarrio barrio={deLaBarra} barrios={resuelta.barrios} administracion={admin.nombre} enConfiguracionGeneral />
        ) : (
          <BarraDeLaAdministracion nombre={admin.nombre} activo="configuracion" conConfiguracionGeneral />
        )
      }
    >
      <main id="contenido" className={estilos.contenido}>
        {pantalla}
      </main>
    </CuerpoConBarraLateral>
  );
}
