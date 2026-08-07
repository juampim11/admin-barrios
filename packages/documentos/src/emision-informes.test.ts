/**
 * La capa 2 de ADR-0001 §8 para los dos documentos nuevos: **estructura del HTML, no apariencia**.
 *
 * Lo que se afirma acá es lo que un diff de píxeles no puede afirmar y una regresión visual no
 * bloquea: que ninguna cifra impresa difiera del modelo, que no salga ninguna URL a la red, que el
 * lenguaje prohibido corte la emisión, y —lo más importante— que **del listado agregado no salga ni
 * un nombre ni una unidad**.
 */

import { describe, expect, it } from "vitest";
import { cifra, faltante, parsearVistaInformeMensual, parsearVistaListadoMora } from "@admin-barrios/shared/documentos";
import {
  contarPendientesDelInforme,
  MARCA_USO_INTERNO,
  solicitudDeInformeMensual,
  solicitudDeListadoMora,
} from "./emision-informes.ts";
import { cuerpoInformeMensual } from "./plantillas/informe-mensual.ts";
import { columnasDelListado, cuerpoListadoMora } from "./plantillas/listado-mora.ts";
import { ANCHO_UTIL_ARCHIVO_MM } from "./plantillas/comun.ts";
import {
  filasMuestra,
  informeMuestra,
  listadoAgregadoMuestra,
  listadoNominadoMuestra,
  MARCA_MUESTRA_INFORME,
  POLITICA_MUESTRA,
} from "./fixtures/informes-muestra.ts";

const informe = parsearVistaInformeMensual(informeMuestra());
const nominado = parsearVistaListadoMora(listadoNominadoMuestra());
const agregado = parsearVistaListadoMora(listadoAgregadoMuestra());

/** PNG de 1×1 transparente. Alcanza: lo que se prueba es la forma del `src`, no la imagen. */
const LOGO_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const conLogo = (marca: typeof MARCA_MUESTRA_INFORME) => ({
  ...marca,
  barrio: { ...marca.barrio, logo: { dataUri: LOGO_DATA_URI, altoMaxMm: 20, anchoMaxMm: 45 } },
});
const informeConLogo = parsearVistaInformeMensual(informeMuestra({ marca: conLogo(MARCA_MUESTRA_INFORME) as never }));
const listadoConLogo = parsearVistaListadoMora(listadoNominadoMuestra({ marca: conLogo(MARCA_MUESTRA_INFORME) }));

/** Cualquier cosa que salga a la red. La red está apagada: saldría en blanco, o peor. */
const URL_EXTERNA = /(src|href|url\()\s*=?\s*["']?(https?:|\/\/)/i;

describe("el HTML no sale a la red y no formatea nada por su cuenta", () => {
  it("el detector de URLs externas detecta de verdad (si no, los tres casos de abajo no prueban nada)", () => {
    expect('<img src="https://cdn.ejemplo.com/logo.png">').toMatch(URL_EXTERNA);
    expect('<link href="//cdn.ejemplo.com/a.css">').toMatch(URL_EXTERNA);
    expect(`background:url(http://x/y.png)`).toMatch(URL_EXTERNA);
  });

  it.each([
    ["informe mensual", cuerpoInformeMensual(informe)],
    ["listado nominado", cuerpoListadoMora(nominado)],
    ["listado agregado", cuerpoListadoMora(agregado)],
    // Con logo, que es el único camino de la plantilla que emite un `<img src>`: sin este caso, los
    // otros tres pasaban porque el fixture no tiene logo y nunca se llega a la etiqueta.
    ["informe con logo del barrio", cuerpoInformeMensual(informeConLogo)],
    ["listado con logo del barrio", cuerpoListadoMora(listadoConLogo)],
  ])("%s: ninguna URL externa", (_nombre, html) => {
    expect(html).not.toMatch(URL_EXTERNA);
  });

  it("el logo entra como data:, que es lo único que el renderizador deja pasar", () => {
    expect(cuerpoInformeMensual(informeConLogo)).toContain('<img src="data:image/png;base64,');
  });

  it("toda cifra impresa del informe es exactamente la del modelo de vista", () => {
    const html = cuerpoInformeMensual(informe);
    for (const c of [
      informe.devengado.totalIngresos,
      informe.devengado.totalEgresos,
      informe.devengado.resultado,
      informe.conciliacion.movimientoDeFondos,
    ]) {
      expect(html).toContain(c.texto);
    }
    // Y el formato es el argentino, no el que devolvería `Intl` sin ICU completo.
    expect(informe.devengado.resultado.texto).toBe("1.200.000,00");
    expect(html).not.toContain("1,200,000.00");
  });

  it("el informe imprime el período y la fecha de corte, que es el defecto 9 del documento actual", () => {
    const html = cuerpoInformeMensual(informe);
    expect(html).toContain("05/2026");
    expect(html).toContain("31/05/2026");
    // La banda que evita el malentendido más caro del envío. Va en versalitas por CSS, no en el
    // markup: el texto que se busca es el que está escrito.
    expect(html).toContain("Este informe no es del período de la boleta.");
  });

  it("el informe nunca imprime el nombre de una persona humana, sólo cuántas son", () => {
    const html = cuerpoInformeMensual(informe);
    expect(html).toContain("Personal de mantenimiento");
    expect(html).toContain("(2 personas)");
    // La razón social de una empresa sí se publica: es información de contratación del barrio.
    expect(html).toContain("Vigía S.A.");
  });

  it("las secciones rotuladas con letra se referencian entre sí (defecto 3 del documento actual)", () => {
    const html = cuerpoInformeMensual(informe);
    expect(html).toContain("A · Resultado del período");
    expect(html).toContain("B · Situación financiera");
    expect(html).toContain("C · Cómo se pasa de A a B");
    // La sección C referencia a A y la B referencia a A: ninguna letra queda definida sin usar.
    expect(html).toContain("Resultado del período (A)");
    expect(html).toContain("(sección A)");
  });

  it("hay UN solo cuadro de fondos (defecto 2: el documento actual imprime dos idénticos)", () => {
    const html = cuerpoInformeMensual(informe);
    const veces = html.split("Fondos al cierre del período").length - 1;
    expect(veces).toBe(1);
  });

  it("el pie legal del emisor se imprime aunque no haya leyendas", () => {
    // La guarda miraba `leyendas` y el bloque imprimía `leyendas + marca.pie`: un informe sin
    // leyendas se llevaba puesto el dato del emisor, que es obligatorio.
    const sinLeyendas = parsearVistaInformeMensual(informeMuestra({ leyendas: [] }));
    expect(cuerpoInformeMensual(sinLeyendas)).toContain("Consultas: administracion@losaromos.test");
  });

  it("los dos documentos cierran con el mismo bloque: huecos, notas, leyendas y pie", () => {
    // Estaba copiado y ya había divergido. Lo que se afirma es que las dos plantillas lo comparten.
    for (const html of [cuerpoInformeMensual(informe), cuerpoListadoMora(nominado)]) {
      expect(html).toContain("Qué falta cargar (");
      expect(html).toContain("Consultas: administracion@losaromos.test");
    }
  });

  it("un dato pendiente se imprime como pendiente, nunca como cero ni como guion", () => {
    const html = cuerpoInformeMensual(informe);
    expect(html).toContain('class="pendiente"');
    expect(html).toContain("Fondo de reserva");
    expect(contarPendientesDelInforme(informe)).toBe(1);
  });
});

describe("del listado agregado no sale ni un nombre ni una unidad", () => {
  it("ninguno de los doce titulares del fixture aparece en el HTML agregado", () => {
    const html = cuerpoListadoMora(agregado);
    for (const fila of filasMuestra() as { titular: string; unidad: string }[]) {
      expect(html).not.toContain(fila.titular);
      expect(html).not.toContain(fila.unidad);
    }
  });

  it("y en el nominado sí aparecen: es la diferencia entre los dos modos, no un accidente", () => {
    const html = cuerpoListadoMora(nominado);
    expect(html).toContain("PÉREZ, ANA");
    expect(html).toContain("01 / 04");
  });

  it("el agregado no lleva identificador de copia ni marca de uso interno", () => {
    const doc = solicitudDeListadoMora(agregado);
    expect(doc.selloPorPagina?.marcaAgua).toBeNull();
    expect(doc.cuerpo).not.toContain("Copia");
  });
});

describe("las guardas de emisión", () => {
  it("el listado nominado lleva marca de agua en TODAS las páginas, derivada del modo", () => {
    const doc = solicitudDeListadoMora(nominado);
    expect(doc.selloPorPagina).toEqual({ marcaAgua: MARCA_USO_INTERNO, numerarPaginas: true });
    // No hay parámetro que la apague: la re-emisión desde una vista congelada entra por acá.
    expect(MARCA_USO_INTERNO).toContain("DATOS PERSONALES");
  });

  it("los dos documentos declaran paginación variable: la cantidad de páginas es dato, no diseño", () => {
    expect(solicitudDeInformeMensual(informe).paginasEsperadas).toBe("variable");
    expect(solicitudDeListadoMora(nominado).paginasEsperadas).toBe("variable");
  });

  it("los márgenes son los de archivo: 18 mm a la izquierda para la perforadora", () => {
    expect(solicitudDeInformeMensual(informe).margenesMm).toEqual({ top: 12, right: 14, bottom: 12, left: 18 });
  });

  it("el lenguaje prohibido CORTA la emisión, no avisa", () => {
    const conLenguaje = parsearVistaListadoMora(
      listadoNominadoMuestra({ leyendas: ["Se publicará el nombre de quien no regularice."] }),
    );
    expect(() => solicitudDeListadoMora(conLenguaje)).toThrow(/lenguaje que este documento no puede imprimir/);
  });

  it("y también en el informe, incluido el texto que carga el cliente", () => {
    const conLenguaje = parsearVistaInformeMensual(
      informeMuestra({ leyendas: ["Se iniciarán acciones legales."] as never }),
    );
    expect(() => solicitudDeInformeMensual(conLenguaje)).toThrow(/lenguaje que este documento no puede imprimir/);
  });

  it("el MOTIVO de un hueco también pasa por el filtro: se imprime entero al pie", () => {
    const filas = filasMuestra() as { antiguedad: unknown }[];
    filas[0]!.antiguedad = faltante("no se registró desde cuándo el moroso dejó de pagar");
    const v = parsearVistaListadoMora(
      listadoNominadoMuestra({ detalle: { modo: "nominado", filas, respaldoDecision: faltante("x"), copia: "AB12-3" } }),
    );
    expect(() => solicitudDeListadoMora(v)).toThrow(/lenguaje que este documento no puede imprimir/);
  });

  it("y en el informe, donde el motivo sale dentro de la celda", () => {
    const roto = informeMuestra() as any;
    roto.denominadores[1].valorTexto = faltante("el fondo de reserva del deudor no se cargó");
    expect(() => solicitudDeInformeMensual(parsearVistaInformeMensual(roto))).toThrow(
      /lenguaje que este documento no puede imprimir/,
    );
  });

  it("el nombre del titular NO pasa por el filtro de lenguaje", () => {
    // Si alguien se apellida como una palabra prohibida, el filtro bloquearía todo el listado por un
    // apellido — y de paso dejaría escrito en el log que ese apellido está en la nómina.
    const filas = filasMuestra() as { titular: string }[];
    filas[0]!.titular = "VERAZ, MARTA";
    const v = parsearVistaListadoMora(
      listadoNominadoMuestra({ detalle: { modo: "nominado", filas, respaldoDecision: faltante("x"), copia: "AB12-3" } }),
    );
    expect(() => solicitudDeListadoMora(v)).not.toThrow();
  });

  it("no se emite para destinatarios que el sistema todavía no sabe resolver", () => {
    const v = parsearVistaListadoMora(
      listadoNominadoMuestra({ politica: { ...POLITICA_MUESTRA, destinatarios: "propietarios" } }),
    );
    expect(() => solicitudDeListadoMora(v)).toThrow(/todavía no existe el vínculo entre un usuario y su unidad funcional/);
  });
});

describe("el presupuesto de anchos del listado", () => {
  it("las columnas declaradas entran en la hoja con TODAS presentes", () => {
    // Es lo que evita que el titular quede en 9 mm y los nombres se aplasten: la guarda de desbordes
    // del renderizador no ve un nombre que envuelve, así que el control tiene que estar acá.
    const { columnas } = columnasDelListado([]);
    expect(columnas.reduce((a, c) => a + c.mm, 0)).toBeLessThanOrEqual(ANCHO_UTIL_ARCHIVO_MM);
  });

  it("una celda de columna accesoria que falta se MARCA, no sale en blanco", () => {
    // Con la mitad de las filas con antigüedad cargada, la columna sobrevive al corte del 50 % y las
    // que faltan tienen que decir que faltan.
    // El tramo se carga **igual dentro de cada bloque**: la antigüedad participa del orden de
    // trabajo, así que mezclarla dentro de un bloque desordenaría el listado y el modelo lo
    // rechazaría por otro motivo, tapando lo que este test quiere ver.
    const filas = filasMuestra() as any[];
    for (const f of filas) {
      if (f.instancia.clave === "gestion_administrativa") f.antiguedad = "de_3_a_6";
    }
    const v = parsearVistaListadoMora(
      listadoNominadoMuestra({ detalle: { modo: "nominado", filas, respaldoDecision: faltante("x"), copia: "AB12-3" } }),
    );
    const html = cuerpoListadoMora(v);
    expect(html).not.toContain('<td class=" antiguedad"></td>');
    expect(html).toContain("3 a 6 períodos");
  });

  it("multas y cargos comparten columna y se desagregan en la segunda línea", () => {
    const filas = filasMuestra() as any[];
    filas[0].saldo = {
      total: cifra("900000.00"),
      capital: cifra("800000.00"),
      intereses: cifra("70000.00"),
      multas: cifra("20000.00"),
      cargos: cifra("10000.00"),
    };
    const v = parsearVistaListadoMora(
      listadoNominadoMuestra({ detalle: { modo: "nominado", filas, respaldoDecision: faltante("x"), copia: "AB12-3" } }),
    );
    const html = cuerpoListadoMora(v);
    expect(html).toContain("Otros cargos");
    expect(html).toContain("30.000,00"); // multas + cargos, en la columna
    expect(html).toContain("Multas 20.000,00 · Cargos 10.000,00"); // desagregado, en la segunda línea
  });
});

describe("el encabezado y el pie corridos", () => {
  it.each([
    ["informe mensual", cuerpoInformeMensual(informe)],
    ["listado nominado", cuerpoListadoMora(nominado)],
  ])("%s: el encabezado repetido dice barrio, documento, corte y criterio", (_n, html) => {
    expect(html).toContain('<thead><tr><td><div class="corrido">');
    expect(html).toContain("Los Aromos");
    expect(html).toContain("Importes en pesos");
    expect(html).toContain('<tfoot><tr><td><div class="pie">');
    // El hueco del folio: lo estampa el renderizador, la plantilla sólo lo reserva.
    expect(html).toContain('class="folio cifra"');
  });

  it("la franja de acento va fuera de la tabla: en el flujo quedaría debajo del encabezado", () => {
    const html = cuerpoInformeMensual(informe);
    expect(html.indexOf('class="franja"')).toBeLessThan(html.indexOf('<table class="hoja">'));
  });

  it.each([
    ["informe mensual", cuerpoInformeMensual(informe)],
    ["listado nominado", cuerpoListadoMora(nominado)],
  ])("%s: la cabecera no tartamudea — ni el barrio ni el emisor salen dos veces", (_n, html) => {
    // La franja de arriba decía el barrio y quién administra, y tres renglones más abajo el bloque
    // del logo repetía los dos. Cada nivel de marca (§E.9.0) sigue entero, pero **una sola vez**: el
    // barrio arriba (encabezado corrido + caja de marca), la administración abajo como emisor legal.
    const corrido = html.slice(html.indexOf('class="corrido"'), html.indexOf('class="pie"'));
    const zona0 = html.slice(html.indexOf('class="zona0"'), html.indexOf('class="zona-p"'));

    expect(corrido.split("Los Aromos").length - 1).toBe(1);
    expect(corrido).not.toContain("Administra:");

    expect(zona0.split("Administra: Administración Los Aromos S.R.L.").length - 1).toBe(1);
    // El nombre del barrio en texto corrido no vuelve a salir. Lo que sí queda es la caja de marca:
    // acá, sin logo cargado, el logotipo tipográfico con el nombre en versales — que es la marca del
    // barrio, no un renglón repetido.
    expect(zona0).not.toContain(">Los Aromos<");
    expect(zona0).toContain("LOS AROMOS");
  });

  it("el bloque de identidad no repite el domicilio que ya dice el emisor", () => {
    // Pasa siempre que la administración funciona adentro del barrio, que es el caso frecuente.
    const html = cuerpoInformeMensual(informe);
    const cabecera = html.slice(0, html.indexOf('class="zona-p"'));
    expect(cabecera.split("Camino de las Sierras Km 4").length - 1).toBe(1);
  });

  it("un documento sin emitir lo dice en el encabezado de TODAS las páginas, no suelto en la primera", () => {
    // Antes salía como un `Sin emitir` colgado arriba a la derecha del logo, pegado a la razón social
    // y a la figura jurídica: ahí se leía como un dato del emisor y no como el estado de la hoja.
    const sinEmitir = parsearVistaInformeMensual(informeMuestra({ emision: { fecha: null } }));
    const html = cuerpoInformeMensual(sinEmitir);
    const corrido = html.slice(html.indexOf('class="corrido"'), html.indexOf('class="zona0"'));
    expect(corrido).toContain("Documento sin emitir");
    expect(html.slice(html.indexOf('class="zona0"'))).not.toContain("sin emitir");
    // Y con fecha, la dice: el estado no se imprime cuando no corresponde.
    expect(cuerpoInformeMensual(informe)).toContain("Emitido 10/07/2026");
  });
});
