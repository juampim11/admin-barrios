/**
 * Volumen (T3): importar la planilla del padrón de un barrio de 700 UF —vista previa y confirmación—
 * por el mismo servicio que usa la pantalla (la ruta `app/api/padron/planilla`), con la identidad de
 * un administrador del barrio (bajo RLS). La planilla se arma como CSV de texto y pasa por el mismo
 * lector (`filasDeCsv`): se mide la lectura, el plan contra el padrón y la escritura en lote.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conUsuario, type DbRequest } from "../../packages/data/src/client.ts";
import { confirmarImportacion, vistaPreviaDeImportacion } from "../../packages/data/src/servicios/padron-edicion.ts";
import { columnasDelPadron, csvDeFilas, filasDeCsv } from "../../packages/shared/src/padron.ts";
import { verificadorBloque1, verificadorBloque2 } from "../../packages/shared/src/cuentas.ts";
import { crearArbol, crearBarrio, dbDe, poolAdmin, poolApp } from "../../packages/data/test/helpers.ts";
import { anotar, desarmarEscenario, medir, UNIDADES, type Escenario } from "./soporte.ts";
import { TOPES } from "./topes.ts";

let admin: ReturnType<typeof poolAdmin>;
let appPool: ReturnType<typeof poolApp>;
let db: DbRequest;
let escenario: Escenario;
let csv: string;

/** Un CBU inventado con los verificadores bien (la base los exige). */
const cbu = (n: number) => {
  const b1 = "2850590";
  const b2 = `40${String(n).padStart(11, "0")}`;
  return `${b1}${verificadorBloque1(b1)}${b2}${verificadorBloque2(b2)}`;
};

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  const arbol = await crearArbol(admin);
  const barrioId = arbol.barrioA2.id;
  await crearBarrio(admin, barrioId, { figuraJuridica: "sa", adecuadoArt2075: "no_aplica" });
  await admin.query(
    `update barrio set identificacion_pago = 'cuenta_por_unidad', recaudador = 'Recaudador', cuenta_cbu = $2, modelo_liquidacion = 'fija'
      where barrio_id = $1`,
    [barrioId, cbu(999_999)],
  );
  escenario = { arbol, barrioId, periodoId: "", usuario: arbol.usuarios.adminEstudioA };

  // 700 unidades, una de cada diez con dos titulares, nueve de cada diez con cuenta propia.
  const columnas = columnasDelPadron(true);
  const filas: string[][] = [[...columnas]];
  const fila = (v: Partial<Record<(typeof columnas)[number], string>>) => columnas.map((c) => v[c] ?? "");
  for (let i = 1; i <= UNIDADES; i++) {
    const manzana = String(Math.ceil(i / 25));
    const lote = String(((i - 1) % 25) + 1);
    filas.push(
      fila({
        manzana,
        lote,
        superficie_m2: `${500 + (i % 300)},00`,
        estado: i % 11 === 0 ? "Baldío" : "Construida",
        titular: `Titular Inventado ${i}`,
        cuit_o_dni: String(30_000_000 + i * 13),
        recibe_boleta: "sí",
        mail: `titular.${i}@ejemplo.test`,
        cbu_unidad: i % 10 === 0 ? "" : cbu(i),
        saldo_inicial: i % 50 === 0 ? "12500,00" : "",
      }),
    );
    if (i % 10 === 0) filas.push(fila({ manzana, lote, titular: `Cotitular Inventada ${i}`, cuit_o_dni: String(40_000_000 + i * 17) }));
  }
  csv = csvDeFilas(filas);
});

afterAll(async () => {
  if (escenario) await desarmarEscenario(admin, escenario);
  await Promise.all([admin.end(), appPool.end()]);
});

describe(`importación de la planilla de ${UNIDADES} UF`, () => {
  it("arma la vista previa dentro de su tope, sin escribir nada", async () => {
    const { resultado, ms, picoRssMb } = await medir(() =>
      conUsuario(db, escenario.usuario, (tx) =>
        vistaPreviaDeImportacion(tx, { barrioId: escenario.barrioId, archivo: "padron-700.csv", filas: filasDeCsv(csv) }),
      ),
    );
    anotar("padron-previa-700", { ms, picoRssMb });
    expect([resultado.ok, resultado.altas, resultado.conError]).toEqual([true, UNIDADES, 0]);
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from unidad_funcional where barrio_id = $1", [escenario.barrioId]);
    expect(rows[0]?.n).toBe(0);
    expect(ms).toBeLessThan(TOPES.padronPreviaMs);
  });

  it("confirma la importación dentro de su tope: todas las unidades, sus titulares y su historial", async () => {
    const { resultado, ms, picoRssMb } = await medir(() =>
      conUsuario(db, escenario.usuario, (tx) =>
        confirmarImportacion(tx, { barrioId: escenario.barrioId, archivo: "padron-700.csv", filas: filasDeCsv(csv) }),
      ),
    );
    anotar("padron-confirmar-700", { ms, picoRssMb });
    expect(resultado.altas).toBe(UNIDADES);
    const { rows } = await admin.query<{ unidades: number; titulares: number; eventos: number; coeficientes: number }>(
      `select (select count(*)::int from unidad_funcional where barrio_id = $1) as unidades,
              (select count(*)::int from unidad_obligado where barrio_id = $1) as titulares,
              (select count(*)::int from padron_evento where barrio_id = $1 and tipo = 'alta_planilla') as eventos,
              (select count(*)::int from coeficiente where barrio_id = $1) as coeficientes`,
      [escenario.barrioId],
    );
    // Cuota fija: la versión de partes iguales se arma sola con las 700.
    expect(rows[0]).toEqual({ unidades: UNIDADES, titulares: UNIDADES + UNIDADES / 10, eventos: UNIDADES, coeficientes: UNIDADES });
    expect(ms).toBeLessThan(TOPES.padronConfirmarMs);
  });
});
