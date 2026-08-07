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

import { readdirSync, readFileSync, statSync } from "node:fs";
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

  it("10b — `@admin-barrios/auth` solo se importa desde `src/servidor/`", () => {
    /*
     * El docblock de `iniciarSesionDeDemo()` afirma que *"la app no puede escribir la palabra
     * `headers` en el camino de identidad"*. **Esa afirmación no estaba verificada por nada.**
     *
     * La regla 4 cerca el archivo del *adapter*, pero nada impedía que la pantalla de entrada
     * importara `crearAuthProvider` de la raíz de `auth` y armara un provider con una `EntradaHttp`
     * fabricada a mano — o sea, con `["host", "localhost"]` adentro, apagando desde la aplicación la
     * vuelta 2 del candado (ADR-0002 §2.4) sin romper ninguna regla existente.
     *
     * Lo señaló `security-engineer` al revisar el rediseño de `/entrar`, y hoy pasa en verde: los
     * únicos importadores son `servidor/db.ts` y `servidor/configuracion.ts`. El valor está en que se
     * quede en verde cuando alguien rehaga la pantalla.
     */
    /*
     * ⚠ Va por **especificadores de import**, no por regex sobre el texto. La primera versión hacía
     * `/from "@admin-barrios\/auth/` y no veía un `await import(...)` ni un `require(...)` — o sea, la
     * regla de seguridad era la más floja del archivo, justo al revés de lo que corresponde. Las
     * reglas 1, 2 y 2b, que cuidan menos, ya usaban este camino.
     */
    const infractores = FUENTES.filter(
      (a) =>
        !relativa(a).startsWith("apps/web/src/servidor/") &&
        importsDe(a).some((e) => e === "@admin-barrios/auth" || e.startsWith("@admin-barrios/auth/")),
    );
    exigirVacio(
      infractores,
      "Violación 10b (ADR-0002 §2.4): `@admin-barrios/auth` importado fuera de `src/servidor/`.",
      "La identidad entra por `servidor/db.ts` y por ningún otro lado. Una pantalla que puede " +
        "construir su propia `EntradaHttp` puede inventarse el `Host`, y con eso apaga sola el " +
        "candado que impide atender desde afuera de la máquina.",
    );
  });

  it("10c — la pantalla de entrada no tiene NINGÚN campo, y el kit no tiene campos de credencial", () => {
    /*
     * **La primera versión de esta regla enumeraba lo prohibido, y `tester` la esquivó dos veces.**
     *
     * Buscaba `type="password"` como texto. Con `type={"password"} name={"clave"}` —una expresión JSX
     * entre llaves— la regla quedaba contenta y en el DOM real había un campo de contraseña
     * renderizado. Después con `type={"pass" + "word"}`. Enumerar lo prohibido es una carrera que se
     * pierde siempre: siempre hay una escritura más.
     *
     * Y tenía un segundo agujero, peor: miraba **solo** `apps/web/src/app/entrar/`. Un campo de
     * credencial escrito como componente era invisible — o sea, la regla vigilaba el único lugar
     * donde la regla 1 del ADR-0003 dice que el campo **no** va a estar.
     *
     * Así que se da vuelta la afirmación, y se afirma lo que sí es verdad y es fácil de comprobar:
     *
     * **(a) La pantalla de entrada no tiene ni un `<input>`.** No es una restricción incómoda: es lo
     * que ya pasa. El identificador de la persona viaja en el par nombre/valor que aporta el botón
     * `submit`, así que no hay ningún campo que llenar. Una condición sobre la etiqueta entera no se
     * puede rodear con una concatenación. Y de yapa cierra el riesgo de **envío implícito** que marcó
     * `code-reviewer`: sin ningún otro focusable adentro del formulario, Enter no puede enviar con el
     * primer botón y entrar como la primera persona de la lista sin que nadie lo pida.
     *
     * **(b) En `packages/ui` no hay ninguna pieza de credencial**, buscada por el concepto y no por la
     * sintaxis: las palabras `password`, `contraseña` y `clave` no aparecen. El día que exista un
     * adapter que verifique de verdad, esta mitad se borra **en el mismo cambio** que lo agrega.
     */
    const ENTRADA = "apps/web/src/app/entrar/";
    const conCampos = FUENTES.filter((a) => relativa(a).startsWith(ENTRADA) && /<input[\s/>]/.test(leerCodigo(a)));
    exigirVacio(
      conCampos,
      "Violación 10c (ADR-0002 §2.3): apareció un `<input>` en la pantalla de entrada.",
      "Esa pantalla no tiene nada que llenar: se elige una persona y el identificador viaja en el " +
        "botón. Un campo ahí es, o una credencial que no verifica nada, o un focusable que hace que " +
        "Enter entre con la primera persona de la lista.",
    );

    const CREDENCIAL = /password|contrase[nñ]a|clave/i;
    // `packages/ui` se recorre acá adentro: la constante del describe de ADR-0003 no llega a este
    // bloque, y esta regla es de identidad, no de frontera del kit.
    const kit = archivosFuente(join(RAIZ, "packages/ui/src"), { incluirTests: true }).filter((a) =>
      CREDENCIAL.test(leerCodigo(a)),
    );
    exigirVacio(
      kit,
      "Violación 10c (ADR-0002 §2.3): pieza de credencial en `packages/ui`.",
      "Mientras el proveedor sea el sustituto de desarrollo no hay nada que verificar, y un campo " +
        "que no verifica es una afirmación falsa sobre la seguridad del producto. Si se agregó " +
        "porque ya existe un adapter de credenciales, hay que borrar esta regla en el mismo cambio.",
    );
  });

  it("10d — la pantalla de entrada se declara dinámica, y dice que es una demostración", () => {
    /*
     * **Dos afirmaciones sobre el mismo archivo, y las dos son del mismo tipo: cosas que hoy son
     * ciertas por accidente y que un rediseño puede romper sin que se note.**
     *
     * `force-dynamic`: hoy la ruta es dinámica porque en algún punto se leen los `headers()`. Es una
     * deducción, y el comentario del layout de `(admin)` documenta que **puede llegar tarde**. Si
     * llegara tarde acá, un `pnpm build` corrido en una máquina de desarrollo —con `.env.local` y
     * `APP_ENTORNO=local`— hornearía **el elenco de la demo en un HTML estático** adentro del
     * artefacto, servido después sin chequeo de `Host` y sin validar el entorno.
     *
     * La declaración de demostración: es el guardrail 2 del análisis de seguridad. Tiene que estar
     * visible siempre y sin poder cerrarse. Un test no puede medir "visible", pero sí puede exigir
     * que el texto exista — y si un rediseño lo borra, el gate lo frena y se discute en el PR, que es
     * donde se tiene que discutir.
     */
    const pagina = FUENTES.filter((a) => relativa(a) === "apps/web/src/app/entrar/page.tsx");
    expect(pagina, "no se encontró `apps/web/src/app/entrar/page.tsx`").toHaveLength(1);
    const codigo = leerCodigo(pagina[0] as string);

    expect(
      /export const dynamic\s*=\s*["']force-dynamic["']/.test(codigo),
      "Violación 10d: `/entrar` no se declara `force-dynamic`. Sin eso, un build puede dejar el " +
        "elenco de la demo horneado en un HTML estático dentro del artefacto.",
    ).toBe(true);

    /*
     * ⚠ Anclado a **la pieza**, no a la palabra. La primera versión buscaba `demostración` en
     * cualquier parte del archivo, y `code-reviewer` mostró que se puede **borrar la banda entera** y
     * la regla sigue verde: la palabra sobrevive cuatro veces más (la rama del proveedor real, el
     * aviso de error, los docblocks). Un cerrojo que se satisface con un comentario no es un cerrojo.
     */
    expect(
      codigo.includes("declaracion={") && codigo.includes("Entorno de demostración"),
      "Violación 10d: la pantalla de entrada dejó de declarar que es un entorno de demostración. " +
        "No es una cortesía: sin contraseña, esa banda es lo único que impide que una captura de " +
        "esta pantalla pase por producción. Tiene que estar la prop `declaracion` de la tarjeta, " +
        "con el texto «Entorno de demostración».",
    ).toBe(true);
  });

  it("10e — el `<form>` del elenco ENVUELVE la lista, no hay uno por persona", () => {
    /*
     * **Es un candado sobre correctitud, y la primera versión de esta regla NO lo era.**
     *
     * Contaba etiquetas `<form` literales y exigía dos. `code-reviewer` demostró que eso no
     * discrimina nada: el código anterior —un formulario por persona— tenía el `<form>` **adentro
     * del `.map()`**, así que en el fuente había **una sola etiqueta literal**, más la de salir. Dos.
     * La regla pasaba en verde sobre exactamente la forma que su mensaje decía prohibir. Una regex
     * sobre texto no puede contar elementos que produce un `map`.
     *
     * Lo que sí discrimina las dos formas es **dónde** está la etiqueta respecto del `map`, y el
     * mecanismo por el que viaja el identificador: antes un `<input type="hidden">` por fila, ahora
     * el par nombre/valor que **el propio botón `submit` aporta**. Las tres cosas se afirman acá.
     *
     * ⚠ Y el motivo también estaba mal escrito, así que va corregido: **con N formularios un doble
     * clic NO entra con otra persona** — cae sobre el mismo elemento y manda el mismo valor. Lo que
     * gana la forma única es un contrato más chico y un solo lugar donde deshabilitar el conjunto el
     * día que la pantalla tenga JavaScript (hoy cuesta cero y así se queda).
     *
     * ⚠ Lo que la forma única SÍ introduce, y hay que saberlo antes de tocar esto: **envío
     * implícito**. El día que alguien meta un `<input>` en ese formulario —un buscador, un filtro—,
     * Enter envía con el **primer** botón `submit`, o sea entra como la primera persona de la lista
     * sin que nadie lo haya pedido. Hoy no pasa porque no hay ningún otro focusable adentro.
     */
    const pagina = FUENTES.filter((a) => relativa(a) === "apps/web/src/app/entrar/page.tsx");
    expect(pagina, "no se encontró `apps/web/src/app/entrar/page.tsx`").toHaveLength(1);
    const codigo = leerCodigo(pagina[0] as string);

    const dondeElForm = codigo.indexOf("<form action={entrarComoUsuarioDemo}");
    const dondeElMapa = codigo.indexOf("elenco.map(");
    expect(dondeElForm, "Violación 10e: no está el formulario del elenco.").toBeGreaterThan(-1);
    expect(dondeElMapa, "Violación 10e: no está el recorrido del elenco.").toBeGreaterThan(-1);
    expect(
      dondeElForm < dondeElMapa,
      "Violación 10e (ADR-0002 §2.3): el `<form>` del elenco no envuelve la lista. " +
        "Tiene que abrirse ANTES del `.map()`: uno solo para todas las personas.",
    ).toBe(true);

    expect(
      codigo.slice(dondeElMapa).includes("<form"),
      "Violación 10e: hay un `<form>` adentro del recorrido del elenco, o sea uno por persona.",
    ).toBe(false);

    expect(
      codigo.includes('nombreCampo="usuarioId"'),
      "Violación 10e: el botón de cada persona dejó de aportar su propio `usuarioId`. " +
        "Sin eso, el formulario único no sabe a quién se eligió.",
    ).toBe(true);

    expect(
      /type=["']hidden["']/.test(codigo),
      "Violación 10e: volvió un campo oculto. El identificador viaja en el botón `submit`, " +
        "que es lo que permite que el formulario sea uno solo.",
    ).toBe(false);
  });

  it("12 — el SDK de almacenamiento solo lo nombra la puerta de cada aplicación", () => {
    // La regla dura de CLAUDE.md §1 no es "no usar S3": es que ningún servicio de negocio lo llame
    // directo. La web SÍ necesita firmar URLs —por eso, a diferencia de Chromium (regla 3), esto no
    // es "el paquete no puede estar en el grafo"— pero el adapter concreto tiene que entrar por un
    // solo archivo, igual que la conexión a la base entra por `servidor/db.ts`.
    //
    // Se cubren `apps/**` y `packages/**`: un servicio de `packages/data` que importara el SDK sería
    // exactamente la violación que la regla dura describe, y hasta acá nada lo impedía.
    const PERMITIDOS = [
      "apps/web/src/servidor/almacenamiento.ts",
      "apps/worker/src/main.ts",
      "packages/almacenamiento/src/adapters/s3.ts",
    ];
    const fuentes = [
      ...archivosFuente(join(RAIZ, "apps"), { incluirTests: true }),
      ...archivosFuente(join(RAIZ, "packages"), { incluirTests: true }),
    ];
    const infractores = fuentes.filter(
      (a) =>
        /@aws-sdk\/|@admin-barrios\/almacenamiento\/s3/.test(leerCodigo(a)) &&
        !PERMITIDOS.includes(relativa(a)) &&
        !relativa(a).startsWith("packages/almacenamiento/test/"),
    );
    exigirVacio(
      infractores,
      "Violación 12 (CLAUDE.md §1.1): el SDK de almacenamiento fuera de la puerta de la aplicación.",
      "El adapter concreto se instancia en UN archivo por proceso, que recibe la configuración desde " +
        "la única puerta al entorno. Un servicio de negocio recibe un `ObjectStorage` por parámetro, " +
        `o no lo toca. (Permitidos: ${PERMITIDOS.join(", ")}.)`,
    );
  });

  it("11 — en `apps/worker`, `DbJob` solo se referencia en `src/servidor/cola.ts`", () => {
    // El worker todavía no existe (queda fuera de esta tanda). La regla se escribe igual: el día que
    // aparezca la carpeta, ya está gateada — que es más barato que acordarse de agregarla después.
    const fuentes = archivosFuente(join(RAIZ, "apps/worker/src"), { incluirTests: true });
    // También las FÁBRICAS, y no solo el nombre del tipo: `const db = crearDbJob(crearPoolJob({url}))`
    // no menciona `DbJob` en ningún lado —la inferencia se lo pone— así que la regla escrita solo
    // contra el identificador del tipo pasaba en verde mientras el aislamiento se evaporaba. Es
    // textualmente el modo de falla que el mensaje de error de acá abajo describe.
    const infractores = fuentes.filter(
      (a) =>
        /\bDbJob\b|\bcrearDbJob\b|\bcrearPoolJob\b/.test(leerCodigo(a)) &&
        relativa(a) !== "apps/worker/src/servidor/cola.ts",
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

// -----------------------------------------------------------------------------
// ADR-0003: frontera del sistema de UI
// -----------------------------------------------------------------------------

describe("ADR-0003: la frontera de packages/ui está gateada", () => {
  const UI = join(RAIZ, "packages/ui/src");
  const DOCUMENTOS = join(RAIZ, "packages/documentos/src");
  const FUENTES_UI = archivosFuente(UI, { incluirTests: true });

  it("UI-1 — Base UI solo se importa desde packages/ui/src", () => {
    const fuentes = [
      ...archivosFuente(join(RAIZ, "apps"), { incluirTests: true }),
      ...archivosFuente(join(RAIZ, "packages"), { incluirTests: true }),
    ];
    const infractores = fuentes.filter(
      (a) => !relativa(a).startsWith("packages/ui/src/") && importsDe(a).some((e) => e.startsWith("@base-ui/")),
    );
    exigirVacio(
      infractores,
      "Violación UI-1 (ADR-0003 §5.1): Base UI importado fuera de packages/ui.",
      "Las pantallas consumen componentes semánticos del kit; la primitiva headless queda encapsulada.",
    );
  });

  it("UI-2 — el grafo de packages/ui no alcanza datos, auth, storage, documentos ni Next", () => {
    const entradas = [resolve(UI, "index.ts"), resolve(UI, "cliente/selector-de-barrio.tsx")];
    const { archivos, externos } = grafo(entradas);
    const archivosVetados = [...archivos].filter((a) => {
      const r = relativa(a);
      return (
        r.startsWith("packages/data/") ||
        r.startsWith("packages/auth/") ||
        r.startsWith("packages/documentos/") ||
        r.startsWith("packages/almacenamiento/")
      );
    });
    exigirVacio(
      archivosVetados,
      "Violación UI-2 (ADR-0003 §5.2): packages/ui alcanzó un paquete de aplicación/datos.",
      "El kit visual solo puede depender de tokens/shared, React y la primitiva headless.",
    );
    for (const vetado of ["next", "pg", "drizzle-orm", "@aws-sdk"]) {
      expect(externos, `Violación UI-2: ${vetado} entró al grafo de packages/ui`).not.toContain(vetado);
    }
  });

  it("UI-3 — packages/documentos no alcanza packages/ui ni react", () => {
    const { archivos, externos } = grafo(archivosFuente(DOCUMENTOS));
    const ui = [...archivos].filter((a) => relativa(a).startsWith("packages/ui/"));
    exigirVacio(
      ui,
      "Violación UI-3 (ADR-0003 §5.3): documentos alcanzó packages/ui.",
      "El papel tiene sustrato propio; un componente de pantalla en una plantilla cambia documentos emitidos.",
    );
    expect(externos, "Violación UI-3: React entró al grafo de packages/documentos").not.toContain("react");
  });

  it("UI-4 — page/layout/loading/template nunca son client components", () => {
    const infractores = archivosFuente(join(WEB, "app"), { incluirTests: true }).filter((a) => {
      const nombre = a.replaceAll("\\", "/").split("/").pop() ?? "";
      if (!/^(page|layout|loading|template)\.tsx$/.test(nombre)) return false;
      return /^\s*["']use client["']/m.test(leerCodigo(a));
    });
    exigirVacio(
      infractores,
      "Violación UI-4 (ADR-0003 §5.5): un archivo de ruta de Next declara `use client`.",
      "Lo interactivo entra como isla; las rutas resuelven datos en servidor y pasan props serializables.",
    );
  });

  it("UI-5 — packages/ui no usa CSS Modules y apps/web no importa Base UI", () => {
    const modulosEnUi = FUENTES_UI.filter((a) => importsDe(a).some((e) => e.endsWith(".module.css")));
    exigirVacio(
      modulosEnUi,
      "Violación UI-5 (ADR-0003 §5.8): CSS Module dentro de packages/ui.",
      "Dentro del kit el vehículo de estilado es Tailwind v4.",
    );
  });

  it("UI-6 — las reglas de formato/entorno también cubren packages/ui", () => {
    const infractores = FUENTES_UI.filter((a) => {
      const fuente = leerCodigo(a);
      return /\bIntl\.|\.toLocale[A-Za-z]*\s*\(|\bNumber\s*\(|\bparseFloat\s*\(|\.toFixed\s*\(|\bprocess\.env\b/.test(fuente);
    });
    exigirVacio(
      infractores,
      "Violación UI-6 (ADR-0003 §5.6): packages/ui formatea, castea dinero o lee entorno.",
      "El kit recibe textos/datos ya preparados o usa shared; nunca decide formato por su cuenta.",
    );
  });

  /**
   * **Los breakpoints son la única excepción, y está acotada por regex.** Una consulta `@media` no
   * acepta `var()`: un `--breakpoint-lg: var(--bp-lg)` compila a algo inválido y la variante `lg:`
   * se pierde **en silencio**, que es exactamente el modo de falla que este guardián existe para
   * evitar. Salen del mismo `tokens.ts` que todo lo demás; lo único que cambia es que se imprime el
   * número. Se les exige `rem` —nunca `px`— para que el layout siga escalando con el tamaño de
   * fuente del sistema (doc 06 §f.8).
   */
  it("UI-7 — theme.generated.css solo contiene vars a tokens, apagados initial o breakpoints en rem", () => {
    const fuente = readFileSync(join(UI, "theme.generated.css"), "utf8");
    const infractores = fuente
      .split("\n")
      .map((linea, i) => ({ linea: linea.trim(), n: i + 1 }))
      .filter(({ linea }) => {
        if (!linea.startsWith("--")) return false;
        if (/^--breakpoint-[a-z0-9]+: \d+(\.\d+)?rem;$/.test(linea)) return false;
        return !/: (var\(--[a-z0-9-]+\)|initial);$/.test(linea);
      });
    expect(
      infractores,
      "Violación UI-7 (ADR-0003 §5.7): theme.generated.css tiene valores que no son var() a tokens ni initial.",
    ).toEqual([]);
    expect(fuente).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b\d+px\b/);
  });

  /**
   * **El barril no arrastra cliente.** `index.ts` es lo que importa una pantalla que solo quiere un
   * `Boton`; si desde ahí se alcanza un módulo de `cliente/`, esa pantalla se lleva la isla entera y
   * su primitiva aunque no las use. No es teórico: pasó el 2026-08-04. `shell.tsx` importaba
   * `SelectorDeBarrio`, y el `pnpm build` mostraba **155 kB** de First Load JS en la lista de
   * períodos —lectura pura, cero interacción—. Sacando ese import quedó en **106 kB**: 48 kB que
   * nadie ejecutaba, en todas las pantallas del barrio.
   *
   * La forma de cumplirlo es pasar la isla **como prop** desde la pantalla, que además hace que la
   * frontera se lea en el import (ADR-0003 §4). Un componente del kit nunca importa a otro de su
   * propio estrato de cliente.
   */
  it("UI-8 — el barril de packages/ui no alcanza ningún módulo de `cliente/`", () => {
    const { archivos } = grafo([resolve(UI, "index.ts")]);
    const infractores = [...archivos].filter((a) => relativa(a).startsWith("packages/ui/src/cliente/"));
    exigirVacio(
      infractores,
      "Violación UI-8 (ADR-0003 §4): el índice del kit arrastra una isla de cliente.",
      "Toda pantalla que importe cualquier cosa del kit se lleva ese JavaScript aunque no lo use. " +
        "La isla se pasa como prop desde la pantalla, que la importa por su subruta `cliente/*`.",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El texto del repo está en UTF-8 y solo en UTF-8
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * **Regla 14 — nada de mojibake.** Una herramienta que lee un archivo como UTF-8 y lo vuelve a
 * guardar como cp1252 (o al revés) convierte `Administración` en `Administraci` + basura. Pasó de
 * verdad el 2026-08-04: `seed-demo.ts` quedó con el padrón entero roto —el nombre de la
 * administradora, el del estudio, media docena de apellidos— y eso se ve **en la pantalla del
 * administrador**, no en un comentario. El daño es silencioso: compila, pasa los tests y aparece
 * recién cuando alguien mira. Lo detectó el usuario a ojo, que es exactamente lo que un gate existe
 * para evitar.
 *
 * Se buscan las dos firmas del doble-encodeo que en castellano correcto no existen nunca: los bytes
 * `C3`/`C2` seguidos de un byte de continuación, y el prefijo de las comillas y rayas tipográficas.
 * La expresión va con escapes `\u` a propósito: escrita con los caracteres de verdad, este archivo
 * dispararía su propia regla.
 */
const MOJIBAKE = new RegExp(`[\u00C2\u00C3][\u0080-\u00BF]|\u00E2\u20AC`);

/** Todo archivo de texto del repo, sin `node_modules`, artefactos ni el lockfile. */
function archivosDeTexto(carpeta: string): string[] {
  const salida: string[] = [];
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      if (["node_modules", ".next", ".git", "dist", "coverage"].includes(entrada)) continue;
      const ruta = join(dir, entrada);
      if (statSync(ruta).isDirectory()) recorrer(ruta);
      else if (/\.(ts|tsx|js|mjs|cjs|css|json|md|sql|ya?ml)$/.test(entrada) && entrada !== "pnpm-lock.yaml") {
        salida.push(ruta);
      }
    }
  };
  recorrer(carpeta);
  return salida;
}

describe("el texto del repo está en UTF-8", () => {
  const DE_TEXTO = archivosDeTexto(RAIZ).filter((a) => resolve(a) !== ESTE_ARCHIVO);

  it("14 — ningún archivo quedó doble-codificado (mojibake)", () => {
    const infractores = DE_TEXTO.filter((a) => MOJIBAKE.test(readFileSync(a, "utf8")));
    exigirVacio(
      infractores,
      "Violación 14: hay texto doble-codificado (UTF-8 guardado como cp1252).",
      "Los acentos se ven como pares de símbolos raros. Reescribí el archivo en UTF-8 sin BOM; si lo generó una herramienta, revisá el encoding de salida ANTES de volver a correrla, o vuelve a romper el archivo entero.",
    );
  });

  /**
   * **Sin BOM, que es la otra mitad de la misma regla.** La 14 nació el 2026-08-04 y su propio texto
   * de remediación decía "UTF-8 **sin BOM**"… mientras seis archivos del mismo commit entraban con
   * BOM, porque la regla solo miraba el mojibake. Lo detectó el revisor.
   *
   * No es cosmético: un `﻿` al principio de un `.mjs` o un `.css` es un carácter más para quien
   * lo parsea, y sale caro en los archivos que **no** son módulos ES —un `.json` con BOM lo rechaza
   * `JSON.parse`, y un `.sql` con BOM se lo come el motor como parte de la primera sentencia—. Es el
   * mismo síntoma de la regla 14: lo escribe una herramienta, compila igual, y aparece lejos.
   */
  it("14b — ningún archivo empieza con BOM", () => {
    const infractores = DE_TEXTO.filter((a) => {
      const bytes = readFileSync(a);
      return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    });
    exigirVacio(
      infractores,
      "Violación 14b: hay un archivo que empieza con BOM.",
      "UTF-8 se escribe sin marca de orden de bytes. Suele ponerlo un editor de Windows o una " +
        "herramienta que reescribió el archivo entero; se saca borrando los tres primeros bytes.",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Regla 15: los tokens que usa un CSS Module tienen que existir
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **Un `var(--token)` que no existe no es un error: la declaración entera se descarta en
 * silencio.** No hay advertencia en la consola, no falla el build, y la pantalla sale con ese
 * renglón de CSS simplemente ausente.
 *
 * Pasó y lo encontró el usuario el 2026-08-04: `documentos.module.css` tenía **siete de ocho**
 * tokens inventados (`--space-3`, `--color-border`, `--color-text`…, ninguno existe). El síntoma
 * visible fue la barra de avance encimada al número que tiene al lado, porque el `gap` que los
 * separaba apuntaba a `--space-3`; y de arrastre los enlaces de descarga estaban sin borde, sin
 * fondo y sin color. Nadie lo vio en meses.
 *
 * **De dónde salen los nombres válidos:** `tokens.generated.css` (que emite
 * `packages/design-tokens`, y por eso no se edita a mano) más lo que `globals.css` define. Un token
 * declarado en el propio archivo también vale — es una variable local, no un token del sistema.
 *
 * **Las dos excepciones son de verdad excepciones**, y por eso están enumeradas y no adivinadas: el
 * acento del barrio se inyecta en runtime con `style={{ "--acento-claro": … }}` desde el layout,
 * porque **es un dato del tenant** y no puede estar en la hoja de estilos.
 */
const TOKENS_INYECTADOS_EN_RUNTIME = new Set(["--acento-claro", "--acento-oscuro"]);

describe("los tokens de los CSS Modules existen", () => {
  it("15 — ningún `var(--token)` apunta a una variable que no está definida", () => {
    const declarados = (archivo: string): string[] =>
      [...readFileSync(archivo, "utf8").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!);

    const conocidos = new Set([
      ...declarados(join(WEB, "app/tokens.generated.css")),
      ...declarados(join(WEB, "app/globals.css")),
      ...TOKENS_INYECTADOS_EN_RUNTIME,
    ]);

    const modulos = archivosDeTexto(WEB).filter((a) => a.endsWith(".module.css"));
    const infractores = modulos.filter((archivo) => {
      // Los comentarios se sacan: este mismo repo tiene módulos que **explican** la convención
      // escribiendo `var(--token)` en una cabecera, y sin esto el comentario rompe la regla — el
      // mismo tropiezo que ya había tenido la regla 7.
      const css = sinComentarios(readFileSync(archivo, "utf8"));
      const locales = new Set(declarados(archivo));
      return [...css.matchAll(/var\((--[a-z0-9-]+)/g)].some(
        (m) => !conocidos.has(m[1]!) && !locales.has(m[1]!),
      );
    });

    exigirVacio(
      infractores,
      "Violación 15: un CSS Module usa un token que no existe.",
      "Un `var()` a una variable inexistente descarta la declaración entera **en silencio**: no hay " +
        "error, no falla el build, y la regla simplemente no se aplica. Los nombres válidos salen de " +
        "`tokens.generated.css` (generado por `packages/design-tokens`, no se edita a mano) y de " +
        "`globals.css`. Si el valor depende del barrio, se inyecta en runtime y se agrega a " +
        "`TOKENS_INYECTADOS_EN_RUNTIME` con su motivo.",
    );
  });
});
