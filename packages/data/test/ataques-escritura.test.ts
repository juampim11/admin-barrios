/**
 * ATAQUES — suite adversarial contra los servicios de escritura del primer recorrido.
 *
 * No es la suite de regresión: es el intento de ROMPERLOS. Cada `it` que empieza con `HALLAZGO`
 * documenta un comportamiento observado que se considera defectuoso; el resto son intentos que la
 * base aguantó (y que conviene dejar fijados).
 *
 * Correr con:  pnpm vitest run --project db packages/data/test/ataques-escritura.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, crearDbRequest, type DbRequest } from "../src/client.ts";
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
import { crearPeriodo, listarGastos } from "../src/servicios/periodos.ts";
import { borrarGasto, corregirGasto, registrarGasto } from "../src/servicios/gastos.ts";
import {
  crearConceptoBoleta,
  listarConceptosBoleta,
  registrarValorConcepto,
} from "../src/servicios/conceptos-boleta.ts";
import { anularAplicacion, aplicarConceptoAUnidad, listarAplicaciones } from "../src/servicios/cargos.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let unidadesA1: string[];
let unidadesA2: string[];
let unidadesB1: string[];
let conceptoGastoA1: string;
let conceptoGastoA2: string;
let actaA1: string;
let actaA2: string;
let quinchoA1: string; // precio_x_cantidad 1500.00
let fijoA1: string; // monto_fijo 45000.00
let quinchoA2: string;

const TABLAS_A_LIMPIAR = [
  "concepto_boleta_unidad_evento",
  "item_liquidacion",
  "liquidacion",
  "concepto_boleta_unidad",
  "concepto_boleta_valor",
  "concepto_boleta",
  "limite_aplicacion_barrio",
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

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> =>
  conUsuario(db, usuario, fn);

/** Corre `fn` y devuelve el `ErrorDeNegocio`; falla el test si no explotó o si salió sin traducir. */
async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) {
      throw new Error(`salió un error SIN traducir: ${String(e)}`);
    }
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

/** Igual, pero devuelve el error crudo (para mirar el canal de error de la base). */
async function capturarCrudo(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

async function periodoNuevo(mes: string, barrioId = arbol.barrioA1.id, usuario?: string): Promise<string> {
  const { id } = await como(usuario ?? arbol.usuarios.adminEstudioA, (tx) =>
    crearPeriodo(tx, {
      barrioId,
      periodo: mes,
      modelo: "variable",
      primerVencimiento: null,
      segundoVencimiento: null,
      notas: null,
    }),
  );
  return id;
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioA2.id);
  await crearBarrio(admin, arbol.barrioB1.id);

  unidadesA1 = await crearUnidades(admin, arbol.barrioA1.id, 4);
  unidadesA2 = await crearUnidades(admin, arbol.barrioA2.id, 2);
  unidadesB1 = await crearUnidades(admin, arbol.barrioB1.id, 2);

  for (const [barrioId, unidades] of [
    [arbol.barrioA1.id, unidadesA1],
    [arbol.barrioA2.id, unidadesA2],
    [arbol.barrioB1.id, unidadesB1],
  ] as const) {
    const version = await crearCoeficientes(admin, barrioId, unidades);
    await admin.query("update coeficiente_version set cerrada = true where id = $1", [version]);
    await admin.query(
      "insert into tasa_mora (barrio_id, tasa_mensual, vigente_desde) values ($1, 0.03, current_date - 300)",
      [barrioId],
    );
  }

  await admin.query(
    "insert into mandato_administracion (barrio_id, administrador_id, desde) values ($1,$2,current_date - 100)",
    [arbol.barrioA1.id, arbol.adminA.id],
  );
  await admin.query(
    // El tope de CARGOS del operador (0025) es holgado a propósito: los ataques de este archivo van
    // contra otras cosas y no tienen que rebotar en él. El techo se ejercita en el bloque 8.
    `insert into limite_aplicacion_barrio (barrio_id, monto_max_operador, porcentaje_max_operador,
                                           monto_max_cargo_operador, vigente_desde)
     values ($1, '10000.00', 12.000000, '200000.00', current_date - 300)`,
    [arbol.barrioA1.id],
  );

  const conceptoDeGasto = async (barrioId: string, nombre: string) => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
       values ($1,$2,'ordinaria','sin_clasificar') returning id`,
      [barrioId, nombre],
    );
    return rows[0]?.id as string;
  };
  conceptoGastoA1 = await conceptoDeGasto(arbol.barrioA1.id, "Seguridad");
  conceptoGastoA2 = await conceptoDeGasto(arbol.barrioA2.id, "Mantenimiento");

  const acta = async (barrioId: string, titulo: string) => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into documento_barrio (barrio_id, tipo, titulo, fecha_documento)
       values ($1,'acta_asamblea',$2, current_date - 30) returning id`,
      [barrioId, titulo],
    );
    return rows[0]?.id as string;
  };
  actaA1 = await acta(arbol.barrioA1.id, "Acta de Los Álamos");
  actaA2 = await acta(arbol.barrioA2.id, "Acta RESERVADA de San Isidro");

  const alta = async (
    barrioId: string,
    nombre: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> => {
    const { conceptoId } = await como(arbol.usuarios.adminEstudioA, (tx) =>
      crearConceptoBoleta(tx, {
        barrioId,
        nombre,
        clase: "cargo",
        metodo: "precio_x_cantidad",
        baseCalculo: "sin_base",
        clasificacionFiscal: "ingreso_ajeno",
        financiamiento: null,
        requiereAdmin: false,
        ordenImpresion: 0,
        vigenteDesde: "2020-01-01",
        montoFijo: null,
        porcentaje: null,
        precioUnitario: "1500.00",
        tope: null,
        ...extra,
      } as Parameters<typeof crearConceptoBoleta>[1]),
    );
    return conceptoId;
  };
  quinchoA1 = await alta(arbol.barrioA1.id, "Quincho A1");
  quinchoA2 = await alta(arbol.barrioA2.id, "Quincho A2");
  fijoA1 = await alta(arbol.barrioA1.id, "Cargo fijo A1", {
    metodo: "monto_fijo",
    montoFijo: "45000.00",
    precioUnitario: null,
  });
});

afterAll(async () => {
  const barrios = [arbol.barrioA1.id, arbol.barrioA2.id, arbol.barrioB1.id];
  await admin.query("set session_replication_role = replica");
  for (const tabla of TABLAS_A_LIMPIAR) {
    await admin.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [barrios]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1. INYECTAR PLATA — campos de más y cantidades raras
// ════════════════════════════════════════════════════════════════════════════════════════════

describe("1. inyectar plata", () => {
  it("campos de más en aplicarConceptoAUnidad no llegan a ninguna columna", async () => {
    const periodoId = await periodoNuevo("2040-01");
    const aplicada = await como(arbol.usuarios.operadorA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[0] as string,
        conceptoBoletaId: quinchoA1,
        fechaHecho: "2040-01-15",
        cantidad: "1",
        detalle: "Con basura adjunta",
        origenEvaluacion: "carga_manual",
        // ── todo lo que sigue es contrabando ──
        precio_unitario: "9500000.00",
        precioUnitario: "9500000.00",
        monto_fijo: "9500000.00",
        montoFijo: "9500000.00",
        importe_resuelto: "9500000.00",
        importeResuelto: "9500000.00",
        importe_sin_tope: "9500000.00",
        base_calculada: "9500000.00",
        barrio_id: arbol.barrioA2.id,
        barrioId: arbol.barrioA2.id,
        clase: "descuento",
        nombre_concepto: "Nombre inventado",
        nombreConcepto: "Nombre inventado",
        aplicado_por: arbol.usuarios.adminEstudioB,
        aplicadoPor: arbol.usuarios.adminEstudioB,
        tope: "1.00",
        anulado_at: null,
      } as unknown as Parameters<typeof aplicarConceptoAUnidad>[1]),
    );

    const { rows } = await admin.query<Record<string, string | null>>(
      `select precio_unitario::text as precio, monto_fijo::text as fijo, importe_resuelto::text as imp,
              base_calculada::text as base, barrio_id::text, clase::text, nombre_concepto,
              aplicado_por::text, tope::text, cantidad::text
         from concepto_boleta_unidad where id = $1`,
      [aplicada.id],
    );
    const f = rows[0] as Record<string, string | null>;
    expect(f["precio"]).toBe("1500.00");
    expect(f["fijo"]).toBeNull();
    expect(f["imp"]).toBeNull();
    expect(f["base"]).toBeNull();
    expect(f["barrio_id"]).toBe(arbol.barrioA1.id);
    expect(f["clase"]).toBe("cargo");
    expect(f["nombre_concepto"]).toBe("Quincho A1");
    expect(f["aplicado_por"]).toBe(arbol.usuarios.operadorA1);
    expect(f["tope"]).toBeNull();
    expect(aplicada.importeEstimado).toBe("1500.00");
  });

  it("campos de más en crearPeriodo, registrarGasto y registrarValorConcepto tampoco", async () => {
    const { id: periodoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearPeriodo(tx, {
        barrioId: arbol.barrioA1.id,
        periodo: "2040-02",
        // `modelo` es un campo REAL del esquema desde el 2026-08-04, así que va acá arriba y no
        // entre los inyectados: pedir `variable` y recibir `variable` no prueba nada sobre el
        // descarte. Que sí se respete cuando se pide `fija` lo prueba el caso de abajo.
        modelo: "variable",
        primerVencimiento: null,
        segundoVencimiento: null,
        notas: null,
        estado: "emitida",
        emitida_at: "2000-01-01",
        emitida_por: arbol.usuarios.adminEstudioB,
        total_gastos: "999999.99",
      } as unknown as Parameters<typeof crearPeriodo>[1]),
    );
    const { rows: per } = await admin.query<{ estado: string; modelo: string; total: string | null }>(
      "select estado::text as estado, modelo::text as modelo, total_gastos::text as total from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(per[0]?.estado).toBe("borrador");
    expect(per[0]?.modelo).toBe("variable");
    expect(per[0]?.total).toBeNull();

    const gasto = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "1000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
        barrio_id: arbol.barrioA2.id,
        barrioId: arbol.barrioA2.id,
        sin_respaldo_asamblea: true,
        sinRespaldoAsamblea: true,
      } as unknown as Parameters<typeof registrarGasto>[1]),
    );
    const { rows: g } = await admin.query<{ barrio: string; marca: boolean }>(
      "select barrio_id::text as barrio, sin_respaldo_asamblea as marca from gasto_periodo where id = $1",
      [gasto.id],
    );
    expect(g[0]?.barrio).toBe(arbol.barrioA1.id);
    expect(g[0]?.marca).toBe(false);

    const { valorId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      registrarValorConcepto(tx, {
        conceptoBoletaId: fijoA1,
        vigenteDesde: "2041-01-01",
        montoFijo: "50000.00",
        porcentaje: null,
        precioUnitario: null,
        tope: null,
        barrio_id: arbol.barrioB1.id,
        barrioId: arbol.barrioB1.id,
        metodo: "porcentaje",
        vigente_hasta: "2999-01-01",
        vigenteHasta: "2999-01-01",
        aprobada_por: arbol.usuarios.adminEstudioB,
      } as unknown as Parameters<typeof registrarValorConcepto>[1]),
    );
    const { rows: v } = await admin.query<Record<string, string | null>>(
      `select barrio_id::text, metodo::text, vigente_hasta::text, aprobada_por::text
         from concepto_boleta_valor where id = $1`,
      [valorId],
    );
    expect(v[0]?.["barrio_id"]).toBe(arbol.barrioA1.id);
    expect(v[0]?.["metodo"]).toBe("monto_fijo");
    expect(v[0]?.["vigente_hasta"]).toBeNull();
    expect(v[0]?.["aprobada_por"]).toBe(arbol.usuarios.adminBarrioA1);
  });

  it("la cantidad: qué entra y qué no", async () => {
    const periodoId = await periodoNuevo("2040-03");
    const aplicar = (cantidad: unknown, unidad = 0) =>
      como(arbol.usuarios.operadorA1, (tx) =>
        aplicarConceptoAUnidad(tx, {
          periodoId,
          unidadFuncionalId: unidadesA1[unidad] as string,
          conceptoBoletaId: quinchoA1,
          fechaHecho: "2040-03-15",
          cantidad: cantidad as string,
          detalle: `cantidad ${String(cantidad)}`,
          origenEvaluacion: "carga_manual",
        }),
      );

    // Rechazadas por Zod, sin tocar la base.
    for (const malo of [
      "1e3",
      "1E3",
      " 1",
      "1 ",
      "-1",
      "-1.000",
      "+1",
      "1,5",
      "0x10",
      "Infinity",
      "NaN",
      "1.0001",
      "١٠",
      "1\n",
    ]) {
      await expect(aplicar(malo), `cantidad ${JSON.stringify(malo)}`).rejects.toThrow(/cantidad inválida/i);
    }
    // Números (no strings) también.
    await expect(aplicar(1000)).rejects.toThrow();

    // `""` NO está en la lista de arriba desde el 2026-07-28: un `<input>` vacío manda `""` —`null`
    // no existe en un `FormData`—, así que `opcionalDeFormulario` lo lee como "no cargada" y la base
    // usa 1 (`coalesce(new.cantidad, 1)` en `app.cbu_antes`, solo para `precio_x_cantidad`). Dejar
    // el campo en blanco cobra UNA reserva, que es lo que la pantalla dice; lo que no puede es
    // inventar un número más grande. Eso es lo que verifica este renglón.
    const vacia = await aplicar("", 1);
    expect(vacia.importeEstimado).toBe("1500.00");

    // Rechazadas por la base (`cbu_cantidad_chk`: > 0 y <= 100).
    const cero = await capturar(() => aplicar("0"));
    expect(cero.codigo).toBe("dato_invalido");
    const pasado = await capturar(() => aplicar("101"));
    expect(pasado.codigo).toBe("dato_invalido");
    // CORREGIDO: el desborde de numeric(12,3) daba un código de soporte ("No se pudo completar la
    // operación"), que es el peor mensaje posible para el error de tipeo más común de una pantalla
    // de carga. Ahora `22003` tiene su regla.
    const gigante = await capturar(() => aplicar("999999999999999999999"));
    console.log("[ataques] cantidad que desborda numeric(12,3) →", gigante.codigo, "|", gigante.message);
    expect(gigante.codigo).toBe("dato_invalido");
    expect(gigante.sugerencia).toMatch(/cero de más/i);

    // El techo real: 100 × 1500 = 150.000 en una sola aplicación, por un `operador`.
    const maxima = await aplicar("100");
    expect(maxima.importeEstimado).toBe("150000.00");
  });

  it("el monto de un gasto: qué entra y qué no", async () => {
    const periodoId = await periodoNuevo("2040-04");
    const cargar = (monto: unknown) =>
      como(arbol.usuarios.operadorA1, (tx) =>
        registrarGasto(tx, {
          periodoId,
          conceptoId: conceptoGastoA1,
          descripcion: "x",
          monto: monto as string,
          proveedorNombre: null,
          comprobante: null,
          actaDocumentoId: null,
        }),
      );

    for (const malo of ["1e3", " 100.00", "100.00 ", "100", "100.000", "+100.00", "1,00", "100.00\n", "NaN"]) {
      await expect(cargar(malo), `monto ${JSON.stringify(malo)}`).rejects.toThrow(/monto inválido/i);
    }
    for (const negativo of ["-100.00", "-0.00"]) {
      await expect(cargar(negativo)).rejects.toThrow(/no puede ser negativo/i);
    }

    // Desborde de numeric(14,2): pasa Zod y explota en la base.
    const desborde = await capturar(() => cargar("99999999999999.99"));
    // ¿qué código sale? Lo dice el test, no lo asume.
    console.log("[ataques] monto que desborda numeric(14,2) →", desborde.codigo, "|", desborde.message);
    expect(["dato_invalido", "desconocido"]).toContain(desborde.codigo);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 2. CRUZAR DE BARRIO
// ════════════════════════════════════════════════════════════════════════════════════════════

describe("2. cruzar de barrio", () => {
  it("matriz completa de (periodo, unidad, concepto) para el admin del estudio", async () => {
    const pA1 = await periodoNuevo("2042-01", arbol.barrioA1.id);
    const pA2 = await periodoNuevo("2042-01", arbol.barrioA2.id);
    const combos: Array<[string, string, string, string]> = [
      ["periodo A1 + unidad A1 + concepto A2", pA1, unidadesA1[0] as string, quinchoA2],
      ["periodo A1 + unidad A2 + concepto A2", pA1, unidadesA2[0] as string, quinchoA2],
      ["periodo A2 + unidad A2 + concepto A1", pA2, unidadesA2[0] as string, quinchoA1],
      ["periodo A2 + unidad A1 + concepto A2", pA2, unidadesA1[0] as string, quinchoA2],
      ["periodo A1 + unidad A2 + concepto A1", pA1, unidadesA2[0] as string, quinchoA1],
      ["periodo A2 + unidad A1 + concepto A1", pA2, unidadesA1[0] as string, quinchoA1],
    ];
    for (const [nombre, periodoId, unidadFuncionalId, conceptoBoletaId] of combos) {
      const e = await capturar(() =>
        como(arbol.usuarios.adminEstudioA, (tx) =>
          aplicarConceptoAUnidad(tx, {
            periodoId,
            unidadFuncionalId,
            conceptoBoletaId,
            fechaHecho: "2042-01-10",
            cantidad: "1",
            detalle: nombre,
            origenEvaluacion: "carga_manual",
          }),
        ),
      );
      console.log(`[ataques] ${nombre} → ${e.codigo}`);
      expect(e.codigo, nombre).toBe("referencia_de_otro_barrio");
    }
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from concepto_boleta_unidad where periodo_id = any($1::uuid[])",
      [[pA1, pA2]],
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("un acta de OTRO barrio no respalda un gasto, ni al cargarlo ni al corregirlo", async () => {
    const periodoId = await periodoNuevo("2042-02", arbol.barrioA1.id);

    const alAlta = await capturar(() =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        registrarGasto(tx, {
          periodoId,
          conceptoId: conceptoGastoA1,
          descripcion: "Con acta ajena",
          monto: "1000.00",
          proveedorNombre: null,
          comprobante: null,
          actaDocumentoId: actaA2,
        }),
      ),
    );
    expect(alAlta.codigo).toBe("referencia_de_otro_barrio");
    expect(alAlta.message).not.toMatch(/RESERVADA/i);

    const gasto = await como(arbol.usuarios.adminEstudioA, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Sano",
        monto: "1000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: actaA1,
      }),
    );
    const alCorregir = await capturar(() =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        corregirGasto(tx, {
          gastoId: gasto.id,
          descripcion: "Con acta ajena",
          monto: "1000.00",
          proveedorNombre: null,
          comprobante: null,
          actaDocumentoId: actaA2,
        }),
      ),
    );
    expect(alCorregir.codigo).toBe("referencia_de_otro_barrio");
    expect(alCorregir.message).not.toMatch(/RESERVADA/i);
  });

  it("registrarValorConcepto no deja mover el valor a otro barrio ni tocar un concepto ajeno", async () => {
    // adminEstudioA llega a A1 y A2: el valor tiene que caer en el barrio DEL CONCEPTO.
    const { valorId } = await como(arbol.usuarios.adminEstudioA, (tx) =>
      registrarValorConcepto(tx, {
        conceptoBoletaId: quinchoA2,
        vigenteDesde: "2043-01-01",
        montoFijo: null,
        porcentaje: null,
        precioUnitario: "2000.00",
        tope: null,
      }),
    );
    const { rows } = await admin.query<{ barrio: string }>(
      "select barrio_id::text as barrio from concepto_boleta_valor where id = $1",
      [valorId],
    );
    expect(rows[0]?.barrio).toBe(arbol.barrioA2.id);

    // Un admin de un solo barrio no llega al concepto del hermano.
    const e = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        registrarValorConcepto(tx, {
          conceptoBoletaId: quinchoA2,
          vigenteDesde: "2043-02-01",
          montoFijo: null,
          porcentaje: null,
          precioUnitario: "1.00",
          tope: null,
        }),
      ),
    );
    expect(e.codigo).toBe("concepto_no_encontrado");
  });

  it("crearConceptoBoleta con el barrioId del hermano lo tiene que decidir el rol, no el parámetro", async () => {
    const e = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        crearConceptoBoleta(tx, {
          barrioId: arbol.barrioA2.id,
          nombre: "Colado en A2",
          clase: "cargo",
          metodo: "monto_fijo",
          baseCalculo: "sin_base",
          clasificacionFiscal: "ingreso_ajeno",
          financiamiento: null,
          requiereAdmin: false,
          ordenImpresion: 0,
          vigenteDesde: "2020-01-01",
          montoFijo: "1.00",
          porcentaje: null,
          precioUnitario: null,
          tope: null,
        }),
      ),
    );
    expect(e.codigo).toBe("sin_permiso");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 3. LA FUGA POR EL CANAL DE ERROR
// ════════════════════════════════════════════════════════════════════════════════════════════

describe("3. fuga por el canal de error", () => {
  it("CORREGIDO: el estado de un período de un barrio INACCESIBLE ya no se lee por el error", async () => {
    // Dos períodos en B1 (barrio de otro estudio, invisible para operadorA1): uno en borrador y uno
    // emitido. Se emite por la puerta de mantenimiento para no depender del cuadre.
    const { rows: b } = await admin.query<{ id: string }>(
      `insert into periodo_expensa (barrio_id, periodo) values ($1,'2044-01'), ($1,'2044-02') returning id`,
      [arbol.barrioB1.id],
    );
    const borradorB1 = b[0]?.id as string;
    const emitidoB1 = b[1]?.id as string;
    await admin.query("set session_replication_role = replica");
    await admin.query("update periodo_expensa set estado='emitida', emitida_at = now() where id = $1", [
      emitidoB1,
    ]);
    await admin.query("set session_replication_role = origin");

    const sondear = (periodoId: string) =>
      capturar(() =>
        como(arbol.usuarios.operadorA1, (tx) =>
          aplicarConceptoAUnidad(tx, {
            periodoId,
            unidadFuncionalId: unidadesA1[0] as string,
            conceptoBoletaId: quinchoA1, // concepto legítimo de MI barrio
            fechaHecho: "2044-01-10",
            cantidad: "1",
            detalle: "sonda",
            origenEvaluacion: "carga_manual",
          }),
        ),
      );

    const inexistente = await sondear("00000000-0000-4000-8000-0000000000aa");
    const enBorrador = await sondear(borradorB1);
    const yaEmitido = await sondear(emitidoB1);

    console.log("[ataques] sonda uuid inexistente  →", inexistente.codigo, JSON.stringify(inexistente.datos));
    console.log("[ataques] sonda período B1 borrador →", enBorrador.codigo, JSON.stringify(enBorrador.datos));
    console.log("[ataques] sonda período B1 emitido  →", yaEmitido.codigo, JSON.stringify(yaEmitido.datos));

    // Antes los tres eran distinguibles: el uuid de un período ajeno era un oráculo de existencia Y
    // de estado, porque `app.periodo_editable()` es `security definer`, lee `periodo_expensa` sin
    // RLS e interpolaba el estado en el `raise` — y corría ANTES de que la FK compuesta lo tapara.
    //
    // La migración 0023 (agujero 2) mueve la verificación a `app.cbu_antes()`, que corre primero y
    // contesta lo mismo en los tres casos cuando el usuario no tiene acceso al barrio del período.
    for (const r of [inexistente, enBorrador, yaEmitido]) {
      expect(r.codigo).toBe("referencia_de_otro_barrio");
      expect(r.message).toBe(inexistente.message);
      // Y nada del estado del período ajeno viaja en los datos que ve la pantalla.
      expect(r.datos["estado"]).toBeUndefined();
    }
    expect(JSON.stringify(yaEmitido.datos)).not.toContain("emitida");
  });

  it("HALLAZGO: app.resolver_aplicaciones distingue 'no existe' de 'no tenés permiso'", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into periodo_expensa (barrio_id, periodo) values ($1,'2044-03') returning id`,
      [arbol.barrioB1.id],
    );
    const ajeno = rows[0]?.id as string;

    const sondear = (periodoId: string) =>
      capturarCrudo(() =>
        como(arbol.usuarios.operadorA1, (tx) =>
          tx.execute(sql`select app.resolver_aplicaciones(${periodoId})`),
        ),
      );

    const existe = (await sondear(ajeno)) as { message?: string };
    const noExiste = (await sondear("00000000-0000-4000-8000-0000000000ab")) as { message?: string };
    console.log("[ataques] resolver_aplicaciones período ajeno   →", existe.message);
    console.log("[ataques] resolver_aplicaciones uuid inexistente →", noExiste.message);
    expect(existe.message).toMatch(/no tenés permiso para liquidar/);
    expect(noExiste.message).toMatch(/no existe/);
  });

  it("CORREGIDO: mandato_administracion ya no revela existencia ni tipo de un nodo arbitrario", async () => {
    // `operador` puede escribir `mandato_administracion` (0003). El trigger de la 0020 validaba
    // contra `tenant_node` en `security definer` e **interpolaba el tipo del nodo** en el mensaje,
    // así que probando uuids se leía existencia Y tipo de cualquier nodo del sistema. La 0024 lo
    // uniforma: un solo mensaje para todo lo que el usuario no puede ver.
    const sondear = (administradorId: string) =>
      capturarCrudo(() =>
        como(arbol.usuarios.operadorA1, (tx) =>
          tx.execute(sql`
            insert into mandato_administracion (barrio_id, administrador_id, desde)
            values (${arbol.barrioA1.id}, ${administradorId}, current_date)
          `),
        ),
      );

    const nodoAjeno = (await sondear(arbol.barrioB1.id)) as { message?: string };
    const inexistente = (await sondear("00000000-0000-4000-8000-0000000000ac")) as { message?: string };
    console.log("[ataques] mandato con nodo de otro estudio →", nodoAjeno.message);
    console.log("[ataques] mandato con uuid inexistente      →", inexistente.message);
    // Los dos casos, indistinguibles. Y el tipo del nodo ajeno no aparece por ningún lado.
    expect(nodoAjeno.message).toMatch(/no existe o no es accesible/);
    expect(inexistente.message).toBe(nodoAjeno.message);
    expect(nodoAjeno.message).not.toMatch(/barrio\)|subsector|llegó/);
  });

  it("app.concepto_valor_vigente NO responde por conceptos de otro barrio (queda cerrado)", async () => {
    const r = await como(arbol.usuarios.operadorA1, (tx) =>
      tx.execute<{ v: string | null }>(
        sql`select app.concepto_valor_vigente(${quinchoA2}, '2043-06-01'::date) as v`,
      ),
    );
    console.log("[ataques] concepto_valor_vigente(concepto de A2) →", r.rows[0]?.v);
    expect(r.rows[0]?.v).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 4. LA ANULACIÓN
// ════════════════════════════════════════════════════════════════════════════════════════════

describe("4. la anulación", () => {
  async function periodoConAplicacion(mes: string, unidad = 0): Promise<{ periodoId: string; id: string }> {
    const periodoId = await periodoNuevo(mes);
    const aplicada = await como(arbol.usuarios.operadorA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[unidad] as string,
        conceptoBoletaId: fijoA1,
        fechaHecho: `${mes}-10`,
        cantidad: null,
        detalle: "para anular",
        origenEvaluacion: "carga_manual",
      }),
    );
    return { periodoId, id: aplicada.id };
  }

  it("anular DOS VECES en la MISMA transacción", async () => {
    const { id } = await periodoConAplicacion("2045-01");
    const e = await capturar(() =>
      como(arbol.usuarios.operadorA1, async (tx) => {
        await anularAplicacion(tx, { aplicacionId: id, motivo: "Primera anulación del vecino" });
        await anularAplicacion(tx, { aplicacionId: id, motivo: "Segunda, para pisar el motivo" });
      }),
    );
    expect(e.codigo).toBe("aplicacion_ya_anulada");
    // La transacción entera se va: no queda ni la primera anulación. Sano, pero implica que un
    // llamador que batchee anulaciones pierde todas por una repetida.
    const { rows } = await admin.query<{ motivo: string | null; n: string }>(
      `select c.motivo_anulacion as motivo,
              (select count(*)::text from concepto_boleta_unidad_evento where aplicacion_id = c.id
                and evento = 'anulacion') as n
         from concepto_boleta_unidad c where c.id = $1`,
      [id],
    );
    console.log("[ataques] tras la doble anulación en una tx → motivo:", rows[0]?.motivo, "| eventos:", rows[0]?.n);
    expect(rows[0]?.motivo).toBeNull();
    expect(rows[0]?.n).toBe("0");
  });

  it("anular en un período YA EMITIDO", async () => {
    const periodoId = await periodoNuevo("2045-02");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "400000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    const aplicada = await como(arbol.usuarios.operadorA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[0] as string,
        conceptoBoletaId: fijoA1,
        fechaHecho: "2045-02-10",
        cantidad: null,
        detalle: "cargo del quincho",
        origenEvaluacion: "carga_manual",
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId }));

    const e = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        anularAplicacion(tx, { aplicacionId: aplicada.id, motivo: "Después de emitir, a ver si entra" }),
      ),
    );
    console.log("[ataques] anular en período emitido →", e.codigo, "|", e.message);
    expect(e.codigo).toBe("periodo_no_editable");

    const { rows } = await admin.query<{ anulado: string | null; monto: string | null }>(
      `select c.anulado_at::text as anulado, i.monto::text as monto
         from concepto_boleta_unidad c
         left join item_liquidacion i on i.aplicacion_id = c.id
        where c.id = $1`,
      [aplicada.id],
    );
    expect(rows[0]?.anulado).toBeNull();
    // El cargo sigue en la boleta emitida, con el importe que se congeló.
    expect(rows[0]?.monto).toBe("50000.00");
  });

  it("un rol de solo lectura no anula, y no lo hace en silencio", async () => {
    const { id } = await periodoConAplicacion("2045-03", 1);
    const e = await capturar(() =>
      como(arbol.usuarios.contadorA1, (tx) =>
        anularAplicacion(tx, { aplicacionId: id, motivo: "El contador se manda solo" }),
      ),
    );
    expect(e.codigo).toBe("aplicacion_no_encontrada");
    const { rows } = await admin.query<{ anulado: string | null }>(
      "select anulado_at::text as anulado from concepto_boleta_unidad where id = $1",
      [id],
    );
    expect(rows[0]?.anulado).toBeNull();
  });

  it("el motivo no se reescribe ni se borra por ningún camino de SQL directo", async () => {
    const { id } = await periodoConAplicacion("2045-04", 2);
    await como(arbol.usuarios.operadorA1, (tx) =>
      anularAplicacion(tx, { aplicacionId: id, motivo: "Motivo original que queda archivado" }),
    );

    const caminos: Array<[string, () => Promise<unknown>]> = [
      [
        "reescribir el motivo",
        () =>
          como(arbol.usuarios.operadorA1, (tx) =>
            tx.execute(sql`update concepto_boleta_unidad set motivo_anulacion = 'otro' where id = ${id}`),
          ),
      ],
      [
        "revertir la anulación",
        () =>
          como(arbol.usuarios.operadorA1, (tx) =>
            tx.execute(
              sql`update concepto_boleta_unidad set anulado_at = null, anulado_por = null, motivo_anulacion = null where id = ${id}`,
            ),
          ),
      ],
      [
        "borrar la aplicación",
        () =>
          como(arbol.usuarios.operadorA1, (tx) =>
            tx.execute(sql`delete from concepto_boleta_unidad where id = ${id}`),
          ),
      ],
      [
        "borrar el evento",
        () =>
          como(arbol.usuarios.operadorA1, (tx) =>
            tx.execute(sql`delete from concepto_boleta_unidad_evento where aplicacion_id = ${id}`),
          ),
      ],
      [
        "reescribir el evento",
        () =>
          como(arbol.usuarios.operadorA1, (tx) =>
            tx.execute(sql`update concepto_boleta_unidad_evento set motivo = 'otro' where aplicacion_id = ${id}`),
          ),
      ],
    ];
    for (const [nombre, fn] of caminos) {
      const e = (await capturarCrudo(fn)) as { message?: string };
      console.log(`[ataques] ${nombre} →`, e.message);
    }
    const { rows } = await admin.query<{ motivo: string; eventos: string }>(
      `select c.motivo_anulacion as motivo,
              (select count(*)::text from concepto_boleta_unidad_evento where aplicacion_id = c.id) as eventos
         from concepto_boleta_unidad c where c.id = $1`,
      [id],
    );
    expect(rows[0]?.motivo).toBe("Motivo original que queda archivado");
    expect(Number(rows[0]?.eventos)).toBeGreaterThanOrEqual(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 5. VIGENCIA DEL VALOR — dos valores vigentes el mismo día
// ════════════════════════════════════════════════════════════════════════════════════════════

describe("5. la vigencia del valor del catálogo", () => {
  it("CORREGIDO: un valor nuevo con la MISMA fecha deja UNO SOLO vigente, y es el nuevo", async () => {
    const { conceptoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearConceptoBoleta(tx, {
        barrioId: arbol.barrioA1.id,
        nombre: "Cargo con vigencia ambigua",
        clase: "cargo",
        metodo: "monto_fijo",
        baseCalculo: "sin_base",
        clasificacionFiscal: "ingreso_ajeno",
        financiamiento: null,
        requiereAdmin: false,
        ordenImpresion: 0,
        vigenteDesde: "2046-01-01",
        montoFijo: "1000.00",
        porcentaje: null,
        precioUnitario: null,
        tope: null,
      }),
    );
    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      registrarValorConcepto(tx, {
        conceptoBoletaId: conceptoId,
        vigenteDesde: "2046-01-01", // MISMA fecha que el anterior
        montoFijo: "9000.00",
        porcentaje: null,
        precioUnitario: null,
        tope: null,
      }),
    );

    const { rows } = await admin.query<{ desde: string; hasta: string | null; monto: string }>(
      `select vigente_desde::text as desde, vigente_hasta::text as hasta, monto_fijo::text as monto
         from concepto_boleta_valor where concepto_boleta_id = $1 order by monto_fijo`,
      [conceptoId],
    );
    console.log("[ataques] vigencias tras el valor con misma fecha →", JSON.stringify(rows));

    // El trigger cierra el anterior con `vigente_hasta = vigente_desde` del nuevo. Con el filtro
    // INCLUSIVO que usaba `app.cbu_antes()` los dos matcheaban el 2046-01-01 y el desempate lo
    // decidía el plan: se llegó a congelar el precio VIEJO el día en que ya regía el nuevo.
    // La 0023 (agujero 3) lo pasa a estricto, que es la convención del resto del modelo (0018 §6).
    const { rows: vigentes } = await admin.query<{ n: string }>(
      `select count(*)::text as n from concepto_boleta_valor
        where concepto_boleta_id = $1 and vigente_desde <= '2046-01-01'
          and (vigente_hasta is null or vigente_hasta > '2046-01-01')`,
      [conceptoId],
    );
    expect(vigentes[0]?.n).toBe("1");

    // Y lo que se congela es el precio NUEVO, de forma determinista.
    const periodoId = await periodoNuevo("2046-01");
    const aplicada = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[0] as string,
        conceptoBoletaId: conceptoId,
        fechaHecho: "2046-01-01",
        cantidad: null,
        detalle: "en el día del empate",
        origenEvaluacion: "carga_manual",
      }),
    );
    console.log("[ataques] importe congelado en el día del traspaso →", aplicada.importeEstimado);
    expect(aplicada.importeEstimado).toBe("9000.00");
  });

  it("un valor con fecha ANTERIOR al vigente: qué mensaje ve la persona", async () => {
    const { conceptoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearConceptoBoleta(tx, {
        barrioId: arbol.barrioA1.id,
        nombre: "Cargo con retro",
        clase: "cargo",
        metodo: "monto_fijo",
        baseCalculo: "sin_base",
        clasificacionFiscal: "ingreso_ajeno",
        financiamiento: null,
        requiereAdmin: false,
        ordenImpresion: 0,
        vigenteDesde: "2047-06-01",
        montoFijo: "1000.00",
        porcentaje: null,
        precioUnitario: null,
        tope: null,
      }),
    );
    const e = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        registrarValorConcepto(tx, {
          conceptoBoletaId: conceptoId,
          vigenteDesde: "2047-01-01",
          montoFijo: "2000.00",
          porcentaje: null,
          precioUnitario: null,
          tope: null,
        }),
      ),
    );
    console.log("[ataques] valor retroactivo →", e.codigo, "|", e.message, "|", e.sugerencia);
    expect(e.codigo).toBeTruthy();
  });

  it("un porcentual SIN tope por la puerta de registrarValorConcepto (Zod no replica la regla)", async () => {
    const { conceptoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearConceptoBoleta(tx, {
        barrioId: arbol.barrioA1.id,
        nombre: "Descuento con techo",
        clase: "descuento",
        metodo: "porcentaje",
        baseCalculo: "expensa_ordinaria",
        clasificacionFiscal: "no_alcanzado",
        financiamiento: "partida_presupuestada",
        requiereAdmin: false,
        ordenImpresion: 0,
        vigenteDesde: "2048-01-01",
        montoFijo: null,
        porcentaje: "10",
        precioUnitario: null,
        tope: "8000.00",
      }),
    );
    const e = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        registrarValorConcepto(tx, {
          conceptoBoletaId: conceptoId,
          vigenteDesde: "2048-06-01",
          montoFijo: null,
          porcentaje: "50",
          precioUnitario: null,
          tope: null, // sin techo
        }),
      ),
    );
    console.log("[ataques] porcentual sin tope por registrarValorConcepto →", e.codigo, "|", e.message);
    expect(e.codigo).toBe("dato_invalido");
    expect(e.message).toMatch(/tope/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 6. CONCURRENCIA
// ════════════════════════════════════════════════════════════════════════════════════════════

describe("6. concurrencia", () => {
  /** Dos conexiones distintas de verdad (el pool de tests tiene max 4). */
  function dosConexiones(): [DbRequest, DbRequest] {
    return [crearDbRequest(appPool), crearDbRequest(appPool)];
  }

  it("dos emisiones simultáneas del mismo período", async () => {
    const periodoId = await periodoNuevo("2050-01");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "800000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const [a, b] = dosConexiones();
    const resultados = await Promise.allSettled([
      conUsuario(a, arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId })),
      conUsuario(b, arbol.usuarios.adminBarrioA1, (tx) => emitirPeriodo(tx, { periodoId })),
    ]);
    const ok = resultados.filter((r) => r.status === "fulfilled");
    const fallos = resultados.filter((r) => r.status === "rejected");
    console.log(
      "[ataques] emisión concurrente →",
      ok.length,
      "éxitos,",
      fallos.map((f) => (esErrorDeNegocio(f.reason) ? f.reason.codigo : String(f.reason))).join(","),
    );
    expect(ok).toHaveLength(1);
    expect(fallos).toHaveLength(1);

    const { rows } = await admin.query<{ estado: string; n: string }>(
      `select estado::text as estado,
              (select count(*)::text from liquidacion where periodo_id = $1) as n
         from periodo_expensa where id = $1`,
      [periodoId],
    );
    expect(rows[0]?.estado).toBe("emitida");
    expect(rows[0]?.n).toBe("4");
  });

  it("dos anulaciones simultáneas de la misma aplicación", async () => {
    const periodoId = await periodoNuevo("2050-02");
    const aplicada = await como(arbol.usuarios.operadorA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[0] as string,
        conceptoBoletaId: fijoA1,
        fechaHecho: "2050-02-10",
        cantidad: null,
        detalle: "para anular dos veces a la vez",
        origenEvaluacion: "carga_manual",
      }),
    );

    const [a, b] = dosConexiones();
    const resultados = await Promise.allSettled([
      conUsuario(a, arbol.usuarios.operadorA1, (tx) =>
        anularAplicacion(tx, { aplicacionId: aplicada.id, motivo: "Motivo del operador A" }),
      ),
      conUsuario(b, arbol.usuarios.adminBarrioA1, (tx) =>
        anularAplicacion(tx, { aplicacionId: aplicada.id, motivo: "Motivo del administrador B" }),
      ),
    ]);
    const ok = resultados.filter((r) => r.status === "fulfilled");
    console.log(
      "[ataques] anulación concurrente →",
      ok.length,
      "éxitos,",
      resultados
        .filter((r) => r.status === "rejected")
        .map((f) => (esErrorDeNegocio(f.reason) ? f.reason.codigo : String(f.reason)))
        .join(","),
    );
    expect(ok).toHaveLength(1);

    const { rows } = await admin.query<{ motivo: string; n: string }>(
      `select c.motivo_anulacion as motivo,
              (select count(*)::text from concepto_boleta_unidad_evento
                where aplicacion_id = c.id and evento = 'anulacion') as n
         from concepto_boleta_unidad c where c.id = $1`,
      [aplicada.id],
    );
    console.log("[ataques] motivo que quedó →", rows[0]?.motivo, "| eventos de anulación:", rows[0]?.n);
    expect(rows[0]?.n).toBe("1");
  });

  it("dos generaciones simultáneas del borrador del mismo período", async () => {
    const periodoId = await periodoNuevo("2050-03");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "600000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );

    const [a, b] = dosConexiones();
    const resultados = await Promise.allSettled([
      conUsuario(a, arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId })),
      conUsuario(b, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId })),
    ]);
    console.log(
      "[ataques] generación concurrente →",
      resultados.map((r) =>
        r.status === "fulfilled" ? "ok" : esErrorDeNegocio(r.reason) ? r.reason.codigo : String(r.reason),
      ),
    );

    const { rows } = await admin.query<{ n: string; total: string }>(
      `select count(*)::text as n, coalesce(sum(total),0)::text as total from liquidacion where periodo_id = $1`,
      [periodoId],
    );
    console.log("[ataques] liquidaciones tras la carrera →", rows[0]?.n, "total", rows[0]?.total);
    // Cuatro unidades, cuatro boletas, y el total del período tiene que ser el gasto.
    expect(rows[0]?.n).toBe("4");
    expect(rows[0]?.total).toBe("600000.00");
  });

  it("dos altas simultáneas del mismo mes en el mismo barrio", async () => {
    const [a, b] = dosConexiones();
    const alta = (conexion: DbRequest) =>
      conUsuario(conexion, arbol.usuarios.adminBarrioA1, (tx) =>
        crearPeriodo(tx, {
          barrioId: arbol.barrioA1.id,
          periodo: "2050-04",
          modelo: "variable",
          primerVencimiento: null,
          segundoVencimiento: null,
          notas: null,
        }),
      );
    const resultados = await Promise.allSettled([alta(a), alta(b)]);
    const ok = resultados.filter((r) => r.status === "fulfilled");
    console.log(
      "[ataques] alta concurrente del mismo mes →",
      ok.length,
      "éxitos,",
      resultados
        .filter((r) => r.status === "rejected")
        .map((f) => (esErrorDeNegocio(f.reason) ? f.reason.codigo : String(f.reason)))
        .join(","),
    );
    expect(ok).toHaveLength(1);
  });

  /**
   * CORREGIDO (migración 0023, agujero 1) — la ventana entre "el trigger leyó el estado" y "la
   * emisión commiteó".
   *
   * Antes del arreglo, este mismo escenario dejaba un período **EMITIDO** —o sea inmutable— con
   * $77.000 de gasto que ninguna boleta cobraba, y sin camino de vuelta desde la aplicación. Ninguna
   * de las dos transacciones tomaba un lock que la otra viera: `app.periodo_editable` leía el estado
   * sin bloqueo y `app.validar_emision` sumaba `gasto_periodo` con un snapshot que no incluía el
   * gasto sin commitear. Las dos pasaban, las dos commiteaban.
   *
   * Ahora `app.periodo_editable` lee `for share`, así que la emisión **espera** al escritor, después
   * ve su gasto y **rechaza por no cuadrar**. El test es determinista: no hay `sleep`, la emisión se
   * lanza sin esperarla y se libera al escritor a continuación.
   */
  it("un gasto que entra mientras se emite BLOQUEA la emisión en vez de descuadrarla", async () => {
    const periodoId = await periodoNuevo("2052-01");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "500000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const [a, b] = dosConexiones();
    let gastoCargado!: () => void;
    let puedeCommitear!: () => void;
    const elGastoYaEsta = new Promise<void>((r) => (gastoCargado = r));
    const laEmisionTermino = new Promise<void>((r) => (puedeCommitear = r));

    // T2: carga el gasto y se queda con la transacción ABIERTA.
    const cargaLenta = conUsuario(b, arbol.usuarios.adminBarrioA1, async (tx) => {
      await registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Gasto que llega mientras se emite",
        monto: "77000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      });
      gastoCargado();
      await laEmisionTermino; // se commitea DESPUÉS de la emisión
    });

    await elGastoYaEsta;
    // T1: intenta emitir. El `update periodo_expensa` necesita el lock exclusivo de la fila, que T2
    // tiene tomado en modo `share`: **queda esperando**. Por eso NO se hace `await` acá — si se
    // hiciera, el test se colgaría, que es justamente la prueba de que ahora se serializan.
    const emision = capturar(() =>
      conUsuario(a, arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId })),
    );
    puedeCommitear();
    await cargaLenta;

    // Con el gasto ya commiteado, la emisión despierta, re-lee, y el cuadre falla como corresponde.
    const e = await emision;
    expect(e.codigo).toBe("periodo_no_cuadra");
    expect(e.datos["esperado"]).toBe("577000.00");
    expect(e.datos["repartido"]).toBe("500000.00");

    const { rows } = await admin.query<{ estado: string; gastos: string; repartido: string }>(
      `select p.estado::text as estado,
              (select coalesce(sum(monto),0)::text from gasto_periodo where periodo_id = p.id) as gastos,
              (select coalesce(sum(total),0)::text from liquidacion where periodo_id = p.id) as repartido
         from periodo_expensa p where p.id = $1`,
      [periodoId],
    );
    console.log("[ataques] emitir vs cargar gasto (determinista) →", JSON.stringify(rows[0]));

    // Lo que importa: el período sigue EDITABLE. El gasto entró, la emisión no, y el administrador
    // puede regenerar el borrador y emitir de nuevo — que es exactamente el estado recuperable que
    // antes no existía.
    expect(rows[0]?.estado).toBe("borrador");
    expect(rows[0]?.gastos).toBe("577000.00");

    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId }));
    const { rows: final } = await admin.query<{ estado: string; repartido: string }>(
      `select p.estado::text as estado,
              (select coalesce(sum(total),0)::text from liquidacion where periodo_id = p.id) as repartido
         from periodo_expensa p where p.id = $1`,
      [periodoId],
    );
    expect(final[0]?.estado).toBe("emitida");
    expect(final[0]?.repartido).toBe("577000.00");
  });

  /** Lo mismo del lado del cargo: antes quedaba una aplicación sin resolver en un período cerrado. */
  it("un cargo que entra mientras se emite tampoco queda huérfano", async () => {
    const periodoId = await periodoNuevo("2052-02");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "400000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const [a, b] = dosConexiones();
    let listo!: () => void;
    let seguí!: () => void;
    const cargoPuesto = new Promise<void>((r) => (listo = r));
    const emisionLista = new Promise<void>((r) => (seguí = r));

    let aplicacionId = "";
    const cargaLenta = conUsuario(b, arbol.usuarios.adminBarrioA1, async (tx) => {
      const aplicada = await aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[1] as string,
        conceptoBoletaId: fijoA1,
        fechaHecho: "2052-02-10",
        cantidad: null,
        detalle: "cargo que llega mientras se emite",
        origenEvaluacion: "carga_manual",
      });
      aplicacionId = aplicada.id;
      listo();
      await emisionLista;
    });

    await cargoPuesto;
    // Igual que arriba: la emisión queda esperando el lock de la fila del período.
    const emision = capturar(() =>
      conUsuario(a, arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId })),
    );
    seguí();
    await cargaLenta;

    // El cargo entró y no está resuelto, así que el período NO se emite: `validar_emision` lo ve.
    const eCarrera = await emision;
    expect(eCarrera.codigo).toBe("periodo_incompleto");

    const { rows } = await admin.query<{
      estado: string;
      resuelto: string | null;
      items: string;
    }>(
      `select p.estado::text as estado, c.importe_resuelto::text as resuelto,
              (select count(*)::text from item_liquidacion where aplicacion_id = c.id) as items
         from periodo_expensa p, concepto_boleta_unidad c
        where p.id = $1 and c.id = $2`,
      [periodoId, aplicacionId],
    );
    console.log("[ataques] emitir vs aplicar cargo (determinista) →", JSON.stringify(rows[0]));
    expect(rows[0]?.estado).toBe("borrador");

    // Y como sigue editable, regenerar lo resuelve y el cargo termina cobrado.
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId }));
    const { rows: final } = await admin.query<{ resuelto: string | null; items: string }>(
      `select c.importe_resuelto::text as resuelto,
              (select count(*)::text from item_liquidacion where aplicacion_id = c.id) as items
         from concepto_boleta_unidad c where c.id = $1`,
      [aplicacionId],
    );
    expect(final[0]?.resuelto).not.toBeNull();
    expect(final[0]?.items).toBe("1");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 7. ÉXITOS SILENCIOSOS QUE QUEDEN
// ════════════════════════════════════════════════════════════════════════════════════════════

describe("7. éxitos silenciosos", () => {
  it("corregir y borrar un gasto de un período de OTRO barrio (visible para el admin del estudio)", async () => {
    // adminEstudioA VE A2: corregir ahí es legítimo. Lo que se verifica es que operadorA1, que no ve
    // A2, no reciba un éxito.
    const periodoA2 = await periodoNuevo("2051-01", arbol.barrioA2.id);
    const gasto = await como(arbol.usuarios.adminEstudioA, (tx) =>
      registrarGasto(tx, {
        periodoId: periodoA2,
        conceptoId: conceptoGastoA2,
        descripcion: "Gasto de A2",
        monto: "9000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    const corregir = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        corregirGasto(tx, {
          gastoId: gasto.id,
          descripcion: "Pisado desde otro barrio",
          monto: "1.00",
          proveedorNombre: null,
          comprobante: null,
          actaDocumentoId: null,
        }),
      ),
    );
    expect(corregir.codigo).toBe("gasto_no_encontrado");
    const borrar = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) => borrarGasto(tx, { gastoId: gasto.id })),
    );
    expect(borrar.codigo).toBe("gasto_no_encontrado");

    const quedan = await como(arbol.usuarios.adminEstudioA, (tx) => listarGastos(tx, { periodoId: periodoA2 }));
    expect(quedan).toHaveLength(1);
    expect(quedan[0]?.monto).toBe("9000.00");
  });

  it("generarLiquidaciones con un rol de solo lectura no devuelve un resumen falso", async () => {
    const periodoId = await periodoNuevo("2051-02");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "100000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    const e = await capturar(() =>
      como(arbol.usuarios.contadorA1, (tx) => generarLiquidaciones(tx, { periodoId })),
    );
    console.log("[ataques] generar el borrador como contador →", e.codigo, "|", e.message);
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from liquidacion where periodo_id = $1",
      [periodoId],
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("aplicar un concepto en un período EMITIDO", async () => {
    const periodoId = await periodoNuevo("2051-03");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "300000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId }));

    const e = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        aplicarConceptoAUnidad(tx, {
          periodoId,
          unidadFuncionalId: unidadesA1[0] as string,
          conceptoBoletaId: fijoA1,
          fechaHecho: "2051-03-10",
          cantidad: null,
          detalle: "después de emitir",
          origenEvaluacion: "carga_manual",
        }),
      ),
    );
    expect(e.codigo).toBe("periodo_no_editable");
    const lista = await como(arbol.usuarios.operadorA1, (tx) => listarAplicaciones(tx, { periodoId }));
    expect(lista).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 8. EL TECHO DE UN CARGO — ¿puede un operador elegir el importe de una boleta?
// ════════════════════════════════════════════════════════════════════════════════════════════

describe("8. el techo de un cargo", () => {
  // El escenario está armado para que los números se puedan seguir a mano:
  //   · 4 unidades con coeficiente uniforme → $ 400.000 de gasto = **$ 100.000 de expensa cada una**;
  //   · el período 2069-12 se liquida y queda como la expensa de referencia de todas ellas;
  //   · los cargos se prueban en 2070-01, que es el período siguiente y todavía sin liquidar — el
  //     caso real: los cargos se cargan durante el mes, antes de generar el borrador.
  // Con eso, el umbral de confirmación del barrio (3 × la expensa, el default) es **$ 300.000**, y el
  // tope de cargos del `operador` (la fila de `limite_aplicacion_barrio` del fixture) es $ 200.000.
  const EXPENSA = "100000.00";
  const UMBRAL = 300_000;
  let periodoCargos: string;
  let cargoGrande: string; // monto_fijo 3.100.000 — el importe de la boleta que rompió
  let cargoMediano: string; // monto_fijo 250.000 — pasa el tope del operador, no el umbral

  beforeAll(async () => {
    const periodoRef = await periodoNuevo("2069-12");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId: periodoRef,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "400000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId: periodoRef }));
    const { rows } = await admin.query<{ ord: string }>(
      `select subtotal_ordinarias::text as ord from liquidacion
        where periodo_id = $1 and unidad_funcional_id = $2`,
      [periodoRef, unidadesA1[0]],
    );
    // Si esto cambia, los múltiplos que verifican los tests de abajo dejan de ser los del enunciado.
    expect(rows[0]?.ord).toBe(EXPENSA);

    periodoCargos = await periodoNuevo("2070-01");
    const alta = async (nombre: string, monto: string) => {
      const { conceptoId } = await como(arbol.usuarios.adminEstudioA, (tx) =>
        crearConceptoBoleta(tx, {
          barrioId: arbol.barrioA1.id,
          nombre,
          clase: "cargo",
          metodo: "monto_fijo",
          baseCalculo: "sin_base",
          clasificacionFiscal: "ingreso_ajeno",
          financiamiento: null,
          requiereAdmin: false,
          ordenImpresion: 0,
          vigenteDesde: "2020-01-01",
          montoFijo: monto,
          porcentaje: null,
          precioUnitario: null,
          tope: null,
        }),
      );
      return conceptoId;
    };
    cargoGrande = await alta("Rotura del portón (importe de la boleta rota)", "3100000.00");
    cargoMediano = await alta("Cargo mediano", "250000.00");
  });

  /** Aplica un cargo y devuelve lo que escribió la base. */
  const aplicar = (
    usuario: string,
    unidad: number,
    concepto: string,
    extra: { cantidad?: string; confirmar?: boolean; detalle?: string } = {},
  ) =>
    como(usuario, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId: periodoCargos,
        unidadFuncionalId: unidadesA1[unidad] as string,
        conceptoBoletaId: concepto,
        fechaHecho: "2070-01-15",
        cantidad: extra.cantidad ?? null,
        detalle: extra.detalle ?? "Cargo del bloque 8",
        origenEvaluacion: "carga_manual",
        ...(extra.confirmar === undefined ? {} : { confirmarMontoInusual: extra.confirmar }),
      }),
    );

  // ── El operador: el tope es AUTORIZACIÓN, y no se levanta con una confirmación ──────────────

  it("un operador aplica un cargo DENTRO de su tope, y no le piden confirmar nada", async () => {
    // 100 × $ 1.500 = $ 150.000: entra en el tope ($ 200.000) y no llega al umbral ($ 300.000).
    const aplicada = await aplicar(arbol.usuarios.operadorA1, 0, quinchoA1, { cantidad: "100" });
    expect(aplicada.importeEstimado).toBe("150000.00");
    // La base NO marcó la fila: el cargo era normal, así que la confirmación no se archiva aunque
    // el formulario la hubiera mandado.
    expect(aplicada.confirmadoPorMontoInusual).toBe(false);
    expect(150_000).toBeLessThan(UMBRAL);
  });

  it("un operador NO pasa su tope de cargos de una sola vez", async () => {
    const e = await capturar(() => aplicar(arbol.usuarios.operadorA1, 1, cargoMediano));
    expect(e.codigo).toBe("tope_operador");
    console.log("[ataques] cargo por encima del tope del operador →", e.message);
    // Las dos cifras, en el mensaje: sin ellas la persona no sabe qué pedir.
    expect(e.datos["importe"]).toBe("250000.00");
    expect(e.datos["tope"]).toBe("200000.00");
    expect(e.sugerencia).toMatch(/administrador/i);
  });

  it("tampoco lo pasa PARTIÉNDOLO en dos cargos chicos (es el ataque de los $3.100.000)", async () => {
    // La unidad 0 ya tiene $ 150.000 del primer test. Otros $ 150.000 llevan el acumulado a
    // $ 300.000, por encima del tope de $ 200.000. **Cada cargo, de a uno, es legítimo**: el que no
    // lo es, es el total — que es exactamente cómo se llegó a emitir la boleta de $ 3.100.000.
    const e = await capturar(() =>
      aplicar(arbol.usuarios.operadorA1, 0, quinchoA1, { cantidad: "100", detalle: "Segunda reserva" }),
    );
    expect(e.codigo).toBe("tope_operador");
    expect(e.datos["acumulado"]).toBe("300000.00");
    expect(e.datos["tope"]).toBe("200000.00");
    expect(e.sugerencia).toMatch(/por unidad y por período/i);

    // Y la boleta de esa unidad quedó con UN cargo, no con veinte.
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from concepto_boleta_unidad
        where periodo_id = $1 and unidad_funcional_id = $2 and clase = 'cargo' and anulado_at is null`,
      [periodoCargos, unidadesA1[0]],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("la confirmación NO es autorización: con ella, el operador sigue sin pasar su tope", async () => {
    // Es la distinción que ordena todo el bloque. Si el `confirmarMontoInusual` levantara el tope,
    // la pantalla podría mandarlo siempre y el candado del operador dejaría de existir.
    const e = await capturar(() =>
      aplicar(arbol.usuarios.operadorA1, 1, cargoGrande, { confirmar: true }),
    );
    expect(e.codigo).toBe("tope_operador");
    expect(e.codigo).not.toBe("cargo_requiere_confirmacion");
  });

  // ── El administrador: no tiene tope, pero tiene que decir que sí ────────────────────────────

  it("un administrador SIN confirmar es RECHAZADO, y el error trae la cifra concreta", async () => {
    const e = await capturar(() => aplicar(arbol.usuarios.adminBarrioA1, 1, cargoGrande));
    console.log("[ataques] cargo inusual sin confirmar →", e.codigo, "|", e.message);
    // El código propio es lo que la pantalla usa para distinguir "esto está mal" de "esto necesita
    // que confirmes": con `dato_invalido` mostraría un error y no ofrecería seguir.
    expect(e.codigo).toBe("cargo_requiere_confirmacion");
    // $ 3.100.000 sobre una expensa de $ 100.000 = 31 veces. La cifra, no un texto genérico.
    expect(e.message).toMatch(/31 veces la expensa/);
    expect(e.datos["multiplo"]).toBe("31");
    expect(e.datos["importe"]).toBe("3100000.00");
    expect(e.datos["expensa"]).toBe(EXPENSA);

    // Y no entró nada: el rechazo es un rechazo, no una advertencia.
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from concepto_boleta_unidad
        where periodo_id = $1 and unidad_funcional_id = $2`,
      [periodoCargos, unidadesA1[1]],
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("el mismo administrador, confirmando, lo aplica — y la confirmación queda archivada", async () => {
    const aplicada = await aplicar(arbol.usuarios.adminBarrioA1, 1, cargoGrande, { confirmar: true });
    expect(aplicada.importeEstimado).toBe("3100000.00");
    // La marca la escribió la base. Es lo que permite explicar tres meses después por qué esa boleta
    // salió así: quién la aplicó, cuándo, y que confirmó explícitamente un importe fuera de escala.
    expect(aplicada.confirmadoPorMontoInusual).toBe(true);
    const { rows } = await admin.query<{ confirmado: boolean; autor: string }>(
      `select confirmacion_monto_inusual as confirmado, aplicado_por::text as autor
         from concepto_boleta_unidad where id = $1`,
      [aplicada.id],
    );
    expect(rows[0]?.confirmado).toBe(true);
    expect(rows[0]?.autor).toBe(arbol.usuarios.adminBarrioA1);

    // Y no se puede apagar después: la confirmación es parte del snapshot inmutable.
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`
          update concepto_boleta_unidad set confirmacion_monto_inusual = false where id = ${aplicada.id}
        `),
      ),
    ).rejects.toThrow();
  });

  it("al administrador también se le pide confirmar el ACUMULADO, no solo el cargo suelto", async () => {
    // Tres cargos de $ 150.000 sobre la unidad 2: los dos primeros entran ($ 300.000 = el umbral,
    // no lo supera), el tercero lleva el acumulado a $ 450.000 = 4,5 veces la expensa. Sin esto, un
    // administrador podía repetir el ataque de a poco, que es justo lo que el tope del operador
    // frena del otro lado.
    await aplicar(arbol.usuarios.adminBarrioA1, 2, quinchoA1, { cantidad: "100", detalle: "1 de 3" });
    await aplicar(arbol.usuarios.adminBarrioA1, 2, quinchoA1, { cantidad: "100", detalle: "2 de 3" });
    const e = await capturar(() =>
      aplicar(arbol.usuarios.adminBarrioA1, 2, quinchoA1, { cantidad: "100", detalle: "3 de 3" }),
    );
    expect(e.codigo).toBe("cargo_requiere_confirmacion");
    expect(e.datos["multiplo"]).toBe("4.5");
    expect(e.datos["acumulado"]).toBe("450000.00");
    console.log("[ataques] acumulado inusual →", e.message);

    const aplicada = await aplicar(arbol.usuarios.adminBarrioA1, 2, quinchoA1, {
      cantidad: "100",
      detalle: "3 de 3, confirmado",
      confirmar: true,
    });
    expect(aplicada.confirmadoPorMontoInusual).toBe(true);
  });

  it("una unidad sin ninguna boleta previa NO falla abierto: se pide confirmar igual", async () => {
    // Barrio A2: no tiene fila de límite cargada y sus unidades nunca se liquidaron, así que no hay
    // NINGUNA referencia. El sistema no puede afirmar que un importe es normal, y no lo afirma.
    const periodoA2 = await periodoNuevo("2070-02", arbol.barrioA2.id);
    const aplicarA2 = (confirmar?: boolean) =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        aplicarConceptoAUnidad(tx, {
          periodoId: periodoA2,
          unidadFuncionalId: unidadesA2[0] as string,
          conceptoBoletaId: quinchoA2,
          fechaHecho: "2070-02-10",
          cantidad: "1",
          detalle: "Primer cargo de la historia del barrio",
          origenEvaluacion: "carga_manual",
          ...(confirmar === undefined ? {} : { confirmarMontoInusual: confirmar }),
        }),
      );

    const e = await capturar(() => aplicarA2());
    console.log("[ataques] cargo sin ninguna referencia →", e.codigo, "|", e.message);
    expect(e.codigo).toBe("cargo_requiere_confirmacion");
    expect(e.message).toMatch(/ninguna boleta/i);
    expect(e.datos["referencia"]).toBe("ninguna");

    const aplicada = await aplicarA2(true);
    expect(aplicada.confirmadoPorMontoInusual).toBe(true);
  });

  it("el ataque original, entero: 20 cargos del operador ya no llegan a la boleta", async () => {
    const periodoId = await periodoNuevo("2071-01");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "400000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );

    let aplicados = 0;
    let rechazo: string | null = null;
    for (let i = 0; i < 20; i++) {
      try {
        await aplicarConceptoAUnidadEnPeriodo(periodoId, i);
        aplicados++;
      } catch (err) {
        rechazo = esErrorDeNegocio(err) ? err.codigo : String(err);
        break;
      }
    }
    // Antes entraban las veinte y la boleta se emitía en $ 3.100.000.
    expect(aplicados).toBe(1);
    expect(rechazo).toBe("tope_operador");

    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId }));
    const { rows } = await admin.query<{ total: string; cargos: string }>(
      `select total::text as total, subtotal_cargos::text as cargos
         from liquidacion where periodo_id = $1 and unidad_funcional_id = $2`,
      [periodoId, unidadesA1[0]],
    );
    console.log("[ataques] boleta tras el ataque, ya con tope →", JSON.stringify(rows[0]));
    expect(rows[0]?.cargos).toBe("150000.00");
    expect(rows[0]?.total).toBe("250000.00");
  });

  /** El paso suelto del ataque, para que el bucle de arriba se lea de un vistazo. */
  function aplicarConceptoAUnidadEnPeriodo(periodoId: string, i: number) {
    return como(arbol.usuarios.operadorA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[0] as string,
        conceptoBoletaId: quinchoA1,
        fechaHecho: "2071-01-15",
        cantidad: "100",
        detalle: `Reserva ${i + 1}`,
        origenEvaluacion: "carga_manual",
      }),
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 9. EL PRECIO QUE MUESTRA LA PANTALLA vs EL QUE SE CONGELA
// ════════════════════════════════════════════════════════════════════════════════════════════

describe("9. catálogo vs snapshot", () => {
  it("HALLAZGO: con dos valores vigentes el mismo día, el catálogo y el snapshot pueden no coincidir", async () => {
    const { conceptoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearConceptoBoleta(tx, {
        barrioId: arbol.barrioA1.id,
        nombre: "Cargo del día del empate",
        clase: "cargo",
        metodo: "monto_fijo",
        baseCalculo: "sin_base",
        clasificacionFiscal: "ingreso_ajeno",
        financiamiento: null,
        requiereAdmin: false,
        ordenImpresion: 0,
        vigenteDesde: "2020-01-01",
        montoFijo: "1000.00",
        porcentaje: null,
        precioUnitario: null,
        tope: null,
      }),
    );
    // El administrador sube el precio "desde hoy" (el caso normal de una pantalla de catálogo).
    const hoy = (
      await admin.query<{ d: string }>("select current_date::text as d")
    ).rows[0]?.d as string;
    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      registrarValorConcepto(tx, {
        conceptoBoletaId: conceptoId,
        vigenteDesde: hoy,
        montoFijo: "9000.00",
        porcentaje: null,
        precioUnitario: null,
        tope: null,
      }),
    );

    const catalogo = await como(arbol.usuarios.operadorA1, (tx) =>
      listarConceptosBoleta(tx, { barrioId: arbol.barrioA1.id }),
    );
    const enPantalla = catalogo.find((c) => c.id === conceptoId)?.valorVigente?.montoFijo;

    const periodoId = await periodoNuevo("2061-01");
    const aplicada = await como(arbol.usuarios.operadorA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[0] as string,
        conceptoBoletaId: conceptoId,
        fechaHecho: hoy,
        cantidad: null,
        detalle: "el día que cambió el precio",
        origenEvaluacion: "carga_manual",
      }),
    );
    console.log(
      "[ataques] precio EN PANTALLA →", enPantalla,
      "| precio CONGELADO en la boleta →", aplicada.importeEstimado,
    );
    // El defecto: los dos leen "el valor vigente hoy" con un empate y desempatan por su cuenta.
    expect(enPantalla).toBeDefined();
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * 10. REESCRIBIR UN PERÍODO YA EMITIDO SIN TOCARLE EL ESTADO
 *
 * Lo encontró `security-engineer` el 2026-08-04, revisando el alta con modelo elegible.
 *
 * `app.periodo_transicion()` arranca con `if new.estado = old.estado then return new`, así que un
 * `update` que **no toca el estado** pasaba entero en cualquier estado, sin validación y sin rastro.
 * Y la boleta **no guarda el modelo**: lo vuelve a leer de la fila cada vez que se arma. O sea que
 * cambiarle el modelo a un período emitido cambiaba lo que dice un documento que el vecino ya
 * recibió, con `app.validar_emision` sin volver a correr y todos los controles cuadrando.
 *
 * Lo cierra el trigger `app.periodo_emitido_inmutable` (migración `0030`). Estos casos van con el
 * pool de la aplicación y un rol de gestión —el que la policy `periodo_expensa_upd` sí habilita—,
 * porque probarlo con el pool de admin no probaría nada: ese saltea la RLS pero también es el
 * camino que ningún request usa.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
describe("10. reescribir un período ya emitido", () => {
  /** Un período emitido de A1, con un gasto y su borrador generado. */
  async function periodoEmitido(mes: string): Promise<string> {
    const periodoId = await periodoNuevo(mes);
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "100000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId }));
    return periodoId;
  }

  it("cambiarle el MODELO a un período emitido no entra", async () => {
    const periodoId = await periodoEmitido("2075-01");

    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update periodo_expensa set modelo = 'fija' where id = ${periodoId}`),
      ),
    ).rejects.toThrow(/no se puede cambiar/i);

    const { rows } = await admin.query<{ modelo: string }>(
      "select modelo::text as modelo from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]?.modelo).toBe("variable");
  });

  it("tampoco el mes, ni la versión de coeficientes contra la que se calculó", async () => {
    const periodoId = await periodoEmitido("2075-02");

    /*
     * `cuota_fija_version_id` **no está en esta lista**, y el motivo es que ponerla sería un test
     * que miente: este período es `variable`, así que esa columna ya vale `null` y "cambiarla a
     * null" no cambia nada — el `is distinct from` del trigger no entra, el `update` pasa, y el
     * caso pasaría a verde sin haber ejercitado ninguna rama. Se descubrió acá, en rojo. La columna
     * comparte exactamente la misma rama del trigger que `coeficiente_version_id`, que sí se
     * verifica; ejercitarla de verdad pide un período de valor fijo emitido, que es escenario de
     * otro archivo.
     */
    for (const sentencia of [
      sql`update periodo_expensa set periodo = '2075-09' where id = ${periodoId}`,
      sql`update periodo_expensa set coeficiente_version_id = null where id = ${periodoId}`,
      // La palabra que sale IMPRESA en la boleta. La boleta la relee de esta fila cada vez que se
      // arma, así que sin este candado un `update` la hacía decir otra cosa que la que el vecino
      // ya recibió — el esquema ya la declaraba congelada y nada la congelaba.
      sql`update periodo_expensa set denominacion_concepto = 'contribución' where id = ${periodoId}`,
      // Y la firma: quién emitió y cuándo. La pone la base desde la sesión (0013) justamente para
      // que nadie firme con el nombre de otro; reescribirla después lo permitía de nuevo.
      sql`update periodo_expensa set emitida_por = ${arbol.usuarios.adminEstudioB}::uuid where id = ${periodoId}`,
      sql`update periodo_expensa set emitida_at = '2000-01-01' where id = ${periodoId}`,
    ]) {
      await expect(
        conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => tx.execute(sentencia)),
      ).rejects.toThrow(/no se puede cambiar/i);
    }

    const { rows } = await admin.query<{ periodo: string; cv: string | null }>(
      "select periodo, coeficiente_version_id::text as cv from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]?.periodo).toBe("2075-02");
    expect(rows[0]?.cv).not.toBeNull();
  });

  /*
   * La contracara, y es la mitad que importa: el candado **no puede** haber roto el recorrido
   * normal. `generarLiquidaciones()` reescribe esas mismas columnas en cada corrida, y lo hace
   * mientras el período es borrador. Sin este caso, un trigger demasiado ancho pasaría los dos de
   * arriba y rompería el uso real — que es peor que el agujero que vino a tapar.
   */
  it("en borrador no congela nada: el borrador se regenera cuantas veces haga falta", async () => {
    const periodoId = await periodoNuevo("2075-03");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoGastoA1,
        descripcion: "Vigilancia",
        monto: "100000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    // Y el modelo de un borrador se puede corregir: es lo que el ADR llama derivado y regenerable.
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      tx.execute(sql`update periodo_expensa set modelo = 'fija' where id = ${periodoId}`),
    );
    const { rows } = await admin.query<{ modelo: string }>(
      "select modelo::text as modelo from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]?.modelo).toBe("fija");
  });

  it("y emitir sigue funcionando: el trigger no se mete en la transición de estado", async () => {
    const periodoId = await periodoEmitido("2075-04");
    const { rows } = await admin.query<{ estado: string }>(
      "select estado::text as estado from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]?.estado).toBe("emitida");
  });
});
