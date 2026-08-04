/**
 * La cuota fija contra Postgres real: definirla, ajustarla por porcentaje, y lo que el sistema se
 * niega a hacer.
 *
 * Lo que se prueba acá y no se puede probar con una función pura:
 *  - que el trigger cierre la versión anterior (nadie hace el `update` desde la app);
 *  - que el porcentaje se aplique **unidad por unidad**, incluso con importes distintos;
 *  - que un rol de solo lectura no pueda definir la cuota (RLS);
 *  - que el ajuste porcentual se **rechace** en vez de inventarle una base a una unidad sin cuota.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { cuotaFijaVigente, definirCuotaFija } from "../src/servicios/cuota-fija.ts";
import {
  borrarArbol,
  crearArbol,
  crearBarrio,
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
let barrioId: string;
let unidades: string[];

/** El mes que viene (`YYYY-MM`), calculado por la misma base (nunca `new Date()`). */
async function proximoMes(): Promise<string> {
  const { rows } = await admin.query<{ d: string }>(
    "select to_char(date_trunc('month', current_date) + interval '1 month', 'YYYY-MM') as d",
  );
  return rows[0]!.d;
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  barrioId = arbol.barrioA1.id;
  await crearBarrio(admin, barrioId);
  unidades = await crearUnidades(admin, barrioId, 5);
});

afterAll(async () => {
  // De hijo a padre: `crearBarrio` deja vigencias de atributos que apuntan al barrio.
  for (const tabla of [
    "cuota_fija",
    "cuota_fija_version",
    "unidad_funcional",
    "barrio_atributo_vigencia",
    "barrio",
  ]) {
    await admin.query(`delete from ${tabla} where barrio_id = $1`, [barrioId]);
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

beforeEach(async () => {
  await admin.query("delete from cuota_fija where barrio_id = $1", [barrioId]);
  await admin.query("delete from cuota_fija_version where barrio_id = $1", [barrioId]);
});

describe("definir la cuota por importe", () => {
  it("le pone el mismo importe a todas las unidades activas y las relee", async () => {
    const escrita = await conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
      definirCuotaFija(tx, {
        barrioId,
        rigeDesde: "2026-08",
        descripcion: "Acta de directorio 112",
        forma: "importe",
        importe: "372000.00",
      }),
    );

    expect(escrita.unidades).toBe(5);
    expect(escrita.importeUnico).toBe("372000.00");
    expect(escrita.totalMensual).toBe("1860000.00");
  });

  it("una unidad dada de baja no paga y no entra en el total", async () => {
    await admin.query("update unidad_funcional set baja_at = now() where id = $1", [unidades[0]]);

    const escrita = await conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
      definirCuotaFija(tx, {
        barrioId,
        rigeDesde: "2026-08",
        descripcion: null,
        forma: "importe",
        importe: "100000.00",
      }),
    );
    expect(escrita.unidades).toBe(4);
    expect(escrita.totalMensual).toBe("400000.00");

    await admin.query("update unidad_funcional set baja_at = null where id = $1", [unidades[0]]);
  });
});

describe("ajustar la cuota por porcentaje", () => {
  beforeEach(async () => {
    await conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
      definirCuotaFija(tx, {
        barrioId,
        rigeDesde: "2026-07",
        descripcion: "Cuota inicial",
        forma: "importe",
        importe: "372000.00",
      }),
    );
  });

  it("aplica el porcentaje, guarda la explicación y cierra la versión anterior", async () => {
    const escrita = await conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
      definirCuotaFija(tx, {
        barrioId,
        rigeDesde: "2026-08",
        descripcion: "Acta de directorio 113",
        forma: "porcentaje",
        porcentaje: "3.2",
        redondeo: "peso",
      }),
    );

    expect(escrita.importeUnico).toBe("383904.00");

    const { rows } = await admin.query<{
      ajuste_porcentaje: string;
      redondeo: string;
      vigente_hasta: string | null;
      anterior: string | null;
    }>(
      `select ajuste_porcentaje::text, redondeo, vigente_hasta::text, version_anterior_id::text as anterior
         from cuota_fija_version where barrio_id = $1 order by vigente_desde`,
      [barrioId],
    );

    // La vieja quedó cerrada por el trigger, con la fecha de la nueva. Nadie hizo ese `update`.
    expect(rows[0]?.vigente_hasta).toBe("2026-08-01");
    // El porcentaje y el redondeo quedaron guardados: sin ellos, el mes que viene nadie puede
    // contestar por qué la cuota cambió.
    expect(rows[1]?.ajuste_porcentaje).toBe("3.2000");
    expect(rows[1]?.redondeo).toBe("peso");
    // La nueva apunta a la vieja: es lo que permite rehacer la cuenta años después.
    expect(rows[1]?.anterior).toBe(await versionId(0));
  });

  it("con importes distintos por unidad, el porcentaje se aplica a CADA UNA", async () => {
    // El caso que la pantalla no puede promediar: una unidad con una quita acordada.
    await admin.query(
      `update cuota_fija set importe = 186000.00
         where barrio_id = $1 and unidad_funcional_id = $2`,
      [barrioId, unidades[0]],
    );

    await conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
      definirCuotaFija(tx, {
        barrioId,
        rigeDesde: "2026-08",
        descripcion: null,
        forma: "porcentaje",
        porcentaje: "10",
        redondeo: "peso",
      }),
    );

    const vigente = await conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
      cuotaFijaVigente(tx, barrioId),
    );
    const importes = [...vigente.cuotas].map((c) => c.importe).sort();
    // 186.000 → 204.600 y 372.000 → 409.200. Ninguna quedó emparejada con la otra.
    expect(importes).toEqual(["204600.00", "409200.00", "409200.00", "409200.00", "409200.00"]);
    expect(vigente.importeUnico).toBeNull();
  });

  it("se niega a ajustar por porcentaje si hay una unidad sin cuota", async () => {
    // Un alta posterior a la última versión. Inventarle una base —el importe único, el promedio— le
    // asignaría a una unidad real un importe que nadie decidió.
    const nuevas = await crearUnidades(admin, barrioId, 1, "9");

    await expect(
      conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
        definirCuotaFija(tx, {
          barrioId,
          rigeDesde: "2026-08",
          descripcion: null,
          forma: "porcentaje",
          porcentaje: "5",
          redondeo: "peso",
        }),
      ),
    ).rejects.toMatchObject({ codigo: "unidades_sin_cuota" });

    await admin.query("delete from unidad_funcional where id = $1", [nuevas[0]]);
  });
});

describe("los candados de la cuota", () => {
  beforeEach(async () => {
    await conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
      definirCuotaFija(tx, {
        barrioId,
        rigeDesde: "2026-07",
        descripcion: "Cuota inicial",
        forma: "importe",
        importe: "372000.00",
      }),
    );
  });

  it("dejar la cuota en cero pide confirmación explícita, y con ella entra", async () => {
    // Cero es un valor posible —un barrio puede suspender la cuota un mes— y también es lo que sale
    // de un campo mal tipeado. La diferencia la ve una persona, no el sistema.
    const sinConfirmar = conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
      definirCuotaFija(tx, {
        barrioId,
        rigeDesde: "2026-08",
        descripcion: null,
        forma: "importe",
        importe: "0.00",
      }),
    );
    await expect(sinConfirmar).rejects.toMatchObject({ codigo: "cuota_en_cero" });

    const escrita = await conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
      definirCuotaFija(tx, {
        barrioId,
        rigeDesde: "2026-08",
        descripcion: "Cuota suspendida por asamblea",
        forma: "importe",
        importe: "0.00",
        confirmarCuotaEnCero: true,
      }),
    );
    expect(escrita.importeUnico).toBe("0.00");
  });

  it("una baja del 100 % también pasa por la confirmación, no por el constraint", async () => {
    await expect(
      conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
        definirCuotaFija(tx, {
          barrioId,
          rigeDesde: "2026-08",
          descripcion: null,
          forma: "porcentaje",
          porcentaje: "-100",
          redondeo: "peso",
        }),
      ),
    ).rejects.toMatchObject({ codigo: "cuota_en_cero" });
  });

  it("una cuota que empieza ANTES que la vigente se rechaza con su propio mensaje", async () => {
    // Sin esto, el choque salía como un 23505 genérico ("ese dato ya existe"), que dice justo lo
    // contrario de lo que pasó.
    await expect(
      conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
        definirCuotaFija(tx, {
          barrioId,
          rigeDesde: "2026-06",
          descripcion: null,
          forma: "porcentaje",
          porcentaje: "5",
          redondeo: "peso",
        }),
      ),
    ).rejects.toMatchObject({ codigo: "cuota_retroactiva" });
  });

  it("empezar el MISMO día que la vigente sí se puede: es el ajuste dentro del mes", async () => {
    const escrita = await conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
      definirCuotaFija(tx, {
        barrioId,
        rigeDesde: "2026-07",
        descripcion: "Corrección del mismo mes",
        forma: "importe",
        importe: "375000.00",
      }),
    );
    expect(escrita.importeUnico).toBe("375000.00");
  });
});

describe("sin cuota vigente", () => {
  it("un porcentaje sobre nada se rechaza con su propio código", async () => {
    const desde = await proximoMes();
    await expect(
      conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
        definirCuotaFija(tx, {
          barrioId,
          rigeDesde: desde,
          descripcion: null,
          forma: "porcentaje",
          porcentaje: "3.2",
          redondeo: "peso",
        }),
      ),
    ).rejects.toMatchObject({ codigo: "sin_cuota_anterior" });
  });
});

describe("quién puede definir la cuota", () => {
  it("un contador (solo lectura) no puede", async () => {
    await expect(
      conUsuario(db, arbol.usuarios.contadorA1, (tx) =>
        definirCuotaFija(tx, {
          barrioId,
          rigeDesde: "2026-08",
          descripcion: null,
          forma: "importe",
          importe: "100000.00",
        }),
      ),
    ).rejects.toThrow();
  });

  it("un admin de OTRO estudio no puede escribir la cuota de este barrio", async () => {
    /*
     * El test de abajo prueba que no **lee** nada, y por eso solo no alcanza: el servicio corta antes
     * en `sin_unidades` y la policy de `insert` nunca se ejercita. Acá se la ejercita de verdad,
     * sembrando la lectura desde el pool de mantenimiento y pegándole al `insert` con la identidad
     * ajena — que es la que la policy `cuota_fija_version_ins` tiene que rechazar (42501).
     */
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from unidad_funcional where barrio_id = $1 and baja_at is null`,
      [barrioId],
    );
    expect(rows[0]?.n).not.toBe("0"); // el barrio sí tiene unidades: el corte no puede ser por eso

    await expect(
      conUsuario(db, arbol.usuarios.adminEstudioB, (tx) =>
        tx.execute(
          sql`insert into cuota_fija_version (barrio_id, descripcion, vigente_desde)
              values (${barrioId}, 'intento cruzado', current_date)`,
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("un usuario de otro estudio no ve ni una unidad de este barrio", async () => {
    const vigente = await conUsuario(db, arbol.usuarios.adminEstudioB, (tx) =>
      cuotaFijaVigente(tx, barrioId),
    );
    expect(vigente.unidadesActivas).toBe(0);
    expect(vigente.cuotas).toEqual([]);
  });
});

/** El id de la n-ésima versión del barrio, por fecha de vigencia. */
async function versionId(indice: number): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "select id::text from cuota_fija_version where barrio_id = $1 order by vigente_desde",
    [barrioId],
  );
  return rows[indice]!.id;
}
