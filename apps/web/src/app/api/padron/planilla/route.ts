/**
 * La planilla del padrón (T3, pantalla 4): subirla (vista previa o confirmación) y bajarla (la
 * exportación del padrón o la plantilla vacía).
 *
 * **Por qué un route handler y no una Server Action** (panel `security-engineer`, G4): el archivo
 * puede pesar hasta 5 MB y el tope de las acciones es 1 MB; subir ese tope sería para todas las
 * acciones del sistema. Acá se controla la sesión y el rol **antes** de leer el cuerpo, y el cuerpo
 * se lee contando los bytes (el `Content-Length` lo escribe el cliente).
 *
 *   POST /api/padron/planilla?barrio=<id>&modo=previa|confirmar&nombre=<archivo>&decisiones=12:misma,15:otra
 *        cuerpo: los bytes del archivo (.xlsx o .csv)
 *   GET  /api/padron/planilla?barrio=<id>&tipo=exportar|plantilla
 *   GET  /api/padron/planilla?barrio=<id>&tipo=a_una_fecha&fecha=YYYY-MM-DD
 *
 * «Padrón a una fecha» (`0078`): quiénes eran los titulares vigentes ese día. Mismos controles que
 * `exportar`: la sesión la exige `conSesionHttp` y la administración, el servicio (que además deja
 * la traza de la exportación).
 */

import { NextResponse } from "next/server";
import { idSchema } from "@admin-barrios/shared/consultas";
import { fechaIsoSchema } from "@admin-barrios/shared/fechas";
import { filasDeCsv, filasDePlantilla, type DecisionPersona } from "@admin-barrios/shared/padron";
import { sanearNombreDeArchivo } from "@admin-barrios/shared/planilla";
import {
  confirmarImportacion,
  exportarPadron,
  leerBarrioDelPadron,
  padronAUnaFecha,
  puedeEditarPadron,
  vistaPreviaDeImportacion,
} from "@admin-barrios/data/servicios/padron-edicion";
import { conSesionHttp } from "../../../../servidor/db.ts";
import { ArchivoRechazado, filasDeXlsx, MAX_BYTES_PLANILLA, textoDeCsv, xlsxDeFilas } from "../../../../servidor/planilla/padron-xlsx.ts";
import { traducirFallo } from "../../../../acciones/resultado.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIPO_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SIN_CACHE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

const json = (cuerpo: unknown, status = 200) => NextResponse.json(cuerpo, { status, headers: SIN_CACHE });
const archivoMal = (mensaje: string) => json({ estado: "campos", campos: { archivo: [mensaje] }, valores: {} });

/** El cuerpo, contando los bytes: `null` si pasa del tope. */
async function leerCuerpo(pedido: Request, maximo: number): Promise<Uint8Array | null> {
  const lector = pedido.body?.getReader();
  if (!lector) return new Uint8Array();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximo) {
      await lector.cancel();
      return null;
    }
    partes.push(value);
  }
  const todo = new Uint8Array(total);
  let i = 0;
  for (const p of partes) {
    todo.set(p, i);
    i += p.byteLength;
  }
  return todo;
}

function decisionesDe(texto: string | null): Map<number, DecisionPersona> {
  const decisiones = new Map<number, DecisionPersona>();
  for (const par of (texto ?? "").split(",").slice(0, 5_000)) {
    const m = /^(\d{1,5}):(misma|otra)$/.exec(par.trim());
    if (m) decisiones.set(Number.parseInt(m[1]!, 10), m[2] as DecisionPersona);
  }
  return decisiones;
}

export async function POST(pedido: Request): Promise<NextResponse> {
  const url = new URL(pedido.url);
  // Un POST que escribe: solo desde la propia aplicación (las Server Actions lo chequean solas; un
  // route handler no). Revisión de código, hallazgo 11.
  const origen = pedido.headers.get("origin");
  if (origen !== null && origen !== url.origin) return json({ error: "origen no permitido" }, 403);
  const barrio = idSchema.safeParse(url.searchParams.get("barrio"));
  const modo = url.searchParams.get("modo");
  if (!barrio.success || (modo !== "previa" && modo !== "confirmar")) return json({ error: "pedido inválido" }, 400);
  const barrioId = barrio.data;
  // Solo el nombre base, sin rutas ni caracteres de control: queda en el historial de cada unidad.
  const nombre = sanearNombreDeArchivo((url.searchParams.get("nombre") ?? "planilla").split(/[\\/]/).pop() ?? "planilla").slice(0, 120) || "planilla";

  try {
    // Primero quién es y si puede: el cuerpo no se lee para nadie más.
    const permiso = await conSesionHttp((tx) => puedeEditarPadron(tx, { barrioId }));
    if (!permiso.ok) return json({ error: "sin sesión" }, 401);
    if (!permiso.valor) return json({ error: "sin permiso" }, 403);

    const bytes = await leerCuerpo(pedido, MAX_BYTES_PLANILLA);
    if (bytes === null) return archivoMal("El archivo pasa de 5 MB: partilo en varios.");
    if (bytes.byteLength === 0) return archivoMal("Elegí el archivo de la planilla (Excel o CSV).");

    let filas: string[][];
    try {
      if (/\.csv$/i.test(nombre)) filas = filasDeCsv(textoDeCsv(bytes));
      else if (/\.xlsx$/i.test(nombre)) filas = await filasDeXlsx(Buffer.from(bytes));
      else return archivoMal("El archivo tiene que ser un Excel (.xlsx) o un CSV. Si es un .xls viejo, guardalo como .xlsx.");
    } catch (e) {
      if (e instanceof ArchivoRechazado) return archivoMal(e.message);
      throw e;
    }

    const entrada = { barrioId, archivo: nombre, filas, decisiones: decisionesDe(url.searchParams.get("decisiones")) };
    const resultado =
      modo === "previa"
        ? await conSesionHttp(async (tx) => {
            const v = await vistaPreviaDeImportacion(tx, entrada);
            // Lo que vuelve a la pantalla: lo que se muestra, sin los datos leídos de cada titular
            // (documentos, mails) ni las filas crudas: al confirmar se vuelve a subir el archivo.
            return {
              ...v,
              unidades: v.unidades.map((u) => ({ ...u, unidad: null, titulares: [] })),
              codigosPrevistos: Object.fromEntries(v.codigosPrevistos),
            };
          })
        : await conSesionHttp((tx) => confirmarImportacion(tx, entrada));
    if (!resultado.ok) return json({ error: "sin sesión" }, 401);
    return json({ estado: "ok", valor: resultado.valor });
  } catch (e) {
    return json({ estado: "falla", error: traducirFallo(e), valores: {} });
  }
}

export async function GET(pedido: Request): Promise<NextResponse> {
  const url = new URL(pedido.url);
  const barrio = idSchema.safeParse(url.searchParams.get("barrio"));
  const tipo = url.searchParams.get("tipo");
  if (!barrio.success || (tipo !== "exportar" && tipo !== "plantilla" && tipo !== "a_una_fecha")) {
    return json({ error: "pedido inválido" }, 400);
  }
  // La fecha llega del cliente: se valida antes de abrir la sesión.
  const fecha = tipo === "a_una_fecha" ? fechaIsoSchema.safeParse(url.searchParams.get("fecha")) : null;
  if (fecha && !fecha.success) return json({ error: "fecha inválida" }, 400);
  try {
    const resultado = await conSesionHttp(async (tx) => {
      const b = await leerBarrioDelPadron(tx, { barrioId: barrio.data });
      if (!b) return null;
      const filas =
        tipo === "exportar"
          ? await exportarPadron(tx, { barrioId: b.id })
          : tipo === "a_una_fecha" && fecha?.success
            ? await padronAUnaFecha(tx, { barrioId: b.id, fecha: fecha.data })
            : filasDePlantilla(b.cuentaPorUnidad);
      return { filas, nombre: b.nombre };
    });
    if (!resultado.ok) return json({ error: "sin sesión" }, 401);
    if (!resultado.valor) return json({ error: "no encontrado" }, 404);
    const buf = await xlsxDeFilas(resultado.valor.filas, "Padrón");
    const base =
      tipo === "exportar"
        ? `padron-${resultado.valor.nombre}`
        : fecha?.success
          ? `padron-al-${fecha.data}-${resultado.valor.nombre}`
          : `plantilla-padron-${resultado.valor.nombre}`;
    const archivo = sanearNombreDeArchivo(`${base}.xlsx`);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        ...SIN_CACHE,
        "Content-Type": TIPO_XLSX,
        "Content-Disposition": `attachment; filename="${archivo.replace(/"/g, "")}"`,
      },
    });
  } catch (e) {
    const error = traducirFallo(e);
    return json({ estado: "falla", error }, error.codigo === "sin_permiso" ? 403 : 500);
  }
}
