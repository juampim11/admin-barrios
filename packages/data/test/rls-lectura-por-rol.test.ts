/**
 * La precondición de seguridad del ADR-0002 §3.5, contra Postgres real.
 *
 * Lo que se protege acá es la frase que el producto tiene que poder sostener: **"un vecino no ve los
 * datos de otro vecino"**. Hasta 0018 no era cierta — las policies de `select` de dominio y expensas
 * miraban el subárbol de tenants pero no el ROL, así que cualquier membresía sobre un barrio leía el
 * padrón entero con la PII de todos los propietarios.
 *
 * Estos tests fallan si alguien reabre el agujero, incluso en una tabla que todavía no existe:
 * el `describe` de "ninguna tabla de barrio queda sin gate" se arma leyendo el catálogo de Postgres,
 * no una lista escrita a mano.
 *
 * Ver `packages/data/migrations/0018_rls_lectura_por_rol.sql`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { conUsuario, type DbRequest } from "../src/client.ts";
import {
  borrarArbol,
  crearArbol,
  crearBarrio,
  crearCoeficientes,
  crearUnidades,
  dbDe,
  poolAdmin,
  poolApp,
  type Arbol,
} from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let unidadesA1: string[];

/** Tablas con datos del barrio que un rol sin gestión NO puede leer, ni una fila. */
const TABLAS_DE_BARRIO = [
  // padrón (0003)
  "barrio",
  "barrio_atributo_vigencia",
  "unidad_funcional",
  "unidad_contacto",
  "obligado",
  "unidad_obligado",
  "coeficiente_version",
  "coeficiente",
  "documento_barrio",
  "mandato_administracion",
  // liquidación (0005)
  "concepto",
  "tasa_mora",
  "periodo_expensa",
  "gasto_periodo",
  "liquidacion",
  "item_liquidacion",
  // cuota fija (0007)
  "cuota_fija_version",
  "cuota_fija",
  // medios de pago (0009)
  "medio_pago_barrio",
  // cargos y descuentos (0016)
  "concepto_boleta",
  "concepto_boleta_valor",
  "concepto_boleta_unidad",
  "concepto_boleta_unidad_evento",
  "limite_aplicacion_barrio",
] as const;

/** Cuenta filas visibles de una tabla para un usuario, a través de la conexión sujeta a RLS. */
async function filasVisibles(userId: string, tabla: string): Promise<number> {
  return conUsuario(db, userId, async (tx) => {
    const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from ${sql.identifier(tabla)}`);
    return Number(res.rows[0]?.n ?? "-1");
  });
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioA2.id);
  unidadesA1 = await crearUnidades(admin, arbol.barrioA1.id, 4);

  // Una fila en cada tabla que se va a interrogar, para que "cero filas visibles" signifique algo:
  // sin datos, un test que espera 0 pasa siempre y no prueba nada.
  //
  // Las dos excepciones son `concepto_boleta_unidad` y su tabla de eventos: sembrarlas exige un
  // período en borrador y disparar `app.resolver_aplicaciones()`, que ya tiene su propia batería en
  // `expensas-liquidacion.test.ts`. Para esas dos, la garantía la da el test de catálogo del final
  // (que mira la policy, no los datos) más el test de 0016 que ya existía.
  const barrio = arbol.barrioA1.id;
  await crearCoeficientes(admin, barrio, unidadesA1);
  const { rows: obl } = await admin.query<{ id: string }>(
    `insert into obligado (barrio_id, nombre, tipo_documento, numero_documento)
     values ($1, 'Vecina de al lado', 'dni', '30111222') returning id`,
    [barrio],
  );
  await admin.query(
    `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
     values ($1,$2,$3,'propietario', current_date - 10, true)`,
    [barrio, unidadesA1[0], obl[0]?.id],
  );
  await admin.query(
    `insert into unidad_contacto (barrio_id, unidad_funcional_id, email, nombre)
     values ($1,$2,'vecina@ejemplo.test','Vecina de al lado')`,
    [barrio, unidadesA1[0]],
  );
  await admin.query(
    `insert into documento_barrio (barrio_id, tipo, titulo, fecha_documento)
     values ($1,'acta_asamblea','Acta de prueba', current_date)`,
    [barrio],
  );
  await admin.query(
    `insert into mandato_administracion (barrio_id, administrador_id, desde) values ($1,$2, current_date - 30)`,
    [barrio, arbol.adminA.id],
  );
  await admin.query(
    `insert into tasa_mora (barrio_id, tasa_mensual, vigente_desde) values ($1, 3.0, current_date - 30)`,
    [barrio],
  );
  await admin.query(
    `insert into medio_pago_barrio (barrio_id, tipo, detalle, titular)
     values ($1,'alias','ALIAS.DE.PRUEBA','Barrio Los Álamos')`,
    [barrio],
  );
  const { rows: con } = await admin.query<{ id: string }>(
    `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
     values ($1,'Seguridad','ordinaria','sin_clasificar') returning id`,
    [barrio],
  );
  const { rows: per } = await admin.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo) values ($1,'2029-11') returning id`,
    [barrio],
  );
  const { rows: gas } = await admin.query<{ id: string }>(
    `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto)
     values ($1,$2,$3,'Vigilancia', 100000) returning id`,
    [barrio, per[0]?.id, con[0]?.id],
  );
  const { rows: liq } = await admin.query<{ id: string }>(
    `insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado,
                              subtotal_ordinarias, subtotal_extraordinarias, subtotal_fondo_reserva,
                              interes_mora, total)
     values ($1,$2,$3, 0.25, 25000, 0, 0, 0, 25000) returning id`,
    [barrio, per[0]?.id, unidadesA1[0]],
  );
  await admin.query(
    `insert into item_liquidacion (barrio_id, liquidacion_id, gasto_id, descripcion, tipo,
                                   coeficiente_aplicado, base_monto, monto)
     values ($1,$2,$3,'Vigilancia','ordinaria', 0.25, 100000, 25000)`,
    [barrio, liq[0]?.id, gas[0]?.id],
  );
  const { rows: cfv } = await admin.query<{ id: string }>(
    `insert into cuota_fija_version (barrio_id, vigente_desde) values ($1, current_date - 30) returning id`,
    [barrio],
  );
  await admin.query(
    `insert into cuota_fija (barrio_id, version_id, unidad_funcional_id, importe) values ($1,$2,$3, 1000)`,
    [barrio, cfv[0]?.id, unidadesA1[0]],
  );
  const { rows: cb } = await admin.query<{ id: string }>(
    `insert into concepto_boleta (barrio_id, nombre, clase, metodo, clasificacion_fiscal, financiamiento)
     values ($1,'Descuento jubilado','descuento','monto_fijo','sin_clasificar','absorbe_barrio') returning id`,
    [barrio],
  );
  await admin.query(
    `insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, monto_fijo, vigente_desde)
     values ($1,$2,'monto_fijo', 500, current_date - 30)`,
    [barrio, cb[0]?.id],
  );
  await admin.query(
    `insert into limite_aplicacion_barrio (barrio_id, monto_max_operador, porcentaje_max_operador, vigente_desde)
     values ($1, 10000, 50, current_date - 30)`,
    [barrio],
  );
});

afterAll(async () => {
  for (const tabla of [
    "concepto_boleta_unidad_evento",
    "concepto_boleta_unidad",
    "concepto_boleta_valor",
    "concepto_boleta",
    "limite_aplicacion_barrio",
    "item_liquidacion",
    "liquidacion",
    "gasto_periodo",
    "periodo_expensa",
    "concepto",
    "cuota_fija",
    "cuota_fija_version",
    "coeficiente",
    "coeficiente_version",
    "medio_pago_barrio",
    "tasa_mora",
    "mandato_administracion",
    "unidad_contacto",
    "unidad_obligado",
    "obligado",
    "unidad_funcional",
    "barrio_atributo_vigencia",
    "documento_barrio",
    "barrio",
  ]) {
    await admin.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [
      [arbol.barrioA1.id, arbol.barrioA2.id],
    ]);
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// -------------------------------------------------------------------------------------------
// El agujero que cierra 0018.
// -------------------------------------------------------------------------------------------
describe("`propietario` y `residente` no leen NADA del barrio", () => {
  for (const rol of ["propietarioA1", "residenteA1"] as const) {
    describe(`rol ${rol.replace("A1", "")}`, () => {
      for (const tabla of TABLAS_DE_BARRIO) {
        it(`no ve ninguna fila de ${tabla}`, async () => {
          expect(await filasVisibles(arbol.usuarios[rol], tabla)).toBe(0);
        });
      }
    });
  }

  it("y el padrón que no ve tiene filas de verdad (el 0 significa algo)", async () => {
    // Sin esto, todos los tests de arriba pasarían con las tablas vacías.
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from obligado where barrio_id = $1",
      [arbol.barrioA1.id],
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  it("un propietario ve su propia membresía, pero no el elenco del barrio", async () => {
    const filas = await conUsuario(db, arbol.usuarios.propietarioA1, async (tx) => {
      const res = await tx.execute<{ user_id: string; rol: string }>(
        sql`select user_id::text, rol::text from membership`,
      );
      return res.rows;
    });
    // Necesita ver la suya para que el login sepa a qué barrio entra y con qué rol.
    expect(filas).toEqual([{ user_id: arbol.usuarios.propietarioA1, rol: "propietario" }]);
  });

  it("un propietario tampoco ve las cesiones de visibilidad entre tenants", async () => {
    await admin.query(
      `insert into tenant_grant (origen_id, destino_id, alcance, motivo, otorgado_por)
       values ($1,$2,'lectura','prueba',$3)`,
      [arbol.barrioA1.id, arbol.barrioA2.id, arbol.usuarios.adminEstudioA],
    );
    try {
      expect(await filasVisibles(arbol.usuarios.propietarioA1, "tenant_grant")).toBe(0);
      expect(await filasVisibles(arbol.usuarios.adminBarrioA1, "tenant_grant")).toBe(1);
    } finally {
      await admin.query("delete from tenant_grant where origen_id = $1", [arbol.barrioA1.id]);
    }
  });

  it("sigue viendo el NODO de su barrio: sin eso el portal del residente no sabe ni dónde está", async () => {
    const nombres = await conUsuario(db, arbol.usuarios.propietarioA1, async (tx) => {
      const res = await tx.execute<{ nombre: string }>(sql`select nombre from tenant_node order by nombre`);
      return res.rows.map((f) => f.nombre);
    });
    expect(nombres).toEqual(["Los Álamos", "Náutica interna"]);
  });
});

// -------------------------------------------------------------------------------------------
// Lo que NO se rompió: los roles de gestión siguen trabajando.
// -------------------------------------------------------------------------------------------
describe("los roles de gestión siguen leyendo lo suyo", () => {
  for (const rol of ["adminEstudioA", "adminBarrioA1", "operadorA1", "contadorA1", "auditorA1"] as const) {
    it(`${rol} lee el padrón y las liquidaciones de A1`, async () => {
      expect(await filasVisibles(arbol.usuarios[rol], "unidad_funcional")).toBeGreaterThanOrEqual(
        unidadesA1.length,
      );
      expect(await filasVisibles(arbol.usuarios[rol], "obligado")).toBeGreaterThan(0);
      expect(await filasVisibles(arbol.usuarios[rol], "liquidacion")).toBe(1);
      expect(await filasVisibles(arbol.usuarios[rol], "item_liquidacion")).toBe(1);
    });
  }

  it("una membresía de gestión DESACTIVADA no lee nada", async () => {
    // `inactivoA1` es `operador` con activo = false: el rol correcto no alcanza.
    expect(await filasVisibles(arbol.usuarios.inactivoA1, "obligado")).toBe(0);
    expect(await filasVisibles(arbol.usuarios.inactivoA1, "liquidacion")).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// El aislamiento entre barrios hermanos, que ya funcionaba, sigue en pie.
// -------------------------------------------------------------------------------------------
describe("el aislamiento entre barrios hermanos no se aflojó", () => {
  it("el operador de A1 no ve el padrón de A2, aunque sean del mismo estudio", async () => {
    const propias = await conUsuario(db, arbol.usuarios.operadorA1, async (tx) => {
      const res = await tx.execute<{ barrio_id: string }>(sql`select distinct barrio_id from unidad_funcional`);
      return res.rows.map((f) => f.barrio_id);
    });
    expect(propias).toEqual([arbol.barrioA1.id]);
  });

  it("el administrador del estudio A sí ve los dos barrios", async () => {
    await crearUnidades(admin, arbol.barrioA2.id, 2, "9");
    const barrios = await conUsuario(db, arbol.usuarios.adminEstudioA, async (tx) => {
      const res = await tx.execute<{ barrio_id: string }>(
        sql`select distinct barrio_id from unidad_funcional order by barrio_id`,
      );
      return res.rows.map((f) => f.barrio_id);
    });
    expect(barrios.sort()).toEqual([arbol.barrioA1.id, arbol.barrioA2.id].sort());
  });

  it("un estudio ajeno no ve nada", async () => {
    expect(await filasVisibles(arbol.usuarios.adminEstudioB, "obligado")).toBe(0);
    expect(await filasVisibles(arbol.usuarios.adminEstudioB, "liquidacion")).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// El candado estructural: se lee del catálogo, así que una tabla NUEVA sin gate también lo rompe.
// -------------------------------------------------------------------------------------------
describe("ninguna tabla con datos de barrio queda sin gate de rol", () => {
  it("toda policy de SELECT sobre una tabla con `barrio_id` usa app.readable_tenant_ids()", async () => {
    const { rows } = await admin.query<{ tabla: string; expresion: string }>(`
      select c.relname as tabla, pg_get_expr(p.polqual, p.polrelid) as expresion
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and p.polcmd = 'r'
         and exists (
           select 1 from pg_attribute a
            where a.attrelid = c.oid and a.attname = 'barrio_id' and a.attnum > 0 and not a.attisdropped
         )
         and pg_get_expr(p.polqual, p.polrelid) not like '%readable_tenant_ids%'
       order by c.relname
    `);
    // Si esto falla, alguien agregó una tabla de barrio con la policy vieja
    // (`barrio_id in (select app.accessible_tenant_ids())`), que NO mira el rol.
    expect(rows.map((f) => f.tabla)).toEqual([]);
  });

  it("toda tabla del esquema public tiene RLS habilitada y forzada", async () => {
    const { rows } = await admin.query<{ tabla: string }>(`
      select c.relname as tabla
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and not (c.relrowsecurity and c.relforcerowsecurity)
       order by c.relname
    `);
    expect(rows.map((f) => f.tabla)).toEqual([]);
  });

  it("la lista de roles de readable_tenant_ids() es exactamente la de gestión", async () => {
    const { rows } = await admin.query<{ def: string }>(
      "select pg_get_functiondef(to_regprocedure('app.readable_tenant_ids()')) as def",
    );
    // Se mira el ARRAY de roles, no el cuerpo entero: los comentarios del SQL nombran a
    // `propietario` justamente para explicar por qué está afuera.
    const lista = /array\[([^\]]*)\]::app\.rol_membership\[\]/.exec(rows[0]?.def ?? "")?.[1];
    const roles = (lista ?? "").split(",").map((r) => r.trim().replaceAll("'", ""));
    expect(roles).toEqual(["admin_plataforma", "admin_barrio", "operador", "contador", "auditor"]);
  });
});

// -------------------------------------------------------------------------------------------
// Mandatos de administración: quién firmaba el comprobante tiene que estar determinado.
// -------------------------------------------------------------------------------------------
describe("dos mandatos de administración no se pueden solapar", () => {
  const barrio = () => arbol.barrioA2.id;

  async function mandato(desde: string, hasta: string | null): Promise<void> {
    await admin.query(
      "insert into mandato_administracion (barrio_id, administrador_id, desde, hasta) values ($1,$2,$3,$4)",
      [barrio(), arbol.adminA.id, desde, hasta],
    );
  }

  beforeAll(async () => {
    await admin.query("delete from mandato_administracion where barrio_id = $1", [barrio()]);
    await mandato("2024-01-01", "2025-01-01");
  });

  it("el traspaso normal entra: `hasta` del saliente = `desde` del entrante", async () => {
    await expect(mandato("2025-01-01", "2026-01-01")).resolves.toBeUndefined();
  });

  it("dos mandatos CERRADOS que se pisan los rechaza la base", async () => {
    await expect(mandato("2024-06-01", "2024-09-01")).rejects.toThrow(/mandato_sin_solape/);
  });

  it("un mandato que envuelve a otro también", async () => {
    await expect(mandato("2023-01-01", "2027-01-01")).rejects.toThrow(/mandato_sin_solape/);
  });

  it("un mandato de duración cero no entra (sería un rango vacío que se cuela por debajo)", async () => {
    await expect(mandato("2030-01-01", "2030-01-01")).rejects.toThrow(/mandato_rango_no_vacio_chk/);
  });

  it("un mandato cerrado que pisa al abierto lo rechaza la base", async () => {
    await admin.query(
      "insert into mandato_administracion (barrio_id, administrador_id, desde) values ($1,$2,'2026-01-01')",
      [barrio(), arbol.adminA.id],
    );
    await expect(mandato("2026-06-01", "2026-08-01")).rejects.toThrow(/mandato_sin_solape/);
  });

  it("y dos abiertos siguen sin poder existir", async () => {
    await expect(
      admin.query(
        "insert into mandato_administracion (barrio_id, administrador_id, desde) values ($1,$2,'2028-01-01')",
        [barrio(), arbol.adminA.id],
      ),
    ).rejects.toThrow(/uq_mandato_vigente|mandato_sin_solape/);
  });
});
