/**
 * Qué columnas se ocultan y **con qué palabras se declara**.
 *
 * Existe por un hallazgo del revisor que los datos del seed no alcanzan a producir: hoy el interés por
 * mora sale `0.00` en las 50 liquidaciones, así que el pie dice "en cero" y dice bien. El caso que
 * importa es el otro —el barrio sin tasa de mora vigente, que la propia pantalla anuncia como
 * "pendiente de definición"— y ahí `interes_mora` es **`null`**. Con el criterio viejo
 * (`valor ?? "0.00"`), esa columna se ocultaba y el pie afirmaba *"todas las liquidaciones las tienen
 * en cero: interés por mora"*, en la pantalla donde se decide emitir y sobre la cifra que la misma
 * pantalla acababa de declarar sin definir.
 *
 * Un test y no "cuando aparezca el dato": el modo de falla es una **afirmación falsa sobre dinero**, y
 * la única forma de que no vuelva es que esté fijado acá.
 */

import { describe, expect, it } from "vitest";
import type { GrillaLiquidaciones, LiquidacionDeGrilla } from "@admin-barrios/data/servicios/liquidaciones";
import { columnasDe, visiblesDe } from "./grilla.tsx";

/** Una liquidación de la grilla, con todo en cero salvo lo que el caso quiera cambiar. */
function liquidacion(cambios: Partial<LiquidacionDeGrilla> = {}): LiquidacionDeGrilla {
  return {
    id: "l1",
    unidadFuncionalId: "u1",
    etiqueta: "MZ 1-1",
    destinatario: "Ana Gómez",
    numeroComprobante: null,
    coeficienteAplicado: "0.020000000",
    subtotalCuotaFija: "0.00",
    subtotalOrdinarias: "1000.00",
    subtotalExtraordinarias: "0.00",
    subtotalFondoReserva: "0.00",
    subtotalCargos: "0.00",
    subtotalDescuentos: "0.00",
    saldoAnterior: "0.00",
    saldoAnteriorOrigen: "sin_movimientos",
    interesMora: "0.00",
    moraPendienteDefinicion: false,
    diasAtraso: null,
    total: "1000.00",
    ...cambios,
  } as LiquidacionDeGrilla;
}

function grillaCon(liquidaciones: readonly LiquidacionDeGrilla[]): GrillaLiquidaciones {
  const cero = "0.00";
  return {
    liquidaciones,
    total: liquidaciones.length,
    limite: 500,
    desplazamiento: 0,
    conMoraPendiente: 0,
    totales: {
      cuotaFija: cero,
      ordinarias: cero,
      extraordinarias: cero,
      fondoReserva: cero,
      cargos: cero,
      descuentos: cero,
      saldoAnterior: cero,
      interesMora: cero,
      total: cero,
    },
  } as GrillaLiquidaciones;
}

const clavesDe = (cs: ReturnType<typeof columnasDe>) => cs.map((c) => c.clave);

describe("`visiblesDe` distingue estar en cero de no estar definido", () => {
  it("una columna con todo en cero se oculta y se declara como en cero", () => {
    const grilla = grillaCon([liquidacion(), liquidacion({ id: "l2" })]);
    const { ocultasEnCero, ocultasSinDato } = visiblesDe(grilla, columnasDe(grilla));

    expect(clavesDe(ocultasEnCero)).toContain("interesMora");
    expect(clavesDe(ocultasSinDato)).not.toContain("interesMora");
  });

  it("una columna con todo en `null` se oculta pero se declara como SIN DEFINIR, no como cero", () => {
    // El caso real: el barrio no tenía tasa de mora vigente al liquidar, el sistema no inventa una y
    // la liquidación sale sin interés calculado. Decir "está en cero" sería afirmar que no debe
    // intereses, que es un hecho distinto y falso.
    const sinTasa = { interesMora: null, moraPendienteDefinicion: true } as Partial<LiquidacionDeGrilla>;
    const grilla = grillaCon([liquidacion(sinTasa), liquidacion({ id: "l2", ...sinTasa })]);
    const { ocultasSinDato, ocultasEnCero } = visiblesDe(grilla, columnasDe(grilla));

    expect(clavesDe(ocultasSinDato)).toContain("interesMora");
    expect(clavesDe(ocultasEnCero)).not.toContain("interesMora");
  });

  it("si UNA sola fila tiene algo, la columna se muestra", () => {
    // Se mira fila por fila y no el total: `saldo_anterior` no tiene check de signo, así que un saldo
    // a favor es negativo. Con el criterio "el total da cero", +180.000 y −180.000 harían desaparecer
    // la columna y la pantalla diría que no hay arrastre habiendo 360.000 de arrastre.
    const grilla = grillaCon([
      liquidacion({ saldoAnterior: "180000.00" }),
      liquidacion({ id: "l2", saldoAnterior: "-180000.00" }),
    ]);
    const { visibles } = visiblesDe(grilla, columnasDe(grilla));

    expect(clavesDe(visibles)).toContain("saldoAnterior");
  });

  it("una columna mezclada (una en cero, otra sin dato) se muestra: no se puede afirmar ninguna de las dos", () => {
    const grilla = grillaCon([
      liquidacion({ interesMora: "0.00" }),
      liquidacion({ id: "l2", interesMora: null }),
    ]);
    const { visibles, ocultasEnCero, ocultasSinDato } = visiblesDe(grilla, columnasDe(grilla));

    expect(clavesDe(visibles)).toContain("interesMora");
    expect(clavesDe(ocultasEnCero)).not.toContain("interesMora");
    expect(clavesDe(ocultasSinDato)).not.toContain("interesMora");
  });

  it("`ordinarias` se muestra aunque esté en cero: sin ella la grilla deja de explicar el reparto", () => {
    const grilla = grillaCon([liquidacion({ subtotalOrdinarias: "0.00" })]);
    const { visibles } = visiblesDe(grilla, columnasDe(grilla));

    expect(clavesDe(visibles)).toContain("ordinarias");
  });
});
