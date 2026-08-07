/**
 * El caminante de grafo y el limpiador de comentarios, probados.
 *
 * Existe por un motivo puntual: `sinComentarios()` alimenta reglas de **seguridad** (las de estilo
 * del ADR-0002 §5.2, que verifican que nadie manipule dinero ni lea el entorno fuera de su lugar).
 * Un helper de test que se come una línea de código convierte esas reglas en un falso verde, y un
 * falso verde en una regla de seguridad es peor que no tener la regla: nadie la vuelve a mirar.
 *
 * La primera implementación —un tokenizador con estado de string— tenía exactamente ese bug con los
 * regex literales. Estos casos lo dejan clavado.
 */

import { describe, expect, it } from "vitest";
import { archivosFuente, importsDe, RAIZ, relativa, resolverWorkspace, sinComentarios } from "./grafo.ts";
import { join, resolve } from "node:path";

/** Dos barras seguidas, armadas por concatenación para no meterlas literales en este archivo. */
const BARRA = "/";

describe("sinComentarios — NUNCA se come código", () => {
  it("no toca un regex literal que termina en dos barras escapadas (el bug que motivó el rediseño)", () => {
    const fuente = `const r = ${BARRA}https:\\${BARRA}\\${BARRA}${BARRA}; const x = Number(1);`;
    expect(sinComentarios(fuente)).toContain("Number(1)");
  });

  it("no toca una URL adentro de un string", () => {
    const fuente = `const u = "https:${BARRA}${BARRA}ejemplo.test"; const z = Number(3);`;
    expect(sinComentarios(fuente)).toContain("Number(3)");
  });

  it("no toca un regex con comillas adentro", () => {
    const fuente = `const r = ${BARRA}["']use server["']${BARRA}; const y = Number(2);`;
    expect(sinComentarios(fuente)).toContain("Number(2)");
  });

  it("no toca un comentario al final de una línea con código: falla ruidoso antes que perder código", () => {
    // Es la contrapartida declarada del diseño. Si molesta, el comentario se mueve a su propia línea.
    const fuente = `const x = 1; ${BARRA}${BARRA} ojo con Number()`;
    expect(sinComentarios(fuente)).toContain("Number()");
  });
});

describe("sinComentarios — vacía los comentarios de documentación", () => {
  it("vacía una línea que arranca con dos barras, con y sin sangría", () => {
    const fuente = [
      `${BARRA}${BARRA} esto menciona Number() en prosa`,
      `    ${BARRA}${BARRA} y esto también, indentado`,
      "const w = 1;",
    ].join("\n");
    const salida = sinComentarios(fuente);
    expect(salida).not.toContain("Number()");
    expect(salida).toContain("const w = 1;");
  });

  it("vacía un bloque `/** … */` de varias líneas y conserva el código de después", () => {
    const fuente = ["/**", " * Prohibido usar Intl.NumberFormat acá.", " */", "const v = 2;"].join("\n");
    const salida = sinComentarios(fuente);
    expect(salida).not.toContain("Intl");
    expect(salida).toContain("const v = 2;");
  });

  it("conserva la cantidad de líneas: los números de línea no se corren", () => {
    const fuente = ["/**", " * doc", " */", "const v = 2;", `${BARRA}${BARRA} nota`].join("\n");
    expect(sinComentarios(fuente).split("\n")).toHaveLength(5);
  });

  it("un bloque de una sola línea deja pasar lo que viene después", () => {
    expect(sinComentarios("/* nota */ const q = Number(9);")).toContain("Number(9)");
  });
});

describe("el caminante", () => {
  it("resuelve los paquetes del workspace por su mapa de `exports`", () => {
    expect(resolverWorkspace("@admin-barrios/data/client")).toBe(resolve(RAIZ, "packages/data/src/client.ts"));
    expect(resolverWorkspace("zod")).toBeNull();
  });

  it("lanza si un import apunta a una subruta que NO está en `exports`", () => {
    // Es lo que hace que esconder una pieza detrás de una subruta sirva: un import que no resuelve
    // falla ruidoso en vez de desaparecer del grafo.
    expect(() => resolverWorkspace("@admin-barrios/data/servicios/inventado")).toThrow(/exports/);
  });

  it("`archivosFuente` devuelve `[]` para una carpeta que no existe (p. ej. `apps/worker`)", () => {
    expect(archivosFuente(join(RAIZ, "apps/carpeta-que-no-existe"))).toEqual([]);
  });

  it("`importsDe` encuentra imports estáticos y dinámicos", () => {
    const delIndex = importsDe(resolve(RAIZ, "packages/auth/src/index.ts"));
    expect(delIndex).toContain("./auth-provider.ts");
    expect(delIndex).toContain("./registro.ts");
  });

  it("`importsDe` ve el `import()` dinámico con backtick y el import por efecto de lado", () => {
    // Las dos formas se le escapaban al patrón original, y con ellas se evadían las reglas 1, 2, 2b
    // y 4 del test de arquitectura — que son exactamente las que protegen el aislamiento.
    const instrumentation = importsDe(resolve(RAIZ, "apps/web/src/instrumentation.ts"));
    expect(instrumentation).toContain("./servidor/db.ts"); // `await import("…")`

    const puerta = importsDe(resolve(RAIZ, "apps/web/src/servidor/db.ts"));
    expect(puerta).toContain("server-only"); // `import "server-only"`, sin `from`
    expect(puerta).toContain("@admin-barrios/data/client");
  });

  it("`relativa` usa siempre `/`, así los mensajes se leen igual en Windows y en Linux", () => {
    expect(relativa(resolve(RAIZ, "packages/auth/src/index.ts"))).toBe("packages/auth/src/index.ts");
  });
});
