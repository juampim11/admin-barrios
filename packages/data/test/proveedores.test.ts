/**
 * El catálogo de proveedores: alta, corrección, desactivación (nunca borrado), y el `check` de CBU.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/proveedores.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import {
  corregirProveedor,
  desactivarProveedor,
  listarProveedores,
  reactivarProveedor,
  registrarProveedor,
} from "../src/servicios/proveedores.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> => conUsuario(db, usuario, fn);

/** Los campos opcionales, en `null`, para no repetirlos en cada llamada del archivo. */
const SIN_DATOS_OPCIONALES = { cuit: null, condicionFiscal: null, contacto: null, cbu: null, alias: null } as const;

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioB1.id);
});

afterEach(async () => {
  await admin.query("delete from proveedor where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
});

afterAll(async () => {
  await admin.query("delete from barrio_atributo_vigencia where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("delete from barrio where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("registrarProveedor()", () => {
  it("da de alta un proveedor con CBU válido", async () => {
    const p = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarProveedor(tx, {
        barrioId: arbol.barrioA1.id,
        razonSocial: "Plomería del Barrio SRL",
        cuit: "20-12345678-9",
        condicionFiscal: "Responsable Inscripto",
        contacto: "011-4444-5555",
        cbu: "0000000000000000000000",
        alias: "plomeria.barrio",
      }),
    );
    expect(p.razonSocial).toBe("Plomería del Barrio SRL");
    expect(p.activo).toBe(true);
  });

  it("rechaza un CBU que no tiene 22 dígitos, antes de llegar a la base (ZodError, no ErrorDeNegocio)", async () => {
    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        registrarProveedor(tx, { barrioId: arbol.barrioA1.id, razonSocial: "Otro", ...SIN_DATOS_OPCIONALES, cbu: "123" }),
      ),
    ).rejects.toThrow(/22 dígitos/);
  });

  it("dos proveedores con el mismo nombre en el mismo barrio: NO", async () => {
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarProveedor(tx, { barrioId: arbol.barrioA1.id, razonSocial: "Jardinería SA", ...SIN_DATOS_OPCIONALES }),
    );
    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        registrarProveedor(tx, { barrioId: arbol.barrioA1.id, razonSocial: "jardinería sa", ...SIN_DATOS_OPCIONALES }),
      ),
    );
    expect(err.codigo).toBe("dato_invalido");
  });
});

describe("aislamiento entre barrios", () => {
  it("un usuario de otro barrio no ve los proveedores de este", async () => {
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarProveedor(tx, { barrioId: arbol.barrioA1.id, razonSocial: "Solo de A1", ...SIN_DATOS_OPCIONALES }),
    );
    const lista = await como(arbol.usuarios.adminEstudioB, (tx) =>
      listarProveedores(tx, { barrioId: arbol.barrioA1.id }),
    );
    expect(lista).toEqual([]);
  });
});

describe("corregirProveedor() / desactivarProveedor() / reactivarProveedor()", () => {
  it("corrige los datos y se puede desactivar sin borrarse", async () => {
    const p = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarProveedor(tx, { barrioId: arbol.barrioA1.id, razonSocial: "A corregir", ...SIN_DATOS_OPCIONALES }),
    );
    const corregido = await como(arbol.usuarios.operadorA1, (tx) =>
      corregirProveedor(tx, {
        barrioId: arbol.barrioA1.id,
        proveedorId: p.id,
        razonSocial: "Ya corregido",
        ...SIN_DATOS_OPCIONALES,
        cuit: "20-1-1",
      }),
    );
    expect(corregido.razonSocial).toBe("Ya corregido");

    await como(arbol.usuarios.operadorA1, (tx) => desactivarProveedor(tx, { proveedorId: p.id }));
    const lista = await como(arbol.usuarios.operadorA1, (tx) =>
      listarProveedores(tx, { barrioId: arbol.barrioA1.id }),
    );
    const fila = lista.find((x) => x.id === p.id);
    expect(fila?.activo).toBe(false);
  });

  it("desactivar es reversible: reactivarProveedor() lo vuelve a poner activo", async () => {
    const p = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarProveedor(tx, { barrioId: arbol.barrioA1.id, razonSocial: "Va y vuelve", ...SIN_DATOS_OPCIONALES }),
    );

    await como(arbol.usuarios.operadorA1, (tx) => desactivarProveedor(tx, { proveedorId: p.id }));
    await como(arbol.usuarios.operadorA1, (tx) => reactivarProveedor(tx, { proveedorId: p.id }));

    const lista = await como(arbol.usuarios.operadorA1, (tx) =>
      listarProveedores(tx, { barrioId: arbol.barrioA1.id }),
    );
    const fila = lista.find((x) => x.id === p.id);
    expect(fila?.activo).toBe(true);
  });

  it("reactivar un proveedor de otro barrio (o inexistente) rechaza, no reactiva a ciegas", async () => {
    const p = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarProveedor(tx, { barrioId: arbol.barrioA1.id, razonSocial: "De A1", ...SIN_DATOS_OPCIONALES }),
    );
    const err = await capturar(() =>
      como(arbol.usuarios.adminEstudioB, (tx) => reactivarProveedor(tx, { proveedorId: p.id })),
    );
    expect(err.codigo).toBe("desconocido");
  });
});
