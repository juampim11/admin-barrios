/**
 * El «Código para soporte» sale solo en un error inesperado (encargo 17b, punto 7f). El caso que lo
 * motivó: agregar una unidad con un número de acción que ya existe mostraba un código para dictar por
 * teléfono, como si el sistema hubiera fallado, cuando era un dato a corregir.
 */

import { describe, expect, it } from "vitest";
import { CODIGOS_ERROR, ErrorDeNegocio, paraMostrar } from "@admin-barrios/shared/errores";
import { muestraCodigoDeSoporte } from "./soporte.ts";

describe("cuándo se muestra el «Código para soporte»", () => {
  it("en un error inesperado, sí", () => {
    // Lo que no es un `ErrorDeNegocio` se degrada a `desconocido`.
    expect(muestraCodigoDeSoporte(paraMostrar(new Error("se cayó la base"), "web-1234abcd"))).toBe(true);
  });

  it("en el número de acción repetido, no", () => {
    const repetido = new ErrorDeNegocio({
      codigo: "numero_accion_repetido",
      mensaje: "Ya hay otra unidad del barrio con ese número de acción.",
      sugerencia: "El número de acción es único en el barrio.",
      correlacion: "0f8fad5b-d9cb-469f-a165-70867728950e",
    });
    expect(muestraCodigoDeSoporte(paraMostrar(repetido, "web-no-se-usa"))).toBe(false);
  });

  it("en ningún rechazo de negocio del catálogo: solo lo inesperado y lo que es del sistema lo muestra", () => {
    const loMuestran = CODIGOS_ERROR.filter((codigo) => muestraCodigoDeSoporte({ codigo, correlacion: "web-1234abcd" }));
    expect([...loMuestran].sort()).toEqual(["aplicacion_huerfana", "desconocido", "registro_inmutable", "subida_no_configurada"]);
  });

  it("sin identificador no hay nada que mostrar", () => {
    expect(muestraCodigoDeSoporte({ codigo: "desconocido", correlacion: "" })).toBe(false);
  });
});
