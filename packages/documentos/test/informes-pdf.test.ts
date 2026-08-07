/**
 * Humo de PDF de los dos documentos multipágina (ADR-0001 §8, capa 4).
 *
 * Lo que sólo se puede afirmar contra un PDF de verdad, y que por eso vive en el proyecto `pdf` y no
 * en el gate barato:
 *
 *  - que un documento de varias páginas **de verdad se pagina** y no se corta,
 *  - que el encabezado de la tabla y el encabezado corrido **se repiten en cada página**, que es lo
 *    que hace interpretable una hoja arrancada de la carpeta,
 *  - que el folio y la marca de agua se estampan en **todas** las páginas, que es justamente lo que
 *    la capa DOM no puede hacer (aparece una sola vez, en el medio del documento),
 *  - y que del listado agregado no sale ni un nombre, mirando el **texto extraído del PDF** y no el
 *    HTML: es el último eslabón, y el único que ve lo que recibe el destinatario.
 */

import { describe, expect, it } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import {
  cifra,
  fechaImpresa,
  parsearVistaInformeMensual,
  parsearVistaListadoMora,
  participacion,
} from "@admin-barrios/shared/documentos";
import { aCentavos, deCentavos } from "@admin-barrios/shared/dinero";
import { crearGeneradorChromium } from "../src/adapters/chromium.ts";
import { MARCA_USO_INTERNO, solicitudDeInformeMensual, solicitudDeListadoMora } from "../src/emision-informes.ts";
import { cuerpoInformeMensual } from "../src/plantillas/informe-mensual.ts";
import {
  filasMuestra,
  informeMuestra,
  listadoAgregadoMuestra,
  listadoNominadoMuestra,
} from "../src/fixtures/informes-muestra.ts";

const CHROMIUM = process.env["CHROME_PATH"] ?? process.env["PUPPETEER_EXECUTABLE_PATH"];
const describeSiHayChromium = CHROMIUM ? describe : describe.skip;

type FilaCruda = {
  unidad: string;
  instancia: { clave: string };
  saldo: { total: { monto: string; texto: string } };
};

/**
 * Repite las filas del fixture hasta llegar a `n`, para forzar varias páginas.
 *
 * Los totales se **recalculan** en vez de escribirse a mano: el modelo de vista no acepta un total
 * que no salga de las filas, así que un fixture con números inventados no llega ni a renderizarse —
 * que es exactamente lo que se quiere de este contrato.
 */
function listadoLargo(n: number): unknown {
  const base = filasMuestra() as FilaCruda[];
  const filas = Array.from({ length: n }, (_, i) => {
    const modelo = base[i % base.length]!;
    return { ...modelo, unidad: `${String(20 + Math.floor(i / 30)).padStart(2, "0")} / ${String((i % 30) + 1).padStart(2, "0")}` };
  }).sort((a, b) => {
    // Mismo orden de trabajo que exige el modelo: instancia recuperable primero, después importe.
    const rango = (f: FilaCruda) => (f.instancia.clave === "gestion_administrativa" ? 0 : 1);
    if (rango(a) !== rango(b)) return rango(a) - rango(b);
    return Number(b.saldo.total.monto) - Number(a.saldo.total.monto);
  });

  const sumar = (xs: readonly FilaCruda[]) =>
    cifra(deCentavos(xs.reduce<bigint>((acumulado, f) => acumulado + aCentavos(f.saldo.total.monto), 0n)));
  const admin = filas.filter((f) => f.instancia.clave === "gestion_administrativa");
  const derivadas = filas.filter((f) => f.instancia.clave !== "gestion_administrativa");
  const total = sumar(filas);
  const mayores = [...filas].sort((a, b) => Number(b.saldo.total.monto) - Number(a.saldo.total.monto)).slice(0, 5);

  return listadoNominadoMuestra({
    detalle: {
      modo: "nominado",
      filas,
      respaldoDecision: { tipo: "acta", referencia: "Acta de directorio N.º 12", fecha: fechaImpresa("2025-11-20") },
      copia: "AB12-3",
    },
    resumen: {
      ...(listadoNominadoMuestra() as { resumen: Record<string, unknown> }).resumen,
      total,
      unidades: n,
      porInstancia: [
        { etiqueta: "Gestión administrativa", unidades: admin.length, importe: sumar(admin), fusionada: false },
        { etiqueta: "Derivado a estudio jurídico", unidades: derivadas.length, importe: sumar(derivadas), fusionada: false },
      ],
      concentracion: {
        unidades: mayores.length,
        importe: sumar(mayores),
        participacionTexto: participacion(sumar(mayores).monto, total.monto),
      },
    },
  });
}

describeSiHayChromium("los documentos multipágina de la familia", () => {
  it("el informe mensual sale entero y con el folio en todas las páginas", async () => {
    const generador = crearGeneradorChromium({ rutaEjecutable: CHROMIUM });
    const vista = parsearVistaInformeMensual(informeMuestra());
    const pdf = await generador.generar(solicitudDeInformeMensual(vista), { timeoutMs: 120_000 });

    const doc = await getDocumentProxy(new Uint8Array(pdf));
    expect(doc.numPages).toBeGreaterThanOrEqual(1);
    const { text } = await extractText(doc, { mergePages: true });
    const plano = text.replace(/\s+/g, " ");

    // El total y el resultado salen con la MISMA cadena que el modelo de vista: es el test que
    // atrapa el bug de ICU (`Intl` degradando a formato en-US en un Node slim).
    expect(plano).toContain(vista.devengado.resultado.texto);
    expect(plano).toContain(vista.devengado.totalEgresos.texto);
    // Un folio por página, y el "de M" que evita que circule media hoja fuera de contexto.
    for (let i = 1; i <= doc.numPages; i++) expect(plano).toContain(`Página ${i} de ${doc.numPages}`);
  }, 180_000);

  it("un listado de 60 unidades ocupa varias páginas y repite los encabezados en todas", async () => {
    const generador = crearGeneradorChromium({ rutaEjecutable: CHROMIUM });
    const vista = parsearVistaListadoMora(listadoLargo(60));
    const pdf = await generador.generar(solicitudDeListadoMora(vista), { timeoutMs: 180_000 });

    const doc = await getDocumentProxy(new Uint8Array(pdf));
    expect(doc.numPages).toBeGreaterThan(1);

    // Página por página, y no sobre el texto pegado: lo que se afirma es que CADA hoja suelta se
    // puede interpretar sola.
    for (let i = 1; i <= doc.numPages; i++) {
      const pagina = await doc.getPage(i);
      const contenido = await pagina.getTextContent();
      const texto = contenido.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ");
      // Encabezado corrido: barrio, documento y fecha de corte.
      expect(texto).toContain("Los Aromos");
      expect(texto).toContain("Corte 31/05/2026");
      // Encabezado de la tabla: repetido por `display:table-header-group`.
      expect(texto).toContain("Saldo al corte".toUpperCase());
      // El sello del renderizador, en TODAS las páginas y no sólo en la del medio.
      expect(texto).toContain(MARCA_USO_INTERNO);
      expect(texto).toContain(`Página ${i} de ${doc.numPages}`);
    }
  }, 240_000);

  it("del PDF agregado no se puede extraer ni un nombre ni una unidad", async () => {
    const generador = crearGeneradorChromium({ rutaEjecutable: CHROMIUM });
    const vista = parsearVistaListadoMora(listadoAgregadoMuestra());
    const pdf = await generador.generar(solicitudDeListadoMora(vista), { timeoutMs: 120_000 });

    const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)), { mergePages: true });
    const plano = text.replace(/\s+/g, " ");
    for (const fila of filasMuestra() as { titular: string; unidad: string }[]) {
      expect(plano).not.toContain(fila.titular);
      expect(plano).not.toContain(fila.unidad);
    }
    // Y tampoco lleva la marca de uso interno: no contiene datos personales que proteger.
    expect(plano).not.toContain(MARCA_USO_INTERNO);
  }, 180_000);

  /**
   * **El pie de una tabla larga aparece UNA sola vez, al final de verdad.**
   *
   * Es el defecto que se vio en la pieza generada con los números reales: Chromium repite el `tfoot`
   * en cada página igual que el `thead`, así que al pie de la página 1 salía impreso
   * `Total 100,00 % — 180.429.036,45` **debajo de cinco de los doce rubros**, y con las barras de
   * participación al lado se leía como si esos cinco sumaran el total del barrio. Un encabezado
   * repetido rotula columnas y es verdadero en todas las páginas; un pie repetido afirma un total y
   * es falso en todas menos en la última.
   *
   * Se afirma sobre el **texto extraído del PDF** y no sobre el HTML, porque en el HTML el `tfoot`
   * está una sola vez las dos veces: el que lo duplica es el paginador.
   */
  it("el total de un cuadro que cruza páginas se imprime una sola vez", async () => {
    const generador = crearGeneradorChromium({ rutaEjecutable: CHROMIUM });
    // Treinta rubros de gasto que suman el total del fixture: fuerza el corte de página en el medio
    // del cuadro, que es la única condición para que el bug aparezca.
    const RUBRO = "260000.00";
    const TOTAL = "7800000.00";
    const egresos = Array.from({ length: 30 }, (_, i) => ({
      // El primero es el renglón de honorarios, que el modelo de vista exige siempre presente
      // (doc 10 §D.3): un cuadro de gasto sin él no llega ni a renderizarse.
      clave: i === 0 ? "honorarios_administracion" : `rubro_${i + 1}`,
      etiqueta: i === 0 ? "Honorarios de administración" : `Rubro de gasto número ${i + 1}`,
      importe: cifra(RUBRO),
      participacionTexto: participacion(RUBRO, TOTAL),
      desagregado: [],
      lineasDeOrigen: 1,
    }));
    const base = informeMuestra() as { devengado: Record<string, unknown> };
    const vista = parsearVistaInformeMensual(
      informeMuestra({ devengado: { ...base.devengado, egresos } } as never),
    );

    const pdf = await generador.generar(solicitudDeInformeMensual(vista), { timeoutMs: 120_000 });
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    const { text } = await extractText(doc, { mergePages: true });
    const plano = text.replace(/\s+/g, " ");

    // El cuadro de gastos cruza de página: si no cruzara, el test no probaría nada.
    expect(doc.numPages).toBeGreaterThan(1);
    // **El paginador no puede agregar una cifra que el documento no escribió.** Se cuenta contra el
    // HTML en vez de contra un número fijo: cuántos "100,00 %" tiene el informe depende del barrio
    // —el cuadro de ingresos de un solo grupo aporta el suyo— y lo que se afirma no es cuántos son,
    // sino que **son los mismos en el papel que en el markup**.
    const enElMarkup = cuerpoInformeMensual(vista).split("100,00 %").length - 1;
    expect(plano.split("100,00 %").length - 1).toBe(enElMarkup);
  }, 180_000);

  /**
   * **Criterio 6 de doc 10 §I.10: ningún gráfico agrega una página.**
   *
   * No se afirma un número de páginas —eso depende de cuántos grupos de gasto tenga el barrio, que es
   * dato y no diseño— sino lo único que importa y que además es cierto para cualquier barrio: **el
   * mismo documento, con y sin formas, ocupa lo mismo**. Una hoja más son ~500 hojas más por mes en un
   * barrio de 510 unidades, más el trabajo de alguien que las abrocha. Un gráfico no vale una hoja.
   */
  it("las tiras del informe no agregan una página", async () => {
    const generador = crearGeneradorChromium({ rutaEjecutable: CHROMIUM });
    const punto = (periodo: string, texto: string) => ({
      periodo,
      etiqueta: `${periodo.slice(5)}/${periodo.slice(0, 4)}`,
      texto,
      unidades: null,
    });
    const conTiras = informeMuestra({
      series: {
        resultado: {
          puntos: [
            punto("2026-01", "-400.000,00"),
            punto("2026-02", "300.000,00"),
            punto("2026-03", "900.000,00"),
            punto("2026-04", "800.000,00"),
            punto("2026-05", "1.200.000,00"),
          ],
        },
        deudaProveedores: {
          puntos: [
            punto("2026-03", "1.200.000,00"),
            punto("2026-04", "1.500.000,00"),
            punto("2026-05", "2.000.000,00"),
          ],
        },
      },
    } as never);

    const paginas = async (vista: unknown) => {
      const pdf = await generador.generar(
        solicitudDeInformeMensual(parsearVistaInformeMensual(vista)),
        { timeoutMs: 120_000 },
      );
      return (await getDocumentProxy(new Uint8Array(pdf))).numPages;
    };

    expect(await paginas(conTiras)).toBe(await paginas(informeMuestra()));
  }, 240_000);

  /**
   * El listado ya no lleva ninguna tira —G-5 se descartó (doc 10 §I.4, descarte 9)— así que acá no
   * hay un "con y sin" que comparar: quedan las barras de participación, que cuestan **0 mm** por
   * vivir en filas que la tabla ya paga. Lo que sigue valiendo del criterio 6 es la afirmación sobre
   * la versión agregada: **es la que se distribuye y entra en una hoja.**
   */
  it("la versión agregada del listado entra en una sola hoja, con barras y todo", async () => {
    const generador = crearGeneradorChromium({ rutaEjecutable: CHROMIUM });
    const pdf = await generador.generar(
      solicitudDeListadoMora(parsearVistaListadoMora(listadoAgregadoMuestra())),
      { timeoutMs: 180_000 },
    );
    expect((await getDocumentProxy(new Uint8Array(pdf))).numPages).toBe(1);
  }, 180_000);

  it("un documento de paginación variable NO se puede meter en un lote", async () => {
    const generador = crearGeneradorChromium({ rutaEjecutable: CHROMIUM });
    const dos = [
      solicitudDeInformeMensual(parsearVistaInformeMensual(informeMuestra())),
      solicitudDeInformeMensual(parsearVistaInformeMensual(informeMuestra())),
    ];
    // Sin la cuenta de páginas no hay forma de saber dónde termina uno y empieza el otro: partir por
    // posición entregaría media rendición con el pie de otro barrio.
    await expect(generador.generarLote(dos, { timeoutMs: 120_000, chunk: 2 })).rejects.toThrow(
      /paginación variable se renderiza solo/,
    );
  }, 180_000);
});
