/**
 * `GET /api/mora/csv` — la lista de mora en CSV, **con las filas del filtro que se está viendo**
 * (encargo E-a, «Bajar CSV» de las pantallas 1 y 2).
 *
 * El alcance va explícito: `?administracion={id}` (todos los barrios) o `?enBarrio={id}` (un barrio).
 * El filtro (`barrio`, `estudio`, `ver`) se lee con la misma función que la pantalla (`leerFiltroMora`)
 * y se aplica con la misma (`filtrarMora`): el archivo tiene exactamente lo que se ve.
 *
 * Lo que cuida, en el orden de `exportaciones/movimientos`:
 *
 *  - **Una lectura bajo la sesión** (`conSesionHttp`): la RLS decide qué barrios entran. Un id ajeno no
 *    da error: da cero barrios y un 404, igual que una pantalla.
 *  - **Serializar fuera de la transacción.** Adentro no se hace nada lento.
 *  - **Fórmulas neutralizadas**: `csvMora` pasa cada celda por `celdaCsv` (portado de Aclade). Un titular
 *    llamado `=HYPERLINK(…)` sale como texto.
 *  - **BOM**: Excel en castellano abre un CSV sin BOM como Windows-1252 y rompe los acentos. Acá sí va
 *    (este archivo se abre afuera; la regla 14b es sobre los fuentes del repo).
 *  - **`no-store` + `Vary: Cookie`**: un CSV de un barrio servido a otro desde un cache sería lo peor que
 *    puede hacer esta ruta. Y el nombre del archivo se arma con texto saneado, sin comillas ni saltos.
 *
 * No registra una traza de exportación como el libro de movimientos: la lista de mora no es un libro
 * contable, y la tabla de trazas (`0051`) es de ese libro. Queda anotado como pendiente si el estudio
 * de seguridad lo pide.
 */

import { NextResponse } from "next/server";
import { idSchema } from "@admin-barrios/shared/consultas";
import { csvMora } from "@admin-barrios/shared/mora";
import { moraDeLaAdministracion } from "@admin-barrios/data/servicios/mora";
import { conSesionHttp } from "../../../../servidor/db.ts";
import { filtrarMora, leerFiltroMora } from "../../../../componentes/mora/filtro.ts";
import { textoDeSituacion, textoDeUltimaGestion } from "../../../../componentes/mora/textos.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIN_CACHE = { "Cache-Control": "no-store", Vary: "Cookie" };

/** Un nombre de archivo sin acentos, espacios ni nada que rompa la cabecera: `los-aromos`. */
function aNombreDeArchivo(texto: string): string {
  const plano = texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return plano.slice(0, 60) || "barrio";
}

export async function GET(pedido: Request): Promise<NextResponse> {
  const url = new URL(pedido.url);
  // Como `searchParams` de una página: un parámetro repetido llega como lista, y `leerFiltroMora` toma
  // el primero. Así el CSV y la pantalla leen la misma URL de la misma forma.
  const crudos: Record<string, string | string[]> = {};
  for (const clave of new Set(url.searchParams.keys())) {
    const valores = url.searchParams.getAll(clave);
    crudos[clave] = valores.length === 1 ? valores[0]! : valores;
  }
  const primero = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const administracion = idSchema.safeParse(primero(crudos["administracion"]));
  const enBarrio = idSchema.safeParse(primero(crudos["enBarrio"]));
  if (!administracion.success && !enBarrio.success) {
    return NextResponse.json({ error: "Falta la administración o el barrio." }, { status: 400, headers: SIN_CACHE });
  }
  const conBarrio = administracion.success;
  const filtro = leerFiltroMora(crudos, { conBarrio });

  const resultado = await conSesionHttp((tx) =>
    moraDeLaAdministracion(tx, administracion.success ? { administracionId: administracion.data } : { barrioId: enBarrio.data! }),
  );
  if (!resultado.ok) return NextResponse.json({ error: "sin sesión" }, { status: 401, headers: SIN_CACHE });
  const mora = resultado.valor;
  if (!mora || mora.barrios.length === 0) {
    return NextResponse.json({ error: "No se encontró la mora pedida." }, { status: 404, headers: SIN_CACHE });
  }

  // Fuera de la transacción, a propósito: acá abajo no se toca la base.
  const filas = filtrarMora(mora.filas, filtro).map((f) => ({
    barrio: f.barrio,
    unidad: f.unidad,
    titular: f.titular ?? "",
    meses: f.meses,
    capital: f.capital,
    interes: f.interes,
    situacion: textoDeSituacion(f),
    estudio: f.derivacion?.estudio ?? null,
    ultimaGestion: textoDeUltimaGestion(f),
  }));
  const cuerpo = `﻿${csvMora(filas)}`;

  const barrioDelNombre = conBarrio ? mora.barrios.find((b) => b.id === filtro.barrio) : mora.barrios[0];
  const quien = barrioDelNombre ? aNombreDeArchivo(barrioDelNombre.nombre) : "todos";
  // La fecha es la de hoy en la hora del barrio, que ya vino de la base (sin `new Date()`).
  const hoy = (barrioDelNombre ?? mora.barrios[0])?.hoy ?? "";
  const nombre = `mora-${quien}-${hoy}.csv`;

  return new NextResponse(cuerpo, {
    status: 200,
    headers: {
      ...SIN_CACHE,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nombre}"`,
    },
  });
}
