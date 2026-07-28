/**
 * La traducción de errores, sin base de datos: entra un error con forma de `pg`, sale un
 * `ErrorDeNegocio`.
 *
 * El test que más importa de este archivo es el último, y no verifica un caso: verifica **todas las
 * reglas a la vez**. Un catálogo con veintitantas entradas crece, y la forma de que una entrada nueva
 * filtre datos es tan chica —un `${e.message}` de más— que ninguna revisión la ve. El test le pasa a
 * cada regla un error envenenado y comprueba que nada del veneno salga en el texto.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { enBase, traducirError } from "./errores.ts";

/** Un error con la forma que expone `pg`. */
function errorPg(campos: {
  code?: string;
  constraint?: string;
  message?: string;
  detail?: string;
  table?: string;
}): Error {
  return Object.assign(new Error(campos.message ?? "error de base"), campos);
}

beforeEach(() => {
  // `traducirError` escribe el error original en el log del servidor, que es la contraparte de no
  // mostrarlo. Acá se silencia para que la salida del gate sea legible; que escriba se verifica abajo.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("traducirError", () => {
  it("un `ErrorDeNegocio` pasa de largo, sin envolverse dos veces", () => {
    const original = new ErrorDeNegocio({
      codigo: "periodo_no_encontrado",
      mensaje: "no existe",
      sugerencia: "volvé al listado",
      correlacion: "11111111-1111-4111-8111-111111111111",
    });
    expect(traducirError(original)).toBe(original);
  });

  it("encuentra el error de `pg` aunque venga anidado en `cause`", () => {
    // Drizzle puede envolver el error del driver, y una versión que hoy no envuelve puede envolver
    // mañana. Sin este recorrido, un cambio de versión degradaría TODAS las traducciones a
    // "desconocido" en silencio: el gate seguiría verde y las pantallas mostrarían el texto genérico.
    const envuelto = new Error("falló la consulta", {
      cause: new Error("capa intermedia", { cause: errorPg({ code: "23505", constraint: "uq_periodo_barrio" }) }),
    });
    expect(traducirError(envuelto).codigo).toBe("periodo_ya_existe");
  });

  it("el nombre del constraint gana sobre el SQLSTATE, porque es más preciso", () => {
    // Una violación de `uq_periodo_barrio` también es un 23505 genérico. El orden del catálogo
    // decide, y tiene que decidir a favor del mensaje que sabe de qué se trata.
    const especifico = traducirError(errorPg({ code: "23505", constraint: "uq_periodo_barrio" }));
    const generico = traducirError(errorPg({ code: "23505", constraint: "otro_indice_cualquiera" }));
    expect(especifico.codigo).toBe("periodo_ya_existe");
    expect(generico.codigo).toBe("dato_invalido");
  });

  it("un error desconocido no se inventa: texto genérico y código de correlación", () => {
    const e = traducirError(new Error("algo raro pasó en el driver"));
    expect(e.codigo).toBe("desconocido");
    expect(e.message).toBe("No se pudo completar la operación.");
    expect(e.message).not.toMatch(/driver|raro/);
    // El identificador aparece en la sugerencia porque es lo que la persona le pasa a soporte.
    expect(e.sugerencia).toContain(e.correlacion);
  });

  it("registra el error original en el log, con el mismo identificador que ve la persona", () => {
    const espia = vi.spyOn(console, "error");
    const e = traducirError(
      errorPg({ code: "23514", constraint: "cbu_aritmetica_chk", detail: "Failing row contains (…)" }),
    );
    const registrado = JSON.parse(String(espia.mock.calls[0]?.[0]));
    expect(registrado.correlacion).toBe(e.correlacion);
    expect(registrado.constraint).toBe("cbu_aritmetica_chk");
    expect(registrado.detalle).toBe("Failing row contains (…)");
    // No mostrarlo sin registrarlo no sería "no filtrar": sería esconder.
    expect(e.message).not.toContain("Failing row");
  });

  it("de un `raise exception` sale SOLO lo que la regla eligió mostrar", () => {
    const e = traducirError(
      errorPg({
        code: "P0001",
        message:
          "el período no cuadra (modelo variable): esperado 1077000.00 y repartido 1000000.00 (diferencia 77000.00)",
      }),
    );
    expect(e.codigo).toBe("periodo_no_cuadra");
    expect(e.datos).toEqual({ esperado: "1077000.00", repartido: "1000000.00", diferencia: "77000.00" });
    // Las cifras se muestran (son agregados que quien emite ya puede leer), el nombre técnico del
    // modelo no: no significa nada para quien mira la pantalla.
    expect(e.message).toContain("1077000.00");
  });

  it("traduce los rechazos de permiso a algo accionable", () => {
    const e = traducirError(
      errorPg({ code: "42501", message: 'new row violates row-level security policy for table "gasto_periodo"' }),
    );
    expect(e.codigo).toBe("sin_permiso");
    // El nombre de la tabla es plomería: no le dice nada a un administrador de consorcios.
    expect(e.message).not.toMatch(/row-level|gasto_periodo|policy/i);
    expect(e.sugerencia).toMatch(/rol|acceso/i);
  });

  it("`enBase` traduce lo que lanza adentro y deja pasar lo que devuelve", async () => {
    await expect(enBase(async () => 42)).resolves.toBe(42);
    await expect(
      enBase(async () => {
        throw errorPg({ code: "23505", constraint: "uq_cbu_descuento_unico" });
      }),
    ).rejects.toMatchObject({ codigo: "descuento_duplicado" });
  });
});

describe("ninguna regla filtra datos del error original", () => {
  /**
   * Los mensajes reales de cada regla del catálogo, uno por uno.
   *
   * Se escriben acá **a mano y copiados de las migraciones** en vez de exportar el catálogo y
   * recorrerlo: un test que recorre la misma estructura que prueba pasa siempre, porque un patrón que
   * cambió sigue matcheando su propio mensaje. Esta lista es una segunda fuente, y si alguien cambia
   * un `raise exception` sin actualizarla, el caso cae a "desconocido" y el test lo dice.
   */
  const MENSAJES_REALES = [
    "el período ya está emitida : no se edita (se corrige en el período siguiente)",
    "no se pudo determinar el período de la fila: se rechaza por seguridad",
    "transición de estado inválida: emitida → borrador",
    "la versión de coeficientes del período no está cerrada",
    "el período no tiene versión de coeficientes: no se puede emitir",
    "el período no cuadra (modelo variable): esperado 100.00 y repartido 90.00 (diferencia 10.00)",
    "el período no cuadra: hay liquidaciones cuyos subtotales no coinciden con sus líneas",
    "faltan liquidaciones: 4 unidades activas y 3 liquidaciones",
    "faltan 2 cuotas fijas: hay unidades activas sin importe asignado",
    "hay 3 conceptos aplicados sin resolver: el período no se puede emitir",
    "hay unidades cuyo neto del período quedaría negativo",
    "el concepto de boleta no existe",
    'el concepto "Bonificación" no tiene valor vigente al 2026-01-01: cargá el valor antes de aplicarlo',
    'el concepto "Multa reservada" solo lo puede aplicar un administrador del barrio',
    "el barrio no tiene límite de aplicación vigente: un operador no puede aplicar descuentos",
    "el descuento puede llegar a 50000.00 y el tope del operador es 10000.00: lo tiene que aplicar un administrador",
    "el porcentaje 30.000000 supera el máximo del operador (12.000000 %)",
    "los descuentos de esta unidad en el período ya suman hasta 16000.00 y el tope del operador es 10000.00",
    "una aplicación no se edita: se anula (con motivo) y se crea otra",
    "una anulación no se revierte",
    'la unidad 1-3 tiene aplicado "Quincho" pero no se le liquidó nada (¿dada de baja?): anulá la aplicación',
    "el tope es el techo de un descuento: en un cargo recortaría lo que hay que cobrar",
    "no tenés permiso para liquidar este período",
    "no hay usuario en la sesión: una aplicación sin autor no se registra",
    // Los dos controles anti-adulteración de `app.validar_aplicaciones` (0017 §8): son el evento más
    // grave que el módulo puede detectar y caían a "No se pudo completar la operación."
    "hay 3 descuentos calculados sobre una base que no es la de su liquidación",
    "hay 2 aplicaciones cuyo importe no coincide con el valor aprobado del catálogo",
    "el período liquida por cuota fija pero no tiene una versión de cuota asignada",
    "un período nace en borrador (llegó en emitida): emitir es una transición, no un estado inicial",
    "el registro de eventos es append-only: no se modifica ni se borra",
    // Migración 0021.
    "el motivo de una anulación no se reescribe: quedó registrado el 2026-07-28 y es la única explicación",
    // Migración 0020.
    "el mandato tiene que apuntar a un nodo de tipo administrador (llegó barrio)",
    "el administrador del mandato tiene que ser un ancestro del barrio: administrar un barrio de otro árbol",
    "no se pudo resolver el nodo del mandato: se rechaza por seguridad",
    // Migración 0023.
    "el período no existe o no es de este barrio",
    "la unidad no existe o no es de este barrio",
    "el período no es del mismo barrio que el concepto elegido",
    "la unidad no es del mismo barrio que el concepto elegido",
  ];

  const CONSTRAINTS_REALES = [
    "uq_periodo_barrio",
    "uq_cbu_descuento_unico",
    "uq_concepto_boleta_barrio_nombre",
    "uq_concepto_barrio_nombre",
    "cbv_tope_obligatorio_chk",
    "concepto_boleta_valor_parametro_chk",
    "fk_cbu_periodo_barrio",
    "fk_cbu_uf_barrio",
    "fk_gasto_concepto_barrio",
    "fk_gasto_acta_barrio",
    "fk_gasto_periodo_barrio",
    "uq_concepto_boleta_valor_abierta",
    "uq_liquidacion_periodo_uf",
  ];

  /** Todo lo que un error de Postgres puede traer y que NUNCA puede llegar a una pantalla. */
  const VENENO = {
    detail:
      "Key (barrio_id, periodo)=(3f2b1a00-0000-4000-8000-000000000009, 2026-05) already exists. " +
      "Failing row contains (Juan Pérez, 8.500.000,00, jubilado).",
    table: "concepto_boleta_unidad",
  };

  it.each(MENSAJES_REALES)("no filtra el detail ni la tabla: %s", (mensaje) => {
    const e = traducirError(errorPg({ code: "P0001", message: mensaje, ...VENENO }));
    expect(e.message).not.toContain("Juan Pérez");
    expect(e.message).not.toContain("jubilado");
    expect(e.message).not.toContain("8.500.000,00");
    expect(e.message).not.toContain("already exists");
    expect(e.message).not.toContain(VENENO.table);
    expect(e.sugerencia).not.toContain("Juan Pérez");
    // Y ninguno cae a "desconocido": si cayera, el mensaje de la migración cambió y la regla quedó
    // huérfana — la pantalla mostraría un texto genérico sin que nadie se entere.
    expect(e.codigo).not.toBe("desconocido");
  });

  it.each(CONSTRAINTS_REALES)("no filtra el detail cuando matchea por constraint: %s", (constraint) => {
    const e = traducirError(errorPg({ code: "23505", constraint, ...VENENO }));
    expect(e.message).not.toContain("Juan Pérez");
    expect(e.message).not.toContain("already exists");
    // El nombre del constraint tampoco: es plomería, y encima le dice a un atacante cómo se llama
    // cada candado del esquema.
    expect(e.message).not.toContain(constraint);
    expect(e.codigo).not.toBe("desconocido");
  });

  it("hasta el caso desconocido, con veneno adentro, sale limpio", () => {
    const e = traducirError(errorPg({ code: "XX000", message: "internal error: Juan Pérez", ...VENENO }));
    expect(e.codigo).toBe("desconocido");
    expect(`${e.message} ${e.sugerencia}`).not.toContain("Juan Pérez");
  });
});
