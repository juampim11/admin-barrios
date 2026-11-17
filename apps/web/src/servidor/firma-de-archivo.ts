/**
 * Si los primeros bytes de un archivo son los de su extensión (encargo E-a2, security-engineer). El
 * POST firmado fija el content-type contra la extensión de la clave, pero no mira los bytes: un
 * ejecutable renombrado a `.pdf` pasaba. Acá se mira la firma de los tres tipos que se aceptan.
 *
 * Puro: se prueba sin almacenamiento.
 */

const FIRMAS: Readonly<Record<string, readonly number[]>> = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  jpg: [0xff, 0xd8, 0xff],
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
};

/** `true` si el contenido empieza con la firma de la extensión de la clave (pdf, jpg, jpeg o png). */
export function firmaCoincideConLaClave(contenido: Uint8Array, clave: string): boolean {
  const extension = clave.slice(clave.lastIndexOf(".") + 1).toLowerCase();
  const firma = FIRMAS[extension];
  if (!firma || contenido.length < firma.length) return false;
  return firma.every((byte, i) => contenido[i] === byte);
}
