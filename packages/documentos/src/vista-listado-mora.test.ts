/**
 * Los invariantes del listado de saldos pendientes.
 *
 * La mitad de este archivo prueba **aritmética** y la otra mitad prueba que **no se puede filtrar
 * identidad**. La segunda mitad es la que importa: es el único documento del producto donde un bug
 * de modelado publica el nombre y la deuda de una persona a cientos de vecinos.
 */

import { describe, expect, it } from "vitest";
import {
  cifra,
  esFaltante,
  faltante,
  K_ANONIMATO_MINIMO,
  ORDEN_DE_TRABAJO,
  parsearVistaListadoMora,
  TITULO_LISTADO_MORA,
} from "@admin-barrios/shared/documentos";
import {
  filasMuestra,
  listadoAgregadoMuestra,
  listadoNominadoMuestra,
  TOTAL_LISTADO_MUESTRA,
} from "./fixtures/informes-muestra.ts";

describe("el listado nominado cierra", () => {
  it("el fixture de referencia pasa entero", () => {
    const v = parsearVistaListadoMora(listadoNominadoMuestra());
    expect(v.resumen.total.texto).toBe("12.200.000,00");
    expect(v.detalle.modo).toBe("nominado");
  });

  it("las filas suman el total que se imprime", () => {
    const filas = filasMuestra() as any[];
    filas[0].saldo.total = cifra("900001.00");
    expect(() => parsearVistaListadoMora(listadoNominadoMuestra({ detalle: { modo: "nominado", filas, respaldoDecision: faltante("x"), copia: "AB12-3" } }))).toThrow(
      /las filas suman 12200001.00/,
    );
  });

  it("el piso de importe se aplicó de verdad: no alcanza con declararlo", () => {
    const filas = filasMuestra() as any[];
    filas[6].saldo.total = cifra("1000.00");
    expect(() =>
      parsearVistaListadoMora(
        listadoNominadoMuestra({
          detalle: { modo: "nominado", filas, respaldoDecision: faltante("x"), copia: "AB12-3" },
          resumen: { ...(listadoNominadoMuestra() as any).resumen, total: cifra("11901000.00") },
        }),
      ),
    ).toThrow(/queda por debajo del piso/);
  });

  it("la composición del saldo, cuando existe, tiene que sumar el total de la fila", () => {
    const filas = filasMuestra() as any[];
    filas[0].saldo = {
      total: cifra("900000.00"),
      capital: cifra("800000.00"),
      intereses: cifra("50000.00"),
      multas: cifra("10000.00"),
      cargos: cifra("10000.00"), // suma 870.000, no 900.000
    };
    expect(() =>
      parsearVistaListadoMora(listadoNominadoMuestra({ detalle: { modo: "nominado", filas, respaldoDecision: faltante("x"), copia: "AB12-3" } })),
    ).toThrow(/capital \+ intereses \+ multas \+ cargos da 870000.00/);
  });

  it("está ordenado PARA TRABAJAR: las instancias recuperables primero, las terminales al final", () => {
    const v = parsearVistaListadoMora(listadoNominadoMuestra());
    const filas = v.detalle.modo === "nominado" ? v.detalle.filas : [];
    const instancias = filas.map((f) => f.instancia.clave);
    const rangos = instancias.map((i) => ORDEN_DE_TRABAJO.indexOf(i as never));
    expect(rangos).toEqual([...rangos].sort((a, b) => a - b));
    // Y lo que ordena NO es el importe: la fila más grande del listado ($ 2.000.000) no va primera.
    expect(filas[0]?.saldo.total.monto).toBe("900000.00");
  });

  it("un listado ordenado por importe, que es como sale hoy, se rechaza", () => {
    const filas = (filasMuestra() as any[]).sort((a, b) => Number(b.saldo.total.monto) - Number(a.saldo.total.monto));
    expect(() =>
      parsearVistaListadoMora(listadoNominadoMuestra({ detalle: { modo: "nominado", filas, respaldoDecision: faltante("x"), copia: "AB12-3" } })),
    ).toThrow(/no está en orden de trabajo/);
  });

  it("una antigüedad desconocida se ordena al FONDO de su bloque, no al frente", () => {
    // `0` la empataba con `un_periodo`, el tramo más fresco: el listado terminaba afirmando que una
    // fila de la que no sabemos nada es la más nueva.
    const filas = filasMuestra() as any[];
    filas[0].antiguedad = "mas_de_12";
    // Con la primera fila declarada como la más vieja, el orden correcto la deja adelante; el
    // fixture ya la tiene primera, así que lo que se prueba es que la faltante NO la desplaza.
    expect(() =>
      parsearVistaListadoMora(listadoNominadoMuestra({ detalle: { modo: "nominado", filas, respaldoDecision: faltante("x"), copia: "AB12-3" } })),
    ).not.toThrow();

    const alReves = filasMuestra() as any[];
    alReves[6].antiguedad = "mas_de_12"; // la última del bloque pasa a ser la más vieja: desordena
    expect(() =>
      parsearVistaListadoMora(listadoNominadoMuestra({ detalle: { modo: "nominado", filas: alReves, respaldoDecision: faltante("x"), copia: "AB12-3" } })),
    ).toThrow(/no está en orden de trabajo/);
  });

  it("el identificador de copia es obligatorio y tiene formato", () => {
    expect(() =>
      parsearVistaListadoMora(
        listadoNominadoMuestra({ detalle: { modo: "nominado", filas: filasMuestra(), respaldoDecision: faltante("x"), copia: "sin formato" } }),
      ),
    ).toThrow(/identificador de copia/);
  });
});

describe("el modo agregado no puede filtrar identidad", () => {
  it("la rama agregada NO TIENE dónde poner una fila", () => {
    // No es que no se impriman: el schema es estricto y la propiedad no existe en la rama.
    expect(() =>
      parsearVistaListadoMora(listadoAgregadoMuestra({ detalle: { modo: "agregado", filas: filasMuestra() } })),
    ).toThrow();
  });

  it.each(["titular", "unidad", "unidadId", "manzana", "lote", "coeficiente", "email", "dni"])(
    "la rama agregada rechaza el campo «%s», aunque venga de un llamador distraído",
    (campo) => {
      expect(() =>
        parsearVistaListadoMora(listadoAgregadoMuestra({ detalle: { modo: "agregado", [campo]: "algo" } })),
      ).toThrow();
    },
  );

  it("ninguna celda publicable puede describir a menos de k unidades", () => {
    const base = listadoAgregadoMuestra() as any;
    base.resumen.porInstancia = [
      { etiqueta: "Gestión administrativa", unidades: 9, importe: cifra("4200000.00"), fusionada: false },
      { etiqueta: "Derivado a estudio jurídico", unidades: 3, importe: cifra("8000000.00"), fusionada: false },
    ];
    expect(() => parsearVistaListadoMora(base)).toThrow(/describe 3 unidades y el piso es 5/);
  });

  it("k no se puede bajar del piso duro", () => {
    const base = listadoAgregadoMuestra() as any;
    base.politica.kAnonimato = K_ANONIMATO_MINIMO - 1;
    expect(() => parsearVistaListadoMora(base)).toThrow();
  });

  it("la concentración se calcula sobre al menos k unidades: por debajo publica el saldo de alguien", () => {
    const base = listadoAgregadoMuestra() as any;
    base.resumen.concentracion = { unidades: 2, importe: cifra("3800000.00"), participacionTexto: "31,15" };
    expect(() => parsearVistaListadoMora(base)).toThrow(/por debajo publica el saldo de alguien/);
  });

  // Un campo por caso: si se rompen dos a la vez, el test pasa aunque exista un solo chequeo.
  it.each([
    ["resumen.total", (b: any) => (b.resumen.total = cifra("12200001.00"))],
    ["resumen.porInstancia[1].importe", (b: any) => (b.resumen.porInstancia[1].importe = cifra("8000001.00"))],
    ["resumen.concentracion.importe", (b: any) => (b.resumen.concentracion.importe = cifra("8000001.00"))],
    [
      "resumen.tramos[0].importe",
      (b: any) => {
        b.resumen.tramos = [{ etiqueta: "1 período", unidades: 12, importe: cifra("12200001.00"), fusionada: false }];
      },
    ],
  ])("«%s» no se puede publicar sin redondear: un importe exacto es una huella", (_campo, romper) => {
    const base = listadoAgregadoMuestra() as any;
    romper(base);
    expect(() => parsearVistaListadoMora(base)).toThrow(/redondead[oa]s? al múltiplo de 1000/);
  });

  it("el conteo de unidades del documento también está sujeto a k", () => {
    // Es lo que se imprime más grande y más arriba de la página 1. Sin este piso, un agregado con las
    // dos listas de celdas vacías publicaba "$ 100.000,00 — 3 unidades con saldo al corte", que es
    // una nómina de tres personas escrita de otra manera.
    const base = listadoAgregadoMuestra() as any;
    base.resumen.unidades = 3;
    base.resumen.porInstancia = [];
    base.resumen.concentracion = faltante("sin concentración");
    expect(() => parsearVistaListadoMora(base)).toThrow(/el documento describe 3 unidades y el piso es 5/);
  });

  it("suprimir un tramo por debajo de k y publicar el resto lo deja calculable por resta", () => {
    // El docstring del archivo promete fusión, nunca supresión. Sin este control, la promesa era
    // sólo un comentario: la celda suprimida sale del total menos las publicadas.
    const base = listadoAgregadoMuestra() as any;
    base.resumen.tramos = [
      { etiqueta: "1 período", unidades: 7, importe: cifra("4200000.00"), fusionada: false },
      { etiqueta: "más de 12 períodos", unidades: 5, importe: cifra("8000000.00"), fusionada: false },
    ];
    base.resumen.unidades = 13; // una unidad y sus $200.000 quedarían afuera, sin decirlo
    base.resumen.porInstancia = [];
    expect(() => parsearVistaListadoMora(base)).toThrow(/los tramos describen 12 unidades y el resumen declara 13/);
  });

  it("la participación de la concentración sale del mismo denominador que el total impreso", () => {
    const base = listadoAgregadoMuestra() as any;
    base.resumen.concentracion.participacionTexto = "99,99";
    expect(() => parsearVistaListadoMora(base)).toThrow(/la participación impresa dice 99,99 %/);
  });

  it("la concentración no puede tomar más unidades que las que tiene el listado", () => {
    const base = listadoAgregadoMuestra() as any;
    base.resumen.concentracion.unidades = 40;
    expect(() => parsearVistaListadoMora(base)).toThrow(/toma 40 unidades y el listado tiene 12/);
  });

  it("la evolución también se redondea: si no, el total anterior sale por diferencia", () => {
    const base = listadoAgregadoMuestra() as any;
    base.resumen.evolucion = {
      corteAnterior: { iso: "2026-04-30", texto: "30/04/2026" },
      totalAnterior: cifra("11000000.00"),
      variacionImporte: cifra("1200000.37"),
      variacionTexto: "+ $ 1.200.000,37",
      unidadesAnterior: 11,
    };
    expect(() => parsearVistaListadoMora(base)).toThrow(/el total anterior se recupera por diferencia/);
  });

  it("el modo del detalle no puede contradecir a la política congelada", () => {
    const base = listadoAgregadoMuestra() as any;
    base.politica.modo = "nominado";
    expect(() => parsearVistaListadoMora(base)).toThrow(/la política dice/);
  });
});

describe("lo que el documento dice de sí mismo", () => {
  it("el título impreso no califica a nadie y no es configurable", () => {
    expect(TITULO_LISTADO_MORA).toBe("Estado de saldos pendientes");
    expect(TITULO_LISTADO_MORA.toLowerCase()).not.toContain("mora");
    expect(TITULO_LISTADO_MORA.toLowerCase()).not.toContain("deudor");
  });

  it("el respaldo de la decisión se declara o se declara faltante, nunca se omite", () => {
    const v = parsearVistaListadoMora(listadoNominadoMuestra());
    const detalle = v.detalle as { respaldoDecision: unknown };
    expect(esFaltante(detalle.respaldoDecision)).toBe(false);

    const sinRespaldo = listadoNominadoMuestra() as any;
    delete sinRespaldo.detalle.respaldoDecision;
    expect(() => parsearVistaListadoMora(sinRespaldo)).toThrow();
  });

  it("los tramos y el total no se contradicen", () => {
    const base = listadoNominadoMuestra() as any;
    base.resumen.tramos = [
      { etiqueta: "1 período", unidades: 7, importe: cifra("4200000.00"), fusionada: false },
      { etiqueta: "3 a 6 períodos", unidades: 5, importe: cifra("7000000.00"), fusionada: false },
    ];
    expect(() => parsearVistaListadoMora(base)).toThrow(/los tramos suman 11200000.00/);
  });

  it("las instancias suman la cantidad de unidades del resumen", () => {
    const base = listadoNominadoMuestra() as any;
    base.resumen.porInstancia[0].unidades = 6;
    expect(() => parsearVistaListadoMora(base)).toThrow(/las instancias suman 11 unidades/);
  });

  it(`el total del fixture es múltiplo del redondeo, así sirve para los dos modos (${TOTAL_LISTADO_MUESTRA})`, () => {
    expect(parsearVistaListadoMora(listadoAgregadoMuestra()).resumen.total.monto).toBe(TOTAL_LISTADO_MUESTRA);
  });
});
