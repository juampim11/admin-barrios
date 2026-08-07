/**
 * ATAQUE — el alta de período con `modelo` elegible (2026-08-04).
 *
 * Lo que ejercita este archivo y **no ejercitaba ninguno**: el recorrido de un período `fija`
 * creado por el SERVICIO de alta (no por un `update ... set modelo='fija'` de mantenimiento), de
 * punta a punta hasta la boleta; los dos modos de falta de valor; el trigger `0030` en los caminos
 * que el archivo de ataques dejó anotados como no cubiertos; y el aislamiento del alta.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { conUsuario, type DbRequest, type DbConIdentidad } from "../src/client.ts";
import { registroPorDefecto } from "@admin-barrios/documentos/cobranza";
import { crearPeriodo, leerPeriodo } from "../src/servicios/periodos.ts";
import { leerBarrio } from "../src/servicios/barrios.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { registrarGasto } from "../src/servicios/gastos.ts";
import { armarVistaBoleta } from "../src/servicios/vista-boleta.ts";
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
let conceptoOrdinario: string;
let conceptoExtraordinario: string;
let actaId: string;

const registro = registroPorDefecto();

function como<T>(usuario: string, fn: (tx: DbConIdentidad) => Promise<T>): Promise<T> {
  return conUsuario(db, usuario, fn);
}

/** Versión de cuota fija para todas las unidades, con la vigencia que se pida. */
async function cuotaDesde(importe: string, desde: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into cuota_fija_version (barrio_id, descripcion, vigente_desde)
     values ($1, $2, $3::date) returning id`,
    [barrioId, `Valor ${importe} desde ${desde}`, desde],
  );
  const versionId = rows[0]!.id;
  for (const u of unidades) {
    await admin.query(
      `insert into cuota_fija (barrio_id, version_id, unidad_funcional_id, importe) values ($1,$2,$3,$4)`,
      [barrioId, versionId, u, importe],
    );
  }
  return versionId;
}

/**
 * Deja el barrio sin períodos y sin valores de cuota. Va en `beforeEach` **a propósito**: la primera
 * versión de este archivo limpiaba al final de cada caso y un caso que fallaba dejaba su versión de
 * cuota abierta, con lo que el caso siguiente —el de "el barrio no definió ningún valor"— encontraba
 * una vigente y pasaba en verde por contaminación. Un fixture que se limpia al salir solo es
 * confiable si ningún caso falla nunca, que es justamente lo contrario de para qué existe este
 * archivo.
 */
async function limpiar(): Promise<void> {
  await admin.query("set session_replication_role = replica");
  await admin.query(
    `delete from item_liquidacion i using liquidacion l, periodo_expensa p
      where l.id = i.liquidacion_id and p.id = l.periodo_id and p.barrio_id = $1`,
    [barrioId],
  );
  await admin.query(
    "delete from liquidacion l using periodo_expensa p where p.id = l.periodo_id and p.barrio_id = $1",
    [barrioId],
  );
  await admin.query("delete from gasto_periodo where barrio_id = $1", [barrioId]);
  await admin.query("delete from periodo_expensa where barrio_id = $1", [barrioId]);
  await admin.query("set session_replication_role = origin");
  await admin.query("delete from cuota_fija where barrio_id = $1", [barrioId]);
  await admin.query("delete from cuota_fija_version where barrio_id = $1", [barrioId]);
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  barrioId = arbol.barrioA1.id;
  await crearBarrio(admin, barrioId);
  await crearBarrio(admin, arbol.barrioB1.id);
  unidades = await crearUnidades(admin, barrioId, 4);
  const version = await crearCoeficientes(admin, barrioId, unidades);
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [version]);

  // Un obligado notificado por unidad: la boleta imprime su nombre y la vista lo necesita.
  for (const [i, unidadId] of unidades.entries()) {
    const { rows } = await admin.query<{ id: string }>(
      `insert into obligado (barrio_id, nombre) values ($1, $2) returning id`,
      [barrioId, `Titular ${i + 1}`],
    );
    await admin.query(
      `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
       values ($1,$2,$3,'propietario', current_date - 100, true)`,
      [barrioId, unidadId, rows[0]!.id],
    );
  }
  await admin.query(
    `insert into mandato_administracion (barrio_id, administrador_id, desde) values ($1,$2,current_date - 200)`,
    [barrioId, arbol.adminA.id],
  );

  const crearConcepto = async (nombre: string, tipo: string) => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
       values ($1,$2,$3,'sin_clasificar') returning id`,
      [barrioId, nombre, tipo],
    );
    return rows[0]!.id;
  };
  conceptoOrdinario = await crearConcepto("Seguridad", "ordinaria");
  conceptoExtraordinario = await crearConcepto("Portón", "extraordinaria");
  const { rows } = await admin.query<{ id: string }>(
    `insert into documento_barrio (barrio_id, tipo, titulo) values ($1,'acta_asamblea','Acta test') returning id`,
    [barrioId],
  );
  actaId = rows[0]!.id;
});

beforeEach(limpiar);

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  for (const tabla of [
    "concepto_boleta_unidad_evento", "item_liquidacion", "liquidacion", "concepto_boleta_unidad",
    "concepto_boleta_valor", "concepto_boleta", "limite_aplicacion_barrio",
    "gasto_periodo", "periodo_expensa", "concepto", "tasa_mora",
    "cuota_fija", "cuota_fija_version",
    "coeficiente", "coeficiente_version", "unidad_obligado", "unidad_contacto", "obligado",
    "unidad_funcional", "mandato_administracion", "barrio_atributo_vigencia", "documento_barrio", "barrio",
  ]) {
    await admin.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [[barrioId, arbol.barrioB1.id]]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 1. El recorrido completo de un período `fija` DADO DE ALTA POR EL SERVICIO
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("1. e2e de un período `fija` creado desde el alta", () => {
  it("crear → gastos → borrador → emitir → boleta, con los totales cuadrados contra la fuente", async () => {
    const versionCuota = await cuotaDesde("100000.00", "2040-01-01");

    const { id: periodoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearPeriodo(tx, {
        barrioId,
        periodo: "2040-01",
        modelo: "fija",
        primerVencimiento: "2040-02-10",
        segundoVencimiento: null,
        notas: null,
      }),
    );

    // Contra la FILA, no contra lo que devolvió el servicio.
    const { rows: fila } = await admin.query<{ modelo: string; estado: string }>(
      "select modelo::text as modelo, estado::text as estado from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(fila[0]).toMatchObject({ modelo: "fija", estado: "borrador" });

    // Un gasto ordinario (se registra, NO se cobra) y una extraordinaria (sí se reparte).
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId, conceptoId: conceptoOrdinario, descripcion: "Vigilancia",
        monto: "777777.00", proveedorNombre: null, comprobante: null, actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId, conceptoId: conceptoExtraordinario, descripcion: "Portón nuevo",
        monto: "40000.00", proveedorNombre: null, comprobante: null, actaDocumentoId: actaId,
      }),
    );

    const resumen = await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    expect(resumen.modelo).toBe("fija");
    // 4 unidades × 100.000 de valor fijo, contra la SUMA DE LA VERSIÓN, no contra una constante.
    const { rows: fuente } = await admin.query<{ suma: string }>(
      "select coalesce(sum(importe),0)::text as suma from cuota_fija where version_id = $1",
      [versionCuota],
    );
    expect(resumen.totalCuotasFijas).toBe(fuente[0]!.suma);
    // Lo repartido = valor fijo + la extraordinaria. El ordinario NO entra.
    expect(resumen.totalRepartido).toBe("440000.00");
    expect(resumen.totalGastos).toBe("817777.00");

    // La versión que quedó fijada en la fila es la que se usó.
    const { rows: fijada } = await admin.query<{ v: string }>(
      "select cuota_fija_version_id::text as v from periodo_expensa where id = $1", [periodoId],
    );
    expect(fijada[0]!.v).toBe(versionCuota);

    // `app.validar_emision` acepta.
    await como(arbol.usuarios.adminBarrioA1, (tx) => emitirPeriodo(tx, { periodoId }));
    const { rows: post } = await admin.query<{ estado: string }>(
      "select estado::text as estado from periodo_expensa where id = $1", [periodoId],
    );
    expect(post[0]!.estado).toBe("emitida");

    // La boleta: sale la línea de valor fijo, y la composición cierra contra el total.
    const { rows: liq } = await admin.query<{ id: string }>(
      "select id from liquidacion where periodo_id = $1 order by numero_comprobante limit 1", [periodoId],
    );
    const vista = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      armarVistaBoleta(tx, liq[0]!.id, { registro }),
    );
    /*
     * **El renglón que lleva la plata lleva el nombre del concepto del barrio**, no un rótulo
     * genérico. Buscaba `"Cuota mensual"` y ese rótulo se eliminó el 2026-08-06: en la hoja impresa
     * salían los dos renglones, el que se llamaba como el barrio decía **cero** y el que llevaba la
     * plata se llamaba con una palabra que el vecino no reconoce.
     */
    const ordinario = vista.composicion.find((r) => r.importe.monto === "100000.00");
    expect(ordinario).toBeDefined();
    expect(ordinario!.importe.texto).toBe("100.000,00");
    // Y se llama con la denominación del barrio, no "Cuota mensual".
    expect(ordinario!.etiqueta.toLowerCase()).toContain("ordinaria");
    expect(ordinario!.etiqueta).not.toBe("Cuota mensual");
    // Y NO queda un segundo renglón ordinario en cero al lado.
    const ordinariosEnCero = vista.composicion.filter(
      (r) => r.etiqueta.toLowerCase().includes("ordinaria") && r.importe.monto === "0.00",
    );
    expect(ordinariosEnCero).toHaveLength(0);
    // Cada unidad: 100.000 de valor fijo + 10.000 de extraordinaria (40.000 / 4).
    expect(vista.totales.delPeriodo.monto).toBe("110000.00");
    expect(vista.totales.aPagar.monto).toBe("110000.00");
    // La composición cierra contra el total: ni un renglón de más ni uno de menos.
    const sumaRenglones = vista.composicion
      .filter((r) => !r.informativo)
      .reduce((acc, r) => acc + Number(r.importe.monto), 0);
    expect(sumaRenglones.toFixed(2)).toBe(vista.totales.delPeriodo.monto);
    /*
     * **Y el gasto ordinario cargado NO se cobró**, que es la propiedad que define el modelo.
     *
     * Se afirmaba mirando que el renglón de ordinarias valiera cero, y eso dejó de servir cuando el
     * renglón ordinario pasó a llevar el valor fijo — que es lo correcto: en este modelo *eso* es lo
     * ordinario. La propiedad se afirma ahora contra la plata, que es donde vive de verdad: el total
     * del período es la cuota más la extraordinaria, y **no incluye** los $ 777.777 de gasto
     * ordinario que el período tiene cargados.
     */
    const gastoOrdinarioCargado = 777_777;
    expect(Number(vista.totales.delPeriodo.monto)).toBeLessThan(gastoOrdinarioCargado);
    expect(vista.totales.delPeriodo.monto).toBe("110000.00");

  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 2. Los dos modos de "no hay valor"
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("2. un período `fija` sin valor aplicable", () => {
  it("el barrio no definió NINGÚN valor: falla al generar, con un error entendible", async () => {
    const { id: periodoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearPeriodo(tx, {
        barrioId, periodo: "2041-01", modelo: "fija",
        primerVencimiento: null, segundoVencimiento: null, notas: null,
      }),
    );

    const error = await como(arbol.usuarios.operadorA1, (tx) =>
      generarLiquidaciones(tx, { periodoId }).then(
        () => null,
        (e: unknown) => e as { codigo?: string; message?: string },
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.codigo).toBe("periodo_incompleto");
    expect(error!.message).toMatch(/cuota vigente para el mes/i);

    // Y no quedó media liquidación colgada.
    const { rows } = await admin.query("select 1 from liquidacion where periodo_id = $1", [periodoId]);
    expect(rows).toHaveLength(0);

  });

  it("el valor rige desde un mes POSTERIOR: mismo rechazo, no un cero silencioso", async () => {
    await cuotaDesde("120000.00", "2042-06-01");
    const { id: periodoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearPeriodo(tx, {
        barrioId, periodo: "2042-03", modelo: "fija",
        primerVencimiento: null, segundoVencimiento: null, notas: null,
      }),
    );

    const error = await como(arbol.usuarios.operadorA1, (tx) =>
      generarLiquidaciones(tx, { periodoId }).then(
        () => null,
        (e: unknown) => e as { codigo?: string },
      ),
    );
    expect(error?.codigo).toBe("periodo_incompleto");

    // Y la pantalla del período tiene que verlo igual: sin versión aplicable el resumen no puede
    // decir "listo para generar".
    const detalle = await como(arbol.usuarios.adminBarrioA1, (tx) => leerPeriodo(tx, { periodoId }));
    expect(detalle?.cuotaFijaVersionId).toBeNull();

  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 3. El trigger 0030 en los caminos que el archivo de ataques dejó fuera
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("3. trigger 0030 — caminos no cubiertos", () => {
  /** Un período `fija` emitido, con su versión de valor fijada. */
  async function fijaEmitido(mes: string): Promise<string> {
    await cuotaDesde("100000.00", `${mes}-01`);
    const { id: periodoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearPeriodo(tx, {
        barrioId, periodo: mes, modelo: "fija",
        primerVencimiento: null, segundoVencimiento: null, notas: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await como(arbol.usuarios.adminBarrioA1, (tx) => emitirPeriodo(tx, { periodoId }));
    return periodoId;
  }

  it("poner en NULL la versión de valor fijo de un período emitido no entra", async () => {
    const periodoId = await fijaEmitido("2043-01");
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update periodo_expensa set cuota_fija_version_id = null where id = ${periodoId}`),
      ),
    ).rejects.toThrow(/no se puede cambiar/i);

    const { rows } = await admin.query<{ v: string | null }>(
      "select cuota_fija_version_id::text as v from periodo_expensa where id = $1", [periodoId],
    );
    expect(rows[0]!.v).not.toBeNull();

  });

  it("el paso emitida → distribuida sigue funcionando con el trigger puesto", async () => {
    const periodoId = await fijaEmitido("2043-02");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      tx.execute(sql`update periodo_expensa set estado = 'distribuida' where id = ${periodoId}`),
    );
    const { rows } = await admin.query<{ estado: string; d: string | null }>(
      "select estado::text as estado, distribuida_at::text as d from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]!.estado).toBe("distribuida");
    expect(rows[0]!.d).not.toBeNull();

  });

  it("ya distribuido, el modelo tampoco se toca", async () => {
    const periodoId = await fijaEmitido("2043-03");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      tx.execute(sql`update periodo_expensa set estado = 'distribuida' where id = ${periodoId}`),
    );
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update periodo_expensa set modelo = 'variable' where id = ${periodoId}`),
      ),
    ).rejects.toThrow(/no se puede cambiar/i);

  });

  /*
   * ────────────────────────────────────────────────────────────────────────────────────────────
   * EMITIR Y MUTAR EN LA MISMA SENTENCIA — el agujero que la primera versión de la 0030 dejaba
   *
   * La guarda original miraba **solo** `old.estado`. En un `update` que sale de `borrador`,
   * `old.estado` es `'borrador'`, así que el trigger devolvía en su primera línea sin verificar
   * nada — y la fila que se escribía ya llevaba el valor nuevo **y** el estado `emitida`.
   *
   * `app.validar_emision(new.id)` no lo compensa: corre en un `before`, o sea que lee de la tabla la
   * fila VIEJA. Validaba un modelo y quedaba escrito el otro: exactamente el estado final que la
   * migración dice impedir, un período emitido que nadie validó.
   *
   * Se tapó mirando los dos estados (`old` y `new`). Estos dos casos nacieron como `it.fails` —el
   * tripwire con el que se demostró el agujero— y se dieron vuelta al arreglarlo. Se quedan porque
   * son la regresión: un candado que nunca se vio fallar no es un candado.
   * ────────────────────────────────────────────────────────────────────────────────────────────
   */
  it("emitir y cambiar el modelo en la MISMA sentencia rebota", async () => {
    // Un período `variable` normal, con su borrador listo para emitir.
    const { id: periodoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearPeriodo(tx, {
        barrioId, periodo: "2043-05", modelo: "variable",
        primerVencimiento: null, segundoVencimiento: null, notas: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarGasto(tx, {
        periodoId, conceptoId: conceptoOrdinario, descripcion: "Vigilancia",
        monto: "100000.00", proveedorNombre: null, comprobante: null, actaDocumentoId: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update periodo_expensa set estado = 'emitida', modelo = 'fija' where id = ${periodoId}`),
      ),
    ).rejects.toThrow();
  });

  it("emitir y cambiar la VERSIÓN DE VALOR FIJO en la misma sentencia también rebota", async () => {
    const v1 = await cuotaDesde("100000.00", "2043-06-01");
    const { id: periodoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearPeriodo(tx, {
        barrioId, periodo: "2043-06", modelo: "fija",
        primerVencimiento: null, segundoVencimiento: null, notas: null,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    // Un aumento posterior: `cuota_fija_version_antes` cierra la anterior.
    const v2 = await cuotaDesde("999999.00", "2043-07-01");

    expect(v1).not.toBe(v2);

    // Sin el candado, lo que quedaba era un período que **dice** haberse calculado con `v2`
    // mientras sus líneas tienen los importes de `v1`: una cifra de dinero cuyo origen declarado es
    // falso, y encima con `app.cuota_fija_version_del_periodo` devolviendo `v2` en la pantalla.
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(
          sql`update periodo_expensa set estado = 'emitida', cuota_fija_version_id = ${v2} where id = ${periodoId}`,
        ),
      ),
    ).rejects.toThrow();
  });

  it("mover un período emitido a OTRO BARRIO tampoco", async () => {
    const periodoId = await fijaEmitido("2043-04");
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update periodo_expensa set barrio_id = ${arbol.barrioA2.id} where id = ${periodoId}`),
      ),
    ).rejects.toThrow();

  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 4. Aislamiento del alta
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("4. aislamiento", () => {
  it("no se puede crear un período en un barrio ajeno pasando su uuid", async () => {
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        crearPeriodo(tx, {
          barrioId: arbol.barrioB1.id, periodo: "2044-01", modelo: "fija",
          primerVencimiento: null, segundoVencimiento: null, notas: null,
        }),
      ),
    ).rejects.toThrow();

    const { rows } = await admin.query(
      "select 1 from periodo_expensa where barrio_id = $1 and periodo = '2044-01'", [arbol.barrioB1.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("un rol de solo lectura no crea períodos", async () => {
    await expect(
      como(arbol.usuarios.contadorA1, (tx) =>
        crearPeriodo(tx, {
          barrioId, periodo: "2044-02", modelo: "fija",
          primerVencimiento: null, segundoVencimiento: null, notas: null,
        }),
      ),
    ).rejects.toThrow();
  });

  it("`tieneCuotaFijaDefinida` no es un oráculo sobre un barrio ajeno", async () => {
    await cuotaDesde("100000.00", "2045-01-01");
    // El barrio propio dice la verdad.
    const propio = await como(arbol.usuarios.adminBarrioA1, (tx) => leerBarrio(tx, { barrioId }));
    expect(propio?.tieneCuotaFijaDefinida).toBe(true);

    // El ajeno no devuelve `false`: devuelve `null` entero, indistinguible de "no existe".
    const ajeno = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      leerBarrio(tx, { barrioId: arbol.barrioB1.id }),
    );
    expect(ajeno).toBeNull();
  });

  /*
   * El flag alimenta un aviso de pantalla, así que tiene que decir lo mismo para todos los roles que
   * llegan ahí. Si un rol viera `false` sobre un barrio que sí definió un valor, el aviso saldría al
   * revés: "todavía no tiene un valor cargado" en un barrio que lo tiene.
   */
  it("`tieneCuotaFijaDefinida` dice lo mismo para todos los roles que leen el barrio", async () => {
    await cuotaDesde("100000.00", "2045-02-01");
    for (const usuario of [
      arbol.usuarios.adminEstudioA,
      arbol.usuarios.adminBarrioA1,
      arbol.usuarios.operadorA1,
      arbol.usuarios.contadorA1,
      arbol.usuarios.auditorA1,
    ]) {
      const b = await como(usuario, (tx) => leerBarrio(tx, { barrioId }));
      expect(b?.tieneCuotaFijaDefinida).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 5. Concurrencia
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("5. concurrencia", () => {
  it("dos altas simultáneas del mismo mes con modelos distintos: solo una queda", async () => {
    const resultados = await Promise.allSettled([
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        crearPeriodo(tx, {
          barrioId, periodo: "2046-01", modelo: "variable",
          primerVencimiento: null, segundoVencimiento: null, notas: null,
        }),
      ),
      como(arbol.usuarios.operadorA1, (tx) =>
        crearPeriodo(tx, {
          barrioId, periodo: "2046-01", modelo: "fija",
          primerVencimiento: null, segundoVencimiento: null, notas: null,
        }),
      ),
    ]);

    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // Y la que perdió lo dice con el código que la pantalla usa para ofrecer la salida, no con un
    // 23505 crudo.
    const perdedora = resultados.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((perdedora.reason as { codigo?: string }).codigo).toBe("periodo_ya_existe");

    const { rows } = await admin.query<{ n: string; modelo: string }>(
      `select count(*)::text as n, min(modelo::text) as modelo
         from periodo_expensa where barrio_id = $1 and periodo = '2046-01'`,
      [barrioId],
    );
    expect(rows[0]!.n).toBe("1");
    // El que quedó tiene UN modelo entero, el de quien ganó: nunca una mezcla de los dos.
    expect(["variable", "fija"]).toContain(rows[0]!.modelo);
  });
});
