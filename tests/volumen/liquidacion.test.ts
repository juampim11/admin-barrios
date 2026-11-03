/**
 * Volumen (BL-016): la liquidación de un barrio de 700 UF y su emisión, por el mismo servicio que usa
 * la pantalla y con la identidad de un administrador del barrio (bajo RLS).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conUsuario, type DbRequest } from "../../packages/data/src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../../packages/data/src/servicios/liquidacion.ts";
import { dbDe, poolAdmin, poolApp } from "../../packages/data/test/helpers.ts";
import { anotar, armarEscenario, desarmarEscenario, medir, UNIDADES, type Escenario } from "./soporte.ts";
import { TOPES } from "./topes.ts";

let admin: ReturnType<typeof poolAdmin>;
let appPool: ReturnType<typeof poolApp>;
let db: DbRequest;
let escenario: Escenario;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  escenario = await armarEscenario(admin, "2045-03");
});

afterAll(async () => {
  if (escenario) await desarmarEscenario(admin, escenario);
  await Promise.all([admin.end(), appPool.end()]);
});

describe(`liquidación de ${UNIDADES} UF`, () => {
  it("genera el borrador dentro de su tope, y cuadra", async () => {
    const { resultado, ms } = await medir(() =>
      conUsuario(db, escenario.usuario, (tx) => generarLiquidaciones(tx, { periodoId: escenario.periodoId })),
    );
    anotar("liquidacion-700", { ms });
    expect(resultado.unidadesLiquidadas).toBe(UNIDADES);
    expect(resultado.totalRepartido).toBe(resultado.totalGastos);
    expect(ms).toBeLessThan(TOPES.liquidacionMs);
  });

  it("emite el período dentro de su tope", async () => {
    const { ms } = await medir(() =>
      conUsuario(db, escenario.usuario, (tx) => emitirPeriodo(tx, { periodoId: escenario.periodoId })),
    );
    anotar("emision-periodo-700", { ms });
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from saldo_uf where barrio_id = $1 and saldo_actual > 0",
      [escenario.barrioId],
    );
    expect(rows[0]?.n).toBe(String(UNIDADES));
    expect(ms).toBeLessThan(TOPES.emisionPeriodoMs);
  });
});
