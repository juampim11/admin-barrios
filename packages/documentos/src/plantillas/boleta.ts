/**
 * La plantilla de la boleta: `VistaBoleta` → HTML.
 *
 * **Una sola plantilla para PDF, email HTML y vista web** (ADR-0001 §3, fundamento 1). Es el mismo
 * markup, así que los tres dicen lo mismo por construcción y no por disciplina.
 *
 * Reglas que este archivo NO puede romper:
 *
 *  - **No formatea dinero ni fechas.** Todo llega ya resuelto en la `VistaBoleta`; acá solo se
 *    imprime `.texto`. Es lo que hace imposible el bug de ICU (doc 07 §A).
 *  - **No tiene un `if` por banco.** Recorre `bloquePago.instrumentos` y pinta (ADR-0001 §4.4).
 *  - **No emite ninguna URL externa.** La red está apagada en el renderizador: una imagen por URL
 *    saldría en blanco y una hoja de estilo remota es la superficie de SSRF que el ADR §3.2 cierra.
 *  - **No estampa la marca de agua.** Eso lo hace el renderizador, no la plantilla (ADR-0001 §10).
 *  - **No inventa tamaños ni tintas.** Salen de `@admin-barrios/design-tokens` (`fontSizePrint`,
 *    `printInk`, `light`), que es donde doc 06 §g.2 manda ponerlos primero. El **acento del barrio**
 *    es la única excepción y va **inline**, nunca en el CSS: es dato, no diseño.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ IMPLEMENTA, Y POR QUÉ SE REESCRIBIÓ ENTERA
 *
 * Implementa **el mock aprobado** (`tmp/mock-boleta/mock-v2.html`, la hoja entre `.hoja` y `.notas`).
 * Durante varias vueltas se fue "acercando" la plantilla vieja zona por zona y no convergía: cada
 * iteración conservaba el esqueleto anterior —el logotipo de 45 × 20 mm, la cifra monoespaciada, las
 * guías de puntos, el cupón en grilla de tres columnas— y el resultado seguía sin parecerse. Portar
 * el mock es más barato y, sobre todo, **verificable**: hay una imagen contra la cual comparar.
 *
 * El presupuesto vertical y las zonas de doc 09 §E se conservan (son las que hacen que el troquel
 * caiga siempre en el mismo lugar y que la guarda de desbordes sepa qué cortar); lo que cambia es el
 * **lenguaje visual** de cada zona.
 *
 * Las diferencias deliberadas contra el mock están anotadas una por una donde ocurren, con la
 * palabra **DIFERENCIA** para poder encontrarlas de un grep. En resumen:
 *
 *  1. **El gráfico de barras.** El mock pone el importe arriba de cada barra; el usuario definió
 *     después otra forma —barras arriba como pura forma, y debajo tres filas: mes anterior, mes
 *     actual y la variación separada por un filete— y es la que va (`evolucion()`).
 *  2. **Los renglones que valen cero no se omiten** (doc 07 §B): el mock corta en "Total de este
 *     período"; la hoja sigue imprimiendo saldo anterior, interés y TOTAL A PAGAR aunque den cero.
 *  3. **La zona del reparto existe.** El mock es un barrio de valor fijo y no la tiene; en un barrio
 *     que prorratea se imprime, con el lenguaje visual del mock.
 *  4. **Piso tipográfico de la capa "sin zoom"** (`printMinLegibleTitular`): el primer vencimiento va
 *     en 14 pt donde el mock usa 12.
 *  5. **El cupón lleva su vencimiento y su importe.** El mock los deja sólo en el talón; un cupón que
 *     se corta y se presenta en una caja sin fecha ni importe no es un cupón.
 */

import {
  fontSizePrint as fp,
  light,
  printInk as tinta,
  printMinLegibleTitular,
} from "@admin-barrios/design-tokens";
import type { InstrumentoPago, VistaBoleta } from "@admin-barrios/shared/documentos";
// La única aritmética de la plantilla, y es de FORMA, no de dinero: el alto de cada barra. Se hace
// con `bigint` sobre centavos porque los valores son importes; el `Number` final cae sobre una
// proporción ya calculada, nunca sobre plata.
import { aCentavos } from "@admin-barrios/shared/dinero";
import { renderizarSimbolo } from "../simbolos.ts";
import { bloqueFuentes, escapar, familiaSans, PILA_MONO, type FuenteEmbebida } from "./comun.ts";
import { ANCHO_COLUMNA_BARRAS_MM, celdaBarra, estilosGraficos, llevaColumnaDeBarras } from "./graficos.ts";
import { glifoBanda, glifoTijera } from "./glifos.ts";

/** Ancho útil de la hoja A4 con los márgenes de doc 09 §E.2.2 (210 − 14 − 14). */
export const ANCHO_UTIL_MM = 182;

/**
 * Presupuesto vertical de doc 09 §E.2.2, en mm. La zona 0 es **fija**: es lo que hace que la cabecera
 * no crezca con el logo del cliente. La 3 es la única elástica y tiene tope; si no entra, el
 * renderizador **falla la emisión** en vez de recortar una línea de dinero en silencio.
 */
export const PRESUPUESTO_MM = {
  /** Franja de acento a sangre. 3 mm es la del mock; eran 4. */
  franja: 3,
  /** Cabecera. 20 mm = el sello de 16 mm del mock más su aire. */
  zona0: 18,
  /** Histórico. La zona 1 ya no reserva alto: ver el comentario de `.zona1`. */
  zona1: 52,
  /** Tope del detalle. Pasado esto, el contenido **desborda al dorso**; hoy corta la emisión. */
  zona3: 56,
  /** Ancho de la celda del importe grande. De acá sale el cuerpo del total (`cuerpoDelTotal`). */
  celdaTotal: 76,
  celdaVence: 40,
} as const;

// El escapado, la validación de fuentes embebidas y la pila tipográfica de reserva viven en
// `comun.ts`: son el sustrato de **toda** la familia de documentos (boleta, informe mensual del
// barrio y listado de saldos pendientes), y copiados en cada plantilla divergen en tres meses. Se
// re-exportan desde acá porque eran parte de la cara pública de este módulo.
export { escapar, fuenteEmbebidaSchema, PILA_MONO, PILA_SANS, type FuenteEmbebida } from "./comun.ts";

/**
 * Avance de carácter de una monoespaciada, en `em`. Liberation Mono, DejaVu Sans Mono, Courier New y
 * Geist Mono valen todas 0,6; se deja un pelo de más porque el número que sale de acá decide si el
 * importe grande se **pisa** con la fecha de vencimiento, y errar por exceso solo lo achica un punto.
 */
const AVANCE_MONO_EM = 0.62;

/**
 * Alto de la pista de la tira de evolución.
 *
 * 14 mm entran en el hueco que libera el pie cuando el medio de cobro no lleva cupón bancario, y son
 * los que hacen que la diferencia entre el mes más bajo y el más alto se vea como un escalón.
 */
/** Ancho de la tarjeta de evolución, y de la celda de vencimientos que se alinea con ella. */
export const ANCHO_TARJETA_MM = 64;

/** Alto de la pista de la tira. Barras angostas y altas se leen mejor que anchas y chatas. */
export const ALTO_TIRA_MM = 18;

/** 1 pt = 25,4/72 mm. */
const MM_POR_PT = 25.4 / 72;

/** Lo que ocupan el `$` (en `2xl`) y su separación, dentro de la celda del importe grande. */
const ANCHO_SIGNO_MM = 5.5;

/**
 * Cuerpo del importe grande, en pt, para que **entre en su celda**.
 *
 * El defecto que esto resuelve se veía en cada boleta emitida: `$ 165.297,53` en 32 pt monoespaciada
 * mide 81 mm y la celda medía 60, así que el importe se imprimía **encima de la fecha de
 * vencimiento**. Y no era un caso raro: era el caso normal.
 *
 * Se calcula, no se adivina: en una monoespaciada el ancho es exactamente `caracteres × avance ×
 * cuerpo`, así que el cuerpo que entra sale de despejar. `4xl` (32 pt) es el techo —doc 09 §E.5.3—;
 * de ahí baja **solo lo necesario**, y el piso es el de la capa sin zoom (`printMinLegibleTitular`),
 * porque por debajo de eso el total deja de leerse en un teléfono y el diseño falló (§E.5.1). Si ni
 * con el piso entra, la guarda de desbordes corta la emisión.
 *
 * ⚠ **El total ya no se imprime en monoespaciada** (el mock lo pone en la sans con `tabular-nums`),
 * y la cuenta se conserva **igual**: los dígitos de una sans miden ~0,55 em y los separadores bastante
 * menos, así que la estimación con 0,62 em queda del lado seguro. Cambiarla por el avance real de la
 * sans sería atarla a la fuente embebida del barrio, que la plantilla no conoce.
 */
export function cuerpoDelTotal(texto: string, anchoMm: number = PRESUPUESTO_MM.celdaTotal): number {
  const caracteres = Math.max(texto.length, 1);
  // El signo de peso va aparte, en un cuerpo menor, y **también ocupa la celda**: descontarlo es la
  // diferencia entre que un total de siete cifras entre o se salga por la derecha.
  const cabeEn = (anchoMm - ANCHO_SIGNO_MM) / (caracteres * AVANCE_MONO_EM * MM_POR_PT);
  return Math.max(printMinLegibleTitular, Math.min(fp["4xl"], Math.floor(cabeEn * 10) / 10));
}

/**
 * Color de cada banda de estado (doc 09 §E.4.1, "token de color"). El scheme de papel se deriva de
 * `light` (doc 09 §E.13); acá se consumen sus semánticos, nunca un hex.
 *
 * **Tres tintas por banda desde el mock**, que las dibuja como píldoras: `borde` y `fondo` son la
 * caja —no llevan texto y sólo necesitan distinguirse del papel— y `texto` es la tinta del rótulo y
 * del glifo, que sí tiene que dar **≥ 4,5:1 sobre blanco** (doc 09 §E.8.1).
 *
 * Donde §E.4.1 y §E.8.1 se contradicen manda el contraste: la banda de bonificación tiene asignado
 * `primary` (teal `#0D9488`), que da **3,1:1** y no puede llevar texto. El teal queda en el borde y
 * el rótulo va en `textPrimary`. La banda sigue distinguiéndose por glifo, palabra y cifra, que es
 * lo que doc 09 §E.8.3 exige que sobreviva a la fotocopia — **el fondo no aporta ni un dato**, y por
 * eso puede ser un tinte del 6 %: si la fotocopia lo pierde, no se pierde nada.
 */
const COLOR_BANDA: Record<string, { borde: string; texto: string; fondo: string }> = {
  al_dia: { borde: light.morosidad.alDia.fg, texto: light.morosidad.alDia.fg, fondo: light.morosidad.alDia.bg }, // 4,9:1
  saldo_anterior: {
    borde: light.morosidad.vencido.fg,
    texto: light.morosidad.vencido.fg,
    fondo: light.morosidad.vencido.bg,
  }, // 4,8:1
  bonificacion_aplicada: { borde: light.primary, texto: tinta.textPrimary, fondo: light.primarySubtle }, // teal 3,1:1: no lleva texto
  bonificacion_no_aplicada: { borde: light.info, texto: light.info, fondo: light.infoSubtle }, // 5,1:1
  interes_pendiente: { borde: light.warning, texto: light.warning, fondo: light.warningSubtle }, // 4,8:1
  vista_previa: { borde: tinta.textSecondary, texto: tinta.textSecondary, fondo: tinta.paper }, // 10,3:1
};

function cssDeBandas(): string[] {
  return Object.entries(COLOR_BANDA).flatMap(([clave, c]) => [
    `.banda--${clave}{border-color:${c.borde};background:${c.fondo}}`,
    `.banda--${clave} .t,.banda--${clave} .glifo{color:${c.texto}}`,
  ]);
}

/**
 * CSS del documento. Se emite **una sola vez por lote**: con 200 boletas en una pasada, el
 * *subsetting* de fuentes se paga una vez y no 200 (ADR-0001 §2.2).
 */
export function estilosBoleta(fuentes: readonly FuenteEmbebida[] = []): string {
  const sans = familiaSans(fuentes);
  const p = PRESUPUESTO_MM;
  return [
    bloqueFuentes(fuentes),
    // La barra de participación de la zona 3 (G-8). Es la ÚNICA forma que entra a la boleta y entra
    // en una sola zona: la 1 y la 2 no llevan nada dibujado, nunca (doc 10 §I.3.1).
    estilosGraficos(),
    // Los márgenes llegan como variables desde `cssDeMargenes(doc.margenesMm)`: la plantilla no
    // conoce el número, así la franja de acento sale "a sangre" sin duplicar la medida en dos lados.
    "*{box-sizing:border-box}",
    `html,body{margin:0;padding:0;background:${tinta.paper};color:${tinta.textPrimary};font-family:${sans};font-size:${fp.base}pt;line-height:1.35;-webkit-print-color-adjust:exact;print-color-adjust:exact}`,
    // Una boleta = una página. El salto va DESPUÉS de cada artículo menos el último.
    ".boleta{position:relative;display:flex;flex-direction:column;width:210mm;height:297mm;padding:0 var(--m-right) var(--m-bottom) var(--m-left);overflow:hidden;page-break-after:always;break-after:page}",
    ".boleta:last-of-type{page-break-after:auto;break-after:auto}",
    ".boleta > *{flex:0 0 auto}",
    /*
     * **Las cifras van en la sans con `tabular-nums`, no en monoespaciada.** Es el cambio del mock que
     * más se nota en la hoja entera: con la mono, "Mza 60 · Lote 4" y cada importe salían con aire de
     * máquina de escribir y la hoja no se parecía a la aprobada. Lo que doc 09 §E.5.3 pide de la mono
     * —que las columnas de dinero aten la vista— lo dan `tabular-nums` (todos los dígitos con el mismo
     * avance) **más** la alineación a la derecha de cada columna de importes, que es la que de verdad
     * sostiene la lectura. La mono queda donde el mock la deja y donde sí es funcional: los valores
     * del instrumento de pago (`.canal .val`) y el número legible bajo el código de barras, que
     * alguien tipea dígito a dígito.
     */
    ".cifra{font-variant-numeric:tabular-nums;white-space:nowrap}",
    // Los glifos de banda y la tijera del troquel: SVG en línea, en la tinta de quien los contiene.
    ".glifo{width:3mm;height:3mm;flex:0 0 auto;display:block}",
    ".tijera{width:3.2mm;height:3.2mm;flex:0 0 auto;display:block}",

    // --- Rótulos comunes -------------------------------------------------------------------------
    // Dos y nada más, como el mock: el rótulo chico que nombra un dato (`.rotulo`) y el título de
    // sección (`.titulo-zona`). El título va en `textPrimary` y no en gris: es lo que separa una
    // sección de una aclaración, y en la hoja vieja los dos eran grises.
    `.rotulo{font-size:${fp.xs}pt;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:${tinta.textSecondary};line-height:1.2}`,
    /*
     * ⚠ **DIFERENCIA transversal con el mock: los milímetros son más chicos que los suyos.**
     *
     * El mock respira 2 y 3,5 mm entre bloques y 1,1 mm por renglón porque su hoja tiene **cuatro**
     * conceptos, ninguna zona de reparto y un pie de tres canales. La plantilla tiene que sostener el
     * peor caso real —el barrio que prorratea: diez renglones de composición, nueve de detalle, cupón
     * con código de barras y talón—, y con los milímetros del mock esa hoja se pasa del papel por
     * 233 px. No es una opinión: es la guarda de desbordes, que **no emite** en vez de imprimir una
     * cifra encima de otra.
     *
     * Así que se conserva el **lenguaje** del mock (filete punteado por fila, aclaración pegada al
     * concepto, títulos en tinta plena, píldoras, sello) y se ajusta la **métrica**. En la hoja del
     * barrio de valor fijo, que es la del mock, sobra papel y el aire vuelve solo: lo junta todo el
     * `margin-top:auto` de la zona 4, arriba del pie.
     */
    `.titulo-zona{display:block;font-size:${fp.lg}pt;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:${tinta.textPrimary};line-height:1.2;margin-bottom:1.2mm}`,

    // --- Franja de acento: a sangre, y NADA MÁS lleva ese color en toda la hoja -------------------
    `.franja{height:${p.franja}mm;margin:0 calc(-1 * var(--m-right)) calc(var(--m-top) - ${p.franja}mm) calc(-1 * var(--m-left))}`,

    // --- Zona 0 · identidad (alto fijo: el logo NUNCA define la altura de la cabecera) ------------
    `.zona0{flex:0 0 ${p.zona0}mm;display:flex;gap:5mm;align-items:flex-start;overflow:hidden;border-bottom:.4pt solid ${tinta.hairline};padding-bottom:2mm}`,
    /*
     * **El sello de 16 mm del mock reemplaza al logotipo de 45 × 20 mm.**
     *
     * El bloque viejo pintaba el nombre entero del barrio en blanco sobre el acento: 9 cm² de tinta
     * plena que se comían la cabecera y, con un acento oscuro, dominaban la hoja. El sello dice lo
     * mismo —de quién es esto— en 2,5 cm², y el nombre del barrio queda donde se lee: al lado, en
     * texto real (doc 09 §E.9.2.bis).
     *
     * El **fondo y el borde salen del acento del barrio**, inline: es el `--acento-suave` del mock
     * generalizado a cualquier acento (ver `acentoTenue`).
     */
    `.sello{width:16mm;height:16mm;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border:.6pt solid;border-radius:3mm;font-size:${fp.lg}pt;font-weight:700;letter-spacing:.02em}`,
    `.logo{width:auto;max-width:45mm;height:16mm;flex:0 0 auto;display:flex;align-items:center;justify-content:flex-start;background:${tinta.paper}}`,
    ".logo img{max-width:45mm;max-height:16mm;object-fit:contain}",
    ".identidad{min-width:0;flex:1 1 auto}",
    `.barrio-nombre{font-size:${fp.xl}pt;font-weight:700;line-height:1.15}`,
    `.emisor{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.3;margin-top:.6mm}`,
    // La columna derecha: qué documento es, de qué unidad y con qué comprobante. En letra chica —lo
    // que la boleta ES ya lo dice el total— con la primera línea en la tinta plena.
    `.identidad-der{flex:0 0 auto;margin-left:auto;text-align:right;font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.5}`,
    `.identidad-der .periodo{display:block;color:${tinta.textPrimary};font-size:${fp.sm}pt;font-weight:600}`,

    // --- Zona 1 · el titular ---------------------------------------------------------------------
    /*
     * **Sin alto reservado.** Reservaba 52 mm para que el troquel cayera siempre en el mismo lugar de
     * la hoja con las bandas grandes; con las píldoras del mock ese alto sobra y deja un hueco entre
     * los vencimientos y el detalle. El anclaje del pie lo resuelve el `margin-top:auto` de `.zona4`.
     */
    ".zona1{flex:0 0 auto;padding-top:1mm}",
    `.destinatario{font-size:${fp.lg}pt;font-weight:600;line-height:1.2}`,
    `.destinatario .unidad-sub{font-weight:400;color:${tinta.textSecondary}}`,
    // Píldoras, no bandas a todo el ancho: al lado del nombre, para que no compitan con el importe.
    ".bandas{display:flex;flex-wrap:wrap;gap:1.5mm;margin:1.5mm 0 2mm}",
    `.banda{display:inline-flex;align-items:center;gap:1.2mm;border:.5pt solid ${tinta.hairline};border-radius:1mm;padding:.8mm 2mm;font-size:${fp.xs}pt;line-height:1.2}`,
    ".banda .t{font-weight:600}",
    ".banda .d{font-weight:400}",
    // El slot vacío no reserva altura: con píldoras no hace falta igualar la hoja del que debe con la
    // del que está al día, porque el troquel ya no ancla al alto de esta zona.
    ".banda.vacia{display:none}",
    ...cssDeBandas(),
    // **Dos celdas, no tres.** La tercera era "Dónde pagás" y se cayó con el mock; la tabla de
    // vencimientos ocupa lo que sobra. La guarda de desbordes lo cazó al primer intento: con la
    // grilla vieja la tabla pedía 241 px y tenía 151, y en vez de imprimir encima **no se emitió**.
    /*
     * La segunda celda mide **lo mismo que la tarjeta de evolución** y cae en la misma columna: así la
     * tabla de vencimientos y el gráfico comparten borde izquierdo, y la hoja tiene UNA columna
     * derecha en vez de dos que arrancan en lugares distintos.
     */
    `.titular{display:grid;grid-template-columns:1fr ${ANCHO_TARJETA_MM}mm;gap:0 6mm;align-items:start;margin-top:.5mm}`,
    // Cada celda es su propia caja acotada: si algo no entra, la guarda de desbordes lo ve y corta la
    // emisión. Es la red que atrapa el importe pisando la fecha antes de que lo vea un vecino.
    // El `padding-bottom` no es aire: con 32 pt e interlínea 1,1 la mancha del glifo sobresale de su
    // caja de línea, y la guarda —que compara `scrollHeight` contra `clientHeight`— lo denunciaba
    // como desborde de la celda del total. Dos milímetros de más y la cuenta cierra.
    ".titular > div{min-width:0;overflow:hidden;padding-bottom:1mm}",
    // `.importe-total` y no `.total`: `.total` colisionaba con `tr.total` de la zona 2 y le metía
    // `display:flex` a la fila del TOTAL A PAGAR, que se imprimía desalineada y sin su guía.
    ".importe-total{display:flex;align-items:baseline;gap:2mm;line-height:1.1;letter-spacing:-.01em;margin-top:.5mm}",
    `.importe-total .signo{font-size:${fp["2xl"]}pt;font-weight:700}`,
    ".importe-total .monto{font-weight:700}",
    // Las dos fechas con su importe. Encabezados en versalitas chicas y las cifras alineadas a la
    // derecha: son las dos columnas de dinero que atan la vista en la mitad superior de la hoja.
    ".vencimientos{border-collapse:collapse;margin-top:.5mm;line-height:1.2}",
    `.vencimientos th{font-size:${fp.xs}pt;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:${tinta.textSecondary};text-align:left;padding:0 8mm .8mm 0;border-bottom:.4pt solid ${tinta.hairline}}`,
    ".vencimientos th:last-child{text-align:right;padding-right:0}",
    // **DIFERENCIA con el mock (12 pt): el primer vencimiento va en el piso de la capa "sin zoom".**
    // Doc 09 §E.5.1 lo fija en `printMinLegibleTitular` porque es lo que hay que poder leer sin zoom
    // en un teléfono, y la fecha y el importe del primer vencimiento son justamente esa capa.
    `.vencimientos td{font-size:${fp.xl}pt;font-weight:600;padding:1mm 8mm 0 0;white-space:nowrap}`,
    ".vencimientos td:last-child{text-align:right;padding-right:0}",
    `.vencimientos tr.segunda td{font-size:${fp.lg}pt;font-weight:400;color:${tinta.textSecondary}}`,

    // --- Zona 2 · la composición -----------------------------------------------------------------
    // Toma el alto que necesita (los renglones varían con la cantidad de cargos) y la zona 3 absorbe
    // la diferencia. Ceros explícitos: ningún renglón desaparece por valer cero.
    // El renglón que comparten la tabla del período y la tarjeta de evolución. `wrap` para que sin
    // tarjeta la tabla recupere sola los 182 mm, y `align-items:flex-start` para que la tarjeta no se
    // estire al alto de la tabla.
    ".cuerpo-medio{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:flex-start;gap:0 5mm}",
    ".zona2{flex:1 1 100mm;min-width:0;padding-top:1.5mm}",
    /*
     * **La aclaración va pegada al concepto y las filas se separan con un filete punteado.**
     *
     * Antes cada renglón era `concepto ··············· importe` con una guía de puntos en el medio y
     * la aclaración tres centímetros más abajo, en las notas. El dato ya lo teníamos; lo imprimíamos
     * donde el ojo no estaba mirando. La guía de puntos desaparece: con el filete de fila el ojo ya
     * no salta de renglón, y dos mecanismos para lo mismo son ruido.
     */
    `.conceptos{width:100%;border-collapse:collapse;line-height:1.15}`,
    `.conceptos td{padding:.45mm 0;vertical-align:top;border-bottom:.3pt dotted ${tinta.hairline}}`,
    ".conceptos td.imp{text-align:right;white-space:nowrap;padding-left:4mm;width:42mm}",
    `.conceptos .nombre{font-size:${fp.base}pt}`,
    `.conceptos .aclara{display:block;font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.2;margin-top:.1mm}`,
    // El subtotal del período: filete de 0,8 pt arriba, que es el que sobrevive a una fotocopia.
    `.conceptos tr.subtotal td{border-bottom:none;border-top:.8pt solid ${tinta.textPrimary};padding-top:1.2mm;font-weight:700;font-size:${fp.lg}pt}`,
    // Y el renglón que **concluye**: encajonado arriba y abajo. Es el mismo patrón que el informe usa
    // para su resultado del período, así que las dos hojas del sobre dicen "esto es la conclusión"
    // con el mismo dibujo.
    `.conceptos tr.total td{border-top:.8pt solid ${tinta.textPrimary};border-bottom:.8pt solid ${tinta.textPrimary};padding:1.2mm 0 .8mm;font-weight:700;font-size:${fp.lg}pt}`,
    ".conceptos tr.total td.imp{padding-left:4mm}",

    // --- Zona 3 · el detalle: la ÚNICA zona elástica ---------------------------------------------
    // Se queda con lo que sobra y, si no alcanza, el renderizador falla la emisión en vez de recortar
    // una línea de dinero (doc 09 §E.2.2).
    `.zona3{flex:0 1 auto;min-height:0;max-height:${p.zona3}mm;padding-top:1.8mm;overflow:hidden;display:flex;flex-direction:column}`,
    // Los hijos NO se encogen. Sin esto, cuando la zona quedaba justa el navegador aplastaba el
    // encabezado ("El barrio gastó $X · tu coeficiente es Y") hasta dejarlo cortado a la mitad —
    // y encima la guarda de desbordes no se enteraba, porque el contenido "entraba" achicado.
    ".zona3 > *{flex:0 0 auto}",
    /*
     * `line-height` de 1,05 y no 1,15: la zona del detalle es la única elástica del presupuesto y la
     * que se queda sin lugar cuando el cupón lleva código de barras — medido, pedía 208 px y tenía
     * 189. Se recupera del interlineado y no del cuerpo, que tiene piso verificado en el gate.
     */
    `.detalle{width:100%;border-collapse:collapse;font-size:${fp.sm}pt;line-height:1.05}`,
    `.detalle th{font-size:${fp.xs}pt;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:${tinta.textSecondary};text-align:left;border-bottom:.4pt solid ${tinta.hairline};padding:0 0 .4mm}`,
    `.detalle td{padding:.1mm 0;border-bottom:.3pt dotted ${tinta.hairline};vertical-align:top}`,
    `.detalle .aclara{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.1}`,
    ".detalle .tipo{white-space:nowrap}",
    ".detalle .num{text-align:right;white-space:nowrap;padding-left:4mm}",
    // La línea de aclaraciones y su fila son **un solo renglón visual**: el filete va abajo de las
    // dos, no en el medio, para que no parezcan dos líneas de detalle distintas.
    ".detalle tr.con-aclara > td{border-bottom:none;padding-bottom:0}",
    ".detalle tr.aclara-fila > td{padding-top:.3mm}",
    // El encabezado de la zona: el título y, al lado, de dónde sale el número.
    ".encabezado-zona{display:flex;align-items:baseline;gap:3mm;margin-bottom:1mm;white-space:nowrap;overflow:hidden}",
    ".encabezado-zona .titulo-zona{margin-bottom:0;white-space:nowrap}",
    `.encabezado-zona .sub{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.3;min-width:0;overflow:hidden;text-overflow:ellipsis}`,
    `.notas{font-size:${fp.xs}pt;color:${tinta.textSecondary};margin-top:.8mm;line-height:1.3}`,

    // --- Cómo cambió lo que paga esta unidad -----------------------------------------------------
    //
    // ⚠ **La pista tiene alto fijo; el rótulo del mes vive AFUERA de ella.** La primera versión metía
    // el rótulo adentro de una columna con `height` fijo, así que el texto desbordaba el contenedor y
    // **se superponía con las filas de abajo** — el título del bloque salía tachado. Se vio recién al
    // mirar el PDF: la extracción de texto decía que todo "estaba", y estar no es entrar.
    /*
     * **Tarjeta angosta al costado, no una banda a lo ancho.** 58 mm es el ancho en el que cuatro
     * barras se leen como un gráfico y no como una franja; con los 182 mm de la hoja la misma tira
     * era una mancha enorme que no informaba nada.
     */
    `.evolucion .titulo-zona{font-size:${fp.base}pt;white-space:nowrap;margin-bottom:1.4mm}`,
    `.evolucion{flex:0 0 ${ANCHO_TARJETA_MM}mm;padding:2mm 2.5mm;border:.4pt solid ${tinta.hairline};border-radius:1.5mm}`,
    ".evolucion .tira{display:flex;gap:1.6mm;align-items:flex-end;margin-bottom:1mm}",
    // **Angostas, no anchas.** Una barra ancha y chata se lee como una franja; el alto es lo que
    // transmite la magnitud. `max-width` acota la columna y el resto queda de aire entre barras.
    ".evolucion .barra .pista{max-width:7mm;margin:0 auto}",
    ".evolucion .barra{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:1mm}",
    `.evolucion .pista{width:100%;height:${ALTO_TIRA_MM}mm;display:flex;align-items:flex-end}`,
    /*
     * **Las barras van RELLENAS**, no en contorno: gris de filete las pasadas y tinta plena la de
     * esta boleta. En contorno se leen como campos de formulario vacíos — el usuario lo rechazó dos
     * veces mirando la hoja impresa, y tenía razón.
     *
     * Siguen siendo **dos estados y ninguno intermedio** (doc 10 §I): `hairline` es el gris más claro
     * de la paleta de papel, así que contra la tinta plena la diferencia sobrevive la fotocopia. Lo
     * que la regla prohíbe es un gris **medio**, que se cierra y hace muaré con la trama.
     */
    `.evolucion .caja{width:100%;background:${tinta.hairline}}`,
    `.evolucion .barra.hoy .caja{background:${tinta.textPrimary}}`,
    /*
     * ⚠ **`min-height` obligatorio.** El rótulo va sólo en los extremos, así que el `div` de las
     * columnas del medio queda vacío y **colapsa a cero**. Con `align-items:flex-end` en la tira, esas
     * columnas apoyan más abajo y su barra se dibuja más corta: la primera parecía más alta que las
     * dos del medio cuando el dato decía lo contrario. Un gráfico que miente sobre la tendencia es
     * peor que no tenerlo.
     */
    `.evolucion .mes{font-size:${fp.xs}pt;color:${tinta.textSecondary};white-space:nowrap;min-height:${fp.xs}pt;line-height:1}`,
    `.evolucion .barra.hoy .mes{font-weight:700;color:${tinta.textPrimary}}`,
    // Las filas debajo de la tira, con el mismo filete punteado de la zona 2: es la misma clase de
    // renglón —etiqueta a la izquierda, cifra a la derecha— y dos dibujos para lo mismo confunden.
    ".evolucion .cuerpo{display:flex;flex-wrap:wrap;align-items:flex-start}",
    ".evolucion .filas{flex:1 1 100%;min-width:0}",
    `.evolucion .fila{display:flex;align-items:baseline;font-size:${fp.sm}pt;line-height:1.2;padding:.7mm 0;border-bottom:.3pt dotted ${tinta.hairline}}`,
    ".evolucion .fila .et{min-width:0}",
    // La guía cede antes que el importe: la cifra nunca corta ni envuelve. Sin puntos —los pone el
    // filete de la fila—, sólo empuja la cifra contra el margen derecho.
    ".evolucion .fila .guia{flex:1 1 auto;min-width:4mm}",
    ".evolucion .fila.hoy{font-weight:600}",
    // El filete que el usuario pidió: separa la variación de los dos meses que la producen.
    `.evolucion .fila.variacion{border-top:.8pt solid ${tinta.textPrimary};border-bottom:none;margin-top:.3mm;padding-top:1mm;font-size:${fp.lg}pt;font-weight:700}`,
    `.evolucion .nota{flex:1 1 100%;min-width:0;font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.25;margin-top:.8mm}`,

    // --- Zona 4 · leyendas y el aviso del adjunto ------------------------------------------------
    /*
     * `margin-top:auto` junta acá el sobrante de la hoja: el aire queda en UN lugar previsible, justo
     * arriba del pie, en vez de repartido en huecos entre bloques (doc 09 §E.10.2, paso 4). Y con eso
     * el pie —el bloque de pago y el talón— cae **siempre en el mismo lugar de la hoja**, que es lo
     * que permite cortar un lote de doscientas de una tijeretada. Es lo que hace el mock, tenga o no
     * troquel el medio de cobro.
     */
    `.zona4{flex:0 0 auto;margin-top:auto;padding-top:1.2mm;font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.3}`,
    /*
     * **Sin troquel, el pie NO se ancla al fondo.** El `margin-top:auto` existe para que la tijera
     * caiga siempre en el mismo lugar y se pueda cortar un lote de doscientas de una pasada. Con un
     * medio que no lleva cupón no hay nada que cortar, y ese anclaje sólo deja un hueco de cinco
     * centímetros en el medio de la hoja — medido en la boleta de transferencia.
     */
    ".boleta:not(.con-troquel) .zona4{margin-top:3mm}",
    // El aviso del adjunto: filete al costado **en el acento del barrio** (va inline), como en el
    // mock. Es lo único de la hoja, además de la franja, que lleva el color del barrio.
    `.adjunto{border-left:2.5pt solid;padding-left:2.5mm;margin:0 0 1.5mm;color:${tinta.textPrimary};line-height:1.35}`,
    ".leyendas div{margin-top:.4mm}",

    // --- Zona de exclusión del instrumento (doc 09 §E.6) -----------------------------------------
    // El renderizador la usa como límite de la marca de agua: nada estampado entra acá.
    `.exclusion{flex:0 0 auto;color:${tinta.instrumentoInk};background:${tinta.paper}}`,
    // Troquel: filete punteado a los costados y el rótulo EN EL MEDIO, no debajo de la línea. Antes
    // el borde superior de la caja cruzaba el texto y lo tachaba.
    `.troquel{display:flex;align-items:center;gap:2mm;height:4mm;font-size:${fp.xs}pt;color:${tinta.instrumentoInk};letter-spacing:.08em;white-space:nowrap}`,
    `.troquel .corte{flex:1 1 auto;border-top:.6pt dashed ${tinta.instrumentoInk}}`,

    // --- Zona 5 · el instrumento -----------------------------------------------------------------
    // Negro puro sobre blanco puro: `textPrimary` es azulado y una impresora lo puede resolver como
    // negro compuesto, bajando el contraste del código justo lo suficiente para que la caja no lo
    // lea (doc 09 §E.5.3, regla 2). Único lugar con hex crudo permitido, y viene del token.
    `.zona5{background:${tinta.paper};color:${tinta.instrumentoInk};border-top:.8pt solid ${tinta.instrumentoInk};padding-top:2mm}`,
    // Con troquel, **la línea de corte ES el separador**: el filete de 0,8 pt a cuatro milímetros de
    // un punteado se lee como un error de impresión, no como dos cosas distintas.
    ".boleta.con-troquel .zona5{border-top:none;padding-top:1mm}",
    // Una o dos frases arriba de los datos del cupón. Con un medio sin caja son lo que convierte un
    // pie sin código de barras en una sección terminada en vez de una que parece incompleta.
    `.instrucciones{font-size:${fp.sm}pt;line-height:1.25;margin-bottom:.8mm}`,
    /*
     * **El QR va al costado de TODO el bloque de datos, no al costado de los canales solos.**
     *
     * Es una medida, no una preferencia: el símbolo mide 34 mm con su zona muda —que es del
     * renderizador y no se toca, porque de ella depende que un lector lo lea— y los tres canales de un
     * medio típico miden 16. Con el QR enfrentado sólo a los canales, esos 18 mm de diferencia quedan
     * en blanco **y la fila entera mide lo que el más alto**: el pie se llevaba 24 mm de más, que son
     * los que la zona del reparto necesita para existir. Enfrentándolo al título, las instrucciones,
     * las cifras y los canales, las dos columnas terminan casi a la par.
     */
    ".pago-cuerpo{display:flex;gap:6mm;align-items:flex-start}",
    ".pago-cuerpo .datos{flex:1 1 auto;min-width:0}",
    ".canales{min-width:0;display:flex;flex-direction:column;gap:1.6mm}",
    /*
     * **Las cifras del cupón van en UN renglón, no una debajo de la otra.** El vencimiento, el
     * importe y la segunda fecha son tres datos cortos; apilados en la columna del mock costaban
     * 24 mm y el pie se comía la zona del reparto.
     */
    ".canal{display:flex;gap:3mm;align-items:baseline;min-width:0;line-height:1.25}",
    // 27 mm y no 24: "Pago electrónico" —el rótulo del instrumento de una red real— envolvía a dos
    // renglones y dejaba su valor flotando contra la primera línea del par.
    `.canal .et{flex:0 0 auto;width:27mm;font-size:${fp.xs}pt;color:${tinta.textSecondary};text-transform:uppercase;letter-spacing:.04em}`,
    // La mono acá sí: un CBU de 22 dígitos o un código de pago se tipean carácter por carácter, y la
    // monoespaciada es la que evita confundir un 1 con una l. `anywhere` para que un alias largo
    // corte dentro de su celda en vez de empujar el QR fuera de la hoja.
    `.canal .val{min-width:0;font-family:${PILA_MONO};font-size:${fp.lg}pt;font-weight:600;letter-spacing:.02em;overflow-wrap:anywhere}`,
    ".canal .val-col{min-width:0;display:flex;flex-direction:column;gap:.4mm}",
    // La cajita de la nota: filete de acento a la izquierda, como en el mock. Ata la aclaración al
    // dato que explica sin agregarle peso — es texto de 8 pt en una caja de contorno fino.
        /*
     * **La aclaración del canal es texto, no una ficha.** Estuvo un rato dentro de un recuadro con
     * filete y borde izquierdo grueso: ese recuadro es el de las **fichas explicativas del mock**
     * (las que comentan la hoja, y que no se imprimen), no el de un renglón de la hoja. Metido acá
     * mezclaba dos lenguajes en el mismo bloque y comía ~12 mm que el detalle necesita.
     */
    `.canal .nota-canal{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.25;font-weight:400;letter-spacing:0;max-width:96mm}`,
    // El importe del cupón es la cifra que alguien paga: el cuerpo que el token le reserva.
    /*
     * **DIFERENCIA con el mock: las aclaraciones de los canales van juntas en un renglón al pie del
     * bloque, no debajo de cada valor.**
     *
     * El mock las pone debajo de su valor y se lee mejor así — pero su bloque tiene tres canales y la
     * hoja entera cuatro conceptos. Medido en el peor caso real: debajo de cada valor el cuerpo del
     * cupón mide 63 mm y en un renglón 29 mm, y esos 34 mm son la zona del reparto entera. Con el QR
     * al costado quedan ~110 mm de ancho, así que además cada nota envolvía a dos renglones.
     */
    `.aclaraciones-pago{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.25;margin-top:.8mm}`,
    // **Sin pie bajo el QR.** El mock le pone "Escaneá desde tu billetera virtual"; acá esa frase no
    // es de la plantilla sino del medio de cobro (`presentacion.instrucciones`), que ya la imprime
    // arriba. Escrita en el CSS sería un literal que un medio de débito automático haría falso.
    ".qr{flex:0 0 auto;text-align:center}",
    // Los símbolos lineales ocupan un RENGLÓN PROPIO, a lo ancho de la hoja. No es estética: el
    // código de barras mide los 182 mm útiles enteros, así que compartir fila con el QR hacía que
    // el QR —posterior en el DOM— se imprimiera **encima del último 24 % del símbolo**, zona muda
    // incluida, y un lector no leía nada. La regla de doc 09 §E.6 ("nada se pone al costado del
    // código") la tiene que hacer cumplir el CSS, no un comentario.
    ".simbolos{min-width:0;margin-top:1mm}",
    ".simbolo{margin:.2mm 0}",
    `.simbolo .et{font-size:${fp.xs}pt;color:${tinta.textSecondary};text-transform:uppercase;letter-spacing:.04em}`,
    `.simbolo .leible{font-family:${PILA_MONO};font-size:${fp.sm}pt;letter-spacing:.03em;line-height:1.2}`,
    `.zona5 .logos{margin-top:1.2mm}`,
    ".zona5 .logos img{margin-right:3mm;vertical-align:middle}",
    `.zona5 .leyendas{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.25;margin-top:1.2mm}`,

    // --- Zona 6 · talón --------------------------------------------------------------------------
    // Tres columnas: qué es, cuándo vence y cuánto. Es lo que se lee de un vistazo cuando el papel ya
    // está cortado y separado de la hoja.
    `.talon{margin-top:2.5mm;border-top:.4pt dashed ${tinta.hairline};padding-top:2.5mm;display:flex;flex-wrap:wrap;gap:1.5mm 6mm;font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.25}`,
    ".talon .col{display:flex;flex-direction:column;gap:.6mm;min-width:0}",
    `.talon b{color:${tinta.textPrimary};font-weight:600}`,
  ].join("");
}

// --- El cuerpo ----------------------------------------------------------------------------------

const ETIQUETA_2048: Record<string, string> = {
  ordinaria: "Ordinaria",
  extraordinaria: "Extraordinaria",
  fondo_reserva: "Fondo de reserva",
  no_corresponde: "Cargo / descuento",
};

/** `"expensa"` → `"Expensa"`. La denominación llega en minúscula: es un sustantivo, no un título. */
const conMayuscula = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

/**
 * El acento del barrio al 10 %: el `--acento-suave` del mock, generalizado.
 *
 * El mock trae un teal claro escrito a mano (`#ECFDF9`) porque su barrio es teal. Acá el acento es
 * **dato del barrio** y puede ser cualquiera, así que el tinte se deriva de él con la componente alfa
 * del propio color — sin `color-mix` (que ataría la hoja a una versión de motor) y sin aritmética de
 * color en la plantilla. Si el motor no soportara el hex de ocho dígitos, el fondo queda transparente
 * y el sello sigue siendo legible: es su borde y su tinta las que lo dibujan.
 */
const acentoTenue = (acentoHex: string) => `${acentoHex}1a`;

/**
 * Las iniciales del barrio para el sello, cuando no hay logo cargado.
 *
 * **Es la única cosa que la plantilla deriva de un dato en vez de imprimirlo**, y por eso la regla es
 * chica y explícita: se descartan las palabras que **no distinguen a un barrio de otro** —el
 * sustantivo genérico con el que empiezan casi todos y los artículos y preposiciones— y se toman las
 * iniciales de las dos últimas que quedan, que es donde vive el nombre propio ("Barrio Los Talas" →
 * "T"; "Barrio Demo Los Aromos" → "DA").
 *
 * No es un dato del modelo y no pretende serlo: si el barrio quiere una marca, carga su logo y el
 * sello no se dibuja.
 */
const PALABRAS_SIN_MARCA = new Set([
  "barrio", "consorcio", "country", "club", "complejo", "conjunto", "edificio", "condominio",
  "residencial", "urbanizacion", "urbanización", "el", "la", "los", "las", "de", "del", "y",
]);

export function inicialesDelBarrio(nombre: string): string {
  const palabras = nombre
    .split(/[\s.,·—–-]+/)
    .filter((w) => w.length > 1 && !PALABRAS_SIN_MARCA.has(w.toLowerCase()));
  const elegidas = (palabras.length > 0 ? palabras : nombre.split(/\s+/)).slice(-2);
  return elegidas
    .map((w) => w.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
}

function cabecera(v: VistaBoleta): string {
  const { barrio, emisor } = v.marca;
  const marcaBarrio =
    barrio.logo === null
      ? `<div class="sello" style="color:${barrio.acentoHex};border-color:${barrio.acentoHex};background:${acentoTenue(barrio.acentoHex)}">` +
        `${escapar(inicialesDelBarrio(barrio.nombre))}</div>`
      : `<div class="logo"><img src="${barrio.logo.dataUri}" alt="${escapar(barrio.nombre)}" style="max-width:${barrio.logo.anchoMaxMm}mm;max-height:${barrio.logo.altoMaxMm}mm"></div>`;

  // El emisor es el **dato legal**, no un elemento de marca: letra chica bajo el nombre del barrio
  // (doc 09 §E.9.0). Arriba y grande va el barrio, que es a quien el vecino le paga.
  const datosEmisor = [
    `Administra: ${escapar(emisor.razonSocial)}`,
    emisor.cuit ? `CUIT ${escapar(emisor.cuit)}` : null,
    emisor.domicilio ? escapar(emisor.domicilio) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");

  return [
    `<div class="franja" style="background:${v.marca.barrio.acentoHex}"></div>`,
    '<header class="zona0" data-desborde="identidad">',
    marcaBarrio,
    '<div class="identidad">',
    `<div class="barrio-nombre">${escapar(barrio.nombre)}</div>`,
    `<div class="emisor">${datosEmisor}</div>`,
    // **La unidad no se repite acá.** La imprimía en 14 pt monoespaciada al lado del nombre del
    // barrio, y salía tres veces en la misma hoja: en la cabecera, en la columna derecha y en el
    // destinatario de la zona 1. El mock la deja en dos lugares, que son los dos que contestan
    // preguntas distintas ("¿de qué unidad es este documento?" y "¿a quién se le emite?").
    "</div>",
    /*
     * A la derecha, **lo que la boleta ES**: la denominación del barrio y su mes. Decía
     * `PERÍODO 07/2026` en versalitas grandes, que nombra el campo del sistema y no el documento —
     * el vecino recibe "su expensa de julio", no "un período".
     */
    '<div class="identidad-der">',
    `<span class="periodo">${escapar(conMayuscula(v.periodo.denominacionConcepto))} <span class="cifra">${escapar(v.periodo.etiqueta)}</span></span>`,
    `<span class="cifra">${escapar(v.unidad.etiqueta)}</span><br>`,
    v.emision.comprobante
      ? `Comprobante <span class="cifra">${escapar(v.emision.comprobante)}</span>`
      : "Comprobante: pendiente de numeración",
    // Mismas palabras que usan el informe y el listado para el mismo estado: la familia no puede
    // tener dos formas de decir que un documento todavía no se emitió.
    v.emision.fecha === null ? "<br>Documento sin emitir" : "",
    "</div>",
    "</header>",
  ].join("");
}

function titular(v: VistaBoleta): string {
  /*
   * Tres slots de banda: los que **existen** se dibujan como píldoras al lado del nombre y el vacío
   * no ocupa nada (`.banda.vacia{display:none}`). El slot sigue emitiéndose porque es lo que hace
   * verificable que el orden de doc 09 §E.4.1 no se toque, y va **primero** por la misma razón de
   * siempre: el orden de las bandas que existen es fijo, el del hueco no lo fija nadie.
   */
  const vacias = Math.max(0, 3 - v.bandas.length);
  const bandas = [
    ...Array.from({ length: vacias }, () => '<div class="banda vacia"></div>'),
    // Marca **no cromática** + palabra + cifra: la hoja en escala de grises dice lo mismo
    // (doc 09 §E.8.3). El dibujo sale de un SVG en línea, no de un glifo de fuente ni de un emoji.
    ...v.bandas.map(
      (b) =>
        `<div class="banda banda--${b.clave}" data-desborde="banda">` +
        glifoBanda(b.marca) +
        `<span class="frase"><span class="t">${escapar(b.titulo)}</span> ` +
        `<span class="d">${escapar(b.texto)}</span></span>` +
        "</div>",
    ),
  ].join("");

  // El cuerpo del importe se calcula para que ENTRE en su celda: es lo que evita que se imprima
  // encima de la fecha de vencimiento (ver `cuerpoDelTotal`).
  const total = v.totales.aPagar.texto;

  const destinatario = v.unidad.rolDestinatario
    ? `${escapar(v.unidad.destinatario)} — ${escapar(v.unidad.rolDestinatario)}`
    : escapar(v.unidad.destinatario);

  return [
    '<section class="zona1">',
    `<div class="destinatario">${destinatario} <span class="unidad-sub">· ${escapar(v.unidad.etiqueta)}</span></div>`,
    `<div class="bandas">${bandas}</div>`,
    '<div class="titular">',
    // `data-sin-marca`: los rótulos que la marca de agua no puede cruzar. La plantilla **declara**
    // cuáles son; dónde y de qué tamaño se estampa lo decide el renderizador (ADR-0001 §10).
    '<div data-desborde="titular-total">',
    '<div class="rotulo" data-sin-marca>Total a pagar</div>',
    '<div class="importe-total cifra">' +
      '<span class="signo">$</span>' +
      `<span class="monto" style="font-size:${cuerpoDelTotal(total)}pt">${escapar(total)}</span>` +
      "</div>",
    "</div>",
    /*
     * **Las dos fechas con su importe, en una tabla con encabezados.** Es el mock aprobado.
     *
     * Antes era `Vence el` + una fecha grande + la segunda como subrenglón sin importe, y al lado una
     * tercera columna `Dónde pagás`. Con dos vencimientos que pueden llevar importes distintos, esa
     * forma no alcanza: la pregunta es "cuánto pago **si pago cada día**", y eso es una tabla.
     *
     * Dónde se paga bajó al pie, que ahora es una sección titulada con los datos completos: repetirlo
     * arriba en dos palabras obligaba a resumir un canal en una etiqueta y no aportaba nada que el
     * pie no dijera mejor.
     */
    '<div data-desborde="titular-vence">',
    '<table class="vencimientos">',
    '<tr><th data-sin-marca>Vencimiento</th><th data-sin-marca>Importe</th></tr>',
    `<tr><td class="cifra">${escapar(v.bloquePago.fechas.vencimiento.texto)}</td>` +
      `<td class="cifra">$ ${escapar(v.bloquePago.importes.alVencimiento.texto)}</td></tr>`,
    v.bloquePago.fechas.tope && v.bloquePago.importes.alTope
      ? `<tr class="segunda"><td class="cifra">${escapar(v.bloquePago.fechas.tope.texto)}</td>` +
        `<td class="cifra">$ ${escapar(v.bloquePago.importes.alTope.texto)}</td></tr>`
      : "",
    "</table>",
    "</div>",
    "</div>",
    "</section>",
  ].join("");
}

function composicion(v: VistaBoleta): string {
  /*
   * **Sin `$` en la columna de importes**, que es lo que hace el mock: la unidad se declara una vez
   * —el total de la zona 1 la lleva, y las leyendas del pie hablan de pesos— y repetirla en cada
   * renglón agrega catorce signos que el ojo tiene que saltear antes de llegar al número. El `$` se
   * conserva donde la cifra viaja **sola**, fuera de una columna: el titular, los vencimientos, el
   * cupón y el talón.
   */
  const renglon = (etiqueta: string, texto: string, clase: string, aclaracion: string | null, marcador: number | null) =>
    `<tr${clase ? ` class="${clase}"` : ""}><td><span class="nombre">${escapar(etiqueta)}${marcador === null ? "" : ` (${marcador})`}</span>` +
    (aclaracion ? `<span class="aclara">${escapar(aclaracion)}</span>` : "") +
    `</td><td class="imp cifra">${escapar(texto)}</td></tr>`;

  const variables = v.composicion
    .map((r) => renglon(r.etiqueta, r.importe.texto, r.informativo ? "informativo" : "", r.aclaracion, r.marcadorNota))
    .join("");

  // Nunca se omite, aunque valga cero (doc 07 §B): un renglón ausente se lee como dato escondido.
  // Y el importe **nunca** se arma post-procesando el HTML con una expresión regular: un cambio de
  // clases dejaría la hoja imprimiendo `$ 0.00` sin formatear y afirmando que no hay interés.
  const renglonPendiente = (etiqueta: string, aclaracion: string | null) =>
    `<tr><td><span class="nombre">${escapar(etiqueta)}</span>` +
    (aclaracion ? `<span class="aclara">${escapar(aclaracion)}</span>` : "") +
    '</td><td class="imp">pendiente</td></tr>';

  const interes =
    v.totales.interes === null || v.interes === null
      ? renglonPendiente("Interés: pendiente de definición", "El barrio no tiene tasa cargada a la fecha de emisión")
      : renglon(
          "Interés",
          v.totales.interes.texto,
          "",
          // Cada parte se imprime solo si el sistema la tiene. Con interés en cero es normal que no
          // haya días ni fecha de corte, y la hoja lo dice en vez de inventarlos.
          [
            `Base $ ${v.interes.base.texto}`,
            v.interes.tasaMensualTexto === null ? null : `${v.interes.tasaMensualTexto} % mensual`,
            v.interes.dias === null ? null : `${v.interes.dias} días`,
            v.interes.computadoHasta === null ? null : `al ${v.interes.computadoHasta.texto}`,
          ]
            .filter((x): x is string => x !== null)
            .join(" · "),
          null,
        );

  return [
    '<section class="zona2">',
    '<span class="titulo-zona" data-sin-marca>Detalle del período</span>',
    '<table class="conceptos">',
    variables,
    renglon(`Total del período ${v.periodo.etiqueta}`, v.totales.delPeriodo.texto, "subtotal", null, null),
    /*
     * Estos tres **no se omiten aunque valgan cero** (doc 07 §B), y se intentó omitirlos: con un
     * vecino al día los tres dicen `0,00` y el total repetido, y la hoja se ve más limpia sin ellos.
     * Se revirtió porque la regla no es de estética — un renglón de dinero ausente se lee como dato
     * escondido, y "saldo anterior: no figura" es justo lo que hace desconfiar de una liquidación.
     * Hay tres tests que lo fijan. **Y es la DIFERENCIA 2 con el mock**, que corta en el subtotal.
     */
    renglon("Saldo de períodos anteriores", v.totales.saldoAnterior.texto, "", null, null),
    interes,
    renglon("TOTAL A PAGAR", v.totales.aPagar.texto, "total", null, null),
    "</table>",
    "</section>",
  ].join("");
}

function detalle(v: VistaBoleta): string {
  // Zona 3 muestra el ORIGEN: las líneas que salen de un reparto o de la cuota fija. Los cargos y
  // los descuentos ya están, uno por uno, en la zona 2 (doc 09 §E.3, niveles 1 y 2).
  const lineas = v.detalle.lineas.filter((l) => l.clase === "prorrateo" || l.clase === "cuota_fija");

  /*
   * **Si no hubo reparto, la zona no se imprime.** Esta zona cruza el gasto del período con el
   * coeficiente de la unidad; en un barrio de valor fijo esas dos columnas no existen y la hoja salía
   * con un guión en cada celda, ocupando 56 mm para no decir nada. La condición se deriva del dato,
   * no del modelo: la plantilla sigue sin un `if` por caso. (Es la DIFERENCIA 3 con el mock, que es
   * justamente un barrio de valor fijo y por eso no tiene esta zona.)
   */
  if (!lineas.some((l) => l.gastoDelPeriodo !== null || l.coeficiente !== null)) return "";

  /**
   * **G-8** — *"¿qué parte de lo que pago es seguridad?"*. Reemplaza una división por línea, que es la
   * cuenta que nadie hace y por eso nadie sabe la respuesta.
   *
   * Sólo dibujan las líneas **ordinarias**: son las únicas que son partes del total de la cuota
   * ordinaria. Un concepto extraordinario o el fondo de reserva no pertenecen a ese todo, así que su
   * celda queda **vacía, sin pista** — una pista vacía ya significa "cero" (doc 10 §I.7, caso 2) y un
   * mismo dibujo no puede decir dos cosas. La nota al pie dice cuál es el todo y quién queda afuera.
   *
   * **Es el único elemento del rediseño de la boleta declarado sacrificable** (§I.6.1): si un barrio
   * tiene nombres de concepto largos, se cae la columna de participación, nunca el nombre.
   */
  const totalOrdinarias = v.detalle.totalOrdinarias;
  const barras =
    totalOrdinarias !== null &&
    llevaColumnaDeBarras(lineas.filter((l) => l.clasificacion2048 === "ordinaria").map((l) => l.importe.texto));

  const columnas = barras ? 6 : 5;
  const filas = lineas
    .map((l) => {
      // Las aclaraciones de la línea (el hecho que la originó, el acta que la respalda) van en un
      // renglón propio a lo ancho de la tabla, **no dentro de la celda del concepto**. Ocupan el
      // mismo renglón que ocupaban —el alto no cambia— y dejan de depender del ancho de esa columna:
      // metidas adentro, "Respaldo: Acta de Asamblea N.º 47 del 12/05/2026" mide 66 mm y con la
      // columna de participación puesta la celda queda en 53, así que la línea envolvía y la zona 3
      // se pasaba de su tope por 0,8 mm. Es el mecanismo que hace que G-8 cueste **cero milímetros**
      // y no "casi cero" (doc 10 §I.6).
      const aclaraciones = [
        l.detalleHecho ? escapar(l.detalleHecho) : null,
        l.respaldo ? `Respaldo: ${escapar(l.respaldo)}` : null,
      ].filter((x): x is string => x !== null);

      return [
        `<tr${aclaraciones.length > 0 ? ' class="con-aclara"' : ""}>`,
        `<td>${escapar(l.concepto)}${l.marcadorNota === null ? "" : ` (${l.marcadorNota})`}</td>`,
        `<td class="tipo">${ETIQUETA_2048[l.clasificacion2048] ?? ""}</td>`,
        `<td class="num cifra">${l.gastoDelPeriodo ? escapar(l.gastoDelPeriodo.texto) : "—"}</td>`,
        `<td class="num cifra">${l.coeficiente ? `${escapar(l.coeficiente.participacionTexto)} %` : "—"}</td>`,
        barras && totalOrdinarias !== null
          ? `<td class="g-celda">${celdaBarra(l.clasificacion2048 === "ordinaria" ? l.importe.texto : null, totalOrdinarias.texto)}</td>`
          : "",
        `<td class="num cifra">${escapar(l.importe.texto)}</td>`,
        "</tr>",
        aclaraciones.length === 0
          ? ""
          : `<tr class="aclara-fila"><td class="aclara" colspan="${columnas}">${aclaraciones.join(" · ")}</td></tr>`,
      ].join("");
    })
    .join("");

  const notas = v.notas.map((n) => `<div>(${n.marcador}) ${escapar(n.texto)}</div>`).join("");
  /**
   * **G-8 va sin nota al pie, y no por olvido.**
   *
   * La nota que explicaría la pista —*"parte de la expensa ordinaria del período ($ X)"*— es **una**
   * línea de 8 pt, o sea 13 px, y a la zona 3 le quedan 10 px de aire con esta boleta. La tercera
   * pregunta del test de admisión no admite matices: si hay que correr una zona, no va (doc 10 §I.1).
   *
   * Y se puede prescindir de ella porque las dos cosas que diría ya están impresas: el 100 % de la
   * pista es el renglón **"…ordinaria {período}"** de la zona 2, tres centímetros más arriba, y de las
   * filas que no llevan barra lo dice la columna **Tipo**, en la misma fila ("Extraordinaria", "Fondo
   * de reserva"). La barra no es la única vía a ningún dato, que es la regla maestra (§I.5.4).
   */
  const notaBarras = "";

  return [
    // `data-desborde` es el ancla de la guarda del renderizador: si el contenido de esta zona no
    // entra, la emisión falla con el nombre de la zona en vez de recortar una línea en silencio.
    '<section class="zona3" data-desborde="detalle">',
    '<div class="encabezado-zona">',
    '<span class="titulo-zona" data-sin-marca>Composición del gasto</span>',
    `<span class="sub">El barrio gastó $ <span class="cifra">${escapar(v.detalle.gastoDelBarrio.texto)}</span> en ${escapar(v.periodo.etiqueta)} · tu coeficiente es <span class="cifra">${escapar(v.detalle.coeficiente.participacionTexto)} %</span></span>`,
    "</div>",
    '<table class="detalle">',
    // Los 18 mm de la columna de participación salen de "Concepto" (74 → 56 mm) y de ningún lado más:
    // el presupuesto vertical de la zona 3 queda **idéntico** (doc 10 §I.6.1).
    "<colgroup><col><col style=\"width:26mm\"><col style=\"width:30mm\"><col style=\"width:22mm\">" +
      (barras ? `<col style="width:${ANCHO_COLUMNA_BARRAS_MM}mm">` : "") +
      "<col style=\"width:30mm\"></colgroup>",
    '<thead><tr><th>Concepto</th><th>Tipo</th><th class="num">Gasto del período</th><th class="num">Coef.</th>' +
      (barras ? "<th></th>" : "") +
      '<th class="num">Importe</th></tr></thead>',
    `<tbody>${filas}</tbody>`,
    "</table>",
    `<div class="notas">${notas}${notaBarras}${v.detalle.continuaAlDorso ? "<div>El detalle sigue al dorso.</div>" : ""}</div>`,
    "</section>",
  ].join("");
}

/*
 * Cada dato de pago con **su nota en una cajita debajo**, no todas concatenadas al pie del bloque.
 *
 * Concatenadas se leían como una línea corrida —"CBU: Cuenta de demostración · Referencia: Ponela en
 * el concepto…"— donde había que volver a buscar a qué dato pertenecía cada aclaración. Es el mock: la
 * nota vive pegada al valor que explica, y el filete de acento a la izquierda la ata visualmente.
 */
function instrumentoTexto(inst: Extract<InstrumentoPago, { tipo: "texto" }>): string {
  const nota = inst.nota === null ? "" : `<div class="nota-canal">${escapar(inst.nota)}</div>`;
  return (
    '<div class="canal">' +
    `<span class="et">${escapar(inst.etiqueta)}</span>` +
    `<span class="val-col"><span class="val">${escapar(inst.valor)}</span>${nota}</span>` +
    "</div>"
  );
}

/** Las aclaraciones de los instrumentos de texto, en un solo renglón al pie del bloque. */
function aclaracionesDePago(textos: readonly Extract<InstrumentoPago, { tipo: "texto" }>[]): string {
  const partes = textos
    .filter((i) => i.nota !== null)
    .map((i) => `${escapar(i.etiqueta)}: ${escapar(i.nota ?? "")}`);
  return partes.length === 0 ? "" : `<div class="aclaraciones-pago">${partes.join(" · ")}</div>`;
}

function instrumentoSimbolo(inst: Extract<InstrumentoPago, { tipo: "simbolo" }>): string {
  const simbolo = renderizarSimbolo(inst, { anchoUtilMm: ANCHO_UTIL_MM });
  return (
    // `data-simbologia` es el ancla del canario que decodifica el símbolo **desde la hoja impresa**
    // (`test/canario-cupon.test.ts`): sin él, el test tendría que adivinar cuál es cuál por posición.
    `<div class="simbolo" data-simbologia="${escapar(inst.simbologia)}">` +
    `<div class="et">${escapar(inst.etiqueta)}</div>` +
    simbolo.svg +
    (inst.leible === null ? "" : `<div class="leible">${escapar(inst.leible)}</div>`) +
    "</div>"
  );
}

function bloqueDePago(v: VistaBoleta): string {
  const b = v.bloquePago;
  // El QR se ubica al costado del bloque de datos; los símbolos lineales van debajo, a lo ancho.
  // **Nada se pone al costado del código de barras**: su zona muda es parte de su propio SVG.
  const lineales = b.instrumentos.filter(
    (i): i is Extract<InstrumentoPago, { tipo: "simbolo" }> => i.tipo === "simbolo" && i.simbologia !== "qrcode",
  );
  const qr = b.instrumentos.filter(
    (i): i is Extract<InstrumentoPago, { tipo: "simbolo" }> => i.tipo === "simbolo" && i.simbologia === "qrcode",
  );
  const textos = b.instrumentos.filter((i): i is Extract<InstrumentoPago, { tipo: "texto" }> => i.tipo === "texto");

  return [
    // La zona de exclusión completa (doc 09 §E.6). El renderizador la lee para no estampar nada
    // encima: una marca de agua sobre el código de barras es un vecino que no puede pagar.
    '<div class="exclusion" data-exclusion>',
    // Troquel: el rótulo va EN LA LÍNEA, entre dos tramos punteados, con la tijera de cada lado.
    // Son los dos únicos agregados permitidos alrededor del instrumento (doc 09 §E.6).
    /*
     * **El troquel lo decide el medio de cobro.** Estaba escrito acá, a mano: con un barrio que cobra
     * por transferencia, "PRESENTÁ ESTA PARTE EN LA CAJA" es falso y la tijera promete un trámite que
     * no existe. Lo declara el adapter, igual que ya declaraba los canales de pago.
     */
    b.presentacion.troquel === null
      ? ""
      : [
          '<div class="troquel">',
          '<span class="corte"></span>',
          glifoTijera(),
          `<span>${escapar(b.presentacion.troquel)}</span>`,
          glifoTijera(),
          '<span class="corte"></span>',
          "</div>",
        ].join(""),
    '<section class="zona5" data-desborde="cupon">',
    '<div class="pago-cuerpo">',
    '<div class="datos">',
    // El pie deja de ser un cupón suelto y pasa a ser una sección con título — es el mock aprobado.
    // Un cupón sin código de barras se lee como incompleto; una sección titulada, como terminada.
    '<span class="titulo-zona" data-sin-marca>Cómo pagar esta boleta</span>',
    b.presentacion.instrucciones.length === 0
      ? ""
      : `<div class="instrucciones">${b.presentacion.instrucciones.map((i) => `<div>${escapar(i)}</div>`).join("")}</div>`,
    /*
     * **El vencimiento y el importe NO se repiten acá. Es el bloque del mock, tal cual.**
     *
     * Estuvieron un rato, con este argumento: la parte de abajo se corta y se presenta en una caja,
     * y un cupón sin fecha ni importe no es un cupón porque el cajero cobra lo que el papel dice.
     * El argumento es correcto y el lugar estaba mal: **el talón también está adentro del recorte**
     * (entra en el mismo `.exclusion`, debajo de la línea de corte) y ya imprime «Vencimientos» e
     * «Importe» en las columnas del mock. Con las filas acá arriba, la misma cifra salía dos veces en
     * el mismo pedazo de papel, en dos formatos distintos —el de fecha/importe de la plantilla vieja
     * y el de dato/aclaración del mock— y esa mezcla es lo que se veía descuadrado. Se cortan las
     * filas, no el dato: el cajero lo sigue leyendo en el talón.
     */
    '<div class="canales">',
    // Los instrumentos de texto del medio: CBU, alias, referencia, código de pago. Sin un `if` por
    // banco — se recorren y se pintan (ADR-0001 §4.4).
    textos.map(instrumentoTexto).join(""),
    "</div>",
    "</div>",
    qr.length === 0 ? "" : `<div class="qr">${qr.map(instrumentoSimbolo).join("")}</div>`,
    "</div>",
    // Las aclaraciones ya no van acá: desde el port del mock cada una vive en su cajita, pegada al
    // dato que explica (ver `instrumentoTexto`). Concatenadas obligaban a volver a buscar de cuál era.

    // `data-desborde` va en el contenedor de los símbolos y no solo en la zona: el desborde de
    // ancho ocurre acá adentro, y medirlo un nivel más arriba no lo ve.
    lineales.length === 0
      ? ""
      : `<div class="simbolos" data-desborde="simbolos">${lineales.map(instrumentoSimbolo).join("")}</div>`,
    b.logos.length === 0
      ? ""
      : `<div class="logos">${b.logos
          .map((l) => `<img src="${l.dataUri}" alt="" style="max-height:${l.altoMaxMm}mm;max-width:${l.anchoMaxMm}mm">`)
          .join("")}</div>`,
    b.leyendas.length === 0
      ? ""
      : `<div class="leyendas">${b.leyendas.map((l) => `<div>${escapar(l)}</div>`).join("")}</div>`,
    "</section>",
    talon(v),
    "</div>",
  ].join("");
}

/**
 * El talón, en las columnas del mock: **qué es, con qué comprobante, cuándo vence y cuánto**.
 *
 * Es lo que queda en la mano cuando el papel ya se cortó, así que repite —a propósito— lo que la
 * hoja dice arriba. `presentacion.talon` es el rótulo y lo pone el medio de cobro: puede ser el
 * comprobante de quien paga o el que se queda la administración, y la plantilla no elige cuál.
 *
 * **Dos renglones por columna y ninguno más**, que es la forma del mock. La versión anterior metía un
 * tercero con el nombre del obligado y la razón social del emisor, y se cayó por dos motivos que
 * apuntan al mismo lado: costaba 3,5 mm de una hoja que no los tiene, y ponía el **nombre de una
 * persona** en el pedazo de papel que se corta y viaja suelto — el talón se imputa por unidad y
 * comprobante, que es lo que la administración busca cuando concilia, y el emisor ya está impreso en
 * la cabecera de la misma hoja.
 */
function talon(v: VistaBoleta): string {
  const b = v.bloquePago;
  if (b.presentacion.talon === null) return "";
  const columna = (rotulo: string, valor: string) => `<div class="col"><span>${rotulo}</span>${valor}</div>`;
  return [
    '<section class="talon">',
    columna(
      escapar(b.presentacion.talon),
      `<b>${escapar(conMayuscula(v.periodo.denominacionConcepto))} ${escapar(v.periodo.etiqueta)} · ${escapar(v.unidad.etiqueta)}</b>`,
    ),
    v.emision.comprobante === null
      ? ""
      : columna("Comprobante", `<b class="cifra">${escapar(v.emision.comprobante)}</b>`),
    columna(
      b.fechas.tope === null ? "Vencimiento" : "Vencimientos",
      b.fechas.tope === null
        ? `<b class="cifra">${escapar(b.fechas.vencimiento.texto)}</b>`
        : `<b class="cifra">${escapar(b.fechas.vencimiento.texto)} y ${escapar(b.fechas.tope.texto)}</b>`,
    ),
    columna("Importe", `<b class="cifra">$ ${escapar(b.importes.alVencimiento.texto)}</b>`),
    "</section>",
  ].join("");
}

/**
 * **Cómo viene cambiando la ordinaria de esta unidad.** Barras arriba como forma, y abajo los dos
 * meses con su importe más la variación — el layout que el usuario definió sobre el mock.
 *
 * ⚠ El rótulo del mes va **afuera** de la pista de alto fijo. Cuando iba adentro, desbordaba y se
 * superponía con las filas, dejando además el título de la sección tachado.
 *
 * El eje arranca en cero. Con una serie que se mueve dentro de su último 10 % las columnas se
 * parecen bastante, y la alternativa —recortar el eje— cambiaría lo que la columna significa sin
 * decirlo. Por eso las barras dan la forma y los números los dan las filas.
 */
function evolucion(v: VistaBoleta): string {
  const e = v.evolucion;
  if (e === null) return "";

  const ultimo = e.puntos.at(-1);
  const previo = e.puntos.at(-2);
  if (!ultimo || !previo) return "";

  const maximo = e.puntos.map((p) => aCentavos(p.importe.monto)).reduce((a, c) => (c > a ? c : a), 0n);
  if (maximo <= 0n) return "";

  const barras = e.puntos
    .map((p, i) => {
      const alto = Number((aCentavos(p.importe.monto) * 1000n) / maximo) / 1000;
      const actual = i === e.puntos.length - 1;
      return (
        `<div class="barra${actual ? " hoy" : ""}">` +
        `<div class="pista"><div class="caja" style="height:${(alto * ALTO_TIRA_MM).toFixed(2)}mm"></div></div>` +
        /*
         * **El rótulo va sólo en los extremos**, como la referencia que el usuario marcó: seis meses
         * rotulados uno por uno son seis cifras chicas compitiendo, y lo que la tira tiene que decir
         * es "de acá hasta acá". Los importes exactos los dan las filas de abajo.
         */
        `<div class="mes">${i === 0 || actual ? escapar(p.etiqueta) : ""}</div>` +
        "</div>"
      );
    })
    .join("");

  const fila = (clase: string, etiqueta: string, cifra: string) =>
    `<div class="fila${clase ? ` ${clase}` : ""}"><span class="et">${escapar(etiqueta)}</span>` +
    `<span class="guia"></span><span class="cifra">${escapar(cifra)}</span></div>`;

  /*
   * La nota dice **por qué este número no coincide con el total a pagar**, que es la reconciliación
   * que el vecino intenta hacer mirando las dos cifras. La denominación va entre paréntesis y en
   * minúscula: interpolada en el rótulo imprimía "CÓMO CAMBIÓ TU CUOTA SOCIAL / APORTE".
   */
  const masViejo = e.puntos[0];
  const nota =
    `Comparamos el importe ordinario de cada período (${v.periodo.denominacionConcepto}): no incluye ` +
    "extraordinarias, saldo anterior ni intereses, así que no coincide con el total a pagar." +
    (e.puntos.length >= 3 && masViejo
      ? ` En ${masViejo.etiqueta}, el período más viejo que tenemos registrado, era $ ${masViejo.importe.texto}.`
      : "");

  return [
    '<section class="evolucion">',
    '<span class="titulo-zona" data-sin-marca>Evolución mensual</span>',
    `<div class="tira">${barras}</div>`,
    '<div class="cuerpo">',
    '<div class="filas">',
    fila("", previo.etiqueta, `$ ${previo.importe.texto}`),
    fila("hoy", `${ultimo.etiqueta} · esta boleta`, `$ ${ultimo.importe.texto}`),
    fila("variacion", "Última variación", e.variacionTexto),
    "</div>",
    `<div class="nota">${escapar(nota)}</div>`,
    "</div>",
    "</section>",
  ].join("");
}


/** Fragmento HTML de **una** boleta. Es lo que se concatena en el lote de una sola pasada. */
export function cuerpoBoleta(v: VistaBoleta): string {
  // Una leyenda que el cupón ya imprime **no se repite** en la zona 4. Las dos listas vienen de
  // fuentes distintas (`vista.leyendas` es del documento, `bloquePago.leyendas` del convenio de
  // cobranza) y en la práctica se pisan: "El pago de la presente no libera de obligaciones de
  // períodos anteriores" salía dos veces en la misma hoja. No se borra información —la leyenda sigue
  // impresa, dentro del cupón, que es la parte que se corta y se entrega— y los milímetros que
  // libera se los queda el detalle, que es la zona que se queda sin lugar.
  const enElCupon = new Set(v.bloquePago.leyendas);
  const leyendasDelFrente = [...v.leyendas.filter((l) => !enElCupon.has(l)), ...v.marca.pie];
  const conTroquel = v.bloquePago.presentacion.troquel !== null;

  return [
    /*
     * `con-troquel`: con línea de corte, el filete de 0,8 pt que abre el cupón sobra (ver `.zona5`).
     *
     * **Acá vivía `sin-anclaje`, y se cayó con el mock.** Existía porque el pie se anclaba al fondo
     * sólo para que el troquel cayera siempre en el mismo lugar, y sin troquel eso dejaba cinco
     * centímetros de blanco en el medio de la hoja. En el mock el pie está anclado **siempre**: el
     * aire se junta arriba de las leyendas, que es donde se lee como margen y no como un agujero, y
     * el talón —que existe con troquel y sin él— también cae siempre en el mismo lugar.
     */
    `<article class="boleta${conTroquel ? " con-troquel" : ""}">`,
    cabecera(v),
    titular(v),
    /*
     * ────────────────────────────────────────────────────────────────────────────────────────
     * EL DETALLE Y LA EVOLUCIÓN COMPARTEN RENGLÓN: TABLA A LA IZQUIERDA, TARJETA A LA DERECHA
     *
     * La evolución ocupaba **los 182 mm de ancho** de la hoja, y a esa escala una tira de cuatro
     * barras es una banda enorme que no dice nada — el usuario la rechazó tres veces mirándola
     * impresa, y tenía razón: *"los gráficos así, a lo ancho de toda la hoja, son espantosos"*.
     *
     * La forma correcta la trae la referencia: el gráfico **chico, en una tarjeta al costado**, y el
     * ancho de la hoja lo llena información de la boleta. Acá esa información es el detalle del
     * período, que es la tabla que más filas tiene y la que mejor aprovecha el ancho.
     *
     * Sin evolución la tabla vuelve sola a ocupar los 182 mm: es un `flex` con `wrap`, no una grilla
     * de dos columnas fijas.
     */
    '<div class="cuerpo-medio">',
    composicion(v),
    /*
     * ⚠ **La evolución no se imprime cuando el cupón lleva un símbolo físico** (código de barras).
     * No es una preferencia: es el presupuesto vertical. Un cupón de red se come ~73 mm del pie y el
     * detalle se queda sin lugar — medido, pedía 208 px y le quedaban 9, y la guarda cortaba la
     * emisión. La evolución es el bloque declarado sacrificable (doc 09 §E.10); el detalle no.
     */
    v.bloquePago.instrumentos.some((i) => i.tipo === "simbolo" && i.simbologia !== "qrcode")
      ? ""
      : evolucion(v),
    "</div>",
    detalle(v),
    '<section class="zona4">',
    /*
     * **El gancho a la liquidación del último mes cerrado.**
     *
     * Requisito del usuario (2026-08-05): la boleta viaja con la liquidación de gastos del último mes
     * cerrado. Hoy el barrio piloto la manda con dos meses de atraso porque concilia a mano; que
     * salga la del mes anterior es en sí mismo un argumento contra el sistema actual, así que la hoja
     * lo dice.
     *
     * **Sin cifras**, por decisión del mismo día: el titular tentaba ("el 32 % se fue en seguridad")
     * pero mete en la boleta de cada unidad un dato del barrio que ya vive, completo y con su
     * respaldo, en el documento adjunto. La boleta avisa; el que explica es el otro.
     *
     * Se dibuja solo si hay un período anterior del que hablar — y lo hay exactamente cuando hay
     * evolución, que arranca en el mes previo a éste.
     */
    v.evolucion === null
      ? ""
      : `<div class="adjunto" style="border-left-color:${v.marca.barrio.acentoHex}">` +
        `<strong>Va adjunta la liquidación de ${escapar(v.evolucion.puntos.at(-2)?.etiqueta ?? "")}</strong>, ` +
        "el último mes cerrado: ahí está el detalle de los gastos.</div>",
    `<div class="leyendas">${leyendasDelFrente.map((l) => `<div>${escapar(l)}</div>`).join("")}</div>`,
    "</section>",
    bloqueDePago(v),
    "</article>",
  ].join("");
}
