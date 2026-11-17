import type { Metadata } from "next";
import { moraDeLaAdministracion } from "@admin-barrios/data/servicios/mora";
import { Boton, CuerpoConBarraLateral } from "@admin-barrios/ui";
import { EncabezadoDePagina, Pagina, Vacio } from "../../../componentes/ui.tsx";
import { IconoBarrio } from "../../../componentes/iconos.tsx";
import { leerFiltroMora, parametrosDelFiltro } from "../../../componentes/mora/filtro.ts";
import { ListaDeMora } from "../../../componentes/mora/lista-de-mora.tsx";
import { barrios as cuantosBarrios } from "../../../componentes/mora/derivar.ts";
import { RUTA_MORA, rutaDelCsvDeMora } from "../../../rutas.ts";
import { conSesion } from "../../../servidor/db.ts";
import { BarraDeLaAdministracion, BarraDelBarrio } from "../barra-del-barrio.tsx";
import { barrioDeLaBarra, pedidoDeAdministracion, resolverAdministracion } from "../administracion-elegida.ts";
import estilos from "../admin.module.css";

export const metadata: Metadata = { title: "Mora · todos los barrios" };

/**
 * **Mora · todos los barrios** (encargo E-a; maqueta de mora, pantalla 1): las unidades con deuda
 * vencida de todos los barrios de la administración, en una sola lista, para derivar en lote a los
 * estudios. El sistema propone las que cumplen el criterio de **su** barrio; derivar es siempre una
 * decisión de la administración.
 *
 * Es una pantalla de la administración, fuera de todo barrio, como `/liquidacion-actual` y
 * `/configuracion`: qué administración muestra lo decide `elegirAdministracion` (la del
 * `?administracion=`, la única, o la del último barrio visitado), y la barra lateral es la del último
 * barrio, con este ítem marcado.
 */
export default async function MoraDeTodosLosBarrios({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const consulta = await searchParams;
  const filtro = leerFiltroMora(consulta, { conBarrio: true });
  const pedido = await pedidoDeAdministracion(consulta);

  // Secuenciales y en una transacción: `node-postgres` encola las consultas del mismo client.
  const datos = await conSesion(async (tx) => {
    const resuelta = await resolverAdministracion(tx, pedido);
    const mora = resuelta.elegida ? await moraDeLaAdministracion(tx, { administracionId: resuelta.elegida.id }) : null;
    return { resuelta, mora };
  });
  const { resuelta, mora } = datos;

  // Con más de una administración a la vista, los enlaces de la pantalla fijan cuál es.
  const conservar: Record<string, string> =
    resuelta.visibles.length > 1 && mora ? { administracion: mora.administracion.id } : {};
  const nombre = mora?.administracion.nombre ?? resuelta.elegida?.nombre ?? null;
  const barrioDeEsta = mora?.barrios.find((b) => b.id === filtro.barrio)?.nombre ?? null;

  const pantalla = (
    <Pagina>
      <EncabezadoDePagina
        migas={[{ texto: nombre ?? "Barrios", href: "/" }, { texto: "Mora · todos los barrios" }]}
        titulo="Mora · todos los barrios"
        bajada={
          mora
            ? `Las unidades con deuda vencida de ${mora.barrios.length === 1 ? "el barrio" : `los ${cuantosBarrios(mora.barrios.length)}`}. El sistema propone las que cumplen el criterio de cada barrio; derivar es siempre una decisión de la administración.`
            : undefined
        }
        acciones={
          mora ? (
            <Boton
              href={rutaDelCsvDeMora({ administracionId: mora.administracion.id }, parametrosDelFiltro(filtro))}
              variante="secundario"
              tamano="sm"
              etiqueta={`Bajar CSV de la mora${barrioDeEsta ? ` de ${barrioDeEsta}` : " de todos los barrios"}`}
            >
              Bajar CSV
            </Boton>
          ) : undefined
        }
      />
      {mora ? (
        <ListaDeMora mora={mora} filtro={filtro} ruta={RUTA_MORA} conservar={conservar} conBarrio />
      ) : (
        <Vacio icono={<IconoBarrio />} titulo="No hay barrios a la vista">
          La mora se arma con los barrios de la administración que podés ver.
        </Vacio>
      )}
    </Pagina>
  );

  const deLaBarra = mora ? barrioDeLaBarra(resuelta, mora.barrios.map((b) => b.id)) : (resuelta.barrios[0] ?? null);
  return (
    <CuerpoConBarraLateral
      barraLateral={
        deLaBarra ? (
          // Fuera de todo barrio: la barra lleva las secciones del último barrio visitado y el selector
          // dice «{administración} · todos los barrios», como en la configuración general.
          <BarraDelBarrio barrio={deLaBarra} barrios={resuelta.barrios} administracion={nombre} enConfiguracionGeneral />
        ) : (
          <BarraDeLaAdministracion nombre={nombre} activo="mora" conConfiguracionGeneral={resuelta.visibles.length > 0} />
        )
      }
    >
      <main id="contenido" className={estilos.contenido}>
        {pantalla}
      </main>
    </CuerpoConBarraLateral>
  );
}
