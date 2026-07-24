/**
 * El test más importante de la fundación: que un barrio NO vea a otro.
 *
 * Todo corre contra Postgres real (`pnpm db:up && pnpm db:migrate && pnpm db:setup`), con la misma
 * conexión sujeta a RLS que va a usar la app. Ver docs/diseno/03-modelo-datos.md §A.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { conUsuario, sinUsuario, type Db } from "../src/client.ts";
import { borrarArbol, crearArbol, dbDe, poolAdmin, poolApp, poolJob, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let jobPool: pg.Pool;
let db: Db;
let dbJob: Db;
let arbol: Arbol;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  jobPool = poolJob();
  db = dbDe(appPool);
  dbJob = dbDe(jobPool);
  arbol = await crearArbol(admin);
});

afterAll(async () => {
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end(), jobPool.end()]);
});

/** Nombres de los nodos que el usuario puede ver, ordenados. */
async function nodosVisibles(userId: string): Promise<string[]> {
  return conUsuario(db, userId, async (tx) => {
    const res = await tx.execute<{ nombre: string }>(sql`select nombre from tenant_node order by path`);
    return res.rows.map((r) => r.nombre);
  });
}

describe("lectura — aislamiento entre tenants", () => {
  it("sin identidad no se ve NADA (default deny)", async () => {
    const filas = await sinUsuario(db, async (tx) => {
      const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from tenant_node`);
      return res.rows[0]?.n;
    });
    expect(filas).toBe("0");
  });

  it("un usuario sin membresías no ve nada", async () => {
    expect(await nodosVisibles(arbol.usuarios.sinMembresia)).toEqual([]);
  });

  it("el usuario del ADMINISTRADOR ve todos sus barrios (herencia por subárbol)", async () => {
    const visibles = await nodosVisibles(arbol.usuarios.adminEstudioA);
    expect(visibles).toEqual(["Estudio Pérez", "Los Álamos", "Náutica interna", "San Isidro"]);
  });

  it("el usuario de UN BARRIO ve su barrio y sus subsectores, y nada más", async () => {
    const visibles = await nodosVisibles(arbol.usuarios.adminBarrioA1);
    expect(visibles).toEqual(["Los Álamos", "Náutica interna"]);
  });

  it("los barrios HERMANOS jamás se ven entre sí", async () => {
    const visibles = await nodosVisibles(arbol.usuarios.adminBarrioA1);
    expect(visibles).not.toContain("San Isidro");
  });

  it("no se ve hacia arriba: el barrio no ve al administrador que lo contiene", async () => {
    const visibles = await nodosVisibles(arbol.usuarios.adminBarrioA1);
    expect(visibles).not.toContain("Estudio Pérez");
  });

  it("administradores distintos no se ven entre sí", async () => {
    const deB = await nodosVisibles(arbol.usuarios.adminEstudioB);
    expect(deB).toEqual(["Otro Estudio", "Las Lomas"]);
    const deA = await nodosVisibles(arbol.usuarios.adminEstudioA);
    expect(deA).not.toContain("Las Lomas");
  });

  it("una membresía dada de baja (activo = false) no da acceso", async () => {
    expect(await nodosVisibles(arbol.usuarios.inactivoA1)).toEqual([]);
  });

  it("un tenant con soft-delete deja de ser accesible", async () => {
    await admin.query("update tenant_node set deleted_at = now() where id = $1", [arbol.subsectorA1.id]);
    try {
      expect(await nodosVisibles(arbol.usuarios.adminBarrioA1)).toEqual(["Los Álamos"]);
    } finally {
      await admin.query("update tenant_node set deleted_at = null where id = $1", [arbol.subsectorA1.id]);
    }
  });

  it("las membresías ajenas tampoco se ven", async () => {
    const cuantas = await conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
      const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from membership`);
      return res.rows[0]?.n;
    });
    // Solo las de su propio subárbol: admin_barrio + propietario + la inactiva de A1.
    expect(cuantas).toBe("3");
  });
});

describe("el bug clásico del prefijo: 1.7 no es ancestro de 1.70", () => {
  it("no filtra datos de un tenant cuyo path empieza igual", async () => {
    // Se fuerzan los paths (el trigger asigna nids correlativos, que no permiten armar el caso).
    const { rows: r1 } = await admin.query<{ id: string }>(
      "insert into tenant_node (tipo, nombre) values ('administrador', 'Prefijo 7') returning id",
    );
    const { rows: r2 } = await admin.query<{ id: string }>(
      "insert into tenant_node (tipo, nombre) values ('administrador', 'Prefijo 70') returning id",
    );
    const idSiete = r1[0]?.id;
    const idSetenta = r2[0]?.id;
    expect(idSiete && idSetenta).toBeTruthy();

    await admin.query("update tenant_node set path = '7' where id = $1", [idSiete]);
    await admin.query("update tenant_node set path = '70' where id = $1", [idSetenta]);

    const usuario = crypto.randomUUID();
    await admin.query("insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'admin_barrio')", [
      usuario,
      idSiete,
    ]);

    try {
      expect(await nodosVisibles(usuario)).toEqual(["Prefijo 7"]);
    } finally {
      await admin.query("delete from membership where user_id = $1", [usuario]);
      await admin.query("delete from tenant_node where id = any($1::uuid[])", [[idSiete, idSetenta]]);
    }
  });
});

describe("escritura — permiso por rol sobre el subárbol", () => {
  it("un admin de barrio puede crear un subsector dentro de SU barrio", async () => {
    const creado = await conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
      const res = await tx.execute<{ id: string; path: string }>(sql`
        insert into tenant_node (tipo, nombre, parent_id)
        values ('subsector', 'Cancha de tenis', ${arbol.barrioA1.id})
        returning id, path
      `);
      return res.rows[0];
    });
    expect(creado?.path).toBe(`${arbol.barrioA1.path}.${creado?.path.split(".").pop()}`);
    expect(creado?.path.startsWith(`${arbol.barrioA1.path}.`)).toBe(true);
    await admin.query("delete from tenant_node where id = $1", [creado?.id]);
  });

  it("NO puede crear nada colgado del barrio hermano", async () => {
    // Falla en el trigger de path ("parent_id inexistente") antes que en la policy: el trigger lee
    // `tenant_node` sujeto a RLS, así que para este usuario el barrio hermano LITERALMENTE no
    // existe. Es el comportamiento deseado — el sistema no confirma la existencia de un tenant ajeno.
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
        await tx.execute(sql`
          insert into tenant_node (tipo, nombre, parent_id)
          values ('subsector', 'Intruso', ${arbol.barrioA2.id})
        `);
      }),
    ).rejects.toThrow(/row-level security|inexistente/i);

    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from tenant_node where nombre = 'Intruso'",
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("un propietario no puede crear nodos", async () => {
    await expect(
      conUsuario(db, arbol.usuarios.propietarioA1, async (tx) => {
        await tx.execute(sql`
          insert into tenant_node (tipo, nombre, parent_id)
          values ('subsector', 'Propietario colado', ${arbol.barrioA1.id})
        `);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("un propietario no puede darse a sí mismo un rol administrativo", async () => {
    await expect(
      conUsuario(db, arbol.usuarios.propietarioA1, async (tx) => {
        await tx.execute(sql`
          insert into membership (user_id, tenant_node_id, rol)
          values (${arbol.usuarios.propietarioA1}::uuid, ${arbol.barrioA1.id}, 'admin_barrio')
        `);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("un admin de barrio no puede renombrar el barrio hermano", async () => {
    const afectadas = await conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
      const res = await tx.execute(sql`
        update tenant_node set nombre = 'Robado' where id = ${arbol.barrioA2.id}
      `);
      return res.rowCount;
    });
    expect(afectadas).toBe(0);
    const { rows } = await admin.query<{ nombre: string }>("select nombre from tenant_node where id = $1", [
      arbol.barrioA2.id,
    ]);
    expect(rows[0]?.nombre).toBe("San Isidro");
  });

  it("nadie borra un tenant desde la app: la baja es lógica (deleted_at)", async () => {
    // Doble candado: el rol de request no tiene privilegio de DELETE y, además, no hay policy de
    // DELETE. Alcanza con que falle el primero para que el dato financiero no se pueda evaporar.
    await expect(
      conUsuario(db, arbol.usuarios.adminEstudioA, async (tx) => {
        await tx.execute(sql`delete from tenant_node where id = ${arbol.subsectorA1.id}`);
      }),
    ).rejects.toThrow(/permission denied|row-level security/i);

    const { rows } = await admin.query<{ n: string }>("select count(*)::text as n from tenant_node where id = $1", [
      arbol.subsectorA1.id,
    ]);
    expect(rows[0]?.n).toBe("1");
  });
});

describe("excepción de aislamiento auditada (tenant_grant, art. 2084)", () => {
  it("la ven las dos puntas y nadie más", async () => {
    await admin.query(
      `insert into tenant_grant (origen_id, destino_id, alcance, motivo, otorgado_por)
       values ($1, $2, 'servidumbre:lectura_expensas', 'Servidumbre de paso entre conjuntos', $3)`,
      [arbol.barrioA1.id, arbol.barrioB1.id, arbol.usuarios.adminEstudioA],
    );
    try {
      const contar = async (userId: string) =>
        conUsuario(db, userId, async (tx) => {
          const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from tenant_grant`);
          return res.rows[0]?.n;
        });

      expect(await contar(arbol.usuarios.adminBarrioA1)).toBe("1"); // origen
      expect(await contar(arbol.usuarios.adminEstudioB)).toBe("1"); // destino
      expect(await contar(arbol.usuarios.sinMembresia)).toBe("0"); // tercero
    } finally {
      await admin.query("delete from tenant_grant");
    }
  });
});

describe("rol de jobs (BYPASSRLS)", () => {
  it("ve todo el árbol, sin identidad de usuario — por eso nunca atiende un request", async () => {
    const res = await dbJob.execute<{ n: string }>(sql`select count(*)::text as n from tenant_node`);
    expect(Number(res.rows[0]?.n)).toBeGreaterThanOrEqual(6);
  });
});

describe("re-parentado de un subárbol", () => {
  it("reescribe el path de todos los descendientes y NO cambia los ids", async () => {
    const { rows } = await admin.query<{ id: string; path: string }>(
      "insert into tenant_node (tipo, nombre, parent_id) values ('subsector', 'Muelle', $1) returning id, path",
      [arbol.subsectorA1.id],
    );
    const nieto = rows[0];
    expect(nieto?.path.startsWith(`${arbol.subsectorA1.path}.`)).toBe(true);

    try {
      // La operación cara se hace con el rol de jobs, en transacción (doc 03 §A.9.1).
      await dbJob.execute(sql`
        update tenant_node set parent_id = ${arbol.barrioA2.id} where id = ${arbol.subsectorA1.id}
      `);

      const { rows: despues } = await admin.query<{ id: string; path: string }>(
        "select id, path from tenant_node where id = any($1::uuid[]) order by path",
        [[arbol.subsectorA1.id, nieto?.id]],
      );
      const pathSub = despues.find((f) => f.id === arbol.subsectorA1.id)?.path ?? "";
      const pathNieto = despues.find((f) => f.id === nieto?.id)?.path ?? "";

      expect(pathSub.startsWith(`${arbol.barrioA2.path}.`)).toBe(true);
      expect(pathNieto.startsWith(`${pathSub}.`)).toBe(true);

      // Y el acceso sigue el árbol nuevo: A1 ya no lo ve, A2 sí (vía el administrador).
      expect(await nodosVisibles(arbol.usuarios.adminBarrioA1)).toEqual(["Los Álamos"]);
    } finally {
      await dbJob.execute(sql`
        update tenant_node set parent_id = ${arbol.barrioA1.id} where id = ${arbol.subsectorA1.id}
      `);
      await admin.query("delete from tenant_node where id = $1", [nieto?.id]);
    }
  });

  it("rechaza colgar un nodo de su propio subárbol (ciclo)", async () => {
    await expect(
      dbJob.execute(sql`
        update tenant_node set parent_id = ${arbol.subsectorA1.id} where id = ${arbol.barrioA1.id}
      `),
    ).rejects.toThrow(/ciclo/i);
  });
});
