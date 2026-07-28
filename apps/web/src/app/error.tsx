"use client";

/**
 * El estado de **error** de toda la app.
 *
 * Next lo exige de cliente: necesita un `onClick` para reintentar. Es la única razón por la que
 * lleva la directiva; no toca datos ni sabe nada del dominio.
 *
 * **Qué se muestra y qué no.** El mensaje que ve el usuario es fijo; lo que puede identificar el
 * problema es el `digest`, que Next genera en el servidor y que apunta al log donde está el error
 * completo. No se imprime `error.message`: los `raise exception` de este esquema interpolan valores
 * de filas —"el concepto «%» no tiene valor vigente al %"— y un `unique_violation` trae en el
 * `detail` el valor en conflicto, que puede pertenecer a una fila que este usuario **no puede leer**
 * bajo RLS. La RLS filtra el `select`; no filtra el mensaje de error (ADR-0002 §4.2).
 */

import { useEffect } from "react";
import estilos from "./error.module.css";

export default function Error({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    console.error("[web] error no controlado:", error);
  }, [error]);

  return (
    <main className={estilos.marco} id="contenido">
      <div className={estilos.caja}>
        <h1 className={estilos.titulo}>Algo salió mal</h1>
        <p className={estilos.texto}>
          No se pudo terminar de armar esta pantalla. No se modificó ningún dato: todas las pantallas
          de esta versión son de lectura.
        </p>
        <button type="button" className={estilos.boton} onClick={reset}>
          Reintentar
        </button>
        {error.digest ? <p className={estilos.digest}>Identificador del error: {error.digest}</p> : null}
      </div>
    </main>
  );
}
