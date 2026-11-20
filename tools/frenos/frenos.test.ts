// Tests del hook de frenos (`.claude/hooks/frenos.mjs`). Se le pasa lo mismo que recibe Claude Code:
// el JSON de entrada de un hook PreToolUse. Sin red, sin base, sin Claude. Corren en el gate barato.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — es JavaScript puro (el hook no tiene dependencias ni paso de compilación).
import { evaluar, leerModo, mencionaRutaSensible } from "../../.claude/hooks/frenos.mjs";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type Resultado = { bloquear: boolean; motivo?: string };
const bash = (command: string, rama = "feat/algo"): Resultado =>
  evaluar({ tool_name: "Bash", tool_input: { command } }, { ramaActual: () => rama });
const powershell = (command: string, rama = "feat/algo"): Resultado =>
  evaluar({ tool_name: "PowerShell", tool_input: { command } }, { ramaActual: () => rama });

function esBloqueo(r: Resultado) {
  expect(r.bloquear).toBe(true);
  expect(r.motivo).toMatch(/^Frenado por regla del proyecto: .+; pedíselo al titular\.$/);
}

describe("3.a rutas sensibles (secretos y datos reales)", () => {
  it("bloquea leer un .env con las herramientas de archivo", () => {
    for (const herramienta of ["Read", "Edit", "Write"]) {
      esBloqueo(evaluar({ tool_name: herramienta, tool_input: { file_path: "C:\\Proyectos_Desa\\admin-barrios\\tmp\\.env.prueba" } }));
    }
    esBloqueo(evaluar({ tool_name: "Read", tool_input: { file_path: "/repo/apps/web/.env.local" } }));
  });

  it("bloquea las carpetas de datos y secretos, con barras de Windows o de Unix", () => {
    esBloqueo(evaluar({ tool_name: "Read", tool_input: { file_path: "C:\\x\\privado\\cuentas.csv" } }));
    esBloqueo(evaluar({ tool_name: "Read", tool_input: { file_path: "/x/_secretos/clave.txt" } }));
    esBloqueo(evaluar({ tool_name: "Read", tool_input: { file_path: "/x/_referencias/datos/informes.json" } }));
    esBloqueo(evaluar({ tool_name: "Grep", tool_input: { pattern: "x", path: "/x/_privado" } }));
  });

  it("bloquea Bash y PowerShell que mencionan la ruta, con cualquier herramienta", () => {
    esBloqueo(bash("cat tmp/.env.prueba"));
    esBloqueo(bash("grep -rn CLAVE _secretos"));
    esBloqueo(bash("sed -n 1,5p apps/web/.env.local"));
    esBloqueo(bash("python -c \"print(open('.env').read())\""));
    esBloqueo(bash("cp .env /tmp/copia"));
    esBloqueo(bash("ls ../datos/"));
    esBloqueo(powershell("Get-Content .\\apps\\web\\.env.local"));
    esBloqueo(powershell("type C:\\x\\privado\\cuentas.csv"));
    esBloqueo(powershell("Copy-Item _secretos\\clave.txt $env:TEMP"));
  });

  it("deja pasar lo que se parece pero no es secreto", () => {
    expect(evaluar({ tool_name: "Read", tool_input: { file_path: "/repo/.env.example" } }).bloquear).toBe(false);
    expect(evaluar({ tool_name: "Read", tool_input: { file_path: "/repo/packages/data/src/dominio.ts" } }).bloquear).toBe(false);
    expect(bash("cat .env.example").bloquear).toBe(false);
    expect(bash("node -e \"console.log(process.env.NODE_ENV)\"").bloquear).toBe(false);
    expect(bash("git add apps/web/src/app/environment.ts").bloquear).toBe(false);
    expect(bash("grep -rn datos packages/data/src").bloquear).toBe(false);
    expect(mencionaRutaSensible("los datos del barrio")).toBeNull();
  });

  it("un mensaje de commit que habla de .env o de datos/ no es leer esos archivos", () => {
    expect(bash('git commit -m "docs: secretos solo en .env, nunca en datos/ ni privado/"').bloquear).toBe(false);
    // …pero el resto del comando sí cuenta: encadenar la lectura después del commit se frena.
    esBloqueo(bash('git commit -m "x" && cat .env'));
  });
});

describe("3.b git push", () => {
  it("bloquea el push estando en main o master", () => {
    esBloqueo(bash("git push", "main"));
    esBloqueo(bash("git push origin feat/algo", "master"));
    esBloqueo(bash("git push --dry-run", "main"));
  });

  it("bloquea el push de una rama a main, aunque se esté parado en otra", () => {
    esBloqueo(bash("git push origin main"));
    esBloqueo(bash("git push origin HEAD:main"));
    esBloqueo(bash("git -C ../otro push origin refs/heads/master"));
    esBloqueo(bash("git checkout main && git push"));
  });

  it("bloquea todo push forzado", () => {
    esBloqueo(bash("git push --force origin feat/algo"));
    esBloqueo(bash("git push -f origin feat/algo"));
    esBloqueo(bash("git push --force-with-lease origin feat/algo"));
    esBloqueo(bash("git push origin +feat/algo"));
    esBloqueo(powershell("git push --force; echo listo"));
  });

  it("deja pasar el push de una rama de trabajo", () => {
    expect(bash("git push -u origin chore/frenos-por-mecanismo").bloquear).toBe(false);
    expect(bash("git push origin HEAD").bloquear).toBe(false);
    expect(bash("git status && git log --oneline -3", "main").bloquear).toBe(false);
  });
});

describe("3.c marca de IA en commits y PR", () => {
  const marca = ["Co-Authored-By: Claude <noreply@anthropic.com>", "🤖 Generated with [Claude Code]"];

  it("bloquea un commit con la atribución o la leyenda de generado", () => {
    for (const texto of marca) {
      esBloqueo(bash(`git commit -m "feat: algo\n\n${texto}"`));
      esBloqueo(powershell(`git commit -m "fix: algo" -m "${texto}"`));
    }
    esBloqueo(bash("git commit -m \"$(cat <<'EOF'\nfeat: algo\n\nco-authored-by: alguien\nEOF\n)\""));
  });

  it("bloquea un PR con la marca en el cuerpo", () => {
    esBloqueo(bash('gh pr create --title "chore: x" --body "Generated with Claude Code"'));
  });

  it("lee el mensaje de un archivo (-F) y también lo bloquea", () => {
    const r = evaluar(
      { tool_name: "Bash", tool_input: { command: "git commit -F msg.txt" } },
      { ramaActual: () => "feat/x", leerArchivo: () => "feat: x\n\nCo-Authored-By: Alguien" },
    );
    esBloqueo(r);
  });

  it("deja pasar un commit y un PR sin marca", () => {
    expect(bash('git commit -m "feat: la cuota fija en la boleta"').bloquear).toBe(false);
    expect(bash("git commit -m \"$(cat <<'EOF'\nfix: algo\n\nSin marca.\nEOF\n)\"").bloquear).toBe(false);
    expect(bash('gh pr create --title "chore: x" --body "Resumen del cambio"').bloquear).toBe(false);
    // Hablar de la marca fuera de un commit (por ejemplo, leer docs) no se frena.
    expect(bash('echo "Co-Authored-By"').bloquear).toBe(false);
  });
});

describe("3.d herramientas MCP de correo, calendario, Drive, pagos y bancos", () => {
  it("bloquea las que tocan datos y plata fuera del repo", () => {
    for (const nombre of [
      "mcp__plugin_small-business_gmail__create_draft",
      "mcp__plugin_small-business_google-calendar__create_event",
      "mcp__plugin_small-business_google-drive__search_files",
      "mcp__plugin_small-business_stripe__authenticate",
      "mcp__plugin_small-business_paypal__authenticate",
      "mcp__plugin_small-business_airwallex__authenticate",
    ]) {
      esBloqueo(evaluar({ tool_name: nombre, tool_input: {} }));
    }
  });

  it("deja pasar las demás herramientas, MCP o no", () => {
    for (const nombre of ["mcp__claude-in-chrome__navigate", "mcp__claude_ai_Claude_Docs__read", "mcp__ide__getDiagnostics", "Read", "Bash"]) {
      expect(evaluar({ tool_name: nombre, tool_input: {} }).bloquear).toBe(false);
    }
  });
});

describe("comandos que el repo no necesita (espejo de permissions.deny)", () => {
  it("bloquea merge de PR, tags, reset duro, nube y despliegue", () => {
    for (const c of ["gh pr merge 57 --squash", "gh release create v1", "gh secret set X", "gh auth login", "git tag v1.0.0", "git reset --hard HEAD~1", "git clean -fd", "aws s3 ls", "kubectl get pods", "ssh host", "docker push imagen", "pnpm publish"]) {
      esBloqueo(bash(c));
    }
    esBloqueo(bash("git merge feat/x", "main"));
  });

  it("mira dentro de bash -c, pwsh -Command y $(…), y detrás de prefijos", () => {
    esBloqueo(bash('bash -c "git push origin main"'));
    esBloqueo(bash("sh -c 'gh pr merge 5'"));
    esBloqueo(powershell("pwsh -Command 'git push --force'"));
    esBloqueo(bash("echo $(git push -f)"));
    esBloqueo(bash('bash -c "cat tmp/.env.prueba"'));
    esBloqueo(bash("AWS_PROFILE=prod aws s3 ls"));
    esBloqueo(bash("npx vercel --prod"));
    esBloqueo(bash("pnpm dlx wrangler deploy"));
    esBloqueo(bash("env kubectl get pods"));
  });

  it("deja pasar la base local y el trabajo normal (db:*, tests, typecheck)", () => {
    for (const c of ["pnpm db:up", "pnpm db:setup", "pnpm db:seed", "pnpm db:migrate", "pnpm db:reset", "pnpm test", "pnpm typecheck", "docker compose up -d postgres", "docker ps", "git tag -l", "git merge main", "gh pr create --title x --body y", "gh pr checks"]) {
      expect(bash(c).bloquear, c).toBe(false);
    }
  });
});

describe("tags: se puede listar, no crear, borrar ni subir", () => {
  it("deja pasar los listados", () => {
    for (const c of ["git tag", "git tag -l", "git tag --list", "git tag -l 'v*'", "git tag --list 'v1.*'", "git tag -n5", "git tag --contains HEAD", "git tag --sort=-creatordate -l"]) {
      expect(bash(c).bloquear, c).toBe(false);
    }
  });

  it("bloquea crear y borrar", () => {
    for (const c of ["git tag v1.0.0", "git tag -a v1.0.0 -m 'x'", "git tag -d v1.0.0", "git tag --delete v1.0.0", "git tag -f v1.0.0", "git tag -s v1", "git tag v1 abc123"]) {
      esBloqueo(bash(c));
    }
  });

  it("bloquea borrar en el remoto (una rama o un tag, que por nombre no se distinguen)", () => {
    for (const c of ["git push --delete origin v1", "git push origin -d feat/vieja", "git push origin --delete feat/vieja"]) esBloqueo(bash(c));
  });

  it("bloquea subir tags", () => {
    for (const c of ["git push --tags", "git push origin --follow-tags", "git push origin tag v1.0.0", "git push origin refs/tags/v1.0.0", "git push origin HEAD:refs/tags/v1"]) {
      esBloqueo(bash(c));
    }
  });
});

describe("los frenos se protegen a sí mismos (escrituras por Bash y PowerShell)", () => {
  it("bloquea reescribirlos con cualquier verbo de escritura", () => {
    for (const c of [
      "echo {} > .claude/settings.json",
      "echo x >> .claude/hooks/frenos.mjs",
      "sed -i 's/a/b/' tools/frenos/frenos.test.ts",
      "cp /tmp/x .claude/settings.json",
      "mv tools/frenos/frenos.test.ts /tmp",
      "rm -rf .claude/hooks",
      "tee .claude/settings.local.json",
      "git checkout -- .claude/hooks/frenos.mjs",
      "git restore tools/frenos",
      "node -e \"require('fs').writeFileSync('.claude/hooks/frenos.mjs','')\"",
      "echo x>.claude/settings.json",
      "echo x>>tools/frenos/frenos.test.ts",
      "perl -pi -e 's/a/b/' .claude/hooks/frenos.mjs",
      "awk -i inplace '1' .claude/settings.json",
      "python -c \"import pathlib; pathlib.Path('.claude/settings.json').write_text('{}')\"",
      'bash -c "echo x > .claude/hooks/pre-tool-use.mjs"',
    ]) {
      esBloqueo(bash(c));
    }
    for (const c of [
      "Set-Content .claude\\settings.json '{}'",
      "Remove-Item -Recurse .claude\\hooks",
      "Out-File -FilePath tools\\frenos\\frenos.test.ts",
      "Copy-Item x.json .claude\\settings.json",
      "'{}' > .claude\\settings.json",
      "(gc x.json) -replace 'a','b' | sc .claude\\settings.json",
    ]) {
      esBloqueo(powershell(c));
    }
  });

  it("deja leerlos, stagearlos, commitearlos y correr sus tests", () => {
    for (const c of [
      "cat .claude/settings.json",
      "git diff -- .claude/hooks/frenos.mjs",
      "git add .claude/settings.json .claude/hooks tools/frenos",
      "pnpm exec vitest run --project unit tools/frenos",
      "node .claude/hooks/pre-tool-use.mjs < entrada.json",
      "git log --oneline -3 -- tools/frenos",
      'git commit -m "chore: rm de .claude/hooks y tools/frenos en el mensaje"',
      "ls .claude/hooks",
    ]) {
      expect(bash(c).bloquear, c).toBe(false);
    }
    expect(powershell("Get-Content .claude\\settings.json").bloquear).toBe(false);
  });
});

describe("el ejecutable (stdin → código de salida), como lo corre Claude Code", () => {
  const correr = (entrada: unknown) =>
    spawnSync(process.execPath, [resolve(raiz, ".claude/hooks/pre-tool-use.mjs")], {
      input: JSON.stringify(entrada),
      encoding: "utf8",
      cwd: raiz,
    });

  it("sale con 2 y el motivo en castellano por stderr cuando bloquea", () => {
    const r = correr({ tool_name: "Read", tool_input: { file_path: "tmp/.env.prueba" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^Frenado por regla del proyecto: .+; pedíselo al titular\.\n$/);
  });

  it("sale con 0 y sin ruido cuando permite", () => {
    const r = correr({ tool_name: "Read", tool_input: { file_path: "README.md" } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("lee la rama real de git, también en una rama de main sin commits", () => {
    const repo = mkdtempSync(join(tmpdir(), "frenos-"));
    try {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      const r = correr({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: repo });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/estando en la rama `main`/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("si la entrada no es JSON no bloquea: avisa con 1", () => {
    const r = spawnSync(process.execPath, [resolve(raiz, ".claude/hooks/pre-tool-use.mjs")], { input: "no es json", encoding: "utf8" });
    expect(r.status).toBe(1);
  });
});

// ── F7: autonomía (commit, push y PR sin preguntar) ──────────────────────────────────────────────────
//
// `permissions.allow` deja pasar sin preguntar git add/commit/push/fetch/checkout/switch/branch, gh pr
// create/edit/view/checks/list, gh run y los scripts de pnpm del repo. El hook corre ANTES que el allow:
// todo lo peligroso de esos comandos lo sigue frenando acá, en los dos modos.

const autonomo = (command: string, rama = "feat/algo") =>
  evaluar({ tool_name: "Bash", tool_input: { command } }, { ramaActual: () => rama, modo: "autonomo" });

describe("F7: con el allow puesto, el hook sigue frenando lo peligroso", () => {
  it("frena push a main o master, forzado, tags, --delete, --mirror, merge de PR y merge sobre main", () => {
    for (const c of [
      "git push origin main",
      "git push -u origin HEAD:main",
      "git push origin feat/x:refs/heads/master",
      "git push --force origin feat/x",
      "git push origin +feat/x",
      "git push --tags",
      "git push origin v1.0.0 --follow-tags",
      "git push origin --delete feat/x",
      "git push --mirror",
      "gh pr merge 1",
      "gh pr merge 66 --squash",
    ]) {
      esBloqueo(autonomo(c));
    }
    esBloqueo(autonomo("git push", "main"));
    esBloqueo(autonomo("git merge feat/x", "main"));
    esBloqueo(autonomo("git checkout main && git push"));
  });

  it("frena lo que el allow dejaría pasar y no es trabajo normal", () => {
    for (const c of [
      "git push origin :feat/vieja",
      "git push --prune origin",
      "git push --all origin",
      "git push --no-verify",
      "git commit --no-verify -m prueba",
      "git commit -n -m prueba",
      "git checkout .",
      "git checkout -- .",
      "git checkout -f feat/x",
      "git switch --discard-changes feat/x",
      "git switch -f main",
      "git branch -D main",
      "git branch -f master HEAD~3",
      "git branch -m main viejo",
    ]) {
      esBloqueo(autonomo(c));
    }
  });

  it("deja pasar el trabajo de todos los días", () => {
    for (const c of [
      "git add packages/data/src/servicios/cobros.ts",
      'git commit -m "feat: algo"',
      "git push -u origin feat/algo",
      "git fetch origin",
      "git checkout main",
      "git checkout -b feat/otra",
      "git checkout -- docs/demo/hoja-del-ensayo.md",
      "git switch feat/algo",
      "git branch -D feat/vieja",
      "gh pr create --base main --title t --body-file cuerpo.md",
      "gh pr checks 66",
      "gh run rerun 123 --failed",
      "pnpm typecheck",
      "pnpm test:db",
    ]) {
      expect(autonomo(c), c).toEqual({ bloquear: false });
    }
  });
});

describe("F7: el interruptor de modo (.claude/modo.json)", () => {
  it("en supervisado, commit, push y PR piden aprobación; en autónomo pasan", () => {
    for (const c of ["git commit -m prueba", "git push -u origin feat/algo", "gh pr create --title t --body x", "gh pr edit 66 --body x", 'bash -c "git commit -m prueba"']) {
      const s = evaluar({ tool_name: "Bash", tool_input: { command: c } }, { ramaActual: () => "feat/algo", modo: "supervisado" });
      expect(s.bloquear, c).toBe(false);
      expect(s.preguntar, c).toMatch(/Modo supervisado/);
      expect(autonomo(c), c).toEqual({ bloquear: false });
    }
    // Lo demás no cambia con el modo.
    const s = evaluar({ tool_name: "Bash", tool_input: { command: "pnpm test" } }, { ramaActual: () => "feat/algo", modo: "supervisado" });
    expect(s).toEqual({ bloquear: false });
  });

  it("los frenos frenan igual en supervisado (un freno no se convierte en pregunta)", () => {
    esBloqueo(evaluar({ tool_name: "Bash", tool_input: { command: "git push origin main" } }, { ramaActual: () => "feat/algo", modo: "supervisado" }));
  });

  it("sin el archivo, con JSON roto o con otro valor, cuenta como supervisado", () => {
    expect(leerModo(() => '{ "modo": "autonomo" }')).toBe("autonomo");
    expect(leerModo(() => '﻿{ "modo": "autonomo" }')).toBe("autonomo");
    expect(leerModo(() => '{ "modo": "supervisado" }')).toBe("supervisado");
    expect(
      leerModo(() => {
        throw new Error("ENOENT");
      }),
    ).toBe("supervisado");
    expect(leerModo(() => "{ modo: autonomo")).toBe("supervisado");
    expect(leerModo(() => '{ "modo": "AUTONOMO" }')).toBe("supervisado");
    expect(leerModo(() => "null")).toBe("supervisado");
  });

  it("el archivo de modo queda protegido como los settings", () => {
    for (const c of ['echo {"modo":"autonomo"} > .claude/modo.json', "rm .claude/modo.json", "git checkout -- .claude/modo.json"]) esBloqueo(bash(c));
    esBloqueo(powershell("Set-Content .claude\\modo.json '{}'"));
    expect(bash("cat .claude/modo.json").bloquear).toBe(false);
  });

  it("el ejecutable, con una copia del hook: supervisado y sin archivo dan `ask`; autónomo, nada", () => {
    const dir = mkdtempSync(join(tmpdir(), "modo-"));
    try {
      mkdirSync(join(dir, "hooks"));
      for (const f of ["frenos.mjs", "pre-tool-use.mjs"]) copyFileSync(resolve(raiz, ".claude/hooks", f), join(dir, "hooks", f));
      const correr = () =>
        spawnSync(process.execPath, [join(dir, "hooks", "pre-tool-use.mjs")], {
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m prueba" } }),
          encoding: "utf8",
          cwd: raiz,
        });
      const ask = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };
      // Sin el archivo: supervisado.
      let r = correr();
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject(ask);
      writeFileSync(join(dir, "modo.json"), '{ "modo": "supervisado" }');
      r = correr();
      expect(JSON.parse(r.stdout)).toMatchObject(ask);
      writeFileSync(join(dir, "modo.json"), "{ roto");
      expect(JSON.parse(correr().stdout)).toMatchObject(ask);
      writeFileSync(join(dir, "modo.json"), '{ "modo": "autonomo" }');
      r = correr();
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("con el modo que versiona el repo (`autonomo`), un commit sale sin nada", () => {
    const r = spawnSync(process.execPath, [resolve(raiz, ".claude/hooks/pre-tool-use.mjs")], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m prueba" }, cwd: raiz }),
      encoding: "utf8",
      cwd: raiz,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("");
  });
});

describe("F7, revisión de seguridad: lo que el allow dejaría pasar por otras formas", () => {
  it("M1: git acepta abreviaturas de las opciones largas y grupos de cortas", () => {
    for (const c of [
      "git push --mirr origin",
      "git push --del origin feat/x",
      "git push -qd origin feat/x",
      "git push --pru",
      "git push --al",
      "git push --tag",
      "git push --no-verif",
      "git push --forc origin feat/x",
      "git commit --no-verif -m x",
      "git commit -nm x",
      "git commit -an -m x",
      "git checkout --forc feat/x",
      "git switch --disc feat/x",
      "git branch --forc main HEAD~3",
    ]) {
      esBloqueo(autonomo(c));
    }
  });

  it("M2: un `&` suelto, paréntesis o llaves no esconden un segundo comando (ni el modo)", () => {
    for (const c of ["git status & git push origin main", "git log & git push --force origin feat", "(git push origin HEAD:refs/heads/main)", "{ git push --mirror; }"]) {
      esBloqueo(autonomo(c));
    }
    const s = evaluar({ tool_name: "Bash", tool_input: { command: "git status & git commit -m x" } }, { ramaActual: () => "feat/algo", modo: "supervisado" });
    expect(s.preguntar).toMatch(/Modo supervisado/);
  });

  it("M3: refspecs «matching» o con comodín, y commitear estando en main", () => {
    esBloqueo(autonomo("git push origin :"));
    esBloqueo(autonomo("git push origin 'refs/heads/*:refs/heads/*'"));
    esBloqueo(autonomo('git commit -m "x"', "main"));
  });

  it("M4: --receive-pack, --exec y --upload-pack ejecutan un programa local", () => {
    for (const c of ["git push --receive-pack='sh -c x' origin feat/x", "git push --exec=x origin feat/x", "git fetch --upload-pack='echo x; git-upload-pack' ../b", "git fetch --upl=x origin"]) {
      esBloqueo(autonomo(c));
    }
  });

  it("M5: una ruta de secretos entre comillas se ve aunque el comando sea un commit o un PR", () => {
    for (const c of ['git add -f ".env" && git commit -m "x"', 'git commit -F ".env"', 'gh pr create --body-file ".env"']) {
      esBloqueo(autonomo(c));
    }
  });

  it("m: git add -f, checkout -B / switch -C sobre main, branch -m estando en main, modo.json sin la ruta", () => {
    esBloqueo(autonomo("git add -f _referencias/boleta.pdf"));
    esBloqueo(autonomo("git add --force tmp/x"));
    esBloqueo(autonomo("git checkout -B main origin/feat/x"));
    esBloqueo(autonomo("git switch -C main origin/feat/x"));
    esBloqueo(autonomo("git branch -m viejo", "main"));
    esBloqueo(bash("cd .claude && echo '{\"modo\":\"autonomo\"}' > modo.json"));
  });

  it("m3: el ejecutable lee el archivo de `git commit -F` y frena la marca de IA que trae", () => {
    const dir = mkdtempSync(join(tmpdir(), "msg-"));
    try {
      writeFileSync(join(dir, "msg.txt"), "feat: algo\n\nCo-Authored-By: Alguien <noreply@anthropic.com>\n");
      const r = spawnSync(process.execPath, [resolve(raiz, ".claude/hooks/pre-tool-use.mjs")], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -F msg.txt" }, cwd: dir }),
        encoding: "utf8",
        cwd: raiz,
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/marca de IA/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("segunda vuelta: `@{0}`, heredoc o here-string a un intérprete, comillas que el shell une, abreviaturas de una letra", () => {
    for (const c of [
      // code-reviewer B1: las llaves pegadas no parten el refspec.
      "git push origin HEAD@{0}:main",
      'git push origin "HEAD@{0}:main"',
      "git push origin feat/x@{0}:refs/heads/main",
      // code-reviewer M1: el cuerpo que recibe un intérprete es un comando.
      "bash <<'EOF'\ngit push origin main\nEOF",
      "bash <<'EOF'\ngit push --force\nEOF",
      "sh -s <<EOF\ngit reset --hard\nEOF",
      "cat <<EOF | bash\ngit push origin main\nEOF",
      "Invoke-Expression @'\ngit push origin main\n'@",
      // code-reviewer m1: las comillas en git branch encierran una rama.
      'git branch -m "main" viejo',
      'git branch -f -t "main" origin/x',
      // security-engineer A: el shell une comillas, barras y llaves.
      "git push origin HEAD:ma''in",
      'git push origin HEAD:ma""in',
      "git push origin HEAD:ma\\in",
      "git push origin HEAD:{main,feat/x}",
      "git push --del''ete origin feat/y",
      "git push origin HEAD:ma`in",
      "git push origin $RAMA",
      // security-engineer B: abreviaturas de una letra.
      "git push --m",
      "git push --e='echo x; git-receive-pack' ../b dev",
      "git checkout --f dev",
    ]) {
      esBloqueo(autonomo(c));
    }
    esBloqueo(autonomo("git checkout stash@{0} -- ."));
  });

  it("sin falsos positivos: un mensaje que describe los frenos no es ejecutarlos", () => {
    for (const c of [
      'git commit -m "fix: -n"',
      'git commit -m "docs: a; git checkout . y mas"',
      "git commit -F - <<'EOF'\nfeat: frenos\n\n- git checkout . descarta todo\n- git push origin main se frena\nEOF",
      "git commit -m @'\nfeat: frenos\n- git push --all sube main\n'@",
      'gh pr create --title "chore: frenos" --body "git push --mirror y git branch -D main se frenan"',
      "git checkout -b feat/otra",
      "git switch -c feat/otra",
      "git branch -D feat/vieja",
    ]) {
      expect(autonomo(c, "feat/algo"), c).toEqual({ bloquear: false });
    }
    // Estando en main, borrar OTRA rama local no toca main.
    expect(autonomo("git branch -D feat/vieja", "main")).toEqual({ bloquear: false });
    // Y descartar todo con HEAD también se frena.
    esBloqueo(autonomo("git checkout HEAD -- ."));
  });
});
