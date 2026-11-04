/**
 * Las migas: dónde está parado el administrador, arriba del título (`.migas` de las maquetas
 * aprobadas en `coordinacion-admin-barrios/maquetas/`).
 *
 * **Componente de servidor, cero JavaScript.** Los segmentos anteriores son `<a>` (el kit no puede
 * alcanzar `next/link`, cerrojo UI-2; ver `boton.tsx`) y el último es texto con
 * `aria-current="page"`: un enlace a la página en la que ya se está es una promesa vacía.
 *
 * El separador « › » es decorativo (`aria-hidden`): la estructura la da la lista ordenada, que es lo
 * que un lector de pantalla anuncia ("lista, 3 elementos").
 *
 * **No decide el texto.** La pantalla arma los segmentos con el vocabulario del repo: el barrio o la
 * administración primero, la unidad con `etiquetaUnidad()` y el mes con `formatearPeriodo()`.
 */

export type Miga = {
  readonly texto: string;
  /** Sin `href` el segmento es texto. El último se dibuja siempre como texto, tenga o no. */
  readonly href?: string | undefined;
};

const ENLACE = [
  "rounded-sm text-text-muted underline-offset-2 hover:text-marca-aa hover:underline",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
].join(" ");

export function Migas({ migas }: { readonly migas: readonly Miga[] }) {
  if (migas.length === 0) return null;
  const ultima = migas.length - 1;
  return (
    <nav aria-label="Migas" className="mb-xs text-sm text-text-muted">
      <ol className="m-0 flex list-none flex-wrap items-center gap-x-xs p-0">
        {migas.map((miga, i) => (
          <li key={`${i}-${miga.texto}`} className="inline-flex items-center gap-x-xs">
            {i === ultima ? (
              <span aria-current="page">{miga.texto}</span>
            ) : miga.href !== undefined ? (
              <a href={miga.href} className={ENLACE}>
                {miga.texto}
              </a>
            ) : (
              <span>{miga.texto}</span>
            )}
            {i < ultima ? <span aria-hidden="true">›</span> : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
