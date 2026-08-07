/**
 * La pantalla de entrada (pieza 4 del inventario, ADR-0003 §4).
 *
 * **Es la primera pantalla que ve alguien a quien se le está mostrando el sistema**, así que carga
 * con más trabajo del que parece: es la única pantalla del producto que *es* la marca, y al mismo
 * tiempo tiene que dejar claro —sin que nadie lo pregunte— que se está mirando una demostración.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LA FORMA, Y POR QUÉ ES ESTA
 *
 * Dos mitades. A la izquierda **la cara**: un panel de color a sangre con el logotipo y una línea
 * descriptiva, nada más. **No lleva ni un control focusable**, y eso no es una casualidad
 * estética: es lo que hace que el tabulador arranque en la primera persona del elenco y no después
 * de recorrer media pantalla de adorno. A la derecha **la puerta**: una columna angosta con la
 * tarjeta, que es lo único con lo que se interactúa.
 *
 * El panel usa `marca-superficie` y **no** `primary`: el teal primario está calibrado para ser tinta
 * sobre papel (un botón, un ícono) y como fondo de un panel entero no llega a contraste — 3,73:1 con
 * texto blanco encima. Está explicado en `design-tokens/semantic.ts` y verificado en
 * `contraste.test.ts`.
 *
 * **En pantalla angosta el color se retira.** Una banda ancha y baja de teal arriba de todo no se
 * lee como una marca: se lee como un error de layout. Debajo de `lg` el panel pasa a fondo normal;
 * debajo de `sm` pierde también la línea descriptiva, y la tarjeta pierde borde y sombra para que el
 * contenido use el ancho entero.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ NO DECIDE ESTE ARCHIVO
 *
 * Acá no hay nada de sesión ni de autenticación: son cajas. Quién se puede elegir, qué pasa al
 * elegirlo, qué dice la declaración de entorno y por qué en producción esta pantalla no existe lo
 * decide `apps/web`. El kit no sabe siquiera que hay una demostración de por medio — recibe un texto
 * y lo pone donde no se puede cerrar.
 */

import type { ReactNode } from "react";
import { IconoChevron, IconoInfo, Isotipo } from "./iconos.tsx";

/**
 * El ancho de la columna de la derecha y del cuerpo del panel de marca.
 *
 * Es un ancho de **medida de lectura**, no un espaciado: no sale de la escala de `spacing` porque no
 * es un múltiplo de ella, y no existe una escala de anchos de contenedor en `design-tokens`. Vive acá
 * como una constante con nombre para que las dos mitades compartan el mismo número y no se despinten.
 */
const ANCHO_COLUMNA = "max-w-[26rem]";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La hoja
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Las dos mitades. `marca` va primero **en el DOM** además de a la izquierda: es el orden de lectura
 * de un lector de pantalla, y ahí también corresponde presentarse antes de pedir algo.
 */
export function HojaDeIngreso({
  marca,
  children,
}: {
  readonly marca: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div
      data-admin-barrios-ui
      className="flex min-h-dvh flex-col bg-bg text-text-primary lg:flex-row lg:items-stretch"
    >
      {marca}
      <section className="flex flex-1 items-start justify-center px-base pb-xl sm:px-lg sm:pb-2xl lg:items-center lg:py-2xl">
        <div className={`w-full ${ANCHO_COLUMNA}`}>{children}</div>
      </section>
    </div>
  );
}

/**
 * El panel de la izquierda. **Ningún hijo suyo puede ser focusable** — ver el docblock de arriba.
 *
 * `nombre` es el nombre del **producto**, no el de un barrio: en esta pantalla todavía no se sabe con
 * cuál se va a trabajar (ADR-0001 §1).
 */
export function PanelDeMarca({
  nombre,
  descripcion,
}: {
  readonly nombre: ReactNode;
  readonly descripcion: ReactNode;
}) {
  return (
    <section className="flex flex-col justify-center px-base pt-lg pb-sm sm:px-lg sm:pt-xl sm:pb-base lg:basis-[42%] lg:shrink-0 lg:bg-marca-superficie lg:p-2xl lg:text-marca-superficie-fg">
      <div className={`mx-auto w-full ${ANCHO_COLUMNA} lg:mr-2xl lg:ml-auto`}>
        <p className="m-none mb-base flex items-center gap-sm lg:mb-base">
          {/*
            El isotipo toma el teal que SÍ llega a contraste mientras está sobre fondo claro, y pasa
            al color del panel recién cuando el panel existe (`lg`). Sin ese cambio, en angosto queda
            un dibujo blanco sobre un fondo casi blanco.
          */}
          <span className="shrink-0 text-3xl text-marca-aa lg:text-marca-superficie-fg" aria-hidden>
            <Isotipo />
          </span>
          <span className="text-xl font-semibold tracking-tight">{nombre}</span>
        </p>

        {/*
          Una sola línea, y descriptiva. Acá hubo una frase de posicionamiento ("Cada peso, con su
          origen.") con tres puntos que la desarrollaban, y el usuario los sacó con un argumento que
          vale la pena dejar escrito: **no eran marketing ni eran una descripción del producto, eran
          detalles técnicos** — hablaban de coeficientes, de períodos y de la base de datos, o sea en
          el vocabulario de quien lo construyó y no en el de quien lo compra. En la primera pantalla
          eso o se lee como jerga o envejece mal.

          Si alguna vez vuelve una frase de posicionamiento, que venga de quien vende, no de quien
          programa.
        */}
        <p className="m-none hidden text-base text-text-secondary sm:block lg:text-lg lg:text-marca-superficie-fg-tenue">
          {descripcion}
        </p>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La tarjeta
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * La tarjeta de la derecha.
 *
 * `declaracion` es la banda de arriba de todo, y su contrato es el que importa: **no tiene botón de
 * cerrar, no es un tooltip y no está en un pie chiquito**. Va donde sobreviva a una captura de
 * pantalla recortada, porque es lo único que impide que esa captura pase por producción.
 */
export function TarjetaDeIngreso({
  declaracion,
  titulo,
  bajada,
  pie,
  children,
}: {
  readonly declaracion?: ReactNode;
  readonly titulo: ReactNode;
  readonly bajada?: ReactNode;
  readonly pie?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="sm:overflow-hidden sm:rounded-lg sm:border sm:border-border sm:bg-surface sm:shadow-md">
      {declaracion ? (
        <p className="m-none flex items-start gap-sm rounded-md border border-border bg-warning-subtle px-base py-sm text-xs leading-snug text-warning sm:rounded-none sm:border-x-0 sm:border-t-0 sm:px-lg">
          <span className="shrink-0" aria-hidden>
            <IconoInfo />
          </span>
          <span>{declaracion}</span>
        </p>
      ) : null}

      <div className="pt-base pb-base sm:px-lg sm:pt-lg">
        <h1 className="m-none text-2xl font-semibold tracking-tight">{titulo}</h1>
        {bajada ? <p className="m-none mt-xs text-sm text-text-secondary">{bajada}</p> : null}
        <div className="mt-base flex flex-col gap-base">{children}</div>
      </div>

      {pie ? (
        <div className="border-t border-border bg-bg px-base py-sm sm:px-lg">{pie}</div>
      ) : null}
    </div>
  );
}

/**
 * El desplegable del pie: lo técnico existe, pero cerrado.
 *
 * `<details>` nativo — cero JavaScript, `aria-expanded` que da el navegador y teclado que funciona
 * sin programarlo. `text-secondary` y no `text-muted` porque este bloque va sobre `bg` y no sobre una
 * superficie: ahí `text-muted` da 4,28:1 y no llega a AA.
 */
export function DetalleDelEntorno({
  resumen,
  children,
}: {
  readonly resumen: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <details className="text-xs text-text-secondary">
      <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring">
        {resumen}
      </summary>
      <p className="m-none mt-sm font-ab-mono leading-normal break-words">{children}</p>
    </details>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El elenco
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El rótulo del grupo etiqueta la lista de verdad (`aria-labelledby`) y no solo la precede: para
 * quien navega por elementos, "lista de 3 elementos" sin nombre no dice qué se está eligiendo.
 *
 * El `id` es constante porque **hay una sola lista de elenco por pantalla**: la pantalla de entrada
 * es una y no se compone.
 */
const ID_ROTULO = "rotulo-del-elenco";

export function ListaDeElenco({
  rotulo,
  children,
}: {
  readonly rotulo: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-sm">
      <p id={ID_ROTULO} className="m-none text-xs font-semibold tracking-wider text-text-muted uppercase">
        {rotulo}
      </p>
      <ul aria-labelledby={ID_ROTULO} className="m-none flex list-none flex-col gap-sm p-none">
        {children}
      </ul>
    </div>
  );
}

/**
 * Una persona del elenco, como **botón de envío de un formulario compartido**.
 *
 * **`nombreCampo`/`valor` es lo que permite que el formulario sea uno solo.** Antes había un `<form>`
 * por persona con un `<input type="hidden">` adentro. Un botón `submit` aporta su propio par
 * nombre/valor al `FormData`, así que con **un solo** formulario y N botones alcanza.
 *
 * ⚠ Acá decía que eso "arregla un bug real: el doble clic entraba con quien no era". **Era falso** y
 * se corrige en vez de borrarse: un doble clic cae sobre el mismo elemento y manda dos veces el mismo
 * identificador. Lo que se gana es menos DOM, un contrato más chico y un solo punto donde deshabilitar
 * el conjunto cuando la pantalla tenga JavaScript.
 *
 * El botón envuelve **toda** la tarjeta y no una flecha al costado: el objetivo táctil es la fila
 * entera (doc 06 §f.6) y con el teclado hay **una sola parada por persona**.
 *
 * Las iniciales son decorativas (`aria-hidden`): **nunca reemplazan al nombre**, lo acompañan.
 * Deletrear "VR" no le sirve a nadie; lo que distingue a una persona de otra es el nombre, el rol y
 * el alcance, y los tres se anuncian.
 */
export function TarjetaDePersona({
  iniciales,
  nombre,
  rol,
  alcance,
  nombreCampo,
  valor,
}: {
  readonly iniciales: string;
  readonly nombre: ReactNode;
  /** El rol, como etiqueta. `null` cuando el dato no lo trae — nunca se inventa uno. */
  readonly rol?: ReactNode;
  /** Qué ve y qué no. Es lo que hace entender en cinco segundos que el sistema aísla por persona. */
  readonly alcance: ReactNode;
  readonly nombreCampo: string;
  readonly valor: string;
}) {
  return (
    <button
      type="submit"
      name={nombreCampo}
      value={valor}
      className="group flex min-h-control-base w-full cursor-pointer items-center gap-sm rounded-md border border-border bg-surface p-md text-left text-text-primary transition-colors hover:border-primary hover:bg-primary-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      <span
        className="grid h-control-sm w-control-sm shrink-0 place-items-center rounded-pill bg-primary-subtle text-xs font-semibold text-marca-aa"
        aria-hidden
      >
        {iniciales}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-sm">
          <span className="min-w-0 break-words text-base font-semibold leading-snug">{nombre}</span>
          {rol ? <EtiquetaDeRol>{rol}</EtiquetaDeRol> : null}
        </span>
        <span className="min-w-0 break-words text-sm leading-snug text-text-secondary">{alcance}</span>
      </span>
      {/*
        Chevron y no flecha: la flecha del kit tiene asta y pesa igual que el nombre que acompaña. Acá
        el ícono solo dice "esto sigue", así que la versión fina es la correcta.
      */}
      <span className="shrink-0 text-text-muted transition-colors group-hover:text-primary" aria-hidden>
        <IconoChevron className="-rotate-90" />
      </span>
    </button>
  );
}

/**
 * El rol, como etiqueta chica.
 *
 * No es el `Chip` del sistema y no debería serlo: aquel es una **señal de estado** (con su ícono y su
 * tono semántico) y este es una categoría fija que acompaña a un nombre propio. Mismo radio, mismos
 * tokens, otro papel.
 */
function EtiquetaDeRol({ children }: { readonly children: ReactNode }) {
  return (
    <span className="min-w-0 break-words rounded-sm border border-border bg-primary-subtle px-xs text-xs font-semibold tracking-wider text-marca-aa uppercase">
      {children}
    </span>
  );
}
