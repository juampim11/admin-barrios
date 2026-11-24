// Frenos por mecanismo (PreToolUse). Node puro, sin dependencias, sin tocar el disco salvo `git`.
//
// Por qué existe: lo que en CLAUDE.md es regla en prosa depende de que el modelo se acuerde. Acá queda
// impuesto por mecanismo. `.claude/settings.json` (`permissions.deny`) cubre lo que un patrón puede
// expresar; este módulo cubre lo que no alcanza (rutas mencionadas con cualquier herramienta, push según
// la rama actual, mensajes de commit, herramientas MCP).
//
// Es una función pura (`evaluar`) para poder testearla con el JSON de entrada de un hook, sin Claude.
// `pre-tool-use.mjs` es el ejecutable que lee stdin y devuelve el bloqueo.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

const PIE = "pedíselo al titular";

/** Resultado de bloquear: el motivo se muestra tal cual a quien lo recibe. */
function frenar(que) {
  return { bloquear: true, motivo: `Frenado por regla del proyecto: ${que}; ${PIE}.` };
}

// ── 3.a Rutas sensibles ──────────────────────────────────────────────────────────────────────────────

/** Normaliza una ruta o comando: minúsculas y barras hacia adelante, para que valga en Windows y en bash. */
function normalizar(texto) {
  return String(texto ?? "").replace(/\\/g, "/").toLowerCase();
}

const SUFIJOS_PLANTILLA = /\.(example|sample|template|dist)$/;

/**
 * ¿La ruta o el texto menciona un `.env`, o una carpeta de secretos o de datos reales?
 * `.env.example` (y sus hermanos `.sample`, `.template`, `.dist`) se deja pasar: es la plantilla versionada
 * y no lleva valores (CLAUDE.md §1.5).
 */
export function mencionaRutaSensible(texto) {
  const t = normalizar(texto);

  // `.env` y `.env.<algo>`: `(?<![\w.-])` evita `process.env`, y `(?![\w-])` evita `.environment.ts`.
  for (const m of t.matchAll(/(?<![\w.-])\.env(?![\w-])((?:\.[\w*-]+)*)/g)) {
    if (!SUFIJOS_PLANTILLA.test(m[0])) return ".env (secretos locales)";
  }

  // Carpetas de datos reales o secretos: `privado/`, `_privado/`, `_secretos/`, `datos/`, y su forma
  // sin barra final solo si va precedida de una barra (`cd ../datos`). Sola, la palabra «datos» es
  // castellano normal en un mensaje de commit y no es una ruta.
  const carpeta = "(?:privado|_privado|_secretos|datos)";
  if (new RegExp(`(?:^|[\\s"'=:(,/])${carpeta}/`).test(t)) return "carpeta de datos o secretos";
  if (new RegExp(`/${carpeta}(?=$|[\\s"';|&)])`).test(t)) return "carpeta de datos o secretos";
  // Con guion bajo el nombre no se confunde con una palabra: se frena aun sin barra.
  if (/(?<![\w])(?:_privado|_secretos)(?![\w])/.test(t)) return "carpeta de datos o secretos";
  return null;
}

/**
 * Quita lo que es solo texto de un commit o de un PR: los heredoc, las here-strings de PowerShell y el
 * argumento de `-m`/`--message`/`-t`/`--title`/`-b`/`--body`. [F7] Solo esos: una ruta entre comillas
 * (`git add -f ".env"`, `-F ".env"`, `--body-file ".env"`) queda a la vista del filtro de secretos
 * (security-engineer, M5).
 */
function sinMensajes(comando) {
  // El vaciado de `-m`, `-t` y `-b` vale solo dentro de un `git commit`, `git tag` o `gh pr`: en
  // `git branch -m "main" viejo` las comillas encierran una rama, no un mensaje (code-reviewer, m1).
  const esMensaje = (texto, desde) => {
    const inicio = Math.max(...[";", "&", "|", "\n"].map((s) => texto.lastIndexOf(s, desde)));
    return /\bgit\b[^;&|\n]*\b(?:commit|tag)\b|\bgh\s+pr\b/.test(texto.slice(inicio + 1, desde));
  };
  return comando
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2(?=\s|$|\))/g, "<<HEREDOC")
    .replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, "@''@")
    .replace(/((?:^|\s)(?:-[a-zA-Z]*m|--message|-t|--title|-b|--body)(?:\s+|=))("(?:\\.|[^"\\])*"|'[^']*')/g, (todo, opcion, _texto, desde, entero) =>
      esMensaje(entero, desde) ? `${opcion}''` : todo,
    );
}

/**
 * [F7] El cuerpo de un heredoc o de una here-string que recibe un intérprete (`bash <<EOF`, `sh -s <<EOF`,
 * `cat <<EOF | bash`, `iex @'…'@`) es un comando, no un mensaje: se evalúa como tal. Sin esto, vaciar los
 * heredoc (para que el texto de un commit no dispare frenos) dejaba pasar `bash <<EOF … git push origin main`
 * (code-reviewer, segunda vuelta, M1).
 */
const INTERPRETE = /\b(?:bash|sh|zsh|dash|ksh|pwsh|powershell|iex|invoke-expression|node|python3?|perl|ruby)(?:\.exe)?\b/i;
function cuerposEjecutados(comando) {
  const salida = [];
  for (const m of comando.matchAll(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\s*\2(?=\s|$|\))/g)) {
    const desde = m.index ?? 0;
    const linea = comando.slice(comando.lastIndexOf("\n", desde) + 1, desde) + m[3];
    if (INTERPRETE.test(linea)) salida.push(m[4]);
  }
  for (const m of comando.matchAll(/@(['"])\r?\n?([\s\S]*?)\r?\n?\1@/g)) {
    const desde = m.index ?? 0;
    const fin = desde + m[0].length;
    const alrededor = comando.slice(comando.lastIndexOf("\n", desde) + 1, desde) + comando.slice(fin, comando.indexOf("\n", fin) === -1 ? undefined : comando.indexOf("\n", fin));
    if (INTERPRETE.test(alrededor)) salida.push(m[2]);
  }
  return salida;
}

// ── Segmentación del comando ─────────────────────────────────────────────────────────────────────────

/**
 * [S8] El `&` de una redirección (`2>&1`, `&>`, `|&`) no es un segundo comando: cortar ahí escondía las rutas
 * que seguían (`rm -rf node_modules 2>&1 src`). El destino de `>&n` queda pegado para no confundirlo con una ruta.
 */
function sinRedirecciones(comando) {
  return comando.replace(/\d*[<>]&\d*/g, ">DEV").replace(/&>>?/g, ">").replace(/\|&/g, "|");
}

/**
 * Parte una línea de comando en sus comandos simples: `;`, `&&`, `||`, `|`, saltos de línea y [F7] también
 * `&` suelto (segundo plano), paréntesis y llaves. Sin eso, `git status & git push origin main` escondía
 * el segundo comando (security-engineer, M2).
 */
function segmentos(comando) {
  return sinRedirecciones(comando)
    // Las llaves, solo sueltas: pegadas a otro texto son `@{0}` (reflog) o un formato, y cortarlas partía
    // `git push origin HEAD@{0}:main` y escondía el destino (code-reviewer, segunda vuelta, B1).
    .split(/\r?\n|&&|\|\||;|\||&|[()]|(?<=^|\s)[{}](?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * [F7] ¿Alguna opción es una de las prohibidas? Git acepta **abreviaturas** de las largas (`--mirr`,
 * `--del`, `--forc`) y **grupos** de cortas (`-qd`, `-nm`): comparar el texto exacto no alcanza
 * (security-engineer, M1). Una larga cuenta desde **una** letra si es el comienzo de una prohibida:
 * `--m` es `--mirror` y `--e` es `--exec` para git (segunda vuelta, B). Si la abreviatura es ambigua,
 * git ya la rechaza, así que frenarla no rompe nada del trabajo normal.
 * Devuelve la larga prohibida (o la letra corta) que coincidió.
 */
function opcionProhibida(args, largas, cortas = "") {
  for (const a of args) {
    if (a.startsWith("--")) {
      const nombre = a.slice(2).split("=")[0].toLowerCase();
      if (nombre.length < 1) continue;
      const p = largas.find((l) => l.startsWith(nombre));
      if (p) return p;
    } else if (cortas && /^-[a-zA-Z]+$/.test(a)) {
      const letra = [...a.slice(1)].find((c) => cortas.includes(c));
      if (letra) return letra;
    }
  }
  return null;
}

/**
 * Tokens de un comando simple, sin comillas. Alcanza para mirar banderas y refspecs de git. [F7] Sin
 * ninguna comilla, barra invertida ni comilla invertida, en cualquier lugar del token: el shell une
 * `ma''in`, `ma\in` y `` ma`in `` en `main`, y comparar el texto crudo dejaba pasar `HEAD:ma''in`
 * (security-engineer, segunda vuelta, A).
 */
function tokens(segmento) {
  // [S8] Las partes pegadas se unen: `"g"it` es `git`.
  return (segmento.match(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g) ?? []).map((t) => t.replace(/["'\\`]/g, ""));
}

/** ¿El comando simple es `git [opciones] <sub> ...`? Devuelve los tokens tras el subcomando. */
function subcomandoGit(segmento, sub) {
  const t = tokens(segmento);
  const i = t.findIndex((x) => /^(?:.*[\\/])?git(?:\.exe)?$/i.test(x));
  if (i === -1) return null;
  // Opciones globales de git con valor: -C <dir>, -c <k=v>, --git-dir=…
  let j = i + 1;
  // [S8] También las globales con el valor aparte (`--git-dir .git`, `--work-tree .`): sin saltarlo, el valor se
  // tomaba por el subcomando y `git --git-dir .git push --force origin main` no se veía como un push.
  while (j < t.length && t[j].startsWith("-")) j += /^(?:-[Cc]|--(?:git-dir|work-tree|namespace|super-prefix|config-env|exec-path|attr-source))$/.test(t[j]) ? 2 : 1;
  return t[j] === sub ? t.slice(j + 1) : null;
}

const RAMAS_PROTEGIDAS = /^(main|master)$/;

function ramaPorDefecto(cwd) {
  try {
    // `symbolic-ref` y no `rev-parse`: este último falla en una rama sin commits y el hook no vería la rama.
    return execFileSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// ── 3.b Push ─────────────────────────────────────────────────────────────────────────────────────────

/** [F7] Las opciones de `git push` que se frenan, con su motivo (también abreviadas o agrupadas). */
const PUSH_PROHIBIDAS = {
  force: "`git push` forzado (--force, -f, --force-with-lease)",
  "force-with-lease": "`git push` forzado (--force, -f, --force-with-lease)",
  "force-if-includes": "`git push` forzado (--force, -f, --force-with-lease)",
  mirror: "`git push --mirror` pisa el remoto",
  // Borrar en el remoto (rama o tag): un tag por nombre es indistinguible de una rama, así que se frena todo `--delete`.
  delete: "`git push --delete` (borrar ramas o tags remotos lo hace el titular)",
  tags: "`git push` de tags (los tags de versión los sube el titular)",
  "follow-tags": "`git push` de tags (los tags de versión los sube el titular)",
  // [F7] Lo que el allow dejaría pasar y no es trabajo normal.
  prune: "`git push --prune` borra ramas remotas",
  all: "`git push --all` sube todas las ramas, también `main`",
  branches: "`git push --all` sube todas las ramas, también `main`",
  "no-verify": "`--no-verify` saltea los hooks de git",
  "receive-pack": "`--receive-pack`/`--exec` ejecutan un programa local (security-engineer, M4)",
  exec: "`--receive-pack`/`--exec` ejecutan un programa local (security-engineer, M4)",
};

function revisarPush(args, ramaActual, comandoCompleto) {
  const op = opcionProhibida(args, Object.keys(PUSH_PROHIBIDAS), "fd");
  if (op) return frenar(op === "f" ? PUSH_PROHIBIDAS.force : op === "d" ? PUSH_PROHIBIDAS.delete : PUSH_PROHIBIDAS[op]);
  for (const a of args) {
    // [F7] Lo que el shell expande antes de que git lo vea (`{main,x}`, `$VAR`, `%VAR%`): no se puede saber
    // a qué rama apunta (segunda vuelta, A). `HEAD@{0}:main` cae acá también, y se frena.
    if (/[{}$%]/.test(a)) return frenar("`git push` con un argumento que el shell expande (llaves, `$` o `%`): no se puede saber a qué rama apunta");
    if (a.startsWith("+")) return frenar("`git push` forzado (refspec con `+`)");
    if (a === "tag" || /(?:^|:)refs\/tags\//.test(a)) return frenar("`git push` de tags (los tags de versión los sube el titular)");
    if (a.startsWith("-")) continue;
    // [F7] Refspecs que borran o que suben más de lo que nombran: `origin :rama` borra la rama remota;
    // `origin :` (matching) y un comodín (`refs/heads/*:refs/heads/*`) suben también `main` (M3).
    if (a === ":" || a.includes("*")) return frenar("`git push` con refspec «matching» o con comodín sube también `main`");
    if (a.startsWith(":")) return frenar("`git push <remoto> :<rama>` borra una rama remota (borrar ramas lo hace el titular)");
  }
  for (const a of args) {
    if (a.startsWith("-")) continue;
    const destino = a.includes(":") ? a.split(":").pop() : a;
    if (RAMAS_PROTEGIDAS.test(destino.replace(/^refs\/heads\//, ""))) {
      return frenar("`git push` a `main` o `master` (los cambios entran por PR que aprueba el titular)");
    }
  }
  if (RAMAS_PROTEGIDAS.test(ramaActual())) {
    return frenar(`\`git push\` estando en la rama \`${ramaActual()}\` (se trabaja en una rama \`feat/…\` o \`chore/…\` y se entra por PR)`);
  }
  // `git checkout main && git push`: la rama cambia dentro del mismo comando.
  if (/\bgit\b[^;&|\n]*\b(?:checkout|switch)\b[^;&|\n]*\b(?:main|master)\b/i.test(comandoCompleto)) {
    return frenar("`git push` tras pasarse a `main` en el mismo comando");
  }
  return null;
}

// ── Comandos prohibidos (espejo de `permissions.deny`, por si vienen con opciones intercaladas) ──────

/**
 * `git tag` sin argumentos o con `-l`/`--list` (y sus filtros) solo lista. Cualquier otra forma crea o borra.
 * Con `-l` el resto son patrones de búsqueda (`git tag -l 'v*'`), salvo que venga una bandera que escribe.
 */
function esListadoDeTags(args) {
  if (args.length === 0) return true;
  if (args.some((a) => /^(?:-[a-z]*[adsfmu][a-z]*|--(?:annotate|delete|sign|force|message|local-user)(?:=.*)?)$/.test(a) && !/^-[a-z]*l[a-z]*$/.test(a) && !/^-n\d*$/.test(a))) return false;
  return args.some((a) => /^(?:-l|--list|-n\d*|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--column)(?:=.*)?$/.test(a));
}

const PROHIBIDOS_GH = [
  [/^gh\s+pr\s+merge\b/, "`gh pr merge` (el merge lo hace el titular)"],
  [/^gh\s+release\b/, "`gh release`"],
  [/^gh\s+secret\b/, "`gh secret`"],
  [/^gh\s+auth\b/, "`gh auth`"],
];

// ── [S8] Borrado recursivo o forzado: `rm`, `Remove-Item`, `del`, `rd` ──────────────────────────────────
//
// Sin esto, `rm -rf` sobre cualquier carpeta del repo salía sin pedir nada (solo se frenaba sobre las rutas
// de los frenos y de los secretos). Un `rm`/`Remove-Item` **sin** opción recursiva ni forzada no se mira: borra
// archivos sueltos, y eso está en el trabajo normal.
//
// LA LISTA DE LO DESCARTABLE VIVE ACÁ, EN UN SOLO LUGAR. Una ruta se deja borrar con `-r`/`-f` solo si TODAS las
// rutas del comando están en la lista; si el comando no nombra ninguna (`… | Remove-Item -Recurse`) no se puede
// saber qué borra y se frena. Nunca vale una ruta con `..`, `~`, `$` o `%` (salvo el prefijo de temporales) ni con
// una comilla invertida: el shell la cambia antes de borrar.
const RUTAS_DESCARTABLES = {
  // Carpetas que se regeneran (`pnpm install`, `next build`, tests): cuenta si el nombre es UN SEGMENTO de una
  // ruta relativa del repo (`apps/web/.next`, `node_modules/.cache`), no una parte del nombre (`distro`).
  // `.next-build` es donde compila `apps/web` (`NEXT_DIST_DIR`, ver `next.config.mjs`).
  carpetas: ["node_modules", ".next", ".next-build", "dist", "coverage"],
  // Carpeta de trabajo del repo (en `.gitignore`), relativa a la raíz: `tmp` y todo lo que cuelga.
  carpetaTemporalDelRepo: "tmp",
  // Temporales del sistema, con lo que sigue SIEMPRE detrás (no se puede borrar el directorio entero).
  // Cada shell expande otra variable: `$TEMP` en PowerShell NO es la de entorno (sin definir queda vacía y
  // `$TEMP/Windows` sería `/Windows`), y `$env:TEMP` en bash no existe. `shell` = "Bash", "PowerShell" o
  // "ambos" (un comando anidado, que no se sabe en qué intérprete corre: solo vale lo que es seguro en los dos).
  prefijosTemporales: (shell) => [
    /^%(?:TEMP|TMP)%\//i,
    // En PowerShell `/tmp/x` es `C:\tmp\x`, una carpeta cualquiera de la raíz del disco: no es el temporal.
    ...(shell !== "PowerShell" ? [/^\/tmp\//] : []),
    ...(shell === "Bash" ? [/^\$\{?(?:TEMP|TMP)\}?\//] : []),
    ...(shell !== "Bash" ? [/^\$(?:env:(?:TEMP|TMP)|\{env:(?:TEMP|TMP)\})\//i] : []),
  ],
  // Los de este equipo, ya resueltos: `C:/Users/…/AppData/Local/Temp`, su forma de Git Bash (`/c/Users/…`) y la
  // real si el nombre corto de Windows (`JUANPB~1`) apunta a otro nombre.
  directoriosTemporalesDelSistema: () => {
    const base = [tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean);
    for (const d of [...base]) {
      try {
        base.push(realpathSync.native(d));
      } catch {
        /* no existe: no hay nada que agregar */
      }
    }
    const rutas = base.map((d) => d.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
    return [...new Set([...rutas, ...rutas.map((d) => d.replace(/^([a-z]):\//, "/$1/"))])];
  },
};

/**
 * ¿Es una ruta que se puede borrar de forma recursiva o forzada? Ver `RUTAS_DESCARTABLES`. `sinVariables`: el
 * comando reasigna `TEMP`/`TMP` (`TEMP=/c; rm -rf $TEMP/x`), así que ninguna variable vale como raíz.
 */
function esRutaDescartable(ruta, shell, sinVariables = false) {
  const original = String(ruta).replace(/^(?:\.[\\/])+/, "");
  const r = original.replace(/\\/g, "/");
  // `~` solo expande al principio de la palabra; en medio es parte del nombre corto de Windows (`JUANPB~1`).
  if (!r || /`|^~/.test(r) || r.includes("$(") || /[(){};]/.test(r.replace(/^\$\{(?:env:)?\w+\}/, ""))) return false;
  // `..` también escondido: en Bash `.\.` es `..` (la barra invertida escapa), y en Windows `\` separa.
  if (r.split("/").includes("..") || original.replace(/\\/g, "").split("/").includes("..")) return false;
  const sinBarraFinal = r.replace(/\/+$/, "");

  for (const prefijo of RUTAS_DESCARTABLES.prefijosTemporales(shell)) {
    if (sinVariables && !/^\^\\\/tmp/.test(prefijo.source)) continue;
    const m = prefijo.exec(r);
    if (m) return !/[$%]/.test(r.slice(m[0].length)) && r.length > m[0].length;
  }
  const bajoElSistema = RUTAS_DESCARTABLES.directoriosTemporalesDelSistema().some((d) => sinBarraFinal.toLowerCase().startsWith(`${d}/`) && sinBarraFinal.length > d.length + 1);
  if (bajoElSistema) return !/[$%]/.test(r);

  // Relativa al repo: sin raíz (`/`, `C:`), sin variables.
  if (/^(?:\/|[a-zA-Z]:)/.test(r) || /[$%]/.test(r)) return false;
  const segmentos = sinBarraFinal.split("/");
  return segmentos[0] === RUTAS_DESCARTABLES.carpetaTemporalDelRepo || segmentos.some((s) => RUTAS_DESCARTABLES.carpetas.includes(s));
}

const VERBOS_DE_BORRADO = /^(?:rm|rmdir|rd|del|erase|ri|remove-item)$/i;
// Lo que se puede anteponer sin cambiar lo que se ejecuta: `sudo rm`, `command rm`, `xargs rm`, `& Remove-Item`, `FOO=1 rm`.
const PREFIJOS_DE_BORRADO = /^(?:then|do|else|elif|elseif|if|while|until|for|foreach|switch|case|try|finally|!|%|foreach-object|icm|invoke-command|sudo|doas|command|builtin|exec|eval|nohup|time|timeout|nice|ionice|stdbuf|busybox|wsl|xargs|env|call|start|&|cmd(?:\.exe)?|\/{1,2}[ck]|(?:\$env:)?\w+=\S*)$/i;
// ¿El comando reasigna `TEMP`/`TMP`? Entonces `$TEMP/x` no apunta a donde parece.
// No se enumeran las formas de asignar (`TEMP=`, `+=`, `read`, `for`, `printf -v`, `SetEnvironmentVariable`…): si, sacando
// los usos como raíz de una ruta (`$TEMP/…`, `${env:TEMP}/…`, `%TEMP%/…`), el comando todavía nombra TEMP o TMP,
// la variable pudo cambiar y no vale.
function reasignaTemporales(comando) {
  return /\b(?:TEMP|TMP)\b/i.test(comando.replace(/["']/g, "").replace(/(?:\$\{?(?:env:)?|%)(?:TEMP|TMP)(?:\}|%)?[\\/]/gi, ""));
}

/** Tokens de un comando simple: las partes pegadas se unen (`"r"m` es `rm`) y se sacan las comillas y las comillas invertidas. */
function tokensDeBorrado(seg) {
  return (seg.match(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g) ?? []).map((x) => x.replace(/["'`]/g, ""));
}

/**
 * [S8] Los comandos simples de la línea para mirar borrados. A diferencia de `segmentos`, NO corta en paréntesis
 * ni en llaves (`Remove-Item (Join-Path . src) -Recurse` perdía sus banderas): las expresiones `(…)` y `$(…)`
 * se reemplazan por un token opaco, que nunca es una ruta descartable.
 */
function segmentosDeBorrado(comando) {
  // Las llaves de un bloque (`{ rm -rf x; }`, `if (…) { Remove-Item … }`) se sacan; quedan las que son parte de
  // una palabra: `${TEMP}`, `{a,b}` y el `{}` de `find -exec`.
  let c = sinRedirecciones(comando)
    .replace(/\$\{[^}]*\}|\{[^{}\s]*\}/g, (m) => m.replace(/[{}]/g, (x) => (x === "{" ? "\u0001" : "\u0002")))
    .replace(/[{}]/g, " ")
    .replace(/\u0001/g, "{")
    .replace(/\u0002/g, "}");
  const salida = [];
  // Un `(…)` es un subshell, una condición o una expresión: su contenido también es un comando y se mira por
  // separado; en el comando de afuera queda un token opaco que nunca es una ruta descartable.
  for (let n = 0; n < 20 && /\([^()]*\)/.test(c); n++) {
    c = c.replace(/\$?[<@]?\(([^()]*)\)/g, (_, dentro) => {
      salida.push(dentro);
      return "(X)";
    });
  }
  salida.push(c);
  // `catch` y `finally` abren otro bloque, con sus propios comandos; la etiqueta de un `case` (`a)`) no es un comando.
  return salida
    .flatMap((x) => x.split(/\r?\n|&&|\|\||;|\||&|(?<=\s|^)(?:catch|finally)(?=\s|$)/i))
    .map((s) => s.replace(/(^|\s)[\w*|./-]+\)(?=\s|$)/g, "$1").trim())
    .filter(Boolean);
}

/**
 * [S8] ¿El comando simple borra de forma recursiva o forzada algo que no es descartable? `shell` es la
 * herramienta que lo ejecuta: en Bash, `rm -rf` agrupa letras; en PowerShell, `-Recurse`/`-Force` aceptan
 * abreviaturas (`-r`, `-fo`) y `rm` es un alias de `Remove-Item`. `del`/`rd`/`rmdir` aceptan además `/s`, `/q` y `/f`.
 */
function revisarBorrado(seg, shell, sinVariables = false) {
  // `$null = Remove-Item …` y `$r = (…)`: la asignación de PowerShell no cambia lo que se ejecuta.
  const t = tokensDeBorrado(seg.replace(/^\s*\$[\w:{}.]+\s*[+\-*/]?=\s*/, ""));
  // `rm`, `r\m`, `Re`move-Item`, `C:\…\rm.exe`: el shell las junta o las ignora antes de ejecutar.
  const nombreDelVerbo = (x) => x.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").replace(/[\\`]/g, "");
  const esVerbo = (x) => VERBOS_DE_BORRADO.test(nombreDelVerbo(x)) || VERBOS_DE_BORRADO.test(x.replace(/[\\`]/g, "").replace(/\.exe$/i, ""));
  let i = 0;
  while (i < t.length && PREFIJOS_DE_BORRADO.test(t[i].replace(/^\\/, ""))) i++;
  if (i >= t.length) return null;
  const viaCmd = t.slice(0, i).some((x) => /^(?:cmd(?:\.exe)?|\/{1,2}[ck])$/i.test(x));
  const esFind = /^(?:.*[\\/])?find(?:\.exe)?$/i.test(t[i]);
  // `find … -delete` borra por su cuenta, recursivo: se mira como `rm -r` sobre sus raíces.
  // También `find … -exec rm {} +` (borra todo lo que encuentra sin `-r`) y, con `-follow`/`-L`, los enlaces.
  const execBorra = t.some((x, n) => /^-(?:exec|execdir|ok|okdir)$/.test(x) && t.slice(n + 1, n + 3).some(esVerbo));
  if (esFind && (t.includes("-delete") || execBorra)) {
    if (t.some((x) => /^(?:-follow|-L)$/.test(x))) return frenar("`find -delete` siguiendo enlaces (`-follow`, `-L`) puede borrar fuera de la carpeta");
    const raices = t.slice(i + 1).filter((x, n, todos) => todos.slice(0, n + 1).every((y) => !/^[-(!]/.test(y)));
    if (raices.length > 0 && raices.every((r) => esRutaDescartable(r, shell, sinVariables))) return null;
    return frenar("`find … -delete` borra de forma recursiva (solo sobre carpetas descartables)");
  }
  // Con un prefijo que lleva opciones (`xargs -0 rm`, `sudo -u x rm`, `env -i rm`, `find … -exec rm`) el verbo
  // no es el token que sigue: se lo busca más adelante.
  // No se busca si lo que sigue al prefijo es otro programa (`time git rm -r --cached x`, `env X=1 git rm …`): el `rm`
  // de `git rm` no es el de borrado de archivos.
  const OTRO_PROGRAMA = /^(?:git|pnpm|npm|npx|node|echo|printf|cat|grep|rg)$/i;
  if (!esVerbo(t[i]) && (i > 0 || esFind) && !OTRO_PROGRAMA.test(nombreDelVerbo(t[i]))) {
    const otro = t.findIndex((x, n) => n > i && OTRO_PROGRAMA.test(nombreDelVerbo(x)));
    const j = t.findIndex((x, n) => n > i && esVerbo(x));
    if (j !== -1 && (otro === -1 || j < otro)) i = j;
  }
  if (!esVerbo(t[i])) return null;
  const verbo = (VERBOS_DE_BORRADO.test(nombreDelVerbo(t[i])) ? nombreDelVerbo(t[i]) : t[i].replace(/[\\`]/g, "").replace(/\.exe$/i, "")).toLowerCase();

  const estiloCmd = /^(?:rmdir|rd|del|erase)$/i.test(verbo);
  // Bash: `rm -rf` agrupa letras. PowerShell: abreviaturas de `-Recurse`/`-Force`. Un comando anidado (`bash -c`,
  // `pwsh -Command`) no dice en qué intérprete corre y se mira con las dos reglas, igual que un `rm.exe` con ruta
  // o con `wsl`, que en PowerShell es el de GNU.
  const reglaGnu = /^(?:rm|rmdir)$/i.test(verbo) && (shell !== "PowerShell" || i > 0 || t[i].toLowerCase() !== verbo);
  const reglaPs = shell !== "Bash" || !reglaGnu;
  // Parámetros de PowerShell que llevan un valor aparte, que no es una ruta (`-ErrorAction SilentlyContinue`).
  const CON_VALOR = ["erroraction", "ea", "warningaction", "wa", "informationaction", "ia", "errorvariable", "ev", "outvariable", "ov", "filter", "include", "exclude", "stream", "credential"];
  let peligroso = false;
  const rutas = [];
  let sinOpciones = false;
  const resto = t.slice(i + 1);
  for (let k = 0; k < resto.length; k++) {
    const a = resto[k];
    // `} catch {}` / `finally`: lo que sigue ya no es argumento del borrado.
    if (/^(?:catch|finally)$/i.test(a)) break;
    // Redirecciones (`2>/dev/null`, `>nul`, `2>`): no son rutas; con el operador suelto, el destino va aparte.
    if (!sinOpciones && /^\d*[<>]/.test(a)) {
      if (/^\d*>{1,2}$|^\d*<$/.test(a)) k++;
      continue;
    }
    // Banderas de cmd, sueltas o pegadas: `/s`, `/s/q`, `/f/s/q` (y `//s` en Git Bash).
    const banderasCmd = estiloCmd && !sinOpciones && /^(?:\/{1,2}[a-z])+$/i.test(a);
    // Con `cmd /c rd …`, un `-ea` es una carpeta más: cmd no tiene parámetros con guion. `cmd /c rm -rf` o
    // `cmd /c powershell Remove-Item -Recurse` usan las reglas del programa que corre.
    if (sinOpciones || (viaCmd && estiloCmd) || (!/^-/.test(a) && !banderasCmd)) {
      if (banderasCmd) { if (/[sqf]/i.test(a.replace(/\//g, ""))) peligroso = true; continue; }
      // Una lista separada por comas (`Remove-Item a,b`) son varias rutas.
      rutas.push(...a.split(",").filter(Boolean));
      continue;
    }
    if (a === "--") { sinOpciones = true; continue; }
    if (banderasCmd) { if (/[sqf]/i.test(a.replace(/\//g, ""))) peligroso = true; continue; }
    if (a.startsWith("--")) {
      // Larga de GNU: abreviable (`--rec`, `--f`).
      const n = a.slice(2).split("=")[0].toLowerCase();
      if (n && ["recursive", "force"].some((l) => l.startsWith(n))) peligroso = true;
      continue;
    }
    const nombre = a.slice(1).split(":")[0];
    // `-Path:x` / `-LiteralPath:x` llevan la ruta pegada.
    const pegada = a.includes(":") ? a.slice(a.indexOf(":") + 1) : "";
    if (/^(?:path|literalpath)$/i.test(nombre) && pegada) { rutas.push(...pegada.split(",").filter(Boolean)); continue; }
    if (!/^[a-zA-Z]+$/.test(nombre)) continue;
    const n = nombre.toLowerCase();
    if ((reglaGnu && /[rRf]/.test(nombre)) || (reglaPs && ["recurse", "force"].some((l) => l.startsWith(n)))) peligroso = true;
    else if (reglaPs && !pegada && (CON_VALOR.includes(n) || (n.length >= 3 && CON_VALOR.some((p) => p.startsWith(n))))) k++;
  }
  // Un `Remove-Item` sin ninguna ruta recibe el listado por el pipe (`Get-ChildItem -Recurse | Remove-Item`): borra
  // de forma recursiva aunque no diga `-Recurse`.
  if (rutas.length === 0 && (/^(?:ri|remove-item)$/i.test(verbo) || shell === "PowerShell")) peligroso = true;
  if (!peligroso) return null;
  if (rutas.length > 0 && rutas.every((r) => esRutaDescartable(r, shell, sinVariables))) return null;
  return frenar(
    `\`${verbo}\` recursivo o forzado sobre ${rutas.length ? "una ruta que no es descartable" : "rutas que no se pueden conocer"} (solo se borra así ${RUTAS_DESCARTABLES.carpetas.join(", ")}, \`${RUTAS_DESCARTABLES.carpetaTemporalDelRepo}/\` del repo y los temporales del sistema)`,
  );
}

const NUBE = /^(?:aws|gcloud|gsutil|az|terraform|tofu|pulumi|kubectl|helm|flyctl|fly|vercel|netlify|wrangler|heroku|railway|supabase|doctl|ssh|scp|sftp|rsync)(?:\.exe|\.cmd)?\s/;

function revisarComandosProhibidos(seg, ramaActual) {
  // Se pelan los prefijos que no cambian lo que se ejecuta: `FOO=1 aws`, `env aws`, `npx vercel`, `pnpm dlx wrangler`.
  const plano = seg
    .replace(/^\s*(?:&\s*)?/, "")
    .replace(/^(?:(?:\$env:)?\w+=\S*\s+|env\s+|npx\s+(?:-\w+\s+)*|pnpm\s+(?:dlx|exec)\s+|npm\s+exec\s+(?:--\s+)?)+/i, "");
  for (const [re, que] of PROHIBIDOS_GH) if (re.test(plano)) return frenar(que);
  if (NUBE.test(`${plano} `)) return frenar("herramientas de nube, despliegue o acceso remoto (aws, gcloud, az, terraform, kubectl, vercel, supabase, ssh…)");
  if (/^docker\s+(?:push|login|logout)\b/.test(plano) || /^docker\s+(?:-H|--host|--context)\b/.test(plano) || /^docker\s+context\s+use\b/.test(plano)) {
    return frenar("Docker contra un registro o un host remoto");
  }
  if (/^(?:pnpm|npm|yarn)\s+publish\b/.test(plano)) return frenar("publicar paquetes");

  const tag = subcomandoGit(seg, "tag");
  if (tag && !esListadoDeTags(tag)) return frenar("`git tag` para crear o borrar un tag (los tags de versión los crea el titular; listar con `git tag -l` sí se puede)");
  const reset = subcomandoGit(seg, "reset");
  if (reset && reset.includes("--hard")) return frenar("`git reset --hard` descarta trabajo sin vuelta atrás");
  // [S8] `git clean` en todas sus formas: con `-n` solo lista, pero `clean.requireForce`, `-i` y los alias
  // hacen que «no forzado» no sea una garantía, y el repo no necesita limpiar el árbol con git.
  if (subcomandoGit(seg, "clean")) return frenar("`git clean` borra archivos sin vuelta atrás (en ninguna de sus formas)");
  // [S8] Las otras formas de borrar o pisar trabajo sin commitear con git, que el allow de `git` dejaría pasar.
  const quitar = subcomandoGit(seg, "rm");
  if (quitar && opcionProhibida(quitar, ["force"], "f")) return frenar("`git rm -f/--force` borra archivos con cambios sin commitear");
  const indice = subcomandoGit(seg, "checkout-index");
  if (indice && opcionProhibida(indice, ["force", "all"], "fa")) return frenar("`git checkout-index -f/-a` pisa los archivos con los del índice y pierde los cambios sin commitear");
  const aplicar = subcomandoGit(seg, "apply");
  // `-3R` es `--3way` + `-R`: las cortas de apply pueden llevar dígitos, y `opcionProhibida` no los acepta.
  if (aplicar && (opcionProhibida(aplicar, ["reverse"]) || aplicar.some((x) => /^-[A-Za-z0-9]*R/.test(x)))) return frenar("`git apply -R/--reverse` deshace cambios en el árbol de trabajo");
  const merge = subcomandoGit(seg, "merge");
  if (merge && RAMAS_PROTEGIDAS.test(ramaActual())) return frenar("`git merge` sobre `main` o `master`");
  // [F7] Con checkout, switch, branch y commit permitidos sin preguntar: descartar TODO el trabajo sin
  // commitear (como `git reset --hard`), borrar o mover `main`, y saltear los hooks de git. Volver a una
  // rama o restaurar un archivo puntual (`git checkout -- archivo`) sigue libre.
  for (const sub of ["checkout", "switch"]) {
    const a = subcomandoGit(seg, sub);
    if (!a) continue;
    if (opcionProhibida(a, ["force", "discard-changes"], "f")) return frenar(`\`git ${sub}\` forzado descarta el trabajo sin commitear`);
    if (a.some((x) => x === "." || x === ":/" || x === "*" || x === "./")) return frenar(`\`git ${sub} .\` descarta todo el trabajo sin commitear`);
    // [S2] `git checkout -- <ruta>` (y `git checkout <rev> -- <ruta>`): lo que va después de `--` son rutas y se
    // pisan con la versión del índice o del commit, perdiendo los cambios sin commitear. Cambiar de rama no lleva `--`.
    if (sub === "checkout" && a.includes("--")) return frenar("`git checkout -- <ruta>` descarta los cambios sin commitear de esos archivos");
    if (sub === "checkout") {
      if (a.some((x) => x.startsWith("--pathspec-from-file"))) return frenar("`git checkout --pathspec-from-file` descarta los cambios sin commitear de los archivos de la lista");
      // Sin `--`: cambiar de rama lleva UN argumento (`git checkout feat/x`); con dos (`git checkout HEAD a.ts`,
      // `git checkout main a.ts`) el segundo es una ruta y se pisa. El valor de `-b/-B/--orphan` no cuenta.
      let posicionales = 0;
      for (let k = 0; k < a.length; k++) {
        if (/^(?:-[bB]|--orphan)$/.test(a[k])) k++;
        else if (!a[k].startsWith("-")) posicionales++;
      }
      if (posicionales > 1) return frenar("`git checkout <rev> <ruta>` descarta los cambios sin commitear de esa ruta (cambiar de rama lleva un solo argumento)");
    }
    // `checkout -B main` / `switch -C main` reapuntan `main` como `git branch -f main` (code-reviewer, m3).
    if (a.some((x) => x === "-B" || x === "-C" || (x.startsWith("--") && "force-create".startsWith(x.slice(2)) && x.length > 4)) && a.some((x) => RAMAS_PROTEGIDAS.test(x))) {
      return frenar(`\`git ${sub}\` que reapunta \`main\` o \`master\``);
    }
  }
  // [S2] `git restore <ruta>` descarta los cambios sin commitear igual que `git checkout -- <ruta>`. Solo se deja
  // pasar `--staged` (sacar del índice, no toca el archivo); con `--worktree`/`-W` o sin `--staged` pisa el archivo.
  const restaurar = subcomandoGit(seg, "restore");
  if (restaurar) {
    const soloIndice = restaurar.some((x) => x === "-S" || (x.startsWith("--") && x.length > 3 && "--staged".startsWith(x)));
    const tocaArchivo = restaurar.some((x) => x === "-W" || (x.startsWith("--w") && "--worktree".startsWith(x)));
    if (!soloIndice || tocaArchivo) return frenar("`git restore` descarta los cambios sin commitear (con `--staged` solo se saca del índice y sí se puede)");
  }
  const rama = subcomandoGit(seg, "branch");
  if (rama && opcionProhibida(rama, ["delete", "force", "move", "copy"], "dDfmMcC")) {
    const nombres = rama.filter((x) => !x.startsWith("-"));
    // Con un solo nombre, `-m` renombra la rama actual: si es `main`, la mueve.
    const renombra = opcionProhibida(rama, ["move"], "mM") !== null;
    const tocaMain = nombres.some((x) => RAMAS_PROTEGIDAS.test(x)) || (renombra && nombres.length <= 1 && RAMAS_PROTEGIDAS.test(ramaActual()));
    if (tocaMain) return frenar("`git branch` que borra, fuerza o mueve `main` o `master`");
  }
  const commit = subcomandoGit(seg, "commit");
  if (commit && opcionProhibida(commit, ["no-verify"], "n")) return frenar("`--no-verify` saltea los hooks de git");
  // Red para M3: con commit y push sin preguntar, un commit hecho en `main` es el primer paso para subirlo.
  if (commit && RAMAS_PROTEGIDAS.test(ramaActual())) return frenar(`\`git commit\` estando en la rama \`${ramaActual()}\` (se trabaja en una rama \`feat/…\` o \`chore/…\`)`);
  const add = subcomandoGit(seg, "add");
  if (add && opcionProhibida(add, ["force"], "f")) return frenar("`git add -f` agrega archivos que `.gitignore` deja afuera (secretos, datos reales, `_referencias/`)");
  const fetch = subcomandoGit(seg, "fetch");
  if (fetch && opcionProhibida(fetch, ["upload-pack"])) return frenar("`git fetch --upload-pack` ejecuta un programa local (security-engineer, M4)");
  return null;
}

// ── [F7] Interruptor de modo (`.claude/modo.json`) ───────────────────────────────────────────────────
//
// `autonomo`: commit, push y PR salen sin preguntar (los permite `permissions.allow`). `supervisado`: el
// hook pide aprobación (`ask`) para esos cuatro aunque estén permitidos, como antes de F7. Si el archivo
// falta, no se lee o no dice `autonomo`, cuenta como `supervisado`: falla hacia lo seguro. Los frenos de
// siempre frenan en los dos modos (se evalúan antes).

const RUTA_DEL_MODO = new URL("../modo.json", import.meta.url);

/** El modo del repo. Cualquier cosa que no sea exactamente `{"modo": "autonomo"}` es `supervisado`. */
export function leerModo(leer = () => readFileSync(RUTA_DEL_MODO, "utf8")) {
  try {
    const datos = JSON.parse(String(leer()).replace(/^﻿/, ""));
    return datos && datos.modo === "autonomo" ? "autonomo" : "supervisado";
  } catch {
    return "supervisado";
  }
}

/** ¿El comando hace commit, push o crea o edita un PR? Son los que en `supervisado` piden aprobación. */
function necesitaAprobacionSupervisada(comando) {
  for (const seg of segmentos(comando)) {
    if (subcomandoGit(seg, "commit") !== null || subcomandoGit(seg, "push") !== null) return true;
    if (/(?:^|\s)gh\s+pr\s+(?:create|edit)\b/.test(seg)) return true;
  }
  return false;
}

// ── 3.c Marca de IA en commits y PRs ─────────────────────────────────────────────────────────────────

const MARCA_IA = /co-authored-by|generated\s+with|noreply@anthropic\.com/i;

function revisarMensajes(comando, leerArchivo) {
  const esCommit = segmentos(comando).some((s) => subcomandoGit(s, "commit") !== null);
  const esPr = /\bgh\s+pr\s+(?:create|edit|comment)\b/.test(comando);
  if (!esCommit && !esPr) return null;
  let texto = comando;
  // `git commit -F archivo` / `gh pr create --body-file archivo`: el mensaje vive en el archivo.
  for (const m of comando.matchAll(/(?:-F|--file|--body-file)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
    const ruta = m[1] ?? m[2] ?? m[3];
    if (ruta && ruta !== "-") texto += `\n${leerArchivo(ruta)}`;
  }
  if (MARCA_IA.test(texto)) {
    return frenar(`el ${esCommit ? "commit" : "PR"} lleva una marca de IA («Co-Authored-By» o «Generated with»); los commits y los PR salen sin marca`);
  }
  return null;
}

// ── 3.d Herramientas MCP de correo, calendario, Drive, pagos y bancos ────────────────────────────────

const MCP_PROHIBIDO =
  /mail|outlook|calendar|drive|sheets|slack|hubspot|zoho|stripe|paypal|square|airwallex|ramp|expensify|quickbooks|myob|gusto|zoho[-_]?books|plaid|mercado[-_]?pago|bank|banco|payment|pagos?(?:_|$)/i;

function revisarMcp(nombre) {
  if (!nombre.startsWith("mcp__") || !MCP_PROHIBIDO.test(nombre)) return null;
  return frenar(`la herramienta \`${nombre}\` toca correo, calendario, Drive, pagos o bancos (datos y acciones fuera del repo)`);
}

// ── Los frenos se protegen a sí mismos ───────────────────────────────────────────────────────────────
//
// Las herramientas Edit/Write sobre estos archivos NO se bloquean acá: piden aprobación por
// `permissions.ask` en `.claude/settings.json`, y la da el titular. Este hook cubre el otro camino: que
// se los reescriba desde Bash/PowerShell (redirecciones, tee, sed -i, cp, mv, rm, Set-Content, node -e con
// writeFile, git checkout/restore…). Leerlos, listarlos, stagearlos y correr sus tests sí se puede.

// [F7] `.claude/modo.json` (el interruptor de autonomía) también: cambiarlo pasa por el titular.
// También el nombre suelto `modo.json` (`cd .claude && echo … > modo.json`, security-engineer m2).
const RUTA_DE_LOS_FRENOS = "(?:\\.claude/settings[\\w.-]*\\.json|(?:\\.claude/)?modo\\.json|\\.claude/hooks|tools/frenos)";
const MENCIONA_LOS_FRENOS = new RegExp(`(?:^|[\\s"'=:(,/<>])${RUTA_DE_LOS_FRENOS}(?:/|(?=$|[\\s"';|&)*]))`);
const REDIRIGE_A_LOS_FRENOS = new RegExp(`(?<![\\d&<-])>>?\\s*["']?[^\\s"'|;&]*${RUTA_DE_LOS_FRENOS}`);
const VERBO_DE_ESCRITURA =
  /(?:^|[\s;|&(])(?:tee|cp|mv|rm|rmdir|del|erase|truncate|dd|install|ln|chmod|chown|touch|patch|sc|set-content|add-content|out-file|clear-content|remove-item|copy-item|move-item|new-item|rename-item|set-itemproperty)(?=\s|$)|\b(?:sed|perl)\s+(?:-\S+\s+)*-[a-z]*i|\bawk\s+(?:-\S+\s+)*-i\s*inplace|write_text|write_bytes|shutil\.|\bgit\s+(?:-\S+\s+)*(?:checkout|restore|stash|reset|apply|am|clean)\b|writefile|appendfile|writesync|rmsync|unlinksync|renamesync|copyfile|\.write\(|open\([^)]*['"][wa]/;

function escribeEnLosFrenos(comando) {
  const t = normalizar(comando);
  if (!MENCIONA_LOS_FRENOS.test(t)) return null;
  if (!REDIRIGE_A_LOS_FRENOS.test(t) && !VERBO_DE_ESCRITURA.test(t)) return null;
  return frenar("el comando escribe en `.claude/settings*.json`, `.claude/modo.json`, `.claude/hooks/` o `tools/frenos/` (los frenos solo los cambia el titular, con un PR; las herramientas Edit y Write piden su aprobación)");
}

/** Comandos que viajan como texto dentro de otro: `sh -c "…"`, `-Command '…'` y `$(…)`. */
function comandosAnidados(comando) {
  const salida = [];
  for (const m of comando.matchAll(/\s(?:-|\/{1,2})(?:c|command)\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')/gi)) salida.push(m[1] ?? m[2]);
  // [S8] Y las comillas invertidas de Bash (`` `rm -rf src` ``).
  // Entre comillas simples Bash no ejecuta nada (`grep '`git clean`' x.md` solo busca texto).
  // Pero dentro de comillas dobles sí (`echo "'" `rm -rf src` "'"` ejecuta el `rm`): se vacían solo los tramos
  // de comillas simples que no están dentro de unas dobles.
  for (const m of comando.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, (x) => (x[0] === "'" ? "''" : x)).matchAll(/`([^`]+)`/g)) salida.push(m[1]);
  for (const m of comando.matchAll(/\$\(([^()]*)\)/g)) salida.push(m[1]);
  // [F7] Y el cuerpo de un heredoc o de una here-string que recibe un intérprete.
  salida.push(...cuerposEjecutados(comando));
  return salida.filter(Boolean);
}

// ── Entrada principal ────────────────────────────────────────────────────────────────────────────────

const HERRAMIENTAS_DE_ARCHIVO = { Read: ["file_path"], Edit: ["file_path"], Write: ["file_path"], MultiEdit: ["file_path"], NotebookEdit: ["notebook_path"], Grep: ["path", "glob"], Glob: ["path"] };

/**
 * @param {{ tool_name?: string, tool_input?: Record<string, unknown>, cwd?: string }} entrada JSON de un hook PreToolUse
 * @param {{ ramaActual?: () => string, leerArchivo?: (ruta: string) => string, modo?: "autonomo" | "supervisado" }} [deps] inyectables para los tests
 * @returns {{ bloquear: false, preguntar?: string } | { bloquear: true, motivo: string }}
 */
export function evaluar(entrada, deps = {}) {
  const nombre = String(entrada?.tool_name ?? "");
  const input = entrada?.tool_input ?? {};
  let rama;
  const ramaActual = deps.ramaActual ?? (() => (rama ??= ramaPorDefecto(entrada?.cwd)));
  const leerArchivo = deps.leerArchivo ?? (() => "");

  const mcp = revisarMcp(nombre);
  if (mcp) return mcp;

  const camposArchivo = HERRAMIENTAS_DE_ARCHIVO[nombre];
  if (camposArchivo) {
    for (const campo of camposArchivo) {
      const sensible = mencionaRutaSensible(input[campo]);
      if (sensible) return frenar(`\`${nombre}\` sobre ${sensible}: secretos y datos reales no los abre el asistente`);
    }
    return { bloquear: false };
  }

  if ((nombre === "Bash" || nombre === "PowerShell") && (deps.profundidad ?? 0) < 3) {
    const comando = String(input.command ?? "");
    // En un commit o un PR el mensaje es texto, no una ruta: «docs: nada de secretos en .env» no es leer .env.
    const miraRutas = /\bgit\b[^;&|\n]*\bcommit\b|\bgh\s+pr\s+(?:create|edit|comment)\b/.test(comando) ? sinMensajes(comando) : comando;
    const sensible = mencionaRutaSensible(miraRutas);
    if (sensible) return frenar(`el comando menciona ${sensible}: secretos y datos reales no los abre el asistente, con ninguna herramienta`);

    const frenos = escribeEnLosFrenos(miraRutas);
    if (frenos) return frenos;

    const marca = revisarMensajes(comando, leerArchivo);
    if (marca) return marca;

    // Lo que va dentro de `bash -c "…"`, `pwsh -Command '…'` o `$(…)` también es un comando.
    for (const anidado of comandosAnidados(miraRutas)) {
      const r = evaluar({ ...entrada, tool_name: "Bash", tool_input: { command: anidado } }, { ...deps, ramaActual, shell: "ambos", profundidad: (deps.profundidad ?? 0) + 1 });
      if (r.bloquear) return r;
    }

    // [F7] Sobre el comando sin los mensajes: un commit cuyo texto describe `git checkout .` o
    // `git push origin main` no es ejecutarlos (code-reviewer, m1).
    for (const seg of segmentos(sinMensajes(comando))) {
      const push = subcomandoGit(seg, "push");
      if (push) {
        const r = revisarPush(push, ramaActual, comando);
        if (r) return r;
      }
      const otro = revisarComandosProhibidos(seg, ramaActual);
      if (otro) return otro;
    }
    // [S8] Borrado recursivo o forzado, con su propia segmentación (ver `segmentosDeBorrado`).
    const sinMsj = sinMensajes(comando);
    const sinVariables = reasignaTemporales(sinMsj);
    for (const seg of segmentosDeBorrado(sinMsj)) {
      const borrado = revisarBorrado(seg, deps.shell ?? nombre, sinVariables);
      if (borrado) return borrado;
    }

    // [F7] Pasó todos los frenos. En `supervisado`, commit, push y PR vuelven a pedir aprobación.
    // También lo que viaja dentro de `bash -c "…"`, `-Command '…'` o `$(…)`: si no, se escaparía por ahí.
    if ((deps.profundidad ?? 0) === 0 && [sinMensajes(comando), ...comandosAnidados(comando)].some(necesitaAprobacionSupervisada)) {
      const modo = deps.modo ?? leerModo();
      if (modo !== "autonomo") {
        return {
          bloquear: false,
          preguntar: "Modo supervisado (.claude/modo.json): commit, push y PR los aprueba el titular.",
        };
      }
    }
  }
  return { bloquear: false };
}
