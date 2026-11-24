// Tests del hook de frenos (`.claude/hooks/frenos.mjs`). Se le pasa lo mismo que recibe Claude Code:
// el JSON de entrada de un hook PreToolUse. Sin red, sin base, sin Claude. Corren en el gate barato.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — es JavaScript puro (el hook no tiene dependencias ni paso de compilación).
import { evaluar, leerModo, mencionaRutaSensible } from "../../.claude/hooks/frenos.mjs";

import { exigirEntornoLocal } from "../../packages/data/scripts/solo-desarrollo.ts";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Un repo git vacío parado en la rama pedida: la rama que ve el hook no depende del checkout donde corre el test. */
function repoTemporal(rama: string): string {
  const dir = mkdtempSync(join(tmpdir(), "frenos-repo-"));
  const r = spawnSync("git", ["init", "-q", "-b", rama], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`no se pudo crear el repo temporal: ${r.stderr}`);
  return dir;
}

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

  it("S2, hueco 1: descartar cambios de archivos puntuales frena igual que `git checkout .`", () => {
    for (const c of [
      "git checkout -- docs/demo/hoja-del-ensayo.md",
      "git checkout HEAD -- packages/data/src/client.ts",
      "git checkout feat/otra -- apps/web/src/a.ts apps/web/src/b.ts",
      "git restore docs/demo/hoja-del-ensayo.md",
      "git restore --source=HEAD~1 packages/data/src/client.ts",
      "git restore -W apps/web/src/a.ts",
      "git restore --worktree apps/web/src/a.ts",
      "git restore --staged --worktree apps/web/src/a.ts",
      "git restore --staged -W apps/web/src/a.ts",
      "git restore --worktre apps/web/src/a.ts",
      "git -C . restore apps/web/src/a.ts",
      // Revisión de seguridad: la abreviatura `--w` también es `--worktree`; y `checkout <rev> <ruta>` sin `--`.
      "git restore --staged --w apps/web/src/a.ts",
      "git checkout apps/web/src/a.ts HEAD",
      "git checkout HEAD apps/web/src/a.ts",
      "git checkout main apps/web/src/a.ts",
      "git checkout --pathspec-from-file=lista.txt",
      'bash -c "git checkout -- apps/web/src/a.ts"',
    ]) {
      esBloqueo(autonomo(c));
      esBloqueo(evaluar({ tool_name: "Bash", tool_input: { command: c } }, { ramaActual: () => "feat/algo", modo: "supervisado" }));
    }
    esBloqueo(powershell("git restore apps\\web\\src\\a.ts"));
    // Sacar del índice no toca el archivo, y cambiar de rama no lleva `--`.
    for (const c of ["git restore --staged apps/web/src/a.ts", "git restore -S apps/web/src/a.ts", "git checkout feat/otra", "git checkout -b feat/otra main", "git checkout -B feat/otra origin/feat/otra", "git checkout origin/feat/otra"]) {
      expect(autonomo(c), c).toEqual({ bloquear: false });
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
      "git restore --staged docs/demo/hoja-del-ensayo.md",
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
    // S2: la rama sale de un repo temporal, no del checkout donde corra el test (en el push a `main` del CI el
    // checkout ES `main`, y el hook frena el commit ahí: el test fallaba con «expected 2 to be 0»).
    const repo = repoTemporal("feat/prueba");
    try {
      mkdirSync(join(dir, "hooks"));
      for (const f of ["frenos.mjs", "pre-tool-use.mjs"]) copyFileSync(resolve(raiz, ".claude/hooks", f), join(dir, "hooks", f));
      const correr = () =>
        spawnSync(process.execPath, [join(dir, "hooks", "pre-tool-use.mjs")], {
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m prueba" }, cwd: repo }),
          encoding: "utf8",
          cwd: repo,
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
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("con el modo que versiona el repo (`autonomo`), un commit en una rama de trabajo sale sin nada, y sobre `main` se frena", () => {
    const hook = resolve(raiz, ".claude/hooks/pre-tool-use.mjs");
    const correrEn = (rama: string) => {
      const repo = repoTemporal(rama);
      try {
        return spawnSync(process.execPath, [hook], {
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m prueba" }, cwd: repo }),
          encoding: "utf8",
          cwd: repo,
        });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    };
    // El modo que se lee es el del repo real (`.claude/modo.json`): tiene que ser `autonomo`.
    expect(leerModo()).toBe("autonomo");
    const trabajo = correrEn("feat/prueba");
    expect(trabajo.status).toBe(0);
    expect(trabajo.stderr).toBe("");
    expect(trabajo.stdout).toBe("");
    const main = correrEn("main");
    expect(main.status).toBe(2);
    expect(main.stderr).toMatch(/Frenado por regla del proyecto/);
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

// ── S2, hueco 2: `pnpm db:*` (en el allow) solo contra la base local ─────────────────────────────────
//
// Sin leer `.env*` desde el hook: lo verifica el propio script, que ya carga el .env, con la URL que de verdad va
// a usar. `db:migrate` pasa por `solo-desarrollo.ts --verificar`; setup, seed y reset por `exigirEntornoLocal`.
describe("S2: los scripts `db:*` se niegan a correr contra una base que no es la local", () => {
  const LOCAL = "postgres://u:p@localhost:5432/admin_barrios";
  const guardia = resolve(raiz, "packages/data/scripts/solo-desarrollo.ts");
  const verificar = (env: Record<string, string | undefined>) =>
    spawnSync(process.execPath, [guardia, "--verificar"], {
      encoding: "utf8",
      // Sin heredar DATABASE_URL* del que corre el test. El script carga el .env de la raíz pero dotenv no pisa lo que
      // ya está definido: se fijan las tres URLs (las que el caso no pide quedan en local) para que un .env remoto
      // de la máquina de quien corre el test no lo haga fallar.
      env: { PATH: process.env["PATH"] ?? "", DATABASE_URL: LOCAL, DATABASE_URL_APP: LOCAL, DATABASE_URL_JOB: LOCAL, ...env },
    });

  it("deja pasar localhost, 127.0.0.1, ::1 y el servicio `postgres` del compose", () => {
    for (const url of [LOCAL, "postgres://u:p@127.0.0.1:5432/a", "postgres://u:p@[::1]:5432/a", "postgres://u:p@postgres:5432/a"]) {
      expect(verificar({ DATABASE_URL: url }).status, url).toBe(0);
    }
  });

  it("se niega con un host remoto, en cualquiera de las tres URLs", () => {
    for (const env of [
      { DATABASE_URL: "postgres://u:p@db.produccion.example.com:5432/a" },
      { DATABASE_URL: "postgres://u:p@10.0.0.5:5432/a" },
      { DATABASE_URL: LOCAL, DATABASE_URL_APP: "postgres://u:p@staging.example.com/a" },
      { DATABASE_URL: LOCAL, DATABASE_URL_JOB: "postgres://u:p@aws-0.pooler.supabase.com/a" },
      // Que el host «empiece» o «termine» como uno local no lo hace local.
      { DATABASE_URL: "postgres://u:p@localhost.evil.example.com/a" },
      { DATABASE_URL: "postgres://localhost:x@evil.example.com/a" },
      // `?host=` pisa el host de la URL en el driver: antes pasaba el guard y conectaba a otro lado.
      { DATABASE_URL: "postgres://u:p@localhost/a?host=prod.example.com" },
      { DATABASE_URL: LOCAL, DATABASE_URL_APP: "postgres://u:p@localhost/a?hostaddr=10.0.0.5" },
      { DATABASE_URL: "no es una url" },
    ]) {
      const r = verificar(env);
      expect(r.status, JSON.stringify(env)).not.toBe(0);
      expect(r.stderr).toMatch(/se niega a correr/);
    }
  });

  it("`exigirEntornoLocal` exige APP_ENTORNO=local y además la base local", () => {
    const antes = { ...process.env };
    try {
      process.env["DATABASE_URL"] = LOCAL;
      process.env["APP_ENTORNO"] = "local";
      expect(() => exigirEntornoLocal("prueba")).not.toThrow();
      process.env["DATABASE_URL"] = "postgres://u:p@db.produccion.example.com/a";
      expect(() => exigirEntornoLocal("prueba")).toThrow(/se niega a correr/);
      process.env["DATABASE_URL"] = LOCAL;
      process.env["APP_ENTORNO"] = "staging";
      expect(() => exigirEntornoLocal("prueba")).toThrow(/solo corre en desarrollo/);
    } finally {
      for (const k of ["DATABASE_URL", "DATABASE_URL_APP", "DATABASE_URL_JOB", "APP_ENTORNO"]) {
        if (antes[k] === undefined) delete process.env[k];
        else process.env[k] = antes[k];
      }
    }
  });

  it("`pnpm db:migrate` pasa por el guard (y `migrate` a secas queda para quien migra otro entorno a propósito)", () => {
    const raizPkg = JSON.parse(readFileSync(resolve(raiz, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const dataPkg = JSON.parse(readFileSync(resolve(raiz, "packages/data/package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(raizPkg.scripts["db:migrate"]).toBe("pnpm --filter @admin-barrios/data migrate:dev");
    expect(dataPkg.scripts["migrate:dev"]).toMatch(/^node \.\/scripts\/solo-desarrollo\.ts --verificar && drizzle-kit migrate$/);
  });
});

// ── S8: borrar o pisar trabajo sin commitear por las formas que quedaban abiertas ───────────────────
//
// Un test por forma frenada y uno por cada excepción. Límites que se aceptan y NO se intentan cubrir: los alias
// de git (`git config alias.x '…'` y `git x`) y `git checkout <ruta>` de un solo argumento (git no distingue una
// rama de una ruta sin mirar el repo). Quedan escritos en HANDOFF.md.
describe("S8: git que borra o pisa trabajo sin commitear", () => {
  it("`git rm` forzado, en cualquiera de sus formas", () => {
    for (const c of ["git rm -f a.ts", "git rm --force a.ts", "git rm --forc a.ts", "git rm -rf carpeta", "git rm -fq a.ts", "git rm a.ts -f", "git -C otro rm -f a.ts"]) esBloqueo(autonomo(c));
  });
  it("`git rm` sin forzar y con --cached sigue libre", () => {
    for (const c of ["git rm a.ts", "git rm -r carpeta", "git rm --cached a.ts", "git rm -r --cached carpeta"]) expect(autonomo(c), c).toEqual({ bloquear: false });
  });
  it("`git checkout-index` con -f, -a o sus formas largas", () => {
    for (const c of ["git checkout-index -f a.ts", "git checkout-index --force a.ts", "git checkout-index -a", "git checkout-index --all", "git checkout-index -fa", "git checkout-index --al", "git checkout-index -q -f -- a.ts"]) esBloqueo(autonomo(c));
  });
  it("`git checkout-index` de un archivo sin forzar sigue libre", () => {
    expect(autonomo("git checkout-index a.ts")).toEqual({ bloquear: false });
  });
  it("`git apply -R` y `--reverse`", () => {
    for (const c of ["git apply -R cambio.patch", "git apply --reverse cambio.patch", "git apply --rev cambio.patch", "git apply --index -R cambio.patch", "git apply -3R cambio.patch"]) esBloqueo(autonomo(c));
  });
  it("`git apply` hacia adelante (y --reject, --recount) sigue libre", () => {
    for (const c of ["git apply cambio.patch", "git apply --check cambio.patch", "git apply --reject cambio.patch", "git apply --recount cambio.patch"]) expect(autonomo(c), c).toEqual({ bloquear: false });
  });
  it("`git clean` en todas sus formas, también la que solo lista", () => {
    for (const c of ["git clean", "git clean -n", "git clean -fd", "git clean -fdx", "git clean --force", "git clean -i", "git clean -d --dry-run", "git -C otro clean -xf"]) esBloqueo(autonomo(c));
  });
});

describe("S8: borrado recursivo o forzado (`rm`, `Remove-Item`, `del`, `rd`)", () => {
  it("rm en Bash con -r, -R, -f o un grupo, y sus formas largas", () => {
    for (const c of [
      "rm -rf src",
      "rm -r src",
      "rm -R src",
      "rm -f src/a.ts",
      "rm -fr src",
      "rm -rvf src",
      "rm --recursive src",
      "rm --force src/a.ts",
      "rm --rec src",
      "rm --for src/a.ts",
      "rm src -rf",
      "rm -rf -- src",
      "rm -rf .",
      "rm -rf *",
      "rm -rf ~/algo",
      "rm -rf /",
      "rm -rf $DIR",
      "rm -rf dist ../src",
      "rm -rf dist src",
    ]) esBloqueo(bash(c));
  });
  it("las formas que lo esconden: prefijos, ruta del ejecutable, comillas, pipes, xargs, bash -c", () => {
    for (const c of ["sudo rm -rf src", "\\rm -rf src", "/bin/rm -rf src", "command rm -rf src", "env X=1 rm -rf src", "'rm' -rf src", "r''m -rf src", "ls | xargs rm -rf", "echo x && rm -rf src", "bash -c 'rm -rf src'", 'sh -c "cd x; rm -rf ."', "echo $(rm -rf src)"]) {
      esBloqueo(bash(c));
    }
  });
  it("Remove-Item en PowerShell con -Recurse, -Force y sus abreviaturas", () => {
    for (const c of [
      "Remove-Item -Recurse src",
      "Remove-Item -Force src\\a.ts",
      "Remove-Item src -Recurse -Force",
      "Remove-Item -r src",
      "Remove-Item -Rec src",
      "Remove-Item -fo src\\a.ts",
      "Remove-Item -Recurse:$true src",
      "Remove-Item -Path src -Recurse",
      "Remove-Item -Path:src -Recurse",
      "Remove-Item -LiteralPath src -Recurse",
      "remove-item -recurse src",
      "ri -r src",
      "rm -r src",
      "rm -Force src\\a.ts",
      "del -Recurse src",
      "Remove-Item -Recurse dist,src",
      "Get-ChildItem . | Remove-Item -Recurse",
      "& Remove-Item -Recurse src",
      "Remove-Item -Recurse C:\\Windows",
      "Remove-Item -Recurse $env:USERPROFILE",
    ]) esBloqueo(powershell(c));
  });
  it("del, rd, rmdir y erase con /s, /q o /f", () => {
    for (const c of ["del /s src", "del /q src\\a.ts", "del /f src\\a.ts", "rd /s /q src", "rd /s src", "rmdir /s src", "erase /f src\\a.ts", "DEL /S SRC", "cmd /c rd /s /q src", 'cmd /c "del /f /q src"']) {
      esBloqueo(powershell(c));
      esBloqueo(bash(c));
    }
  });
  it("sin opción recursiva ni forzada no se mira: borra archivos sueltos", () => {
    for (const c of ["rm src/a.ts", "rm a.ts b.ts", "rm -i a.ts", "rm -v a.ts", "rmdir vacia", "del a.ts", "rd vacia"]) expect(bash(c), c).toEqual({ bloquear: false });
    for (const c of ["Remove-Item a.ts", "Remove-Item -Path a.ts", "Remove-Item -LiteralPath a.ts", "Remove-Item -WhatIf a.ts", "rm a.ts", "ri a.ts"]) expect(powershell(c), c).toEqual({ bloquear: false });
  });
  it("`-LiteralPath` y `-Filter` no se confunden con -r ni -f en PowerShell", () => {
    expect(powershell("Remove-Item -LiteralPath a.ts")).toEqual({ bloquear: false });
    expect(powershell("rm -LiteralPath a.ts")).toEqual({ bloquear: false });
  });
  it("excepción: carpetas descartables (node_modules, .next, dist, coverage), en cualquier nivel del repo", () => {
    for (const c of [
      "rm -rf node_modules",
      "rm -rf ./node_modules",
      "rm -rf node_modules/",
      "rm -rf apps/web/node_modules",
      "rm -rf .next",
      "rm -rf apps/web/.next",
      "rm -rf dist",
      "rm -rf packages/data/dist",
      "rm -rf coverage",
      "rm -rf node_modules .next dist coverage",
      "rm -rf apps/web/.next/cache",
      "rm -rf dist/*",
      "rm -fr node_modules",
      "rm --recursive --force dist",
    ]) expect(bash(c), c).toEqual({ bloquear: false });
    for (const c of ["Remove-Item -Recurse -Force node_modules", "Remove-Item -Recurse apps\\web\\.next", "Remove-Item -Recurse -Force dist, coverage", "Remove-Item -Path node_modules -Recurse", "rm -r -fo .next", "rd /s /q node_modules", "del /s /q dist"]) {
      expect(powershell(c), c).toEqual({ bloquear: false });
    }
  });
  it("excepción: `.next-build`, donde compila apps/web", () => {
    for (const c of ["rm -rf apps/web/.next-build", "rm -rf .next-build/", "rm -rf apps/web/.next-build/cache"]) expect(bash(c), c).toEqual({ bloquear: false });
    expect(powershell("Remove-Item -Recurse -Force apps\\web\\.next-build")).toEqual({ bloquear: false });
    // Sigue siendo un segmento exacto, y con `..` no vale.
    for (const c of ["rm -rf mi.next-build", "rm -rf .next-build-viejo", "rm -rf .next-build/../src"]) esBloqueo(bash(c));
  });
  it("excepción: `tmp/` del repo", () => {
    for (const c of ["rm -rf tmp", "rm -rf tmp/", "rm -rf ./tmp/x", "rm -rf tmp/pruebas/uno"]) expect(bash(c), c).toEqual({ bloquear: false });
    expect(powershell("Remove-Item -Recurse -Force tmp\\x")).toEqual({ bloquear: false });
    // Una carpeta que solo se parece, o `tmp` que no está en la raíz del repo, no es la de trabajo.
    for (const c of ["rm -rf tmpdir", "rm -rf src/tmp", "rm -rf mitmp/x", "rm -rf distro", "rm -rf src/node_modules_viejo", "rm -rf mi.next"]) esBloqueo(bash(c));
  });
  it("excepción: temporales del sistema (/tmp, $TEMP, %TEMP%, $env:TEMP), siempre con algo detrás", () => {
    for (const c of ["rm -rf /tmp/prueba", "rm -rf /tmp/a/b", "rm -rf $TEMP/prueba", "rm -rf ${TEMP}/prueba", "rm -rf $TMP/prueba"]) expect(bash(c), c).toEqual({ bloquear: false });
    for (const c of ["Remove-Item -Recurse $env:TEMP\\prueba", "Remove-Item -Recurse -Force $env:TEMP/prueba", "Remove-Item -Recurse %TEMP%\\prueba", "rd /s /q %TEMP%\\prueba"]) expect(powershell(c), c).toEqual({ bloquear: false });
    // El directorio de temporales entero, otra raíz, o salirse de él, no.
    for (const c of ["rm -rf /tmp", "rm -rf /tmp/", "rm -rf $TEMP", "rm -rf /tmp/../etc", "rm -rf $TEMP/../x", "rm -rf /tmpx/a", "rm -rf /tmp/$X", "rm -rf /var/tmp/a"]) esBloqueo(bash(c));
    for (const c of ["Remove-Item -Recurse $env:TEMP", "Remove-Item -Recurse %TEMP%", "Remove-Item -Recurse $env:TEMP\\..\\Windows", "Remove-Item -Recurse $env:TEMPX\\a"]) esBloqueo(powershell(c));
  });
  it("excepción: el directorio temporal real de este equipo (os.tmpdir) con algo detrás, y no él solo", () => {
    const base = tmpdir();
    expect(bash(`rm -rf "${join(base, "prueba-s8")}"`)).toEqual({ bloquear: false });
    expect(powershell(`Remove-Item -Recurse -Force "${join(base, "prueba-s8")}"`)).toEqual({ bloquear: false });
    esBloqueo(bash(`rm -rf "${base}"`));
    esBloqueo(powershell(`Remove-Item -Recurse -Force "${join(base, "..", "otro")}"`));
  });
  it("la excepción exige que TODAS las rutas sean descartables y que no haya variables ni `..`", () => {
    for (const c of ["rm -rf node_modules src", "rm -rf dist ..", "rm -rf node_modules/../src", "rm -rf dist/../../x", "rm -rf node_modules $DIR", "rm -rf `echo src`", "rm -rf tmp/$(pwd)", "rm -rf ~/node_modules", "rm -rf /node_modules", "rm -rf C:/dist", "rm -rf C:\\algo\\node_modules"]) {
      esBloqueo(bash(c));
    }
    esBloqueo(powershell("Remove-Item -Recurse -Force node_modules, src"));
  });
  it("revisión: un `bash -c` o `pwsh -Command` anidado se mira con las reglas de los dos intérpretes", () => {
    for (const c of ["bash -c 'rm -rf src'", 'bash -c "rm -rf src"', "sh -c 'rm -fr src'", "pwsh -Command \"Remove-Item -Recurse src\"", "bash -c 'rm -rf dist src'"]) {
      esBloqueo(powershell(c));
      esBloqueo(bash(c));
    }
    expect(powershell("bash -c 'rm -rf node_modules'")).toEqual({ bloquear: false });
  });
  it("revisión: `$TEMP` en PowerShell no es la variable de entorno (`$env:TEMP` sí); en Bash es al revés", () => {
    for (const c of ["Remove-Item -Recurse -Force $TEMP/Windows", "Remove-Item -Recurse -Force ${TEMP}/Windows", "Remove-Item -Recurse $TMP/x"]) esBloqueo(powershell(c));
    esBloqueo(bash("rm -rf $env:TEMP/x"));
    expect(powershell("Remove-Item -Recurse $env:TEMP/x")).toEqual({ bloquear: false });
    expect(bash("rm -rf $TEMP/x")).toEqual({ bloquear: false });
    // Anidado: solo vale lo que es seguro en los dos.
    esBloqueo(powershell("bash -c 'rm -rf $TEMP/x'"));
  });
  it("revisión: banderas de cmd pegadas (`/s/q`)", () => {
    for (const c of ["rd /s/q src", "del /f/s/q src", "cmd /c rd /s/q src", "rmdir /s/q src"]) {
      esBloqueo(powershell(c));
      esBloqueo(bash(c));
    }
    expect(powershell("rd /s/q node_modules")).toEqual({ bloquear: false });
  });
  it("revisión: prefijos con opciones (`xargs -0`, `sudo -u`, `env -i`, `nice -n`, `find -exec`)", () => {
    for (const c of ["find . -name x -print0 | xargs -0 rm -rf", "xargs -I{} rm -rf {}", "env -i rm -rf src", "sudo -u x rm -rf src", "nice -n 5 rm -rf src", "find . -exec rm -rf {} +"]) esBloqueo(bash(c));
    expect(bash("xargs -0 rm -rf node_modules")).toEqual({ bloquear: false });
  });
  it("revisión: redirecciones y parámetros con valor no se toman por rutas", () => {
    for (const c of ["rm -rf dist 2>/dev/null", "rm -rf node_modules >/dev/null 2>&1", "rm -rf coverage 2>nul"]) expect(bash(c), c).toEqual({ bloquear: false });
    for (const c of ["Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue", "Remove-Item -Recurse -Force node_modules -EA 0", "Remove-Item -Recurse -Force node_modules -Include *.js"]) expect(powershell(c), c).toEqual({ bloquear: false });
    esBloqueo(powershell("Remove-Item -Recurse -Force src -ErrorAction SilentlyContinue"));
    esBloqueo(bash("rm -rf src 2>/dev/null"));
  });
  it("seguridad A1: en Bash `.\\.` es `..` y no anula la lista", () => {
    for (const c of ["rm -rf node_modules/.\\./src", "rm -rf tmp/.\\./src", "rm -rf /tmp/.\\./etc", "rm -rf $TEMP/.\\./.\\./x"]) esBloqueo(bash(c));
    esBloqueo(powershell("Remove-Item -Recurse node_modules\\..\\src"));
  });
  it("seguridad A2: el `&` de una redirección no corta el comando", () => {
    for (const c of ["rm -rf node_modules 2>&1 src", "rm -rf dist &>/dev/null src", "rm -rf dist 2>&1 | rm -rf src", "rm -rf dist |& rm -rf src"]) esBloqueo(bash(c));
    expect(bash("rm -rf node_modules 2>&1")).toEqual({ bloquear: false });
    expect(bash("rm -rf dist 2> /dev/null")).toEqual({ bloquear: false });
    esBloqueo(bash("git checkout --force x 2>&1 | tail"));
  });
  it("seguridad A3: una expresión entre paréntesis no separa a Remove-Item de sus banderas", () => {
    for (const c of ["Remove-Item (Join-Path . src) -Recurse -Force", "Remove-Item -Path ($PWD.Path + '\\src') -Recurse -Force", "Remove-Item $(Resolve-Path src) -Recurse", "Remove-Item -Recurse -Force (Get-Item src)", "Get-ChildItem src -Recurse -File | Remove-Item", "gci src -r | ri", "& {Remove-Item src -Recurse}"]) esBloqueo(powershell(c));
  });
  it("seguridad A4: `rm.exe` de GNU con ruta, o con wsl, desde PowerShell", () => {
    for (const c of ["& 'C:\\Program Files\\Git\\usr\\bin\\rm.exe' -rf src", "C:\\Git\\usr\\bin\\rm.exe -rf src", "wsl rm -rf src"]) esBloqueo(powershell(c));
  });
  it("seguridad M1: si el comando reasigna TEMP o TMP, ninguna variable vale", () => {
    for (const c of ["TEMP=/c/Proyectos_Desa; rm -rf $TEMP/admin-barrios", "export TMP=/c; rm -rf $TMP/Proyectos_Desa"]) esBloqueo(bash(c));
    for (const c of ["$env:TEMP='C:\\Proyectos_Desa'; Remove-Item $env:TEMP\\admin-barrios -Recurse -Force", "$env:TMP = 'C:\\'; Remove-Item -Recurse $env:TMP\\x"]) esBloqueo(powershell(c));
    expect(bash("TEMP=/c/x; rm -rf /tmp/prueba")).toEqual({ bloquear: false });
  });
  it("seguridad M2/M3: `cmd //c`, `/c` pegado, y que `-ea` no se salte una carpeta de cmd", () => {
    for (const c of ["cmd //c rd //s //q src", 'cmd //c "rd /s /q src"', 'cmd /c"rd /s /q src"', "cmd /c rd /s /q node_modules -ea src"]) {
      esBloqueo(bash(c));
      esBloqueo(powershell(c));
    }
  });
  it("seguridad M4: tokens pegados, `r\\m`, comillas invertidas y más prefijos", () => {
    for (const c of ['"r"m -rf src', "r\\m -rf src", "echo `rm -rf src`", "timeout 60 rm -rf src", "busybox rm -rf src", "eval rm -rf src", '"g"it clean -fdx']) esBloqueo(bash(c));
    esBloqueo(powershell("Re`move-Item src -Recurse"));
  });
  it("seguridad M5: opciones globales de git con el valor aparte (también para el push)", () => {
    for (const c of ["git --work-tree . clean -fdx", "git --git-dir .git --work-tree . clean -fdx", "git --namespace x clean -fdx", "git --git-dir .git push --force origin main", "git --git-dir .git rm -f a.ts"]) esBloqueo(autonomo(c));
  });
  it("seguridad M6: `find -delete` se mira como `rm -r` sobre sus raíces", () => {
    for (const c of ["find src -delete", "find src -type f -delete", "find . -name x -delete"]) esBloqueo(bash(c));
    expect(bash("find node_modules -type f -delete")).toEqual({ bloquear: false });
  });
  it("seguridad F1/F4: el temporal en forma de Git Bash y `${env:TEMP}` se aceptan", () => {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(tmpdir());
    if (m) expect(bash(`rm -rf "/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}/prueba-s8"`)).toEqual({ bloquear: false });
    expect(powershell('Remove-Item -Recurse -Force "${env:TEMP}\\x"')).toEqual({ bloquear: false });
  });
  it("segunda vuelta B1: el borrado dentro de subshells, bloques, if, for y try se frena", () => {
    for (const c of ["(rm -rf src)", "cd apps && (rm -rf src)", "cat <(rm -rf src)", "{ rm -rf src; }", "true && { rm -rf src; }", "if true; then rm -rf src; fi", "for d in src; do rm -rf $d; done", "! rm -rf src", "(rm -rf v1) && if true; then rm -rf v2; fi", "echo hola && ( cd x && rm -rf src )"]) esBloqueo(bash(c));
    for (const c of [
      "(Remove-Item src -Recurse -Force)",
      "@(Remove-Item src -Recurse -Force)",
      "if (Test-Path src) { Remove-Item src -Recurse -Force }",
      "foreach ($f in 1) { Remove-Item src -Recurse -Force }",
      "try { Remove-Item src -Recurse -Force } catch {}",
      "gci src | % { Remove-Item $_ -Recurse -Force }",
      "gci src -r -file | ForEach-Object { rm $_.FullName -Force }",
    ]) esBloqueo(powershell(c));
    // Lo descartable dentro de las mismas formas pasa.
    expect(bash("if [ -d dist ]; then rm -rf dist; fi")).toEqual({ bloquear: false });
    expect(powershell("if (Test-Path dist) { Remove-Item dist -Recurse -Force }")).toEqual({ bloquear: false });
    expect(powershell("try { Remove-Item node_modules -Recurse -Force } catch {}")).toEqual({ bloquear: false });
    expect(bash("(cd apps/web && rm -rf .next)")).toEqual({ bloquear: false });
  });
  it("segunda vuelta M7: `cmd /c` con rm o con powershell usa las reglas del programa", () => {
    for (const c of ["cmd //c rm -rf src", "cmd /c rm -rf src", "cmd /c powershell Remove-Item src -Recurse -Force"]) {
      esBloqueo(bash(c));
      esBloqueo(powershell(c));
    }
  });
  it("segunda vuelta M8: cualquier mención de TEMP o TMP fuera de la raíz de una ruta anula las variables", () => {
    for (const c of ["read -r TEMP <<< /c; rm -rf $TEMP/Proyectos_Desa", "for TEMP in /c; do rm -rf $TEMP/Proyectos_Desa; done", "TEMP+=/../../..; rm -rf $TEMP/Proyectos_Desa", "printf -v TMP %s /c; rm -rf $TMP/Proyectos_Desa"]) esBloqueo(bash(c));
    for (const c of ["${env:TEMP}='C:\\Proyectos_Desa'; Remove-Item ${env:TEMP}/admin-barrios -Recurse -Force", "$env:TEMP+='\\..\\..\\..'; Remove-Item $env:TEMP/admin-barrios -Recurse -Force", "[Environment]::SetEnvironmentVariable('TEMP','C:\\Proyectos_Desa','Process'); Remove-Item $env:TEMP/admin-barrios -Recurse -Force"]) esBloqueo(powershell(c));
    expect(bash("rm -rf $TEMP/a $TEMP/b")).toEqual({ bloquear: false });
  });
  it("segunda vuelta M9/M10/M11: find -exec rm, find -follow -delete, comillas invertidas en las opciones", () => {
    for (const c of ["find src -type f -exec rm {} +", "find src -exec rm -f {} ;", "find node_modules -follow -delete", "find -L node_modules -delete"]) esBloqueo(bash(c));
    expect(bash("find node_modules -type f -exec rm {} +")).toEqual({ bloquear: false });
    for (const c of ["Remove-Item src -Rec`urse", "Remove-Item src -Recurse`"]) esBloqueo(powershell(c));
  });
  it("tercera vuelta: catch, asignación del resultado, comillas dobles con una simple, switch y case", () => {
    for (const c of [
      "try { Remove-Item node_modules -Recurse -Force -ErrorAction Stop } catch { Remove-Item src -Recurse -Force }",
      "try { Get-Item x } finally { Remove-Item src -Recurse -Force }",
      "$null = Remove-Item src -Recurse -Force",
      "$r = Remove-Item src -Recurse -Force",
      "switch (1) { 1 { Remove-Item src -Recurse -Force } }",
    ]) esBloqueo(powershell(c));
    for (const c of ["echo \"'\" `rm -rf src` \"'\"", "case a in a) rm -rf src;; esac", "TE=1; declare \"TE\"\"MP=/c\"; rm -rf $TEMP/Proyectos_Desa"]) esBloqueo(bash(c));
    expect(powershell("$null = Remove-Item dist -Recurse -Force")).toEqual({ bloquear: false });
    expect(bash("case a in a) rm -rf dist;; esac")).toEqual({ bloquear: false });
  });
  it("segunda vuelta: `git rm` tras un prefijo y comillas invertidas entre comillas simples no son borrados", () => {
    for (const c of ["time git rm -r --cached carpeta", "timeout 60 git rm -r --cached x", "env FOO=1 git rm -r --cached x", "grep -n '`git clean`' docs/x.md", "grep -n '`rm -rf src`' docs/x.md"]) expect(bash(c), c).toEqual({ bloquear: false });
    esBloqueo(bash('grep -n "`rm -rf src`" docs/x.md'));
    // `/tmp/x` en PowerShell no cuenta como el prefijo `/tmp/` (en Windows es `C:\tmp\x`). En Linux sí es el temporal del
    // sistema (`os.tmpdir()`), así que el caso depende de la plataforma y solo se mira donde `/tmp` no es el temporal.
    if (!tmpdir().replace(/\\/g, "/").toLowerCase().startsWith("/tmp")) esBloqueo(powershell("Remove-Item -Recurse -Force /tmp/x"));
  });
  it("un mensaje de commit que describe el borrado no es ejecutarlo", () => {
    expect(autonomo('git commit -m "chore: ya no se hace rm -rf src ni Remove-Item -Recurse"')).toEqual({ bloquear: false });
  });
  it("los scripts de pnpm del repo no usan rm ni Remove-Item (frenarlos no rompe nada)", () => {
    const paquetes = ["package.json", ...["apps", "packages"].flatMap((d) => readdirSync(resolve(raiz, d), { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(resolve(raiz, d, e.name, "package.json"))).map((e) => `${d}/${e.name}/package.json`))];
    expect(paquetes.length).toBeGreaterThan(5);
    for (const p of paquetes) {
      const scripts = (JSON.parse(readFileSync(resolve(raiz, p), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const [nombre, comando] of Object.entries(scripts)) {
        expect(comando, `${p} → ${nombre}`).not.toMatch(/(?:^|[\s;&|(])(?:rm|rmdir|rimraf|del|rd|remove-item)(?=\s|$)/i);
      }
    }
  });
});
