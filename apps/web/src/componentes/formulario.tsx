"use client";

/**
 * El vocabulario de los formularios: campos, botones y los tres avisos que puede devolver una acción.
 *
 * **Por qué este archivo es de cliente y el de lectura (`ui.tsx`) no.** Un formulario con errores por
 * campo necesita el resultado de la acción sin recargar la pantalla, y eso es `useActionState`. Es la
 * única razón: acá no hay estado de negocio, no hay cálculo y no se toca la base. Las pantallas de
 * lectura siguen costando cero JavaScript; el kit viaja solo a las de escritura.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE KIT HACE CUMPLIR, PARA QUE NINGUNA PANTALLA TENGA QUE ACORDARSE
 *
 * **1. El error va en el campo, no en un cartel arriba.** Un `Campo` que recibe `errores` dibuja
 * `aria-invalid`, cuelga el mensaje de `aria-describedby` y lo marca con ícono + texto + borde —
 * nunca solo con color (doc 06 §f.2). Un error que solo se ve en rojo no existe para quien no
 * distingue el rojo, y tampoco para quien está escuchando la pantalla.
 *
 * **2. El foco va al primer campo con error.** `useFocoEnElPrimerError` lo hace después de cada
 * envío fallido. Sin eso, en un formulario de ocho campos el mensaje aparece fuera de la pantalla y
 * la persona ve que "no pasó nada".
 *
 * **3. El identificador de correlación se puede agarrar.** Va en monoespaciada y con
 * `user-select: all`: un click lo selecciona entero. Es lo que se lee por teléfono cuando algo falla,
 * y es lo único que conecta la pantalla con el log del servidor.
 *
 * **4. Un rechazo que pide confirmación no se dibuja como un error.** Otro tono, otro ícono, otro
 * verbo, y una casilla que hay que marcar. Ver `acciones/confirmacion.ts`.
 *
 * **5. Nada de `Intl`, `Number` ni `new Date()`.** El formateo vive en `@admin-barrios/shared`
 * (reglas 5–7 del test de arquitectura). Acá los importes son `<input type="text">` con
 * `inputMode="decimal"`: un `type="number"` deja al navegador decidir el separador decimal según la
 * configuración regional y devuelve `"1,50"` en media Europa, que el esquema rechaza sin que se
 * entienda por qué.
 */

import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CodigoError, ErrorParaMostrar } from "@admin-barrios/shared/errores";
import {
  CAMPOS_DE_CONFIRMACION,
  CAMPO_CODIGO_CONFIRMADO,
  CAMPO_CONFIRMO,
  VALOR_CONFIRMO,
  type Confirmacion,
} from "../acciones/confirmacion.ts";
import {
  INICIAL,
  type ErroresPorCampo,
  type ResultadoDeAccion,
  type ValoresDeFormulario,
} from "../acciones/resultado.ts";
import { IconoAlerta, IconoCorrecto, IconoInfo } from "./iconos.tsx";
import estilos from "./formulario.module.css";

const clases = (...partes: ReadonlyArray<string | false | undefined>): string =>
  partes.filter(Boolean).join(" ");

/** A dónde mandar a la persona según el `codigo`. Lo arma cada pantalla: solo ella sabe sus rutas. */
export type Salida = { readonly texto: string; readonly href: string };
export type Salidas = Partial<Record<CodigoError, Salida>>;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El hook
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Todo lo que un formulario necesita de su acción, resuelto **una vez y bien**.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ES UN HOOK Y NO TRES LÍNEAS COPIADAS EN CADA PANTALLA
 *
 * Eran tres líneas de estrechamiento de tipos repetidas en cada formulario:
 *
 * ```ts
 * const campos = resultado.estado === "campos" ? resultado.campos : {};
 * const previos = resultado.estado === "inicial" || resultado.estado === "ok" ? {} : resultado.valores;
 * const confirmacion = resultado.estado === "confirmar" ? confirmacionDe(resultado.error.codigo) : null;
 * ```
 *
 * Con seis formularios, tres ya se habían olvidado de contemplar algún estado. Un olvido ahí no se ve
 * en una revisión rápida ni lo agarra el compilador —todas las variantes tipan igual de bien— y el
 * síntoma aparece recién en la pantalla, como un campo que se vació o un rechazo que no muestra nada.
 * Acá se resuelve una sola vez, con el `switch` exhaustivo, y ninguna pantalla puede volver a
 * olvidárselo.
 *
 * **El foco también se maneja acá** por el mismo motivo: era una llamada que había que acordarse de
 * agregar, y los tres formularios chicos (quitar un gasto, anular un cargo, generar el borrador) no
 * la tenían.
 *
 * **`confirmacion` sale del resultado, no de una consulta propia.** La resuelve `ejecutar` en el
 * servidor y viaja adentro. Ver el comentario de la variante `confirmar` en `resultado.ts`.
 */
export function useFormulario<T>(
  accion: (previo: ResultadoDeAccion<T>, form: FormData) => Promise<ResultadoDeAccion<T>>,
): {
  readonly enviar: (form: FormData) => void;
  readonly pendiente: boolean;
  readonly resultado: ResultadoDeAccion<T>;
  /** Errores de validación por campo. Vacío si el último envío no fue de validación. */
  readonly campos: ErroresPorCampo;
  /** Lo tipeado en el intento anterior, para repoblar. Vacío al arrancar y después de un éxito. */
  readonly previos: ValoresDeFormulario;
  /** No `null` **solo** cuando el rechazo pide una confirmación explícita. */
  readonly confirmacion: Confirmacion | null;
} {
  const [resultado, enviar, pendiente] = useActionState(accion, INICIAL as ResultadoDeAccion<T>);
  useFocoEnElPrimerError(resultado);

  // `switch` exhaustivo sobre las cinco variantes: agregar una sexta no compila hasta que alguien
  // decida qué le corresponde a cada campo. Es lo contrario del `?:` encadenado que había antes.
  switch (resultado.estado) {
    case "campos":
      return { enviar, pendiente, resultado, campos: resultado.campos, previos: resultado.valores, confirmacion: null };
    case "falla":
      return { enviar, pendiente, resultado, campos: {}, previos: resultado.valores, confirmacion: null };
    case "confirmar":
      return {
        enviar,
        pendiente,
        resultado,
        campos: {},
        previos: resultado.valores,
        confirmacion: resultado.confirmacion,
      };
    case "inicial":
    case "ok":
      return { enviar, pendiente, resultado, campos: {}, previos: {}, confirmacion: null };
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Estructura del formulario
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El `<form>`.
 *
 * `noValidate` es deliberado: **un solo validador**. Con la validación nativa activa, el navegador
 * corta el envío en el primer campo, muestra una burbuja que no podemos estilar ni asociar al campo,
 * y en un idioma que elige él. El `required` se deja igual porque es la semántica que un lector de
 * pantalla anuncia; quien valida es el `parse` de Zod del servidor, que además devuelve **todos** los
 * errores de una vez y con nuestros mensajes.
 */
export function Formulario({
  accion,
  etiqueta,
  children,
}: {
  readonly accion: (formData: FormData) => void;
  readonly etiqueta: string;
  readonly children: ReactNode;
}) {
  return (
    <form action={accion} noValidate aria-label={etiqueta} className={estilos.formulario}>
      {children}
    </form>
  );
}

/**
 * Texto que solo se escucha.
 *
 * Existe por un caso concreto y repetido: veinte botones que dicen "Quitar" son veinte controles
 * indistinguibles para quien navega por la lista de botones de la página. El texto visible se queda
 * corto porque la fila ya dice de qué se trata; el que escucha no tiene la fila.
 */
export function SoloLectores({ children }: { readonly children: ReactNode }) {
  return <span className={estilos.soloLectores}>{children}</span>;
}

/** Los campos, en una rejilla que colapsa a una columna sola en pantallas chicas. */
export function Campos({ children }: { readonly children: ReactNode }) {
  return <div className={estilos.campos}>{children}</div>;
}

/** La fila de botones. El primario va **último** en el DOM: es el orden de lectura y de tabulación. */
export function Acciones({ ayuda, children }: { readonly ayuda?: ReactNode; readonly children: ReactNode }) {
  return (
    <div className={estilos.acciones}>
      {ayuda ? <p className={estilos.ayudaDeAcciones}>{ayuda}</p> : null}
      <div className={estilos.botones}>{children}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Campos
// ────────────────────────────────────────────────────────────────────────────────────────────────

type Comun = {
  readonly nombre: string;
  readonly etiqueta: ReactNode;
  /** Qué significa el campo o qué consecuencia tiene. No repite la etiqueta. */
  readonly ayuda?: ReactNode;
  readonly errores?: readonly string[] | undefined;
  readonly requerido?: boolean;
  readonly valorInicial?: string | undefined;
  readonly deshabilitado?: boolean;
  /** Ocupa las dos columnas de la rejilla. Para descripciones y detalles. */
  readonly ancho?: boolean;
};

/** El armazón común: etiqueta asociada, ayuda y error, los tres cableados con `aria-describedby`. */
function Campo({
  id,
  etiqueta,
  ayuda,
  errores,
  requerido,
  ancho,
  children,
}: Comun & { readonly id: string; readonly children: (ids: string | undefined) => ReactNode }) {
  const idAyuda = ayuda ? `${id}-ayuda` : undefined;
  const idError = errores && errores.length > 0 ? `${id}-error` : undefined;
  const descritoPor = [idAyuda, idError].filter(Boolean).join(" ") || undefined;

  return (
    <div className={clases(estilos.campo, ancho && estilos.campoAncho)}>
      <label htmlFor={id} className={estilos.etiqueta}>
        {etiqueta}
        {requerido ? (
          <span className={estilos.obligatorio}>
            <span aria-hidden>*</span>
            <span className={estilos.soloLectores}> (obligatorio)</span>
          </span>
        ) : (
          <span className={estilos.opcional}>opcional</span>
        )}
      </label>
      {children(descritoPor)}
      {ayuda ? (
        <p id={idAyuda} className={estilos.ayuda}>
          {ayuda}
        </p>
      ) : null}
      {idError ? (
        <p id={idError} className={estilos.error}>
          <span className={estilos.errorIcono} aria-hidden>
            <IconoAlerta />
          </span>
          <span>
            <span className={estilos.soloLectores}>Error: </span>
            {errores?.join(". ")}
          </span>
        </p>
      ) : null}
    </div>
  );
}

type TipoDeTexto = "text" | "date" | "month";

export function CampoTexto({
  tipo = "text",
  maximo,
  ...comun
}: Comun & { readonly tipo?: TipoDeTexto; readonly maximo?: number }) {
  const id = useId();
  const hayError = (comun.errores?.length ?? 0) > 0;
  return (
    <Campo {...comun} id={id}>
      {(descritoPor) => (
        <input
          id={id}
          name={comun.nombre}
          type={tipo}
          defaultValue={comun.valorInicial ?? ""}
          maxLength={maximo}
          required={comun.requerido}
          disabled={comun.deshabilitado}
          aria-invalid={hayError || undefined}
          aria-describedby={descritoPor}
          className={clases(estilos.control, hayError && estilos.controlConError)}
        />
      )}
    </Campo>
  );
}

/**
 * Un importe.
 *
 * `type="text"` con `inputMode="decimal"`: teclado numérico en el celular, punto decimal nuestro y no
 * el que el navegador elija por configuración regional. El `$` es decorativo (`aria-hidden`) y la
 * unidad va en la etiqueta, que es lo que un lector de pantalla anuncia.
 *
 * El valor viaja **como texto** hasta la base, sin pasar por `Number` ni una sola vez: es
 * `numeric(14,2)` del otro lado y el redondeo de punto flotante en una expensa no se perdona.
 */
export function CampoMonto(comun: Comun) {
  const id = useId();
  const hayError = (comun.errores?.length ?? 0) > 0;
  return (
    <Campo {...comun} id={id}>
      {(descritoPor) => (
        <div className={clases(estilos.conPrefijo, hayError && estilos.controlConError)}>
          <span className={estilos.prefijo} aria-hidden>
            $
          </span>
          <input
            id={id}
            name={comun.nombre}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            defaultValue={comun.valorInicial ?? ""}
            required={comun.requerido}
            disabled={comun.deshabilitado}
            aria-invalid={hayError || undefined}
            aria-describedby={descritoPor}
            className={clases(estilos.control, estilos.controlNumerico, estilos.controlSinBorde)}
          />
        </div>
      )}
    </Campo>
  );
}

/** Cantidad con decimales (cuántas reservas, cuántas jornadas). También texto: mismo motivo. */
export function CampoCantidad(comun: Comun) {
  const id = useId();
  const hayError = (comun.errores?.length ?? 0) > 0;
  return (
    <Campo {...comun} id={id}>
      {(descritoPor) => (
        <input
          id={id}
          name={comun.nombre}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={comun.valorInicial ?? ""}
          required={comun.requerido}
          disabled={comun.deshabilitado}
          aria-invalid={hayError || undefined}
          aria-describedby={descritoPor}
          className={clases(estilos.control, estilos.controlNumerico, hayError && estilos.controlConError)}
        />
      )}
    </Campo>
  );
}

export type Opcion = {
  readonly valor: string;
  readonly texto: string;
  /** Segunda línea del `<optgroup>`: agrupa sin obligar a leer el nombre completo de cada opción. */
  readonly grupo?: string;
  readonly deshabilitada?: boolean;
};

/**
 * Un desplegable.
 *
 * `sinSeleccion` no tiene default y es a propósito: la primera opción de un `<select>` queda elegida
 * sola, así que un desplegable sin ese renglón vacío **decide por la persona**. En un formulario que
 * termina en dinero, "la primera de la lista" no es una elección.
 */
/**
 * Un desplegable que **repone su valor solo** después de cada acción.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL BUG QUE ESTO EXISTE PARA EVITAR, Y POR QUÉ NO SE ARREGLA DESDE AFUERA
 *
 * React 19 hace `form.reset()` cuando una acción termina. Al reponer, el navegador vuelve a lo que
 * cada control declaró como default — y ahí `<select>` se porta distinto de `<input>`: React aplica
 * el `defaultValue` de un `<select>` marcando `defaultSelected` en sus `<option>` **solo al montar**,
 * y en un update posterior no lo vuelve a tocar. O sea que un `defaultValue` nuevo (el que devolvió
 * la acción) no llega al DOM, y el reset devuelve el desplegable **al placeholder** mientras los
 * campos de texto de al lado vuelven con lo tipeado.
 *
 * El síntoma en la pantalla de cargos era una contradicción sobre qué se va a cobrar: el panel del
 * catálogo mostrando "Alquiler de quincho" —que sale del estado— y el desplegable en «Elegí el
 * concepto…» al mismo tiempo.
 *
 * **Se arregla acá adentro y no con un `key` que pase cada llamador**, porque una regla que hay que
 * acordarse de aplicar en cada uso es una regla que se va a olvidar: de hecho, los cuatro llamadores
 * que había se la habían olvidado. El componente escucha el `reset` de su propio `<form>` y se
 * remonta: al volver a montar, el `defaultValue` —que para entonces ya es el que devolvió la acción—
 * se aplica de nuevo. El `id` de `useId()` es estable entre remontes, así que el oyente se registra
 * una sola vez sobre el `<form>`, que no se remonta nunca.
 */
export function CampoSeleccion({
  opciones,
  sinSeleccion,
  alCambiar,
  ...comun
}: Comun & {
  readonly opciones: readonly Opcion[];
  readonly sinSeleccion: string;
  /**
   * Aviso de que cambió lo elegido, para cuando **otra parte del formulario depende de eso** — el
   * campo `cantidad`, que se dibuja o no según el método del concepto.
   *
   * ⚠ **El desplegable sigue siendo NO CONTROLADO aunque haya `alCambiar`, y eso no es pereza.**
   * React 19 hace `form.reset()` sobre el `<form>` cuando una acción termina. A un campo no
   * controlado eso lo devuelve a su `defaultValue`, que es justo lo que queremos; a uno **controlado**
   * le borra el valor del DOM y, como el estado de React no cambió, no hay re-render que lo vuelva a
   * poner. El síntoma medido el 2026-07-28: después de un reintento fallido, la pantalla mostraba el
   * panel del concepto elegido —que sale del estado— **y el desplegable en «Elegí el concepto…»** al
   * mismo tiempo. Un formulario que se contradice consigo mismo sobre qué se va a cobrar.
   *
   * Quien necesite que el valor sobreviva a un reintento le pasa un `key` distinto por intento: al
   * remontar, el `defaultValue` se vuelve a aplicar.
   */
  readonly alCambiar?: (valor: string) => void;
}) {
  const id = useId();
  const hayError = (comun.errores?.length ?? 0) > 0;
  const grupos = [...new Set(opciones.map((o) => o.grupo ?? ""))];

  /*
   * Cada `reset` del formulario incrementa la generación, y la generación es el `key` del `<select>`:
   * eso lo remonta con el `defaultValue` vigente. El oyente va sobre el `<form>` —que no se remonta—
   * y se encuentra por el `id`, que `useId()` mantiene estable a través de los remontes.
   */
  const [generacion, setGeneracion] = useState(0);
  useEffect(() => {
    const form = (document.getElementById(id) as HTMLSelectElement | null)?.form;
    if (!form) return;
    const alResetear = () => setGeneracion((n) => n + 1);
    form.addEventListener("reset", alResetear);
    return () => form.removeEventListener("reset", alResetear);
  }, [id]);

  return (
    <Campo {...comun} id={id}>
      {(descritoPor) => (
        <select
          key={generacion}
          id={id}
          name={comun.nombre}
          defaultValue={comun.valorInicial ?? ""}
          onChange={alCambiar ? (e) => alCambiar(e.target.value) : undefined}
          required={comun.requerido}
          disabled={comun.deshabilitado}
          aria-invalid={hayError || undefined}
          aria-describedby={descritoPor}
          className={clases(estilos.control, hayError && estilos.controlConError)}
        >
          <option value="">{sinSeleccion}</option>
          {grupos.map((grupo) => {
            const suyas = opciones.filter((o) => (o.grupo ?? "") === grupo);
            const renglones = suyas.map((o) => (
              <option key={o.valor} value={o.valor} disabled={o.deshabilitada}>
                {o.texto}
              </option>
            ));
            return grupo === "" ? (
              renglones
            ) : (
              <optgroup key={grupo} label={grupo}>
                {renglones}
              </optgroup>
            );
          })}
        </select>
      )}
    </Campo>
  );
}

export function CampoParrafo({ maximo, filas = 3, ...comun }: Comun & { readonly maximo?: number; readonly filas?: number }) {
  const id = useId();
  const hayError = (comun.errores?.length ?? 0) > 0;
  return (
    <Campo {...comun} id={id}>
      {(descritoPor) => (
        <textarea
          id={id}
          name={comun.nombre}
          rows={filas}
          maxLength={maximo}
          defaultValue={comun.valorInicial ?? ""}
          required={comun.requerido}
          disabled={comun.deshabilitado}
          aria-invalid={hayError || undefined}
          aria-describedby={descritoPor}
          className={clases(estilos.control, hayError && estilos.controlConError)}
        />
      )}
    </Campo>
  );
}

/**
 * Una casilla de acuse.
 *
 * El objetivo táctil es **la etiqueta entera** y no el cuadradito de 16 px (doc 06 §f.6): con el
 * pulgar, parado en la guardia, un cuadradito no se toca.
 */
export function Casilla({
  nombre,
  valor,
  children,
  errores,
}: {
  readonly nombre: string;
  readonly valor: string;
  readonly children: ReactNode;
  readonly errores?: readonly string[] | undefined;
}) {
  const id = useId();
  const hayError = (errores?.length ?? 0) > 0;
  const idError = hayError ? `${id}-error` : undefined;
  return (
    <div>
      <label htmlFor={id} className={clases(estilos.casilla, hayError && estilos.casillaConError)}>
        <input
          id={id}
          type="checkbox"
          name={nombre}
          value={valor}
          aria-invalid={hayError || undefined}
          aria-describedby={idError}
          className={estilos.casillaControl}
        />
        <span>{children}</span>
      </label>
      {idError ? (
        <p id={idError} className={estilos.error}>
          <span className={estilos.errorIcono} aria-hidden>
            <IconoAlerta />
          </span>
          <span>{errores?.join(". ")}</span>
        </p>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Botones
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type TonoDeBoton = "primario" | "secundario" | "peligro";

const CLASE_BOTON: Record<TonoDeBoton, string> = {
  primario: estilos.botonPrimario ?? "",
  secundario: estilos.botonSecundario ?? "",
  peligro: estilos.botonPeligro ?? "",
};

/**
 * El botón que envía.
 *
 * Mientras la acción corre queda **deshabilitado, con `aria-busy` y con el verbo en gerundio**. Las
 * tres señales juntas: el disabled evita el doble envío —que en una emisión sería un segundo intento
 * sobre un período que ya cambió de estado—, el `aria-busy` lo anuncia, y el texto lo dice sin
 * depender de ver un spinner.
 */
export function BotonEnviar({
  tono = "primario",
  pendiente,
  cargando,
  children,
}: {
  readonly tono?: TonoDeBoton;
  readonly pendiente: boolean;
  readonly cargando: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={pendiente}
      aria-busy={pendiente}
      className={clases(estilos.boton, CLASE_BOTON[tono])}
    >
      {pendiente ? (
        <>
          <span className={estilos.girando} aria-hidden />
          {cargando}
        </>
      ) : (
        children
      )}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Los tres avisos
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * La región donde aparecen los avisos de una acción.
 *
 * `aria-live="polite"` y no `assertive`: la persona acaba de apretar un botón, así que está esperando
 * la respuesta; interrumpirla en la mitad de otra lectura no aporta nada. El contenedor existe
 * **siempre**, aunque esté vacío, porque un `aria-live` que aparece junto con su contenido no lo
 * anuncia — el navegador tiene que haber visto la región antes de que cambie.
 */
export function Avisos({ children }: { readonly children?: ReactNode }) {
  return (
    <div className={estilos.avisos} aria-live="polite">
      {children}
    </div>
  );
}

/** Un fallo del servicio: `mensaje` y `sugerencia` tal cual vinieron, y el código para copiar. */
export function AvisoDeFallo({
  error,
  salidas,
}: {
  readonly error: ErrorParaMostrar;
  readonly salidas?: Salidas;
}) {
  const salida = salidas?.[error.codigo];
  return (
    // `tabIndex={-1}` para poder recibir el foco por programa sin entrar en el orden de tabulación:
    // es un destino, no una parada. Ver `useFocoEnElPrimerError`.
    <div className={clases(estilos.aviso, estilos.avisoPeligro)} data-foco-resultado tabIndex={-1}>
      <span className={estilos.avisoIcono} aria-hidden>
        <IconoAlerta />
      </span>
      <div className={estilos.avisoCuerpo}>
        <p className={estilos.avisoTitulo}>{error.mensaje}</p>
        <p>{error.sugerencia}</p>
        {salida ? (
          <p>
            <a className={estilos.avisoEnlace} href={salida.href}>
              {salida.texto} →
            </a>
          </p>
        ) : null}
        {error.correlacion ? <Correlacion valor={error.correlacion} /> : null}
      </div>
    </div>
  );
}

/**
 * El mismo fallo, para donde no hay ancho: la celda de una tabla, al lado del botón que lo produjo.
 *
 * **No recorta información** —mensaje, sugerencia y código de correlación siguen los tres— sino el
 * marco: sin ícono grande, sin borde grueso, en tipografía chica. Un error de fila que mande a leer
 * un cartel arriba de todo obliga a reconstruir de qué fila se estaba hablando.
 */
export function AvisoDeFalloCompacto({
  error,
  salidas,
}: {
  readonly error: ErrorParaMostrar;
  readonly salidas?: Salidas;
}) {
  const salida = salidas?.[error.codigo];
  return (
    <div className={estilos.falloCompacto}>
      <p className={estilos.falloCompactoTitulo}>
        <span className={estilos.errorIcono} aria-hidden>
          <IconoAlerta />
        </span>
        <span>{error.mensaje}</span>
      </p>
      <p>{error.sugerencia}</p>
      {salida ? (
        <p>
          <a className={estilos.avisoEnlace} href={salida.href}>
            {salida.texto} →
          </a>
        </p>
      ) : null}
      {error.correlacion ? <Correlacion valor={error.correlacion} /> : null}
    </div>
  );
}

/**
 * Los mensajes que Zod no pudo atribuir a ningún campo — los `superRefine` sin `path`, que se
 * guardan bajo la clave `""`.
 *
 * Van arriba y no en un campo porque el problema **es la combinación**: "el segundo vencimiento no
 * puede ser anterior al primero" no es de ninguno de los dos campos, es de los dos juntos. No lleva
 * identificador de correlación porque no hay nada que buscar en ningún log: el error es lo que está
 * escrito en el formulario.
 */
export function AvisoDeCamposSueltos({ mensajes }: { readonly mensajes: readonly string[] }) {
  return (
    <div className={clases(estilos.aviso, estilos.avisoPeligro)}>
      <span className={estilos.avisoIcono} aria-hidden>
        <IconoAlerta />
      </span>
      <div className={estilos.avisoCuerpo}>
        <p className={estilos.avisoTitulo}>Revisá los datos cargados.</p>
        <p>{mensajes.join(". ")}</p>
      </div>
    </div>
  );
}

/**
 * El identificador de correlación.
 *
 * `user-select: all` para que un solo click lo seleccione entero, monoespaciada para que no se
 * confunda un `1` con una `l`, y con la palabra "código" adelante para que se entienda qué es lo que
 * hay que dictar. Es lo único que conecta esta pantalla con el error completo, que quedó en el log
 * del servidor y **no** en el navegador.
 */
function Correlacion({ valor }: { readonly valor: string }) {
  return (
    <p className={estilos.correlacion}>
      Código para soporte: <code className={estilos.codigo}>{valor}</code>
    </p>
  );
}

/**
 * El pedido de confirmación. **No es un error y no se dibuja como uno.**
 *
 * Tono de advertencia y no de peligro, ícono de información, y el verbo del botón en positivo. Lo que
 * lo separa de un aviso decorativo es la casilla: sin marcarla, el formulario se vuelve a enviar sin
 * la confirmación y el servicio vuelve a rechazar. La casilla no es ceremonia, es el mecanismo.
 *
 * Los campos ocultos son los valores del intento anterior, **intactos**: lo que se confirma es
 * exactamente lo que se había pedido, no una versión reconstruida por la pantalla.
 */
export function PedidoDeConfirmacion({
  error,
  confirmacion,
  valores,
  pendiente,
  children,
}: {
  readonly error: ErrorParaMostrar;
  readonly confirmacion: Confirmacion;
  readonly valores: ValoresDeFormulario;
  readonly pendiente: boolean;
  /** El resumen de lo que se está confirmando, armado por la pantalla que conoce sus campos. */
  readonly children?: ReactNode;
}) {
  return (
    <div className={clases(estilos.aviso, estilos.avisoAlerta)} data-foco-resultado tabIndex={-1}>
      <span className={estilos.avisoIcono} aria-hidden>
        <IconoInfo />
      </span>
      <div className={estilos.avisoCuerpo}>
        <p className={estilos.avisoTitulo}>{confirmacion.titulo}</p>
        <p>{error.mensaje}</p>
        <p>{error.sugerencia}</p>
        {children}
        <p className={estilos.queSeConfirma}>{confirmacion.queSeConfirma}</p>

        {/*
          Lo del intento anterior, intacto — **menos todo lo que sea una confirmación**.
          `ejecutar` ya devuelve los valores crudos, así que en condiciones normales acá no hay nada
          que filtrar; este `filter` es el cinturón encima del tirante. Si el campo de una
          confirmación llegara a colarse como `<input type="hidden">`, la casilla dejaría de hacer
          falta y el candado quedaría convertido en un cartel: alcanzaría con volver a apretar el
          botón. La lista sale de la misma tabla que define las confirmaciones, así que no se puede
          desincronizar.
        */}
        {Object.entries(valores)
          .filter(([clave]) => !CAMPOS_DE_CONFIRMACION.has(clave))
          .map(([clave, valor]) => (
            <input key={clave} type="hidden" name={clave} value={valor} />
          ))}
        <input type="hidden" name={CAMPO_CODIGO_CONFIRMADO} value={error.codigo} />

        <Casilla nombre={CAMPO_CONFIRMO} valor={VALOR_CONFIRMO}>
          {confirmacion.leyendaDeLaCasilla}
        </Casilla>

        <div className={estilos.botones}>
          <BotonEnviar tono="primario" pendiente={pendiente} cargando="Confirmando…">
            {confirmacion.textoDelBoton}
          </BotonEnviar>
        </div>
        {error.correlacion ? <Correlacion valor={error.correlacion} /> : null}
      </div>
    </div>
  );
}

/** Salió bien. Con lo que el servicio devolvió, no con lo que la pantalla creía estar mandando. */
export function AvisoDeExito({ titulo, children }: { readonly titulo: ReactNode; readonly children?: ReactNode }) {
  return (
    <div className={clases(estilos.aviso, estilos.avisoExito)}>
      <span className={estilos.avisoIcono} aria-hidden>
        <IconoCorrecto />
      </span>
      <div className={estilos.avisoCuerpo}>
        <p className={estilos.avisoTitulo}>{titulo}</p>
        {children}
      </div>
    </div>
  );
}

/** Algo que hay que avisar sin bloquear: se escribió, y quedó marcado. */
export function AvisoDeMarca({ titulo, children }: { readonly titulo: ReactNode; readonly children?: ReactNode }) {
  return (
    <div className={clases(estilos.aviso, estilos.avisoAlerta)}>
      <span className={estilos.avisoIcono} aria-hidden>
        <IconoAlerta />
      </span>
      <div className={estilos.avisoCuerpo}>
        <p className={estilos.avisoTitulo}>{titulo}</p>
        {children}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Foco
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Manda el foco al primer campo con error después de cada envío fallido.
 *
 * Es la mitad del trabajo de accesibilidad de un formulario largo: sin esto, el envío deja el foco en
 * el botón, el primer error puede estar tres pantallazos más arriba, y lo que la persona percibe es
 * que el botón no hizo nada.
 *
 * `useRef` sobre el propio resultado y no sobre un contador: `useActionState` devuelve un objeto
 * nuevo por envío, así que la identidad referencial alcanza para distinguir "hubo un envío nuevo" de
 * "se volvió a renderizar por otra cosa". Un contador haría falta solo si el mismo objeto se pudiera
 * repetir, y no puede.
 */
export function useFocoEnElPrimerError(resultado: ResultadoDeAccion<unknown>): void {
  const anterior = useRef<unknown>(null);

  useEffect(() => {
    if (anterior.current === resultado) return;
    anterior.current = resultado;

    /*
     * Dos destinos según qué pasó:
     *
     * · `campos` → el primer control inválido **en orden del documento**, que es el mismo orden en
     *   que la persona los recorrió;
     * · `falla` y `confirmar` → el aviso. En el segundo caso es imprescindible: el pedido de
     *   confirmación **reemplaza** al formulario entero, así que el botón que se acaba de apretar
     *   deja de existir y el foco se cae al `<body>`. Sin esto, quien navega con teclado tiene que
     *   recorrer la página de nuevo para encontrar la casilla que le están pidiendo marcar.
     *
     * En `ok` no se toca: el `aria-live` ya anunció el acuse, y robar el foco sacaría a la persona
     * del formulario justo cuando lo más probable es que quiera cargar otro.
     */
    const destino =
      resultado.estado === "campos"
        ? document.querySelector<HTMLElement>('[aria-invalid="true"]')
        : resultado.estado === "falla" || resultado.estado === "confirmar"
          ? document.querySelector<HTMLElement>("[data-foco-resultado]")
          : null;

    // Sin `behavior: "smooth"`: quien pidió que no se mueva nada (`prefers-reduced-motion`) tampoco
    // quiere que la pantalla se deslice sola, y acá el desplazamiento no aporta información.
    destino?.focus();
    destino?.scrollIntoView({ block: "center" });
  }, [resultado]);
}
