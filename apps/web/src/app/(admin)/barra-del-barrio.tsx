import {
  BarraLateralDeLaAdministracion,
  BarraLateralDelBarrio,
  Chip,
  IconoAdministracion,
  IconoTablero,
  ItemDeSeccion,
  SeparadorDeSecciones,
  type BarrioParaSelector,
} from "@admin-barrios/ui";
// La subruta `cliente/*` es la frontera declarada: acá, y solo acá, la barra manda JavaScript al
// navegador (ADR-0003 §4). El resto es servidor.
import { SelectorDeBarrio, type OpcionTodosLosBarrios } from "@admin-barrios/ui/cliente/selector-de-barrio";
import type { BarrioAccesible } from "@admin-barrios/data/servicios/barrios";
import { etiquetaFiguraCorta, ROL } from "../../componentes/etiquetas.tsx";
import { portadaDelBarrio, RUTA_CONFIGURACION_GENERAL, rutaDeConfiguracionGeneralDesde } from "../../rutas.ts";
import { NavegacionDelBarrio } from "./[barrio]/navegacion.tsx";

type BarrioDeLaBarra = Pick<BarrioAccesible, "id" | "nombre" | "figuraJuridica" | "denominacionConcepto" | "roles">;

/** Un barrio en la forma que el selector entiende. */
export const paraSelector = (barrio: BarrioDeLaBarra): BarrioParaSelector => ({
  id: barrio.id,
  nombre: barrio.nombre,
  figura: etiquetaFiguraCorta(barrio.figuraJuridica),
  detalle: barrio.denominacionConcepto,
  href: portadaDelBarrio(barrio.id),
});

/**
 * **La barra lateral, armada una sola vez para los dos lugares que la muestran**: el layout del
 * barrio y la configuración general de la administración (`/configuracion`, encargo 8, T1 §4).
 *
 * En la configuración general la barra es **la misma** —un solo chrome con el foco corrido (doc 06
 * §c.6.1), como la dibuja la maqueta `mora-parametros.html`—: las secciones son las del último barrio
 * visitado (salir de la configuración general es volver a él), el ítem marcado es «Configuración
 * general · todos los barrios», y el selector dice «{administración} · todos los barrios».
 *
 * Es composición, no estilo: cómo se ve cada pieza lo decide `packages/ui`.
 */
export function BarraDelBarrio({
  barrio,
  barrios,
  administracion,
  enConfiguracionGeneral = false,
}: {
  /** El barrio cuyas secciones se listan: el actual, o el último visitado desde la configuración general. */
  readonly barrio: BarrioDeLaBarra;
  /** Todos los barrios que ve quien mira, para el selector. */
  readonly barrios: readonly BarrioDeLaBarra[];
  /** El nombre de la administración del barrio, si se lo conoce (rótulo de «Todos los barrios»). */
  readonly administracion: string | null;
  readonly enConfiguracionGeneral?: boolean;
}) {
  const todos: OpcionTodosLosBarrios = {
    texto: administracion ? `${administracion} · todos los barrios` : "Todos los barrios",
    detalle: "Configuración general",
    href: rutaDeConfiguracionGeneralDesde(barrio.id),
  };

  /*
   * Con un solo barrio accesible no hay nada que elegir: va el título fijo, no un control desplegable
   * con una única opción (doc 06 §c.6.2). «Todos los barrios» igual se alcanza desde el ítem de la
   * barra. En la configuración general el título fijo dice de quién es la pantalla.
   */
  const selector =
    barrios.length > 1 ? (
      <SelectorDeBarrio
        actualId={enConfiguracionGeneral ? null : barrio.id}
        barrios={barrios.map(paraSelector)}
        todos={todos}
      />
    ) : null;

  return (
    <BarraLateralDelBarrio
      barrioId={barrio.id}
      nombre={enConfiguracionGeneral ? todos.texto : barrio.nombre}
      selector={selector}
      figura={<Chip tono="neutro">{etiquetaFiguraCorta(barrio.figuraJuridica)}</Chip>}
      roles={barrio.roles.map((rol) => (
        <Chip key={rol} tono="marca">
          {ROL[rol]}
        </Chip>
      ))}
    >
      <NavegacionDelBarrio barrioId={barrio.id} rutaGeneral={RUTA_CONFIGURACION_GENERAL} hrefGeneral={todos.href} />
    </BarraLateralDelBarrio>
  );
}

/**
 * **La barra cuando no hay barrio elegido** (encargo 9, PR 1 §4): el inicio, el alta de un barrio y la
 * configuración general sin un barrio al que volver. «Barrios» lleva al mapa de barrios y, separada
 * como en la barra del barrio, «Configuración general · todos los barrios» —solo si quien mira tiene
 * alguna administración a la vista (`listarAdministracionesVisibles`, la misma lectura con la que
 * `/configuracion` decide si hay algo que mostrar).
 *
 * Servidor de punta a punta: la página sabe dónde está y lo dice con `activo`; no hace falta
 * `usePathname()` porque esta barra no vive en un layout que sobreviva a la navegación.
 */
export function BarraDeLaAdministracion({
  nombre,
  activo,
  conConfiguracionGeneral,
}: {
  /** La administración, si quien mira ve una sola; si no, `null`. */
  readonly nombre: string | null;
  readonly activo: "barrios" | "configuracion" | null;
  readonly conConfiguracionGeneral: boolean;
}) {
  return (
    <BarraLateralDeLaAdministracion nombre={nombre ?? "Tus barrios"}>
      <ItemDeSeccion href="/" activo={activo === "barrios"} icono={<IconoTablero />}>
        Barrios
      </ItemDeSeccion>
      {conConfiguracionGeneral ? (
        <>
          <SeparadorDeSecciones />
          <ItemDeSeccion
            href={RUTA_CONFIGURACION_GENERAL}
            activo={activo === "configuracion"}
            icono={<IconoAdministracion />}
            subtitulo="todos los barrios"
          >
            Configuración general
          </ItemDeSeccion>
        </>
      ) : null}
    </BarraLateralDeLaAdministracion>
  );
}
