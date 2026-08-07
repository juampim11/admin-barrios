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
          No se pudo terminar de armar esta pantalla.
        </p>
        {/*
          Antes este párrafo decía "no se modificó ningún dato: todas las pantallas de esta versión
          son de lectura". Dejó de ser cierto con las pantallas de carga y emisión, y una afirmación
          tranquilizadora que puede ser falsa es peor que ninguna: alguien la lee después de un error
          en el medio de una carga y decide no revisar. Lo que sí se puede afirmar es lo de abajo —
          cada escritura corre en una transacción, así que una que falló no dejó nada a medias.
        */}
        <p className={estilos.texto}>
          Si venías de cargar o emitir algo, revisá la pantalla del período antes de repetir la
          operación: no quedan cosas a medias —cada escritura va en una transacción— pero sí puede
          haberse completado la anterior.
        </p>
        <button type="button" className={estilos.boton} onClick={reset}>
          Reintentar
        </button>
        {error.digest ? <p className={estilos.digest}>Identificador del error: {error.digest}</p> : null}
      </div>
    </main>
  );
}
