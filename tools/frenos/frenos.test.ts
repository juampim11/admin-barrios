// Tests del hook de frenos (`.claude/hooks/frenos.mjs`). Se le pasa lo mismo que recibe Claude Code:
// el JSON de entrada de un hook PreToolUse. Sin red, sin base, sin Claude. Corren en el gate barato.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — es JavaScript puro (el hook no tiene dependencias ni paso de compilación).
import { evaluar, mencionaRutaSensible } from "../../.claude/hooks/frenos.mjs";

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
