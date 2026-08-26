import "server-only";

/**
 * El serializador XLSX. **Es el único archivo del repo que importa `exceljs`**, y hay una regla del
 * gate que lo verifica: si el vocabulario de celdas y `numFmt` se filtra al dominio, la próxima
 * exportación se escribe pegada a la librería.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LA ASIMETRÍA QUE HAY QUE DEJAR ESCRITA: DINERO = NÚMERO, FECHA E IDENTIFICADOR = TEXTO
 *
 * Es deliberada, y si no está explicada alguien la "arregla" para que sea uniforme:
 *
 *  · **El dinero va como celda numérica con `numFmt`.** El valor y su presentación viajan separados:
 *    el número va crudo y el formato va en la columna, así que el separador decimal lo pone el Excel
 *    de quien abre, con SU locale. Escribir el importe ya formateado como texto se ve bien y **no
 *    suma**, que es lo único que esta planilla existe para permitir.
 *
 *  · **Las fechas van como TEXTO en ISO-8601**, tal cual las devuelve Postgres, sin pasar por
 *    `formatearFecha` (que es `dd/mm/aaaa`, de pantalla) y **sin pasar por `Date`**. Una celda de
 *    fecha de verdad le pediría a `exceljs` un `Date` de JS, y ahí un `2026-08-01` se convierte en
 *    `2026-07-31` según el huso — el modo de falla exacto que la regla 7 del gate persigue. ISO-8601
 *    además ordena bien como texto, y el contador lo convierte a fecha si quiere.
 *
 *  · **Los identificadores (CUIT, CBU, comprobante) van como TEXTO aunque sean todo dígitos.** Excel
 *    guarda 15 dígitos significativos: un CBU de 22 **pierde dígitos** y se muestra `1,23457E+21`.
 *    Eso es un número de cuenta bancaria alterado adentro de un archivo contable
 *    (`security-engineer`, panel 2026-08-26).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * NINGÚN SUBTOTAL ES UNA FÓRMULA
 *
 * Todos los totales llegan calculados desde `dataset.ts` y se escriben como valores. Una fórmula en
 * el archivo es un número que puede recalcularse distinto en la máquina del contador y dejar de
 * coincidir con lo que dice el sistema — la falla exacta que CLAUDE.md §1.4 existe para evitar.
 * Tampoco se escribe **nunca** `{ formula: … }` en una celda: sería reintroducir a mano la inyección
 * que `sanearTextoDePlanilla` neutraliza.
 */

import ExcelJS from "exceljs";
import type { Celda, Hoja, LibroParaPlanilla, TipoDeColumna } from "./dataset.ts";

/** Formato de los importes. Los separadores los resuelve el locale de quien abre el archivo. */
const FORMATO_MONTO = "#,##0.00";

/** Excel corta los nombres de solapa en 31 caracteres, y rechaza el libro si dos quedan iguales. */
const LARGO_MAXIMO_SOLAPA = 31;

export async function serializarLibro(libro: LibroParaPlanilla): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  // Metadatos institucionales, fijados a propósito. Si no se fijan, la librería los deja vacíos y
  // el día que alguien "mejore" el archivo poniendo el mail del usuario acá, ese dato personal viaja
  // adentro de un archivo que se manda por mail o por WhatsApp.
  //
  // **Sin `wb.created`**: pediría un `Date` de JS armado en el proceso web, y la fecha de este
  // archivo ya está adentro del libro —el sello de extracción, que sale de la base y es el mismo que
  // quedó en la traza—. Dos relojes para el mismo hecho es uno de más.
  wb.creator = "admin-barrios";
  wb.lastModifiedBy = "admin-barrios";

  for (const hoja of libro.hojas) escribirHoja(wb, hoja);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function escribirHoja(wb: ExcelJS.Workbook, hoja: Hoja): void {
  const ws = wb.addWorksheet(hoja.nombre.slice(0, LARGO_MAXIMO_SOLAPA));

  for (const renglon of hoja.bloquePrevio) {
    // `addRow([texto])` y no `addRow(texto)`: un string suelto lo reparte carácter por carácter.
    const fila = ws.addRow([renglon]);
    fila.font = { bold: renglon.startsWith("PROVISORIO") || renglon.startsWith("Libro de movimientos") };
  }
  if (hoja.bloquePrevio.length > 0) ws.addRow([]);

  const filaEncabezado = ws.addRow(hoja.columnas.map((c) => c.header));
  filaEncabezado.font = { bold: true };
  // El panel se congela **debajo del encabezado de la tabla**, no en la fila 1: arriba hay un bloque
  // de contexto de alto variable, así que el número sale de la posición real de esa fila.
  ws.views = [{ state: "frozen", ySplit: filaEncabezado.number }];

  for (const fila of hoja.filas) {
    ws.addRow(hoja.columnas.map((columna, i) => valorDeCelda(fila[i], columna.tipo)));
  }

  hoja.columnas.forEach((columna, i) => {
    const col = ws.getColumn(i + 1);
    if (columna.tipo === "monto") col.numFmt = FORMATO_MONTO;
    // `@` es el formato "texto" de Excel: sin esto, una columna de identificadores que resultan ser
    // todo dígitos puede volver a interpretarse como número al editar el archivo.
    if (columna.tipo === "identificador") col.numFmt = "@";
    col.width = Math.min(Math.max(columna.header.length + 4, 12), 46);
  });

  if (hoja.bloquePosterior.length > 0) {
    ws.addRow([]);
    for (const renglon of hoja.bloquePosterior) {
      const fila = ws.addRow([renglon]);
      fila.font = { bold: true };
    }
  }
}

/**
 * El valor que va a la celda, según el tipo de la columna.
 *
 * Devuelve `""` y no `null` para lo ausente: una celda vacía tiene que verse vacía, y nunca decir
 * "null" adentro de una planilla contable.
 */
function valorDeCelda(celda: Celda | undefined, tipo: TipoDeColumna): string | number {
  if (celda === null || celda === undefined) return "";

  switch (tipo) {
    case "monto":
    case "entero":
      // Ya viene como `number` desde el dataset (`montoANumeroDePlanilla`). Si llegara un string,
      // se escribe como texto en vez de castearlo acá: este archivo no convierte dinero.
      return typeof celda === "number" ? celda : String(celda);
    case "bool":
      return celda === true ? "Sí" : celda === false ? "No" : String(celda);
    // `fecha` e `identificador` caen a propósito en el mismo camino que `texto`: los dos son
    // cadenas y los dos se romperían si Excel intentara interpretarlos. Ver el encabezado.
    case "fecha":
    case "identificador":
    case "texto":
    default:
      return String(celda);
  }
}
