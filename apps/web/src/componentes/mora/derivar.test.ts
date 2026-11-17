import { describe, expect, it } from "vitest";
import {
  agruparPorBarrio,
  estudioDe,
  estudioInicial,
  motivoParaNoDerivar,
  porEstudio,
  sinIntimacion,
  textoDeLosCorreos,
  type BarrioParaDerivar,
  type ElegibleMora,
} from "./derivar.ts";

// Nombres genéricos a propósito: nada del piloto (CLAUDE.md §1.6).
const AROMOS: BarrioParaDerivar = {
  id: "b-aromos",
  nombre: "Los Aromos",
  pedirIntimacion: true,
  estudios: [
    { id: "e-demo", nombre: "Estudio Demo", porDefecto: true },
    { id: "e-ejemplo", nombre: "Estudio Ejemplo", porDefecto: false },
  ],
};
const CORTADERAS: BarrioParaDerivar = {
  id: "b-cortaderas",
  nombre: "Las Cortaderas",
  pedirIntimacion: false,
  estudios: [{ id: "e-demo", nombre: "Estudio Demo", porDefecto: false }],
};
const SAN_JORGE: BarrioParaDerivar = { id: "b-jorge", nombre: "San Jorge", pedirIntimacion: true, estudios: [] };
const DOS_SIN_DEFECTO: BarrioParaDerivar = {
  id: "b-dos",
  nombre: "Dos Estudios",
  pedirIntimacion: false,
  estudios: [
    { id: "e-a", nombre: "A", porDefecto: false },
    { id: "e-b", nombre: "B", porDefecto: false },
  ],
};

const u = (id: string, barrioId: string, conIntimacion = true): ElegibleMora => ({
  id,
  barrioId,
  unidad: `Unidad ${id}`,
  meses: 4,
  conIntimacion,
});

describe("el agrupado por barrio", () => {
  it("agrupa en el orden de los barrios y deja afuera los barrios sin elegidas", () => {
    const grupos = agruparPorBarrio([u("1", "b-cortaderas"), u("2", "b-aromos"), u("3", "b-aromos")], [AROMOS, CORTADERAS, SAN_JORGE]);
    expect(grupos.map((g) => [g.barrio.nombre, g.unidades.map((x) => x.id)])).toEqual([
      ["Los Aromos", ["2", "3"]],
      ["Las Cortaderas", ["1"]],
    ]);
  });

  it("una elegida de un barrio que no está en la lista no aparece", () => {
    expect(agruparPorBarrio([u("1", "b-otro")], [AROMOS])).toEqual([]);
  });
});

describe("el estudio de cada grupo", () => {
  it("viene elegido el de por defecto; con uno solo, ese; con varios sin por defecto, ninguno", () => {
    expect(estudioInicial(AROMOS)).toBe("e-demo");
    expect(estudioInicial(CORTADERAS)).toBe("e-demo");
    expect(estudioInicial(DOS_SIN_DEFECTO)).toBeNull();
    expect(estudioInicial(SAN_JORGE)).toBeNull();
  });

  it("lo que elige la persona gana, pero solo si es un estudio de ese barrio", () => {
    expect(estudioDe(AROMOS, { "b-aromos": "e-ejemplo" })).toBe("e-ejemplo");
    // Un estudio que no trabaja en el barrio no vale, y no vuelve solo al inicial: queda bloqueado.
    expect(estudioDe(CORTADERAS, { "b-cortaderas": "e-ejemplo" })).toBeNull();
  });

  it("volver al «Elegí el estudio» deja el grupo sin estudio y bloquea", () => {
    expect(estudioDe(AROMOS, { "b-aromos": "" })).toBeNull();
    const grupos = agruparPorBarrio([u("1", "b-aromos")], [AROMOS]);
    expect(motivoParaNoDerivar(grupos, { "b-aromos": "" })).toBe("Elegí el estudio de Los Aromos.");
  });
});

describe("qué falta para derivar", () => {
  it("un barrio sin estudios bloquea, y lo dice", () => {
    const grupos = agruparPorBarrio([u("1", "b-aromos"), u("2", "b-jorge")], [AROMOS, SAN_JORGE]);
    expect(motivoParaNoDerivar(grupos, {})).toMatch(/^San Jorge no tiene ningún estudio/);
  });

  it("un barrio con varios estudios y ninguno elegido pide elegir", () => {
    const grupos = agruparPorBarrio([u("1", "b-dos")], [DOS_SIN_DEFECTO]);
    expect(motivoParaNoDerivar(grupos, {})).toBe("Elegí el estudio de Dos Estudios.");
    expect(motivoParaNoDerivar(grupos, { "b-dos": "e-b" })).toBeNull();
  });

  it("sin elegidas no se deriva", () => {
    expect(motivoParaNoDerivar([], {})).not.toBeNull();
  });
});

describe("los correos y la intimación", () => {
  const grupos = agruparPorBarrio(
    [u("1", "b-aromos", false), u("2", "b-aromos"), u("3", "b-cortaderas", false)],
    [AROMOS, CORTADERAS],
  );

  it("cuenta por estudio cuántas unidades recibe y de cuántos barrios", () => {
    expect(porEstudio(grupos, {})).toEqual([{ estudioId: "e-demo", estudio: "Estudio Demo", unidades: 3, barrios: 2 }]);
    expect(porEstudio(grupos, { "b-aromos": "e-ejemplo" })).toEqual([
      { estudioId: "e-ejemplo", estudio: "Estudio Ejemplo", unidades: 2, barrios: 1 },
      { estudioId: "e-demo", estudio: "Estudio Demo", unidades: 1, barrios: 1 },
    ]);
  });

  it("dice que hoy no sale ningún correo, y lo que diría cada uno", () => {
    const texto = textoDeLosCorreos(porEstudio(grupos, { "b-aromos": "e-ejemplo" }));
    expect(texto).toBe("Los avisos por correo al estudio todavía no salen: avisale vos (Estudio Ejemplo, 2 unidades; Estudio Demo, 1 unidad).");
    expect(textoDeLosCorreos(porEstudio(grupos, {}))).toContain("(Estudio Demo, 3 unidades de 2 barrios)");
  });

  it("cuenta las elegidas sin intimación solo en los barrios cuyo criterio la pide", () => {
    // La 1 (Aromos, pide) cuenta; la 3 (Cortaderas, no pide) no.
    expect(sinIntimacion(grupos)).toBe(1);
  });
});
