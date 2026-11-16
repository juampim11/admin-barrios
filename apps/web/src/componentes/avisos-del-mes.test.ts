import { describe, expect, it } from "vitest";
import type { Falta } from "@admin-barrios/data/servicios/circuito-del-mes";
import { avisosDeUnMesEmitido } from "./avisos-del-mes.ts";

describe("los avisos de un mes emitido", () => {
  it("quedan los de los gastos; se van los que hablan del antes de emitir y lo que bloquea", () => {
    const faltas: Falta[] = [
      { tipo: "bloquea", titulo: "No cuadra", detalle: "", donde: "boletas" },
      { tipo: "avisa", titulo: "1 orden de pago sin aprobar por $ 10,00", detalle: "", donde: "ordenes" },
      { tipo: "avisa", titulo: "El mes no tiene vencimiento", detalle: "", donde: "vencimientos" },
      { tipo: "avisa", titulo: "Mantenimiento se pasó $ 270.000,00 del presupuesto", detalle: "", donde: "gastos" },
      { tipo: "avisa", titulo: "1 gasto extraordinario sin respaldo de asamblea · $ 5,00", detalle: "", donde: "gastos" },
    ];
    expect(avisosDeUnMesEmitido(faltas).map((f) => f.titulo)).toEqual([
      "Mantenimiento se pasó $ 270.000,00 del presupuesto",
      "1 gasto extraordinario sin respaldo de asamblea · $ 5,00",
    ]);
  });
});
