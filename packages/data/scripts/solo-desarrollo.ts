/**
 * Guard compartido de los scripts que **solo** pueden correr en desarrollo (reset, roles, seed, demo).
 *
 * Antes cada script preguntaba `if (process.env.NODE_ENV === "production") throw`. Eso es una **lista
 * de prohibidos**, y falla abierta para todo lo demás: `undefined`, `"Production"`, `"prod"`,
 * `"staging"`. Y `NODE_ENV` además dice cómo se compila, no en qué entorno se está corriendo — hay
 * razones legítimas para levantar un entorno real con `NODE_ENV=development`.
 *
 * Acá se invierte: **lo que no está declarado explícitamente como desarrollo, es producción**
 * (docs/devops/01-entornos.md §2.2). Un script que borra esquemas enteros y siembra datos de demo no
 * puede depender de que alguien se haya acordado de setear una variable.
 */
export function exigirEntornoLocal(queHace: string): void {
  const entorno = process.env["APP_ENTORNO"];
  if (entorno === "local") return;
  throw new Error(
    `${queHace} solo corre en desarrollo. APP_ENTORNO=${entorno ? `"${entorno}"` : "(sin definir)"} ` +
      `y se exige "local". Lo que no está declarado explícitamente como desarrollo se trata como ` +
      `producción (docs/devops/01-entornos.md §2.2). Si es tu máquina, revisá el .env de la raíz.`,
  );
}
