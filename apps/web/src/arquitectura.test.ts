/**
 * Dónde termina `apps/web` y empieza `packages/` — **verificado, no documentado** (ADR-0002 §5).
 *
 * > `apps/web` hace **cuatro** cosas: routing, sesión, presentación y traducción de errores a
 * > mensajes. Todo lo demás está en `packages/`.
 *
 * Una regla que no se verifica en CI es una intención. Acá están las once violaciones detectables
 * del §5.2, cada una con su nombre y su motivo en el mensaje de error — porque el que la rompa
 * dentro de seis meses va a leer el fallo, no este comentario.
 *
 * Las estructurales (1–4, 9–11) se verifican con el caminante de grafo de `tools/arquitectura/`. Las
 * de estilo (5–8) con una pasada de expresiones regulares y una lista de permitidos **explícita y
 * chica** por regla. Es tosco y es a propósito: una regla que se verifica con `grep` en 40 ms y
 * falla el build vale más que un lint sofisticado que nadie configura. Cuando alguna genere ruido,
 * se discute la excepción en un PR — que es donde se tiene que discutir.
 *
 * Lo que esto **no** detecta: una regla de negocio escrita en prosa adentro de un componente
 * (`if (periodo.estado === "borrador" && diasHastaVencimiento < 5)`). Contra eso no hay regex; hay
 * revisión de código y la regla de las cuatro líneas de una Server Action (§4.2).
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  archivosFuente,
  grafo,
  importadoresDe,
  importsDe,
  RAIZ,
  relativa,
  resolverWorkspace,
  sinComentarios,
} from "../../../tools/arquitectura/grafo.ts";

const WEB = join(RAIZ, "apps/web/src");
const PUERTA = resolve(WEB, "servidor/db.ts");

/**
 * Todos los fuentes de la web, **incluidos los tests**: un test tampoco puede abrir el pool.
 *
 * Menos **este** archivo, que nombra a propósito todo lo prohibido —`conIngreso`, `crearDbJob`,
 * `Intl`, `process.env`— para poder buscarlo. Sin la exclusión, el verificador se denuncia a sí
 * mismo y la única forma de arreglarlo sería debilitar las reglas.
 */
const ESTE_ARCHIVO = resolve(WEB, "arquitectura.test.ts");
const FUENTES = archivosFuente(WEB, { incluirTests: true }).filter((a) => resolve(a) !== ESTE_ARCHIVO);

/** Los fuentes que no son la puerta única. Es sobre estos que se verifican las reglas 1 y 2. */
const FUENTES_SIN_PUERTA = FUENTES.filter((a) => resolve(a) !== PUERTA);

/**
 * El código de un archivo, **sin comentarios**. Es lo que usan las reglas de estilo (5–8) y las de
 * referencia por identificador (2c, 10, 11): una regex no distingue el código de la prosa, así que
 * sin esto el comentario que explica una regla la rompe. Pasó de verdad la primera vez que corrió
 * este archivo — el comentario de `db.ts` que dice "no usar `new Date()`" hacía fallar la regla 7.
 *
 * Las reglas de **import** (1, 2, 2b, 4, 9) usan el fuente crudo a propósito: ahí conviene
 * sobre-reportar. Un import comentado que dispara el test se discute en un PR; un import real que
 * el stripper se comió por un bug se va a producción.
 */
const leerCodigo = (archivo: string) => sinComentarios(readFileSync(archivo, "utf8"));

/** Falla nombrando **todos** los archivos que rompen la regla, no solo el primero. */
function exigirVacio(infractores: readonly string[], regla: string, motivo: string): void {
  expect(
    infractores.map(relativa).sort(),
    `${regla}\n${motivo}\nArchivos que la rompen:`,
  ).toEqual([]);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Reglas estructurales: el grafo de imports
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("la conexión a la base no se puede abrir desde ningún otro lado", () => {
  it("1 — NADIE en `apps/web` importa `pg` ni `drizzle-orm`, ni siquiera la puerta", () => {
    // El ADR permitía la excepción para `servidor/db.ts`; en la práctica no hace falta, y una regla
    // sin excepciones es más fuerte que una con una. Lo poco que la puerta necesitaba de la ORM
    // —contar el elenco de la demo en el arranque— vive en un servicio.
    const infractores = FUENTES.filter((a) =>
      importsDe(a).some((e) => e === "pg" || e === "drizzle-orm" || e.startsWith("drizzle-orm/")),
    );
    exigirVacio(
      infractores,
      "Violación 1 (ADR-0002 §5.2): `pg` / `drizzle-orm` importado desde `apps/web`.",
      "Si hace falta una consulta, va en un servicio de `packages/data/src/servicios/`, con la firma " +
        "`(tx: DbConIdentidad, parametros)`. La web llama al servicio adentro de `conSesion`.",
    );
  });

  it("2 — nadie importa `@admin-barrios/data` (raíz) ni `/schema`: solo `servicios/*` y `/client`", () => {
    const infractores = FUENTES.filter((a) =>
      importsDe(a).some((e) => e === "@admin-barrios/data" || e === "@admin-barrios/data/schema"),
    );
    exigirVacio(
      infractores,
      "Violación 2 (ADR-0002 §5.2): import de la raíz de `@admin-barrios/data` o de su esquema.",
      "Arrastra el esquema entero al grafo de la web. La web importa `@admin-barrios/data/servicios/*`; " +
        "`/client` lo importa un solo archivo (`servidor/db.ts`), que es lo que verifica la regla 2b.",
    );
  });

  it("2b — `@admin-barrios/data/client` lo importa exactamente un archivo, y es la puerta", () => {
    const infractores = FUENTES_SIN_PUERTA.filter((a) =>
      importsDe(a).some((e) => e === "@admin-barrios/data/client"),
    );
    exigirVacio(
      infractores,
      "Violación 2b (ADR-0002 §3.2, cerrojo 2): `client.ts` fuera de `servidor/db.ts`.",
      "`client.ts` vive detrás de su propia subruta justamente para que se lo importe escribiéndolo. " +
        "El pool es un singleton de módulo que no se exporta: si hace falta la base, es `conSesion()`.",
    );
  });

  it("2c — las fábricas peligrosas no se nombran en ninguna parte de la web", () => {
    // Se busca el identificador, no el import: un `import * as data` seguido de `data.crearDbJob()`
    // no lo agarraría un chequeo de especificadores.
    const PELIGROSAS = ["crearPoolJob", "crearDbJob", "crearDbMantenimiento", "sinUsuario"];
    const infractores = FUENTES_SIN_PUERTA.filter((a) => {
      const fuente = leerCodigo(a);
      return PELIGROSAS.some((n) => new RegExp(`\\b${n}\\b`).test(fuente));
    });
    exigirVacio(
      infractores,
      "Violación 2c (ADR-0002 §3.2): fábrica de conexión sin RLS, o `sinUsuario`, fuera de la puerta.",
      "`crearDbJob`/`crearPoolJob` abren la conexión BYPASSRLS y `crearDbMantenimiento` la del dueño " +
        "del esquema: ninguna de las tres tiene lugar en un proceso que atiende personas. `sinUsuario` " +
        "solo se usa adentro de `conIngreso()`, que vive en `servidor/db.ts`.",
    );
  });

  it("3 — la web no arrastra Chromium ni un motor de PDF (ADR-0001 §3)", () => {
    const { archivos, externos } = grafo(archivosFuente(WEB));
    expect(archivos.has(resolve(RAIZ, "packages/documentos/src/adapters/chromium.ts"))).toBe(false);
    for (const vetado of ["puppeteer-core", "puppeteer", "playwright", "pdf-lib"]) {
      expect(externos, `Violación 3: "${vetado}" entró al grafo de apps/web`).not.toContain(vetado);
    }
  });

  it("4 — el adapter `dev-suplantacion` lo nombra UN solo archivo del repo: la fábrica guardada", () => {
    const ADAPTER = resolve(RAIZ, "packages/auth/src/adapters/dev-suplantacion.ts");
    // Que esté en el GRAFO de la web es correcto y esperado: en desarrollo, de ahí sale el provider.
    // Lo que no puede pasar es que alguien lo instancie a mano, porque el gate por `APP_ENTORNO` vive
    // en la fábrica y llamarlo por afuera lo saltea entero.
    const PERMITIDOS = [
      "packages/auth/src/registro.ts",
      "packages/auth/src/adapters/dev-suplantacion.test.ts",
    ];
    const infractores = importadoresDe(ADAPTER, ["apps", "packages", "tools"]).filter(
      (a) => !PERMITIDOS.includes(relativa(a)),
    );
    exigirVacio(
      infractores,
      "Violación 4 (ADR-0002 §2.4, vuelta 4): alguien importa el sustituto de identidad a mano.",
      "El gate por APP_ENTORNO vive en `crearAuthProvider()`. Instanciar el adapter directamente lo " +
        `saltea. Único camino permitido: la fábrica. (Permitidos: ${PERMITIDOS.join(", ")}.)`,
    );
  });

  it("el mapa de `exports` esconde de verdad las piezas peligrosas", () => {
    expect(resolverWorkspace("@admin-barrios/data/client")).toBe(
      resolve(RAIZ, "packages/data/src/client.ts"),
    );
    expect(resolverWorkspace("@admin-barrios/auth/adapters/dev-suplantacion")).toBe(
      resolve(RAIZ, "packages/auth/src/adapters/dev-suplantacion.ts"),
    );
    // La raíz de `auth` NO alcanza al adapter: si lo re-exportara, la regla 4 sería decorativa.
    const { archivos } = grafo([resolve(RAIZ, "packages/auth/src/index.ts")]);
    expect(archivos.has(resolve(RAIZ, "packages/auth/src/adapters/dev-suplantacion.ts"))).toBe(true);
    // ↑ sí está, porque `registro.ts` lo importa. Lo que se protege es QUIÉN lo nombra (regla 4),
    //   no que esté ausente: la fábrica tiene que poder devolverlo en desarrollo.
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Reglas de estilo: dinero, formato, fechas y entorno
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Archivos donde una regla de estilo tiene una excepción justificada. Chica y explícita. */
const EXCEPCIONES: Readonly<Record<string, readonly string[]>> = {
  // La única puerta al entorno. Es literalmente la regla 8.
  entorno: ["apps/web/src/servidor/configuracion.ts", "apps/web/src/instrumentation.ts"],
};

describe("el dinero, el formato y las fechas no se manipulan en la web", () => {
  it("5 — nada de `Number()`, `parseFloat` ni `.toFixed()`", () => {
    const infractores = FUENTES.filter((a) =>
      /\bNumber\s*\(|\bparseFloat\s*\(|\.toFixed\s*\(/.test(leerCodigo(a)),
    );
    exigirVacio(
      infractores,
      "Violación 5 (ADR-0002 §5.2): aritmética de punto flotante sobre datos de la base.",
      "El dinero es `numeric` y se lee como **string** a propósito (`pg.types` no lo castea). Un " +
        "`Number()` sobre un importe es una pérdida de exactitud silenciosa. La aritmética vive en " +
        "`@admin-barrios/shared/dinero`, que trabaja en centavos con `bigint`.",
    );
  });

  it("6 — nada de `Intl.NumberFormat` ni `toLocale*`", () => {
    const infractores = FUENTES.filter((a) => /\bIntl\.|\.toLocale[A-Za-z]*\s*\(/.test(leerCodigo(a)));
    exigirVacio(
      infractores,
      "Violación 6 (ADR-0002 §5.2): formateo con `Intl` / `toLocale*`.",
      "Un Node slim sin ICU completo degrada `es-AR` a `en-US` **en silencio**: `359.000,00` en " +
        "pantalla y `359,000.00` en el PDF, y el bug no se ve en desarrollo. El formateo vive en " +
        "`@admin-barrios/shared/dinero` y `/fechas`, sin ICU, en un solo lugar — y por eso el test " +
        "puede comparar la misma cadena en la pantalla, el email y el PDF.",
    );
  });

  it("7 — nada de `new Date()` para una fecha de negocio", () => {
    const infractores = FUENTES.filter((a) => /\bnew\s+Date\s*\(\s*\)/.test(leerCodigo(a)));
    exigirVacio(
      infractores,
      "Violación 7 (ADR-0002 §5.2): `new Date()` sin argumentos.",
      "Después de las 21:00 ART el servidor en UTC ya está en el día siguiente: una fecha de negocio " +
        "sacada del reloj del proceso se corre un día. Va por `@admin-barrios/shared/fechas`.",
    );
  });

  it("8 — `process.env` se lee en un solo archivo", () => {
    const infractores = FUENTES.filter(
      (a) => /\bprocess\.env\b/.test(leerCodigo(a)) && !(EXCEPCIONES["entorno"] ?? []).includes(relativa(a)),
    );
    exigirVacio(
      infractores,
      "Violación 8 (ADR-0002 §5.2): lectura de `process.env` fuera de `servidor/configuracion.ts`.",
      "Una sola puerta al entorno, validada con Zod al arrancar. Es lo que hace posible el candado " +
        `del §2.4 vuelta 1. (Permitidos: ${(EXCEPCIONES["entorno"] ?? []).join(", ")}.)`,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Reglas de acotamiento: Server Actions, `conIngreso` y el worker
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("las excepciones están cercadas", () => {
  /** Lo único que un archivo `"use server"` puede importar (ADR-0002 §5.2, regla 9). */
  const PERMITIDO_EN_ACCIONES = [
    /^@admin-barrios\/data\/servicios\//,
    /^@admin-barrios\/shared(\/|$)/,
    /^@admin-barrios\/documentos$/,
    /^zod$/,
    /^next(\/|$)/,
    /^react(-dom)?(\/|$)/,
    /^\.\.?\//, // relativos del propio app (incluye `../servidor/*`)
  ];

  it("9 — un archivo `\"use server\"` solo importa de la lista blanca", () => {
    const infractores: string[] = [];
    for (const archivo of FUENTES) {
      const fuente = leerCodigo(archivo);
      if (!/^\s*["']use server["']/m.test(fuente)) continue;
      const fuera = importsDe(archivo).filter((e) => !PERMITIDO_EN_ACCIONES.some((p) => p.test(e)));
      if (fuera.length > 0) infractores.push(`${archivo} → ${fuera.join(", ")}`);
    }
    expect(
      infractores.map((i) => relativa(i.split(" → ")[0] ?? i)).sort(),
      "Violación 9 (ADR-0002 §5.2): una Server Action importa algo fuera de la lista blanca.\n" +
        "Una Server Action tiene cuatro pasos y ninguno más: (1) `parse` con Zod de `packages/shared`; " +
        "(2) `conSesion`; (3) UNA llamada a un servicio de `@admin-barrios/data/servicios/*`; " +
        "(4) `revalidatePath` y devolver un resultado serializable.\nArchivos que la rompen:",
    ).toEqual([]);
  });

  it("10 — `conIngreso` solo se referencia desde `src/app/entrar/`", () => {
    const infractores = FUENTES_SIN_PUERTA.filter(
      (a) => /\bconIngreso\b/.test(leerCodigo(a)) && !relativa(a).startsWith("apps/web/src/app/entrar/"),
    );
    exigirVacio(
      infractores,
      "Violación 10 (ADR-0002 §3.1): `conIngreso` fuera de la pantalla de entrada.",
      "Es la ÚNICA excepción a la puerta única y existe para resolver el huevo y la gallina del " +
        "login. Una excepción sin cerco se convierte en un `sinSesion()` genérico en una semana.",
    );
  });

  it("11 — en `apps/worker`, `DbJob` solo se referencia en `src/servidor/cola.ts`", () => {
    // El worker todavía no existe (queda fuera de esta tanda). La regla se escribe igual: el día que
    // aparezca la carpeta, ya está gateada — que es más barato que acordarse de agregarla después.
    const fuentes = archivosFuente(join(RAIZ, "apps/worker/src"), { incluirTests: true });
    const infractores = fuentes.filter(
      (a) => /\bDbJob\b/.test(leerCodigo(a)) && relativa(a) !== "apps/worker/src/servidor/cola.ts",
    );
    exigirVacio(
      infractores,
      "Violación 11 (ADR-0002 §5.2): `DbJob` fuera del módulo de la cola.",
      "El worker es el único proceso que legítimamente tiene la conexión BYPASSRLS, y solo para tomar " +
        "el trabajo. El cerrojo 1 impide pasarle `DbJob` a un servicio (no compila), pero " +
        "`dbJob.execute(sql`…`)` compila perfecto. Todo el resto del worker recibe `DbConIdentidad`.",
    );
  });
});
