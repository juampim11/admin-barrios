import { describe, expect, it } from "vitest";
import {
  CLAUSULAS_BORRADOR,
  completarClausula,
  guardarModeloDeClausulasSchema,
  NOMBRES_DE_VARIABLES,
  variablesDesconocidas,
} from "./planes-documentos.ts";

const VALORES = Object.fromEntries(NOMBRES_DE_VARIABLES.map((n) => [n, `<${n}>`])) as Record<(typeof NOMBRES_DE_VARIABLES)[number], string>;
const ID = "11111111-1111-4111-8111-111111111111";

describe("las cláusulas", () => {
  it("el borrador son las tres del encargo y solo usa variables que existen", () => {
    expect(CLAUSULAS_BORRADOR.map((c) => c.titulo)).toEqual([
      "El plan no reemplaza la deuda original",
      "La quita depende de cumplir el plan",
      "Si el plan cae, tiene su cargo",
    ]);
    expect(CLAUSULAS_BORRADOR.flatMap((c) => variablesDesconocidas(c.texto))).toEqual([]);
  });

  it("completa las variables y deja lo demás como está", () => {
    expect(completarClausula("Debe {deuda} y cae con {cuotasParaCaer}; {nada} y {}", VALORES)).toBe("Debe <deuda> y cae con <cuotasParaCaer>; {nada} y {}");
    // Lo que existe en el prototipo de un objeto no es una variable (code-reviewer).
    expect(completarClausula("{constructor} {toString}", VALORES)).toBe("{constructor} {toString}");
    expect(variablesDesconocidas("{constructor} y {hasOwnProperty}")).toEqual(["constructor", "hasOwnProperty"]);
  });

  it("al guardar, una variable que no existe se rechaza con su nombre y la lista de las que hay", () => {
    const r = guardarModeloDeClausulasSchema.safeParse({
      modeloId: ID,
      clausulas: JSON.stringify([{ titulo: "Pago", texto: "Paga {monto} por {unidad}." }]),
      textoValidado: "no",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/^La cláusula 1 usa \{monto\}, que no es una de las variables\. Las que hay: \{barrio\}/);
  });

  it("al guardar, el JSON de las cláusulas y el sí/no llegan como los manda el formulario", () => {
    const r = guardarModeloDeClausulasSchema.parse({ modeloId: ID, clausulas: JSON.stringify([{ titulo: " A ", texto: " B " }]), textoValidado: "si" });
    expect(r).toEqual({ modeloId: ID, clausulas: [{ titulo: "A", texto: "B" }], textoValidado: true });
    expect(guardarModeloDeClausulasSchema.safeParse({ modeloId: ID, clausulas: "[]", textoValidado: "no" }).success).toBe(false);
    expect(guardarModeloDeClausulasSchema.safeParse({ modeloId: ID, clausulas: "no es json", textoValidado: "no" }).success).toBe(false);
  });
});
