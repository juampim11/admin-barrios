import { prorratear, sumarMontos } from "@admin-barrios/shared/dinero";
import estilos from "./page.module.css";

/**
 * Página de verificación de la Fase 6C: la fundación está cableada de punta a punta —
 * tokens de diseño → CSS vars → UI, y dominio puro (`@admin-barrios/shared`) → render.
 * La UI real del administrador se construye sobre esto (docs/diseno/06-direccion-visual.md).
 */

const UNIDADES = [
  { id: "MZ-3-L-12", coeficiente: "0.021500", estado: "alDia" },
  { id: "MZ-3-L-13", coeficiente: "0.018300", estado: "porVencer" },
  { id: "MZ-4-L-02", coeficiente: "0.033700", estado: "vencido" },
  { id: "MZ-4-L-07", coeficiente: "0.026500", estado: "moroso" },
] as const;

const ETIQUETA_ESTADO: Record<(typeof UNIDADES)[number]["estado"], string> = {
  alDia: "Al día",
  porVencer: "Por vencer",
  vencido: "Vencido",
  moroso: "Moroso",
};

const TOTAL_PERIODO = "1250000.00";

export default function Home() {
  const partes = prorratear(
    TOTAL_PERIODO,
    UNIDADES.map((u) => [u.id, u.coeficiente] as const),
  );
  const suma = sumarMontos(...partes.map(([, monto]) => monto));

  return (
    <main className={estilos.pagina}>
      <header>
        <div className={estilos.marca}>
          <strong>admin-barrios</strong>
          <span className={estilos.subtitulo}>administración de barrios privados, consorcios y PH</span>
        </div>
      </header>

      <section className={estilos.tarjeta}>
        <h2>Prorrateo de ejemplo — período 2026-07</h2>
        <p className={estilos.subtitulo}>
          Total a repartir <span className="dinero">$ {TOTAL_PERIODO}</span> por coeficiente. Cada cifra
          sale de su origen (barrio, unidad, coeficiente, período): nunca un número suelto.
        </p>
        <table className={estilos.tabla}>
          <thead>
            <tr>
              <th scope="col">Unidad funcional</th>
              <th scope="col">Estado</th>
              <th scope="col">Coeficiente</th>
              <th scope="col">Expensa</th>
            </tr>
          </thead>
          <tbody>
            {UNIDADES.map((unidad, i) => (
              <tr key={unidad.id}>
                <td>{unidad.id}</td>
                <td>
                  <span
                    className={estilos.chip}
                    style={{
                      color: `var(--morosidad-${kebab(unidad.estado)}-fg)`,
                      background: `var(--morosidad-${kebab(unidad.estado)}-bg)`,
                    }}
                  >
                    {ETIQUETA_ESTADO[unidad.estado]}
                  </span>
                </td>
                <td className="dinero">{unidad.coeficiente}</td>
                <td className="dinero">$ {partes[i]?.[1] ?? "—"}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3}>
                <strong>Suma de las partes</strong>
              </td>
              <td className="dinero">
                <strong>$ {suma}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className={estilos.tarjeta}>
        <h2>Fundación (Fase 6C)</h2>
        <ul className={estilos.lista}>
          <li>Monorepo pnpm: {"apps/web + packages/{shared, data, design-tokens}"}.</li>
          <li>Aislamiento entre barrios por RLS de Postgres, probado contra la base real.</li>
          <li>Tokens de diseño "Verdemar" con modo oscuro desde el día uno.</li>
        </ul>
      </section>

      <footer className={estilos.pie}>
        Los colores de estado siempre van con texto, nunca solos (WCAG AA).
      </footer>
    </main>
  );
}

function kebab(clave: string): string {
  return clave.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
