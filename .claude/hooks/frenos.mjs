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

/** Quita lo que es solo texto de un commit o de un PR: los mensajes entre comillas y los heredoc. */
function sinMensajes(comando) {
  return comando
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2(?=\s|$|\))/g, "<<HEREDOC")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'[^']*'/g, "''");
}

// ── Segmentación del comando ─────────────────────────────────────────────────────────────────────────

/** Parte una línea de comando en sus comandos simples (`;`, `&&`, `||`, `|`, saltos de línea). */
function segmentos(comando) {
  return comando
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tokens de un comando simple, sin comillas. Alcanza para mirar banderas y refspecs de git. */
function tokens(segmento) {
  return (segmento.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
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

function revisarPush(args, ramaActual, comandoCompleto) {
  for (const a of args) {
    if (a === "--force" || a === "-f" || a.startsWith("--force-with-lease") || a === "--force-if-includes" || /^-[a-z]*f[a-z]*$/.test(a)) {
      return frenar("`git push` forzado (--force, -f, --force-with-lease)");
    }
    if (a.startsWith("+")) return frenar("`git push` forzado (refspec con `+`)");
    if (a === "--mirror") return frenar("`git push --mirror` pisa el remoto");
    // Borrar en el remoto (rama o tag): un tag por nombre es indistinguible de una rama, así que se frena todo `--delete`.
    if (a === "--delete" || a === "-d") return frenar("`git push --delete` (borrar ramas o tags remotos lo hace el titular)");
    if (a === "--tags" || a === "--follow-tags" || a === "tag" || /(?:^|:)refs\/tags\//.test(a)) return frenar("`git push` de tags (los tags de versión los sube el titular)");
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
  return null;
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

const RUTA_DE_LOS_FRENOS = "(?:\\.claude/settings[\\w.-]*\\.json|\\.claude/hooks|tools/frenos)";
const MENCIONA_LOS_FRENOS = new RegExp(`(?:^|[\\s"'=:(,/<>])${RUTA_DE_LOS_FRENOS}(?:/|(?=$|[\\s"';|&)*]))`);
const REDIRIGE_A_LOS_FRENOS = new RegExp(`(?<![\\d&<-])>>?\\s*["']?[^\\s"'|;&]*${RUTA_DE_LOS_FRENOS}`);
const VERBO_DE_ESCRITURA =
  /(?:^|[\s;|&(])(?:tee|cp|mv|rm|rmdir|del|erase|truncate|dd|install|ln|chmod|chown|touch|patch|sc|set-content|add-content|out-file|clear-content|remove-item|copy-item|move-item|new-item|rename-item|set-itemproperty)(?=\s|$)|\b(?:sed|perl)\s+(?:-\S+\s+)*-[a-z]*i|\bawk\s+(?:-\S+\s+)*-i\s*inplace|write_text|write_bytes|shutil\.|\bgit\s+(?:-\S+\s+)*(?:checkout|restore|stash|reset|apply|am|clean)\b|writefile|appendfile|writesync|rmsync|unlinksync|renamesync|copyfile|\.write\(|open\([^)]*['"][wa]/;

function escribeEnLosFrenos(comando) {
  const t = normalizar(comando);
  if (!MENCIONA_LOS_FRENOS.test(t)) return null;
  if (!REDIRIGE_A_LOS_FRENOS.test(t) && !VERBO_DE_ESCRITURA.test(t)) return null;
  return frenar("el comando escribe en `.claude/settings*.json`, `.claude/hooks/` o `tools/frenos/` (los frenos solo los cambia el titular, con un PR; las herramientas Edit y Write piden su aprobación)");
}

/** Comandos que viajan como texto dentro de otro: `sh -c "…"`, `-Command '…'` y `$(…)`. */
function comandosAnidados(comando) {
  const salida = [];
  for (const m of comando.matchAll(/\s-(?:c|command)\s+(?:"((?:\\.|[^"\\])*)"|'([^']*)')/gi)) salida.push(m[1] ?? m[2]);
  for (const m of comando.matchAll(/\$\(([^()]*)\)/g)) salida.push(m[1]);
  return salida.filter(Boolean);
}

// ── Entrada principal ────────────────────────────────────────────────────────────────────────────────

const HERRAMIENTAS_DE_ARCHIVO = { Read: ["file_path"], Edit: ["file_path"], Write: ["file_path"], MultiEdit: ["file_path"], NotebookEdit: ["notebook_path"], Grep: ["path", "glob"], Glob: ["path"] };

/**
 * @param {{ tool_name?: string, tool_input?: Record<string, unknown>, cwd?: string }} entrada JSON de un hook PreToolUse
 * @param {{ ramaActual?: () => string, leerArchivo?: (ruta: string) => string }} [deps] inyectables para los tests
 * @returns {{ bloquear: false } | { bloquear: true, motivo: string }}
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

    for (const seg of segmentos(comando)) {
      const push = subcomandoGit(seg, "push");
      if (push) {
        const r = revisarPush(push, ramaActual, comando);
        if (r) return r;
      }
      const otro = revisarComandosProhibidos(seg, ramaActual);
      if (otro) return otro;
    }
  }
  return { bloquear: false };
}
