/**
 * F4 tramo 4 (BL-055 g): ningún selector de mora o planes devuelve el texto de Zod en inglés. Un caso por
 * mensaje: un valor que no es de la lista tiene que dar la frase en castellano del campo.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  agregarEstudioSchema,
  criterioAdministracionSchema,
  derivarSchema,
  estudioDelBarrioSchema,
  moraBarrioSchema,
  retirarSchema,
} from "./mora.ts";
import { proponerPlanAMedidaSchema, proponerPlanDeCatalogoSchema } from "./planes.ts";
import { prepararSubidaDeRendicionSchema } from "./planes-rendicion.ts";

const ID = "8f2b1a8e-7c1d-4f5a-9b3e-2d4c6a8e0f11";

/** El mensaje que Zod da para `campo` con esta entrada. */
function mensaje(esquema: z.ZodTypeAny, entrada: Record<string, unknown>, campo: string): string | undefined {
  const r = esquema.safeParse(entrada);
  return r.success ? undefined : r.error.issues.find((i) => i.path.join(".") === campo)?.message;
}

describe("los selectores dicen qué elegir, en castellano", () => {
  const casos: readonly [string, z.ZodTypeAny, Record<string, unknown>, string, string][] = [
    ["retirar del estudio sin motivo", retirarSchema, { derivacionId: ID, motivo: "" }, "motivo", "Elegí el motivo."],
    ["derivar sin motivo", derivarSchema, { unidades: [{ unidadFuncionalId: ID, barrioId: ID, estudioId: ID }], motivo: "x" }, "motivo", "Elegí el motivo."],
    [
      "cuándo se le avisa al estudio",
      agregarEstudioSchema,
      { administracionId: ID, nombre: "E", cuit: "30710000162", correoAvisos: "a@b.co", preferenciaAviso: "x" },
      "preferenciaAviso",
      "Elegí cuándo le avisamos al estudio.",
    ],
    ["pedir la intimación", criterioAdministracionSchema, { administracionId: ID, pedirIntimacion: "x" }, "pedirIntimacion", "Elegí si se pide la intimación."],
    ["el criterio del barrio", moraBarrioSchema, { barrioId: ID, criterio: "x" }, "criterio", "Elegí qué criterio usa el barrio."],
    [
      "el pacto de ejecutividad",
      moraBarrioSchema,
      { barrioId: ID, pactoEjecutividad: "x" },
      "pactoEjecutividad",
      "Elegí qué dice el reglamento sobre la vía ejecutiva.",
    ],
    ["el aviso de la boleta", moraBarrioSchema, { barrioId: ID, aviso: "x" }, "aviso", "Elegí qué aviso va en la boleta."],
    ["qué hacer con el estudio del barrio", estudioDelBarrioSchema, { barrioId: ID, estudioId: ID, accion: "x" }, "accion", "Elegí qué hacer con el estudio."],
    ["quién cobra un plan del catálogo", proponerPlanDeCatalogoSchema, { modoCobro: "x" }, "modoCobro", "Elegí quién cobra."],
    ["quién cobra un plan a medida", proponerPlanAMedidaSchema, { modoCobro: "x" }, "modoCobro", "Elegí quién cobra."],
    ["qué archivo de la rendición se sube", prepararSubidaDeRendicionSchema, { rendicionId: ID, para: "x" }, "para", "Elegí qué archivo se sube."],
    ["el tipo del archivo de la rendición", prepararSubidaDeRendicionSchema, { rendicionId: ID, contentType: "x" }, "contentType", "El archivo tiene que ser PDF, JPG o PNG."],
  ];
  it.each(casos)("%s", (_nombre, esquema, entrada, campo, esperado) => {
    expect(mensaje(esquema, entrada, campo)).toBe(esperado);
  });
});
