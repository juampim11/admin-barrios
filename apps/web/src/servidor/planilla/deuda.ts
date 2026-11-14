/**
 * La planilla de deuda anterior (encargo 17), entre el lector de planillas y el servicio. Calco de
 * `usos.ts` (encargo 16b).
 *
 * **Acá no se lee ningún archivo ni se valida ninguna fila.** El archivo lo leen los dos lectores de
 * siempre (`filasDeXlsx` y `textoDeCsv`, en `padron-xlsx.ts`; regla EX-4) y cada fila la valida
 * `leerPlanillaDeDeuda` (`@admin-barrios/shared/activacion`) y después el servicio contra la base. Lo
 * que hace este archivo es **achicar** lo leído a lo que el servicio mira, porque esas filas vuelven
 * al navegador con la vista previa y viajan de nuevo al confirmar:
 *
 *  - quedan solo las seis columnas de la planilla de deuda, en su orden y con su nombre canónico; una
 *    planilla que trae además «propietario» u «observaciones» no las pasea ida y vuelta;
 *  - cada celda se corta a un largo que sigue dejando ver el error (un nombre de concepto de más de
 *    120 caracteres sigue siendo «demasiado largo» para `leerPlanillaDeDeuda`);
 *  - las filas vacías del final se sacan. **Las del medio se conservan**: el número de fila que se le
 *    muestra a la persona en cada error es el de su planilla.
 *
 * Es una entrada de terceros: todo se trata como texto y nada se interpreta.
 */

import { COLUMNAS_DE_DEUDA, indicesDeColumnaDeDeuda, MAX_FILAS_DEUDA } from "@admin-barrios/shared/activacion";
import { nombreDeConceptoNormalizado } from "@admin-barrios/shared/conceptos";

/** Lo máximo que se conserva de una celda. Más que el tope de cualquier campo de la planilla (120). */
export const MAX_LARGO_DE_CELDA_DE_DEUDA = 160;

/**
 * Lo máximo que pueden pesar, como texto, las filas que vuelven al navegador. Una planilla llena
 * (5.000 deudas con nombres de concepto normales) anda por los 350 mil caracteres; el tope de una
 * Server Action es 1 MB y estas filas viajan en un campo del formulario al confirmar.
 */
export const MAX_CARACTERES_DE_DEUDA = 700_000;

/** Filas vacías en el medio que se toleran, además de las de datos: lo mismo que deja pasar el esquema. */
const MARGEN_DE_FILAS_VACIAS = 99;

export type PlanillaDeDeudaLeida =
  | { readonly ok: true; readonly filas: string[][] }
  | { readonly ok: false; readonly mensaje: string };

const vacia = (fila: readonly string[]): boolean => fila.every((c) => String(c ?? "").trim() === "");

/**
 * Dónde está cada columna, **como la busca `leerPlanillaDeDeuda`**: sin distinguir mayúsculas ni
 * acentos, el importe también como «importe adeudado» o «falta pagar», y el vencimiento como
 * «venció». Si esto y la lectura buscaran distinto, achicar cambiaría lo que la planilla dice.
 */
function indiceDeColumna(encabezado: readonly string[], columna: (typeof COLUMNAS_DE_DEUDA)[number]): number {
  // La misma búsqueda que el validador (`indicesDeColumnaDeDeuda`, lista cerrada de nombres).
  return indicesDeColumnaDeDeuda(encabezado, columna)[0] ?? -1;
}

/**
 * Deja la planilla en las columnas de deuda que el encabezado nombra. Si falta alguna columna, el
 * encabezado queda sin ella y `leerPlanillaDeDeuda` dice cuál falta: acá no se decide que la planilla
 * esté mal por eso.
 */
export function prepararPlanillaDeDeuda(filasCrudas: readonly (readonly string[])[]): PlanillaDeDeudaLeida {
  let ultima = filasCrudas.length;
  while (ultima > 0 && vacia(filasCrudas[ultima - 1] ?? [])) ultima -= 1;
  const filas = filasCrudas.slice(0, ultima);

  if (filas.length === 0) return { ok: false, mensaje: "La planilla está vacía." };
  const conDatos = filas.slice(1).filter((f) => !vacia(f)).length;
  if (conDatos > MAX_FILAS_DEUDA || filas.length > MAX_FILAS_DEUDA + 1 + MARGEN_DE_FILAS_VACIAS) {
    return { ok: false, mensaje: `La planilla tiene más de ${MAX_FILAS_DEUDA} filas: sacá las filas vacías o los meses que ya no se deben.` };
  }

  const encabezado = (filas[0] ?? []).map((c) => nombreDeConceptoNormalizado(String(c ?? "")));
  // Dos columnas que se leen como el importe: no se elige una al achicar (el validador diría que está
  // bien). Se rechaza acá, con las mismas palabras.
  if (indicesDeColumnaDeDeuda(encabezado, "importe").length > 1) {
    return { ok: false, mensaje: "La planilla tiene más de una columna de importe: dejá una sola, con lo que falta pagar." };
  }
  const presentes = COLUMNAS_DE_DEUDA.map((nombre) => ({ nombre, indice: indiceDeColumna(encabezado, nombre) })).filter((c) => c.indice >= 0);

  const achicadas = filas.map((fila, i) =>
    i === 0
      ? presentes.map((c) => c.nombre as string)
      : presentes.map((c) => String(fila[c.indice] ?? "").trim().slice(0, MAX_LARGO_DE_CELDA_DE_DEUDA)),
  );

  const caracteres = achicadas.reduce((total, fila) => total + fila.reduce((t, c) => t + c.length + 3, 2), 0);
  if (caracteres > MAX_CARACTERES_DE_DEUDA) {
    return { ok: false, mensaje: "La planilla tiene demasiado texto en sus celdas: revisala antes de subirla." };
  }
  return { ok: true, filas: achicadas };
}
