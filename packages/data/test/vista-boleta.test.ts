/**
 * El armado de la `VistaBoleta` contra Postgres real.
 *
 * Este archivo existe porque no existía: el servicio que toca base, dinero y RLS era el único sin
 * cobertura, y ahí vivían tres bugs que encontró la revisión. Lo que se prueba acá es exactamente
 * eso — que el denominador del coeficiente impreso sea el que repartió, que el interés no se
 * explique con datos inventados, y que emitir el padrón entero exija rol de administración.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { crearMedioGenericoDemo } from "@admin-barrios/documentos/cobranza";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { armarVistaBoleta, armarVistasDelPeriodo } from "../src/servicios/vista-boleta.ts";
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
let barrioId: string;
let unidades: string[];
let periodoId: string;
let versionCoeficientes: string;

const medio = crearMedioGenericoDemo();

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  barrioId = arbol.barrioA1.id;
  await crearBarrio(admin, barrioId);
  unidades = await crearUnidades(admin, barrioId, 6);
  versionCoeficientes = await crearCoeficientes(admin, barrioId, unidades);
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [versionCoeficientes]);

  // Un obligado notificado por unidad: la boleta imprime su nombre.
  for (const [i, unidadId] of unidades.entries()) {
    const { rows } = await admin.query<{ id: string }>(
      `insert into obligado (barrio_id, nombre) values ($1, $2) returning id`,
      [barrioId, `Titular ${i + 1}`],
    );
    await admin.query(
      `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
       values ($1,$2,$3,'propietario', current_date - 100, true)`,
      [barrioId, unidadId, rows[0]?.id],
    );
  }

  const { rows: conceptoRows } = await admin.query<{ id: string }>(
    `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
     values ($1,'Seguridad','ordinaria','sin_clasificar') returning id`,
    [barrioId],
  );
  const conceptoId = conceptoRows[0]?.id;

  await admin.query(
    `insert into tasa_mora (barrio_id, tasa_mensual, vigente_desde) values ($1, 0.030000, current_date - 100)`,
    [barrioId],
  );

  const { rows: perRows } = await admin.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo, primer_vencimiento)
     values ($1,'2026-03', current_date + 10) returning id`,
    [barrioId],
  );
  periodoId = perRows[0]?.id as string;
  await admin.query(
    `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto)
     values ($1,$2,$3,'Vigilancia','1200000.00')`,
    [barrioId, periodoId, conceptoId],
  );

  await conUsuario(db, arbol.usuarios.adminEstudioA, (tx) => generarLiquidaciones(tx, { periodoId }));
  await conUsuario(db, arbol.usuarios.adminEstudioA, (tx) => emitirPeriodo(tx, periodoId));
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  for (const tabla of [
    "item_liquidacion", "liquidacion", "gasto_periodo", "periodo_expensa", "concepto", "tasa_mora",
    "coeficiente", "coeficiente_version", "unidad_obligado", "obligado", "unidad_funcional",
    "barrio_atributo_vigencia", "documento_barrio", "barrio",
  ]) {
    await admin.query(`delete from ${tabla} where barrio_id = $1`, [barrioId]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

const armar = () =>
  conUsuario(db, arbol.usuarios.adminEstudioA, (tx) => armarVistasDelPeriodo(tx, periodoId, { medio }));

describe("el dinero de la vista sale de la liquidación", () => {
  it("arma una vista por unidad y todas cierran los invariantes de `parsearVistaBoleta`", async () => {
    const vistas = await armar();
    expect(vistas).toHaveLength(unidades.length);
    // Que `parsearVistaBoleta` no haya tirado ya prueba los invariantes; acá se afirma el cierre.
    for (const v of vistas) {
      expect(v.totales.aPagar.monto).toBe(v.totales.delPeriodo.monto);
      expect(v.bloquePago.importes.alVencimiento.monto).toBe(v.totales.aPagar.monto);
    }
  });

  it("lo que suman todas las boletas es exactamente el gasto del período", async () => {
    const vistas = await armar();
    const total = vistas.reduce((a, v) => a + BigInt(v.totales.delPeriodo.monto.replace(".", "")), 0n);
    expect(total).toBe(120_000_000n); // $ 1.200.000,00 en centavos
  });
});

describe("el coeficiente impreso es el que repartió", () => {
  it("una unidad dada de baja DESPUÉS de cerrar la versión no infla el denominador", async () => {
    // `unidad_funcional` tiene baja lógica y `coeficiente` no tiene columna de vigencia: si el
    // denominador se sacara de la tabla entera, el porcentaje impreso quedaría por debajo del real
    // y la cuenta dejaría de rehacerse con una calculadora.
    const antes = (await armar())[0];
    expect(antes).toBeDefined();

    const deBaja = unidades.at(-1);
    await admin.query("update unidad_funcional set baja_at = now() where id = $1", [deBaja]);
    try {
      const despues = (await armar())[0];
      expect(despues).toBeDefined();
      // La participación SUBE al sacar una unidad del reparto: el denominador es más chico.
      expect(Number(despues?.detalle.coeficiente.participacionTexto.replace(",", "."))).toBeGreaterThan(
        Number(antes?.detalle.coeficiente.participacionTexto.replace(",", ".")),
      );
    } finally {
      await admin.query("update unidad_funcional set baja_at = null where id = $1", [deBaja]);
    }
  });
});

describe("el interés no se explica con datos inventados", () => {
  it("con interés en cero y sin fecha de corte, la vista dice `null` en vez de la fecha de hoy", async () => {
    const vista = (await armar())[0];
    expect(vista?.totales.interes?.monto).toBe("0.00");
    // El check de la base exime del par (días, fecha de corte) cuando el interés es cero: la vista
    // refleja esa ausencia en vez de rellenarla con `current_date` del servidor.
    expect(vista?.interes?.computadoHasta).toBeNull();
    expect(vista?.interes?.tasaMensualTexto).toBe("3,0000");
    expect(vista?.interes?.dias).toBe(0);
  });
});

describe("emitir el padrón exige rol de administración", () => {
  it("un `propietario` con membresía activa NO puede emitir", async () => {
    // Hay DOS candados, y este test verifica que el de afuera es el que actúa. Antes de 0018 el
    // primero era el gate de `puede_emitir` del servicio, porque la RLS dejaba leer el período a
    // cualquier membresía. Ahora la RLS ya no le muestra el período: el servicio ni llega a evaluar
    // el rol. Si esta expectativa vuelve a ser /no tenés permiso para emitir/, es que alguien
    // reabrió la lectura de `periodo_expensa` para roles sin gestión.
    await expect(
      conUsuario(db, arbol.usuarios.propietarioA1, (tx) => armarVistasDelPeriodo(tx, periodoId, { medio })),
    ).rejects.toThrow(/no existe o no es accesible/);
  });

  it("un `contador` (gestión, solo lectura) sí ve el período pero tampoco emite", async () => {
    // El gate de `puede_emitir` del servicio sigue haciendo falta: hay roles de gestión que leen
    // todo y no deben poder generar los documentos del padrón.
    await expect(
      conUsuario(db, arbol.usuarios.contadorA1, (tx) => armarVistasDelPeriodo(tx, periodoId, { medio })),
    ).rejects.toThrow(/no tenés permiso para emitir/);
  });

  it("un usuario de otro estudio no ve el período siquiera", async () => {
    await expect(
      conUsuario(db, arbol.usuarios.adminEstudioB, (tx) => armarVistasDelPeriodo(tx, periodoId, { medio })),
    ).rejects.toThrow(/no existe o no es accesible/);
  });

  it("un usuario sin membresía tampoco", async () => {
    await expect(
      conUsuario(db, randomUUID(), (tx) => armarVistasDelPeriodo(tx, periodoId, { medio })),
    ).rejects.toThrow(/no existe o no es accesible/);
  });
});

describe("la vista previa de una boleta no se trae el período entero", () => {
  it("`armarVistaBoleta` devuelve solo la liquidación pedida", async () => {
    const vistas = await armar();
    const primera = vistas[0];
    expect(primera).toBeDefined();

    const { rows } = await admin.query<{ id: string }>(
      `select l.id from liquidacion l join unidad_funcional u on u.id = l.unidad_funcional_id
        where l.periodo_id = $1 order by u.manzana, u.lote limit 1`,
      [periodoId],
    );
    const liquidacionId = rows[0]?.id as string;

    const una = await conUsuario(db, arbol.usuarios.adminEstudioA, (tx) =>
      armarVistaBoleta(tx, liquidacionId, { medio }),
    );
    expect(una.unidad.etiqueta).toBe(primera?.unidad.etiqueta);
    expect(una.totales.aPagar.monto).toBe(primera?.totales.aPagar.monto);
  });
});
