/**
 * El candado del ADR-0002 §2.4, contra Postgres real.
 *
 * El §2.3 dice, textualmente, que "la lista se lee sin identidad y eso no es un agujero" **se
 * verifica, no se argumenta**. Este archivo es esa verificación: tres `select` sobre el catálogo de
 * Postgres —policy única, columnas exactas, cero grants de escritura— más el comportamiento con la
 * tabla vacía.
 *
 * Los tres primeros son los que importan a largo plazo: no prueban un caso, prueban una **propiedad
 * del esquema entero**, y por lo tanto fallan también cuando el agujero lo abre una migración
 * futura que hoy no existe.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  conUsuario,
  crearDbMantenimiento,
  sinUsuario,
  verificarConexionSujetaARls,
  type DbJob,
  type DbRequest,
} from "../src/client.ts";
import { dbDe, dbDeJob, poolAdmin, poolApp, poolJob } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let jobPool: pg.Pool;
let db: DbRequest;
let dbJob: DbJob;

/** Personaje de prueba propio: no se toca el elenco que haya dejado el seed. */
const PRUEBA = {
  id: randomUUID(),
  email: `elenco-de-prueba-${randomUUID()}@ejemplo.test`,
  nombre: "Personaje de prueba",
  descripcion: "creado por usuario-demo.test.ts",
};

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  jobPool = poolJob();
  db = dbDe(appPool);
  dbJob = dbDeJob(jobPool);
});

afterAll(async () => {
  await admin.query("delete from usuario_demo where user_id = $1", [PRUEBA.id]);
  await Promise.all([admin.end(), appPool.end(), jobPool.end()]);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Las tres propiedades del esquema (§2.3)
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("propiedades del esquema que sostienen el candado", () => {
  it("(a) `usuario_demo_sel` es la ÚNICA policy permisiva con `qual = 'true'` de todo el esquema", async () => {
    // Este test es el que más vale del archivo: si mañana alguien abre otra tabla "porque es
    // pública", falla acá y no en una filtración. `permissive = 'PERMISSIVE'` importa porque una
    // policy RESTRICTIVE con `true` no abre nada, solo no restringe.
    const { rows } = await admin.query<{ tablename: string; policyname: string }>(`
      select tablename, policyname
        from pg_policies
       where schemaname = 'public'
         and permissive = 'PERMISSIVE'
         and cmd in ('SELECT', 'ALL')
         and coalesce(btrim(qual), '') = 'true'
       order by tablename, policyname
    `);
    expect(rows.map((r) => `${r.tablename}.${r.policyname}`)).toEqual(["usuario_demo.usuario_demo_sel"]);
  });

  it("(b) las columnas son exactamente las cinco del elenco: ni PII real, ni dinero, ni nada de un barrio", async () => {
    const { rows } = await admin.query<{ column_name: string }>(`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'usuario_demo'
       order by column_name
    `);
    expect(rows.map((r) => r.column_name)).toEqual([
      "creado_at",
      "descripcion",
      "email",
      "nombre",
      "user_id",
    ]);
  });

  it("(c) ningún rol de la app puede ESCRIBIR: ni `app_request` ni `app_job`", async () => {
    const { rows } = await admin.query<{ grantee: string; privilege_type: string }>(`
      select grantee, privilege_type
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'usuario_demo'
         and grantee in ('app_request', 'app_job')
       order by grantee, privilege_type
    `);
    // `app_request` solo lee; `app_job` no aparece en absoluto. Este último importa SOLO por el
    // grant: tiene BYPASSRLS, así que la policy nunca lo va a tocar y el grant es el único control.
    expect(rows).toEqual([{ grantee: "app_request", privilege_type: "SELECT" }]);
  });

  it("la tabla tiene RLS habilitada Y forzada, como todo el resto del esquema", async () => {
    const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'usuario_demo'",
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Comportamiento
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("lectura sin identidad (la pantalla de entrada)", () => {
  it("se lee SIN usuario, que es todo el punto: es el huevo y la gallina del login", async () => {
    await admin.query(
      "insert into usuario_demo (user_id, email, nombre, descripcion) values ($1,$2,$3,$4)",
      [PRUEBA.id, PRUEBA.email, PRUEBA.nombre, PRUEBA.descripcion],
    );

    const filas = await sinUsuario(db, async (tx) => {
      const r = await tx.execute<{ user_id: string }>(
        sql`select user_id from usuario_demo where user_id = ${PRUEBA.id}`,
      );
      return r.rows;
    });
    expect(filas).toHaveLength(1);
  });

  it("sin identidad NO se lee ninguna otra tabla: la excepción es de una tabla, no un modo", async () => {
    // Es lo que hace que `conIngreso()` sea seguro: corre sin identidad, pero sobre una conexión que
    // sigue sujeta a RLS. La única policy `using (true)` es la de arriba.
    const cuentas = await sinUsuario(db, async (tx) => {
      const r = await tx.execute<{ unidades: string; barrios: string; liquidaciones: string }>(sql`
        select (select count(*) from unidad_funcional)::text as unidades,
               (select count(*) from barrio)::text as barrios,
               (select count(*) from liquidacion)::text as liquidaciones
      `);
      return r.rows[0];
    });
    expect(cuentas).toEqual({ unidades: "0", barrios: "0", liquidaciones: "0" });
  });
});

describe("el rol de la app no puede tocar el elenco", () => {
  it("`app_request` no puede insertar, ni actualizar, ni borrar", async () => {
    const usuarioCualquiera = randomUUID();
    for (const sentencia of [
      sql`insert into usuario_demo (user_id, email, nombre, descripcion)
          values (${randomUUID()}, 'colado@ejemplo.test', 'Colado', 'no debería entrar')`,
      sql`update usuario_demo set nombre = 'Otro' where user_id = ${PRUEBA.id}`,
      sql`delete from usuario_demo where user_id = ${PRUEBA.id}`,
    ]) {
      await expect(
        conUsuario(db, usuarioCualquiera, (tx) => tx.execute(sentencia)),
        // Rebota por el grant (`permission denied`) antes incluso de llegar a la policy.
      ).rejects.toThrow(/permission denied|row-level security/i);
    }
  });

  it("`app_job` (BYPASSRLS) tampoco: para él el grant es el único control, y no lo tiene", async () => {
    // Este es el caso que un test escrito solo sobre policies se perdería: `app_job` saltea la RLS
    // por definición, así que lo único que lo frena es no tener el grant.
    await expect(dbJob.execute(sql`select count(*) from usuario_demo`)).rejects.toThrow(/permission denied/i);
    await expect(
      dbJob.execute(sql`insert into usuario_demo (user_id, email, nombre, descripcion)
                        values (${randomUUID()}, 'job@ejemplo.test', 'Job', 'no')`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("la conexión de la web está de verdad sujeta a la RLS", () => {
  /**
   * El hueco que ningún otro cerrojo tapa: los controles de `tools/infra/credenciales.ts` y de
   * `configuracion.ts` verifican **nombres de variable**, no privilegios. Un DSN de superusuario
   * puesto en `DATABASE_URL_APP` pasa los cinco cerrojos —el nombre de la variable es el correcto— y
   * el resultado no es un error sino algo peor: las policies dejan de evaluarse y todos los barrios
   * se le sirven a todos los usuarios, en silencio.
   */
  it("acepta el rol de request, que es el que corresponde", async () => {
    await expect(verificarConexionSujetaARls(db)).resolves.toBeUndefined();
  });

  it("RECHAZA la conexión del dueño del esquema, que es superusuario en la base local", async () => {
    // `DATABASE_URL` es la del dueño/superusuario: exactamente la que no tiene que llegar a la web.
    // Que el chequeo la rechace es lo que hace que la aserción de arranque valga algo.
    const dueno = crearDbMantenimiento(admin);
    await expect(verificarConexionSujetaARls(dueno)).rejects.toThrow(
      /SUPERUSUARIO|BYPASSRLS/,
    );
  });

  it("RECHAZA la conexión de jobs, que tiene BYPASSRLS", async () => {
    // El doble casteo es a propósito: el tipo prohíbe pasar `DbJob` acá, y por eso hay que forzarlo
    // para poder probar que, si alguien igual lo lograra por configuración, la base lo delata.
    const comoSiFuera = dbJob as unknown as DbRequest;
    await expect(verificarConexionSujetaARls(comoSiFuera)).rejects.toThrow(/BYPASSRLS/);
  });
});

describe("la precondición de seguridad del ADR-0002 §3.5", () => {
  /**
   * El ADR §3.5 punto 2 pide, textual, `select count(*) from membership where rol in
   * ('propietario','residente')` = 0. Eso **no se puede verificar tal cual** en esta base, y decirlo
   * es más honesto que escribir un test que no mide lo que dice: los fixtures de los otros archivos
   * de test crean justamente esas membresías, a propósito, para probar que no leen ni una fila
   * (`rls-lectura-por-rol.test.ts`). Si el gate exigiera cero global, o borrábamos esos tests o
   * borrábamos este.
   *
   * Lo que sí es la precondición real —y lo que el ADR quiere decir— son dos afirmaciones, y van
   * como dos casos separados: nadie del **elenco** los tiene (nadie entra con ese rol), y el
   * **seed** no los siembra (el barrio de demo no tiene vecinos con acceso).
   */
  it("nadie del elenco tiene rol propietario ni residente: no se entra al producto con ese rol", async () => {
    const { rows } = await admin.query<{ n: string }>(`
      select count(*)::text as n
        from membership m
        join usuario_demo u on u.user_id = m.user_id
       where m.rol in ('propietario', 'residente')
    `);
    expect(rows[0]?.n).toBe("0");
  });

  it("el seed no siembra ninguna membresía propietario/residente en el árbol de la demo", async () => {
    // Se acota al subárbol del administrador de demo por `path`, que es como se recorre la tenancía
    // en todo el esquema. Si el seed no corrió, no hay filas y el test pasa por vacío — correcto:
    // lo que se prohíbe es que el seed las cree, no que la base las tenga por un fixture.
    const { rows } = await admin.query<{ rol: string; nodo: string }>(`
      select m.rol::text as rol, n.nombre as nodo
        from membership m
        join tenant_node n on n.id = m.tenant_node_id
        join tenant_node raiz
          on raiz.tipo = 'administrador'
         and raiz.nombre = 'Estudio Demo — Administración'
         and (n.path = raiz.path or n.path like raiz.path || '.%')
       where m.rol in ('propietario', 'residente')
    `);
    // El día que alguien siembre un propietario "para ver cómo se ve", esto lo nombra y falla el
    // gate. Ver el comentario del elenco en `seed-demo.ts`.
    expect(rows).toEqual([]);
  });
});
