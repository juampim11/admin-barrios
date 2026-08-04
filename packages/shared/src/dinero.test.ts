import { describe, expect, it } from "vitest";
import {
  aCentavos,
  coeficienteAEntero,
  deCentavos,
  enmascararMontoTipeado,
  montoSchema,
  normalizarMontoTipeado,
  prorratear,
  prorratearDetallado,
  restarMontos,
  sumarMontos,
} from "./dinero.ts";

describe("montos exactos", () => {
  it("no pierde precisión donde el float fallaría", () => {
    // 0.1 + 0.2 === 0.30000000000000004 con number; acá tiene que dar exacto.
    expect(sumarMontos("0.10", "0.20")).toBe("0.30");
  });

  it("ida y vuelta a centavos", () => {
    expect(aCentavos("1234.56")).toBe(123456n);
    expect(aCentavos("-8.00")).toBe(-800n);
    expect(deCentavos(123456n)).toBe("1234.56");
    expect(deCentavos(-5n)).toBe("-0.05");
    expect(deCentavos(0n)).toBe("0.00");
  });

  it("rechaza formatos ambiguos", () => {
    expect(() => aCentavos("1234.5")).toThrow();
    expect(() => aCentavos("1.234,56")).toThrow();
    expect(() => aCentavos("1234")).toThrow();
  });

  it("suma y resta grandes sin desbordar", () => {
    expect(sumarMontos("99999999.99", "0.01")).toBe("100000000.00");
    expect(restarMontos("100.00", "133.33")).toBe("-33.33");
  });
});

describe("prorrateo por coeficiente", () => {
  it("reparte proporcionalmente", () => {
    const partes = prorratear("1000.00", [
      ["uf-1", "0.50"],
      ["uf-2", "0.50"],
    ]);
    expect(partes).toEqual([
      ["uf-1", "500.00"],
      ["uf-2", "500.00"],
    ]);
  });

  it("la suma de las partes SIEMPRE cierra igual al total (resto a la última)", () => {
    const total = "1000.00";
    const partes = prorratear(total, [
      ["uf-1", "0.333333"],
      ["uf-2", "0.333333"],
      ["uf-3", "0.333334"],
    ]);
    expect(sumarMontos(...partes.map(([, m]) => m))).toBe(total);
  });

  it("cierra también con muchas unidades y coeficientes despapadejos", () => {
    const coefs = Array.from({ length: 47 }, (_, i) => [`uf-${i}`, `0.0${(i % 7) + 1}`] as const);
    const partes = prorratear("123456.78", coefs);
    expect(sumarMontos(...partes.map(([, m]) => m))).toBe("123456.78");
  });

  it("soporta prorrateo no proporcional (pesos arbitrarios, no porcentajes)", () => {
    // Coeficientes por superficie: 120 m2 vs 80 m2 sobre un total de 200.
    const partes = prorratear("500.00", [
      ["uf-1", "120"],
      ["uf-2", "80"],
    ]);
    expect(partes).toEqual([
      ["uf-1", "300.00"],
      ["uf-2", "200.00"],
    ]);
  });

  it("no acepta repartir entre nadie ni con coeficientes en cero", () => {
    expect(() => prorratear("100.00", [])).toThrow();
    expect(() => prorratear("100.00", [["uf-1", "0"]])).toThrow();
  });
});

describe("prorrateo detallado: lo que se cobra y lo que da la calculadora", () => {
  it("el teórico se calcula sobre la SUMA de coeficientes, no sobre una escala fija", () => {
    // Coeficientes como pesos relativos (art. 2081: superficie/lote/mixto NO suman 1).
    // Este es el caso que estaba mal: dividir por una escala fija daba $29.700 en vez de $297.
    const partes = prorratearDetallado("900.00", [
      ["uf-1", "33.0"],
      ["uf-2", "33.0"],
      ["uf-3", "34.0"],
    ]);
    expect(partes.map((p) => p.monto)).toEqual(["297.00", "297.00", "306.00"]);
    expect(partes.map((p) => p.montoTeorico)).toEqual(["297.00", "297.00", "306.00"]);
  });

  it("si una unidad quedó fuera del reparto, el teórico se renormaliza igual que el cobro", () => {
    // Versión cerrada con 4 unidades al 0.25; una se dio de baja después, así que reparte entre 3.
    const partes = prorratearDetallado("1000.00", [
      ["uf-1", "0.25"],
      ["uf-2", "0.25"],
      ["uf-3", "0.25"],
    ]);
    expect(partes.map((p) => p.montoTeorico)).toEqual(["333.33", "333.33", "333.33"]);
    expect(sumarMontos(...partes.map((p) => p.monto))).toBe("1000.00");
  });

  it("el ajuste (cobro − teórico) es de centavos, y la suma cierra igual", () => {
    const partes = prorratearDetallado("100.02", [
      ["a", "0.25"],
      ["b", "0.25"],
      ["c", "0.25"],
      ["d", "0.25"],
    ]);
    for (const p of partes) {
      // En centavos, para no comparar con la aritmética de punto flotante que este módulo evita.
      const ajuste = aCentavos(p.monto) - aCentavos(p.montoTeorico);
      expect(ajuste >= -1n && ajuste <= 1n).toBe(true);
    }
    expect(sumarMontos(...partes.map((p) => p.monto))).toBe("100.02");
  });

  it("redondea bien en negativo (el día que existan las notas de crédito)", () => {
    const partes = prorratearDetallado("-10.00", [
      ["a", "0.5"],
      ["b", "0.5"],
    ]);
    expect(partes.map((p) => p.montoTeorico)).toEqual(["-5.00", "-5.00"]);
    expect(sumarMontos(...partes.map((p) => p.monto))).toBe("-10.00");
  });

  it("coeficienteAEntero trunca a 9 decimales, igual que la columna de la base", () => {
    expect(coeficienteAEntero("0.012345678")).toBe(12345678n);
    expect(coeficienteAEntero("0.0123456789")).toBe(12345678n); // el décimo decimal se descarta
    expect(coeficienteAEntero("120")).toBe(120_000_000_000n);
    expect(() => coeficienteAEntero("-0.5")).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La máscara de escritura — reglas B-1 y B-1.bis del usuario (2026-08-03)
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("máscara de dinero: lo que se ve mientras se escribe", () => {
  it("agrupa los miles con punto y separa los decimales con coma", () => {
    expect(enmascararMontoTipeado("92368783,69")).toBe("92.368.783,69");
    expect(enmascararMontoTipeado("2500000")).toBe("2.500.000");
    expect(enmascararMontoTipeado("999")).toBe("999");
  });

  it("no rompe lo que ya está enmascarado: la máscara es idempotente", () => {
    expect(enmascararMontoTipeado("92.368.783,69")).toBe("92.368.783,69");
    expect(enmascararMontoTipeado(enmascararMontoTipeado("1234567,8"))).toBe("1.234.567,8");
  });

  it("deja seguir escribiendo: la coma colgada no se completa sola", () => {
    // Si acá saliera "2.500.000,00", el próximo dígito quedaría atrás de los ceros.
    expect(enmascararMontoTipeado("2500000,")).toBe("2.500.000,");
    expect(enmascararMontoTipeado("2500000,5")).toBe("2.500.000,5");
  });

  it("el punto es SIEMPRE miles, en cualquier posición", () => {
    // La regla que reemplazó a "un punto con dos dígitos o menos atrás es decimal", que hacía que
    // borrar un dígito dividiera el importe por mil. El punto del teclado numérico se traduce a coma
    // en el campo (`CampoMonto`), que es donde se sabe qué tecla se apretó.
    expect(enmascararMontoTipeado("1.234")).toBe("1.234");
    expect(enmascararMontoTipeado("1.23")).toBe("123");
    expect(enmascararMontoTipeado("2.500.00")).toBe("250.000");
  });

  it("empezar por la coma escribe el cero y no se pierde la coma", () => {
    expect(enmascararMontoTipeado(",")).toBe("0,");
    expect(enmascararMontoTipeado(",5")).toBe("0,5");
  });

  it("tipear dígito a dígito nunca se traba", () => {
    const tecleado = ["1", "12", "123", "1234", "12345"];
    // Cada paso vuelve a entrar por la máscara con lo que quedó en pantalla más la tecla nueva.
    let enPantalla = "";
    for (const _ of tecleado) {
      enPantalla = enmascararMontoTipeado(enPantalla + tecleado[0]![0]!);
    }
    expect(enPantalla).toBe("11.111");
  });

  it("descarta lo que no es un número y no inventa ceros a la izquierda", () => {
    expect(enmascararMontoTipeado("$ 1.500 ")).toBe("1.500");
    expect(enmascararMontoTipeado("abc")).toBe("");
    expect(enmascararMontoTipeado("007")).toBe("7");
    expect(enmascararMontoTipeado("")).toBe("");
  });

  it("recorta a dos decimales, que es lo que la base guarda", () => {
    expect(enmascararMontoTipeado("10,999")).toBe("10,99");
  });

  it("conserva el signo negativo", () => {
    expect(enmascararMontoTipeado("-1500,5")).toBe("-1.500,5");
  });
});

describe("máscara de dinero: lo que viaja al servidor", () => {
  it("completa los decimales que faltan (B-1.bis: nadie tipea el ,00)", () => {
    expect(normalizarMontoTipeado("2500000")).toBe("2500000.00");
    expect(normalizarMontoTipeado("2.500.000")).toBe("2500000.00");
    expect(normalizarMontoTipeado("1234,5")).toBe("1234.50");
  });

  it("lo que sale pasa el esquema que exige dos decimales", () => {
    for (const tipeado of ["2500000", "2.500.000", "1234,5", "92.368.783,69", "0", "-1.500"]) {
      expect(() => montoSchema.parse(normalizarMontoTipeado(tipeado))).not.toThrow();
    }
  });

  it("un campo vacío llega vacío: quién exige es el esquema, no la máscara", () => {
    expect(normalizarMontoTipeado("")).toBe("");
    expect(normalizarMontoTipeado("  ")).toBe("");
    expect(normalizarMontoTipeado("$")).toBe("");
  });

  it("el importe del recorrido del usuario llega exacto", () => {
    // El gasto que el usuario escribió y no pudo guardar (observación B-1.bis).
    expect(normalizarMontoTipeado(enmascararMontoTipeado("2500000"))).toBe("2500000.00");
    expect(aCentavos(normalizarMontoTipeado("92.368.783,69"))).toBe(9236878369n);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Ataque a la máscara (verificación adversarial, 2026-08-04)
//
// Los tests de arriba prueban la máscara con lo que la persona **quiso** escribir. Estos la prueban
// con lo que efectivamente pasa en un campo: teclas de a una, borrar, pegar, el dedo que roza la coma
// dos veces. La diferencia importa porque la máscara **reescribe el campo en cada tecla**, así que la
// entrada de la tecla siguiente no es lo que la persona tipeó sino lo que la máscara devolvió.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El campo, simulado. `CampoMonto` es un `<input controlado>`: en cada `onChange` el valor visible
 * vuelve a entrar por `enmascararMontoTipeado` y lo que queda es lo que se ve. `"\b"` es un
 * retroceso al final (el caso más común: borrar el último dígito).
 */
/**
 * Modela el campo real tecla por tecla. `\b` es un retroceso.
 *
 * **Traduce el punto a coma antes de enmascarar, igual que `CampoMonto`**: el teclado numérico del
 * celular solo tiene punto, y esa traducción vive en el campo porque es el único lugar que sabe qué
 * tecla se apretó. La función pura ve el texto final y ahí un punto tipeado y uno puesto por la
 * máscara son indistinguibles — confundirlos es lo que hacía que un retroceso dividiera por mil.
 */
function tipear(teclas: string): { readonly pantalla: string; readonly oculto: string } {
  let pantalla = "";
  for (const tecla of [...teclas]) {
    const siguiente = tecla === "\b" ? pantalla.slice(0, -1) : pantalla + (tecla === "." ? "," : tecla);
    pantalla = enmascararMontoTipeado(siguiente);
  }
  return { pantalla, oculto: normalizarMontoTipeado(pantalla) };
}

/** Todas las palabras de largo `n` sobre un alfabeto hostil: dígitos, separadores, signo y ruido. */
function* palabrasHostiles(n: number, prefijo = ""): Generator<string> {
  if (n === 0) return yield prefijo;
  for (const c of ["1", "0", "9", ",", ".", "-", " ", "$"]) yield* palabrasHostiles(n - 1, prefijo + c);
}

const TODO_LO_TIPEABLE = (function* () {
  for (let n = 0; n <= 4; n++) yield* palabrasHostiles(n);
})();
const HOSTILES = [...TODO_LO_TIPEABLE];

describe("máscara de dinero: las propiedades que valen para TODO texto", () => {
  /**
   * **La propiedad que sostiene a las otras dos.** El campo que viaja es el `hidden` con la salida de
   * `normalizarMontoTipeado`; si esa salida puede no ser un monto, el esquema rechaza con
   * *"monto inválido (esperado string decimal con 2 decimales)"* — el mensaje exacto que la regla
   * B-1.bis existe para que nadie vuelva a ver.
   */
  it("normalizar devuelve `''` o algo que montoSchema acepta — nunca un tercer estado", () => {
    const rotos = HOSTILES.filter((t) => {
      const salida = normalizarMontoTipeado(t);
      return salida !== "" && !montoSchema.safeParse(salida).success;
    });
    expect({ cuantos: rotos.length, ejemplos: rotos.slice(0, 6) }).toEqual({ cuantos: 0, ejemplos: [] });
  });

  it("enmascarar es idempotente: lo que ya está en pantalla no se vuelve a mover", () => {
    for (const t of HOSTILES) {
      expect(enmascararMontoTipeado(enmascararMontoTipeado(t))).toBe(enmascararMontoTipeado(t));
    }
  });

  it("pasar por la pantalla no cambia el número: normalizar(enmascarar(t)) === normalizar(t)", () => {
    // Si esto fallara, lo que se ve y lo que viaja serían dos importes distintos.
    //
    // Se exige sobre los textos que **tienen al menos un dígito**, que son los que representan un
    // importe. Un texto de puros separadores no es un número: `","` viaja como `""` —para que el
    // esquema diga que falta el monto y no que está mal escrito— pero en pantalla se dibuja `"0,"`,
    // porque si la coma desapareciera del campo el `,50` siguiente entraría como cincuenta pesos.
    for (const t of HOSTILES.filter((x) => /\d/.test(x))) {
      expect(normalizarMontoTipeado(enmascararMontoTipeado(t))).toBe(normalizarMontoTipeado(t));
    }
  });
});

describe("máscara de dinero: entradas hostiles", () => {
  it("solo separadores no es un importe", () => {
    for (const t of [",", ".", ",.", ".,", "-", "-.", "- ", "$", "$-", "   "]) {
      expect(normalizarMontoTipeado(t)).toBe("");
    }
  });

  it("el signo menos solo cuenta adelante; en el medio es ruido", () => {
    expect(normalizarMontoTipeado("-1500")).toBe("-1500.00");
    expect(normalizarMontoTipeado("  -1500")).toBe("-1500.00");
    expect(normalizarMontoTipeado("--1500")).toBe("-1500.00");
    expect(normalizarMontoTipeado("1-500")).toBe("1500.00");
    expect(normalizarMontoTipeado("1500-")).toBe("1500.00");
  });

  it("un importe larguísimo sale bien formado (lo que no entra en la columna lo rechaza la base)", () => {
    const veinteDigitos = "9".repeat(20);
    expect(() => montoSchema.parse(normalizarMontoTipeado(veinteDigitos))).not.toThrow();
    expect(aCentavos(normalizarMontoTipeado(veinteDigitos))).toBe(BigInt(`${veinteDigitos}00`));
  });

  it("un importe pegado en formato yanqui entra por el valor que dice", () => {
    // Un punto DESPUÉS de la última coma solo puede ser un importe copiado de un Excel o una página
    // en inglés: acá los miles van antes del decimal y nunca después. Sin esta rama, pegar
    // `1,234,567.89` guardaba $1,23 en silencio — un monto válido que ninguna capa de abajo podía
    // atrapar, que es la peor forma de perder plata.
    expect(normalizarMontoTipeado("1,234.56")).toBe("1234.56");
    expect(normalizarMontoTipeado("1,234,567.89")).toBe("1234567.89");
    expect(enmascararMontoTipeado("1,234,567.89")).toBe("1.234.567,89");
  });
});

describe("máscara de dinero: tecleo real, tecla por tecla", () => {
  it("el importe del recorrido se escribe entero sin trabarse", () => {
    expect(tipear("2500000")).toEqual({ pantalla: "2.500.000", oculto: "2500000.00" });
    expect(tipear("1500,50")).toEqual({ pantalla: "1.500,50", oculto: "1500.50" });
    expect(tipear("-1500,5")).toEqual({ pantalla: "-1.500,5", oculto: "-1500.50" });
  });

  it("con el teclado del celular (solo punto) también", () => {
    expect(tipear("92368783.69")).toEqual({ pantalla: "92.368.783,69", oculto: "92368783.69" });
  });

  it("el tercer decimal se descarta y no traba el campo", () => {
    expect(tipear("10,999")).toEqual({ pantalla: "10,99", oculto: "10.99" });
  });

  /**
   * ⛔ **ROTO (2026-08-04).** Borrar el último dígito de un importe de miles lo divide por mil.
   *
   * La máscara pone el punto de miles y después **no puede distinguirlo del punto que tipeó la
   * persona**: al borrar un dígito de `1.500` queda `1.50`, que la regla del punto lee como decimal.
   * El caso caro es el de siete dígitos: `2.500.000` menos una tecla da `2.500,00`, que **parece un
   * importe normal** — nadie mira dos veces un "dos mil quinientos con cero centavos". Es exactamente
   * el error que la regla B-1 existe para evitar ("fácil de equivocar en un cero"), producido por la
   * propia máscara y con una sola tecla.
   */
  it("borrar el último dígito de un importe de miles NO puede dividirlo por mil", () => {
    expect(tipear("1500\b")).toEqual({ pantalla: "150", oculto: "150.00" });
    expect(tipear("2500000\b")).toEqual({ pantalla: "250.000", oculto: "250000.00" });

    // No es un caso borde: pasa con **todo** importe de cuatro dígitos o más, porque el último grupo
    // de la máscara siempre tiene tres dígitos y al sacarle uno quedan dos.
    for (let n = 4; n <= 10; n++) {
      const tecleado = "1" + "5".repeat(n - 1);
      expect(tipear(`${tecleado}\b`).oculto, `${n} dígitos`).toBe(`${tecleado.slice(0, -1)}.00`);
    }
  });

  /**
   * ⛔ **ROTO (2026-08-04).** Empezar por la coma multiplica por cien.
   *
   * `enmascararMontoTipeado(",")` devuelve `""` porque no hay ni un dígito, así que la coma
   * **desaparece del campo** y las teclas siguientes entran como enteros: quien escribe `,50`
   * pensando en cincuenta centavos termina cargando cincuenta pesos. Pegado de una vez sí funciona
   * (`",50"` → `"0,50"`), lo que confirma que es el camino tecla por tecla el que se pierde.
   */
  it("empezar por la coma no puede multiplicar por cien", () => {
    expect(tipear(",50")).toEqual({ pantalla: "0,50", oculto: "0.50" });
  });

  /**
   * ⛔ **ROTO (2026-08-04).** Dos comas seguidas dejan el campo inválido **y trabado**.
   *
   * La segunda coma se cuela en la parte decimal (`",5"` sobrevive al `slice(0, 2)`), así que el
   * `hidden` sale `"1500.,5"` —que `montoSchema` rechaza— y, peor, la máscara ya no acepta más
   * teclas: el `0` final se descarta en silencio y el campo queda pegado en `1.500,,5`. La persona ve
   * un campo que no responde y, si envía, el mensaje de "monto inválido" que B-1.bis vino a eliminar.
   */
  it("dos comas seguidas no pueden dejar el campo inválido ni trabado", () => {
    const { pantalla, oculto } = tipear("1500,,50");
    expect(montoSchema.safeParse(oculto).success).toBe(true);
    expect(oculto).toBe("1500.50");
    expect(pantalla).toBe("1.500,50");
  });
});
