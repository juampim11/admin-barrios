/**
 * Volumen (BL-016): la pantalla del período de un barrio de 700 UF. Son las mismas cuatro lecturas que
 * hace `liquidacion/[periodo]/page.tsx`, en una transacción y con la identidad de un administrador
 * (bajo RLS): el período, la primera página de la grilla (500), el barrio y las aplicaciones.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conUsuario, type DbRequest } from "../../packages/data/src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../../packages/data/src/servicios/liquidacion.ts";
import { leerPeriodo } from "../../packages/data/src/servicios/periodos.ts";
import { listarLiquidaciones } from "../../packages/data/src/servicios/liquidaciones.ts";
import { leerBarrio } from "../../packages/data/src/servicios/barrios.ts";
import { listarAplicaciones } from "../../packages/data/src/servicios/cargos.ts";
import { dbDe, poolAdmin, poolApp } from "../../packages/data/test/helpers.ts";
import { anotar, armarEscenario, desarmarEscenario, medir, UNIDADES, type Escenario } from "./soporte.ts";
import { TOPES } from "./topes.ts";

/** El techo de página de la pantalla (`POR_PAGINA` en `liquidacion/[periodo]/page.tsx`). */
const POR_PAGINA = 500;

let admin: ReturnType<typeof poolAdmin>;
let appPool: ReturnType<typeof poolApp>;
let db: DbRequest;
let escenario: Escenario;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  escenario = await armarEscenario(admin, "2045-04");
  await conUsuario(db, escenario.usuario, (tx) => generarLiquidaciones(tx, { periodoId: escenario.periodoId }));
  await conUsuario(db, escenario.usuario, (tx) => emitirPeriodo(tx, { periodoId: escenario.periodoId }));
});

afterAll(async () => {
  if (escenario) await desarmarEscenario(admin, escenario);
  await Promise.all([admin.end(), appPool.end()]);
});

describe(`pantalla del período de ${UNIDADES} UF`, () => {
  it("lee el período, la primera página, el barrio y las aplicaciones dentro de su tope", async () => {
    const { resultado, ms } = await medir(() =>
      conUsuario(db, escenario.usuario, async (tx) => {
        const periodo = await leerPeriodo(tx, { periodoId: escenario.periodoId });
        const grilla = await listarLiquidaciones(tx, { periodoId: escenario.periodoId, limite: POR_PAGINA, desplazamiento: 0 });
        const barrio = await leerBarrio(tx, { barrioId: escenario.barrioId });
        const aplicaciones = await listarAplicaciones(tx, { periodoId: escenario.periodoId });
        return { periodo, grilla, barrio, aplicaciones };
      }),
    );
    anotar("pantalla-periodo-700", { ms });
    expect(resultado.periodo?.estado).toBe("emitida");
    expect(resultado.grilla.liquidaciones).toHaveLength(POR_PAGINA);
    expect(resultado.grilla.total).toBe(UNIDADES);
    expect(ms).toBeLessThan(TOPES.pantallaPeriodoMs);
  });
});
