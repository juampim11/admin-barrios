/**
 * El libro de movimientos **de punta a punta contra Postgres real**: se siembran cobros y egresos de
 * verdad, se corre el mismo camino que corre la ruta (contar → registrar → leer → construir →
 * serializar) y se verifican los invariantes sobre el resultado.
 *
 * **Por qué este test vive acá y no en `packages/data/test/`.** Lo que prueba no es una consulta ni
 * una policy —eso ya está en `exportaciones-rls.test.ts`— sino que **las tres capas encajan**: el
 * servicio devuelve lo que el dataset espera, el dataset produce lo que el serializador puede
 * escribir, y los totales cierran con datos reales en vez de con los objetos a mano del test unitario.
 * El bug que este archivo existe para atrapar es el de integración: una columna que el servicio
 * renombra y el dataset sigue leyendo con el nombre viejo, y que ningún test de una sola capa ve.
 *
 * Correr con: pnpm vitest run --project db apps/web/test/exportacion-movimientos.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { conUsuario, crearDbRequest, type DbRequest } from "@admin-barrios/data/client";
import {
  contarMovimientos,
  leerLibroDeMovimientos,
  registrarExportacion,
  puedeExportarMovimientos,
} from "@admin-barrios/data/servicios/exportaciones";
import { construirLibro } from "../src/servidor/export/dataset.ts";
import { serializarLibro } from "../src/servidor/export/xlsx.ts";

const PERIODO = "2029-04";
const RANGO = { periodoDesde: PERIODO, periodoHasta: PERIODO } as const;

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;

let barrioId: string;
let nodoId: string;
let raizId: string;
let periodoId: string;
let unidadId: string;
let liquidacionId: string;
const usuarioAdmin = randomUUID();

const como = <T>(fn: (tx: DbRequest) => Promise<T>, usuario = usuarioAdmin): Promise<T> =>
  conUsuario(db, usuario, fn);

beforeAll(async () => {
  // Mismas dos conexiones que `packages/data/test/helpers.ts`: la de administración arma y limpia el
  // fixture por fuera de la RLS, y la de la aplicación —sujeta a RLS— es la que se está probando.
  const urlAdmin = process.env["DATABASE_URL"];
  const urlApp = process.env["DATABASE_URL_APP"];
  if (!urlAdmin || !urlApp) throw new Error("Faltan DATABASE_URL / DATABASE_URL_APP: correr `pnpm db:setup`");

  admin = new pg.Pool({ connectionString: urlAdmin, max: 4 });
  appPool = new pg.Pool({ connectionString: urlApp, max: 4 });
  db = crearDbRequest(appPool);

  const uno = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) =>
    (await admin.query<T>(sql, args)).rows[0] as T;

  // Tenancía mínima: un administrador raíz con un barrio colgando (`tenant_node_root_chk` no deja
  // que un barrio sea raíz — la raíz siempre es el estudio administrador), y un `admin_barrio`
  // activo sobre el barrio.
  raizId = (
    await uno<{ id: string }>(
      `insert into tenant_node (tipo, nombre, parent_id) values ('administrador', $1, null) returning id`,
      [`Estudio export ${PERIODO}`],
    )
  ).id;
  nodoId = (
    await uno<{ id: string }>(
      `insert into tenant_node (tipo, nombre, parent_id) values ('barrio', $1, $2) returning id`,
      ["Los Álamos del Test", raizId],
    )
  ).id;
  barrioId = nodoId;
  await admin.query(
    `insert into membership (user_id, tenant_node_id, rol, activo) values ($1,$2,'admin_barrio',true)`,
    [usuarioAdmin, nodoId],
  );
  await admin.query(
    `insert into barrio (barrio_id, figura_juridica, adecuado_art_2075, encuadre_urbanistico,
                         municipio, servicios_internos_a_cargo_de, cuit)
     values ($1,'ph_especial','en_tramite','ure','villa-allende','urbanizacion','30712345678')`,
    [barrioId],
  );

  unidadId = (
    await uno<{ id: string }>(
      `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
       values ($1,'7','13','construido') returning id`,
      [barrioId],
    )
  ).id;

  periodoId = (
    await uno<{ id: string }>(
      `insert into periodo_expensa (barrio_id, periodo) values ($1,$2) returning id`,
      [barrioId, PERIODO],
    )
  ).id;

  const conceptoId = (
    await uno<{ id: string }>(
      `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
       values ($1,'Mantenimiento','ordinaria','sin_clasificar') returning id`,
      [barrioId],
    )
  ).id;

  // Un egreso normal y uno con un texto hostil, para ver el saneado llegar hasta la planilla.
  await admin.query(
    `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, proveedor_nombre)
     values ($1,$2,$3,'Bombas de agua','15000.00','Bombas del Sur SRL'),
            ($1,$2,$3,'=HYPERLINK("http://malo.test","click")','2500.00','@SUM(A1)')`,
    [barrioId, periodoId, conceptoId],
  );

  liquidacionId = (
    await uno<{ id: string }>(
      `insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado,
                                subtotal_ordinarias, subtotal_extraordinarias, subtotal_fondo_reserva,
                                interes_mora, total)
       values ($1,$2,$3,'1.000000000','800.00','0.00','200.00','0.00','1000.00') returning id`,
      [barrioId, periodoId, unidadId],
    )
  ).id;

  // Dos cobros: uno aplicado entero y otro sin aplicar — los dos casos que la hoja B tiene que cerrar.
  /*
   * Los cobros se siembran con los triggers apagados — mismo patrón que `cobros-imputacion.test.ts`.
   * No es para saltear una validación: `pago` exige `app.current_user_id()` (un pago sin autor no se
   * registra, y con razón) y el pool de administración no tiene identidad de sesión. Lo que se prueba
   * acá es la LECTURA del libro, no el circuito de alta de un cobro, que ya tiene sus propios tests.
   *
   * Se apaga **solo para esto**: los nodos de tenancía necesitan sus triggers vivos, porque el
   * `path` del árbol lo calcula la base y no la aplicación.
   */
  await admin.query("set session_replication_role = replica");

  // La clave se arma en JS y viaja como un parámetro más: interpolarla en SQL obligaba a usar el
  // mismo `$1` como uuid y como texto, y Postgres no puede deducir dos tipos para un parámetro.
  const claveDe = (token: string) => `barrios/${barrioId}/pagos/comprobantes/${token}.pdf`;

  const pagoAplicado = (
    await uno<{ id: string }>(
      `insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen, usuario_registrador,
                         comprobante_adjunto)
       values ($1,$2,'1000.00',$3,'manual',$4,$5) returning id`,
      [barrioId, unidadId, `${PERIODO}-10`, usuarioAdmin, claveDe("aaaaaaaaaaaaaaaaaaaaaa")],
    )
  ).id;
  await admin.query(
    `insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen, usuario_registrador,
                       comprobante_adjunto)
     values ($1,$2,'400.00',$3,'manual',$4,$5)`,
    [barrioId, unidadId, `${PERIODO}-15`, usuarioAdmin, claveDe("bbbbbbbbbbbbbbbbbbbbbb")],
  );
  await admin.query(
    `insert into pago_imputacion (barrio_id, pago_id, liquidacion_id, monto_imputado)
     values ($1,$2,$3,'1000.00')`,
    [barrioId, pagoAplicado, liquidacionId],
  );

  await admin.query("set session_replication_role = origin");
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  for (const tabla of [
    "exportacion_movimientos",
    "pago_imputacion",
    "pago",
    "liquidacion",
    "gasto_periodo",
    "concepto",
    "periodo_expensa",
    "unidad_funcional",
    "barrio_atributo_vigencia",
    "barrio",
  ]) {
    await admin.query(`delete from ${tabla} where barrio_id = $1`, [barrioId]);
  }
  await admin.query("delete from membership where tenant_node_id = $1", [nodoId]);
  await admin.query("delete from tenant_node where id = $1", [nodoId]);
  await admin.query("delete from tenant_node where id = $1", [raizId]);
  await admin.query("set session_replication_role = origin");
  await appPool.end();
  await admin.end();
});

describe("el libro de movimientos, de punta a punta", () => {
  it("el admin del barrio puede exportar", async () => {
    expect(await como((tx) => puedeExportarMovimientos(tx, { barrioId }))).toBe(true);
  });

  it("cuenta lo que sembramos, sin traer las filas", async () => {
    const conteo = await como((tx) => contarMovimientos(tx, { barrioId, ...RANGO }));
    expect(conteo).toEqual({ ingresos: 2, imputaciones: 1, egresos: 2, total: 5 });
  });

  it("arma el libro y produce un XLSX real", async () => {
    const resultado = await como(async (tx) => {
      const conteo = await contarMovimientos(tx, { barrioId, ...RANGO });
      const libro = await leerLibroDeMovimientos(tx, { barrioId, ...RANGO });
      const { selloDeExtraccion } = await registrarExportacion(tx, {
        barrioId,
        ...RANGO,
        conteo,
        incluyoProvisorio: libro.cabecera.incluyeProvisorio,
      });
      return { libro, selloDeExtraccion };
    });

    const paraPlanilla = construirLibro(resultado.libro, RANGO, resultado.selloDeExtraccion);
    const bytes = await serializarLibro(paraPlanilla);

    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    // El período está en borrador: el libro sale marcado.
    expect(paraPlanilla.nombreArchivo).toContain("PROVISORIO");
    expect(paraPlanilla.nombreArchivo).toContain("Los Álamos del Test");
  });

  /**
   * **El invariante del módulo, ahora con datos de verdad.** $1.000 aplicados + $400 a cuenta tienen
   * que dar los mismos $1.400 que la hoja de caja. Si esto se rompe, el contador cuadra la primera
   * hoja contra el banco, pasa a la segunda y los números no coinciden.
   */
  it("la hoja de imputadas cierra contra la de cobranzas", async () => {
    const libro = await como((tx) => leerLibroDeMovimientos(tx, { barrioId, ...RANGO }));
    const paraPlanilla = construirLibro(libro, RANGO, "2029-04-30T10:00:00Z");

    const a = paraPlanilla.hojas.find((h) => h.nombre === "Cobranzas (percibido)");
    const b = paraPlanilla.hojas.find((h) => h.nombre === "Cobranzas imputadas");

    expect(a?.bloquePosterior.join(" ")).toContain("Total cobrado: 1400.00");
    expect(a?.bloquePosterior.join(" ")).toContain("Total aplicado: 1000.00");
    expect(a?.bloquePosterior.join(" ")).toContain("Total a cuenta: 400.00");

    // La imputación real más la fila residual del pago sin aplicar.
    expect(b?.filas).toHaveLength(2);
    const sumaB = (b?.filas ?? []).reduce((acum, fila) => acum + Number(fila[4] ?? 0), 0);
    expect(sumaB).toBe(1400);
  });

  it("el saneado de fórmula llega hasta la planilla con datos reales", async () => {
    const libro = await como((tx) => leerLibroDeMovimientos(tx, { barrioId, ...RANGO }));
    const paraPlanilla = construirLibro(libro, RANGO, "2029-04-30T10:00:00Z");
    const egresos = paraPlanilla.hojas.find((h) => h.nombre === "Egresos");

    const textos = (egresos?.filas ?? []).flat().map((c) => String(c));
    expect(textos.some((t) => t.startsWith("'=HYPERLINK"))).toBe(true);
    expect(textos.some((t) => t.startsWith("'@SUM"))).toBe(true);
    // Y ninguna celda quedó empezando con un carácter que Excel evalúe.
    expect(textos.some((t) => /^[=+@]/.test(t))).toBe(false);
  });

  it("el período en borrador toma la clasificación del catálogo, y la fila lo dice", async () => {
    const libro = await como((tx) => leerLibroDeMovimientos(tx, { barrioId, ...RANGO }));
    expect(libro.cabecera.incluyeProvisorio).toBe(true);
    expect(libro.egresos.every((e) => e.origenClasificacion === "catalogo")).toBe(true);

    const paraPlanilla = construirLibro(libro, RANGO, "2029-04-30T10:00:00Z");
    const egresos = paraPlanilla.hojas.find((h) => h.nombre === "Egresos");
    expect(egresos?.filas[0]).toContain("Catálogo vigente (borrador)");
    expect(egresos?.filas[0]).toContain("SIN CLASIFICAR — requiere definición");
  });

  it("la cabecera trae la figura vigente y el CUIT del barrio", async () => {
    const libro = await como((tx) => leerLibroDeMovimientos(tx, { barrioId, ...RANGO }));
    expect(libro.cabecera.figuraJuridica).toBe("ph_especial");
    expect(libro.cabecera.barrioCuit).toBe("30712345678");
    expect(libro.cabecera.barrioNombre).toBe("Los Álamos del Test");
  });

  it("un rango fuera de los períodos sembrados sale vacío, no falla", async () => {
    const libro = await como((tx) =>
      leerLibroDeMovimientos(tx, { barrioId, periodoDesde: "2029-11", periodoHasta: "2029-12" }),
    );
    expect(libro.ingresos).toHaveLength(0);
    expect(libro.egresos).toHaveLength(0);

    // Y el libro vacío sigue produciendo un archivo abrible: el contador tiene que poder ver que no
    // hubo movimientos, no recibir un error.
    const bytes = await serializarLibro(construirLibro(libro, RANGO, "2029-04-30T10:00:00Z"));
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});
