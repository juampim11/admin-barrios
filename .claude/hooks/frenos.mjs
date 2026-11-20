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
import { readFileSync } from "node:fs";

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
 * Parte una línea de comando en sus comandos simples: `;`, `&&`, `||`, `|`, saltos de línea y [F7] también
 * `&` suelto (segundo plano), paréntesis y llaves. Sin eso, `git status & git push origin main` escondía
 * el segundo comando (security-engineer, M2).
 */
function segmentos(comando) {
  return comando
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
  return (segmento.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/["'\\`]/g, ""));
}

/** ¿El comando simple es `git [opciones] <sub> ...`? Devuelve los tokens tras el subcomando. */
function subcomandoGit(segmento, sub) {
  const t = tokens(segmento);
  const i = t.findIndex((x) => /^(?:.*[\\/])?git(?:\.exe)?$/i.test(x));
  if (i === -1) return null;
  // Opciones globales de git con valor: -C <dir>, -c <k=v>, --git-dir=…
  let j = i + 1;
  while (j < t.length && t[j].startsWith("-")) j += /^-[Cc]$/.test(t[j]) ? 2 : 1;
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
  const limpiar = subcomandoGit(seg, "clean");
  if (limpiar && limpiar.some((a) => /^-[a-z]*f/.test(a) || a === "--force")) return frenar("`git clean -f` borra archivos sin vuelta atrás");
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
  for (const m of comando.matchAll(/\s-(?:c|command)\s+(?:"((?:\\.|[^"\\])*)"|'([^']*)')/gi)) salida.push(m[1] ?? m[2]);
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
      const r = evaluar({ ...entrada, tool_name: "Bash", tool_input: { command: anidado } }, { ...deps, ramaActual, profundidad: (deps.profundidad ?? 0) + 1 });
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
