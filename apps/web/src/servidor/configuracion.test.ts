/**
 * **El cerrojo 5 del ADR-0002 §3.2, verificado adentro del proceso.**
 *
 * `apps/web` se niega a atender si recibe una credencial que no le corresponde o si le falta
 * configuración. Eso estaba escrito, y **estaba verificado únicamente sobre el `docker-compose.yml`**
 * (`tools/infra/credenciales.test.ts`): o sea, se comprobaba que el archivo no le pasara la
 * credencial equivocada, pero nada comprobaba que el proceso la rechazara si igual llegaba —por un
 * manifiesto de despliegue, por una variable exportada a mano, por un `.env` de otra máquina—.
 *
 * Lo señaló `security-engineer` revisando el arranque perezoso de `db.ts`: la garantía "el proceso no
 * atiende" cuelga hoy de una sola pieza (`instrumentation.ts`), y de esa pieza no se verificaba nada.
 * Este archivo cubre la mitad que se puede cubrir con un test puro: **que la función que decide diga
 * que no**.
 *
 * ⚠ Lo que este archivo **no** puede probar, y hay que saberlo: que Next llame a `register()`, que un
 * rechazo ahí **aborte el arranque** en vez de quedar logueado, y que el health-check del despliegue
 * toque una ruta que ejercite los recursos. Si Next loguea y sigue, el contenedor queda verde, el
 * despliegue se da por bueno y cada request devuelve 500 — que es exactamente el escenario que
 * `instrumentation.ts` existe para evitar. Eso es trabajo de `devops` y está anotado.
 */

import { describe, expect, it } from "vitest";
import { esEntornoLocal, leerConfiguracion } from "./configuracion.ts";

/**
 * Un entorno mínimo que sí es válido, para partir de ahí y romperlo de a una cosa por vez.
 *
 * El tipo de vuelta es el del parámetro y no `NodeJS.ProcessEnv`: ese tipo exige `NODE_ENV`, que no
 * tiene nada que ver con lo que se está probando y obligaría a inventarlo en cada caso.
 */
function entornoValido(): Record<string, string | undefined> {
  return {
    APP_ENTORNO: "local",
    DATABASE_URL_APP: "postgres://app_request:x@localhost:5432/admin_barrios",
    AUTH_PROVIDER: "dev-suplantacion",
  };
}

describe("la configuración válida se lee", () => {
  it("devuelve el entorno, la URL y el proveedor", () => {
    const config = leerConfiguracion(entornoValido());
    expect(config.entorno).toBe("local");
    expect(config.proveedorAuth).toBe("dev-suplantacion");
    expect(config.urlBaseApp).toContain("app_request");
  });

  it("sin variables de storage, `s3` queda en null y no es un error", () => {
    // Media configuración de storage es peor que ninguna; ninguna es un estado legítimo.
    expect(leerConfiguracion(entornoValido()).s3).toBeNull();
  });
});

describe("el proceso se niega si le falta configuración", () => {
  it.each([
    ["DATABASE_URL_APP", "urlBaseApp"],
    ["AUTH_PROVIDER", "proveedorAuth"],
    ["APP_ENTORNO", "entorno"],
  ])("sin %s no arranca, y el mensaje nombra el campo que falta", (variable, campo) => {
    const entorno = entornoValido();
    delete entorno[variable];
    expect(() => leerConfiguracion(entorno)).toThrow(new RegExp(campo));
  });

  it("un APP_ENTORNO que no existe se rechaza", () => {
    expect(() => leerConfiguracion({ ...entornoValido(), APP_ENTORNO: "casi-produccion" })).toThrow();
  });
});

describe("el proceso se niega si recibe una credencial que no le toca (cerrojo 5)", () => {
  /*
   * Estas dos son las que importan de verdad. `DATABASE_URL` es el dueño del esquema: puede llenar
   * `usuario_demo`, que **es** el candado del sustituto de identidad. Y `app_job` tiene `BYPASSRLS`:
   * con esa URL, las policies directamente no se evalúan y el aislamiento entre barrios desaparece.
   */
  it.each(["DATABASE_URL", "DATABASE_URL_JOB"])("con %s en el entorno, no atiende", (variable) => {
    expect(() => leerConfiguracion({ ...entornoValido(), [variable]: "postgres://quien_sea@x/y" })).toThrow(
      /no le corresponden/,
    );
  });

  it("el mensaje explica POR QUÉ esa credencial es peligrosa, no solo que sobra", () => {
    // Quien la puso creía que hacía falta. Un "variable no permitida" a secas se lee como burocracia
    // y termina en alguien renombrando la variable para esquivar el chequeo.
    expect(() => leerConfiguracion({ ...entornoValido(), DATABASE_URL: "postgres://x@y/z" })).toThrow(
      /dueño del esquema/,
    );
    expect(() => leerConfiguracion({ ...entornoValido(), DATABASE_URL_JOB: "postgres://x@y/z" })).toThrow(
      /BYPASSRLS/,
    );
  });

  it("declarada en vacío NO es una violación", () => {
    // Es el patrón "declarada pero apagada" de algunos orquestadores: la variable existe con valor
    // vacío y no aporta ninguna credencial. Tratarlo como violación rompe despliegues legítimos.
    expect(() => leerConfiguracion({ ...entornoValido(), DATABASE_URL: "" })).not.toThrow();
  });
});

describe("esEntornoLocal", () => {
  it("solo `local` es local — de esto depende que el sustituto de identidad exista", () => {
    expect(esEntornoLocal("local")).toBe(true);
    expect(esEntornoLocal("staging")).toBe(false);
    expect(esEntornoLocal("produccion")).toBe(false);
  });
});
