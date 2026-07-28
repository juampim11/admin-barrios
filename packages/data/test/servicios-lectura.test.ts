/**
 * Los servicios de lectura del ADR-0002 §7, contra Postgres real.
 *
 * Lo que se prueba **no** es que las consultas devuelvan filas: es que devuelvan **las filas que
 * corresponden a quien pregunta**, sin que ningún servicio filtre por barrio a mano. Por eso cada
 * caso se corre con varios usuarios del mismo fixture —el del estudio, el de un solo barrio, uno
 * ajeno, uno sin membresía, uno con la membresía desactivada— y se compara el resultado.
 *
 * El escenario es el de `helpers.ts`:
 *
 *   Estudio Pérez (A)            ├─ Otro Estudio (B)
 *    ├─ Los Álamos (A1)          │   └─ Las Lomas (B1)
 *    │    └─ Náutica (A1.sub)    │
 *    └─ San Isidro (A2)          │
 *
 * `adminEstudioA` tiene membresía en el nodo **administrador** y ve los dos barrios: es el caso
 * central del producto (un estudio que administra varios barrios) y el que más fácil se rompe.
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
import { leerBarrio, listarBarriosAccesibles } from "../src/servicios/barrios.ts";
import { listarPadron } from "../src/servicios/padron.ts";
import { leerPeriodo, listarGastos, listarPeriodos } from "../src/servicios/periodos.ts";
import { listarLiquidaciones } from "../src/servicios/liquidaciones.ts";
import { generarLiquidaciones } from "../src/servicios/liquidacion.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let unidadesA1: string[];
let unidadesA2: string[];
let periodoA1: string;
let periodoA2: string;

const TABLAS_A_LIMPIAR = [
  "item_liquidacion",
  "liquidacion",
  "gasto_periodo",
  "periodo_expensa",
  "concepto",
  "tasa_mora",
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
];

/** Corre `fn` con la identidad de `usuario`. Azúcar para que los casos se lean de un vistazo. */
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> =>
  conUsuario(db, usuario, fn);

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id, { figuraJuridica: "ph_especial", municipio: "villa-allende" });
  await crearBarrio(admin, arbol.barrioA2.id, { figuraJuridica: "sa", municipio: "la-calera" });
  await crearBarrio(admin, arbol.barrioB1.id, { figuraJuridica: "ph_especial", municipio: "la-calera" });

  unidadesA1 = await crearUnidades(admin, arbol.barrioA1.id, 4);
  unidadesA2 = await crearUnidades(admin, arbol.barrioA2.id, 2);
  await crearUnidades(admin, arbol.barrioB1.id, 3);

  // Mandato vigente en A1: el detalle del barrio tiene que traer al administrador.
  await admin.query(
    `insert into mandato_administracion (barrio_id, administrador_id, desde)
     values ($1, $2, current_date - 100)`,
    [arbol.barrioA1.id, arbol.adminA.id],
  );

  // Obligados de A1: un propietario notificado en cada unidad, y un poseedor en la primera —el caso
  // de los arts. 2049/2050, donde el propietario NO se libera y por eso el padrón devuelve dos.
  for (const [i, unidad] of unidadesA1.entries()) {
    const { rows } = await admin.query<{ id: string }>(
      `insert into obligado (barrio_id, nombre, tipo_documento, numero_documento, email)
       values ($1, $2, 'DNI', $3, $4) returning id`,
      [arbol.barrioA1.id, `Propietario ${i + 1}`, String(30_000_000 + i), `p${i + 1}@ejemplo.test`],
    );
    await admin.query(
      `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
       values ($1,$2,$3,'propietario', current_date - 300, true)`,
      [arbol.barrioA1.id, unidad, rows[0]?.id],
    );
  }
  const { rows: poseedor } = await admin.query<{ id: string }>(
    `insert into obligado (barrio_id, nombre) values ($1, 'Poseedor de la 1') returning id`,
    [arbol.barrioA1.id],
  );
  await admin.query(
    `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde)
     values ($1,$2,$3,'poseedor', current_date - 50)`,
    [arbol.barrioA1.id, unidadesA1[0], poseedor[0]?.id],
  );

  // Coeficientes cerrados y vigentes en los dos barrios de A: sin esto no se puede liquidar.
  for (const [barrioId, unidades] of [
    [arbol.barrioA1.id, unidadesA1],
    [arbol.barrioA2.id, unidadesA2],
  ] as const) {
    const version = await crearCoeficientes(admin, barrioId, unidades);
    await admin.query("update coeficiente_version set cerrada = true where id = $1", [version]);
    await admin.query(
      `insert into tasa_mora (barrio_id, tasa_mensual, vigente_desde) values ($1, 0.030000, current_date - 300)`,
      [barrioId],
    );
  }

  // Un período por barrio, con gastos. En A1 se liquida; en A2 se deja en borrador sin liquidar,
  // para que el test note la diferencia entre "cargado" y "liquidado".
  const crearPeriodoConGastos = async (
    barrioId: string,
    periodo: string,
    gastos: readonly (readonly [string, string, string, boolean])[],
  ): Promise<string> => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into periodo_expensa (barrio_id, periodo, primer_vencimiento, segundo_vencimiento)
       values ($1,$2, current_date + 10, current_date + 20) returning id`,
      [barrioId, periodo],
    );
    const periodoId = rows[0]?.id as string;
    for (const [nombre, tipo, monto, fondo] of gastos) {
      const { rows: c } = await admin.query<{ id: string }>(
        `insert into concepto (barrio_id, nombre, tipo, es_fondo_reserva, clasificacion_fiscal)
         values ($1,$2,$3,$4,'sin_clasificar') returning id`,
        [barrioId, nombre, tipo, fondo],
      );
      await admin.query(
        `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto)
         values ($1,$2,$3,$4,$5)`,
        [barrioId, periodoId, c[0]?.id, `${nombre} del período`, monto],
      );
    }
    return periodoId;
  };

  periodoA1 = await crearPeriodoConGastos(arbol.barrioA1.id, "2026-05", [
    ["Seguridad", "ordinaria", "400000.00", false],
    ["Fondo de reserva", "ordinaria", "100000.00", true],
  ]);
  periodoA2 = await crearPeriodoConGastos(arbol.barrioA2.id, "2026-05", [
    ["Mantenimiento", "ordinaria", "250000.00", false],
  ]);

  await como(arbol.usuarios.adminEstudioA, (tx) => generarLiquidaciones(tx, { periodoId: periodoA1 }));
});

afterAll(async () => {
  const barrios = [arbol.barrioA1.id, arbol.barrioA2.id, arbol.barrioB1.id];
  for (const tabla of TABLAS_A_LIMPIAR) {
    await admin.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [barrios]);
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("listarBarriosAccesibles", () => {
  it("el usuario del estudio ve SUS DOS barrios y ninguno más", async () => {
    const barrios = await como(arbol.usuarios.adminEstudioA, listarBarriosAccesibles);
    expect(barrios.map((b) => b.nombre).sort()).toEqual(["Los Álamos", "San Isidro"]);
    // Ni asomo de "Las Lomas", que es del otro estudio.
    expect(barrios.some((b) => b.nombre === "Las Lomas")).toBe(false);
  });

  it("el usuario de un solo barrio ve solo ese", async () => {
    const barrios = await como(arbol.usuarios.adminBarrioA1, listarBarriosAccesibles);
    expect(barrios.map((b) => b.nombre)).toEqual(["Los Álamos"]);
  });

  it("un administrador ajeno no ve NADA de A", async () => {
    const barrios = await como(arbol.usuarios.adminEstudioB, listarBarriosAccesibles);
    expect(barrios.map((b) => b.nombre)).toEqual(["Las Lomas"]);
  });

  it("sin membresía, con la membresía inactiva, o con rol de residente: la lista es vacía", async () => {
    for (const usuario of [
      arbol.usuarios.sinMembresia,
      arbol.usuarios.inactivoA1,
      arbol.usuarios.propietarioA1,
      arbol.usuarios.residenteA1,
    ]) {
      expect(await como(usuario, listarBarriosAccesibles)).toEqual([]);
    }
  });

  it("trae el rol con el que el usuario llega", async () => {
    const [alamos] = await como(arbol.usuarios.operadorA1, listarBarriosAccesibles);
    expect(alamos?.roles).toEqual(["operador"]);
    expect(alamos?.unidadesActivas).toBe(unidadesA1.length);

    // La membresía del estudio se HEREDA hacia el subárbol: el rol se ve igual en los dos barrios.
    const delEstudio = await como(arbol.usuarios.adminEstudioA, listarBarriosAccesibles);
    for (const b of delEstudio) expect(b.roles).toEqual(["admin_barrio"]);
  });

  it("HALLAZGO: el nombre del administrador solo lo ve quien tiene membresía en el nodo del estudio", async () => {
    // Con membresía en el ADMINISTRADOR: el nodo está dentro de `accessible_tenant_ids()`.
    const [delEstudio] = await como(arbol.usuarios.adminEstudioA, listarBarriosAccesibles);
    expect(delEstudio?.administrador?.nombre).toBe("Estudio Pérez");

    // Con membresía solo en el BARRIO: la fila de `mandato_administracion` sí se lee, pero el
    // `tenant_node` del estudio está por ENCIMA y `tenant_node_sel` (0001) no alcanza a los
    // ancestros. Este test documenta el comportamiento real, no el deseado.
    //
    // ⚠ Importa más allá de esta pantalla: `vista-boleta.ts` hace el mismo `left join` y un
    // `operador` PUEDE emitir, así que hoy generaría los PDF con el emisor cayendo al nombre del
    // barrio. Cuando se decida la salida —abrir la lectura del ancestro con mandato vigente, o
    // congelar el emisor en la liquidación— este test se da vuelta y avisa que hay que revisarlo.
    const [delBarrio] = await como(arbol.usuarios.operadorA1, listarBarriosAccesibles);
    expect(delBarrio?.administrador).toBeNull();
  });
});

describe("leerBarrio", () => {
  it("devuelve el detalle del barrio propio", async () => {
    const barrio = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      leerBarrio(tx, { barrioId: arbol.barrioA1.id }),
    );
    expect(barrio?.nombre).toBe("Los Álamos");
    expect(barrio?.figuraJuridica).toBe("ph_especial");
    expect(barrio?.tieneCoeficientesVigentes).toBe(true);
    expect(barrio?.tieneTasaMoraVigente).toBe(true);
  });

  it("el uuid de la URL NO autoriza: pedir un barrio ajeno devuelve `null`", async () => {
    // Este es EL caso del ADR-0002 §3.4. Si esto devolviera datos, el segmento de la URL sería la
    // autorización — que es exactamente el patrón que la RLS existe para evitar.
    const ajeno = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      leerBarrio(tx, { barrioId: arbol.barrioB1.id }),
    );
    expect(ajeno).toBeNull();

    // Y desde el otro lado: el del estudio B tampoco ve A1.
    expect(
      await como(arbol.usuarios.adminEstudioB, (tx) => leerBarrio(tx, { barrioId: arbol.barrioA1.id })),
    ).toBeNull();
  });

  it("un barrio inexistente y uno inaccesible se ven IGUAL: no hay oráculo de existencia", async () => {
    const inexistente = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      leerBarrio(tx, { barrioId: "11111111-1111-4111-8111-111111111111" }),
    );
    const inaccesible = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      leerBarrio(tx, { barrioId: arbol.barrioB1.id }),
    );
    expect(inexistente).toBe(inaccesible); // los dos `null`
  });

  it("un uuid mal formado se rechaza en el borde, con Zod, y no llega a la base", async () => {
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) => leerBarrio(tx, { barrioId: "../../etc/passwd" })),
    ).rejects.toThrow(/identificador/i);
  });
});

describe("listarPadron", () => {
  it("trae las unidades del barrio con su coeficiente y sus obligados vigentes", async () => {
    const padron = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      listarPadron(tx, { barrioId: arbol.barrioA1.id }),
    );
    expect(padron.total).toBe(unidadesA1.length);
    expect(padron.unidades).toHaveLength(unidadesA1.length);

    const primera = padron.unidades[0];
    expect(primera?.etiqueta).toBe("Mza 1 · Lote 1");
    // El coeficiente viaja como string con sus 9 decimales: nunca pasa por `number`.
    expect(primera?.coeficiente).toMatch(/^\d+\.\d{9}$/);

    // Propietario + poseedor a la vez (arts. 2049/2050), y el notificado va primero.
    expect(primera?.obligados).toHaveLength(2);
    expect(primera?.obligados[0]?.esNotificado).toBe(true);
    expect(primera?.obligados.map((o) => o.tipo).sort()).toEqual(["poseedor", "propietario"]);
  });

  it("un barrio ajeno devuelve el padrón VACÍO, no el de otro", async () => {
    const padron = await como(arbol.usuarios.adminEstudioB, (tx) =>
      listarPadron(tx, { barrioId: arbol.barrioA1.id }),
    );
    expect(padron.unidades).toEqual([]);
    expect(padron.total).toBe(0);
  });

  it("un `propietario` no lee ni una fila del padrón (precondición del §3.5)", async () => {
    // Antes de 0018 esto devolvía el padrón entero con la PII de todos los vecinos.
    for (const usuario of [arbol.usuarios.propietarioA1, arbol.usuarios.residenteA1]) {
      const padron = await como(usuario, (tx) => listarPadron(tx, { barrioId: arbol.barrioA1.id }));
      expect(padron.unidades).toEqual([]);
    }
  });

  it("pagina, y el total corresponde al mismo filtro que la lista", async () => {
    const pagina = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      listarPadron(tx, { barrioId: arbol.barrioA1.id, limite: 2, desplazamiento: 1 }),
    );
    expect(pagina.unidades).toHaveLength(2);
    expect(pagina.total).toBe(unidadesA1.length); // el total es del filtro, no de la página
    expect(pagina.unidades[0]?.lote).toBe("2");
  });

  it("las unidades dadas de baja se ocultan por defecto y se pueden pedir (su deuda sigue existiendo)", async () => {
    await admin.query("update unidad_funcional set baja_at = now() where id = $1", [unidadesA1[3]]);
    try {
      const sinBajas = await como(arbol.usuarios.adminBarrioA1, (tx) =>
        listarPadron(tx, { barrioId: arbol.barrioA1.id }),
      );
      expect(sinBajas.total).toBe(unidadesA1.length - 1);

      const conBajas = await como(arbol.usuarios.adminBarrioA1, (tx) =>
        listarPadron(tx, { barrioId: arbol.barrioA1.id, incluirBajas: true }),
      );
      expect(conBajas.total).toBe(unidadesA1.length);
      expect(conBajas.unidades.filter((u) => u.dadaDeBaja)).toHaveLength(1);
    } finally {
      await admin.query("update unidad_funcional set baja_at = null where id = $1", [unidadesA1[3]]);
    }
  });

  it("un límite absurdo se rechaza en el borde: 'ver el padrón' no es 'descargar el padrón'", async () => {
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        listarPadron(tx, { barrioId: arbol.barrioA1.id, limite: 100_000 }),
      ),
    ).rejects.toThrow();
  });
});

describe("listarPeriodos y leerPeriodo", () => {
  it("lista los períodos del barrio, del más nuevo al más viejo", async () => {
    const periodos = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      listarPeriodos(tx, { barrioId: arbol.barrioA1.id }),
    );
    expect(periodos.map((p) => p.periodo)).toEqual(["2026-05"]);
    expect(periodos[0]?.estado).toBe("borrador");
    expect(periodos[0]?.liquidaciones).toBe(unidadesA1.length);
  });

  it("el usuario del estudio ve los períodos de cada uno de sus barrios, sin mezclarlos", async () => {
    const deA1 = await como(arbol.usuarios.adminEstudioA, (tx) =>
      listarPeriodos(tx, { barrioId: arbol.barrioA1.id }),
    );
    const deA2 = await como(arbol.usuarios.adminEstudioA, (tx) =>
      listarPeriodos(tx, { barrioId: arbol.barrioA2.id }),
    );
    expect(deA1).toHaveLength(1);
    expect(deA2).toHaveLength(1);
    expect(deA1[0]?.id).not.toBe(deA2[0]?.id);
    // A2 no se liquidó: el conteo lo dice, y no hay que adivinarlo por el total en null.
    expect(deA2[0]?.liquidaciones).toBe(0);
  });

  it("el detalle deriva el barrio de la propia fila y trae los gastos", async () => {
    const detalle = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      leerPeriodo(tx, { periodoId: periodoA1 }),
    );
    expect(detalle?.barrioId).toBe(arbol.barrioA1.id);
    expect(detalle?.barrioNombre).toBe("Los Álamos");
    expect(detalle?.gastos).toHaveLength(2);
    expect(detalle?.editable).toBe(true);
    expect(detalle?.puedeEmitir).toBe(true);
  });

  it("`totalGastosCargados` se recalcula de los gastos y es exacto (sin punto flotante)", async () => {
    const detalle = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      leerPeriodo(tx, { periodoId: periodoA1 }),
    );
    expect(detalle?.totalGastosCargados).toBe("500000.00");
    // Y coincide con lo que la base congeló al liquidar: si divergieran, el reparto no cuadraría.
    expect(detalle?.totalGastos).toBe("500000.00");
  });

  it("un contador puede leer pero NO emitir: el rol se refleja en el detalle", async () => {
    const detalle = await como(arbol.usuarios.contadorA1, (tx) => leerPeriodo(tx, { periodoId: periodoA1 }));
    expect(detalle?.barrioNombre).toBe("Los Álamos");
    expect(detalle?.puedeEmitir).toBe(false);
  });

  it("un período de otro barrio devuelve `null`, aunque se sepa su uuid", async () => {
    expect(await como(arbol.usuarios.adminEstudioB, (tx) => leerPeriodo(tx, { periodoId: periodoA1 }))).toBeNull();
    expect(await como(arbol.usuarios.propietarioA1, (tx) => leerPeriodo(tx, { periodoId: periodoA1 }))).toBeNull();
  });

  it("`listarGastos` de un período ajeno devuelve la lista vacía", async () => {
    expect(await como(arbol.usuarios.adminEstudioB, (tx) => listarGastos(tx, { periodoId: periodoA1 }))).toEqual([]);
    expect(
      (await como(arbol.usuarios.adminBarrioA1, (tx) => listarGastos(tx, { periodoId: periodoA2 }))).length,
    ).toBe(0); // A1 no ve el período de A2
  });
});

describe("listarLiquidaciones", () => {
  it("trae una fila por unidad, con los seis subtotales y su destinatario", async () => {
    const grilla = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      listarLiquidaciones(tx, { periodoId: periodoA1 }),
    );
    expect(grilla.total).toBe(unidadesA1.length);
    const primera = grilla.liquidaciones[0];
    expect(primera?.etiqueta).toBe("Mza 1 · Lote 1");
    expect(primera?.destinatario).toBe("Propietario 1");
    // Todos los importes son strings de `numeric`, con dos decimales exactos.
    expect(primera?.total).toMatch(/^-?\d+\.\d{2}$/);
  });

  it("los totales de la grilla cierran contra el gasto del período: el reparto no pierde ni un centavo", async () => {
    const grilla = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      listarLiquidaciones(tx, { periodoId: periodoA1 }),
    );
    // Ordinarias + fondo de reserva = los 500.000 cargados. Es el mismo cuadre que la base exige
    // para emitir, verificado desde el lado de la pantalla que lo muestra.
    const repartido = [grilla.totales.ordinarias, grilla.totales.fondoReserva];
    expect(repartido).toEqual(["400000.00", "100000.00"]);

    // Y la suma de la columna "total" es la suma de las filas: el administrador la puede rehacer.
    const { rows } = await admin.query<{ suma: string }>(
      "select sum(total)::text as suma from liquidacion where periodo_id = $1",
      [periodoA1],
    );
    expect(grilla.totales.total).toBe(rows[0]?.suma);
  });

  it("un período ajeno devuelve la grilla vacía y los totales en cero, no un error", async () => {
    const grilla = await como(arbol.usuarios.adminEstudioB, (tx) =>
      listarLiquidaciones(tx, { periodoId: periodoA1 }),
    );
    expect(grilla.liquidaciones).toEqual([]);
    expect(grilla.total).toBe(0);
    expect(grilla.totales.total).toBe("0.00");
  });

  it("el orden es `manzana, lote` — el MISMO que recorre el lote de boletas", async () => {
    const grilla = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      listarLiquidaciones(tx, { periodoId: periodoA1 }),
    );
    const { rows } = await conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) =>
      tx.execute<{ id: string }>(sql`
        select l.id from liquidacion l
          join unidad_funcional u on u.id = l.unidad_funcional_id
         where l.periodo_id = ${periodoA1}
         order by u.manzana, u.lote
      `),
    );
    expect(grilla.liquidaciones.map((l) => l.id)).toEqual(rows.map((r) => r.id));
  });
});

describe("`conUsuario` no deja que la identidad se pierda en silencio", () => {
  it("un `userId` que no es uuid se rechaza acá, no en la primera policy", async () => {
    await expect(conUsuario(db, "no-soy-un-uuid", async () => 1)).rejects.toThrow(/no es un uuid/i);
  });

  it("la identidad efectiva es la pedida (si no, la RLS devolvería cero filas y se vería 'sin datos')", async () => {
    const efectivo = await como(arbol.usuarios.adminBarrioA1, async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`select app.current_user_id()::text as id`);
      return r.rows[0]?.id;
    });
    expect(efectivo).toBe(arbol.usuarios.adminBarrioA1);
  });
});
