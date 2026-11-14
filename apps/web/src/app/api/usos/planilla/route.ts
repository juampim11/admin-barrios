/**
 * La planilla de usos del mes (encargo 16b; pantalla 4 de la maqueta): subirla para ver la **vista
 * previa**, y bajar la planilla modelo.
 *
 *   POST /api/usos/planilla?periodo=<id>&nombre=<archivo>
 *        cuerpo: los bytes del archivo (.xlsx o .csv)
 *        → { estado: "ok", valor: { vista, filas } }
 *   GET  /api/usos/planilla?tipo=plantilla
 *
 * **Por qué un route handler y no una Server Action:** el mismo motivo que la planilla del padrón
 * (`api/padron/planilla`). El archivo puede pesar hasta 5 MB y el tope de las acciones es 1 MB. Acá
 * se controla la sesión y el permiso **antes** de leer el cuerpo, y el cuerpo se lee contando los
 * bytes (el `Content-Length` lo escribe el cliente).
 *
 * **Este handler no escribe nada.** Devuelve la vista previa (`vistaPreviaDePlanillaDeUsos`) y las
 * filas ya leídas, achicadas a las columnas de la planilla (`prepararPlanillaDeUsos`). «Aplicar» es
 * una Server Action (`aplicarPlanillaDeUsosAction`) que manda esas filas: así el pedido de
 * confirmación por importes inusuales pasa por el mismo camino que el resto del sistema. Lo que
 * vuelve del navegador no se da por bueno: el servicio valida de nuevo cada fila contra la base.
 *
 * El archivo es una entrada de terceros (lo arma quien lleva las reservas): se lee con los dos
 * lectores de siempre, con sus defensas, y cada celda se trata como texto.
 */

import { NextResponse } from "next/server";
import { idSchema } from "@admin-barrios/shared/consultas";
import { plantillaDeUsos } from "@admin-barrios/shared/conceptos";
import { filasDeCsv } from "@admin-barrios/shared/padron";
import { sanearNombreDeArchivo } from "@admin-barrios/shared/planilla";
import { conceptosDelMes, vistaPreviaDePlanillaDeUsos } from "@admin-barrios/data/servicios/conceptos-del-mes";
import { conSesionHttp } from "../../../../servidor/db.ts";
import { ArchivoRechazado, filasDeXlsx, MAX_BYTES_PLANILLA, textoDeCsv, xlsxDeFilas } from "../../../../servidor/planilla/padron-xlsx.ts";
import { prepararPlanillaDeUsos } from "../../../../servidor/planilla/usos.ts";
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

export async function POST(pedido: Request): Promise<NextResponse> {
  const url = new URL(pedido.url);
  // Solo desde la propia aplicación (las Server Actions lo chequean solas; un route handler no).
  const origen = pedido.headers.get("origin");
  if (origen !== null && origen !== url.origin) return json({ error: "origen no permitido" }, 403);
  const periodo = idSchema.safeParse(url.searchParams.get("periodo"));
  if (!periodo.success) return json({ error: "pedido inválido" }, 400);
  const periodoId = periodo.data;
  // Solo el nombre base, sin rutas ni caracteres de control: queda guardado con cada uso.
  const nombre = sanearNombreDeArchivo((url.searchParams.get("nombre") ?? "planilla").split(/[\\/]/).pop() ?? "planilla").slice(0, 120) || "planilla";

  try {
    // Primero quién es y si puede cargar en este mes: el cuerpo no se lee para nadie más.
    const permiso = await conSesionHttp(async (tx) => (await conceptosDelMes(tx, { periodoId })).puedeCargar);
    if (!permiso.ok) return json({ error: "sin sesión" }, 401);
    if (!permiso.valor) return json({ error: "sin permiso" }, 403);

    const bytes = await leerCuerpo(pedido, MAX_BYTES_PLANILLA);
    if (bytes === null) return archivoMal("El archivo pasa de 5 MB: partilo en varios.");
    if (bytes.byteLength === 0) return archivoMal("Elegí el archivo de la planilla (Excel o CSV).");

    let crudas: string[][];
    try {
      if (/\.csv$/i.test(nombre)) crudas = filasDeCsv(textoDeCsv(bytes));
      else if (/\.xlsx$/i.test(nombre)) crudas = await filasDeXlsx(Buffer.from(bytes));
      else return archivoMal("El archivo tiene que ser un Excel (.xlsx) o un CSV. Si es un .xls viejo, guardalo como .xlsx.");
    } catch (e) {
      if (e instanceof ArchivoRechazado) return archivoMal(e.message);
      throw e;
    }

    const planilla = prepararPlanillaDeUsos(crudas);
    if (!planilla.ok) return archivoMal(planilla.mensaje);

    const vista = await conSesionHttp((tx) => vistaPreviaDePlanillaDeUsos(tx, { periodoId, archivo: nombre, filas: planilla.filas }));
    if (!vista.ok) return json({ error: "sin sesión" }, 401);
    return json({ estado: "ok", valor: { vista: vista.valor, filas: planilla.filas } });
  } catch (e) {
    return json({ estado: "falla", error: traducirFallo(e), valores: {} });
  }
}

export async function GET(pedido: Request): Promise<NextResponse> {
  const url = new URL(pedido.url);
  if (url.searchParams.get("tipo") !== "plantilla") return json({ error: "pedido inválido" }, 400);
  // La planilla modelo no trae datos de ningún barrio, pero no se sirve sin sesión.
  const sesion = await conSesionHttp(async () => true);
  if (!sesion.ok) return json({ error: "sin sesión" }, 401);
  const buf = await xlsxDeFilas(plantillaDeUsos(), "Usos");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      ...SIN_CACHE,
      "Content-Type": TIPO_XLSX,
      "Content-Disposition": 'attachment; filename="planilla-de-usos-modelo.xlsx"',
    },
  });
}
