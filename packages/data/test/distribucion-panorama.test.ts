/**
 * **Lo que la pantalla de distribución cree, contra lo que la base dice.**
 *
 * `distribucion-rls.test.ts` fija que no se pueda construir el sobre de otro vecino, y
 * `distribucion-envio.test.ts` que el mismo sobre no salga dos veces. Este archivo persigue una
 * falla distinta y más silenciosa: **que la pantalla muestre un número que no es**.
 *
 * Los dos que más importan:
 *
 *  - **`unidadesSinContacto`.** Es el conteo de a quiénes NO les va a llegar nada. Si sale bajo por
 *    un `join` que multiplica filas, alguien manda tranquilo y tres vecinos llaman en enero.
 *  - **`puedeDistribuir`.** Si dijera `true` para un `operador`, la pantalla le ofrecería un botón
 *    primario que el trigger de `0053` va a rechazar — y encima con un mensaje de permisos, que se
 *    lee como una falla del sistema y no como lo que es.
 *
 * También fija el gate de rol **en la base**, que es el único que no se puede saltear: el encolado
 * no tiene ninguna compuerta en TypeScript, a propósito.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/distribucion-panorama.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { panoramaDeDistribucion } from "../src/servicios/distribucion.ts";
import { encolarTrabajoDelPeriodo } from "../src/servicios/trabajos.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;

let periodoId: string;
let liquidacionConContacto: string;
let liquidacionSinContacto: string;

const PERIODO = "2029-12";
const como = <T>(fn: (tx: DbRequest) => Promise<T>, usuario = arbol.usuarios.adminBarrioA1) =>
  conUsuario(db, usuario, fn);

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomUUID().replaceAll("-", "") + "ab";
const clave = (carpeta: string, ext = "pdf") =>
  `barrios/${arbol.barrioA1.id}/periodos/${periodoId}/${carpeta}/${token()}.${ext}`;

const uno = async (q: string, args: unknown[]) =>
  (await admin.query<{ id: string }>(q, args)).rows[0]!.id;

/** Emite una boleta con la conexión de administración. Devuelve el id del documento. */
async function emitirBoleta(liquidacionId: string, semilla: string): Promise<string> {
  await admin.query("set session_replication_role = replica");
  const id = await uno(
    `insert into documento_emitido (barrio_id, periodo_id, tipo, liquidacion_id, storage_key,
                                    sha256, bytes, vista, vista_version, motor, plantilla_hash,
                                    medio_cobranza, emitido_por)
     values ($1,$2,'boleta_unidad',$3,$4,$5, 1024, '{}'::jsonb, 'boleta/1', 'test', $5, 'cupon', $6)
     returning id`,
    [arbol.barrioA1.id, periodoId, liquidacionId, clave("boletas"), hash(semilla), arbol.usuarios.adminBarrioA1],
  );
  await admin.query("set session_replication_role = origin");
  return id;
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);

  periodoId = await uno(
    `insert into periodo_expensa (barrio_id, periodo) values ($1,$2) returning id`,
    [arbol.barrioA1.id, PERIODO],
  );

  const armarUnidad = async (lote: string, emails: readonly string[]) => {
    const id = await uno(
      `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
       values ($1,'1',$2,'construido') returning id`,
      [arbol.barrioA1.id, lote],
    );
    const liquidacionId = await uno(
      `insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado,
                                subtotal_ordinarias, subtotal_extraordinarias, subtotal_fondo_reserva,
                                interes_mora, total)
       values ($1,$2,$3,'0.333333333','100000.00','0.00','0.00','0.00','100000.00') returning id`,
      [arbol.barrioA1.id, periodoId, id],
    );
    for (const email of emails) {
      await admin.query(
        `insert into unidad_contacto (barrio_id, unidad_funcional_id, email, principal)
         values ($1,$2,$3,$4)`,
        [arbol.barrioA1.id, id, email, email === emails[0]],
      );
    }
    return liquidacionId;
  };

  /*
   * **La unidad con DOS casillas es el fixture importante.** `destinatarios` cuenta unidades a las
   * que les llega, no filas de contacto: sin el `distinct` sobre la unidad, esta sola haría que el
   * conteo diga 3 cuando las unidades con boleta y contacto son 2, y el cartel de confirmación
   * prometería más envíos de los que hay.
   */
  liquidacionConContacto = await armarUnidad("1", ["ana@ejemplo.test", "ana.alt@ejemplo.test"]);
  await armarUnidad("2", ["bruno@ejemplo.test"]);
  liquidacionSinContacto = await armarUnidad("3", []);

  await admin.query("set session_replication_role = replica");
  await admin.query(
    "update periodo_expensa set estado = 'emitida', emitida_at = now(), emitida_por = $2 where id = $1",
    [periodoId, arbol.usuarios.adminBarrioA1],
  );
  await admin.query("set session_replication_role = origin");
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  /*
   * De hijo a padre, y **`barrio` incluido**: `borrarArbol` borra el `tenant_node`, y la fila de
   * `barrio` lo referencia con `on delete restrict`. Mismo cierre que `distribucion-envio.test.ts`,
   * con `paquete_distribucion` sumado — el manifiesto cae por su propio `on delete cascade`, pero el
   * paquete no. Sin esto el archivo pasa igual y lo que falla es el `afterAll`: el error aparece
   * como una suite rota sin un solo test en rojo.
   */
  for (const t of [
    "envio_liquidacion", "trabajo", "paquete_distribucion", "documento_emitido", "liquidacion",
    "unidad_contacto", "unidad_funcional", "periodo_expensa",
    "barrio_atributo_vigencia", "barrio",
  ]) {
    await admin.query(`delete from ${t} where barrio_id = $1`, [arbol.barrioA1.id]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await admin.end();
  await appPool.end();
});

describe("el panorama que dibuja la pantalla", () => {
  it("sin boletas emitidas no hay nada que distribuir, y no lanza", async () => {
    const p = await como((tx) => panoramaDeDistribucion(tx, { periodoId }));

    // El punto es que **no lance**: "todavía no hay nada" es un estado que la pantalla dibuja.
    expect(p.boletas).toBe(0);
    expect(p.informeEmitido).toBe(false);
    expect(p.paquete).toBeNull();
    expect(p.destinatarios).toBe(0);
  });

  it("cuenta UNIDADES y no filas de contacto: una unidad con dos casillas es un destinatario", async () => {
    await emitirBoleta(liquidacionConContacto, "con-contacto");
    await emitirBoleta(liquidacionSinContacto, "sin-contacto");

    const p = await como((tx) => panoramaDeDistribucion(tx, { periodoId }));

    expect(p.boletas).toBe(2);
    // Una sola unidad con boleta Y contacto, pese a tener dos casillas cargadas.
    expect(p.destinatarios).toBe(1);
    // Y la otra, con boleta y sin ninguna casilla, se cuenta aparte en vez de callarse.
    expect(p.unidadesSinContacto).toBe(1);
  });

  it("`informeEmitido` se enciende recién cuando el informe existe", async () => {
    expect(await como((tx) => panoramaDeDistribucion(tx, { periodoId }))).toMatchObject({
      informeEmitido: false,
    });

    await admin.query("set session_replication_role = replica");
    await uno(
      `insert into documento_emitido (barrio_id, periodo_id, tipo, storage_key, sha256, bytes, vista,
                                      vista_version, motor, plantilla_hash, medio_cobranza, emitido_por)
       values ($1,$2,'informe_mensual',$3,$4, 2048, '{}'::jsonb, 'informe-mensual/2', 'test', $4, 'cupon', $5)
       returning id`,
      [arbol.barrioA1.id, periodoId, clave("informes"), hash("informe"), arbol.usuarios.adminBarrioA1],
    );
    await admin.query("set session_replication_role = origin");

    expect(await como((tx) => panoramaDeDistribucion(tx, { periodoId }))).toMatchObject({
      informeEmitido: true,
    });
  });

  it("el paquete se reporta SUPERADO si se emitió una boleta después de armarlo", async () => {
    await admin.query("set session_replication_role = replica");
    const paqueteId = await uno(
      `insert into paquete_distribucion (barrio_id, periodo_id, storage_key, sha256, bytes, armado_por)
       values ($1,$2,$3,$4, 4096, $5) returning id`,
      [arbol.barrioA1.id, periodoId, clave("paquetes", "zip"), hash("zip"), arbol.usuarios.adminBarrioA1],
    );
    // El manifiesto trae SOLO una de las dos boletas ya emitidas: el ZIP nace incompleto.
    const { rows } = await admin.query<{ id: string }>(
      "select id from documento_emitido where periodo_id = $1 and tipo = 'boleta_unidad' order by emitido_at limit 1",
      [periodoId],
    );
    // Sin `barrio_id`: el manifiesto **no lo tiene**. El tenant lo hereda del paquete, que es lo que
    // hace que no pueda quedar apuntando a otro barrio que el de su propio ZIP.
    await admin.query(
      "insert into paquete_distribucion_item (paquete_id, documento_id) values ($1,$2)",
      [paqueteId, rows[0]!.id],
    );
    await admin.query("set session_replication_role = origin");

    const p = await como((tx) => panoramaDeDistribucion(tx, { periodoId }));

    expect(p.paquete).not.toBeNull();
    expect(p.paquete!.documentos).toBe(1);
    // Ésta es la cifra que hace que la pantalla diga "el paquete quedó desactualizado" en vez de
    // ofrecer una descarga que miente por omisión.
    expect(p.paquete!.boletasFaltantes).toBe(1);
  });
});

describe("el gate de rol de la distribución vive en la base", () => {
  it("`puedeDistribuir` es false para un operador y true para el admin del barrio", async () => {
    const comoAdmin = await como((tx) => panoramaDeDistribucion(tx, { periodoId }));
    const comoOperador = await como(
      (tx) => panoramaDeDistribucion(tx, { periodoId }),
      arbol.usuarios.operadorA1,
    );

    expect(comoAdmin.puedeDistribuir).toBe(true);
    // Si esto fuera `true`, la pantalla le ofrecería al operador un botón que el trigger rechaza.
    expect(comoOperador.puedeDistribuir).toBe(false);
  });

  it("un operador NO puede encolar la distribución, aunque sí el informe y el paquete", async () => {
    // Los dos que sí: emitir documentos es interno y se queda en el storage.
    await expect(
      como(
        (tx) => encolarTrabajoDelPeriodo(tx, { periodoId, tipo: "emitir_informe_periodo" }),
        arbol.usuarios.operadorA1,
      ),
    ).resolves.toMatchObject({ estado: "encolado" });

    await expect(
      como(
        (tx) => encolarTrabajoDelPeriodo(tx, { periodoId, tipo: "armar_paquete_periodo" }),
        arbol.usuarios.operadorA1,
      ),
    ).resolves.toMatchObject({ estado: "encolado" });

    // El que no: mandar PII afuera del sistema no se hereda de poder escribir un PDF adentro.
    await expect(
      como(
        (tx) => encolarTrabajoDelPeriodo(tx, { periodoId, tipo: "distribuir_liquidaciones" }),
        arbol.usuarios.operadorA1,
      ),
    ).rejects.toMatchObject({ codigo: "sin_permiso" });
  });
});
