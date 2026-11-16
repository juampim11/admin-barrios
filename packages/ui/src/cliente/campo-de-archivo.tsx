"use client";

/**
 * El control para **elegir un archivo** (encargo 17b, punto 7c): un botón y, al lado, el nombre del
 * archivo elegido —o «Ningún archivo elegido»—.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE
 *
 * El `<input type="file">` nativo dibuja su propio botón y su propio texto, en el idioma del navegador
 * y no en el del sistema («Seleccionar archivo», «Choose File»), y no se puede maquetar. Acá el
 * `<input>` real **sigue existiendo y es el que el formulario manda**: queda fuera de la vista
 * (`sr-only`), y lo que se ve es un botón del kit con el nombre del archivo.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * ACCESIBILIDAD
 *
 * - **El foco va al `<input>` real**, así que `Tab` llega y `Enter`/`Espacio` abren el diálogo del
 *   sistema, como en el nativo. El contorno de foco se pinta en la caja (`has-[input:focus-visible]`),
 *   con `outline`, como el resto del kit.
 * - El nombre accesible sale del `<label htmlFor>` que pone quien lo usa; `descritoPor` cablea la
 *   ayuda y el error. El botón visible es decorativo (`aria-hidden`): el control es el `<input>`.
 * - La validación nativa (`required`) sigue funcionando: el `<input>` no está `display: none`.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL NOMBRE NO MIENTE
 *
 * El nombre mostrado se lee del `<input>` real y se vuelve a leer cuando el formulario se limpia
 * (evento `reset`, que también dispara React al terminar una acción): si el archivo ya no está
 * elegido, vuelve a decir «Ningún archivo elegido». Cuando el archivo vive en el estado de quien lo
 * usa (una subida en curso, que sobrevive a un reintento), se pasa `archivoElegido` y manda ese.
 */

import { useEffect, useRef, useState } from "react";
import { clasesDeBoton } from "../boton.tsx";

const CAJA = [
  "relative flex min-h-control-base w-full cursor-pointer items-center gap-sm rounded-sm border bg-surface p-xs text-sm text-text-primary",
  "hover:border-primary",
  "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus-ring",
].join(" ");

export function CampoDeArchivo({
  id,
  nombre,
  aceptar,
  requerido,
  deshabilitado,
  invalido,
  descritoPor,
  alElegir,
  archivoElegido,
  textoBoton = "Elegir archivo",
  textoVacio = "Ningún archivo elegido",
}: {
  /** El `id` del `<input>` real: a él apunta el `<label htmlFor>` de quien lo usa. */
  readonly id: string;
  /** El `name` con que el archivo viaja en el formulario. Sin él, el archivo no viaja. */
  readonly nombre?: string | undefined;
  /** El `accept` del `<input type="file">` (`".xlsx,.csv"`, `"application/pdf,image/png"`). */
  readonly aceptar?: string | undefined;
  readonly requerido?: boolean | undefined;
  readonly deshabilitado?: boolean | undefined;
  /** El campo tiene un error: borde de peligro y `aria-invalid`. */
  readonly invalido?: boolean | undefined;
  /** Los `id` de la ayuda y del error (`aria-describedby`). */
  readonly descritoPor?: string | undefined;
  /** Se llama al elegir (o al quitar: `null`). */
  readonly alElegir?: ((archivo: File | null) => void) | undefined;
  /**
   * El nombre del archivo cuando lo guarda quien usa el control. `null` es «ninguno». Sin pasarlo, el
   * control muestra lo que tiene el `<input>`.
   */
  readonly archivoElegido?: string | null | undefined;
  readonly textoBoton?: string;
  readonly textoVacio?: string;
}) {
  const entrada = useRef<HTMLInputElement>(null);
  const [delInput, setDelInput] = useState<string | null>(null);
  const leer = () => setDelInput(entrada.current?.files?.[0]?.name ?? null);

  useEffect(() => {
    // Al montar: por si se eligió un archivo antes de que la isla despertara.
    leer();
    const formulario = entrada.current?.form;
    if (!formulario) return;
    // `reset` se dispara antes de que el `<input>` quede vacío: se lee en la vuelta siguiente.
    let pendiente: ReturnType<typeof setTimeout> | undefined;
    const alLimpiar = () => {
      pendiente = setTimeout(leer, 0);
    };
    formulario.addEventListener("reset", alLimpiar);
    return () => {
      formulario.removeEventListener("reset", alLimpiar);
      if (pendiente !== undefined) clearTimeout(pendiente);
    };
  }, []);

  const mostrado = archivoElegido !== undefined ? archivoElegido : delInput;

  return (
    <div
      data-admin-barrios-ui
      className={[
        CAJA,
        invalido ? "border-danger" : "border-border-strong",
        deshabilitado ? "cursor-not-allowed opacity-60" : "",
      ].join(" ")}
      // La caja entera abre el diálogo, como el nativo. El click que nace en el `<input>` no se
      // reenvía: sería un bucle.
      onClick={(e) => {
        if (deshabilitado || e.target === entrada.current) return;
        entrada.current?.click();
      }}
    >
      <input
        ref={entrada}
        id={id}
        type="file"
        name={nombre}
        accept={aceptar}
        required={requerido}
        disabled={deshabilitado}
        aria-invalid={invalido || undefined}
        aria-describedby={descritoPor}
        className="sr-only"
        onChange={(e) => {
          const archivo = e.currentTarget.files?.[0] ?? null;
          setDelInput(archivo?.name ?? null);
          alElegir?.(archivo);
        }}
      />
      <span aria-hidden className={clasesDeBoton({ variante: "secundario", tamano: "sm", deshabilitado })}>
        {textoBoton}
      </span>
      <span className={`min-w-0 flex-1 truncate ${mostrado === null ? "text-text-secondary" : "text-text-primary"}`} title={mostrado ?? undefined}>
        {mostrado ?? textoVacio}
      </span>
    </div>
  );
}
