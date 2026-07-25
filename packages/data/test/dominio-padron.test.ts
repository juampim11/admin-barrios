/**
 * El padrón del barrio contra Postgres real: aislamiento, reglas del CCyC que hace cumplir la base
 * (unidades baldías, obligados múltiples, coeficientes que cuadran) y vigencia de los 5 ejes.
 *
 * Ver `docs/diseno/03-modelo-datos.md` §B y `knowledge/cordoba/REQUISITOS-MODELO-DATOS.md` §1/§3.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { conUsuario, type DbJob, type DbRequest } from "../src/client.ts";
import {
  borrarArbol,
  crearArbol,
  crearBarrio,
  crearCoeficientes,
  crearUnidades,
  dbDe,
  dbDeJob,
  poolAdmin,
  poolApp,
  poolJob,
  type Arbol,
} from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let jobPool: pg.Pool;
let db: DbRequest;
let dbJob: DbJob;
let arbol: Arbol;
let unidadesA1: string[];
let unidadesA2: string[];

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  jobPool = poolJob();
  db = dbDe(appPool);
  dbJob = dbDeJob(jobPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id, { figuraJuridica: "ph_especial", municipio: "villa-allende" });
  await crearBarrio(admin, arbol.barrioA2.id, { figuraJuridica: "sa", municipio: "la-calera" });
  unidadesA1 = await crearUnidades(admin, arbol.barrioA1.id, 6);
  unidadesA2 = await crearUnidades(admin, arbol.barrioA2.id, 3);
});

afterAll(async () => {
  // De hijo a padre: el padrón referencia al barrio, y el barrio al nodo de tenancía.
  for (const tabla of [
    "coeficiente",
    "coeficiente_version",
    "unidad_obligado",
    "unidad_contacto",
    "obligado",
    "unidad_funcional",
    "mandato_administracion",
    "barrio_atributo_vigencia",
    "documento_barrio",
    "barrio",
  ]) {
    await admin.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [
      [arbol.barrioA1.id, arbol.barrioA2.id],
    ]);
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end(), jobPool.end()]);
});

describe("aislamiento del padrón entre barrios", () => {
  it("el usuario de un barrio ve solo SUS unidades", async () => {
    const filas = await conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
      const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from unidad_funcional`);
      return res.rows[0]?.n;
    });
    expect(filas).toBe(String(unidadesA1.length));
  });

  it("el usuario del administrador ve las de todos sus barrios", async () => {
    const filas = await conUsuario(db, arbol.usuarios.adminEstudioA, async (tx) => {
      const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from unidad_funcional`);
      return res.rows[0]?.n;
    });
    expect(filas).toBe(String(unidadesA1.length + unidadesA2.length));
  });

  it("un administrador ajeno no ve nada del padrón", async () => {
    const filas = await conUsuario(db, arbol.usuarios.adminEstudioB, async (tx) => {
      const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from unidad_funcional`);
      return res.rows[0]?.n;
    });
    expect(filas).toBe("0");
  });

  it("un propietario lee el padrón pero no lo escribe", async () => {
    const lee = await conUsuario(db, arbol.usuarios.propietarioA1, async (tx) => {
      const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from unidad_funcional`);
      return res.rows[0]?.n;
    });
    expect(lee).toBe(String(unidadesA1.length));

    await expect(
      conUsuario(db, arbol.usuarios.propietarioA1, async (tx) => {
        await tx.execute(sql`
          insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
          values (${arbol.barrioA1.id}, 'X', '99', 'construido')
        `);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("las FKs compuestas impiden mezclar datos de dos barrios (ni siquiera con el rol de jobs)", async () => {
    // El rol de jobs saltea la RLS: sin la FK (id, barrio_id) esto pasaría desapercibido.
    const { rows } = await admin.query<{ id: string }>(
      `insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1,'parte_indivisa',current_date) returning id`,
      [arbol.barrioA1.id],
    );
    const version = rows[0]?.id;
    await expect(
      dbJob.execute(sql`
        insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor)
        values (${arbol.barrioA1.id}, ${version}, ${unidadesA2[0]}, '0.5')
      `),
    ).rejects.toThrow(/foreign key|fk_coef_uf_barrio/i);
    await admin.query("delete from coeficiente_version where id = $1", [version]);
  });
});

describe("unidades funcionales", () => {
  it("manzana/lote es único DENTRO del barrio, no entre barrios", async () => {
    // El mismo 'MZ 1 - LOTE 1' existe en los dos barrios del fixture: eso es válido.
    // (Se acota a esos dos barrios: la base puede tener además el barrio del modo demo.)
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from unidad_funcional where manzana = '1' and lote = '1' and barrio_id = any($1::uuid[])",
      [[arbol.barrioA1.id, arbol.barrioA2.id]],
    );
    expect(Number(rows[0]?.n)).toBe(2);

    await expect(
      admin.query(
        `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1,'1','1','construido')`,
        [arbol.barrioA1.id],
      ),
    ).rejects.toThrow(/uq_uf_barrio_manzana_lote|duplicate key/i);
  });

  it("una unidad baldía integra el padrón (art. 2077)", async () => {
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from unidad_funcional where barrio_id = $1 and estado_unidad = 'baldio'",
      [arbol.barrioA1.id],
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  it("un email de contacto mal formado se rechaza", async () => {
    await expect(
      admin.query(
        `insert into unidad_contacto (barrio_id, unidad_funcional_id, email) values ($1,$2,'no-es-un-mail')`,
        [arbol.barrioA1.id, unidadesA1[0]],
      ),
    ).rejects.toThrow(/contacto_email_chk/i);
  });
});

describe("obligados: varios a la vez y con histórico (arts. 2049/2050)", () => {
  it("una unidad puede tener propietario y poseedor simultáneos, y el propietario no se libera", async () => {
    const crearObligado = async (nombre: string) => {
      const { rows } = await admin.query<{ id: string }>(
        `insert into obligado (barrio_id, nombre) values ($1,$2) returning id`,
        [arbol.barrioA1.id, nombre],
      );
      return rows[0]?.id as string;
    };
    const propietario = await crearObligado("Ana Propietaria");
    const poseedor = await crearObligado("Bruno Poseedor");
    const unidad = unidadesA1[0];

    await admin.query(
      `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
       values ($1,$2,$3,'propietario',current_date,true)`,
      [arbol.barrioA1.id, unidad, propietario],
    );
    await admin.query(
      `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde)
       values ($1,$2,$3,'poseedor',current_date)`,
      [arbol.barrioA1.id, unidad, poseedor],
    );

    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from unidad_obligado where unidad_funcional_id = $1 and hasta is null",
      [unidad],
    );
    expect(Number(rows[0]?.n)).toBe(2);
  });

  it("solo un obligado notificado vigente por unidad", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into obligado (barrio_id, nombre) values ($1,'Carla Otra') returning id`,
      [arbol.barrioA1.id],
    );
    await expect(
      admin.query(
        `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
         values ($1,$2,$3,'usufructuario',current_date,true)`,
        [arbol.barrioA1.id, unidadesA1[0], rows[0]?.id],
      ),
    ).rejects.toThrow(/uq_unidad_notificado|duplicate key/i);
  });

  it("al vender, el vínculo se cierra pero queda en el histórico (la deuda no se reinicia)", async () => {
    const unidad = unidadesA1[1];
    const { rows: v } = await admin.query<{ id: string }>(
      `insert into obligado (barrio_id, nombre) values ($1,'Vendedor') returning id`,
      [arbol.barrioA1.id],
    );
    const { rows: c } = await admin.query<{ id: string }>(
      `insert into obligado (barrio_id, nombre) values ($1,'Comprador') returning id`,
      [arbol.barrioA1.id],
    );
    await admin.query(
      `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde)
       values ($1,$2,$3,'propietario','2020-01-01')`,
      [arbol.barrioA1.id, unidad, v[0]?.id],
    );
    await admin.query("update unidad_obligado set hasta = current_date where unidad_funcional_id = $1", [unidad]);
    await admin.query(
      `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde)
       values ($1,$2,$3,'propietario',current_date)`,
      [arbol.barrioA1.id, unidad, c[0]?.id],
    );

    const { rows } = await admin.query<{ n: string; vigentes: string }>(
      `select count(*)::text as n, count(*) filter (where hasta is null)::text as vigentes
         from unidad_obligado where unidad_funcional_id = $1`,
      [unidad],
    );
    expect(rows[0]?.n).toBe("2"); // el histórico queda
    expect(rows[0]?.vigentes).toBe("1"); // pero hoy responde uno solo
  });
});

describe("coeficientes: no se cierra una versión que no cuadra", () => {
  it("rechaza cerrar si la suma no da 1 en base parte indivisa", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1,'parte_indivisa',current_date) returning id`,
      [arbol.barrioA2.id],
    );
    const version = rows[0]?.id as string;
    for (const unidad of unidadesA2) {
      await admin.query(
        `insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,'0.300000000')`,
        [arbol.barrioA2.id, version, unidad],
      );
    }
    await expect(
      admin.query("update coeficiente_version set cerrada = true where id = $1", [version]),
    ).rejects.toThrow(/no cuadran|sumar exactamente 1/i);
    await admin.query("delete from coeficiente_version where id = $1", [version]);
  });

  it("rechaza cerrar si falta el coeficiente de alguna unidad (incluidas las baldías)", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1,'parte_indivisa',current_date) returning id`,
      [arbol.barrioA2.id],
    );
    const version = rows[0]?.id as string;
    await admin.query(
      `insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,'1.000000000')`,
      [arbol.barrioA2.id, version, unidadesA2[0]],
    );
    await expect(
      admin.query("update coeficiente_version set cerrada = true where id = $1", [version]),
    ).rejects.toThrow(/faltan coeficientes/i);
    await admin.query("delete from coeficiente_version where id = $1", [version]);
  });

  it("cierra cuando cuadra, y después la versión no se toca más", async () => {
    const version = await crearCoeficientes(admin, arbol.barrioA1.id, unidadesA1);
    await admin.query("update coeficiente_version set cerrada = true where id = $1", [version]);

    const { rows } = await admin.query<{ cerrada: boolean; cerrada_at: string | null; suma: string }>(
      `select cv.cerrada, cv.cerrada_at, (select sum(valor)::text from coeficiente where version_id = cv.id) as suma
         from coeficiente_version cv where cv.id = $1`,
      [version],
    );
    expect(rows[0]?.cerrada).toBe(true);
    expect(rows[0]?.cerrada_at).not.toBeNull();
    expect(Number(rows[0]?.suma)).toBe(1);

    await expect(
      admin.query("update coeficiente set valor = '0.5' where version_id = $1", [version]),
    ).rejects.toThrow(/cerrada/i);
    await expect(
      admin.query("update coeficiente_version set cerrada = false where id = $1", [version]),
    ).rejects.toThrow(/no se reabre/i);
  });

  it("con base superficie no exige que sume 1 (el prorrateo usa pesos relativos, art. 2081)", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1,'superficie',current_date) returning id`,
      [arbol.barrioA2.id],
    );
    const version = rows[0]?.id as string;
    for (const [i, unidad] of unidadesA2.entries()) {
      await admin.query(
        `insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,$4)`,
        [arbol.barrioA2.id, version, unidad, String(300 + i * 50)],
      );
    }
    await admin.query("update coeficiente_version set cerrada = true where id = $1", [version]);
    const { rows: r } = await admin.query<{ cerrada: boolean }>(
      "select cerrada from coeficiente_version where id = $1",
      [version],
    );
    expect(r[0]?.cerrada).toBe(true);
  });
});

describe("los 5 ejes se versionan (la tabla manda, la columna es cache)", () => {
  it("dar de alta un barrio siembra las cinco vigencias", async () => {
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from barrio_atributo_vigencia where barrio_id = $1 and vigente_hasta is null",
      [arbol.barrioA1.id],
    );
    expect(rows[0]?.n).toBe("5");
  });

  it("un valor inválido para el eje se rechaza", async () => {
    await expect(
      admin.query(
        `insert into barrio_atributo_vigencia (barrio_id, eje, valor, vigente_desde)
         values ($1,'figura_juridica','sociedad_anonima_trucha',current_date)`,
        [arbol.barrioA1.id],
      ),
    ).rejects.toThrow(/invalid input value|figura_juridica/i);
  });

  it("una vigencia nueva cierra la anterior y actualiza el valor vigente del barrio", async () => {
    const barrioId = arbol.barrioA2.id;
    const { rows: antes } = await admin.query<{ adecuado_art_2075: string }>(
      "select adecuado_art_2075 from barrio where barrio_id = $1",
      [barrioId],
    );
    expect(antes[0]?.adecuado_art_2075).toBe("en_tramite");

    await admin.query(
      `insert into barrio_atributo_vigencia (barrio_id, eje, valor, vigente_desde)
       values ($1,'adecuado_art_2075','si',current_date)`,
      [barrioId],
    );

    const { rows: despues } = await admin.query<{ adecuado_art_2075: string }>(
      "select adecuado_art_2075 from barrio where barrio_id = $1",
      [barrioId],
    );
    expect(despues[0]?.adecuado_art_2075).toBe("si");

    const { rows: abiertas } = await admin.query<{ n: string }>(
      "select count(*)::text as n from barrio_atributo_vigencia where barrio_id = $1 and eje = 'adecuado_art_2075' and vigente_hasta is null",
      [barrioId],
    );
    expect(abiertas[0]?.n).toBe("1");
  });

  it("se puede preguntar qué regía en una fecha pasada (liquidar un período viejo)", async () => {
    const barrioId = arbol.barrioA2.id;
    // La vigencia sembrada al alta empieza HOY, así que ayer todavía no había nada: null.
    const { rows: ayer } = await admin.query<{ valor: string | null }>(
      "select app.valor_eje_vigente($1,'adecuado_art_2075', current_date - 1) as valor",
      [barrioId],
    );
    expect(ayer[0]?.valor).toBeNull();

    const { rows: hoy } = await admin.query<{ valor: string | null }>(
      "select app.valor_eje_vigente($1,'adecuado_art_2075', current_date) as valor",
      [barrioId],
    );
    expect(hoy[0]?.valor).toBe("si");
  });
});

describe("integridad barrio ↔ tenancía", () => {
  it("no se pueden cargar datos de barrio sobre el nodo de un administrador", async () => {
    await expect(
      crearBarrio(admin, arbol.adminA.id),
    ).rejects.toThrow(/tipo administrador|solo un nodo de tipo barrio/i);
  });
});
