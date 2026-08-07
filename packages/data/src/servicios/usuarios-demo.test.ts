/**
 * La codificación del rol dentro de `descripcion` (`"Rol — qué ve y qué no"`).
 *
 * Es un test barato de una convención que no lo era: hasta acá el formato se escribía a mano en el
 * seed y se parseaba a mano en la pantalla, en paquetes distintos, sin una sola aserción. Lo que se
 * fija son los **bordes**, que es donde una convención de texto se rompe sin romper nada visible:
 * separadores parecidos, mitades vacías y el ida y vuelta.
 *
 * No hay base de datos acá: `armarDescripcion` y `partirDescripcion` son puras.
 */

import { describe, expect, it } from "vitest";
import { armarDescripcion, partirDescripcion } from "./usuarios-demo.ts";

describe("armarDescripcion", () => {
  it("pega rol y alcance con la raya entre espacios", () => {
    expect(armarDescripcion({ rol: "Contadora", alcance: "Consulta y exporta." })).toBe(
      "Contadora — Consulta y exporta.",
    );
  });

  it("falla ruidoso si falta una de las dos mitades: mejor romper el seed que mostrar mal", () => {
    expect(() => armarDescripcion({ rol: "", alcance: "Algo" })).toThrow(/rol y alcance/);
    expect(() => armarDescripcion({ rol: "   ", alcance: "Algo" })).toThrow(/rol y alcance/);
    expect(() => armarDescripcion({ rol: "Operador", alcance: "" })).toThrow(/rol y alcance/);
  });

  it("falla si el rol trae la raya adentro, porque rompería el ida y vuelta", () => {
    expect(() => armarDescripcion({ rol: "Auditor — externo", alcance: "Solo mira." })).toThrow(
      /separador/,
    );
  });
});

describe("partirDescripcion", () => {
  it("ida y vuelta: lo que arma el seed es exactamente lo que lee la pantalla", () => {
    const partes = { rol: "Administradora", alcance: "Ve todos los barrios del estudio." };
    expect(partirDescripcion(armarDescripcion(partes))).toEqual(partes);
  });

  it("corta en la PRIMERA raya: las que sigan son parte del alcance", () => {
    expect(partirDescripcion("Operador — Carga gastos — y nada más.")).toEqual({
      rol: "Operador",
      alcance: "Carga gastos — y nada más.",
    });
  });

  it("sin raya no hay rol, y el texto entero es el alcance", () => {
    expect(partirDescripcion("Una descripción vieja, sin ninguna convención.")).toEqual({
      rol: null,
      alcance: "Una descripción vieja, sin ninguna convención.",
    });
  });

  it("el guión común `-` y el guión medio `–` NO son separadores, aunque se parezcan a ojo", () => {
    // El caso que importa de verdad: un alcance con un guión no puede inventar un rol.
    expect(partirDescripcion("Operador - Carga gastos.")).toEqual({
      rol: null,
      alcance: "Operador - Carga gastos.",
    });
    expect(partirDescripcion("Operador – Carga gastos.")).toEqual({
      rol: null,
      alcance: "Operador – Carga gastos.",
    });
  });

  it("raya al principio: no hay rol, y no se devuelve uno vacío que pinte un chip en blanco", () => {
    expect(partirDescripcion(" — Solo el alcance.")).toEqual({
      rol: null,
      alcance: " — Solo el alcance.",
    });
    // Sin el espacio de la izquierda ni siquiera es el separador.
    expect(partirDescripcion("— Solo el alcance.")).toEqual({
      rol: null,
      alcance: "— Solo el alcance.",
    });
  });

  it("raya al final: tampoco alcanza, y la línea se muestra entera", () => {
    expect(partirDescripcion("Contadora — ")).toEqual({ rol: null, alcance: "Contadora — " });
  });

  it("descripción vacía: sin rol y sin alcance, sin explotar", () => {
    expect(partirDescripcion("")).toEqual({ rol: null, alcance: "" });
  });
});
