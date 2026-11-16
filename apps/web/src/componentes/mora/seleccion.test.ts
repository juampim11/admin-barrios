import { describe, expect, it } from "vitest";
import { agregarUnidades, alternarUnidad, aMandar, claveDeFiltro, elegidasVigentes, quitarUnidades, sinElegir } from "./seleccion.ts";

describe("la clave del filtro", () => {
  it("no depende del orden de los parámetros y deja afuera los vacíos", () => {
    expect(claveDeFiltro({ ver: "derivadas", barrio: "b1", estudio: null })).toBe("barrio=b1&ver=derivadas");
    expect(claveDeFiltro({ estudio: "", barrio: "b1", ver: "derivadas" })).toBe("barrio=b1&ver=derivadas");
  });

  it("cambia si cambia cualquiera de los filtros", () => {
    expect(claveDeFiltro({ barrio: "b1" })).not.toBe(claveDeFiltro({ barrio: "b2" }));
    expect(claveDeFiltro({ estudio: "sin" })).not.toBe(claveDeFiltro({}));
  });
});

describe("la elección pertenece al filtro (Aclade, seleccion-derivar)", () => {
  it("alternar suma y saca", () => {
    let e = sinElegir("k");
    e = alternarUnidad(e, "k", "u1");
    e = alternarUnidad(e, "k", "u2");
    expect([...elegidasVigentes(e, "k")]).toEqual(["u1", "u2"]);
    e = alternarUnidad(e, "k", "u1");
    expect([...elegidasVigentes(e, "k")]).toEqual(["u2"]);
  });

  it("cambiar de filtro la vacía, y volver al anterior no la trae de vuelta", () => {
    let e = agregarUnidades(sinElegir("a"), "a", ["u1", "u2"]);
    expect(elegidasVigentes(e, "b").size).toBe(0);
    // Elegir en el filtro nuevo arranca de cero: lo de «a» no se arrastra.
    e = alternarUnidad(e, "b", "u3");
    expect([...elegidasVigentes(e, "b")]).toEqual(["u3"]);
    expect(elegidasVigentes(e, "a").size).toBe(0);
  });

  it("una elegida que dejó de estar en el filtro deja de contar", () => {
    const e = agregarUnidades(sinElegir("k"), "k", ["u1", "u2"]);
    expect([...elegidasVigentes(e, "k", ["u2", "u3"])]).toEqual(["u2"]);
  });

  it("«elegir todas» no duplica las que ya estaban", () => {
    const e = agregarUnidades(alternarUnidad(sinElegir("k"), "k", "u1"), "k", ["u1", "u2"]);
    expect(elegidasVigentes(e, "k").size).toBe(2);
  });

  it("«Sacar estas unidades» saca solo esas", () => {
    const e = quitarUnidades(agregarUnidades(sinElegir("k"), "k", ["u1", "u2", "u3"]), "k", ["u2", "u9"]);
    expect([...elegidasVigentes(e, "k")]).toEqual(["u1", "u3"]);
  });

  it("se manda solo lo que el diálogo mostró y sigue elegido, en su orden", () => {
    expect(aMandar(["u3", "u1", "u2"], new Set(["u1", "u3", "u9"]))).toEqual(["u3", "u1"]);
  });
});
