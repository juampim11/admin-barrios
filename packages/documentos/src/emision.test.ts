/**
 * La salvaguarda del ADR-0001 §10: **la marca de agua no es opcional y no se puede apagar.**
 *
 * Un documento con un código de barras legible y un importe se parece demasiado a un instrumento de
 * pago real como para que esa marca dependa de que alguien se acuerde de activarla.
 */

import { describe, expect, it } from "vitest";
import { MARCA_MUESTRA, MARGENES_BOLETA_MM, solicitudDeBoleta, solicitudesDeBoletas } from "./emision.ts";
import { htmlCompleto } from "./generador.ts";
import { crearRegistroMediosCobranza } from "./cobranza/medio-cobranza.ts";
import { revisarTextosImpresos, textosImpresosDeBoleta } from "./lenguaje-prohibido.ts";
import { vistaBoletaDeMuestra } from "./fixtures/boleta-muestra.ts";

const conDemo = vistaBoletaDeMuestra();

describe("marca de agua", () => {
  it("con el medio de demostración sale siempre, con el texto exacto", () => {
    expect(conDemo.bloquePago.sinValorDePago).toBe(true);
    expect(solicitudDeBoleta(conDemo).marcaAgua).toBe(MARCA_MUESTRA);
    expect(MARCA_MUESTRA).toBe("MUESTRA — SIN VALOR DE PAGO");
  });

  it("no hay parámetro que la desactive: `solicitudDeBoleta` solo acepta fuentes", () => {
    // Si alguien agregara una opción para apagarla, este test seguiría pasando — pero el `as` de
    // abajo obliga a que el intento sea explícito y visible en el diff.
    const conIntento = solicitudDeBoleta(conDemo, { marcaAgua: null } as unknown as { fuentes?: never });
    expect(conIntento.marcaAgua).toBe(MARCA_MUESTRA);
  });

  it("sale de la vista y no del markup: la plantilla no la contiene", () => {
    const solicitud = solicitudDeBoleta(conDemo);
    expect(solicitud.cuerpo).not.toContain(MARCA_MUESTRA);
    expect(solicitud.estilos).not.toContain(MARCA_MUESTRA);
  });

  it("un medio de cobranza real (sin `sinValorDePago`) no lleva marca", () => {
    const sinMarca = vistaBoletaDeMuestra({
      bloquePago: { ...conDemo.bloquePago, medio: "banco-ficticio", sinValorDePago: false },
    });
    // El adapter ficticio verifica bien y no declara `sinValorDePago`: no hay marca de agua.
    const registro = crearRegistroMediosCobranza([
      {
        clave: "banco-ficticio",
        armarBloquePago: () => sinMarca.bloquePago,
        verificar: () => ({ ok: true }),
      },
    ]);
    expect(solicitudDeBoleta(sinMarca, { registro }).marcaAgua).toBeNull();
  });

  it("el medio de demostración NO puede emitir sin declarar `sinValorDePago`", () => {
    // Es el camino por el que se colaría una muestra que se lee como un instrumento real: el mismo
    // convenio inexistente, el mismo código de barras, y sin la marca de agua encima. Entra por
    // acá porque la re-emisión desde una vista congelada no pasa por ningún adapter al armarse.
    const disfrazada = vistaBoletaDeMuestra({
      bloquePago: { ...conDemo.bloquePago, sinValorDePago: false },
    });
    expect(() => solicitudDeBoleta(disfrazada)).toThrow(/marca de agua/);
  });

  it("un medio que no está registrado NO se renderiza: falla cerrado", () => {
    const desconocida = vistaBoletaDeMuestra({
      bloquePago: { ...conDemo.bloquePago, medio: "banco-que-nadie-registro" },
    });
    expect(() => solicitudDeBoleta(desconocida)).toThrow(/no tiene un medio de pago configurado/);
  });
});

describe("filtro de lenguaje (doc 07 §E)", () => {
  // El filtro se corre **al emitir** (en el armador de `packages/data`), no al re-abrir una vista
  // congelada: si viviera en `parsearVistaBoleta`, agregar una frase a la lista dejaría sin poder
  // abrirse a todas las boletas viejas que la contengan (ADR-0001 §6). Acá se prueba la función.
  it("junta TODOS los textos impresos, incluidos los que carga el cliente", () => {
    const textos = textosImpresosDeBoleta(conDemo);
    expect(textos).toContain(conDemo.leyendas[0]);
    expect(textos).toContain(conDemo.detalle.lineas[0]?.concepto);
    expect(textos).toContain(conDemo.bloquePago.leyendas[0]);
    expect(textos.some((t) => t.includes("Acta de Asamblea"))).toBe(true);
  });

  it("una leyenda del cliente con lenguaje prohibido queda marcada", () => {
    const conLeyendaMala = vistaBoletaDeMuestra({
      marca: { ...conDemo.marca, pie: ["Bajo apercibimiento de iniciar acciones legales."] },
    });
    const motivos = revisarTextosImpresos(textosImpresosDeBoleta(conLeyendaMala));
    expect(motivos.join(" ")).toMatch(/bajo apercibimiento/);
  });

  it("también el texto que carga el administrador en un cargo", () => {
    const conDetalleMalo = vistaBoletaDeMuestra({
      detalle: {
        ...conDemo.detalle,
        lineas: conDemo.detalle.lineas.map((l) =>
          l.clase === "cargo" ? { ...l, detalleHecho: "Aplicado al moroso de la Mza 99" } : l,
        ),
      },
    });
    expect(revisarTextosImpresos(textosImpresosDeBoleta(conDetalleMalo)).join(" ")).toMatch(/moroso/);
  });

  it("la boleta de muestra pasa el filtro entera", () => {
    expect(revisarTextosImpresos(textosImpresosDeBoleta(conDemo))).toEqual([]);
  });
});

describe("la solicitud", () => {
  it("una boleta = una página, y el margen inferior nunca baja de 10 mm", () => {
    const solicitud = solicitudDeBoleta(conDemo);
    expect(solicitud.paginasEsperadas).toBe(1);
    expect(solicitud.formato).toBe("A4");
    expect(MARGENES_BOLETA_MM.bottom).toBeGreaterThanOrEqual(10);
  });

  it("todas las boletas del lote comparten los mismos estilos: una pasada, un juego de fuentes", () => {
    const solicitudes = solicitudesDeBoletas([conDemo, conDemo, conDemo]);
    expect(new Set(solicitudes.map((s) => s.estilos)).size).toBe(1);
  });

  it("re-valida la vista aunque venga tipada: es el borde por el que entra un documento", () => {
    const rota = { ...conDemo, totales: { ...conDemo.totales, aPagar: { monto: "1.00", texto: "1,00" } } };
    expect(() => solicitudDeBoleta(rota as typeof conDemo)).toThrow();
  });

  it("el HTML autónomo (email y vista web) sale del mismo markup que el PDF", () => {
    const solicitud = solicitudDeBoleta(conDemo);
    const pagina = htmlCompleto(solicitud, "Boleta");
    expect(pagina).toContain(solicitud.cuerpo);
    expect(pagina).toContain("<!doctype html>");
    // Los márgenes viajan como variables: la plantilla no repite el número.
    expect(pagina).toContain("--m-bottom:10mm");
  });

  it("rechaza una fuente que no venga embebida como data:", () => {
    expect(() =>
      solicitudDeBoleta(conDemo, {
        fuentes: [{ familia: "Geist", peso: 400, formato: "woff2", dataUri: "https://fonts.ejemplo.test/geist.woff2" }],
      }),
    ).toThrow(/data:/);
  });
});
