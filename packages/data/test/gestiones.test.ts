/**
 * Encargo E-a2, contra Postgres real (`0091`): registrar y anular gestiones, el adjunto y el estado de
 * la promesa resuelto con los pagos e imputaciones de siempre.
 *
 * El caso: el barrio A1 de «Estudio Pérez» con cuatro unidades que deben un mes vencido de $ 1.000
 * cada una (el barrio no cobra interés, para que las cuentas se lean a mano). Un estudio trabaja en A1.
 *
 * **La regla del pago parcial** (la de Aclade, `promesas_de_pago` de su `0014`): una promesa se cumple
 * solo si lo pagado —lo imputado de pagos con fecha entre el alta de la gestión y la fecha prometida,
 * inclusive— **llega al monto**. Pagada en parte, sigue «pendiente» hasta su fecha y después queda
 * «vencida», con lo pagado a la vista.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { registrarEImputarPago } from "../src/servicios/deuda.ts";
import { anularPago } from "../src/servicios/pagos.ts";
import { agregarEstudio, cambiarEstudioDelBarrio, derivar } from "../src/servicios/mora.ts";
import {
  anularGestion,
  fichaDeMora,
  prepararDescargaDeAdjuntoDeGestion,
  prepararSubidaDeAdjuntoDeGestion,
  registrarGestion,
  sha256DeAdjunto,
} from "../src/servicios/gestiones.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf: [string, string, string, string];
let hoy: string;
let estudio: string;

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminA = () => arbol.usuarios.adminEstudioA;
const operador = () => arbol.usuarios.operadorA1;
const CUIT_TEST = "30710000057";

const dia = (n: number) => {
  const d = new Date(`${hoy}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

const pagar = (unidad: string, monto: string, fecha: string) =>
  como(adminA(), (tx) =>
    registrarEImputarPago(tx, {
      pago: { unidadFuncionalId: unidad, obligadoId: null, monto, fecha, origen: "extracto", comprobanteAdjunto: null },
      confirmarPagoConInteres: true,
      noCobrarInteres: null,
    }),
  );

const promesaDe = async (unidad: string) => (await como(adminA(), (tx) => fichaDeMora(tx, { unidadFuncionalId: unidad })))!.promesa;

/** Una promesa de días anteriores: la base fija el alta en «hoy», así que va con los triggers apagados. */
async function promesaPasada(unidad: string, alta: string, fecha: string, monto: string): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query(
      `insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, fecha, promesa_fecha, promesa_monto, registrado_por, registrado_at)
       values ($1, $2, 'administracion', 'whatsapp', 'promesa_de_pago', $3, $4, $5, $6, now())`,
      [barrio(), unidad, alta, fecha, monto, adminA()],
    );
    await c.query("commit");
  } finally {
    c.release();
  }
}

async function limpiar(): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["gestion_anulacion", "gestion", "derivacion_foto", "derivacion", "estudio_barrio", "mora_barrio"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("delete from estudio_administracion where administracion_id = $1", [arbol.adminA.id]);
    await c.query("delete from estudio_juridico where cuit = $1", [CUIT_TEST]);
    await c.query("commit");
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  await crearBarrio(admin, arbol.barrioB1.id);
  await borrarParametrosDe(admin, [barrio()]);
  await cargarParametro(admin, barrio(), "interes.cobra", false);
  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     values ($1,'1','1','construido'), ($1,'1','2','construido'), ($1,'1','3','construido'), ($1,'1','4','construido') returning id`,
    [barrio()],
  );
  uf = [ufs[0]!.id, ufs[1]!.id, ufs[2]!.id, ufs[3]!.id];
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [barrio()],
  );
  for (const u of uf) {
    await admin.query("insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1, $2, $3, 0.25)", [barrio(), v[0]!.id, u]);
  }
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [barrio()],
  );
  const { rows: p } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, '2026-01', '2026-01-10') returning id",
    [barrio()],
  );
  await admin.query("insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '4000.00')", [
    barrio(),
    p[0]!.id,
    c[0]!.id,
  ]);
  await como(adminA(), (tx) => generarLiquidaciones(tx, { periodoId: p[0]!.id, origenSaldo: "calculado", fechaCorteMora: "2026-01-01" }));
  await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: p[0]!.id }));
  hoy = (await admin.query<{ hoy: string }>("select (now() at time zone zona_horaria)::date::text as hoy from barrio where barrio_id = $1", [barrio()])).rows[0]!
    .hoy;

  await limpiar();
  estudio = (
    await como(adminA(), (tx) =>
      agregarEstudio(tx, {
        administracionId: arbol.adminA.id,
        nombre: "Estudio de Gestiones",
        cuit: CUIT_TEST,
        correoAvisos: "gestiones@estudio.test",
        telefonoBoleta: null,
        preferenciaAviso: "cada_derivacion",
      }),
    )
  ).estudioId;
  await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: barrio(), estudioId: estudio, accion: "sumar" }));
});

afterAll(async () => {
  await limpiar();
  await borrarParametrosDe(admin, [barrio()]);
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago", "item_liquidacion", "liquidacion",
      "gasto_periodo", "periodo_expensa", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("delete from barrio where barrio_id = any($1::uuid[])", [[barrio(), arbol.barrioB1.id]]);
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarArbol(admin, arbol);
  await appPool.end();
  await admin.end();
});

describe("registrar una gestión", () => {
  it("la registra el operador, a su nombre y con el día de hoy en el barrio", async () => {
    const { gestionId } = await como(operador(), (tx) =>
      registrarGestion(tx, { unidadFuncionalId: uf[0], canal: "llamada", resultado: "no_contesta", nota: "", promesaFecha: "", promesaMonto: "" }),
    );
    const { rows } = await admin.query<{ fecha: string; registrado_por: string; autor_tipo: string }>(
      "select fecha::text as fecha, registrado_por, autor_tipo from gestion where id = $1",
      [gestionId],
    );
    expect(rows[0]).toEqual({ fecha: hoy, registrado_por: operador(), autor_tipo: "administracion" });
  });

  it("la misma gestión dos veces seguidas (doble clic) se rechaza", async () => {
    const e = await capturar(() =>
      como(operador(), (tx) =>
        registrarGestion(tx, { unidadFuncionalId: uf[0], canal: "llamada", resultado: "no_contesta", nota: "", promesaFecha: "", promesaMonto: "" }),
      ),
    );
    expect(e.message).toMatch(/ya se registró recién/);
  });

  it("la promesa va de hoy en adelante y hasta 60 días", async () => {
    const promesa = (fecha: string) =>
      capturar(() =>
        como(operador(), (tx) =>
          registrarGestion(tx, { unidadFuncionalId: uf[0], canal: "whatsapp", resultado: "promesa_de_pago", nota: "", promesaFecha: fecha, promesaMonto: "100.00" }),
        ),
      );
    expect((await promesa(dia(-1))).message).toMatch(/ya pasó/);
    expect((await promesa(dia(61))).message).toMatch(/hasta 60 días/);
  });

  it("el contador no registra (es de solo lectura) y nadie registra el renglón de una derivación", async () => {
    const e = await capturar(() =>
      como(arbol.usuarios.contadorA1, (tx) =>
        registrarGestion(tx, { unidadFuncionalId: uf[0], canal: "llamada", resultado: "contactado", nota: "", promesaFecha: "", promesaMonto: "" }),
      ),
    );
    expect(e.codigo).toBe("sin_permiso");
    expect(() =>
      // @ts-expect-error: «derivacion» no es un canal que se registre a mano
      registrarGestion(null as never, { unidadFuncionalId: uf[0], canal: "derivacion", resultado: "contactado", nota: "", promesaFecha: "", promesaMonto: "" }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe("el adjunto", () => {
  it("la clave la da el servidor, dentro de la carpeta de gestiones del barrio; el contador no la pide", async () => {
    const { storageKey } = await como(operador(), (tx) => prepararSubidaDeAdjuntoDeGestion(tx, { unidadFuncionalId: uf[1], contentType: "application/pdf" }));
    expect(storageKey).toMatch(new RegExp(`^barrios/${barrio()}/gestiones/[A-Za-z0-9_-]{22,64}\\.pdf$`));
    const e = await capturar(() =>
      como(arbol.usuarios.contadorA1, (tx) => prepararSubidaDeAdjuntoDeGestion(tx, { unidadFuncionalId: uf[1], contentType: "application/pdf" })),
    );
    expect(e.codigo).toBe("sin_permiso");
  });

  it("es obligatorio para la carta documento y la nota firmada", async () => {
    for (const canal of ["carta_documento", "nota"] as const) {
      await expect(
        como(operador(), (tx) => registrarGestion(tx, { unidadFuncionalId: uf[1], canal, resultado: "enviada", nota: "", promesaFecha: "", promesaMonto: "" })),
      ).rejects.toMatchObject({ name: "ZodError" });
    }
  });

  it("se guarda con su sha256, su nombre y su tipo, y se descarga por la gestión", async () => {
    const { storageKey } = await como(operador(), (tx) => prepararSubidaDeAdjuntoDeGestion(tx, { unidadFuncionalId: uf[1], contentType: "application/pdf" }));
    const contenido = Buffer.from("%PDF-1.4 carta documento de prueba");
    const sha = sha256DeAdjunto(contenido);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const { gestionId } = await como(operador(), (tx) =>
      registrarGestion(tx, {
        unidadFuncionalId: uf[1],
        canal: "carta_documento",
        resultado: "enviada",
        nota: "Al domicilio de la unidad.",
        promesaFecha: "",
        promesaMonto: "",
        adjunto: { clave: storageKey, nombre: "CD acuse.pdf" },
        adjuntoSha256: sha,
      }),
    );
    const { rows } = await admin.query("select adjunto_clave, adjunto_sha256, adjunto_nombre, adjunto_tipo from gestion where id = $1", [gestionId]);
    expect(rows[0]).toEqual({ adjunto_clave: storageKey, adjunto_sha256: sha, adjunto_nombre: "CD acuse.pdf", adjunto_tipo: "application/pdf" });
    expect(await como(arbol.usuarios.contadorA1, (tx) => prepararDescargaDeAdjuntoDeGestion(tx, { gestionId }))).toEqual({
      storageKey,
      nombreArchivo: "CD acuse.pdf",
    });
    // Otra administración no lo descarga: para ella la gestión no existe.
    const e = await capturar(() => como(arbol.usuarios.adminEstudioB, (tx) => prepararDescargaDeAdjuntoDeGestion(tx, { gestionId })));
    expect(e.codigo).toBe("referencia_inexistente");
  });

  it("una clave de otro barrio o sin su sha256 no se acepta", async () => {
    const ajena = `barrios/${arbol.barrioB1.id}/gestiones/AAAAAAAAAAAAAAAAAAAAAAAA.pdf`;
    const propia = `barrios/${barrio()}/gestiones/BBBBBBBBBBBBBBBBBBBBBBBB.pdf`;
    for (const [clave, sha] of [
      [ajena, "a".repeat(64)],
      [propia, null],
      [propia, "no-es-un-hash"],
    ] as const) {
      const e = await capturar(() =>
        como(operador(), (tx) =>
          registrarGestion(tx, {
            unidadFuncionalId: uf[1],
            canal: "carta_documento",
            resultado: "enviada",
            nota: "x",
            promesaFecha: "",
            promesaMonto: "",
            adjunto: { clave, nombre: "x.pdf" },
            adjuntoSha256: sha,
          }),
        ),
      );
      expect(e.message).toMatch(/no se pudo verificar/);
    }
  });
});

describe("lo que cerró la revisión de E-a2", () => {
  it("la clave del adjunto de una gestión no se reusa en otra (ni en otra unidad del barrio)", async () => {
    const { rows } = await admin.query<{ clave: string; sha: string }>(
      "select adjunto_clave as clave, adjunto_sha256 as sha from gestion where adjunto_clave is not null limit 1",
    );
    const e = await capturar(() =>
      como(operador(), (tx) =>
        registrarGestion(tx, {
          unidadFuncionalId: uf[2],
          canal: "carta_documento",
          resultado: "enviada",
          nota: "",
          promesaFecha: "",
          promesaMonto: "",
          adjunto: { clave: rows[0]!.clave, nombre: "copia.pdf" },
          adjuntoSha256: rows[0]!.sha,
        }),
      ),
    );
    expect(e.message).toMatch(/no se pudo verificar/);
  });

  it("la descarga lleva la extensión de la clave, no la del nombre que se tipeó", async () => {
    const { storageKey } = await como(operador(), (tx) => prepararSubidaDeAdjuntoDeGestion(tx, { unidadFuncionalId: uf[1], contentType: "application/pdf" }));
    const { gestionId } = await como(operador(), (tx) =>
      registrarGestion(tx, {
        unidadFuncionalId: uf[1],
        canal: "nota",
        resultado: "intimacion_entregada",
        nota: "",
        promesaFecha: "",
        promesaMonto: "",
        adjunto: { clave: storageKey, nombre: "acuse firmado.exe" },
        adjuntoSha256: sha256DeAdjunto(Buffer.from("%PDF-1.4 acuse")),
      }),
    );
    expect((await como(adminA(), (tx) => prepararDescargaDeAdjuntoDeGestion(tx, { gestionId }))).nombreArchivo).toBe("acuse firmado.pdf");
  });

  it("«Enviada» va solo con la carta documento o la nota", async () => {
    await expect(
      como(operador(), (tx) => registrarGestion(tx, { unidadFuncionalId: uf[1], canal: "llamada", resultado: "enviada", nota: "", promesaFecha: "", promesaMonto: "" })),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("el operador anula solo las que cargó él; la administración, cualquiera", async () => {
    const { gestionId } = await como(adminA(), (tx) =>
      registrarGestion(tx, { unidadFuncionalId: uf[1], canal: "visita", resultado: "contactado", nota: "", promesaFecha: "", promesaMonto: "" }),
    );
    expect((await como(operador(), (tx) => fichaDeMora(tx, { unidadFuncionalId: uf[1] })))!.gestiones.find((g) => g.id === gestionId)!.anulable).toBe(false);
    expect((await capturar(() => como(operador(), (tx) => anularGestion(tx, { gestionId, motivo: "No es mía." })))).codigo).toBe("sin_permiso");
    const { gestionId: delOperador } = await como(operador(), (tx) =>
      registrarGestion(tx, { unidadFuncionalId: uf[1], canal: "visita", resultado: "no_contesta", nota: "", promesaFecha: "", promesaMonto: "" }),
    );
    await como(adminA(), (tx) => anularGestion(tx, { gestionId: delOperador, motivo: "La anula la administración." }));
  });
});

describe("el estado de la promesa, con los pagos e imputaciones de siempre", () => {
  it("pendiente: hasta la fecha prometida, sin pago", async () => {
    await como(operador(), (tx) =>
      registrarGestion(tx, { unidadFuncionalId: uf[2], canal: "whatsapp", resultado: "promesa_de_pago", nota: "", promesaFecha: dia(10), promesaMonto: "400.00" }),
    );
    expect(await promesaDe(uf[2])).toEqual({ fecha: dia(10), monto: "400.00", pagado: "0.00", estado: "pendiente" });
  });

  it("pagada en parte: sigue pendiente, con lo pagado a la vista", async () => {
    await pagar(uf[2], "300.00", hoy);
    expect(await promesaDe(uf[2])).toEqual({ fecha: dia(10), monto: "400.00", pagado: "300.00", estado: "pendiente" });
  });

  it("cumplida con pago: lo pagado llega al monto", async () => {
    await pagar(uf[2], "100.00", hoy);
    expect(await promesaDe(uf[2])).toEqual({ fecha: dia(10), monto: "400.00", pagado: "400.00", estado: "cumplida" });
  });

  it("vencida: pasó la fecha sin pago", async () => {
    await promesaPasada(uf[3], dia(-20), dia(-10), "500.00");
    expect(await promesaDe(uf[3])).toEqual({ fecha: dia(-10), monto: "500.00", pagado: "0.00", estado: "vencida" });
  });

  it("pagada en parte y pasada la fecha: vencida, con lo pagado; un pago después de la fecha no cuenta", async () => {
    await pagar(uf[3], "200.00", dia(-15));
    await pagar(uf[3], "800.00", dia(-5));
    expect(await promesaDe(uf[3])).toEqual({ fecha: dia(-10), monto: "500.00", pagado: "200.00", estado: "vencida" });
  });

  it("un pago anulado no cuenta", async () => {
    const { rows } = await admin.query<{ id: string }>("select id from pago where unidad_funcional_id = $1 and fecha = $2", [uf[3], dia(-15)]);
    await como(adminA(), (tx) => anularPago(tx, { pagoId: rows[0]!.id, motivo: "Cargado dos veces." }));
    expect((await promesaDe(uf[3]))?.pagado).toBe("0.00");
  });
});

describe("anular", () => {
  it("la administración anula la suya con motivo; queda en la ficha, tachada", async () => {
    const { gestionId } = await como(operador(), (tx) =>
      registrarGestion(tx, { unidadFuncionalId: uf[1], canal: "mail", resultado: "contactado", nota: "", promesaFecha: "", promesaMonto: "" }),
    );
    await como(operador(), (tx) => anularGestion(tx, { gestionId, motivo: "Cargada en la unidad equivocada." }));
    const g = (await como(adminA(), (tx) => fichaDeMora(tx, { unidadFuncionalId: uf[1] })))!.gestiones.find((x) => x.id === gestionId)!;
    expect(g.anulacion?.motivo).toBe("Cargada en la unidad equivocada.");
    expect(g.anulable).toBe(false);
    expect((await capturar(() => como(operador(), (tx) => anularGestion(tx, { gestionId, motivo: "Otra vez." })))).message).toMatch(/ya está anulada/);
  });

  it("las gestiones no aceptan UPDATE ni DELETE", async () => {
    const { rows } = await admin.query<{ id: string }>("select id from gestion where unidad_funcional_id = $1 limit 1", [uf[1]]);
    for (const consulta of [sql`update gestion set nota = 'x' where id = ${rows[0]!.id}`, sql`delete from gestion where id = ${rows[0]!.id}`]) {
      await expect(como(adminA(), (tx) => tx.execute(consulta))).rejects.toThrow();
    }
    const c = await admin.connect();
    try {
      await expect(c.query("update gestion set nota = 'x' where id = $1", [rows[0]!.id])).rejects.toThrow(/no se editan ni se borran/);
      await expect(c.query("delete from gestion where id = $1", [rows[0]!.id])).rejects.toThrow(/no se editan ni se borran/);
    } finally {
      c.release();
    }
  });

  it("ni la del estudio ni el renglón de una derivación", async () => {
    await como(adminA(), (tx) =>
      derivar(tx, { unidades: [{ unidadFuncionalId: uf[0], barrioId: barrio(), estudioId: estudio }], motivo: "criterio_cumplido", nota: null }),
    );
    const ficha = (await como(adminA(), (tx) => fichaDeMora(tx, { unidadFuncionalId: uf[0] })))!;
    const renglon = ficha.gestiones.find((g) => g.canal === "derivacion")!;
    expect(renglon.anulable).toBe(false);
    expect((await capturar(() => como(adminA(), (tx) => anularGestion(tx, { gestionId: renglon.id, motivo: "No." })))).message).toMatch(/se retira/);
    const c = await admin.connect();
    let delEstudio = "";
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      const { rows } = await c.query<{ id: string }>(
        `insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, estudio_id, canal, resultado, fecha, registrado_por)
         values ($1, $2, 'estudio', $3, 'llamada', 'contactado', current_date, $4) returning id`,
        [barrio(), uf[0], estudio, "00000000-0000-4000-9000-0000000000f9"],
      );
      delEstudio = rows[0]!.id;
      await c.query("commit");
    } finally {
      c.release();
    }
    expect((await capturar(() => como(adminA(), (tx) => anularGestion(tx, { gestionId: delEstudio, motivo: "No." })))).codigo).toBe("sin_permiso");
  });
});

describe("la ficha", () => {
  it("trae las cifras de siempre, la derivación con su foto y las gestiones de los dos autores", async () => {
    const f = (await como(adminA(), (tx) => fichaDeMora(tx, { unidadFuncionalId: uf[0] })))!;
    expect([f.meses, f.capitalVencido, f.interes]).toEqual([1, "1000.00", "0.00"]);
    expect(f.atraso?.desde).toBe("2026-01-10");
    expect(f.derivacionVigente?.estudio).toBe("Estudio de Gestiones");
    expect(f.derivacionVigente?.foto?.capitalVencido).toBe("1000.00");
    expect(new Set(f.gestiones.map((g) => g.autor))).toEqual(new Set(["administracion", "estudio"]));
    expect([f.puedeRegistrar, f.puedeRetirar]).toEqual([true, true]);
    const delOperador = (await como(operador(), (tx) => fichaDeMora(tx, { unidadFuncionalId: uf[0] })))!;
    expect([delOperador.puedeRegistrar, delOperador.puedeRetirar]).toEqual([true, false]);
  });

  it("RLS: otra administración no ve la ficha ni las gestiones", async () => {
    expect(await como(arbol.usuarios.adminEstudioB, (tx) => fichaDeMora(tx, { unidadFuncionalId: uf[0] }))).toBeNull();
    const { rows } = await como(arbol.usuarios.adminEstudioB, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from gestion`));
    expect(rows[0]!.n).toBe(0);
    const { rows: anuladas } = await como(arbol.usuarios.adminEstudioB, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from gestion_anulacion`));
    expect(anuladas[0]!.n).toBe(0);
    const e = await capturar(() =>
      como(arbol.usuarios.adminEstudioB, (tx) =>
        registrarGestion(tx, { unidadFuncionalId: uf[0], canal: "llamada", resultado: "contactado", nota: "", promesaFecha: "", promesaMonto: "" }),
      ),
    );
    expect(e.codigo).toBe("unidad_no_encontrada");
  });
});
