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
 * de paquetes de la imagen; en CI, `ubuntu-latest` ya lo trae). **En local sale de
 * `apps/worker/.env.local`**, que es donde ya vive esa variable — ver la nota sobre la carga de
 * entorno, más abajo.
 */

import pg from "pg";
import { sql } from "drizzle-orm";
import { config as cargarEnv } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exigirEntornoLocal } from "./solo-desarrollo.ts";
import { registroPorDefecto } from "@admin-barrios/documentos/cobranza";
import { solicitudesDeBoletas } from "@admin-barrios/documentos";
import { crearGeneradorChromium } from "@admin-barrios/documentos/chromium";
import { conUsuario, crearDbMantenimiento } from "../src/client.ts";
import { armarVistasDelPeriodo } from "../src/servicios/vista-boleta.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
cargarEnv({ path: resolve(aqui, "../../../.env"), quiet: true });
/*
 * **Y también el entorno del worker, que es donde vive `CHROME_PATH`.**
 *
 * Sin esto el script fallaba con *"no hay Chromium: definí CHROME_PATH"* **teniendo el navegador
 * instalado y la variable ya escrita** en `apps/worker/.env.local` —el `.env.local.example` incluso
 * documenta la ruta de Windows—. El mensaje mandaba a definir algo que ya estaba definido, así que se
 * leía como "falta instalar Chromium", que es un problema distinto y bastante más caro. Pasó de
 * verdad el 2026-08-05: se dio por no instalado un navegador que estaba ahí.
 *
 * Va **después** del `.env` de la raíz y no antes: `dotenv` no pisa lo que ya está definido, así que
 * el archivo del worker aporta lo que falta —`CHROME_PATH`— sin poder robarle la `DATABASE_URL` al
 * entorno de datos. El orden es la garantía; invertirlo cambiaría a qué base apunta la demo.
 *
 * Que el archivo no exista no es un error: en CI y en la imagen del worker la variable viene del
 * entorno, y `dotenv` con un `path` inexistente no hace nada.
 */
cargarEnv({ path: resolve(aqui, "../../../apps/worker/.env.local"), quiet: true });

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
/*
 * Filtro por nombre de barrio, parcial y sin distinguir mayúsculas (`--barrio talas`).
 *
 * **Sin esto, la boleta del barrio de valor fijo era imposible de generar**, y es justamente la que
 * hay que poder mirar: es la que lleva la línea de la cuota mensual en vez del prorrateo. Los dos
 * barrios del seed tienen su período emitido en el MISMO mes y se crean en la MISMA transacción, así
 * que `created_at` empata y el desempate quedaba librado al orden físico de las filas — con
 * `--periodo` salía siempre el mismo barrio y no había forma de pedir el otro.
 */
const barrioPedido = argumento("barrio");

const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const db = crearDbMantenimiento(pool);

  const { periodoId, etiqueta, barrio } = await conUsuario(db, usuarioDemo, async (tx) => {
    /*
     * Los dos filtros son opcionales e independientes, y el orden de preferencia es siempre el
     * mismo: primero un período **emitido** —el borrador no tiene liquidaciones y hace fallar la
     * demo con un mensaje correcto pero desconcertante—, después el mes más nuevo.
     *
     * `${periodoPedido}::text is null` en vez de armar el SQL con `if`: una sola sentencia, un solo
     * plan, y ninguna rama que pueda divergir de la otra al tocarla.
     */
    const fila = (
      await tx.execute<{ id: string; periodo: string; barrio: string }>(sql`
        select p.id, p.periodo, t.nombre as barrio
          from periodo_expensa p join tenant_node t on t.id = p.barrio_id
         where (${periodoPedido ?? null}::text is null or p.periodo = ${periodoPedido ?? null})
           and (${barrioPedido ?? null}::text is null or t.nombre ilike '%' || ${barrioPedido ?? null} || '%')
         order by (p.estado in ('emitida', 'distribuida')) desc, p.periodo desc, p.created_at desc
         limit 1
      `)
    ).rows[0];
    if (!fila) {
      // El mensaje nombra los filtros usados: "no hay período" a secas mandaría a sembrar de nuevo
      // una base que puede estar perfecta y no tener lo que se pidió.
      const filtros = [
        periodoPedido ? `período ${periodoPedido}` : null,
        barrioPedido ? `barrio que contenga "${barrioPedido}"` : null,
      ].filter(Boolean);
      throw new Error(
        filtros.length > 0
          ? `no hay ningún período accesible con ${filtros.join(" y ")}`
          : "no hay ningún período accesible: corré `pnpm db:seed` primero",
      );
    }
    return { periodoId: fila.id, etiqueta: fila.periodo, barrio: fila.barrio };
  });

  const registro = registroPorDefecto();
  const vistas = await conUsuario(db, usuarioDemo, (tx) => armarVistasDelPeriodo(tx, periodoId, { registro }));
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
