/**
 * Los servicios de **escritura** del primer recorrido, contra Postgres real.
 *
 * Lo que se prueba acá no es que las escrituras escriban. Es tres cosas:
 *
 * **1. Que los caminos que tienen que fallar, fallen** — y que fallen en la BASE, no en un `if` de
 * TypeScript. Por eso varios casos van con la identidad de un usuario que no debería poder: un
 * `contador` (rol de gestión de solo lectura), un `operador` pasado de tope, un administrador de otro
 * estudio. Si mañana alguien borra una validación del servicio, estos tests siguen pasando; si
 * alguien afloja una policy o un trigger, se caen.
 *
 * **2. Que el error que sale sea el que una persona necesita.** No alcanza con `rejects.toThrow()`:
 * cada caso verifica el `codigo` del `ErrorDeNegocio`, que es lo que la pantalla usa para decidir qué
 * mostrar y a qué campo apuntar. Un test que solo mira que "explotó" deja pasar el día en que todo
 * empieza a explotar como "desconocido".
 *
 * **3. Que el aislamiento aguante para el caso central del producto: un estudio con VARIOS barrios.**
 * `adminEstudioA` tiene membresía en el nodo del estudio y llega a A1 y a A2. Es el único usuario con
 * el que "cruzar de barrio" es siquiera posible —para uno de un solo barrio, la RLS lo tapa antes— y
 * por eso los tests de cruce van con él.
 *
 * Escenario (el de `helpers.ts`):
 *
 *   Estudio Pérez (A)            ├─ Otro Estudio (B)
 *    ├─ Los Álamos (A1)          │   └─ Las Lomas (B1)
 *    │    └─ Náutica (A1.sub)    │
 *    └─ San Isidro (A2)          │
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type CodigoError, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
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
import { crearPeriodo, leerPeriodo, listarGastos } from "../src/servicios/periodos.ts";
import { borrarGasto, corregirGasto, listarConceptos, registrarGasto } from "../src/servicios/gastos.ts";
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
let conceptoOrdinarioA1: string;
let conceptoExtraordinarioA1: string;
let conceptoOrdinarioA2: string;

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

/**
 * Corre `fn` esperando que falle con un `codigo` concreto, y devuelve el error para poder mirarle
 * los `datos`.
 *
 * Verifica **el código y no el texto** porque el texto es de producto y va a cambiar; el código es el
 * contrato con la pantalla. Y verifica que sea un `ErrorDeNegocio`: si saliera el error crudo del
 * driver, el test lo dice — que es exactamente el modo de falla que la capa de traducción existe para
 * impedir (un `e.message` de Postgres puede traer valores de filas que la RLS no dejaba ver).
 */
async function fallaCon(codigo: CodigoError, fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  let capturado: unknown;
  try {
    await fn();
  } catch (e) {
    capturado = e;
  }
  if (capturado === undefined) {
    throw new Error(`se esperaba que fallara con "${codigo}" y no falló`);
  }
  if (!esErrorDeNegocio(capturado)) {
    throw new Error(
      `falló con un error SIN traducir (${String(capturado)}): tenía que salir un ErrorDeNegocio`,
    );
  }
  expect(capturado.codigo).toBe(codigo);
  // Todo error tiene que decir qué hacer y traer su identificador de correlación para el log.
  expect(capturado.sugerencia.length).toBeGreaterThan(10);
  expect(capturado.correlacion).toMatch(/^[0-9a-f-]{36}$/);
  return capturado;
}

/** Período nuevo en A1, listo para cargarle gastos. */
async function periodoNuevo(mes: string, barrioId = arbol.barrioA1.id): Promise<string> {
  const { id } = await como(arbol.usuarios.adminEstudioA, (tx) =>
    crearPeriodo(tx, {
      barrioId,
      periodo: mes,
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

  for (const [barrioId, unidades] of [
    [arbol.barrioA1.id, unidadesA1],
    [arbol.barrioA2.id, unidadesA2],
  ] as const) {
    const version = await crearCoeficientes(admin, barrioId, unidades);
    await admin.query("update coeficiente_version set cerrada = true where id = $1", [version]);
    await admin.query(
      "insert into tasa_mora (barrio_id, tasa_mensual, vigente_desde) values ($1, 0.03, current_date - 300)",
      [barrioId],
    );
  }

  // Mandato vigente: sin él, `armarVistasDelPeriodo` no tendría emisor que verificar.
  await admin.query(
    "insert into mandato_administracion (barrio_id, administrador_id, desde) values ($1,$2,current_date - 100)",
    [arbol.barrioA1.id, arbol.adminA.id],
  );

  // El techo del operador en A1. Sin esta fila, `app.cbu_antes()` falla cerrado y el operador no
  // aplica NINGÚN descuento — es el hueco que el ADR-0002 §7.3 dejó anotado.
  await admin.query(
    // `monto_max_cargo_operador` (0025): holgado, para que los cargos de este archivo —que prueban
    // otras cosas— no reboten en el techo. El techo tiene su propio bloque en `ataques-escritura`.
    `insert into limite_aplicacion_barrio (barrio_id, monto_max_operador, porcentaje_max_operador,
                                           monto_max_cargo_operador, vigente_desde)
     values ($1, '10000.00', 12.000000, '200000.00', current_date - 300)`,
    [arbol.barrioA1.id],
  );

  const crearConceptoDeGasto = async (barrioId: string, nombre: string, tipo: string) => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
       values ($1,$2,$3,'sin_clasificar') returning id`,
      [barrioId, nombre, tipo],
    );
    return rows[0]?.id as string;
  };
  conceptoOrdinarioA1 = await crearConceptoDeGasto(arbol.barrioA1.id, "Seguridad", "ordinaria");
  conceptoExtraordinarioA1 = await crearConceptoDeGasto(arbol.barrioA1.id, "Portón", "extraordinaria");
  conceptoOrdinarioA2 = await crearConceptoDeGasto(arbol.barrioA2.id, "Mantenimiento", "ordinaria");
});

afterAll(async () => {
  const barrios = [arbol.barrioA1.id, arbol.barrioA2.id, arbol.barrioB1.id];
  // El registro de eventos de las aplicaciones es append-only y los períodos emitidos son inmutables,
  // las dos cosas a propósito. La limpieza del fixture entra por la puerta de mantenimiento, que solo
  // puede el superusuario y solo se usa acá.
  await admin.query("set session_replication_role = replica");
  for (const tabla of TABLAS_A_LIMPIAR) {
    await admin.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [barrios]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("crearPeriodo", () => {
  it("nace en BORRADOR, sin firma de emisión y sin versión de coeficientes", async () => {
    const id = await periodoNuevo("2030-01");
    const detalle = await como(arbol.usuarios.adminEstudioA, (tx) => leerPeriodo(tx, { periodoId: id }));

    expect(detalle?.estado).toBe("borrador");
    expect(detalle?.editable).toBe(true);
    expect(detalle?.emitidaAt).toBeNull();
    // La versión la fija `generarLiquidaciones`, no el alta: elegirla acá permitiría liquidar contra
    // una versión abierta, que es justo lo que `validar_emision` rechaza al final del camino.
    expect(detalle?.coeficienteVersionId).toBeNull();
    expect(detalle?.modelo).toBe("variable");
  });

  it("dos períodos del mismo mes en el mismo barrio: NO", async () => {
    await periodoNuevo("2030-02");
    const e = await fallaCon("periodo_ya_existe", () => periodoNuevo("2030-02"));
    // El mensaje no devuelve el `detail` del unique, que trae el par (barrio_id, periodo) en crudo.
    expect(e.message).not.toMatch(/uq_periodo_barrio|Key \(/);
  });

  it("el MISMO mes en otro barrio sí, porque el período es del barrio", async () => {
    await periodoNuevo("2030-02", arbol.barrioA2.id);
  });

  it("un contador NO crea períodos, aunque lea todo el barrio", async () => {
    await fallaCon("sin_permiso", () =>
      como(arbol.usuarios.contadorA1, (tx) =>
        crearPeriodo(tx, {
          barrioId: arbol.barrioA1.id,
          periodo: "2030-03",
          primerVencimiento: null,
          segundoVencimiento: null,
          notas: null,
        }),
      ),
    );
  });

  it("un administrador de otro estudio no crea nada en un barrio ajeno", async () => {
    await fallaCon("sin_permiso", () =>
      como(arbol.usuarios.adminEstudioB, (tx) =>
        crearPeriodo(tx, {
          barrioId: arbol.barrioA1.id,
          periodo: "2030-04",
          primerVencimiento: null,
          segundoVencimiento: null,
          notas: null,
        }),
      ),
    );
  });

  it("un mes con formato inválido lo corta Zod, antes de tocar la base", async () => {
    await expect(periodoNuevo("2030-13")).rejects.toThrow(/período inválido/i);
  });
});

describe("registrarGasto", () => {
  it("carga un gasto y devuelve lo que escribió la base", async () => {
    const periodoId = await periodoNuevo("2031-01");
    const gasto = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoOrdinarioA1,
        descripcion: "Vigilancia del mes",
        monto: "400000.00",
        proveedorNombre: "Seguridad SRL",
        comprobante: "FC-A-0001-00000123",
        actaDocumentoId: null,
      }),
    );
    expect(gasto.sinRespaldoAsamblea).toBe(false);

    const gastos = await como(arbol.usuarios.operadorA1, (tx) => listarGastos(tx, { periodoId }));
    expect(gastos).toHaveLength(1);
    expect(gastos[0]?.monto).toBe("400000.00");
    expect(gastos[0]?.proveedorNombre).toBe("Seguridad SRL");
  });

  it("una extraordinaria SIN acta se carga igual y la base la MARCA", async () => {
    const periodoId = await periodoNuevo("2031-02");
    const gasto = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoExtraordinarioA1,
        descripcion: "Reparación de urgencia del portón",
        monto: "150000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    // La marca la pone el trigger, no el servicio: vale igual desde la UI, una importación o un job.
    // Que vuelva en el resultado es lo que permite avisar en el acto y no recién al emitir.
    expect(gasto.sinRespaldoAsamblea).toBe(true);
  });

  it("un concepto de OTRO barrio no entra, aunque el usuario llegue a los dos", async () => {
    // El caso central del producto: `adminEstudioA` administra A1 y A2, así que la RLS no lo tapa.
    // Lo que lo impide es la FK compuesta `fk_gasto_concepto_barrio (concepto_id, barrio_id)`.
    const periodoId = await periodoNuevo("2031-03");
    const e = await fallaCon("referencia_de_otro_barrio", () =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        registrarGasto(tx, {
          periodoId,
          conceptoId: conceptoOrdinarioA2,
          descripcion: "Gasto cruzado",
          monto: "1000.00",
          proveedorNombre: null,
          comprobante: null,
          actaDocumentoId: null,
        }),
      ),
    );
    expect(e.message).toMatch(/no es de este barrio/i);
    expect(e.message).not.toMatch(/foreign key|fk_gasto/i);
  });

  it("un período inexistente y uno inaccesible dan el MISMO error: no hay oráculo", async () => {
    const ajeno = await periodoNuevo("2031-04", arbol.barrioA2.id);
    const inexistente = "00000000-0000-4000-8000-0000000000ff";

    const alta = (periodoId: string) =>
      como(arbol.usuarios.operadorA1, (tx) =>
        registrarGasto(tx, {
          periodoId,
          conceptoId: conceptoOrdinarioA1,
          descripcion: "x",
          monto: "1.00",
          proveedorNombre: null,
          comprobante: null,
          actaDocumentoId: null,
        }),
      );

    const a = await fallaCon("periodo_no_encontrado", () => alta(ajeno));
    const b = await fallaCon("periodo_no_encontrado", () => alta(inexistente));
    expect(a.message).toBe(b.message);
  });

  it("en un período EMITIDO no se carga, ni se corrige, ni se borra", async () => {
    const periodoId = await periodoNuevo("2031-05");
    const gasto = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoOrdinarioA1,
        descripcion: "Vigilancia",
        monto: "200000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await como(arbol.usuarios.adminBarrioA1, (tx) => emitirPeriodo(tx, { periodoId }));

    const alta = await fallaCon("periodo_no_editable", () =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        registrarGasto(tx, {
          periodoId,
          conceptoId: conceptoOrdinarioA1,
          descripcion: "Uno más",
          monto: "1.00",
          proveedorNombre: null,
          comprobante: null,
          actaDocumentoId: null,
        }),
      ),
    );
    // El mensaje tiene que nombrar el estado y decir qué hacer: "se corrige en el período siguiente".
    expect(alta.message).toMatch(/emitida/i);
    expect(alta.datos["estado"]).toBe("emitida");
    expect(alta.sugerencia).toMatch(/período siguiente/i);

    await fallaCon("periodo_no_editable", () =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        corregirGasto(tx, {
          gastoId: gasto.id,
          descripcion: "Otra cosa",
          monto: "5.00",
          proveedorNombre: null,
          comprobante: null,
          actaDocumentoId: null,
        }),
      ),
    );
    await fallaCon("periodo_no_editable", () =>
      como(arbol.usuarios.adminBarrioA1, (tx) => borrarGasto(tx, { gastoId: gasto.id })),
    );
  });
});

describe("corregirGasto y borrarGasto", () => {
  it("corrigen mientras el período es editable, y vuelven a evaluar la marca del acta", async () => {
    const periodoId = await periodoNuevo("2032-01");
    const { rows: actas } = await admin.query<{ id: string }>(
      `insert into documento_barrio (barrio_id, tipo, titulo, fecha_documento)
       values ($1,'acta_asamblea','Acta que aprueba el portón', current_date - 30) returning id`,
      [arbol.barrioA1.id],
    );
    const actaId = actas[0]?.id as string;

    const gasto = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoExtraordinarioA1,
        descripcion: "Portón",
        monto: "300000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    expect(gasto.sinRespaldoAsamblea).toBe(true);

    // Se le agrega el acta: la marca se recalcula sola, porque el trigger es `before insert or update`.
    const corregido = await como(arbol.usuarios.operadorA1, (tx) =>
      corregirGasto(tx, {
        gastoId: gasto.id,
        descripcion: "Portón de acceso (1ª cuota)",
        monto: "310000.00",
        proveedorNombre: "Metalúrgica del Sur",
        comprobante: "FC-B-0002-00000045",
        actaDocumentoId: actaId,
      }),
    );
    expect(corregido.sinRespaldoAsamblea).toBe(false);

    await como(arbol.usuarios.operadorA1, (tx) => borrarGasto(tx, { gastoId: gasto.id }));
    expect(await como(arbol.usuarios.operadorA1, (tx) => listarGastos(tx, { periodoId }))).toEqual([]);
  });

  it("corregir o borrar un gasto que no se ve NO devuelve éxito silencioso", async () => {
    // Es el modo de falla más caro: bajo RLS, un `update ... where id = $1` sobre una fila invisible
    // actualiza cero filas y no lanza nada. Sin la guarda, la pantalla diría "listo".
    const inexistente = "00000000-0000-4000-8000-0000000000fe";
    await fallaCon("gasto_no_encontrado", () =>
      como(arbol.usuarios.operadorA1, (tx) => borrarGasto(tx, { gastoId: inexistente })),
    );
    await fallaCon("gasto_no_encontrado", () =>
      como(arbol.usuarios.operadorA1, (tx) =>
        corregirGasto(tx, {
          gastoId: inexistente,
          descripcion: "x",
          monto: "1.00",
          proveedorNombre: null,
          comprobante: null,
          actaDocumentoId: null,
        }),
      ),
    );
  });

  it("un contador no borra un gasto", async () => {
    const periodoId = await periodoNuevo("2032-02");
    const gasto = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoOrdinarioA1,
        descripcion: "Vigilancia",
        monto: "1000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    // La policy de `delete` no lo alcanza, así que la fila no existe PARA ÉL: no es "sin permiso",
    // es "no la encuentro". Se verifica que el gasto siga ahí, que es lo que de verdad importa.
    await fallaCon("gasto_no_encontrado", () =>
      como(arbol.usuarios.contadorA1, (tx) => borrarGasto(tx, { gastoId: gasto.id })),
    );
    expect(await como(arbol.usuarios.operadorA1, (tx) => listarGastos(tx, { periodoId }))).toHaveLength(1);
  });
});

describe("catálogo de conceptos de boleta", () => {
  it("da de alta el concepto CON su valor, en una sola operación", async () => {
    const { conceptoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearConceptoBoleta(tx, {
        barrioId: arbol.barrioA1.id,
        nombre: "Alquiler de quincho",
        clase: "cargo",
        metodo: "precio_x_cantidad",
        baseCalculo: "sin_base",
        clasificacionFiscal: "ingreso_ajeno",
        financiamiento: null,
        requiereAdmin: false,
        ordenImpresion: 10,
        vigenteDesde: "2020-01-01",
        montoFijo: null,
        porcentaje: null,
        precioUnitario: "38000.00",
        tope: null,
      }),
    );

    const catalogo = await como(arbol.usuarios.operadorA1, (tx) =>
      listarConceptosBoleta(tx, { barrioId: arbol.barrioA1.id }),
    );
    const quincho = catalogo.find((c) => c.id === conceptoId);
    // Sin valor vigente el concepto no se puede aplicar: por eso van juntos y por eso la lista lo trae.
    expect(quincho?.valorVigente?.precioUnitario).toBe("38000.00");
    expect(quincho?.clasificacionFiscal).toBe("ingreso_ajeno");
  });

  it("un valor nuevo CIERRA la vigencia del anterior, sin dejar hueco", async () => {
    const { conceptoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearConceptoBoleta(tx, {
        barrioId: arbol.barrioA1.id,
        nombre: "Alquiler de cancha",
        clase: "cargo",
        metodo: "monto_fijo",
        baseCalculo: "sin_base",
        clasificacionFiscal: "ingreso_ajeno",
        financiamiento: null,
        requiereAdmin: false,
        ordenImpresion: 20,
        vigenteDesde: "2020-01-01",
        montoFijo: "5000.00",
        porcentaje: null,
        precioUnitario: null,
        tope: null,
      }),
    );
    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      registrarValorConcepto(tx, {
        conceptoBoletaId: conceptoId,
        vigenteDesde: "2024-01-01",
        montoFijo: "9000.00",
        porcentaje: null,
        precioUnitario: null,
        tope: null,
      }),
    );

    const { rows } = await admin.query<{ desde: string; hasta: string | null }>(
      `select vigente_desde::text as desde, vigente_hasta::text as hasta
         from concepto_boleta_valor where concepto_boleta_id = $1 order by vigente_desde`,
      [conceptoId],
    );
    // El cierre lo hace la base: si lo hiciera el request, podría dejar un hueco de vigencia, y en
    // ese hueco el concepto deja de poder aplicarse sin que nadie lo haya decidido.
    expect(rows.map((r) => [r.desde, r.hasta])).toEqual([
      ["2020-01-01", "2024-01-01"],
      ["2024-01-01", null],
    ]);
  });

  it("el catálogo lo define un admin del barrio: un operador NO, y un contador tampoco", async () => {
    const alta = (usuario: string, nombre: string) =>
      como(usuario, (tx) =>
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
          montoFijo: "100.00",
          porcentaje: null,
          precioUnitario: null,
          tope: null,
        }),
      );
    // El privilegio va partido a propósito (doc 08 §Y): el `operador` aplica lo que ya existe, pero
    // no define la tarifa. Si pudiera, el tope por rol no serviría de nada.
    await fallaCon("sin_permiso", () => alta(arbol.usuarios.operadorA1, "Inventado por el operador"));
    await fallaCon("sin_permiso", () => alta(arbol.usuarios.contadorA1, "Inventado por el contador"));
  });

  it("un nombre repetido en el mismo barrio: NO", async () => {
    await fallaCon("concepto_duplicado", () =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        crearConceptoBoleta(tx, {
          barrioId: arbol.barrioA1.id,
          nombre: "alquiler de QUINCHO", // el índice es sobre `lower(nombre)`
          clase: "cargo",
          metodo: "monto_fijo",
          baseCalculo: "sin_base",
          clasificacionFiscal: "ingreso_ajeno",
          financiamiento: null,
          requiereAdmin: false,
          ordenImpresion: 0,
          vigenteDesde: "2020-01-01",
          montoFijo: "100.00",
          porcentaje: null,
          precioUnitario: null,
          tope: null,
        }),
      ),
    );
  });

  it("un descuento porcentual SIN tope lo corta Zod, con el mensaje en el campo", async () => {
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        crearConceptoBoleta(tx, {
          barrioId: arbol.barrioA1.id,
          nombre: "Descuento sin techo",
          clase: "descuento",
          metodo: "porcentaje",
          baseCalculo: "expensa_ordinaria",
          clasificacionFiscal: "no_alcanzado",
          financiamiento: "partida_presupuestada",
          requiereAdmin: false,
          ordenImpresion: 0,
          vigenteDesde: "2020-01-01",
          montoFijo: null,
          porcentaje: "5",
          precioUnitario: null,
          tope: null,
        }),
      ),
    ).rejects.toThrow(/tope/i);
  });

  it("un descuento sin declarar de dónde sale la plata: NO", async () => {
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        crearConceptoBoleta(tx, {
          barrioId: arbol.barrioA1.id,
          nombre: "Descuento sin financiamiento",
          clase: "descuento",
          metodo: "monto_fijo",
          baseCalculo: "sin_base",
          clasificacionFiscal: "no_alcanzado",
          financiamiento: null,
          requiereAdmin: false,
          ordenImpresion: 0,
          vigenteDesde: "2020-01-01",
          montoFijo: "1000.00",
          porcentaje: null,
          precioUnitario: null,
          tope: null,
        }),
      ),
    ).rejects.toThrow(/de dónde sale la plata/i);
  });
});

describe("aplicarConceptoAUnidad", () => {
  let quinchoA1: string;
  let bonificacionA1: string;
  let quinchoA2: string;

  beforeAll(async () => {
    const alta = async (
      barrioId: string,
      nombre: string,
      extra: Partial<Parameters<typeof crearConceptoBoleta>[1]> = {},
    ) => {
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
    bonificacionA1 = await alta(arbol.barrioA1.id, "Bonificación cumplidor", {
      clase: "descuento",
      metodo: "porcentaje",
      baseCalculo: "expensa_ordinaria",
      clasificacionFiscal: "no_alcanzado",
      financiamiento: "partida_presupuestada",
      precioUnitario: null,
      porcentaje: "10",
      tope: "8000.00",
    });
  });

  it("el importe NO lo manda el request: el snapshot lo escribe la base desde el catálogo", async () => {
    const periodoId = await periodoNuevo("2033-01");
    const aplicada = await como(arbol.usuarios.operadorA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[0] as string,
        conceptoBoletaId: quinchoA1,
        fechaHecho: "2033-01-15",
        cantidad: "2",
        detalle: "Reserva del quincho — 2 jornadas",
        origenEvaluacion: "carga_manual",
      }),
    );

    expect(aplicada.nombreConcepto).toBe("Quincho A1");
    expect(aplicada.clase).toBe("cargo");
    // 1500 × 2, calculado por `app.cbu_importe_bruto()` — la MISMA y única definición de la
    // aritmética que después usa el cálculo real y el CHECK. Que salga de ahí y no de una
    // multiplicación en TypeScript es lo que garantiza que este número sea el de la boleta.
    expect(aplicada.importeEstimado).toBe("3000.00");

    const { rows } = await admin.query<{ precio: string; aplicado_por: string; resuelto: string | null }>(
      `select precio_unitario::text as precio, aplicado_por::text, importe_resuelto::text as resuelto
         from concepto_boleta_unidad where id = $1`,
      [aplicada.id],
    );
    expect(rows[0]?.precio).toBe("1500.00");
    // La firma la puso la base desde la sesión, no el request.
    expect(rows[0]?.aplicado_por).toBe(arbol.usuarios.operadorA1);
    // Y el importe nace NULO siempre: se resuelve contra la liquidación al generar el borrador.
    expect(rows[0]?.resuelto).toBeNull();
  });

  it("los campos de más que inyecte el formulario se DESCARTAN antes de llegar a la sentencia", async () => {
    // Es el ataque directo contra el modelo de confianza de la migración 0017: mandar el concepto
    // legítimo con un `precio_unitario` propio. Zod descarta lo desconocido (no es `.strict()` a
    // propósito: un `FormData` de una Server Action siempre trae claves de más), así que el objeto
    // parseado no lo tiene y la sentencia no lo puede escribir.
    const periodoId = await periodoNuevo("2033-11");
    const veneno = {
      periodoId,
      unidadFuncionalId: unidadesA1[0] as string,
      conceptoBoletaId: quinchoA1,
      fechaHecho: "2033-11-15",
      cantidad: "1",
      detalle: "Con campos de más",
      origenEvaluacion: "carga_manual" as const,
      // Todo lo que un atacante querría mandar:
      precioUnitario: "9500000.00",
      precio_unitario: "9500000.00",
      importeResuelto: "9500000.00",
      importe_resuelto: "9500000.00",
      montoResuelto: "9500000.00",
      barrioId: arbol.barrioB1.id,
      barrio_id: arbol.barrioB1.id,
      aplicadoPor: arbol.usuarios.adminEstudioB,
      aplicado_por: arbol.usuarios.adminEstudioB,
      clase: "cargo",
      tope: "0.01",
    };
    const aplicada = await como(arbol.usuarios.operadorA1, (tx) =>
      aplicarConceptoAUnidad(tx, veneno as Parameters<typeof aplicarConceptoAUnidad>[1]),
    );
    expect(aplicada.importeEstimado).toBe("1500.00"); // el del catálogo, no el inyectado

    const { rows } = await admin.query<{
      precio: string;
      barrio: string;
      aplicado_por: string;
      resuelto: string | null;
      tope: string | null;
    }>(
      `select precio_unitario::text as precio, barrio_id::text as barrio, aplicado_por::text,
              importe_resuelto::text as resuelto, tope::text
         from concepto_boleta_unidad where id = $1`,
      [aplicada.id],
    );
    expect(rows[0]?.precio).toBe("1500.00");
    expect(rows[0]?.barrio).toBe(arbol.barrioA1.id);
    expect(rows[0]?.aplicado_por).toBe(arbol.usuarios.operadorA1);
    expect(rows[0]?.resuelto).toBeNull();
    expect(rows[0]?.tope).toBeNull();
  });

  it("el importe de un porcentual NO se puede saber al aplicarlo, y el servicio lo dice", async () => {
    const periodoId = await periodoNuevo("2033-02");
    const aplicada = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[0] as string,
        conceptoBoletaId: bonificacionA1,
        fechaHecho: "2033-02-10",
        cantidad: null,
        detalle: "Sin saldo pendiente al cierre anterior",
        origenEvaluacion: "carga_manual",
      }),
    );
    // `null` y no `0.00`: la base de cálculo sale de la liquidación de esa unidad, que todavía no
    // existe. Un cero acá sería una cifra inventada en una pantalla de dinero.
    expect(aplicada.importeEstimado).toBeNull();
    expect(aplicada.tope).toBe("8000.00");
  });

  it("una unidad de OTRO barrio no recibe un concepto de este, ni para el admin del estudio", async () => {
    const periodoId = await periodoNuevo("2033-03");
    const e = await fallaCon("referencia_de_otro_barrio", () =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        aplicarConceptoAUnidad(tx, {
          periodoId, // de A1
          unidadFuncionalId: unidadesA2[0] as string, // de A2
          conceptoBoletaId: quinchoA1, // de A1
          fechaHecho: "2033-03-10",
          cantidad: "1",
          detalle: "Cruzado",
          origenEvaluacion: "carga_manual",
        }),
      ),
    );
    expect(e.message).toMatch(/unidad no es del mismo barrio/i);
  });

  it("un período de OTRO barrio tampoco, aunque el usuario llegue a los dos", async () => {
    const periodoA2 = await periodoNuevo("2033-04", arbol.barrioA2.id);
    await fallaCon("referencia_de_otro_barrio", () =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        aplicarConceptoAUnidad(tx, {
          periodoId: periodoA2,
          unidadFuncionalId: unidadesA1[0] as string,
          conceptoBoletaId: quinchoA1,
          fechaHecho: "2033-04-10",
          cantidad: "1",
          detalle: "Cruzado al revés",
          origenEvaluacion: "carga_manual",
        }),
      ),
    );
  });

  it("un concepto de un barrio inaccesible: mismo mensaje que uno inexistente, sin filtrar su NOMBRE", async () => {
    // Regresión de la migración 0021. `app.cbu_antes()` es `security definer` con dueño `app_job`
    // (BYPASSRLS): su cuerpo ve el catálogo de TODOS los barrios y corre ANTES del `with check` de la
    // policy. Los `raise exception` que interpolaban `v_cat.nombre` servían el nombre de un concepto
    // de otro tenant por el canal de error, aunque la fila nunca entrara.
    const { rows } = await admin.query<{ id: string }>(
      `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal,
                                    requiere_admin)
       values ($1, 'Multa por obra sin permiso — expediente reservado', 'cargo', 'monto_fijo',
               'sin_base', 'sin_clasificar', true) returning id`,
      [arbol.barrioB1.id],
    );
    const conceptoAjeno = rows[0]?.id as string;
    const periodoId = await periodoNuevo("2033-05");

    const e = await fallaCon("concepto_no_encontrado", () =>
      como(arbol.usuarios.operadorA1, (tx) =>
        aplicarConceptoAUnidad(tx, {
          periodoId,
          unidadFuncionalId: unidadesA1[0] as string,
          conceptoBoletaId: conceptoAjeno,
          fechaHecho: "2033-05-10",
          cantidad: null,
          detalle: "A ver si se filtra",
          origenEvaluacion: "carga_manual",
        }),
      ),
    );
    expect(e.message).not.toMatch(/expediente|Multa/i);
  });

  it("un operador NO pasa su tope, ni de una ni partiendo el descuento en varios", async () => {
    const periodoId = await periodoNuevo("2033-06");
    // El tope del barrio es $ 10.000 y este descuento puede llegar a $ 8.000: entra.
    await como(arbol.usuarios.operadorA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[1] as string,
        conceptoBoletaId: bonificacionA1,
        fechaHecho: "2033-06-10",
        cantidad: null,
        detalle: "Primera bonificación",
        origenEvaluacion: "carga_manual",
      }),
    );

    // Un segundo descuento a la MISMA unidad en el MISMO período llevaría el máximo posible a
    // $ 16.000: el tope es agregado justamente para que partirlo en conceptos chicos no lo evada.
    const { conceptoId: otroDescuento } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearConceptoBoleta(tx, {
        barrioId: arbol.barrioA1.id,
        nombre: "Bonificación adicional",
        clase: "descuento",
        metodo: "porcentaje",
        baseCalculo: "expensa_ordinaria",
        clasificacionFiscal: "no_alcanzado",
        financiamiento: "partida_presupuestada",
        requiereAdmin: false,
        ordenImpresion: 0,
        vigenteDesde: "2020-01-01",
        montoFijo: null,
        porcentaje: "10",
        precioUnitario: null,
        tope: "8000.00",
      }),
    );

    const e = await fallaCon("tope_operador", () =>
      como(arbol.usuarios.operadorA1, (tx) =>
        aplicarConceptoAUnidad(tx, {
          periodoId,
          unidadFuncionalId: unidadesA1[1] as string,
          conceptoBoletaId: otroDescuento,
          fechaHecho: "2033-06-11",
          cantidad: null,
          detalle: "Segunda bonificación, para evadir el tope",
          origenEvaluacion: "carga_manual",
        }),
      ),
    );
    expect(e.sugerencia).toMatch(/administrador/i);
    expect(e.datos["tope"]).toBe("10000.00");

    // El mismo descuento, aplicado por un ADMINISTRADOR del barrio, sí entra: el tope es por rol.
    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[1] as string,
        conceptoBoletaId: otroDescuento,
        fechaHecho: "2033-06-11",
        cantidad: null,
        detalle: "Segunda bonificación, aprobada por el administrador",
        origenEvaluacion: "carga_manual",
      }),
    );
  });

  it("sin límite cargado, el operador no aplica NI descuentos NI cargos (falla cerrado)", async () => {
    const periodoId = await periodoNuevo("2033-07");
    await admin.query(
      "update limite_aplicacion_barrio set vigente_hasta = current_date where barrio_id = $1",
      [arbol.barrioA1.id],
    );
    try {
      const e = await fallaCon("sin_limite_de_aplicacion", () =>
        como(arbol.usuarios.operadorA1, (tx) =>
          aplicarConceptoAUnidad(tx, {
            periodoId,
            unidadFuncionalId: unidadesA1[2] as string,
            conceptoBoletaId: bonificacionA1,
            fechaHecho: "2033-07-10",
            cantidad: null,
            detalle: "Sin techo definido",
            origenEvaluacion: "carga_manual",
          }),
        ),
      );
      // Un default de "$X hasta que lo configuren" sería un agujero con fecha de vencimiento: el
      // mensaje tiene que explicar que la ausencia de techo ES el motivo.
      expect(e.sugerencia).toMatch(/sin techo definido, no hay techo/i);

      // **Y desde la migración 0025, un CARGO tampoco.** Hasta entonces entraba, con el argumento de
      // que un cargo es tarifa del catálogo y no una decisión sobre la deuda de un vecino. El
      // argumento era cierto sobre el PRECIO y falso sobre lo que quedó sin techo: cuántas veces se
      // le cobra a la misma unidad en el mismo período. Por ahí se emitió una boleta de $ 3.100.000
      // sobre una expensa de $ 100.000 (`ataques-escritura`, bloque 8).
      const eCargo = await fallaCon("sin_limite_de_aplicacion", () =>
        como(arbol.usuarios.operadorA1, (tx) =>
          aplicarConceptoAUnidad(tx, {
            periodoId,
            unidadFuncionalId: unidadesA1[2] as string,
            conceptoBoletaId: quinchoA1,
            fechaHecho: "2033-07-10",
            cantidad: "1",
            detalle: "Reserva",
            origenEvaluacion: "carga_manual",
          }),
        ),
      );
      expect(eCargo.message).toMatch(/cargos/i);

      // El administrador sí lo aplica: el tope es por ROL, no por barrio. Y no le piden confirmar
      // nada, porque $ 1.500 no es un importe raro contra la expensa de esa unidad — la confirmación
      // se pide por el monto, no por la ausencia del límite (eso lo cubre `ataques-escritura` §8).
      const aplicada = await como(arbol.usuarios.adminBarrioA1, (tx) =>
        aplicarConceptoAUnidad(tx, {
          periodoId,
          unidadFuncionalId: unidadesA1[2] as string,
          conceptoBoletaId: quinchoA1,
          fechaHecho: "2033-07-10",
          cantidad: "1",
          detalle: "Reserva",
          origenEvaluacion: "carga_manual",
        }),
      );
      expect(aplicada.confirmadoPorMontoInusual).toBe(false);
    } finally {
      await admin.query(
        "update limite_aplicacion_barrio set vigente_hasta = null where barrio_id = $1",
        [arbol.barrioA1.id],
      );
    }
  });

  it("un concepto sin valor vigente a la fecha del hecho se rechaza, con el nombre y la fecha", async () => {
    const periodoId = await periodoNuevo("2033-08");
    const e = await fallaCon("concepto_sin_valor_vigente", () =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        aplicarConceptoAUnidad(tx, {
          periodoId,
          unidadFuncionalId: unidadesA1[0] as string,
          conceptoBoletaId: quinchoA1,
          fechaHecho: "2019-06-01", // antes de que el valor entrara en vigencia
          cantidad: "1",
          detalle: "Con fecha vieja",
          origenEvaluacion: "carga_manual",
        }),
      ),
    );
    // El nombre del concepto y la fecha SÍ se muestran: son del barrio en el que la persona trabaja
    // y el concepto lo acaba de elegir de una lista que ya leyó bajo RLS.
    expect(e.datos["concepto"]).toBe("Quincho A1");
    expect(e.datos["fecha"]).toBe("2019-06-01");
  });

  it("el concepto de otro barrio no se puede aplicar ni siquiera con su propio período", async () => {
    // Cierra el trío: A2 tiene su propio quincho, y el operador de A1 no llega a A2 de ninguna forma.
    const periodoA2 = await periodoNuevo("2033-09", arbol.barrioA2.id);
    await fallaCon("concepto_no_encontrado", () =>
      como(arbol.usuarios.operadorA1, (tx) =>
        aplicarConceptoAUnidad(tx, {
          periodoId: periodoA2,
          unidadFuncionalId: unidadesA2[0] as string,
          conceptoBoletaId: quinchoA2,
          fechaHecho: "2033-09-10",
          cantidad: "1",
          detalle: "Desde otro barrio",
          origenEvaluacion: "carga_manual",
        }),
      ),
    );
  });

  it("anular: con motivo, una sola vez, y el motivo archivado no se reescribe", async () => {
    const periodoId = await periodoNuevo("2033-10");
    const aplicada = await como(arbol.usuarios.operadorA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[3] as string,
        conceptoBoletaId: quinchoA1,
        fechaHecho: "2033-10-10",
        cantidad: "1",
        detalle: "Reserva que después se cancela",
        origenEvaluacion: "carga_manual",
      }),
    );

    // Un motivo de una letra no sirve: es la única explicación de por qué esa plata no se cobró.
    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        anularAplicacion(tx, { aplicacionId: aplicada.id, motivo: "x" }),
      ),
    ).rejects.toThrow(/motivo/i);

    await como(arbol.usuarios.operadorA1, (tx) =>
      anularAplicacion(tx, {
        aplicacionId: aplicada.id,
        motivo: "El vecino canceló la reserva con 48 h de anticipación",
      }),
    );

    const lista = await como(arbol.usuarios.operadorA1, (tx) => listarAplicaciones(tx, { periodoId }));
    expect(lista[0]?.anuladoAt).not.toBeNull();
    expect(lista[0]?.motivoAnulacion).toMatch(/48 h/);

    // Anular de nuevo no es un no-op silencioso.
    await fallaCon("aplicacion_ya_anulada", () =>
      como(arbol.usuarios.operadorA1, (tx) =>
        anularAplicacion(tx, { aplicacionId: aplicada.id, motivo: "Otro motivo distinto" }),
      ),
    );

    // Y el candado de verdad está en la BASE (migración 0021), no en el `where` del servicio: el
    // registro de eventos solo anota la transición no-anulada → anulada, así que reescribir el motivo
    // por SQL directo dejaría la fila diciendo una cosa y el log otra.
    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        tx.execute(sql`
          update concepto_boleta_unidad set motivo_anulacion = 'motivo reescrito' where id = ${aplicada.id}
        `),
      ),
    ).rejects.toThrow(/no se reescribe/i);
  });

  it("una aplicación que no se ve no se anula en silencio", async () => {
    await fallaCon("aplicacion_no_encontrada", () =>
      como(arbol.usuarios.operadorA1, (tx) =>
        anularAplicacion(tx, {
          aplicacionId: "00000000-0000-4000-8000-0000000000fd",
          motivo: "Un motivo suficientemente largo",
        }),
      ),
    );
  });
});

describe("generar el borrador y emitir", () => {
  it("el recorrido entero: crear, cargar, aplicar, generar y emitir", async () => {
    const periodoId = await periodoNuevo("2034-01");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoOrdinarioA1,
        descripcion: "Vigilancia",
        monto: "1000000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );

    const { conceptoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearConceptoBoleta(tx, {
        barrioId: arbol.barrioA1.id,
        nombre: "Quincho del recorrido",
        clase: "cargo",
        metodo: "monto_fijo",
        baseCalculo: "sin_base",
        clasificacionFiscal: "ingreso_ajeno",
        financiamiento: null,
        requiereAdmin: false,
        ordenImpresion: 0,
        vigenteDesde: "2020-01-01",
        montoFijo: "45000.00",
        porcentaje: null,
        precioUnitario: null,
        tope: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadesA1[0] as string,
        conceptoBoletaId: conceptoId,
        fechaHecho: "2034-01-15",
        cantidad: null,
        detalle: "Reserva del quincho",
        origenEvaluacion: "carga_manual",
      }),
    );

    const resumen = await como(arbol.usuarios.operadorA1, (tx) =>
      generarLiquidaciones(tx, { periodoId }),
    );
    expect(resumen.totalRepartido).toBe("1000000.00");
    expect(resumen.totalCargos).toBe("45000.00");

    // El importe del cargo lo resolvió la base contra la liquidación, no el request.
    const aplicaciones = await como(arbol.usuarios.operadorA1, (tx) =>
      listarAplicaciones(tx, { periodoId }),
    );
    expect(aplicaciones[0]?.importeResuelto).toBe("45000.00");

    const emitido = await como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId }));
    // La firma sale de la sesión: si viniera por parámetro, cualquiera firmaría con el nombre de otro.
    expect(emitido.emitidaPor).toBe(arbol.usuarios.operadorA1);
    // Marca de emisión tal como la entrega Postgres. NO es un `Date`: `db.execute()` de Drizzle
    // instala su propio parser y devuelve `timestamptz` en crudo — el tipo de `periodos.ts` decía
    // `Date` y era mentira, así que un `.toLocaleDateString()` en la pantalla reventaba.
    expect(emitido.emitidaAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it("NO emite un período que no cuadra, y el mensaje trae las dos cifras", async () => {
    const periodoId = await periodoNuevo("2034-02");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoOrdinarioA1,
        descripcion: "Vigilancia",
        monto: "1000000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    // Se carga un gasto DESPUÉS de liquidar: lo repartido ya no es el gasto del período.
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoOrdinarioA1,
        descripcion: "Un gasto que llegó tarde",
        monto: "77000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );

    const e = await fallaCon("periodo_no_cuadra", () =>
      como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId })),
    );
    // Sin los números, "no cuadra" no se puede investigar. Son agregados del período que se está
    // emitiendo, y quien emite ya puede leer los gastos y las liquidaciones de los que salen.
    expect(e.datos["esperado"]).toBe("1077000.00");
    expect(e.datos["repartido"]).toBe("1000000.00");
    expect(e.datos["diferencia"]).toBe("77000.00");
    expect(e.sugerencia).toMatch(/generar el borrador/i);
  });

  it("NO emite si falta liquidar una unidad activa", async () => {
    const periodoId = await periodoNuevo("2034-03");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoOrdinarioA1,
        descripcion: "Vigilancia",
        monto: "500000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await admin.query(
      "delete from liquidacion where id = (select id from liquidacion where periodo_id = $1 limit 1)",
      [periodoId],
    );

    const e = await fallaCon("periodo_incompleto", () =>
      como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId })),
    );
    expect(e.datos["unidades"]).toBe("4");
    expect(e.datos["liquidaciones"]).toBe("3");
  });

  it("EMITIR UN PERÍODO QUE NO SE VE NO DEVUELVE ÉXITO — el bug silencioso que cerró esta tanda", async () => {
    // El `using` de una policy de UPDATE actúa como FILTRO de filas, no como una verificación que
    // aborte: la versión anterior de `emitirPeriodo` hacía `update ... where id = $1` sin mirar
    // cuántas filas tocó, así que un período de otro barrio devolvía `UPDATE 0`, sin error, y la
    // pantalla decía "emitido". Verificado contra la base, no deducido.
    const periodoA2 = await periodoNuevo("2034-04", arbol.barrioA2.id);
    await fallaCon("periodo_no_encontrado", () =>
      como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId: periodoA2 })),
    );

    const { rows } = await admin.query<{ estado: string }>(
      "select estado::text as estado from periodo_expensa where id = $1",
      [periodoA2],
    );
    expect(rows[0]?.estado).toBe("borrador");
  });

  it("emitir DOS VECES tampoco es un éxito silencioso", async () => {
    // El segundo camino invisible: `app.periodo_transicion()` corta con `if new.estado = old.estado
    // then return new`, así que el UPDATE afectaba 1 fila, `validar_emision` no corría, y la persona
    // se quedaba creyendo que acababa de emitir.
    const periodoId = await periodoNuevo("2034-05");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoOrdinarioA1,
        descripcion: "Vigilancia",
        monto: "600000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId }));

    const e = await fallaCon("periodo_no_editable", () =>
      como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId })),
    );
    expect(e.datos["estado"]).toBe("emitida");
  });

  it("regenerar el borrador de un período emitido: NO", async () => {
    const periodoId = await periodoNuevo("2034-06");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoOrdinarioA1,
        descripcion: "Vigilancia",
        monto: "300000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await como(arbol.usuarios.operadorA1, (tx) => emitirPeriodo(tx, { periodoId }));

    await fallaCon("periodo_no_editable", () =>
      como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId })),
    );
  });

  it("un contador no emite, aunque lea el período entero", async () => {
    const periodoId = await periodoNuevo("2034-07");
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId,
        conceptoId: conceptoOrdinarioA1,
        descripcion: "Vigilancia",
        monto: "250000.00",
        proveedorNombre: null,
        comprobante: null,
        actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    // El contador LEE el período entero (es rol de gestión) pero la policy de UPDATE no lo alcanza.
    // El mensaje tiene que decirle que le falta el rol, no "no existe" ni "ya está borrador":
    // las tres cosas se ven igual desde el `UPDATE 0` y sólo una manda a la persona al lugar correcto.
    const e = await fallaCon("sin_permiso", () =>
      como(arbol.usuarios.contadorA1, (tx) => emitirPeriodo(tx, { periodoId })),
    );
    expect(e.sugerencia).toMatch(/contador|auditor/i);
    const { rows } = await admin.query<{ estado: string }>(
      "select estado::text as estado from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]?.estado).toBe("borrador");
  });

  it("sin coeficientes cerrados no se genera el borrador, y lo dice", async () => {
    // Se usa B1, que no tiene ninguna versión de coeficientes. Reabrir la de A2 no es una opción:
    // un trigger lo impide ("una versión cerrada no se reabre: se crea una versión nueva"), que es
    // justamente la garantía de que lo ya liquidado se puede rehacer.
    const { id: periodoId } = await como(arbol.usuarios.adminEstudioB, (tx) =>
      crearPeriodo(tx, {
        barrioId: arbol.barrioB1.id,
        periodo: "2034-08",
        primerVencimiento: null,
        segundoVencimiento: null,
        notas: null,
      }),
    );
    // `barrio_sin_coeficientes` y no `sin_coeficientes`: son dos situaciones con salidas distintas
    // —cargar y cerrar la versión del barrio vs. generar el borrador del período— y el `codigo` es
    // lo que la pantalla usa para decidir a dónde mandar a la persona.
    const e = await fallaCon("barrio_sin_coeficientes", () =>
      como(arbol.usuarios.adminEstudioB, (tx) => generarLiquidaciones(tx, { periodoId })),
    );
    expect(e.sugerencia).toMatch(/cerrarla/i);
  });

  it("listarConceptos trae el catálogo de gastos del barrio y solo de ese barrio", async () => {
    const deA1 = await como(arbol.usuarios.operadorA1, (tx) =>
      listarConceptos(tx, { barrioId: arbol.barrioA1.id }),
    );
    expect(deA1.map((c) => c.nombre).sort()).toEqual(["Portón", "Seguridad"]);
    expect(deA1.some((c) => c.nombre === "Mantenimiento")).toBe(false);
  });
});
