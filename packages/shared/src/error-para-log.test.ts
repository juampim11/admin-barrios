import { describe, expect, it } from "vitest";
import { describirErrorParaLog } from "./error-para-log.ts";

/** Un error con la forma de los de `pg`/`net`: lleva la conexión pegada. */
const deConexion = () =>
  Object.assign(new Error("connect ECONNREFUSED 10.9.8.7:5999"), {
    code: "ECONNREFUSED",
    address: "10.9.8.7",
    port: 5999,
    client: { user: "rol_secreto", password: "clave_secreta", host: "bd.interna.example", database: "admin_barrios" },
    user: "rol_secreto",
    password: "clave_secreta",
    host: "bd.interna.example",
  });

describe("describirErrorParaLog: la línea de log no lleva datos de la conexión", () => {
  it("deja el nombre, el mensaje y el código, y saca dirección, puerto, usuario, contraseña y host", () => {
    const linea = describirErrorParaLog(deConexion());
    expect(linea).toContain("ECONNREFUSED");
    expect(linea).not.toMatch(/10\.9\.8\.7|5999|rol_secreto|clave_secreta|bd\.interna|admin_barrios/);
  });

  it("sigue los errores de un AggregateError (Node prueba IPv6 e IPv4) y la causa", () => {
    const a = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED", address: "127.0.0.1", port: 5432 });
    const agregado = new AggregateError([a], "");
    const conCausa = new Error("falló la consulta", { cause: deConexion() });
    expect(describirErrorParaLog(agregado)).not.toMatch(/127\.0\.0\.1|5432/);
    expect(describirErrorParaLog(agregado)).toContain("ECONNREFUSED");
    expect(describirErrorParaLog(conCausa)).not.toMatch(/10\.9\.8\.7|5999|clave_secreta/);
  });

  it("saca una URL de conexión que haya quedado en un mensaje, también en la pila", () => {
    const e = new Error("no se pudo abrir postgres://usuario:clave_secreta@bd.interna.example:5432/admin_barrios");
    expect(describirErrorParaLog(e, { pila: true })).not.toMatch(/clave_secreta|bd\.interna|usuario:/);
  });

  it("con `pila: true` conserva la pila, y sin ella es una sola línea", () => {
    const e = new Error("algo falló");
    expect(describirErrorParaLog(e, { pila: true })).toContain("algo falló");
    expect(describirErrorParaLog(e, { pila: true })).toContain("\n");
    expect(describirErrorParaLog(e)).toBe("Error: algo falló");
  });

  it("lo que no es un Error no se vuelca: un string se limpia y un objeto se nombra por su tipo", () => {
    expect(describirErrorParaLog("falló postgres://u:p@h/x")).not.toContain("u:p");
    expect(describirErrorParaLog({ password: "clave_secreta" })).toBe("(valor que no es un Error: object)");
  });
});

describe("describirErrorParaLog: lo que el servidor de Postgres pone en sus mensajes", () => {
  it("los mensajes de autenticación y de acceso no llevan el usuario, la base ni el host", () => {
    const casos = [
      Object.assign(new Error('password authentication failed for user "app_job"'), { code: "28P01" }),
      Object.assign(new Error('role "app_job" does not exist'), { code: "28000" }),
      Object.assign(new Error('database "admin_barrios" does not exist'), { code: "3D000" }),
      Object.assign(new Error('no pg_hba.conf entry for host "2001:db8::1", user "app_job", database "admin_barrios", SSL off'), { code: "28000" }),
    ];
    for (const e of casos) expect(describirErrorParaLog(e)).not.toMatch(/app_job|admin_barrios|2001:db8/);
    expect(describirErrorParaLog(casos[0]!)).toContain("(28P01)");
  });

  it("IPv6 con puerto, los altnames de un certificado y una fecha con horas (que no es una dirección)", () => {
    expect(describirErrorParaLog(new Error("connect ECONNREFUSED [::1]:5432"))).not.toMatch(/::1|5432/);
    expect(describirErrorParaLog(new Error("connect ECONNREFUSED ::1:5432"))).not.toMatch(/::1|5432/);
    expect(describirErrorParaLog(new Error("Host: x. is not in the cert's altnames: DNS:db.interna.example"))).not.toContain("db.interna");
    expect(describirErrorParaLog(new Error("falló a las 10:30:45 del 2026-11-20"))).toContain("10:30:45");
  });
});
