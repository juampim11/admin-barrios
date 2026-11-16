/**
 * El campo de importe, de punta a punta (encargo 17b, punto 3).
 *
 * `dinero.test.ts` prueba las funciones de un texto. Acá se prueba **el campo**: lo que se ve y lo
 * que viaja después de tipear, salir y volver a entrar, con el cursor real. `campo()` hace
 * exactamente lo que hace `EntradaDeImporte` (`packages/ui`) con los eventos del navegador, y nada
 * más: el componente no tiene ni una regla propia.
 */

import { describe, expect, it } from "vitest";
import {
  formatearMonto,
  importeAlEntrar,
  importeAlSalir,
  importeInicial,
  montoSchema,
  normalizarMontoTipeado,
  reenmascararConCursor,
  reescribirImporte,
  tipearEnImporte,
  tipearEnMonto,
  type ImporteEnEdicion,
} from "./dinero.ts";

/**
 * El campo, simulado. `teclas` tipea de a una en el cursor (`\b` es un retroceso); `pegar` inserta un
 * texto de una vez en el cursor; `reemplazar` es «seleccionar todo y pegar».
 *
 * `viaja` es el valor del campo oculto: se recalcula en cada edición y **no** al salir ni al entrar,
 * igual que en el componente.
 */
function campo(valorInicial = "") {
  const inicial = importeInicial(valorInicial);
  let texto = inicial.visible;
  let cursor = texto.length;
  let comaDePunto = false;
  let viaja = inicial.canonico;

  const aplicar = (e: ImporteEnEdicion) => {
    texto = e.texto;
    cursor = e.cursor;
    comaDePunto = e.comaDePunto;
    viaja = normalizarMontoTipeado(texto);
  };

  const api = {
    teclas(secuencia: string) {
      for (const tecla of secuencia) {
        if (tecla !== "\b") aplicar(tipearEnImporte(texto, cursor, cursor, tecla, comaDePunto));
        else if (cursor > 0) aplicar(reescribirImporte(`${texto.slice(0, cursor - 1)}${texto.slice(cursor)}`, cursor - 1, comaDePunto));
      }
      return api;
    },
    pegar(pegado: string) {
      aplicar(reescribirImporte(`${texto.slice(0, cursor)}${pegado}${texto.slice(cursor)}`, cursor + pegado.length, false));
      return api;
    },
    reemplazar(pegado: string) {
      aplicar(reescribirImporte(pegado, pegado.length, false));
      return api;
    },
    cursorEn(posicion: number) {
      cursor = posicion;
      return api;
    },
    salir() {
      texto = importeAlSalir(texto);
      comaDePunto = false;
      return api;
    },
    /** Entra con el cursor al final, que es donde queda al entrar con Tab o con un clic a la derecha. */
    entrar() {
      texto = importeAlEntrar(texto);
      cursor = texto.length;
      return api;
    },
    get visto() {
      return texto;
    },
    get viaja() {
      return viaja;
    },
    get cursor() {
      return cursor;
    },
  };
  return api;
}

const vistoYViaja = (c: { readonly visto: string; readonly viaja: string }) => ({ visto: c.visto, viaja: c.viaja });

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Los cinco comportamientos que pidió el titular
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("campo de importe: los cinco comportamientos", () => {
  it("1 · al salir muestra el separador de miles y la coma decimal", () => {
    expect(vistoYViaja(campo().teclas("92368783,69").salir())).toEqual({ visto: "92.368.783,69", viaja: "92368783.69" });
  });

  it("2 · el punto del teclado numérico escribe la coma decimal", () => {
    expect(campo().teclas("1234.").visto).toBe("1.234,");
    expect(campo().teclas("1234.5").visto).toBe("1.234,5");
    expect(vistoYViaja(campo().teclas("1234.5").salir())).toEqual({ visto: "1.234,50", viaja: "1234.50" });
    expect(vistoYViaja(campo().teclas("1234.56").salir())).toEqual({ visto: "1.234,56", viaja: "1234.56" });
  });

  it("3 · sin decimales completa «,00»", () => {
    expect(vistoYViaja(campo().teclas("250000").salir())).toEqual({ visto: "250.000,00", viaja: "250000.00" });
    expect(vistoYViaja(campo().teclas("1234,5").salir())).toEqual({ visto: "1.234,50", viaja: "1234.50" });
    expect(vistoYViaja(campo().teclas("7").salir())).toEqual({ visto: "7,00", viaja: "7.00" });
  });

  it("4 · «250.000» se lee como doscientos cincuenta mil", () => {
    // Tecla por tecla: el punto escribe la coma, y el tercer dígito lo vuelve punto de miles.
    expect(campo().teclas("250.").visto).toBe("250,");
    expect(campo().teclas("250.0").visto).toBe("250,0");
    expect(campo().teclas("250.00").visto).toBe("250,00");
    expect(campo().teclas("250.000").visto).toBe("250.000");
    expect(vistoYViaja(campo().teclas("250.000").salir())).toEqual({ visto: "250.000,00", viaja: "250000.00" });
    // Pegado o autocompletado de una vez, también.
    expect(vistoYViaja(campo().pegar("250.000").salir())).toEqual({ visto: "250.000,00", viaja: "250000.00" });
  });

  it("5 · al volver a entrar se edita sin perder ni duplicar los decimales", () => {
    // Muestra 1.234,50; se entra y se agrega un 6 al final: el 6 entra como centavo.
    const c = campo("1234.50");
    expect(c.visto).toBe("1.234,50");
    expect(c.entrar().visto).toBe("1.234,5");
    expect(c.teclas("6").visto).toBe("1.234,56");
    expect(vistoYViaja(c.salir())).toEqual({ visto: "1.234,56", viaja: "1234.56" });

    // Muestra 1.234,00; se entra y se escriben los centavos: una sola coma, sin ceros de más.
    expect(vistoYViaja(campo("1234.00").entrar().teclas(",5").salir())).toEqual({ visto: "1.234,50", viaja: "1234.50" });
    expect(vistoYViaja(campo("1234.00").entrar().teclas(".75").salir())).toEqual({ visto: "1.234,75", viaja: "1234.75" });

    // Entrar y salir sin tocar nada no cambia nada, las veces que sea.
    for (const canonico of ["1234.00", "1234.50", "1234.56", "0.50", "0.05", "250000.00", "-8.00"]) {
      const quieto = campo(canonico);
      const antes = quieto.visto;
      quieto.entrar().salir().entrar().salir();
      expect(vistoYViaja(quieto), canonico).toEqual({ visto: antes, viaja: canonico });
    }
  });

  it("campo vacío al salir: sigue vacío y viaja vacío", () => {
    expect(vistoYViaja(campo().salir())).toEqual({ visto: "", viaja: "" });
    expect(vistoYViaja(campo().entrar().salir())).toEqual({ visto: "", viaja: "" });
    expect(vistoYViaja(campo().teclas("12\b\b").salir())).toEqual({ visto: "", viaja: "" });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La coma que nace de un punto
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("campo de importe: el punto que resulta ser de miles", () => {
  it("quien escribe los miles con punto por costumbre llega al importe que quiso", () => {
    expect(vistoYViaja(campo().teclas("12.345.678").salir())).toEqual({ visto: "12.345.678,00", viaja: "12345678.00" });
    expect(vistoYViaja(campo().teclas("1.234.567").salir())).toEqual({ visto: "1.234.567,00", viaja: "1234567.00" });
  });

  it("«250.000,5»: miles con punto y centavos con coma (o con otro punto)", () => {
    expect(campo().teclas("250.000,5").visto).toBe("250.000,5");
    expect(vistoYViaja(campo().teclas("250.000,5").salir())).toEqual({ visto: "250.000,50", viaja: "250000.50" });
    expect(vistoYViaja(campo().teclas("250.000.5").salir())).toEqual({ visto: "250.000,50", viaja: "250000.50" });
    expect(vistoYViaja(campo().teclas("250.000.50").salir())).toEqual({ visto: "250.000,50", viaja: "250000.50" });
  });

  it("con uno o dos dígitos atrás, el punto ES la coma decimal", () => {
    expect(vistoYViaja(campo().teclas("250.5").salir())).toEqual({ visto: "250,50", viaja: "250.50" });
    expect(vistoYViaja(campo().teclas("250.50").salir())).toEqual({ visto: "250,50", viaja: "250.50" });
    expect(vistoYViaja(campo().teclas("250.00").salir())).toEqual({ visto: "250,00", viaja: "250.00" });
  });

  it("la coma tipeada con la tecla coma es firme: el tercer decimal se descarta", () => {
    expect(vistoYViaja(campo().teclas("10,999").salir())).toEqual({ visto: "10,99", viaja: "10.99" });
    expect(vistoYViaja(campo().teclas("250,000").salir())).toEqual({ visto: "250,00", viaja: "250.00" });
    // Y con el punto, tres dígitos son miles: diez mil novecientos noventa y nueve.
    expect(vistoYViaja(campo().teclas("10.999").salir())).toEqual({ visto: "10.999,00", viaja: "10999.00" });
  });

  it("la tecla coma confirma una coma que había nacido de un punto", () => {
    expect(vistoYViaja(campo().teclas("250.,000").salir())).toEqual({ visto: "250,00", viaja: "250.00" });
  });

  it("la marca no sobrevive a salir del campo", () => {
    // 250,00 escrito con punto; se sale y se vuelve a entrar: el campo dice 250 y un 0 es un entero.
    const c = campo().teclas("250.00").salir().entrar();
    expect(c.visto).toBe("250");
    expect(vistoYViaja(c.teclas(",000").salir())).toEqual({ visto: "250,00", viaja: "250.00" });
  });

  it("la marca no sobrevive a borrar la coma", () => {
    // 250, → retroceso → 250 → 000: son enteros, y no hay coma que convertir.
    expect(vistoYViaja(campo().teclas("250.\b000").salir())).toEqual({ visto: "250.000,00", viaja: "250000.00" });
    expect(vistoYViaja(campo().teclas("250.5\b\b,123").salir())).toEqual({ visto: "250,12", viaja: "250.12" });
  });

  it("un texto pegado no se reinterpreta por una marca que venía de antes", () => {
    // 250, (de un punto) y se pega encima «1.234,567»: trae su propia coma, que es firme.
    expect(vistoYViaja(campo().teclas("250.").reemplazar("1.234,567").salir())).toEqual({ visto: "1.234,56", viaja: "1234.56" });
  });

  it("«0.500» no es quinientos: empezar por cero o por el punto es escribir centavos", () => {
    expect(vistoYViaja(campo().teclas("0.500").salir())).toEqual({ visto: "0,50", viaja: "0.50" });
    expect(vistoYViaja(campo().teclas(".500").salir())).toEqual({ visto: "0,50", viaja: "0.50" });
  });

  it("el tercer dígito en el medio de los decimales también convierte, con el cursor en su lugar", () => {
    // 250,05 con el cursor entre el 0 y el 5, y se tipea un 1: 250.015.
    const c = campo().teclas("250.05").cursorEn(5).teclas("1");
    expect(c.visto).toBe("250.015");
    expect(c.cursor).toBe(6);
    expect(c.teclas("9").visto).toBe("2.500.195");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Los bordes
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("campo de importe: bordes", () => {
  it("solo la coma (o solo el punto): escribe el cero, y los centavos caen después", () => {
    expect(campo().teclas(",").visto).toBe("0,");
    expect(campo().teclas(".").visto).toBe("0,");
    expect(vistoYViaja(campo().teclas(",5").salir())).toEqual({ visto: "0,50", viaja: "0.50" });
    expect(vistoYViaja(campo().teclas("0,5").salir())).toEqual({ visto: "0,50", viaja: "0.50" });
    expect(vistoYViaja(campo().teclas(".05").salir())).toEqual({ visto: "0,05", viaja: "0.05" });
    // La coma sola, sin nada más, es un cero: lo mismo que viajaba antes de este cambio.
    expect(vistoYViaja(campo().teclas(",").salir())).toEqual({ visto: "0,00", viaja: "0.00" });
  });

  it("pegar «1.234,5»", () => {
    expect(campo().pegar("1.234,5").visto).toBe("1.234,5");
    expect(vistoYViaja(campo().pegar("1.234,5").salir())).toEqual({ visto: "1.234,50", viaja: "1234.50" });
  });

  it("pegar en formato yanqui «1,234.56»: entra por el valor que dice", () => {
    expect(vistoYViaja(campo().pegar("1,234.56").salir())).toEqual({ visto: "1.234,56", viaja: "1234.56" });
  });

  /**
   * ⚠ **Sin cambio respecto de antes, a propósito.** Un texto pegado no tiene tecla: solo se ve el
   * texto, y ahí el punto es SIEMPRE de miles (ver `partirLoTipeado`). `1234.56` pegado sigue
   * leyéndose `123.456`. Cambiarlo cambiaría lo que se guarda para una entrada que hoy es válida, y
   * eso no se hace sin que lo decida el titular. Tipeado con el teclado sí da `1.234,56` (punto 2).
   */
  it("pegar «1234.56» (punto sin coma): el punto de un texto pegado es de miles, como antes", () => {
    expect(vistoYViaja(campo().pegar("1234.56").salir())).toEqual({ visto: "123.456,00", viaja: "123456.00" });
    expect(vistoYViaja(campo().teclas("1234.56").salir())).toEqual({ visto: "1.234,56", viaja: "1234.56" });
  });

  it("pegar con ruido alrededor: se queda con el importe", () => {
    expect(vistoYViaja(campo().pegar("$ 1.500,75 ").salir())).toEqual({ visto: "1.500,75", viaja: "1500.75" });
    expect(vistoYViaja(campo().pegar("abc").salir())).toEqual({ visto: "", viaja: "" });
  });

  it("negativo pegado o precargado: conserva el signo", () => {
    expect(vistoYViaja(campo().pegar("-1500,5").salir())).toEqual({ visto: "-1.500,50", viaja: "-1500.50" });
    const c = campo("-1500.50");
    expect(c.visto).toBe("-1.500,50");
    expect(vistoYViaja(c.entrar().teclas("7").salir())).toEqual({ visto: "-1.500,57", viaja: "-1500.57" });
    // Un cero negativo se muestra sin signo, y un signo solo no es un importe.
    expect(vistoYViaja(campo().pegar("-0").salir())).toEqual({ visto: "0,00", viaja: "-0.00" });
    expect(vistoYViaja(campo().pegar("-").salir())).toEqual({ visto: "", viaja: "" });
  });

  /**
   * ⚠ **Sin cambio respecto de antes, a propósito.** El signo menos **tipeado** antes del primer
   * dígito no queda: el cursor se cuenta en dígitos y coma, así que después del `-` vuelve a la
   * posición cero y el dígito siguiente entra delante del signo, que deja de serlo. Ya pasaba con el
   * campo anterior. Ningún formulario de hoy pide un importe negativo; si alguno lo pidiera, se
   * arregla acá y este test cambia.
   */
  it("el signo menos tipeado delante no queda (igual que antes): viaja el importe positivo", () => {
    expect(vistoYViaja(campo().teclas("-1500").salir())).toEqual({ visto: "1.500,00", viaja: "1500.00" });
  });

  it("borrar desde el final", () => {
    expect(vistoYViaja(campo().teclas("2500000\b"))).toEqual({ visto: "250.000", viaja: "250000.00" });
    expect(vistoYViaja(campo().teclas("1234,56\b"))).toEqual({ visto: "1.234,5", viaja: "1234.50" });
    expect(vistoYViaja(campo().teclas("1234,56\b\b"))).toEqual({ visto: "1.234,", viaja: "1234.00" });
    expect(vistoYViaja(campo().teclas("1234,56\b\b\b"))).toEqual({ visto: "1.234", viaja: "1234.00" });
    expect(vistoYViaja(campo().teclas("1234,56\b\b\b\b"))).toEqual({ visto: "123", viaja: "123.00" });
  });

  it("borrar un importe que ya tenía sus decimales: al entrar no hay ceros que sacar a mano", () => {
    // Muestra 2.500.000,00; se entra y un solo retroceso saca un dígito, no un cero de relleno.
    expect(vistoYViaja(campo("2500000.00").entrar().teclas("\b").salir())).toEqual({ visto: "250.000,00", viaja: "250000.00" });
  });

  it("cursor en el medio: insertar y borrar no lo hacen saltar", () => {
    // 1.234.567 con el cursor después del 1, y se tipea un 9.
    const insertar = campo().teclas("1234567").cursorEn(1).teclas("9");
    expect(insertar.visto).toBe("19.234.567");
    expect(insertar.cursor).toBe(2);

    // 1.234.567 con el cursor después del 4, y un retroceso.
    const borrar = campo().teclas("1234567").cursorEn(5).teclas("\b");
    expect(borrar.visto).toBe("123.567");
    expect(borrar.cursor).toBe(3);

    // El retroceso sobre un punto de miles no borra ningún dígito: el cursor lo salta.
    const sobreElPunto = campo().teclas("1234").cursorEn(2).teclas("\b");
    expect(vistoYViaja(sobreElPunto)).toEqual({ visto: "1.234", viaja: "1234.00" });
    expect(sobreElPunto.cursor).toBe(1);
  });

  it("corregir un dígito en el medio de un importe con decimales", () => {
    // 1.234,56 → el 3 pasa a ser un 9: cursor después del 3, retroceso, 9.
    expect(vistoYViaja(campo("1234.56").entrar().cursorEn(4).teclas("\b9").salir())).toEqual({ visto: "1.294,56", viaja: "1294.56" });
  });

  it("más de dos decimales con la coma: el tercero se descarta y el campo no se traba", () => {
    expect(vistoYViaja(campo().teclas("10,9999").salir())).toEqual({ visto: "10,99", viaja: "10.99" });
    expect(vistoYViaja(campo().teclas("10,999\b5").salir())).toEqual({ visto: "10,95", viaja: "10.95" });
  });

  it("punto (o coma) cuando ya hay coma: no entra una segunda y el importe no se recorta", () => {
    // Delante de la coma que ya está: no pasa a ser ella. El cursor salta a los centavos.
    for (const tecla of [".", ","]) {
      const c = campo().teclas("1234,56").cursorEn(1).teclas(tecla);
      expect(vistoYViaja(c)).toEqual({ visto: "1.234,56", viaja: "1234.56" });
      expect(c.cursor).toBe(6);
    }
    // Al final, dos veces seguidas.
    expect(vistoYViaja(campo().teclas("1500,,50").salir())).toEqual({ visto: "1.500,50", viaja: "1500.50" });
    expect(vistoYViaja(campo().teclas("1500..50").salir())).toEqual({ visto: "1.500,50", viaja: "1500.50" });
    expect(vistoYViaja(campo().teclas("1500,.50").salir())).toEqual({ visto: "1.500,50", viaja: "1500.50" });
  });

  it("una coma que dejaría más de dos dígitos atrás no entra", () => {
    const c = campo().teclas("12345").cursorEn(2).teclas(".");
    expect(vistoYViaja(c)).toEqual({ visto: "12.345", viaja: "12345.00" });
  });

  it("ceros a la izquierda", () => {
    expect(vistoYViaja(campo().teclas("007").salir())).toEqual({ visto: "7,00", viaja: "7.00" });
    expect(vistoYViaja(campo().teclas("0").salir())).toEqual({ visto: "0,00", viaja: "0.00" });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Entrar, salir y el valor inicial, como funciones
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("campo de importe: salir, entrar y nacer", () => {
  it("importeAlSalir completa los decimales y agrupa los miles", () => {
    expect(importeAlSalir("1.234")).toBe("1.234,00");
    expect(importeAlSalir("1.234,")).toBe("1.234,00");
    expect(importeAlSalir("1.234,5")).toBe("1.234,50");
    expect(importeAlSalir("1.234,56")).toBe("1.234,56");
    expect(importeAlSalir("250000")).toBe("250.000,00");
    expect(importeAlSalir("0,")).toBe("0,00");
    expect(importeAlSalir("")).toBe("");
    expect(importeAlSalir("-")).toBe("");
  });

  it("importeAlEntrar saca solo los ceros que completó la salida", () => {
    expect(importeAlEntrar("1.234,00")).toBe("1.234");
    expect(importeAlEntrar("1.234,50")).toBe("1.234,5");
    expect(importeAlEntrar("1.234,56")).toBe("1.234,56");
    expect(importeAlEntrar("1.234,05")).toBe("1.234,05");
    expect(importeAlEntrar("250.000,00")).toBe("250.000");
    expect(importeAlEntrar("0,00")).toBe("0");
    expect(importeAlEntrar("1.000")).toBe("1.000");
    expect(importeAlEntrar("")).toBe("");
  });

  it("importeInicial pinta el canónico y lo deja viajar tal cual", () => {
    expect(importeInicial("2500000.00")).toEqual({ visible: "2.500.000,00", canonico: "2500000.00" });
    expect(importeInicial("1234.50")).toEqual({ visible: "1.234,50", canonico: "1234.50" });
    expect(importeInicial("")).toEqual({ visible: "", canonico: "" });
    expect(importeInicial("  ")).toEqual({ visible: "", canonico: "" });
  });

  it("importeInicial no se rompe con un texto que no es canónico: lo lee como tipeado", () => {
    expect(importeInicial("15.000,00")).toEqual({ visible: "15.000,00", canonico: "15000.00" });
    expect(importeInicial("abc")).toEqual({ visible: "", canonico: "" });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Propiedades, sobre todo lo que se puede tipear en cinco teclas
// ────────────────────────────────────────────────────────────────────────────────────────────────

function* secuencias(alfabeto: readonly string[], n: number, prefijo = ""): Generator<string> {
  yield prefijo;
  if (n === 0) return;
  for (const c of alfabeto) yield* secuencias(alfabeto, n - 1, prefijo + c);
}

const TODAS = [...secuencias(["1", "0", "9", ",", ".", "\b"], 5)];
const legible = (s: string): string => s.replaceAll("\b", "←");

describe("campo de importe: lo que vale para TODA secuencia de teclas", () => {
  it("lo que viaja es vacío o un monto que el esquema acepta — nunca un tercer estado", () => {
    const rotos = TODAS.filter((s) => {
      const { viaja } = campo().teclas(s);
      return viaja !== "" && !montoSchema.safeParse(viaja).success;
    });
    expect(rotos.slice(0, 5).map(legible)).toEqual([]);
  });

  it("lo que se ve al salir es, textualmente, lo que viaja", () => {
    const distintos = TODAS.filter((s) => {
      const c = campo().teclas(s).salir();
      return c.visto !== (c.viaja === "" ? "" : formatearMonto(c.viaja));
    });
    expect(distintos.slice(0, 5).map(legible)).toEqual([]);
  });

  it("salir y volver a entrar no cambia el importe, y es estable", () => {
    const movidos = TODAS.filter((s) => {
      const c = campo().teclas(s).salir();
      const alSalir = c.visto;
      const alEntrar = c.entrar().visto;
      return (
        normalizarMontoTipeado(alEntrar) !== c.viaja ||
        importeAlEntrar(alEntrar) !== alEntrar ||
        c.salir().visto !== alSalir
      );
    });
    expect(movidos.slice(0, 5).map(legible)).toEqual([]);
  });

  it("el cursor nunca queda fuera del texto", () => {
    const afuera = TODAS.filter((s) => {
      const c = campo().teclas(s);
      return c.cursor < 0 || c.cursor > c.visto.length;
    });
    expect(afuera.slice(0, 5).map(legible)).toEqual([]);
  });

  /**
   * **La garantía de que lo que se guarda no cambió.** Sin la tecla punto no hay coma provisoria, y
   * el campo tiene que hacer —tecla por tecla, con el mismo cursor— lo que hacía el anterior
   * (`tipearEnMonto` para la coma, `reenmascararConCursor` para todo lo demás).
   */
  it("sin la tecla punto, el campo hace exactamente lo que hacía el anterior", () => {
    const campoAnterior = (s: string) => {
      let estado = { texto: "", cursor: 0 };
      for (const tecla of s) {
        if (tecla === ",") estado = tipearEnMonto(estado.texto, estado.cursor, estado.cursor, tecla);
        else if (tecla !== "\b") {
          estado = reenmascararConCursor(`${estado.texto.slice(0, estado.cursor)}${tecla}${estado.texto.slice(estado.cursor)}`, estado.cursor + 1);
        } else if (estado.cursor > 0) {
          estado = reenmascararConCursor(`${estado.texto.slice(0, estado.cursor - 1)}${estado.texto.slice(estado.cursor)}`, estado.cursor - 1);
        }
      }
      return { visto: estado.texto, viaja: normalizarMontoTipeado(estado.texto), cursor: estado.cursor };
    };
    const distintos = TODAS.filter((s) => !s.includes(".")).filter((s) => {
      const nuevo = campo().teclas(s);
      const anterior = campoAnterior(s);
      return nuevo.visto !== anterior.visto || nuevo.viaja !== anterior.viaja || nuevo.cursor !== anterior.cursor;
    });
    expect(distintos.slice(0, 5).map(legible)).toEqual([]);
  });

  /**
   * Con la tecla punto, lo único que cambia respecto del campo anterior es **el tercer dígito detrás
   * de un punto**: antes se descartaba (y `250.000` guardaba 250,00), ahora vuelve el punto de miles.
   * Toda secuencia que no llega a ese tercer dígito guarda lo mismo que antes.
   */
  it("con la tecla punto, solo cambia lo que tenía un tercer dígito detrás del punto", () => {
    const campoAnterior = (s: string) => {
      let estado = { texto: "", cursor: 0 };
      for (const tecla of s) estado = tipearEnMonto(estado.texto, estado.cursor, estado.cursor, tecla);
      return normalizarMontoTipeado(estado.texto);
    };
    const soloTeclas = [...secuencias(["1", "0", "9", ",", "."], 5)];
    const cambiaron = soloTeclas.filter((s) => campo().teclas(s).viaja !== campoAnterior(s));
    expect(cambiaron.length).toBeGreaterThan(0);
    // Todas las que cambiaron tienen un punto seguido de tres dígitos (con o sin puntos repetidos en el medio).
    expect(cambiaron.filter((s) => !/\.\.*\d\.*\d\.*\d/.test(s)).slice(0, 5)).toEqual([]);
  });
});
