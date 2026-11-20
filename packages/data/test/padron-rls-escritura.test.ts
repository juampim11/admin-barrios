/**
 * S6 (BL-023 a): el padrón no se escribe por SQL directo salvo la administración.
 *
 * `0103_padron_solo_administracion` deja las policies de INSERT y UPDATE de `unidad_funcional`,
 * `unidad_obligado`, `obligado`, `coeficiente_version` y `coeficiente` para `admin_plataforma` y
 * `admin_barrio` (los dos roles que escriben `padron_evento`). Antes también las tenía `operador`: podía
 * dar de alta una unidad, cambiar un titular o sus coeficientes sin dejar rastro.
 *
 * Una tabla por rol y por operación, sobre la misma conexión sujeta a RLS que usa la aplicación
 * (`app_request`), cada sentencia en su propia transacción que se deshace. Lo que la pantalla permite sigue
 * andando (`padron-edicion.test.ts` y `padron-romper.test.ts` lo ejercen por el servicio); acá se prueba lo
 * directo.
 *
 * `unidad_contacto` NO está acá a propósito: el operador sigue cargando contactos (con traza), ver
 * `unidad-contacto-traza.test.ts`.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/padron-rls-escritura.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { borrarArbol, crearArbol, crearBarrio, crearUnidades, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let arbol: Arbol;
let unidad: string;
let otraUnidad: string;
let obligado: string;
let titularidad: string;
let version: string;
let versionAbierta: string;
let coeficiente: string;
let coeficienteAbierto: string;

type Resultado = { readonly ok: boolean; readonly codigo: string | null };

/** Corre `sentencia` como `usuario` en una transacción que se deshace. `ok` = se aplicó al menos a una fila. */
async function intentar(usuario: string, sentencia: string, parametros: unknown[] = []): Promise<Resultado> {
  const c = await appPool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.user_id', $1, true)", [usuario]);
    const r = await c.query(sentencia, parametros);
    return { ok: (r.rowCount ?? 0) > 0, codigo: null };
  } catch (e) {
    return { ok: false, codigo: (e as { code?: string }).code ?? "?" };
  } finally {
    await c.query("rollback");
    c.release();
  }
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  const dos = await crearUnidades(admin, arbol.barrioA1.id, 2);
  unidad = dos[0]!;
  otraUnidad = dos[1]!;
  const b = arbol.barrioA1.id;
  obligado = (await admin.query<{ id: string }>("insert into obligado (barrio_id, nombre) values ($1, 'Titular de prueba') returning id", [b])).rows[0]!.id;
  titularidad = (
    await admin.query<{ id: string }>(
      "insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde) values ($1,$2,$3,'propietario', current_date - 5) returning id",
      [b, unidad, obligado],
    )
  ).rows[0]!.id;
  version = (
    await admin.query<{ id: string }>(
      "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
      [b],
    )
  ).rows[0]!.id;
  coeficiente = (
    await admin.query<{ id: string }>(
      "insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,0.5) returning id",
      [b, version, unidad],
    )
  ).rows[0]!.id;
  await admin.query("insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,0.5)", [b, version, otraUnidad]);
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [version]);
  // Una versión abierta aparte: en la cerrada, el trigger de coeficientes rechaza el insert antes que la policy
  // y el test no distinguiría una cosa de la otra.
  versionAbierta = (
    await admin.query<{ id: string }>(
      "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'superficie', '2030-01-01') returning id",
      [b],
    )
  ).rows[0]!.id;
  coeficienteAbierto = (
    await admin.query<{ id: string }>(
      "insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,1) returning id",
      [b, versionAbierta, unidad],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  if (arbol) {
    await admin.query("set session_replication_role = replica");
    for (const tabla of ["coeficiente", "coeficiente_version", "unidad_obligado", "obligado", "unidad_funcional", "codigo_pago_secuencia", "barrio"]) {
      await admin.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [[arbol.barrioA1.id]]);
    }
    await admin.query("set session_replication_role = origin");
    await borrarArbol(admin, arbol);
  }
  await appPool.end();
  await admin.end();
});

/** Una sentencia por operación y tabla del padrón. Los insert van a otra unidad/persona/versión para no chocar. */
const OPERACIONES = (b: string): ReadonlyArray<{ nombre: string; sql: string; params: unknown[] }> => [
  { nombre: "unidad_funcional · insert", sql: "insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1,'S6','1','construido')", params: [b] },
  { nombre: "unidad_funcional · update (saldo inicial)", sql: "update unidad_funcional set saldo_inicial = 99999 where id = $1", params: [unidad] },
  { nombre: "unidad_funcional · update (superficie)", sql: "update unidad_funcional set superficie_m2 = 123 where id = $1", params: [unidad] },
  { nombre: "unidad_funcional · update (baja)", sql: "update unidad_funcional set baja_at = now(), baja_motivo = 'otro' where id = $1", params: [unidad] },
  { nombre: "obligado · insert", sql: "insert into obligado (barrio_id, nombre) values ($1,'Otra persona')", params: [b] },
  { nombre: "obligado · update", sql: "update obligado set nombre = 'Cambiado' where id = $1", params: [obligado] },
  { nombre: "unidad_obligado · insert (titular nuevo)", sql: "insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde) values ($1,$2,$3,'poseedor', current_date)", params: [b, unidad, obligado] },
  { nombre: "unidad_obligado · update (cierra la titularidad)", sql: "update unidad_obligado set hasta = current_date where id = $1", params: [titularidad] },
  { nombre: "coeficiente_version · insert", sql: "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1,'partes_iguales', current_date)", params: [b] },
  { nombre: "coeficiente_version · update", sql: "update coeficiente_version set descripcion = 'cambiada' where id = $1", params: [versionAbierta] },
  { nombre: "coeficiente · insert", sql: "insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,2)", params: [b, versionAbierta, otraUnidad] },
  { nombre: "coeficiente · update", sql: "update coeficiente set valor = 2 where id = $1", params: [coeficienteAbierto] },
];

describe("S6: lo directo sobre el padrón, por rol", () => {
  // Los que NO son de la administración: ninguna escritura directa pasa (policy, o el guard del trigger).
  const SIN_ESCRITURA: ReadonlyArray<readonly [string, () => string]> = [
    ["operador", () => arbol.usuarios.operadorA1],
    ["contador", () => arbol.usuarios.contadorA1],
    ["auditor", () => arbol.usuarios.auditorA1],
    ["propietario", () => arbol.usuarios.propietarioA1],
    ["residente", () => arbol.usuarios.residenteA1],
  ];

  for (const [rol, usuario] of SIN_ESCRITURA) {
    it(`${rol}: ninguna operación de escritura directa sobre el padrón se aplica`, async () => {
      for (const op of OPERACIONES(arbol.barrioA1.id)) {
        const r = await intentar(usuario(), op.sql, op.params);
        expect({ op: op.nombre, ok: r.ok }, `${rol} no debería poder: ${op.nombre}`).toEqual({ op: op.nombre, ok: false });
      }
    });
  }

  it("operador: los inserts se rechazan con 42501 (la policy), no por otra cosa", async () => {
    for (const op of OPERACIONES(arbol.barrioA1.id).filter((o) => o.nombre.endsWith("insert") || o.nombre.includes("insert ("))) {
      const r = await intentar(arbol.usuarios.operadorA1, op.sql, op.params);
      expect(r.codigo, op.nombre).toBe("42501");
    }
  });

  it("operador: sigue leyendo el padrón (lo necesita para cargar cobros)", async () => {
    const r = await intentar(arbol.usuarios.operadorA1, "select id from unidad_funcional where id = $1", [unidad]);
    expect(r.ok).toBe(true);
  });

  it("nadie borra, ni la administración ni el operador (no hay policy ni privilegio de DELETE)", async () => {
    for (const usuario of [arbol.usuarios.adminBarrioA1, arbol.usuarios.adminEstudioA, arbol.usuarios.operadorA1]) {
      for (const sentencia of [
        "delete from unidad_funcional where id = $1",
        "delete from obligado where id = $1",
        "delete from unidad_obligado where id = $1",
      ]) {
        const id = sentencia.includes("unidad_funcional") ? unidad : sentencia.includes("unidad_obligado") ? titularidad : obligado;
        const r = await intentar(usuario, sentencia, [id]);
        expect(r.ok, sentencia).toBe(false);
      }
    }
  });

  // La administración sí: es el mismo SQL que ejecuta el servicio del padrón (`padron-edicion.ts`). Las doce
  // operaciones, para que «el operador no puede» no sea vacuo (que falle por un trigger o por un dato mal armado).
  for (const [rol, usuario] of [
    ["admin_barrio del barrio", () => arbol.usuarios.adminBarrioA1],
    ["admin_barrio de la administración", () => arbol.usuarios.adminEstudioA],
  ] as const) {
    it(`${rol}: las doce operaciones directas se aplican (lo que hace la pantalla sigue andando)`, async () => {
      for (const op of OPERACIONES(arbol.barrioA1.id)) {
        const r = await intentar(usuario(), op.sql, op.params);
        expect({ op: op.nombre, ok: r.ok, codigo: r.codigo }).toEqual({ op: op.nombre, ok: true, codigo: null });
      }
    });
  }

  it("mover una fila a otro barrio se rechaza (el with check mira el barrio nuevo)", async () => {
    const r = await intentar(arbol.usuarios.adminBarrioA1, "update unidad_funcional set barrio_id = $2 where id = $1", [unidad, arbol.barrioA2.id]);
    expect(r).toEqual({ ok: false, codigo: "42501" });
  });

  it("la administración de OTRO barrio no escribe en este (aislamiento intacto)", async () => {
    const r = await intentar(arbol.usuarios.adminEstudioB, "update unidad_funcional set superficie_m2 = 1 where id = $1", [unidad]);
    expect(r.ok).toBe(false);
  });
});
