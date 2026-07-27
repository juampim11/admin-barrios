/**
 * Las **dos formas gráficas** de la familia de documentos (doc 10 §I).
 *
 * Un documento con cinco lenguajes gráficos es peor que uno sin ninguno, porque cada lenguaje nuevo
 * obliga al lector a aprender a leerlo antes de poder leer el dato. Acá hay dos, con el **mismo
 * vocabulario de dos estados**: *tinta llena = el valor del que habla la fila* · *contorno de 0,4 pt =
 * la referencia contra la que se lo compara*. Quien aprendió a leer una ya sabe leer la otra.
 *
 * | | **Barra de participación** | **Tira de períodos** |
 * |---|---|---|
 * | Responde | *"¿qué parte del total es esta fila?"* | *"¿esto viene subiendo o bajando?"* |
 * | Vive | dentro de una fila de tabla que ya existe | al lado del número del que es la historia |
 * | Cuesta | **0 mm verticales** | 10 mm de alto + 4 mm de rótulos |
 *
 * Cuatro reglas que este archivo hace cumplir, y que no son de estilo:
 *
 *  1. **Nada se pide por red y no hay SVG.** Las dos formas son rectángulos —una caja con borde o con
 *     fondo—, así que el dibujo es parte del documento como el filete de 0,4 pt. El renderizador
 *     aborta todo request que no sea `data:` (ADR-0001 §3.2): un gráfico que necesite red **no se ve
 *     mal, no se ve**. Y un rectángulo con medidas en pt es el mismo objeto en el PDF, en la web del
 *     residente y en mobile, sin reimplementarse.
 *  2. **La geometría se alimenta del TEXTO PUBLICADO, nunca de un monto** (§I.8.2). Las funciones de
 *     acá reciben `string` formateado y no aceptan otra cosa: si la celda publica un importe
 *     redondeado al millar, la barra lleva exactamente esa precisión y ni un dígito más. Dos filas
 *     con el mismo texto impreso dibujan barras idénticas al punto, por construcción.
 *  3. **Escala de 0 al TOTAL DEL CUADRO, nunca de 0 al máximo de la serie** (§I.5.6). Es el bug más
 *     probable de toda la sección y es un bug de dinero: con escala 0→máximo, un rubro del 11 %
 *     ocuparía el 19 % de la pista y el lector leería 19. En la tira, el eje **arranca siempre en
 *     cero y nunca se corta**: truncar un eje en un documento de rendición es fabricar una tendencia.
 *  4. **El gráfico nunca es el portador del dato** (§I.5.4). Sin escala, sin eje, sin marca de valor,
 *     sin un número por columna. El equivalente accesible es la tabla que lo contiene: si el dibujo
 *     no se renderiza, no se pierde ni un dato. Es la única razón por la que se puede meter una forma
 *     en un documento que no se puede etiquetar.
 *
 * **Sin tramas, sin grises intermedios y sin color** (§I.5.2 y §I.5.3). La distinción es siempre
 * entre *hay tinta* y *no hay tinta*: a barras de 1 mm, una trama de 45° hace moiré con la trama de la
 * impresora, se rellena en la fotocopia de segunda generación y desaparece en la captura de WhatsApp.
 * No es una precaución teórica — ya se midió en este producto con la píldora `pendiente`
 * (`printPatron.pendienteFondo`). Si una forma necesita un tercer estado, la forma está mal planteada.
 */

import { chartPrint as g, fontSizePrint as fp, printInk as tinta } from "@admin-barrios/design-tokens";
import { magnitudPublicada, type SerieHistorica } from "@admin-barrios/shared/documentos";
import { escapar } from "./comun.ts";

/**
 * Ancho útil de la pista, en pt: el interior del contorno.
 *
 * Con `box-sizing:border-box` el contorno de 0,4 pt se come 0,8 pt del ancho declarado, así que **el
 * 100 % es esto y no `trackWidth`**. Que la cuenta sea exacta importa: una fila cuyo importe es el
 * total del cuadro tiene que llenar la pista **exactamente**, ni un punto de menos.
 */
export const ANCHO_UTIL_PISTA = Number((g.trackWidth - 2 * g.rule).toFixed(2));

/** Aire entre el número de la fila y su pista, en mm. */
export const ANCHO_AIRE_PISTA_MM = 3;

/**
 * Ancho total que hay que reservarle a la columna de barras, en mm: la pista más su aire.
 *
 * Las plantillas declaran **esto** y no 18 mm sueltos. Con 18 la pista entraba justa y el aire se lo
 * comía a la columna de al lado, que en una tabla de layout automático es la del nombre del concepto
 * — la única que no se puede achicar.
 */
export const ANCHO_COLUMNA_BARRAS_MM = Math.ceil(g.trackWidth * (25.4 / 72)) + ANCHO_AIRE_PISTA_MM;

/** Redondeo a centésimas de punto: lo que se puede escribir en un `style` sin arrastrar ruido. */
function pt(valor: number): number {
  return Math.round(valor * 100) / 100;
}

// --- Forma 1 · la barra de participación --------------------------------------------------------

/**
 * Longitud del relleno de una fila, en pt, leída del texto que la fila imprime.
 *
 * Tres comportamientos que son los casos degenerados de §I.7 y no accidentes de implementación:
 *
 *  - **cero → 0** (caso 2): ausencia de tinta *es* el cero, y esa equivalencia no admite excepciones.
 *    Un cero **nunca** se dibuja con la longitud mínima;
 *  - **mayor que cero pero minúsculo → `minInk`** (caso 3): hay tinta, entonces hay algo. Declarado:
 *    una barra mínima significa *"mayor que cero"*, no *"tanto"*;
 *  - **igual o mayor que el total → la pista entera** (caso 7): una fila que se lleva el 95 % aplasta
 *    a las demás y el dibujo aplastado **es** el hallazgo. No se les "da aire" a las chicas: eso
 *    sería falsear la escala.
 */
export function anchoDeRelleno(textoValor: string, textoTotal: string): number {
  const valor = magnitudPublicada(textoValor);
  const total = magnitudPublicada(textoTotal);
  if (valor <= 0n || total <= 0n) return 0;
  if (valor >= total) return ANCHO_UTIL_PISTA;
  // La proporción se saca en enteros y recién ahí se pasa a pt: la división de dos cifras de dinero
  // no puede depender de un `number`.
  const proporcion = Number((valor * 1_000_000n) / total) / 1_000_000;
  return Math.min(ANCHO_UTIL_PISTA, Math.max(g.minInk, pt(proporcion * ANCHO_UTIL_PISTA)));
}

/**
 * Si el cuadro lleva columna de barras. **Se decide para el cuadro entero y antes que nada.**
 *
 * La jerarquía importa y es lo que evita cuadros con una barra sola al 100 %: primero se decide si el
 * cuadro lleva la columna, y recién después, fila por fila, cuánta tinta lleva cada una.
 *
 *  - **Un renglón negativo apaga la columna en TODO el cuadro** (§I.7, caso 4), no sólo en esa fila:
 *    un cuadro con un negativo **no es una partición de un todo**, y una barra de participación
 *    afirma que lo es. Es literalmente el caso del cuadro de ingresos del informe real, donde la
 *    cuota de lista daba 102,93 % y la bonificación −7,72 %.
 *  - **Con menos de tres filas con valor mayor que cero, tampoco** (§I.7, caso 6): una barra sola al
 *    100 % no compara nada, y dos barras se comparan leyendo los dos números. La forma 1 empieza a
 *    servir en la tercera fila.
 */
export function llevaColumnaDeBarras(textos: readonly (string | null)[]): boolean {
  const magnitudes = textos.filter((t): t is string => t !== null).map(magnitudPublicada);
  if (magnitudes.some((m) => m < 0n)) return false;
  return magnitudes.filter((m) => m > 0n).length >= 3;
}

/**
 * El contenido de una celda de barra: la pista, y el relleno **sólo si hay algo que dibujar**.
 *
 * `textoValor` en `null` es la fila que **no pertenece a ese todo** (un concepto extraordinario en la
 * boleta): no lleva ni pista. Es una corrección deliberada a la letra de §I.6.1, que la dejaba "con
 * pista vacía": una pista vacía ya significa **cero** (§I.7, caso 2), y un mismo dibujo no puede
 * decir dos cosas. Sin pista, la celda dice lo único cierto: *esta fila no se compara acá*.
 */
export function celdaBarra(textoValor: string | null, textoTotal: string): string {
  if (textoValor === null) return "";
  const ancho = anchoDeRelleno(textoValor, textoTotal);
  return `<span class="g-pista">${ancho === 0 ? "" : `<i style="width:${ancho}pt"></i>`}</span>`;
}

// --- Forma 2 · la tira de períodos --------------------------------------------------------------

export type ColumnaTira = {
  /** Distancia al borde izquierdo de la tira, en pt. */
  readonly x: number;
  /** Distancia al borde superior, en pt. */
  readonly y: number;
  /** Alto del rectángulo, en pt. `0` = no se dibuja (cero, o período sin informe). */
  readonly alto: number;
};

export type GeometriaTira = {
  readonly ancho: number;
  readonly alto: number;
  /** Dónde cae el cero, medido desde arriba. La línea de base se dibuja **siempre**. */
  readonly base: number;
  readonly columnas: readonly ColumnaTira[];
};

/**
 * La geometría de la tira, leída de los textos publicados.
 *
 * **El eje arranca en cero y nunca se corta** (§I.5.6). De ahí sale que la línea de base se dibuje
 * incluso cuando toda la serie es positiva: el lector nunca tiene que adivinar dónde está el cero. Y
 * de ahí sale también que un período negativo se dibuje hacia abajo en vez de recortarse — acá el
 * negativo **es** la información, y es el caso para el que la línea de base existe (§I.7, caso 5).
 *
 * Un período sin informe (`null`) **reserva su lugar y no se interpola** (§I.7, caso 8): interpolar
 * un mes de plata es inventarlo, y el hueco dice algo verdadero.
 */
export function geometriaDeTira(textos: readonly (string | null)[]): GeometriaTira {
  const valores = textos.map((t) => (t === null ? null : magnitudPublicada(t)));
  const conDato = valores.filter((v): v is bigint => v !== null);
  const maximo = conDato.reduce((a, v) => (v > a ? v : a), 0n);
  const minimo = conDato.reduce((a, v) => (v < a ? v : a), 0n);
  const rango = maximo - minimo;

  // Toda la serie en cero: queda la línea de base al pie y ni un rectángulo. Es raro y no es un error.
  const arriba = rango === 0n ? g.stripHeight : pt((Number(maximo) / Number(rango)) * g.stripHeight);

  const columnas = valores.map((valor, i) => {
    const x = pt(i * (g.colWidth + g.colGap));
    if (valor === null || valor === 0n || rango === 0n) return { x, y: arriba, alto: 0 };
    const bruto = pt((Number(valor < 0n ? -valor : valor) / Number(rango)) * g.stripHeight);
    const alto = Math.max(g.minInk, bruto);
    return valor > 0n ? { x, y: pt(arriba - alto), alto } : { x, y: arriba, alto };
  });

  return {
    ancho: pt(textos.length * g.colWidth + Math.max(0, textos.length - 1) * g.colGap),
    alto: g.stripHeight,
    base: arriba,
    columnas,
  };
}

/**
 * Cuántos períodos hacen falta para que una tira diga algo. **Con dos hay un delta, no una tendencia**
 * — y un delta es una frase, no un dibujo (§I.7, caso 1).
 */
export function sePuedeDibujarTira(serie: SerieHistorica | null): serie is SerieHistorica {
  return serie !== null && serie.puntos.length >= g.minPoints;
}

/**
 * La tira completa: el dibujo, los rótulos de sus dos extremos y —cuando corresponde— la nota del
 * máximo.
 *
 * **Rotula dos puntos y nada más**: el primer período y el último, más el valor del último (§I.5.4).
 * Nunca un número por columna.
 *
 * `rotulo: null` es el modo **pegado**, y es el que usan tres de las cuatro instancias: la tira vive
 * literalmente al lado de la cifra de la que es la historia —el resultado del período en 24 pt, el
 * renglón de cierre de la deuda, la tarjeta de cobranza— así que el título y el valor del último
 * punto **ya están impresos a dos centímetros**. Repetirlos cuesta 6 mm de alto y no agrega un dato:
 * la adyacencia es el mecanismo que §I.3 pide ("las tiras viven al lado del número del que son la
 * historia", nunca en una sección de gráficos al final). Con un rótulo, en cambio, la tira se sostiene
 * sola y entonces sí lleva su título y su último valor.
 *
 * Con menos de `minPoints` períodos **no se dibuja** y en su lugar va una línea de texto. Para `n = 2`
 * esa línea muestra los dos puntos tal como se publicaron y **no calcula la diferencia**: formatear
 * dinero en una plantilla es exactamente lo que esta familia de documentos tiene prohibido.
 */
export function tiraDePeriodos(
  serie: SerieHistorica | null,
  opciones: { readonly rotulo: string | null },
): string {
  if (serie === null) return "";
  const puntos = serie.puntos;
  const primero = puntos[0];
  const ultimo = puntos[puntos.length - 1];
  if (!primero || !ultimo) return "";
  const titulo = opciones.rotulo === null ? "" : `<div class="g-rotulo">${escapar(opciones.rotulo)}</div>`;

  if (!sePuedeDibujarTira(serie)) {
    const texto =
      puntos.length === 1
        ? "primer período liquidado en este sistema"
        : `${escapar(primero.etiqueta)} ${primero.texto === null ? "sin informe" : escapar(primero.texto)} → ` +
          `${escapar(ultimo.etiqueta)} ${ultimo.texto === null ? "sin informe" : escapar(ultimo.texto)}`;
    return `<div class="g-tira-caja">${titulo}<div class="g-nota">${texto}</div></div>`;
  }

  const geo = geometriaDeTira(puntos.map((p) => p.texto));
  const rectangulos = geo.columnas
    .filter((c) => c.alto > 0)
    .map((c) => `<i style="left:${c.x}pt;top:${c.y}pt;height:${c.alto}pt"></i>`)
    .join("");

  return [
    '<div class="g-tira-caja">',
    titulo,
    `<div class="g-tira" style="width:${geo.ancho}pt;height:${geo.alto}pt">`,
    `<b style="top:${geo.base}pt"></b>`,
    rectangulos,
    "</div>",
    // Los dos extremos en **un solo renglón**, no uno a cada punta de la tira: una tira de seis
    // columnas mide 13 mm y dos rótulos de 8 pt miden 24 mm, así que repartidos a los costados se
    // pisaban y salía impreso "12/202505/2026". El renglón dice lo mismo —el primer período y el
    // último, nada más (§I.5.4)— y puede ser más ancho que el dibujo sin romper nada.
    `<div class="g-ejes">${escapar(primero.etiqueta)} → ${escapar(ultimo.etiqueta)}</div>`,
    opciones.rotulo === null || ultimo.texto === null
      ? ""
      : `<div class="g-nota">${escapar(ultimo.etiqueta)}: ${escapar(ultimo.texto)}</div>`,
    notaDelMaximo(puntos),
    "</div>",
  ].join("");
}

/**
 * La nota que evita el eje truncado.
 *
 * Si un período aplasta a los demás —una derrama, un mes atípico— **el eje no se recorta**: se declara
 * cuál es el máximo, y si supera cuatro veces la mediana de la serie se dice que la escala está
 * dominada por ese período (§I.5.6 y §I.7, caso 9). Recortar el eje sería fabricar una tendencia.
 */
function notaDelMaximo(puntos: SerieHistorica["puntos"]): string {
  const conDato = puntos.filter((p): p is (typeof puntos)[number] & { texto: string } => p.texto !== null);
  if (conDato.length < 3) return "";
  const magnitudes = conDato.map((p) => {
    const m = magnitudPublicada(p.texto);
    return m < 0n ? -m : m;
  });
  const ordenadas = [...magnitudes].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  const mediana = ordenadas[Math.floor(ordenadas.length / 2)] ?? 0n;
  const maximo = magnitudes.reduce((a, m) => (m > a ? m : a), 0n);
  if (mediana === 0n || maximo <= 4n * mediana) return "";
  const pico = conDato[magnitudes.findIndex((m) => m === maximo)];
  if (!pico) return "";
  return `<div class="g-nota">Escala dominada por ${escapar(pico.etiqueta)}: ${escapar(pico.texto)}</div>`;
}

// --- El CSS -------------------------------------------------------------------------------------

/**
 * El CSS de las dos formas. **Dos tintas y ninguna nueva**: `textPrimary` para lo que significa algo
 * y `hairline` —el mismo filete de 0,4 pt del resto del documento— para la referencia.
 *
 * De ahí sale que el contraste quede verificado por construcción: todo lo que carga significado va a
 * ~18:1 sobre blanco, muy por encima del 3:1 que WCAG pide para objetos gráficos. Y **no hay paleta
 * que validar porque no hay paleta**: cero series categóricas, cero pares que separar bajo daltonismo,
 * cero decisiones de color que puedan salir mal. El modo de fallo más común de los gráficos acá no
 * existe.
 */
export function estilosGraficos(): string {
  return [
    // La pista: un rectángulo de contorno. `border-box` para que el 100 % sea el ancho declarado.
    // El aire que separa la pista del número de la izquierda va como **margen de la propia forma** y
    // no como padding de la celda: el padding de un `td` lo fija cada tabla (`.tabla td`,
    // `.detalle td`) con la misma especificidad, así que según el orden en que se concatenen las
    // hojas de estilo ganaba uno u otro — y en el informe la barra salía pegada al "%".
    `.g-pista{display:inline-block;box-sizing:border-box;width:${g.trackWidth}pt;height:${g.barHeight}pt;` +
      `margin-left:${ANCHO_AIRE_PISTA_MM}mm;border:${g.rule}pt solid ${tinta.hairline};vertical-align:middle}`,
    `.g-pista > i{display:block;height:100%;background:${tinta.textPrimary}}`,
    // Todas las pistas del cuadro arrancan en el mismo origen: sin eso, comparar dos barras exige
    // mirar antes dónde empieza cada una, y la forma deja de servir.
    ".g-celda{white-space:nowrap}",
    // La tira: caja de alto fijo, la línea de base y los rectángulos posicionados adentro.
    ".g-tira-caja{flex:0 0 auto}",
    ".g-tira{position:relative;display:block}",
    `.g-tira > b{position:absolute;left:0;right:0;height:0;border-top:${g.rule}pt solid ${tinta.hairline}}`,
    `.g-tira > i{position:absolute;display:block;width:${g.colWidth}pt;background:${tinta.textPrimary}}`,
    `.g-ejes{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.2;margin-top:.6mm;white-space:nowrap}`,
    `.g-rotulo{font-size:${fp.xs}pt;color:${tinta.textSecondary};text-transform:uppercase;letter-spacing:.04em;line-height:1.2;margin-bottom:.8mm}`,
    `.g-nota{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.2}`,
  ].join("");
}
