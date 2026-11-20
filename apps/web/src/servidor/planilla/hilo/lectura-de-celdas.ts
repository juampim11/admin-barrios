/**
 * Cómo se vuelve texto una celda de una planilla, y cómo se limpia ese texto. Código **puro y sin
 * dependencias de ejecución**: lo usan el lector del padrón (`padron-xlsx.ts`, para el CSV) y el hilo que
 * lee el Excel (`lector-xlsx.ts`, en esta carpeta), que corre en un `worker_thread` y por eso no puede importar nada del
 * servidor web (ni `server-only`, ni los paquetes del monorepo).
 *
 * Tampoco nombra `exceljs` (ni como tipo): el valor de la celda entra como `unknown` y se acota acá, así los
 * únicos archivos de la web que nombran la librería siguen siendo los de EX-3.
 */
export const MAX_CELDA = 300;

/** Caracteres de control y de dirección de texto: no aportan nada a un dato y pueden disfrazarlo. */
export const INVISIBLES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

/** Una celda de exceljs → texto, sin evaluar nada. */
export function textoDeCelda(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "string") return valor;
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) return "";
    // Un número de más de 15 cifras perdió precisión en el double (un CBU guardado como número):
    // se devuelve algo que la validación rechaza con el motivo, en vez de un dato corrido.
    if (Math.abs(valor) >= 1e15) return "(número demasiado largo: guardá esa columna como texto)";
    return String(valor);
  }
  if (typeof valor === "boolean") return valor ? "sí" : "";
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? "" : valor.toISOString().slice(0, 10);
  if (typeof valor === "object") {
    if ("richText" in valor && Array.isArray(valor.richText)) return (valor.richText as { text: string }[]).map((r) => r.text).join("");
    if ("formula" in valor || "sharedFormula" in valor) {
      const resultado = (valor as { result?: unknown }).result;
      return resultado === undefined || (typeof resultado === "object" && resultado !== null && "error" in resultado) ? "" : textoDeCelda(resultado);
    }
    if ("text" in valor && typeof valor.text === "string") return valor.text;
  }
  return "";
}

export const limpiar = (t: string) => t.normalize("NFC").replace(INVISIBLES, "").trim().slice(0, MAX_CELDA);
