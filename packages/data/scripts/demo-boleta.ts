/**
 * `pnpm demo:boleta` — genera los PDFs de las boletas de un período a una carpeta local.
 *
 * Recorre el camino real de punta a punta: lee la liquidación bajo RLS, arma la `VistaBoleta`,
 * la pasa por la plantilla y la renderiza con el adapter de Chromium en **una sola pasada**. Si
 * algo se rompe, se rompe acá y no en una demostración.
 *
 * Uso (después de `pnpm db:up && pnpm db:migrate && pnpm db:setup && pnpm db:seed`):
 *
 *   pnpm demo:boleta                      → el último período EMITIDO del barrio demo, a ./tmp/boletas
 *   pnpm demo:boleta -- --periodo 2026-07 --salida ./tmp/boletas --limite 3
 *
 * Necesita un Chromium: `CHROME_PATH` en el entorno (en la imagen del worker lo instala el gestor
 * de paquetes de la imagen; en CI, `ubuntu-latest` ya lo trae).
 */

import pg from "pg";
import { sql } from "drizzle-orm";
import { config as cargarEnv } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exigirEntornoLocal } from "./solo-desarrollo.ts";
import { crearMedioGenericoDemo } from "@admin-barrios/documentos/cobranza";
import { solicitudesDeBoletas } from "@admin-barrios/documentos";
import { crearGeneradorChromium } from "@admin-barrios/documentos/chromium";
import { conUsuario, crearDbMantenimiento } from "../src/client.ts";
import { armarVistasDelPeriodo } from "../src/servicios/vista-boleta.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
cargarEnv({ path: resolve(aqui, "../../../.env"), quiet: true });

function argumento(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("Falta DATABASE_URL (ver .env.example)");
exigirEntornoLocal("la demo de boletas");

const periodoPedido = argumento("periodo");
// Por defecto, `tmp/boletas` **en la raíz del repo**: `pnpm --filter` corre con el cwd del paquete,
// así que resolver contra `process.cwd()` dejaría los PDFs escondidos dentro de `packages/data`.
const raizRepo = resolve(aqui, "../../..");
const salidaPedida = argumento("salida");
const salida = salidaPedida ? resolve(process.cwd(), salidaPedida) : resolve(raizRepo, "tmp/boletas");
const limite = Number(argumento("limite") ?? "0");
// El usuario demo del seed. En producción la identidad sale de la capa de Auth, nunca de un literal.
const usuarioDemo = argumento("usuario") ?? "00000000-0000-4000-8000-000000000001";

const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const db = crearDbMantenimiento(pool);

  const { periodoId, etiqueta, barrio } = await conUsuario(db, usuarioDemo, async (tx) => {
    const fila = (
      await tx.execute<{ id: string; periodo: string; barrio: string }>(
        periodoPedido
          ? sql`select p.id, p.periodo, t.nombre as barrio
                  from periodo_expensa p join tenant_node t on t.id = p.barrio_id
                 where p.periodo = ${periodoPedido} order by p.created_at desc limit 1`
          : // Se prefiere un período **emitido**, y no simplemente el último creado.
            //
            // Desde que el seed deja también un período en borrador (para que se puedan probar las
            // pantallas de carga), "el último" era el borrador — que no tiene liquidaciones y hace
            // fallar la demo con un mensaje correcto pero desconcertante. El desempate por `periodo`
            // hace falta porque el seed crea los dos en la misma transacción y `created_at` empata.
            sql`select p.id, p.periodo, t.nombre as barrio
                  from periodo_expensa p join tenant_node t on t.id = p.barrio_id
                 order by (p.estado in ('emitida', 'distribuida')) desc, p.periodo desc,
                          p.created_at desc
                 limit 1`,
      )
    ).rows[0];
    if (!fila) throw new Error("no hay ningún período accesible: corré `pnpm db:seed` primero");
    return { periodoId: fila.id, etiqueta: fila.periodo, barrio: fila.barrio };
  });

  const medio = crearMedioGenericoDemo();
  const vistas = await conUsuario(db, usuarioDemo, (tx) => armarVistasDelPeriodo(tx, periodoId, { medio }));
  const elegidas = limite > 0 ? vistas.slice(0, limite) : vistas;
  if (elegidas.length === 0) throw new Error("el período no tiene liquidaciones: corré `pnpm db:seed` primero");

  const arranque = Date.now();
  const generador = crearGeneradorChromium();
  const pdfs = await generador.generarLote(solicitudesDeBoletas(elegidas), { timeoutMs: 120_000, chunk: 50 });
  const ms = Date.now() - arranque;

  await mkdir(salida, { recursive: true });
  let bytes = 0;
  for (const [i, pdf] of pdfs.entries()) {
    const vista = elegidas[i];
    if (!vista) continue;
    // Nombre lindo, **sin nombres de personas**: el archivo se reenvía (doc 09 §E.7.3).
    const nombre = `Expensas-${vista.barrio.nombre}-${vista.periodo.codigo}-${vista.unidad.etiqueta}${
      vista.bloquePago.sinValorDePago ? "-MUESTRA" : ""
    }.pdf`
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9.-]+/g, "-");
    await writeFile(resolve(salida, nombre), pdf);
    bytes += pdf.byteLength;
  }

  console.log(`Boletas generadas:
  Barrio     : ${barrio}
  Período    : ${etiqueta}
  Documentos : ${pdfs.length} (${(bytes / pdfs.length / 1024).toFixed(0)} KB promedio)
  Motor      : ${generador.motor}
  Tiempo     : ${ms} ms (${(ms / pdfs.length).toFixed(0)} ms por boleta, una sola pasada)
  Carpeta    : ${salida}

  Las boletas salen con la marca de agua "MUESTRA — SIN VALOR DE PAGO": el medio de cobranza
  resuelto es el de demostración y su instrumento no puede recibir un pago.`);
} finally {
  await pool.end();
}
