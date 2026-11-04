/**
 * La barra lateral del barrio (pieza 2 del inventario, doc 06 §c.2).
 *
 * **Un solo chrome, con el foco corrido** (§c.6.1): la barra es la misma en todas las pantallas y lo
 * único que cambia es qué ítem está marcado. Arriba va el selector de barrio —la pregunta "¿en qué
 * barrio estoy trabajando?" es el eje de toda la navegación (§c.1)— y debajo las secciones.
 *
 * **El acento del tenant vive acá** (§c.5.1): una franja de color determinístico derivado del id del
 * barrio, en el borde de la barra y en un tinte leve de su cabecera. Nunca en botones, acciones ni
 * estados, y nunca reemplaza a la marca. Es lo que hace que dos barrios se distingan de reojo sin
 * competir con la semántica del color.
 *
 * **Solo se listan las secciones que existen.** Un menú con ocho módulos que todavía no se
 * construyeron es una promesa que la aplicación no puede cumplir, y la regla §c.6.4 —no mostrar lo
 * que no se puede ejecutar— vale igual para la navegación que para los botones. Agregar una sección
 * el día que exista es una línea en el arreglo de la pantalla.
 */

import type { CSSProperties, ReactNode } from "react";
import { acentoBarrio } from "@admin-barrios/design-tokens/barrio-accent";

/**
 * El armazón de dos columnas: barra a la izquierda, contenido a la derecha.
 *
 * **Se apila en pantalla angosta y recién en `lg` pasa a dos columnas.** El administrador también
 * mira desde el celular (doc 06 §e.7), y ahí una barra lateral fija se come la mitad del ancho útil;
 * apilada arriba sigue estando a la vista, que es lo que pide §c.5.2.
 */
export function CuerpoConBarraLateral({
  barraLateral,
  children,
}: {
  readonly barraLateral: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div data-admin-barrios-ui className="grid flex-1 grid-cols-1 items-start lg:grid-cols-[17rem_minmax(0,1fr)]">
      {barraLateral}
      {children}
    </div>
  );
}

/**
 * La barra en sí.
 *
 * `sticky` desde `lg`: en escritorio acompaña el scroll de una grilla de 500 liquidaciones, que es
 * justo cuando más se necesita saber dónde se está. Apilada no tendría sentido pegarla.
 */
export function BarraLateralDelBarrio({
  barrioId,
  nombre,
  selector,
  figura,
  roles,
  children,
}: {
  readonly barrioId: string;
  readonly nombre: string;
  /** La isla del selector, o `null` si el usuario tiene un solo barrio (§c.6.2). */
  readonly selector: ReactNode;
  readonly figura: ReactNode;
  readonly roles: readonly ReactNode[];
  /** Los ítems de navegación. Entran como hijos porque quién está activo lo sabe la pantalla. */
  readonly children: ReactNode;
}) {
  const style = {
    "--acento-claro": acentoBarrio(barrioId, "light"),
    "--acento-oscuro": acentoBarrio(barrioId, "dark"),
  } as CSSProperties;

  return (
    <aside
      data-admin-barrios-ui
      style={style}
      aria-label="Barrio y secciones"
      className="border-b border-border bg-surface [--acento:var(--acento-claro)] lg:sticky lg:top-none lg:h-dvh lg:border-b-0 lg:border-r dark:[--acento:var(--acento-oscuro)]"
    >
      <div className="flex flex-col gap-base p-base [box-shadow:inset_0_3px_0_0_var(--acento)] lg:[box-shadow:inset_3px_0_0_0_var(--acento)]">
        <div className="flex flex-col gap-sm bg-[linear-gradient(to_bottom,color-mix(in_srgb,var(--acento)_10%,var(--surface)),transparent)] pb-sm">
          {selector ?? (
            <h2 className="flex items-center gap-sm text-lg font-semibold">
              <PuntoDelBarrio />
              {nombre}
            </h2>
          )}
          <div className="flex flex-wrap items-center gap-xs">
            {figura}
            {roles}
          </div>
        </div>
        <nav aria-label="Secciones del barrio">
          <ul className="flex flex-col gap-xs">{children}</ul>
        </nav>
      </div>
    </aside>
  );
}

/**
 * La barra **cuando no hay barrio elegido**: el inicio (el mapa de barrios), el alta de un barrio y la
 * configuración general sin un barrio al que volver (encargo 9, PR 1 §4). Es el mismo chrome que la
 * del barrio —mismo lugar, mismos ítems—, pero sin acento: el acento es la identidad de UN barrio, y
 * acá no hay ninguno. Arriba dice de quién es la pantalla (la administración).
 */
export function BarraLateralDeLaAdministracion({
  nombre,
  children,
}: {
  /** La administración, o un rótulo genérico si quien mira ve más de una. */
  readonly nombre: string;
  /** Los ítems. Quién está activo lo decide la pantalla. */
  readonly children: ReactNode;
}) {
  return (
    <aside
      data-admin-barrios-ui
      aria-label="Administración y secciones"
      className="border-b border-border bg-surface lg:sticky lg:top-none lg:h-dvh lg:border-b-0 lg:border-r"
    >
      <div className="flex flex-col gap-base p-base">
        <h2 className="text-lg font-semibold">{nombre}</h2>
        <nav aria-label="Secciones de la administración">
          <ul className="flex flex-col gap-xs">{children}</ul>
        </nav>
      </div>
    </aside>
  );
}

/**
 * Un ítem de la barra.
 *
 * **Tres señales para el activo, nunca solo el color** (doc 06 §f.2): fondo, barra vertical a la
 * izquierda y `aria-current="page"`, que es lo que lo anuncia a un lector de pantalla. Quién está
 * activo llega como prop y no se calcula acá: el kit no sabe de rutas.
 */
export function ItemDeSeccion({
  href,
  activo,
  icono,
  subtitulo,
  children,
}: {
  readonly href: string;
  readonly activo: boolean;
  readonly icono?: ReactNode;
  /**
   * Un renglón chico debajo del nombre, para cuando el alcance del ítem no es el del barrio — hoy,
   * «Configuración general · todos los barrios». Es texto y no un ícono porque lo que distingue a
   * los dos ítems de configuración es **a quién alcanzan**, y eso se lee, no se adivina.
   */
  readonly subtitulo?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <li>
      <a
        href={href}
        aria-current={activo ? "page" : undefined}
        className={[
          "flex min-h-control-base items-center gap-sm rounded-sm border-l-2 px-sm py-xs text-sm no-underline",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
          activo
            ? "border-primary bg-primary-subtle font-semibold text-text-primary"
            : "border-transparent text-text-secondary hover:bg-primary-subtle hover:text-text-primary",
        ].join(" ")}
      >
        {icono ? (
          <span className="shrink-0 text-[1.15em] text-marca-aa" aria-hidden>
            {icono}
          </span>
        ) : null}
        {subtitulo ? (
          <span className="flex flex-col leading-tight">
            <span>{children}</span>
            <span className="text-xs font-regular text-text-muted">{subtitulo}</span>
          </span>
        ) : (
          children
        )}
      </a>
    </li>
  );
}

/**
 * Una línea entre grupos de ítems que **no alcanzan a lo mismo**. Hoy separa lo del barrio de lo que
 * vale para todos los barrios de la administración: sin la línea, «Configuración del barrio» y
 * «Configuración general» se leen como dos pantallas hermanas del mismo barrio, y no lo son.
 * Decorativa para el lector de pantalla (`role="presentation"`): el alcance lo dice el subtítulo.
 */
export function SeparadorDeSecciones() {
  return <li role="presentation" className="my-xs border-t border-border" />;
}

/** El punto de color del barrio (§c.5.1). Decorativo: el nombre está al lado, escrito. */
export function PuntoDelBarrio() {
  return <span className="h-[0.7rem] w-[0.7rem] shrink-0 rounded-pill bg-[var(--acento)]" aria-hidden />;
}
