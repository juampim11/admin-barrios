/**
 * La planilla de usos (encargo 16b), entre el lector de planillas y el servicio.
 *
 * **Acá no se lee ningún archivo ni se valida ninguna fila.** El archivo lo leen los dos lectores de
 * siempre (`filasDeXlsx` y `textoDeCsv`, en `padron-xlsx.ts`; regla EX-4) y cada fila la valida
 * `leerPlanillaUsos` (`@admin-barrios/shared/conceptos`) y después el servicio contra la base. Lo que
 * hace este archivo es **achicar** lo leído a lo que el servicio mira, porque esas filas vuelven al
 * navegador con la vista previa y viajan de nuevo al aplicar:
 *
 *  - quedan solo las cinco columnas de la planilla de usos, en su orden; una planilla que trae además
 *    «propietario», «observaciones» o veinte columnas vacías no las pasea ida y vuelta;
 *  - cada celda se corta a un largo que sigue dejando ver el error (un nombre de concepto de más de
 *    120 caracteres sigue siendo «demasiado largo» para `leerPlanillaUsos`);
 *  - las filas vacías del final se sacan. **Las del medio se conservan**: el número de fila que se le
 *    muestra a la persona en cada error es el de su planilla.
 *
 * Es una entrada de terceros: todo se trata como texto y nada se interpreta.
 */

import { COLUMNAS_DE_USOS, MAX_FILAS_USOS, nombreDeConceptoNormalizado } from "@admin-barrios/shared/conceptos";

/** Lo máximo que se conserva de una celda. Más que el tope de cualquier campo de la planilla (120). */
export const MAX_LARGO_DE_CELDA_DE_USOS = 160;

/**
 * Lo máximo que pueden pesar, como texto, las filas que vuelven al navegador. Una planilla llena
 * (2.000 usos con nombres de concepto normales) anda por los 150 mil caracteres; el tope de una
 * Server Action es 1 MB y estas filas viajan en un campo del formulario al aplicar.
 */
export const MAX_CARACTERES_DE_USOS = 600_000;

export type PlanillaDeUsosLeida =
  | { readonly ok: true; readonly filas: string[][] }
  | { readonly ok: false; readonly mensaje: string };

const vacia = (fila: readonly string[]): boolean => fila.every((c) => String(c ?? "").trim() === "");

/**
 * Deja la planilla en las columnas de usos que el encabezado nombra (sin distinguir mayúsculas ni
 * acentos, igual que `leerPlanillaUsos`). Si falta alguna columna, el encabezado queda sin ella y
 * `leerPlanillaUsos` dice cuál falta: acá no se decide que la planilla esté mal por eso.
 */
export function prepararPlanillaDeUsos(filasCrudas: readonly (readonly string[])[]): PlanillaDeUsosLeida {
  let ultima = filasCrudas.length;
  while (ultima > 0 && vacia(filasCrudas[ultima - 1] ?? [])) ultima -= 1;
  const filas = filasCrudas.slice(0, ultima);

  if (filas.length === 0) return { ok: false, mensaje: "La planilla está vacía." };
  if (filas.length > MAX_FILAS_USOS + 1) {
    return { ok: false, mensaje: `La planilla tiene más de ${MAX_FILAS_USOS} filas: partila en varias.` };
  }

  const encabezado = (filas[0] ?? []).map((c) => nombreDeConceptoNormalizado(String(c ?? "")));
  // La primera columna con cada nombre, como la busca `leerPlanillaUsos`.
  const presentes = COLUMNAS_DE_USOS.map((nombre) => ({ nombre, indice: encabezado.indexOf(nombre) })).filter((c) => c.indice >= 0);

  const achicadas = filas.map((fila, i) =>
    i === 0
      ? presentes.map((c) => c.nombre as string)
      : presentes.map((c) => String(fila[c.indice] ?? "").trim().slice(0, MAX_LARGO_DE_CELDA_DE_USOS)),
  );

  const caracteres = achicadas.reduce((total, fila) => total + fila.reduce((t, c) => t + c.length + 3, 2), 0);
  if (caracteres > MAX_CARACTERES_DE_USOS) {
    return { ok: false, mensaje: "La planilla tiene demasiado texto en sus celdas: revisala o partila en varias." };
  }
  return { ok: true, filas: achicadas };
}
