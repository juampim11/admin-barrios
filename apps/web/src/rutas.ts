import { idSchema } from "@admin-barrios/shared/consultas";

/**
 * ¿El segmento de la URL tiene forma de identificador?
 *
 * **Por qué hace falta, y no es paranoia.** `/{barrio}` es un segmento dinámico de primer nivel: le
 * cae **todo** lo que no matchee otra ruta, empezando por el `/favicon.ico` que pide cualquier
 * navegador. Sin este chequeo ese pedido llega hasta `leerBarrio()`, el `parse()` de Zod lanza y el
 * resultado es un **500** — verificado en el log del servidor la primera vez que se levantó esta
 * pantalla. Con el chequeo es un 404, que es lo que corresponde.
 *
 * **Esto no autoriza nada.** Solo dice "esto ni siquiera tiene forma de id". Quién puede ver ese
 * barrio lo decide la RLS y nada más (ADR-0002 §3.4): un uuid con forma válida pero de otro tenant
 * pasa por acá y muere igual en la policy, devolviendo cero filas y el mismo 404.
 *
 * Usa el `idSchema` de `@admin-barrios/shared/consultas` —el mismo que aplican los servicios— y no
 * una expresión regular propia: dos definiciones de "qué es un id" es una que se va a desincronizar.
 */
export function esIdValido(segmento: string): boolean {
  return idSchema.safeParse(segmento).success;
}
