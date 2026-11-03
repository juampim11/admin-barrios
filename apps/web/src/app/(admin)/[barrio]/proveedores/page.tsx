import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarOrdenesPago } from "@admin-barrios/data/servicios/ordenes-pago";
import { listarProveedores } from "@admin-barrios/data/servicios/proveedores";
import { sumarMontos } from "@admin-barrios/shared/dinero";
import { BarraDeFiltros, BusquedaDeLista, FiltroDeLista, FiltrosDeLista, PanelDesplegable } from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../componentes/iconos.tsx";
import { EncabezadoDePagina, MarcoTabla, Pagina, Panel, Tabla, Vacio, ui } from "../../../../componentes/ui.tsx";
import { esIdValido, hrefDeLista, migaDelBarrio, rutasDeProveedores, salidasDeProveedores } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import { FilaDeProveedor, FormularioDeProveedor } from "./formularios.tsx";

export const metadata: Metadata = { title: "Proveedores" };

const FILTROS_PROVEEDORES = ["todos", "activos", "inactivos"] as const;
type FiltroProveedores = (typeof FILTROS_PROVEEDORES)[number];
const NOMBRE_DEL_FILTRO: Record<FiltroProveedores, string> = { todos: "Todos", activos: "Activos", inactivos: "Inactivos" };

/** Filtro y búsqueda llegan por la URL, o sea del cliente: se validan con Zod. Un filtro desconocido es «Todos». */
const consultaSchema = z.object({
  filtro: z.enum(FILTROS_PROVEEDORES).catch("todos"),
  q: z.string().trim().max(80).catch(""),
});

/**
 * El catálogo de proveedores del barrio: alta, corrección, desactivación y reactivación.
 *
 * **Sin paginado, a propósito.** Es el mismo criterio que `liquidacion/page.tsx` con los períodos: un
 * catálogo de proveedores de un barrio no llega al volumen que justifica cortar la lista, y acá
 * además hace falta el total activo/inactivo, que con paginado dejaría de ser una cuenta simple.
 *
 * **Trae también los inactivos** (`listarProveedores`, activos primero): una orden de pago vieja
 * puede seguir necesitando nombrar a un proveedor que después se desactivó, y desde acá se lo puede
 * reactivar en cualquier momento — "se desactiva, nunca se borra" es reversible (`formularios.tsx`
 * tiene la nota completa sobre la regresión que esto corrigió, 2026-08-26).
 *
 * **Filtros y búsqueda, como el padrón** (encargo 8, T1): «Todos» / «Activos» / «Inactivos» son links
 * (`?filtro=`) con su conteo y la búsqueda es un `<form method="get">` (`?q=`), sin JavaScript. Como
 * la lista ya llega entera, filtro, búsqueda y conteos se resuelven sobre esas mismas filas, acá en el
 * servidor: por razón social (parcial, sin distinguir mayúsculas) o por CUIT (6 dígitos o más, con o
 * sin guiones — el mismo umbral que el padrón usa para un documento).
 */
export default async function Proveedores({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const crudos = await searchParams;
  const unico = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const consulta = consultaSchema.parse({ filtro: unico(crudos["filtro"]), q: unico(crudos["q"]) });

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    proveedores: await listarProveedores(tx, { barrioId }),
    ordenes: await listarOrdenesPago(tx, { barrioId }),
  }));

  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const proveedores = datos.proveedores;
  const activos = proveedores.filter((p) => p.activo).length;
  const salidas = salidasDeProveedores(barrio.id);

  const ruta = rutasDeProveedores(barrio.id).grilla;
  const filtro = consulta.filtro;
  const hrefFiltro = (f: FiltroProveedores, q: string = consulta.q): string =>
    hrefDeLista(ruta, { filtro: f === "todos" ? null : f, q });
  const texto = consulta.q.toLowerCase();
  const digitos = consulta.q.replace(/\D/g, "");
  const coincide = (p: (typeof proveedores)[number]): boolean =>
    texto === "" ||
    p.razonSocial.toLowerCase().includes(texto) ||
    (digitos.length >= 6 && p.cuit !== null && p.cuit.replace(/\D/g, "").includes(digitos));
  const visibles = proveedores
    .filter((p) => (filtro === "activos" ? p.activo : filtro === "inactivos" ? !p.activo : true))
    .filter(coincide);

  // Lo que el diálogo de «Desactivar» dice de la plata: las órdenes de ese proveedor que todavía no se
  // pagaron (pendientes de aprobar o aprobadas), con su suma. Leído acá, de la misma lista que ve la
  // pantalla de órdenes de pago; el diálogo no calcula nada.
  const sinPagarPorProveedor = new Map<string, { cantidad: number; monto: string }>();
  for (const orden of datos.ordenes) {
    if (orden.estado !== "pendiente" && orden.estado !== "aprobada") continue;
    const previo = sinPagarPorProveedor.get(orden.proveedorId);
    sinPagarPorProveedor.set(orden.proveedorId, {
      cantidad: (previo?.cantidad ?? 0) + 1,
      monto: sumarMontos(previo?.monto ?? "0.00", orden.monto),
    });
  }

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio(barrio), { texto: "Proveedores" }]}
        titulo="Proveedores"
        bajada={`El catálogo de proveedores de ${barrio.nombre}. ${activos} activos de ${proveedores.length} — se desactivan, nunca se borran: una orden de pago vieja puede seguir necesitando nombrar a uno inactivo.`}
      />

      <PanelDesplegable
        titulo="Nuevo proveedor"
        origen="Alta contra el catálogo del barrio."
        abiertoPorDefecto={proveedores.length === 0}
      >
        <FormularioDeProveedor barrioId={barrio.id} salidas={salidas} />
      </PanelDesplegable>

      <BarraDeFiltros>
        <FiltrosDeLista etiqueta="Filtrar los proveedores">
          <FiltroDeLista href={hrefFiltro("todos")} activo={filtro === "todos"} cantidad={proveedores.length}>
            Todos
          </FiltroDeLista>
          <FiltroDeLista href={hrefFiltro("activos")} activo={filtro === "activos"} cantidad={activos}>
            Activos
          </FiltroDeLista>
          <FiltroDeLista href={hrefFiltro("inactivos")} activo={filtro === "inactivos"} cantidad={proveedores.length - activos}>
            Inactivos
          </FiltroDeLista>
        </FiltrosDeLista>
        {/* Sin JavaScript: el navegador arma `?filtro=…&q=…` y el servidor resuelve. */}
        <BusquedaDeLista
          accion={ruta}
          valor={consulta.q}
          etiqueta="Buscar por razón social o CUIT"
          conservar={filtro !== "todos" ? { filtro } : {}}
        />
      </BarraDeFiltros>

      <Panel
        titulo="Catálogo del barrio"
        origen={
          consulta.q !== "" ? (
            <>
              Resultado de buscar «{consulta.q}». <Link href={hrefFiltro(filtro, "")}>Ver sin la búsqueda</Link>
            </>
          ) : (
            "Activos primero, después los desactivados."
          )
        }
        sinRelleno
      >
        {proveedores.length === 0 ? (
          <Vacio icono={<IconoBorrador />} titulo="Todavía no hay ningún proveedor cargado">
            Un gasto o una orden de pago se imputan siempre a un proveedor del catálogo. Se carga desde
            «Nuevo proveedor», arriba.
          </Vacio>
        ) : visibles.length === 0 ? (
          <Vacio
            icono={<IconoBorrador />}
            titulo={
              consulta.q !== "" ? "Ningún proveedor coincide con la búsqueda" : `No hay proveedores en el filtro «${NOMBRE_DEL_FILTRO[filtro]}»`
            }
          >
            {consulta.q !== "" ? (
              <>
                Se buscó «{consulta.q}»{filtro !== "todos" ? ` con el filtro «${NOMBRE_DEL_FILTRO[filtro]}»` : ""}. Probá
                con parte de la razón social o con el CUIT, o <Link href={hrefFiltro("todos", "")}>mirá todo el catálogo</Link>.
              </>
            ) : (
              <>
                {filtro === "activos" ? "Todos los proveedores del barrio están desactivados." : "Ningún proveedor del barrio está desactivado."}{" "}
                Para sacar el filtro, <Link href={hrefFiltro("todos")}>mirá todo el catálogo</Link>.
              </>
            )}
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Proveedores del barrio">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Razón social
                  </th>
                  <th scope="col">CUIT</th>
                  <th scope="col">Contacto</th>
                  <th scope="col">CBU / alias</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((proveedor) => (
                  <FilaDeProveedor
                    key={proveedor.id}
                    proveedor={proveedor}
                    sinPagar={sinPagarPorProveedor.get(proveedor.id) ?? null}
                    salidas={salidas}
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
