/**
 * SCRATCH — script de revisión visual para el recibo, NO forma parte del producto.
 *
 * Registra pagos reales contra unidades del barrio de demo (`pnpm --filter @admin-barrios/data
 * seed:demo`), arma la `VistaRecibo` con esos datos, la renderiza con el mismo motor Chromium que
 * usa el worker, y guarda el PDF + un PNG de la primera página para revisión humana. Corre los DOS
 * casos de `unidad.destinatario` (con y sin obligado) en la misma pasada.
 *
 * **El destinatario sale de `pago.obligado_id`, no de "el obligado vigente de la unidad".** Son dos
 * preguntas distintas: un pago puede registrarse sin obligado aunque la unidad SÍ tenga uno vigente
 * (`obligadoId` es un parámetro propio de `registrarPago`, no una consecuencia de `unidad_obligado`).
 * Un recibo es la constancia de UN pago puntual, así que tiene que reflejar a quién se le atribuyó
 * ESE pago — nunca una inferencia posterior sobre quién vive ahí hoy. (La primera versión de este
 * script tenía justo ese bug: pedía el obligado vigente de la unidad para el rótulo, sin mirar qué
 * `obligadoId` había quedado realmente en el pago.)
 *
 * Se borra (o se convierte en fixture/test) una vez aprobada la plantilla — no se commitea así.
 *
 * Uso: `node apps/worker/scripts/preview-recibo.ts`
 */
import pg from "pg";
import { config as cargarEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { conUsuario, crearDbRequest, crearPoolRequest } from "@admin-barrios/data/client";
import { registrarPago } from "@admin-barrios/data/servicios/pagos";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { cifra, fechaImpresa, acentoImpreso } from "@admin-barrios/shared/documentos";
import type { VistaRecibo } from "@admin-barrios/shared/documentos";
import { solicitudDeRecibo } from "@admin-barrios/documentos";
import { crearGeneradorChromium, rutaChromiumPorDefecto } from "@admin-barrios/documentos/chromium";
import { nuevoToken } from "@admin-barrios/almacenamiento";

const execFileAsync = promisify(execFile);

const aqui = dirname(fileURLToPath(import.meta.url));
cargarEnv({ path: resolve(aqui, "../../../.env"), quiet: true });

const OUT_DIR = process.env["PREVIEW_OUT_DIR"] ?? resolve(aqui, "../../../.preview-recibo");

type UnidadDemo = { readonly id: string; readonly manzana: string; readonly lote: string };
type ObligadoDePago = { readonly nombre: string; readonly rol: string | undefined };

/**
 * El obligado de ESTE pago puntual, resuelto por `obligadoId` — nunca por "el vigente de la
 * unidad". Si `obligadoId` es `null`, no hay nada que resolver: se devuelve `null` sin consultar
 * nada, que es exactamente el caso "pago sin obligado".
 *
 * El rol (`unidad_obligado.tipo`) se busca aparte, atado al PAR (unidad, obligado): un obligado
 * puede tener un rol vigente hoy distinto del que tenía cuando se registró el pago, o puede no
 * tener ninguno vigente ya — en ese caso se imprime el nombre solo, sin inventar un rol.
 */
async function obligadoDelPago(
  admin: pg.Pool,
  unidadId: string,
  obligadoId: string | null,
): Promise<ObligadoDePago | null> {
  if (obligadoId === null) return null;
  const { rows } = await admin.query<{ nombre: string; tipo: string | null }>(
    `select o.nombre, uo.tipo::text as tipo
       from obligado o
       left join unidad_obligado uo
         on uo.obligado_id = o.id and uo.unidad_funcional_id = $2 and uo.hasta is null
      where o.id = $1`,
    [obligadoId, unidadId],
  );
  const fila = rows[0];
  if (!fila) throw new Error(`el obligado ${obligadoId} no existe`);
  return { nombre: fila.nombre, rol: fila.tipo ?? undefined };
}

async function renderCaso(opciones: {
  readonly admin: pg.Pool;
  readonly db: ReturnType<typeof crearDbRequest>;
  readonly operadorId: string;
  readonly barrio: { readonly id: string; readonly nombre: string; readonly domicilio: string | null };
  readonly unidad: UnidadDemo;
  readonly obligadoId: string | null;
  readonly numeroRecibo: string;
  readonly sufijoArchivo: string;
}): Promise<void> {
  const { admin, db, operadorId, barrio, unidad, obligadoId, numeroRecibo, sufijoArchivo } = opciones;

  const monto = "182450.00";
  const fechaPago = "2026-07-28";
  // Storage key con forma válida (`pago_comprobante_storage_key_chk`) — no hay un archivo real
  // detrás, pero el CHECK solo verifica la forma de la clave, no que el objeto exista. Token nuevo
  // en cada corrida (no un literal fijo): `uq_pago_comprobante_adjunto` exige unicidad, y correr
  // este script dos veces con el mismo string chocaría contra esa constraint la segunda vez.
  const comprobanteAdjunto = `barrios/${barrio.id}/pagos/comprobantes/${nuevoToken()}.pdf`;

  const pago = await conUsuario(db, operadorId, (tx) =>
    registrarPago(tx, {
      unidadFuncionalId: unidad.id,
      obligadoId,
      monto,
      fecha: fechaPago,
      origen: "manual",
      comprobanteAdjunto,
    }),
  );
  console.log(`[${sufijoArchivo}] Pago registrado: ${pago.id} — $ ${pago.monto} el ${pago.fecha} — obligadoId=${obligadoId}`);

  // El destinatario se resuelve por el `obligadoId` que efectivamente quedó en ESTE pago.
  const obligado = await obligadoDelPago(admin, unidad.id, obligadoId);

  const vista: VistaRecibo = {
    version: "recibo/1",
    marca: {
      barrio: { nombre: barrio.nombre, logo: null, acentoHex: acentoImpreso(null) },
      emisor: {
        razonSocial: "Estudio Demo — Administración",
        cuit: null,
        domicilio: barrio.domicilio,
        contacto: null,
        logo: null,
      },
      pie: [],
    },
    unidad: {
      etiqueta: etiquetaUnidad(unidad.manzana, unidad.lote),
      destinatario: obligado ? obligado.nombre : null,
      rolDestinatario: obligado?.rol,
    },
    recibo: { numero: numeroRecibo, fecha: fechaImpresa("2026-07-29") },
    pago: { fecha: fechaImpresa(fechaPago), monto: cifra(monto), origen: "manual" },
    leyendas: [
      "Este recibo acredita el pago registrado; no implica conformidad con liquidaciones de otros períodos.",
    ],
    faltantes: [],
  };

  const solicitud = solicitudDeRecibo(vista);
  const generador = crearGeneradorChromium({ rutaEjecutable: rutaChromiumPorDefecto() });
  const pdfBytes = await generador.generar(solicitud, { timeoutMs: 30_000 });

  await mkdir(OUT_DIR, { recursive: true });
  const pdfPath = resolve(OUT_DIR, `recibo-${sufijoArchivo}.pdf`);
  await writeFile(pdfPath, pdfBytes);
  console.log(`[${sufijoArchivo}] PDF real: ${pdfPath} (${pdfBytes.length} bytes, motor=${generador.motor})`);

  // PNG de revisión: el MISMO html que produjo el PDF, a tamaño físico A5 (el `@page` propio del
  // recibo, ver `estilosRecibo()`) y 2x de densidad. Se llama a Chrome por línea de comandos
  // (`--headless --screenshot`), no con `puppeteer-core`: este script corre desde `apps/worker`, que
  // no declara esa dependencia — el motor real ya la trae encapsulada.
  const ESCALA = 2;
  const anchoPx = Math.round((148 / 25.4) * 96 * ESCALA);
  const altoPx = Math.round((210 / 25.4) * 96 * ESCALA);
  const html = [
    "<!doctype html>",
    '<html lang="es-AR"><head><meta charset="utf-8">',
    // Sin `@page{size:A4}` acá: `solicitud.estilos` YA trae su propio `@page{size:148mm 210mm}`
    // (`estilosRecibo()`), y CSS resuelve la cascada por propiedad — declarar A4 antes solo
    // confundiría al lector del archivo sin cambiar el resultado.
    `<style>:root{--m-top:12mm;--m-right:14mm;--m-bottom:10mm;--m-left:14mm}` +
      `html{zoom:${ESCALA}}${solicitud.estilos}</style>`,
    "</head><body>",
    solicitud.cuerpo,
    "</body></html>",
  ].join("");
  const htmlPath = resolve(OUT_DIR, `recibo-${sufijoArchivo}.html`);
  await writeFile(htmlPath, html, "utf-8");

  const pngPath = resolve(OUT_DIR, `recibo-${sufijoArchivo}.png`);
  await execFileAsync(rutaChromiumPorDefecto(), [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--window-size=${anchoPx},${altoPx}`,
    `--screenshot=${pngPath}`,
    pathToFileURL(htmlPath).href,
  ]);
  console.log(`[${sufijoArchivo}] PNG de revisión: ${pngPath}`);
}

async function main() {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("Falta DATABASE_URL (ver .env.example)");

  const admin = new pg.Pool({ connectionString: url });
  const appPool = crearPoolRequest();
  const db = crearDbRequest(appPool);

  try {
    // --- Datos reales del barrio de demo (sembrado por seed-demo.ts) ---------------------------
    const { rows: barrioRows } = await admin.query<{
      id: string;
      nombre: string;
      domicilio: string | null;
    }>(
      `select tn.id, tn.nombre, b.domicilio_sede as domicilio
         from tenant_node tn join barrio b on b.barrio_id = tn.id
        where tn.nombre = 'Barrio Demo Los Aromos'`,
    );
    const barrio = barrioRows[0];
    if (!barrio) throw new Error("no se encontró 'Barrio Demo Los Aromos' — ¿corriste seed:demo?");

    const { rows: unidadRows } = await admin.query<UnidadDemo>(
      `select id, manzana, lote from unidad_funcional
        where barrio_id = $1 order by manzana, lote limit 2 offset 4`,
      [barrio.id],
    );
    const unidadConObligado = unidadRows[0];
    const unidadSinObligado = unidadRows[1];
    if (!unidadConObligado || !unidadSinObligado) throw new Error("el barrio de demo necesita al menos 2 unidades");

    // Un obligado vigente real, para el caso CON destinatario — solo para elegir un id realista,
    // no para construir la vista directamente (eso lo hace `obligadoDelPago`, por `pago.obligado_id`).
    const { rows: obligadoRows } = await admin.query<{ id: string }>(
      `select obligado_id as id from unidad_obligado
        where unidad_funcional_id = $1 and hasta is null limit 1`,
      [unidadConObligado.id],
    );
    const obligadoIdReal = obligadoRows[0]?.id ?? null;
    if (!obligadoIdReal) {
      throw new Error(`la unidad ${unidadConObligado.id} no tiene obligado vigente — probá con otro offset`);
    }

    // El operador demo (Martín Coria) — con permiso de `registrarPago` (`pago_ins`).
    const { rows: operadorRows } = await admin.query<{ id: string }>(
      `select user_id as id from usuario_demo where email = 'operador@estudio.test'`,
    );
    const operadorId = operadorRows[0]?.id;
    if (!operadorId) throw new Error("no se encontró el operador demo — ¿corriste seed:demo?");

    await renderCaso({
      admin,
      db,
      operadorId,
      barrio,
      unidad: unidadConObligado,
      obligadoId: obligadoIdReal,
      numeroRecibo: "000001",
      sufijoArchivo: "con-obligado",
    });

    await renderCaso({
      admin,
      db,
      operadorId,
      barrio,
      unidad: unidadSinObligado,
      obligadoId: null,
      numeroRecibo: "000002",
      sufijoArchivo: "sin-obligado",
    });
  } finally {
    await admin.end();
    await appPool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
