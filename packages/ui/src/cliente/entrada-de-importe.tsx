"use client";

/**
 * **El campo de importe. El único de la aplicación** (encargo 17b, punto 3).
 *
 * Lo que hace, tal como lo pidió el titular después de probarlo en pantalla:
 * - al salir muestra el separador de miles y la coma decimal, y completa «,00» si no hay decimales;
 * - el punto del teclado numérico escribe la coma decimal;
 * - «250.000» se lee como doscientos cincuenta mil;
 * - al volver a entrar se edita sin perder ni duplicar los decimales.
 *
 * **Acá no hay ni una regla de formato.** Qué pasa en cada tecla, al salir y al entrar lo deciden
 * las funciones puras de `@admin-barrios/shared/dinero` (`tipearEnImporte`, `reescribirImporte`,
 * `importeAlSalir`, `importeAlEntrar`, `importeInicial`), que están cubiertas por tests. Este
 * archivo solo conecta esas funciones con los eventos del navegador.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * DOS CAMPOS, UNO SOLO A LA VISTA
 *
 * El que se ve **no tiene `name`**: muestra `2.500.000,00` y no viaja a ningún lado. El que viaja es
 * el `hidden`, con el valor canónico `2500000.00` que `montoSchema` espera. Así la comodidad de la
 * pantalla no le cuesta nada al esquema, que sigue exigiendo dos decimales porque es lo que
 * garantiza que el dinero llegue exacto a `numeric(14,2)`. El valor viaja **como texto**, sin pasar
 * por un número de JavaScript ni una sola vez.
 *
 * `type="text"` con `inputMode="decimal"`: teclado numérico en el celular, y el separador lo
 * decidimos nosotros y no la configuración regional del navegador.
 *
 * **Los dos campos son NO controlados, y es deliberado.** React resetea los formularios no
 * controlados cuando la acción termina; con `value` + estado, el campo quedaba con el importe
 * anterior escrito después de guardar — en una pantalla que se usa en ráfaga, un importe viejo
 * esperando a que alguien no lo mire. La máscara escribe en el nodo directamente.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ ES Y QUÉ NO ES
 *
 * Es **el control**: el marco con el signo pesos, el campo que se ve y el que viaja. El rótulo, la
 * ayuda y el error los pone el armazón de formularios de quien lo usa (`CampoMonto`, en
 * `apps/web/src/componentes/formulario.tsx`), que es el mismo de todos los demás campos: por eso
 * recibe `id`, `descritoPor` e `invalido` ya resueltos en vez de dibujarlos.
 */

import { useEffect, useLayoutEffect, useRef, type ChangeEvent } from "react";
import {
  importeAlEntrar,
  importeAlSalir,
  importeInicial,
  normalizarMontoTipeado,
  reescribirImporte,
  tipearEnImporte,
  type ImporteEnEdicion,
} from "@admin-barrios/shared/dinero";

const MARCO =
  "flex items-stretch overflow-hidden rounded-sm bg-surface focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring";

/*
 * El error tiñe el borde **y** engorda el trazo: el grosor es la señal que sobrevive a la escala de
 * grises y al daltonismo. El mensaje, con su ícono, lo dibuja el armazón.
 */
const MARCO_NORMAL = "border border-border-strong hover:border-primary";
const MARCO_CON_ERROR = "border-2 border-danger";

const PREFIJO =
  "grid place-items-center border-r border-border bg-[color-mix(in_srgb,var(--border)_30%,var(--surface))] px-md font-ab-numeric text-sm text-text-secondary";

/*
 * Sin borde ni anillo propios: el foco se dibuja sobre el marco (`focus-within`), porque el campo
 * está pegado al borde y su anillo quedaría recortado por el `overflow-hidden`.
 */
const CONTROL =
  "min-h-control-base w-full min-w-0 border-0 bg-surface px-md py-sm text-right font-ab-numeric text-sm leading-snug tabular-nums text-text-primary outline-none placeholder:text-text-muted disabled:cursor-not-allowed disabled:bg-[color-mix(in_srgb,var(--border)_25%,var(--surface))] disabled:text-text-muted";

export function EntradaDeImporte({
  id,
  nombre,
  valorInicial,
  requerido,
  deshabilitado,
  invalido,
  descritoPor,
  alCambiar,
}: {
  /** El `id` del campo que se ve: es al que apunta el `<label htmlFor>` del armazón. */
  readonly id: string;
  /** El `name` con el que viaja el importe canónico (`2500000.00`). */
  readonly nombre: string;
  /** Canónico (`2500000.00`): lo que devuelve la base o lo que el campo mandó en el intento anterior. */
  readonly valorInicial?: string | undefined;
  readonly requerido?: boolean | undefined;
  /** Un campo deshabilitado no viaja en el formulario: se apagan los dos, el que se ve y el oculto. */
  readonly deshabilitado?: boolean | undefined;
  readonly invalido?: boolean | undefined;
  /** Los `id` de la ayuda y del error, para `aria-describedby`. */
  readonly descritoPor?: string | undefined;
  /**
   * Aviso del importe **canónico** mientras se escribe (`"1234.50"`, o `""` si no hay importe), para
   * cuando otra parte de la pantalla depende del valor.
   *
   * ⚠ Quien escucha guarda **una copia para mirar**, nunca la fuente de verdad: el campo sigue siendo
   * no controlado, y el reseteo del formulario al terminar una acción no pasa por acá.
   */
  readonly alCambiar?: ((canonico: string) => void) | undefined;
}) {
  const visible = useRef<HTMLInputElement>(null);
  const aEnviar = useRef<HTMLInputElement>(null);
  /** ¿La coma que hay en el campo nació de un punto? Ver `comaDePunto` en `shared/dinero`. */
  const comaDePunto = useRef(false);
  const avisar = useRef(alCambiar);
  avisar.current = alCambiar;
  const nombreActual = useRef(nombre);
  nombreActual.current = nombre;

  /*
   * **Lo que viaja es lo que se ve** (encargo 17b, code-reviewer A1). En cada render React vuelve a
   * escribir el `defaultValue` del campo oculto, y en un `hidden` eso ES su valor: con cualquier
   * redibujado de la pantalla (cambiar la fecha, elegir otra opción del formulario) el oculto volvía
   * a su valor inicial mientras el visible seguía mostrando lo tipeado, y se guardaba el importe
   * anterior —o ninguno— sin ningún error. Dos cierres:
   *   · después de cada render, el oculto se vuelve a escribir desde el visible (acá);
   *   · al armar el envío, el valor se toma del visible (el oyente de `formdata`, abajo), que es la
   *     fuente de verdad pase lo que pase con el oculto.
   */
  useLayoutEffect(() => {
    if (visible.current && aEnviar.current) aEnviar.current.value = normalizarMontoTipeado(visible.current.value);
  });

  const inicial = importeInicial(valorInicial ?? "");

  /** Deja en el campo lo que decidió la lógica: el texto, el cursor, la marca y el valor que viaja. */
  const pintar = (estado: ImporteEnEdicion) => {
    const nodo = visible.current;
    if (!nodo) return;
    nodo.value = estado.texto;
    nodo.setSelectionRange(estado.cursor, estado.cursor);
    comaDePunto.current = estado.comaDePunto;
    const canonico = normalizarMontoTipeado(estado.texto);
    if (aEnviar.current) aEnviar.current.value = canonico;
    avisar.current?.(canonico);
  };

  /** Todo lo que el navegador ya escribió en el campo: dígitos, borrados, pegados. */
  const alEscribir = (evento: ChangeEvent<HTMLInputElement>) => {
    const nodo = evento.currentTarget;
    // Un texto pegado o arrastrado trae sus propios separadores: la coma provisoria no le aplica.
    const tipo = (evento.nativeEvent as InputEvent).inputType ?? "";
    const fueUnaTecla = tipo.startsWith("insertText") || tipo.startsWith("insertComposition") || tipo.startsWith("delete");
    pintar(
      reescribirImporte(nodo.value, nodo.selectionStart ?? nodo.value.length, fueUnaTecla && comaDePunto.current),
    );
  };

  /** Al entrar: el mismo importe, sin los ceros que completó la salida. No cambia lo que viaja. */
  const alEntrar = () => {
    const nodo = visible.current;
    if (!nodo) return;
    const antes = nodo.value;
    const texto = importeAlEntrar(antes);
    if (texto === antes) return;
    // Entrando con Tab el navegador selecciona todo; cambiar el valor suelta la selección.
    const estabaTodoSeleccionado = antes !== "" && nodo.selectionStart === 0 && nodo.selectionEnd === antes.length;
    nodo.value = texto;
    if (estabaTodoSeleccionado) nodo.select();
  };

  /** Al salir: miles, coma y los dos decimales. Lo que se ve es, textualmente, lo que se guarda. */
  const alSalir = () => {
    const nodo = visible.current;
    if (!nodo) return;
    nodo.value = importeAlSalir(nodo.value);
    comaDePunto.current = false;
  };

  /**
   * **El punto y la coma se atienden antes de que el navegador los escriba**, porque este es el único
   * lugar que sabe qué tecla se apretó.
   *
   * Va en el `beforeinput` **nativo**, no en el `onBeforeInput` de React (encargo 10, BL-030 a): el
   * de React es una imitación armada sobre `textInput`/`keypress`, que en Firefox no trae `data`. El
   * nativo lo tienen todos los navegadores de hoy y también los teclados virtuales de Android, que en
   * `keydown` no identifican la tecla.
   */
  useEffect(() => {
    const nodo = visible.current;
    if (!nodo) return;
    const alInsertar = (evento: InputEvent) => {
      // Pegar y arrastrar traen su propio texto y van por `alEscribir`.
      if (evento.inputType === "insertFromPaste" || evento.inputType === "insertFromDrop") return;
      if (evento.data !== "." && evento.data !== ",") return;
      evento.preventDefault();
      const inicio = nodo.selectionStart ?? nodo.value.length;
      const fin = nodo.selectionEnd ?? inicio;
      pintar(tipearEnImporte(nodo.value, inicio, fin, evento.data, comaDePunto.current));
    };
    // El formulario se resetea al terminar la acción: el campo vuelve a su valor inicial sin marca.
    const alResetear = () => {
      comaDePunto.current = false;
    };
    // Al armar el envío (`new FormData(form)`, que es lo que hacen el navegador y React): el importe
    // es el del campo que se ve. Un campo deshabilitado no viaja.
    const alArmarElEnvio = (evento: FormDataEvent) => {
      if (nodo.disabled) return;
      evento.formData.set(nombreActual.current, normalizarMontoTipeado(nodo.value));
    };
    const form = nodo.form;
    nodo.addEventListener("beforeinput", alInsertar);
    form?.addEventListener("reset", alResetear);
    form?.addEventListener("formdata", alArmarElEnvio);
    return () => {
      nodo.removeEventListener("beforeinput", alInsertar);
      form?.removeEventListener("reset", alResetear);
      form?.removeEventListener("formdata", alArmarElEnvio);
    };
    // `pintar` solo toca refs: no hay nada que volver a enganchar entre renders.
  }, []);

  return (
    <div className={[MARCO, invalido ? MARCO_CON_ERROR : MARCO_NORMAL].join(" ")}>
      {/* Decorativo: la unidad va en el rótulo, que es lo que un lector de pantalla anuncia. */}
      <span className={PREFIJO} aria-hidden>
        $
      </span>
      <input
        id={id}
        ref={visible}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0,00"
        defaultValue={inicial.visible}
        onChange={alEscribir}
        onFocus={alEntrar}
        onBlur={alSalir}
        required={requerido}
        disabled={deshabilitado}
        aria-invalid={invalido || undefined}
        aria-describedby={descritoPor}
        className={CONTROL}
      />
      {/*
        El que viaja. El visible no tiene `name` justamente para que no llegue nunca al esquema. El
        `defaultValue` de acá es el canónico, así que un reseteo del formulario deja a los dos
        coherentes.
      */}
      <input type="hidden" ref={aEnviar} name={nombre} disabled={deshabilitado} defaultValue={inicial.canonico} />
    </div>
  );
}
