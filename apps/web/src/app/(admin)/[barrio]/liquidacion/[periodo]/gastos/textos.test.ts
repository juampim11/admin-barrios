import { describe, expect, it } from "vitest";
import type { Falta } from "@admin-barrios/data/servicios/circuito-del-mes";
import { avisosDeRubrosExcedidos, conSigno, marcaDelRubro } from "./textos.ts";

describe("los textos de gastos contra presupuesto", () => {
  it("el signo menos va delante del signo pesos", () => {
    expect(conSigno("-270000.00")).toEqual({ texto: "− $ 270.000,00", negativo: true });
    expect(conSigno("37700.00")).toEqual({ texto: "$ 37.700,00", negativo: false });
    expect(conSigno("0.00")).toEqual({ texto: "$ 0,00", negativo: false });
    expect(conSigno("-0.00")).toEqual({ texto: "$ 0,00", negativo: false });
  });

  it("la marca de la fila: se pasó, sin cargar o nada", () => {
    expect(marcaDelRubro({ presupuesto: "1350000.00", gastado: "1620000.00", excedido: true })).toEqual({ tono: "peligro", texto: "Se pasó" });
    expect(marcaDelRubro({ presupuesto: "300000.00", gastado: "0.00", excedido: false })).toEqual({ tono: "neutro", texto: "Sin cargar" });
    expect(marcaDelRubro({ presupuesto: "450000.00", gastado: "412300.00", excedido: false })).toBeNull();
    // Sin presupuesto no es «sin cargar»: es un gasto fuera del presupuesto.
    expect(marcaDelRubro({ presupuesto: null, gastado: "0.00", excedido: false })).toBeNull();
  });

  it("de los avisos del mes, solo el del rubro que se pasó", () => {
    const avisos: Falta[] = [
      { tipo: "avisa", titulo: "1 orden de pago sin aprobar por $ 10,00", detalle: "", donde: "ordenes" },
      { tipo: "avisa", titulo: "1 gasto extraordinario sin respaldo de asamblea · $ 5,00", detalle: "", donde: "gastos" },
      { tipo: "avisa", titulo: "Mantenimiento se pasó $ 270.000,00 del presupuesto", detalle: "El último gasto…", donde: "gastos", clase: "presupuesto" },
      // Un título parecido sin la marca no es un aviso del presupuesto.
      { tipo: "avisa", titulo: "Seguros se pasó $ 1,00 del presupuesto", detalle: "", donde: "gastos" },
    ];
    expect(avisosDeRubrosExcedidos(avisos).map((a) => a.titulo)).toEqual(["Mantenimiento se pasó $ 270.000,00 del presupuesto"]);
    expect(avisosDeRubrosExcedidos(avisos.slice(0, 2))).toEqual([]);
  });
});
