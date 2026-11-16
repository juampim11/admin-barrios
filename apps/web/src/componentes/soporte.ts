/**
 * Cuándo se muestra el «Código para soporte» de un fallo (encargo 17b, punto 7f).
 *
 * **Solo en un error inesperado** —código `desconocido`: «No se pudo completar la operación»—, que es
 * el único caso en que la persona no puede hacer nada más que avisar, y el código es lo que conecta
 * su pantalla con el error completo en el log del servidor.
 *
 * Un rechazo de negocio (`numero_accion_repetido`, `dato_invalido`, `sin_permiso`,
 * `planilla_con_errores`…) ya dice qué pasó y qué hacer: mostrarle además un código para dictar por
 * teléfono lo hace parecer una falla del sistema cuando es un dato a corregir. El identificador sigue
 * viajando en el error y sigue en el log; lo único que cambia es que no se dibuja.
 *
 * Se afirma en positivo —«solo `desconocido`»— y no enumerando los códigos de negocio: un código
 * nuevo del catálogo queda del lado correcto sin tocar este archivo.
 */

import type { ErrorParaMostrar } from "@admin-barrios/shared/errores";

/**
 * Además de `desconocido`, tres rechazos que tampoco se arreglan corrigiendo un dato: son del sistema
 * o de su configuración, y lo único que la persona puede hacer es avisar (panel `security-engineer`).
 */
const INESPERADOS: readonly string[] = ["desconocido", "subida_no_configurada", "aplicacion_huerfana", "registro_inmutable"];

export function muestraCodigoDeSoporte(error: Pick<ErrorParaMostrar, "codigo" | "correlacion">): boolean {
  return INESPERADOS.includes(error.codigo) && error.correlacion !== "";
}
