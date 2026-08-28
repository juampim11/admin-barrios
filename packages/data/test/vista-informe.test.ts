/**
 * El productor del informe mensual, contra Postgres real.
 *
 * Lo que se prueba acá es que **el SQL corresponde al esquema real** y que la vista que sale pasa
 * sus propios invariantes. Los invariantes en sí ya están probados en
 * `packages/documentos/src/vista-informe-mensual.test.ts` con datos a mano; esto es la otra mitad:
 * que los datos de la base lleguen a esa forma.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/vista-informe.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { armarVistaInformeMensual, type OpcionesVistaInforme } from "../src/servicios/vista-informe.ts";
import { esFaltante } from "@admin-barrios/shared/documentos";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let periodoId: string;
let conceptoOrdinarioId: string;
let conceptoExtraId: string;

const PERIODO = "2028-06";

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> => conUsuario(db, usuario, fn);

const OPCIONES: OpcionesVistaInforme = {
  marca: {
    barrio: { nombre: "Los Álamos", logo: null, acentoHex: "#0f5c5c" },
    emisor: { razonSocial: "Estudio Pérez", cuit: "30712345678", domicilio: "Av. Siempreviva 100", contacto: null, logo: null },
    pie: [],
  },
  corteIso: "2028-06-30",
  emisionIso: "2028-07-10",
  recepcion: { plazoHastaIso: "2028-07-20", canal: "administracion@ejemplo.test" },
};

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);

  const uno = async (sql: string, args: unknown[]) => (await admin.query<{ id: string }>(sql, args)).rows[0]!.id;

  // Tres unidades activas y una de baja: el denominador tiene que contar tres.
  for (const [mz, lote] of [["1", "1"], ["1", "2"], ["1", "3"]]) {
    await admin.query(
      `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1,$2,$3,'construido')`,
      [arbol.barrioA1.id, mz, lote],
    );
  }
  await admin.query(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, baja_at)
     values ($1,'1','9','construido', now())`,
    [arbol.barrioA1.id],
  );

  periodoId = await uno(`insert into periodo_expensa (barrio_id, periodo) values ($1,$2) returning id`, [
    arbol.barrioA1.id,
    PERIODO,
  ]);

  conceptoOrdinarioId = await uno(
    `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
     values ($1,'Seguridad','ordinaria','sin_clasificar') returning id`,
    [arbol.barrioA1.id],
  );
  conceptoExtraId = await uno(
    `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
     values ($1,'Obra del portón','extraordinaria','sin_clasificar') returning id`,
    [arbol.barrioA1.id],
  );

  const actaId = await uno(
    `insert into documento_barrio (barrio_id, tipo, titulo, fecha_documento)
     values ($1,'acta_asamblea','Acta de asamblea 4/2028','2028-05-20') returning id`,
    [arbol.barrioA1.id],
  );

  await admin.query(
    `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto)
     values ($1,$2,$3,'Vigilancia contratada','600000.00'),
            ($1,$2,$3,'Mantenimiento de barreras','150000.00')`,
    [arbol.barrioA1.id, periodoId, conceptoOrdinarioId],
  );
  await admin.query(
    `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, acta_documento_id)
     values ($1,$2,$3,'Reparación del portón','250000.00',$4)`,
    [arbol.barrioA1.id, periodoId, conceptoExtraId, actaId],
  );

  /*
   * Las liquidaciones de las tres unidades activas. **Sin ellas el informe no se arma**, y eso es
   * correcto: el esquema exige al menos un grupo de ingreso, porque un informe de un período sin
   * liquidar no puede decir en qué se repartió el gasto. Hay un test abajo que fija ese borde.
   *
   * $400.000 de ordinarias + $100.000 de fondo por unidad, y la obra ($250.000) repartida en tres.
   */
  const unidades = (
    await admin.query<{ id: string }>(
      "select id from unidad_funcional where barrio_id = $1 and baja_at is null order by lote",
      [arbol.barrioA1.id],
    )
  ).rows;
  for (const u of unidades) {
    await admin.query(
      `insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado,
                                subtotal_ordinarias, subtotal_extraordinarias, subtotal_fondo_reserva,
                                interes_mora, total)
       values ($1,$2,$3,'0.333333333','400000.00','83333.33','100000.00','0.00','583333.33')`,
      [arbol.barrioA1.id, periodoId, u.id],
    );
  }
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  for (const t of ["gasto_periodo", "documento_barrio", "concepto", "liquidacion", "periodo_expensa", "unidad_funcional", "barrio_atributo_vigencia", "barrio"]) {
    await admin.query(`delete from ${t} where barrio_id = $1`, [arbol.barrioA1.id]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await appPool.end();
  await admin.end();
});

describe("el productor del informe mensual", () => {
  it("arma una vista que pasa sus propios invariantes", async () => {
    const v = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      armarVistaInformeMensual(tx, periodoId, OPCIONES),
    );
    expect(v.version).toBe("informe-mensual/2");
    expect(v.periodo.codigo).toBe(PERIODO);
    expect(v.periodo.etiqueta).toBe("06/2028");
  });

  /**
   * El campo que se agregó por el art. 2048 tiene fuente real: `concepto.tipo` da la naturaleza y
   * `gasto_periodo.acta_documento_id` da el acta. No era teórico.
   */
  it("el gasto extraordinario sale con su acta citada, y el ordinario sin respaldo", async () => {
    const v = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      armarVistaInformeMensual(tx, periodoId, OPCIONES),
    );

    const obra = v.devengado.egresos.find((g) => g.etiqueta === "Obra del portón");
    expect(obra?.naturaleza).toBe("extraordinario");
    expect(obra?.respaldo).toEqual({
      tipo: "acta",
      referencia: "Acta de asamblea 4/2028",
      fecha: { texto: "20/05/2028", iso: "2028-05-20" },
    });

    const seguridad = v.devengado.egresos.find((g) => g.etiqueta === "Seguridad");
    expect(seguridad?.naturaleza).toBe("ordinario");
    expect(seguridad?.respaldo).toBeNull();
  });

  it("el resultado ordinario deja afuera la obra, y el total la cuenta", async () => {
    const v = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      armarVistaInformeMensual(tx, periodoId, OPCIONES),
    );
    expect(v.devengado.totalEgresos.monto).toBe("1000000.00");
    // Ingresos: 3 x (400.000 ordinarias + 100.000 fondo + 83.333,33 extraordinaria) = 1.749.999,99.
    expect(v.devengado.totalIngresos.monto).toBe("1749999.99");
    expect(v.devengado.resultado.monto).toBe("749999.99");
    // El ordinario deja afuera la obra (250.000) y la contribución que la financia (249.999,99):
    // 1.500.000 de ingreso ordinario menos 750.000 de gasto ordinario.
    expect(v.devengado.resultadoOrdinario.monto).toBe("750000.00");
  });

  it("los honorarios llevan renglón propio aunque el barrio no haya cargado ninguno", async () => {
    const v = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      armarVistaInformeMensual(tx, periodoId, OPCIONES),
    );
    const honorarios = v.devengado.egresos.find((g) => g.clave === "honorarios_administracion");
    expect(honorarios?.importe.monto).toBe("0.00");
  });

  it("no publica el nombre de ningún proveedor mientras el modelo no distinga persona de empresa", async () => {
    const v = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      armarVistaInformeMensual(tx, periodoId, OPCIONES),
    );
    const proveedores = v.devengado.egresos.flatMap((g) => g.desagregado).map((l) => l.proveedor.tipo);
    expect(new Set(proveedores)).toEqual(new Set(["sin_identificar"]));
  });

  it("cuenta las unidades activas y calcula el gasto por unidad", async () => {
    const v = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      armarVistaInformeMensual(tx, periodoId, OPCIONES),
    );
    const unidades = v.denominadores.find((d) => d.clave === "unidades_alcanzadas");
    // Tres activas: la dada de baja no cuenta.
    expect(unidades?.valorTexto).toBe("3");
    const porUnidad = v.denominadores.find((d) => d.clave === "gasto_por_unidad");
    expect(porUnidad?.valorTexto).toBe("333.333,33");
  });

  /**
   * La decisión de alcance del 2026-08-28: no hay modelo de caja/banco/fondo, y **nada de eso se
   * aproxima**. El hueco se dice; no se rellena con un número plausible.
   */
  it("la situación financiera sale como hueco declarado, no como ceros", async () => {
    const v = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      armarVistaInformeMensual(tx, periodoId, OPCIONES),
    );
    expect(esFaltante(v.financiero.fondos.saldoInicial)).toBe(true);
    expect(esFaltante(v.financiero.fondos.saldoFinal)).toBe(true);
    // `null` = el barrio no tiene fondo cargado, que es una respuesta legítima del esquema.
    expect(v.financiero.fondoReserva).toBeNull();
    // Apagada por default.
    expect(v.financiero.creditosConUnidades).toBeNull();
    expect(v.faltantes.length).toBeGreaterThan(0);
  });

  it("el puente arranca en el resultado y declara el hueco en vez de cerrar falso", async () => {
    const v = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      armarVistaInformeMensual(tx, periodoId, OPCIONES),
    );
    expect(v.conciliacion.partida.monto).toBe(v.devengado.resultado.monto);
    expect(esFaltante(v.conciliacion.renglones[0]!.importe)).toBe(true);
  });

  it("trae la figura jurídica y el canal de observaciones", async () => {
    const v = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      armarVistaInformeMensual(tx, periodoId, OPCIONES),
    );
    expect(v.barrio.figuraJuridica).toBe("ph_especial");
    expect(v.recepcionDeObservaciones?.canal).toBe("administracion@ejemplo.test");
  });

  /** Mismo gate que emitir la boleta: el informe publica el gasto del barrio con sus proveedores. */
  it("un contador no puede armarlo: leer el período no es emitir su informe", async () => {
    await expect(
      como(arbol.usuarios.contadorA1, (tx) => armarVistaInformeMensual(tx, periodoId, OPCIONES)),
    ).rejects.toThrow(/No tenés permiso para emitir el informe/);
  });

  it("un barrio ajeno no lo ve", async () => {
    await expect(
      como(arbol.usuarios.adminEstudioB, (tx) => armarVistaInformeMensual(tx, periodoId, OPCIONES)),
    ).rejects.toThrow(/El período no existe o no tenés acceso/);
  });
});
