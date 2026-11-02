/**
 * `exportacion_movimientos` — **el gate de "quién puede exportar el libro de movimientos"**.
 *
 * Este archivo no verifica una tabla de auditoría: verifica el **control de acceso de la feature**.
 * Como la exportación es síncrona y no deja artefacto, no hay una tabla de documento sobre la cual
 * poner una policy de `select` que decida quién puede exportar — así que el gate vive en el `insert`
 * de la traza (`0051`), y la fila se escribe antes de serializar. De ahí que probar el `insert` sea
 * probar la autorización entera: **no se puede exportar sin dejar rastro, ni dejar rastro sin el
 * rol**.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/exportaciones-rls.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { sql } from "drizzle-orm";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { contarMovimientos, registrarExportacion } from "../src/servicios/exportaciones.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> => conUsuario(db, usuario, fn);

const RANGO = { periodoDesde: "2026-01", periodoHasta: "2026-03" } as const;
const CONTEO = { ingresos: 3, imputaciones: 5, egresos: 2, total: 10 } as const;

/** Intenta registrar una exportación de A1 como `usuario`. Devuelve si la dejó pasar. */
async function puedeExportar(usuario: string, barrioId = arbol.barrioA1.id): Promise<boolean> {
  try {
    await como(usuario, (tx) =>
      registrarExportacion(tx, { barrioId, ...RANGO, conteo: CONTEO, incluyoProvisorio: false }),
    );
    return true;
  } catch {
    return false;
  }
}

async function fijarFlagAuditor(valor: boolean): Promise<void> {
  await admin.query("update barrio set auditor_exporta_movimientos = $2 where barrio_id = $1", [
    arbol.barrioA1.id,
    valor,
  ]);
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioB1.id);
});

/**
 * La traza es append-only **de verdad**: `app.solo_append()` rechaza el `delete` incluso con la
 * conexión de admin. Para limpiar el fixture hay que desactivar los triggers de la sesión — mismo
 * patrón que ya usan `ataques-escritura.test.ts` y `cobros-imputacion.test.ts`.
 *
 * Que la limpieza del test necesite este rodeo **es la prueba de que el candado funciona**, y por eso
 * se deja escrito acá en vez de aflojar el trigger.
 */
async function limpiarTraza(): Promise<void> {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from exportacion_movimientos where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("set session_replication_role = origin");
}

afterEach(async () => {
  await limpiarTraza();
  await fijarFlagAuditor(false);
});

afterAll(async () => {
  await limpiarTraza();
  // Las vigencias de los cinco ejes las siembra el alta del barrio: cuelgan de él por FK y hay que
  // sacarlas primero (de hijo a padre, mismo orden que `borrarArbol`).
  await admin.query("delete from barrio_atributo_vigencia where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("delete from barrio where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await borrarArbol(admin, arbol);
  await appPool.end();
  await admin.end();
});

describe("quién puede exportar", () => {
  it("admin_barrio del estudio puede", async () => {
    expect(await puedeExportar(arbol.usuarios.adminEstudioA)).toBe(true);
  });

  it("admin_barrio del barrio puede", async () => {
    expect(await puedeExportar(arbol.usuarios.adminBarrioA1)).toBe(true);
  });

  /**
   * El contador es el **destinatario** del entregable (doc 01 §4.8): si no pudiera exportarlo, la
   * feature no tendría a quién servir. Es además el único conjunto de roles de este repo donde el
   * contador aparece — en todos los demás es solo lectura.
   */
  it("contador puede: es el destinatario del entregable", async () => {
    expect(await puedeExportar(arbol.usuarios.contadorA1)).toBe(true);
  });

  /**
   * **El corazón del gate.** El operador carga pagos, gastos y órdenes de pago de a uno, y los lee
   * todos por pantalla. Pero el libro completo es un agregado del barrio entero que sale del sistema
   * en un archivo — y el repo ya había tomado esta misma decisión para el listado de saldos
   * pendientes (`documento_emitido_sel`, `0027`): un agregado no es la suma de las filas que uno
   * puede leer.
   */
  it("operador NO puede, aunque cargue esos mismos movimientos de a uno", async () => {
    expect(await puedeExportar(arbol.usuarios.operadorA1)).toBe(false);
  });

  it("operador NO puede ni siquiera con el flag de auditor prendido", async () => {
    await fijarFlagAuditor(true);
    expect(await puedeExportar(arbol.usuarios.operadorA1)).toBe(false);
  });

  it("propietario y residente no pueden: no leen ni una fila del barrio", async () => {
    expect(await puedeExportar(arbol.usuarios.propietarioA1)).toBe(false);
    expect(await puedeExportar(arbol.usuarios.residenteA1)).toBe(false);
  });

  it("una membresía inactiva no puede", async () => {
    expect(await puedeExportar(arbol.usuarios.inactivoA1)).toBe(false);
  });

  it("sin membresía no puede", async () => {
    expect(await puedeExportar(arbol.usuarios.sinMembresia)).toBe(false);
  });
});

describe("el auditor depende del flag del barrio", () => {
  /**
   * La decisión que el panel derivó a producto y que el usuario resolvió (2026-08-26): configurable
   * **por barrio**, no por el producto. Un auditor que no puede exportar no puede auditar; y también
   * es un rol de lectura amplia sobre un archivo que sale del sistema. Lo decide el barrio.
   */
  it("con el flag en false (el default) NO puede", async () => {
    await fijarFlagAuditor(false);
    expect(await puedeExportar(arbol.usuarios.auditorA1)).toBe(false);
  });

  it("con el flag en true SÍ puede", async () => {
    await fijarFlagAuditor(true);
    expect(await puedeExportar(arbol.usuarios.auditorA1)).toBe(true);
  });

  /** El flag es por barrio: prenderlo en A1 no habilita nada en B1. */
  it("el flag de un barrio no se derrama al otro", async () => {
    await fijarFlagAuditor(true);
    expect(await puedeExportar(arbol.usuarios.auditorA1, arbol.barrioB1.id)).toBe(false);
  });
});

describe("aislamiento entre barrios", () => {
  it("un admin del estudio B no puede exportar un barrio de A", async () => {
    expect(await puedeExportar(arbol.usuarios.adminEstudioB, arbol.barrioA1.id)).toBe(false);
  });

  it("un admin de A no puede exportar el barrio de B", async () => {
    expect(await puedeExportar(arbol.usuarios.adminEstudioA, arbol.barrioB1.id)).toBe(false);
  });

  /**
   * Contar un barrio ajeno devuelve **cero, no un error**: distinguir "no existe" de "no es tuyo"
   * convertiría el conteo en un oráculo de existencia de barrios — mismo criterio que la ruta de
   * descarga de documentos.
   */
  it("contar un barrio ajeno da cero, no falla", async () => {
    const conteo = await como(arbol.usuarios.adminEstudioB, (tx) =>
      contarMovimientos(tx, { barrioId: arbol.barrioA1.id, ...RANGO }),
    );
    expect(conteo).toEqual({ ingresos: 0, imputaciones: 0, egresos: 0, total: 0 });
  });
});

describe("la traza es confiable", () => {
  /**
   * `solicitado_por` la escribe la base desde `app.current_user_id()`. Si la pudiera escribir quien
   * la genera, no sería una firma de auditoría: sería un campo más.
   */
  it("solicitado_por lo escribe la base, no el cliente", async () => {
    await como(arbol.usuarios.contadorA1, (tx) =>
      registrarExportacion(tx, {
        barrioId: arbol.barrioA1.id,
        ...RANGO,
        conteo: CONTEO,
        incluyoProvisorio: false,
      }),
    );

    const { rows } = await admin.query<{ solicitado_por: string; filas_ingresos: number }>(
      "select solicitado_por, filas_ingresos from exportacion_movimientos where barrio_id = $1",
      [arbol.barrioA1.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.solicitado_por).toBe(arbol.usuarios.contadorA1);
    expect(rows[0]?.filas_ingresos).toBe(CONTEO.ingresos);
  });

  /**
   * **Regresión encontrada corriendo estos tests, no razonándola.** El sello se pedía con `INSERT …
   * RETURNING`, que bajo RLS exige que la fila pase también la policy de **SELECT** — y el contador
   * puede insertar pero deliberadamente no puede leer esta tabla. O sea: exportar le fallaba
   * justamente al destinatario del entregable. Ahora el sello sale de un `select now()` en la misma
   * transacción, que es el mismo instante.
   */
  it("el contador obtiene el sello aunque no pueda leer la tabla", async () => {
    const { selloDeExtraccion } = await como(arbol.usuarios.contadorA1, (tx) =>
      registrarExportacion(tx, {
        barrioId: arbol.barrioA1.id,
        ...RANGO,
        conteo: CONTEO,
        incluyoProvisorio: false,
      }),
    );
    expect(selloDeExtraccion).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  /** El sello del libro tiene que ser el MISMO instante que quedó en la fila, o no ata nada. */
  it("el sello coincide con el solicitado_at registrado", async () => {
    const { selloDeExtraccion } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      registrarExportacion(tx, {
        barrioId: arbol.barrioA1.id,
        ...RANGO,
        conteo: CONTEO,
        incluyoProvisorio: false,
      }),
    );

    const { rows } = await admin.query<{ sello: string }>(
      `select to_char(solicitado_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as sello
         from exportacion_movimientos where barrio_id = $1`,
      [arbol.barrioA1.id],
    );
    expect(rows[0]?.sello).toBe(selloDeExtraccion);
  });

  it("es append-only: no se puede editar ni borrar la traza", async () => {
    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      registrarExportacion(tx, {
        barrioId: arbol.barrioA1.id,
        ...RANGO,
        conteo: CONTEO,
        incluyoProvisorio: false,
      }),
    );

    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update exportacion_movimientos set filas_ingresos = 0`),
      ),
    ).rejects.toThrow();

    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) => tx.execute(sql`delete from exportacion_movimientos`)),
    ).rejects.toThrow();
  });

  it("registra el rango y si el libro salió provisorio", async () => {
    await como(arbol.usuarios.contadorA1, (tx) =>
      registrarExportacion(tx, {
        barrioId: arbol.barrioA1.id,
        ...RANGO,
        conteo: CONTEO,
        incluyoProvisorio: true,
      }),
    );

    const { rows } = await admin.query<{
      periodo_desde: string;
      periodo_hasta: string;
      incluyo_provisorio: boolean;
      alcance: string;
      formato: string;
    }>(
      `select periodo_desde, periodo_hasta, incluyo_provisorio, alcance, formato
         from exportacion_movimientos where barrio_id = $1`,
      [arbol.barrioA1.id],
    );
    expect(rows[0]).toMatchObject({
      periodo_desde: "2026-01",
      periodo_hasta: "2026-03",
      incluyo_provisorio: true,
      alcance: "movimientos",
      formato: "xlsx",
    });
  });
});

/**
 * El flag es **dato de gobierno del barrio**, y su grant de columna nació con ella (`0050` §3). Este
 * bloque cubre las dos mitades de esa decisión — y la segunda es la que importa más, porque es la
 * que se rompe sin hacer ruido.
 */
describe("el flag no es autoconfigurable", () => {
  it("app_request no puede escribir auditor_exporta_movimientos, ni siquiera siendo admin_barrio", async () => {
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(
          sql`update barrio set auditor_exporta_movimientos = true where barrio_id = ${arbol.barrioA1.id}`,
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("tampoco puede el admin del estudio, que es el rol más alto que llega por app_request", async () => {
    await expect(
      como(arbol.usuarios.adminEstudioA, (tx) =>
        tx.execute(
          sql`update barrio set auditor_exporta_movimientos = true where barrio_id = ${arbol.barrioA1.id}`,
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  /**
   * **La regresión más probable de esta tanda.** `revoke` + `grant (columnas)` no es incremental: la
   * migración `0050` tiene que volver a nombrar las 17 columnas escribibles que venían de `0047`. Si
   * alguna se cae de esa lista, la escritura correspondiente se rompe **en silencio** — no falla al
   * migrar, falla recién el día que alguien edita esa columna desde la aplicación.
   *
   * Por eso el test no verifica "la columna nueva está cerrada" (que es lo obvio) sino **el conjunto
   * exacto**: las 17 que tienen que poder escribirse, y ni una de las tres de gobierno.
   */
  it("las 17 columnas escribibles de barrio siguen escribibles, y las 3 de gobierno no", async () => {
    const { rows } = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_name = 'barrio' and grantee = 'app_request' and privilege_type = 'UPDATE'
        order by column_name`,
    );
    const escribibles = rows.map((r) => r.column_name);

    expect(escribibles).toEqual([
      "adecuado_art_2075",
      "cuit",
      "denominacion_concepto",
      "domicilio_sede",
      "encuadre_urbanistico",
      "figura_juridica",
      "jurisdiccion",
      "medio_cobranza_clave",
      "municipio",
      "pacto_ejecutividad",
      "reglamento_inscripto",
      "servicios_internos_a_cargo_de",
      "tiene_consejo",
      "tiene_espacios_comunes_exclusivos",
      "tiene_fondo_reserva",
      "titularidad_espacios_comunes",
      "updated_at",
    ]);

    // Las tres de gobierno, nombradas de nuevo acá para que borrar una de la lista de arriba no
    // pase inadvertido: si alguna aparece, el grant se volvió a abrir.
    expect(escribibles).not.toContain("orden_imputacion");
    expect(escribibles).not.toContain("orden_pago_cuatro_ojos");
    expect(escribibles).not.toContain("auditor_exporta_movimientos");
  });
});

describe("quién LEE la traza", () => {
  async function cuantasVe(usuario: string): Promise<number> {
    const { rows } = await como(usuario, (tx) =>
      tx.execute<{ n: string }>(sql`select count(*) as n from exportacion_movimientos`),
    );
    return Number.parseInt(rows[0]?.n ?? "0", 10);
  }

  // `beforeEach` y no `beforeAll`: el `afterEach` de arriba limpia la traza entre tests (tiene que
  // hacerlo, o el conteo de un test arrastra las filas del anterior), así que cada uno necesita
  // sembrar la suya.
  beforeEach(async () => {
    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      registrarExportacion(tx, {
        barrioId: arbol.barrioA1.id,
        ...RANGO,
        conteo: CONTEO,
        incluyoProvisorio: false,
      }),
    );
  });

  it("la administración ve el registro", async () => {
    expect(await cuantasVe(arbol.usuarios.adminBarrioA1)).toBeGreaterThan(0);
  });

  /**
   * El auditor lee esta tabla **siempre**, aunque el barrio no lo habilite a exportar: ver el libro
   * y ver quién lo sacó son cosas distintas, y auditar el uso del sistema es literalmente su función.
   */
  it("el auditor ve el registro aunque no pueda exportar", async () => {
    await fijarFlagAuditor(false);
    expect(await cuantasVe(arbol.usuarios.auditorA1)).toBeGreaterThan(0);
  });

  /** Es el destinatario del entregable, no un supervisor del uso del sistema. */
  it("el contador NO ve quién más exportó", async () => {
    expect(await cuantasVe(arbol.usuarios.contadorA1)).toBe(0);
  });

  /** No puede exportar; no tiene por qué saber quién exportó. */
  it("el operador NO ve el registro", async () => {
    expect(await cuantasVe(arbol.usuarios.operadorA1)).toBe(0);
  });

  it("un barrio ajeno no ve nada", async () => {
    expect(await cuantasVe(arbol.usuarios.adminEstudioB)).toBe(0);
  });
});
