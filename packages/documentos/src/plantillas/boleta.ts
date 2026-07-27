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
 *    `printInk`), que es donde doc 06 §g.2 manda ponerlos primero.
 *
 * El diseño que implementa es doc 09 §E: cinco zonas con presupuesto vertical en mm (§E.2.2), la
 * jerarquía tipográfica de §E.5.3 y la zona de exclusión del instrumento de §E.6.
 */

import { fontSizePrint as fp, light, printInk as tinta, printMinLegibleTitular } from "@admin-barrios/design-tokens";
import type { InstrumentoPago, VistaBoleta } from "@admin-barrios/shared/documentos";
import { renderizarSimbolo } from "../simbolos.ts";
import { bloqueFuentes, escapar, familiaSans, PILA_MONO, type FuenteEmbebida } from "./comun.ts";
import { ANCHO_COLUMNA_BARRAS_MM, celdaBarra, estilosGraficos, llevaColumnaDeBarras } from "./graficos.ts";
import { glifoBanda, glifoTijera } from "./glifos.ts";

/** Ancho útil de la hoja A4 con los márgenes de doc 09 §E.2.2 (210 − 14 − 14). */
export const ANCHO_UTIL_MM = 182;

/**
 * Presupuesto vertical de doc 09 §E.2.2, en mm. Las zonas 0 y 1 son **fijas**: es lo que hace que el
 * troquel caiga siempre en el mismo lugar de la hoja, tenga o no deuda el vecino. La 3 es la única
 * elástica y tiene tope; si no entra, el renderizador **falla la emisión** en vez de recortar una
 * línea de dinero en silencio.
 */
export const PRESUPUESTO_MM = {
  franja: 4,
  zona0: 24,
  zona1: 52,
  /** Tope del detalle. Pasado esto, el contenido **desborda al dorso**; hoy corta la emisión. */
  zona3: 56,
  /** Ancho de la celda del importe grande. De acá sale el cuerpo del total (`cuerpoDelTotal`). */
  celdaTotal: 80,
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
 * de ahí baja **solo lo necesario**, y el piso es el de la capa sin zoom (`printMinLegibleTitular`), porque
 * por debajo de eso el total deja de leerse en un teléfono y el diseño falló (§E.5.1). Si ni con el
 * piso entra, la guarda de desbordes corta la emisión.
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
 * **Dos tintas por banda y no una, a propósito.** `barra` es el filete de 1,2 mm del borde
 * izquierdo, que no lleva texto y solo necesita distinguirse del papel; `texto` es la tinta del
 * rótulo y del glifo, y esa sí tiene que dar **≥ 4,5:1 sobre blanco** (doc 09 §E.8.1).
 *
 * Donde §E.4.1 y §E.8.1 se contradicen manda el contraste: la banda de bonificación tiene asignado
 * `primary` (teal `#0D9488`), que da **3,1:1** y no puede llevar texto. El teal queda en la barra y
 * el rótulo va en `textPrimary`. La banda sigue distinguiéndose por glifo, palabra y cifra, que es
 * lo que doc 09 §E.8.3 exige que sobreviva a la fotocopia.
 */
const COLOR_BANDA: Record<string, { barra: string; texto: string }> = {
  al_dia: { barra: light.morosidad.alDia.fg, texto: light.morosidad.alDia.fg }, // 4,9:1
  saldo_anterior: { barra: light.morosidad.vencido.fg, texto: light.morosidad.vencido.fg }, // 4,8:1
  bonificacion_aplicada: { barra: light.primary, texto: tinta.textPrimary }, // teal: 3,1:1, no lleva texto
  bonificacion_no_aplicada: { barra: light.info, texto: light.info }, // 5,1:1
  interes_pendiente: { barra: light.warning, texto: light.warning }, // 4,8:1
  vista_previa: { barra: tinta.textSecondary, texto: tinta.textSecondary }, // 10,3:1
};

function cssDeBandas(): string[] {
  return Object.entries(COLOR_BANDA).flatMap(([clave, c]) => [
    `.banda--${clave}{border-left-color:${c.barra}}`,
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
    // Columna flex con el presupuesto vertical de doc 09 §E.2.2: zonas 0 y 1 de altura fija, la 3
    // elástica con tope, y el instrumento **anclado al borde inferior**.
    ".boleta{position:relative;display:flex;flex-direction:column;width:210mm;height:297mm;padding:0 var(--m-right) var(--m-bottom) var(--m-left);overflow:hidden;page-break-after:always;break-after:page}",
    ".boleta:last-of-type{page-break-after:auto;break-after:auto}",
    ".boleta > *{flex:0 0 auto}",
    // Toda cifra en monoespaciada: es lo único que sostiene la alineación de columnas (doc 09 §E.5.3).
    `.cifra{font-family:${PILA_MONO};font-variant-numeric:tabular-nums;white-space:nowrap}`,
    // Los glifos de banda y la tijera del troquel: SVG en línea, en la tinta de quien los contiene.
    ".glifo{width:4mm;height:4mm;flex:0 0 auto;display:block}",
    ".tijera{width:3.2mm;height:3.2mm;flex:0 0 auto;display:block}",

    // --- Franja de acento: 4 mm a sangre, y NADA MÁS lleva ese color en toda la hoja -------------
    `.franja{height:${p.franja}mm;margin:0 calc(-1 * var(--m-right)) calc(var(--m-top) - ${p.franja}mm) calc(-1 * var(--m-left))}`,

    // --- Zona 0 · identidad (alto fijo: el logo NUNCA define la altura de la cabecera) -----------
    // Doc 09 §E.2.2 le da 28 mm; acá mide 24. La caja de logo sigue siendo la de §E.9.2 (20 mm de
    // alto) y las dos columnas de texto entran holgadas en 22 mm, así que los 4 mm de diferencia
    // eran aire muerto — y el detalle los necesitaba. Lo que §E protege con el número es que la
    // cabecera NO crezca con el logo del cliente, y eso se sigue cumpliendo.
    `.zona0{flex:0 0 ${p.zona0}mm;display:flex;gap:5mm;align-items:flex-start;overflow:hidden;border-bottom:.4pt solid ${tinta.hairline};padding-bottom:2mm}`,
    `.logo{width:auto;max-width:45mm;height:20mm;flex:0 0 auto;display:flex;align-items:center;justify-content:flex-start;background:${tinta.paper}}`,
    ".logo img{max-width:45mm;max-height:20mm;object-fit:contain}",
    `.logotipo{display:flex;align-items:center;justify-content:center;width:45mm;height:20mm;flex:0 0 auto;color:${tinta.paper};font-weight:600;font-size:${fp.xl}pt;line-height:1.2;text-align:center;padding:2mm}`,
    ".identidad{min-width:0;flex:1 1 auto}",
    `.barrio-nombre{font-size:${fp.lg}pt;font-weight:600;line-height:1.2}`,
    `.emisor{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.25;margin-top:.6mm}`,
    // La unidad es lo que responde "¿esto es mío?": va en el piso de la zona 1, no en letra de pie.
    `.unidad{font-size:${fp.xl}pt;font-weight:500;margin-top:1.6mm;line-height:1.2}`,
    `.destinatario{font-size:${fp.base}pt;color:${tinta.textSecondary};line-height:1.25}`,
    `.identidad-der{flex:0 0 auto;text-align:right;font-size:${fp.base}pt;line-height:1.3}`,
    `.identidad-der .periodo{font-size:${fp.xl}pt;font-weight:600}`,
    `.identidad-der .dato{color:${tinta.textSecondary}}`,

    // --- Zona 1 · el titular (52 mm de piso) -----------------------------------------------------
    // `min-height` y no alto fijo: con tres bandas apiladas y textos que van a dos renglones, 52 mm
    // no alcanzan (doc 09 §E.4.1 los pide de un renglón, pero sus propios textos modelo no entran).
    // La zona crece y **la 3 absorbe**, que es el mecanismo de §E.2.2; el troquel no se mueve porque
    // quien lo ancla es el bloque de exclusión al pie de la columna, no el alto exacto de esta zona.
    //
    // Las bandas van pegadas ABAJO (`margin-top:auto`): así el aire de la zona queda alrededor del
    // importe —que es lo que lo convierte en la única mancha de la hoja (doc 09 §E.15.1)— y no
    // pooleado entre las bandas y la composición.
    `.zona1{flex:0 0 auto;min-height:${p.zona1}mm;display:flex;flex-direction:column;padding-top:2.5mm}`,
    `.titular{display:grid;grid-template-columns:${p.celdaTotal}mm ${p.celdaVence}mm 1fr;gap:0 4mm;align-items:start}`,
    // Cada celda es su propia caja acotada: si algo no entra, la guarda de desbordes lo ve y corta la
    // emisión. Es la red que atrapa el importe pisando la fecha antes de que lo vea un vecino.
    ".titular > div{min-width:0;overflow:hidden}",
    `.rotulo{font-size:${fp.xl}pt;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:${tinta.textSecondary};line-height:1.2}`,
    // `.importe-total` y no `.total`: `.total` colisionaba con `tr.total` de la zona 2 y le metía
    // `display:flex` a la fila del TOTAL A PAGAR, que se imprimía desalineada y sin su guía.
    ".importe-total{display:flex;align-items:baseline;gap:1.5mm;line-height:1.05;margin-top:.5mm}",
    `.importe-total .signo{font-size:${fp["2xl"]}pt;font-weight:600;color:${tinta.textSecondary}}`,
    ".importe-total .monto{font-weight:700}",
    `.vence{font-size:${fp["2xl"]}pt;font-weight:600;line-height:1.15;margin-top:1mm}`,
    `.sub{font-size:${fp.base}pt;color:${tinta.textSecondary};line-height:1.3}`,
    `.zona1 .sub{margin-top:.8mm}`,
    ".bandas{margin-top:auto;display:flex;flex-direction:column;gap:1mm}",
    // Altura reservada para tres bandas de un renglón (doc 09 §E.4.1). Una banda que necesita dos
    // renglones se los toma del slot libre: el ÁREA no se colapsa, que es lo que mantiene el troquel
    // quieto; lo que se reparte adentro es asunto del caso.
    `.banda{flex:0 0 auto;min-height:6.5mm;display:flex;align-items:center;gap:2mm;border:.4pt solid ${tinta.hairline};border-left-width:1.2mm;padding:.5mm 2.5mm;font-size:${fp.xl}pt;line-height:1.15;overflow:hidden}`,
    ".banda .frase{min-width:0}",
    ".banda .t{font-weight:600;text-transform:uppercase;letter-spacing:.03em}",
    `.banda .d{font-size:${fp.base}pt;font-weight:400}`,
    ".banda.vacia{border-color:transparent;visibility:hidden;min-height:6.5mm}",
    ...cssDeBandas(),

    // --- Zona 2 · la composición -----------------------------------------------------------------
    // Toma el alto que necesita (los renglones varían con la cantidad de cargos) y la zona 3 absorbe
    // la diferencia. Ceros explícitos: ningún renglón desaparece por valer cero.
    ".zona2{flex:0 0 auto;padding-top:3mm}",
    `.titulo-zona{font-size:${fp.lg}pt;font-weight:600;line-height:1.2;text-transform:uppercase;letter-spacing:.04em;color:${tinta.textSecondary};margin-bottom:.8mm}`,
    `.renglones{width:100%;border-collapse:collapse;font-size:${fp.base}pt;line-height:1.12}`,
    ".renglones td{padding:.1mm 0;vertical-align:baseline}",
    ".renglones td.imp{text-align:right;width:40mm;white-space:nowrap}",
    // La guía de puntos no es adorno: son 40 mm de blanco entre el concepto y el importe, y sin ella
    // el ojo salta de renglón. Se dibuja con un filete punteado que ocupa lo que sobra.
    ".renglones .lin{display:flex;align-items:baseline;gap:2mm}",
    `.renglones .lin .guia{flex:1 1 auto;border-bottom:.4pt dotted ${tinta.hairline};transform:translateY(-.8mm)}`,
    `.renglones tr.subtotal td{border-top:.4pt solid ${tinta.hairline};font-size:${fp.lg}pt;font-weight:700;padding-top:1mm}`,
    `.renglones tr.total td{border-top:1.2pt double ${tinta.textPrimary};font-size:${fp.lg}pt;font-weight:700;padding-top:1mm}`,
    `.renglones td .aclara{font-size:${fp.xs}pt;color:${tinta.textSecondary};white-space:nowrap}`,

    // --- Zona 3 · el detalle: la ÚNICA zona elástica ---------------------------------------------
    // Se queda con lo que sobra y, si no alcanza, el renderizador falla la emisión en vez de recortar
    // una línea de dinero (doc 09 §E.2.2).
    `.zona3{flex:0 1 auto;min-height:0;max-height:${p.zona3}mm;padding-top:2.5mm;overflow:hidden;display:flex;flex-direction:column}`,
    // Los hijos NO se encogen. Sin esto, cuando la zona quedaba justa el navegador aplastaba el
    // encabezado ("El barrio gastó $X · tu coeficiente es Y") hasta dejarlo cortado a la mitad —
    // y encima la guarda de desbordes no se enteraba, porque el contenido "entraba" achicado.
    ".zona1 > *,.zona3 > *{flex:0 0 auto}",
    `.detalle{width:100%;border-collapse:collapse;font-size:${fp.sm}pt;line-height:1.15}`,
    `.detalle th{font-size:${fp.xs}pt;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:${tinta.textSecondary};text-align:left;border-bottom:.4pt solid ${tinta.hairline};padding:0 0 .8mm}`,
    `.detalle td{padding:.2mm 0;border-bottom:.4pt solid ${tinta.hairlineSoft};vertical-align:top}`,
    `.detalle .aclara{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.2}`,
    // La línea de aclaraciones y su fila son **un solo renglón visual**: el filete va abajo de las
    // dos, no en el medio, para que no parezcan dos líneas de detalle distintas.
    ".detalle tr.con-aclara > td{border-bottom:none;padding-bottom:0}",
    ".detalle tr.aclara-fila > td{padding-top:0}",
    ".detalle .tipo{white-space:nowrap}",
    ".detalle .num{text-align:right;white-space:nowrap;padding-left:4mm}",
    ".encabezado-zona{display:flex;align-items:baseline;gap:3mm;margin-bottom:.5mm;white-space:nowrap;overflow:hidden}",
    ".encabezado-zona .titulo-zona{margin-bottom:0;white-space:nowrap}",
    `.notas{font-size:${fp.xs}pt;color:${tinta.textSecondary};margin-top:.5mm;line-height:1.2}`,

    // --- Zona 4 · notas y "cómo pagar" -----------------------------------------------------------
    // `margin-top:auto` junta acá el sobrante de la hoja: el aire queda en UN lugar previsible, justo
    // arriba del pie, en vez de repartido en huecos entre bloques (doc 09 §E.10.2, paso 4).
    `.zona4{flex:0 0 auto;margin-top:auto;font-size:${fp.xs}pt;color:${tinta.textSecondary};padding-top:1mm;line-height:1.25}`,

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
    `.zona5{background:${tinta.paper};color:${tinta.instrumentoInk};padding-top:.8mm;display:flex;flex-wrap:wrap;align-items:flex-start;gap:0 4mm}`,
    ".zona5 .datos{flex:1 1 110mm;min-width:0}",
    ".zona5 .qr{flex:0 0 auto}",
    // Los símbolos lineales ocupan un RENGLÓN PROPIO, a lo ancho de la hoja. No es estética: el
    // código de barras mide los 182 mm útiles enteros, así que compartir fila con el QR hacía que
    // el QR —posterior en el DOM— se imprimiera **encima del último 24 % del símbolo**, zona muda
    // incluida, y un lector no leía nada. La regla de doc 09 §E.6 ("nada se pone al costado del
    // código") la tiene que hacer cumplir el CSS, no un comentario.
    ".zona5 .simbolos{flex:1 1 100%;min-width:0}",
    `.zona5 .et{font-size:${fp.sm}pt;font-weight:600}`,
    `.zona5 .imp{font-size:${fp["2xl"]}pt;font-weight:700;line-height:1.1}`,
    ".simbolos{display:flex;flex-wrap:wrap;align-items:flex-end;gap:0 4mm}",
    `.zona5 .nota{font-size:${fp.xs}pt;color:${tinta.instrumentoInk};line-height:1.2;margin-top:.4mm}`,
    ".simbolo{margin:.2mm 0}",
    `.simbolo .leible{font-family:${PILA_MONO};font-size:${fp.sm}pt;letter-spacing:.03em;line-height:1.2}`,
    `.textos-pago{display:grid;grid-template-columns:repeat(3,1fr);gap:.8mm 3mm;font-size:${fp.sm}pt;line-height:1.15}`,
    `.textos-pago .cifra{font-size:${fp.xs}pt;overflow-wrap:anywhere;white-space:normal}`,
    `.leyendas{font-size:${fp.xs}pt;margin-top:.6mm;line-height:1.2}`,
    // --- Zona 6 · talón para la administración ---------------------------------------------------
    `.talon{border-top:.6pt dotted ${tinta.instrumentoInk};margin-top:.6mm;padding-top:.6mm;font-size:${fp.sm}pt;line-height:1.25;color:${tinta.instrumentoInk}}`,
  ].join("");
}

// --- El cuerpo ----------------------------------------------------------------------------------

const ETIQUETA_2048: Record<string, string> = {
  ordinaria: "Ordinaria",
  extraordinaria: "Extraordinaria",
  fondo_reserva: "Fondo de reserva",
  no_corresponde: "Cargo / descuento",
};

function cabecera(v: VistaBoleta): string {
  const { barrio, emisor } = v.marca;
  const marcaBarrio =
    barrio.logo === null
      ? `<div class="logotipo" style="background:${barrio.acentoHex}">${escapar(barrio.nombre.toUpperCase())}</div>`
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

  const destinatario = v.unidad.rolDestinatario
    ? `${escapar(v.unidad.destinatario)} — ${escapar(v.unidad.rolDestinatario)}`
    : escapar(v.unidad.destinatario);

  return [
    `<div class="franja" style="background:${v.marca.barrio.acentoHex}"></div>`,
    '<header class="zona0" data-desborde="identidad">',
    marcaBarrio,
    '<div class="identidad">',
    `<div class="barrio-nombre">${escapar(barrio.nombre)}</div>`,
    `<div class="emisor">${datosEmisor}</div>`,
    `<div class="unidad cifra">${escapar(v.unidad.etiqueta)}</div>`,
    `<div class="destinatario">${destinatario}</div>`,
    "</div>",
    '<div class="identidad-der">',
    `<div class="periodo">PERÍODO <span class="cifra">${escapar(v.periodo.etiqueta)}</span></div>`,
    v.emision.comprobante
      ? `<div class="dato">Comprobante <span class="cifra">${escapar(v.emision.comprobante)}</span></div>`
      : '<div class="dato">Comprobante: pendiente de numeración</div>',
    // Mismas palabras que usan el informe y el listado para el mismo estado: la familia no puede
    // tener dos formas de decir que un documento todavía no se emitió.
    v.emision.fecha === null
      ? '<div class="dato">Documento sin emitir</div>'
      : `<div class="dato">Emitida <span class="cifra">${escapar(v.emision.fecha.texto)}</span></div>`,
    `<div class="dato">Coeficiente <span class="cifra">${escapar(v.detalle.coeficiente.participacionTexto)} %</span></div>`,
    "</div>",
    "</header>",
  ].join("");
}

function titular(v: VistaBoleta): string {
  // La celda contesta **dónde**, y eso lo declara el adapter (`canalesDePago`). Antes se armaba
  // juntando las etiquetas de los instrumentos de texto, y ahí se colaba "Convenio", que no es un
  // lugar donde pagar sino el número del acuerdo con la red — un campo del cupón del pie.
  const donde = v.bloquePago.canalesDePago.map(escapar).join(" · ");

  // Tres slots de banda con altura reservada: la hoja del que debe y la del que está al día ocupan
  // lo mismo, así el troquel cae siempre en el mismo lugar de la hoja (doc 09 §E.4.1).
  //
  // **Los slots vacíos van primero.** El orden de las bandas que existen es fijo (§E.4.1) y no se
  // toca; el del hueco no lo fija nadie. Poniéndolo arriba, las bandas quedan pegadas al filete de
  // la zona 2 y el blanco reservado se suma al que rodea al importe — que es donde doc 09 §E.15.1
  // lo quiere. Con el hueco abajo, la hoja de casi todos los vecinos mostraba 12 mm de nada entre
  // la última banda y "De dónde sale ese número".
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

  return [
    '<section class="zona1">',
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
    '<div data-desborde="titular-vence">',
    '<div class="rotulo" data-sin-marca>Vence el</div>',
    `<div class="vence cifra">${escapar(v.bloquePago.fechas.vencimiento.texto)}</div>`,
    // La fecha tope va **subordinada**, nunca igualada: no es un segundo vencimiento con recargo,
    // es el límite de la red de cobranza (doc 09 §E.6). Igualarlas enseña a pagar tarde.
    v.bloquePago.fechas.tope
      ? `<div class="sub">Tope de la red <span class="cifra">${escapar(v.bloquePago.fechas.tope.texto)}</span></div>`
      : '<div class="sub">Sin fecha tope informada</div>',
    "</div>",
    '<div data-desborde="titular-donde">',
    '<div class="rotulo" data-sin-marca>Dónde pagás</div>',
    `<div class="sub">${donde || "Ver el cupón al pie"}</div>`,
    '<div class="sub">Con el código del pie</div>',
    "</div>",
    "</div>",
    `<div class="bandas">${bandas}</div>`,
    "</section>",
  ].join("");
}

function composicion(v: VistaBoleta): string {
  const renglon = (etiqueta: string, texto: string, clase: string, aclaracion: string | null, marcador: number | null) =>
    `<tr class="${clase}"><td><span class="lin"><span>${escapar(etiqueta)}${marcador === null ? "" : ` (${marcador})`}</span>` +
    (aclaracion ? `<span class="aclara">${escapar(aclaracion)}</span>` : "") +
    `<span class="guia"></span></span></td><td class="imp cifra">$ ${escapar(texto)}</td></tr>`;

  const variables = v.composicion
    .map((r) => renglon(r.etiqueta, r.importe.texto, r.informativo ? "informativo" : "", r.aclaracion, r.marcadorNota))
    .join("");

  // Nunca se omite, aunque valga cero (doc 07 §B): un renglón ausente se lee como dato escondido.
  // Y el importe **nunca** se arma post-procesando el HTML con una expresión regular: un cambio de
  // clases dejaría la hoja imprimiendo `$ 0.00` sin formatear y afirmando que no hay interés.
  const renglonPendiente = (etiqueta: string, aclaracion: string | null) =>
    `<tr><td><span class="lin"><span>${escapar(etiqueta)}</span>` +
    (aclaracion ? `<span class="aclara">${escapar(aclaracion)}</span>` : "") +
    '<span class="guia"></span></span></td><td class="imp">pendiente</td></tr>';

  const interes =
    v.totales.interes === null || v.interes === null
      ? renglonPendiente("Interés: pendiente de definición", "El barrio no tiene tasa cargada a la fecha de emisión")
      : renglon(
          // Cada parte se imprime solo si el sistema la tiene. Con interés en cero es normal que no
          // haya días ni fecha de corte, y la hoja lo dice en vez de inventarlos.
          [
            `Interés (base $ ${v.interes.base.texto}`,
            v.interes.tasaMensualTexto === null ? null : `${v.interes.tasaMensualTexto} % mensual`,
            v.interes.dias === null ? null : `${v.interes.dias} días`,
            v.interes.computadoHasta === null ? null : `al ${v.interes.computadoHasta.texto}`,
          ]
            .filter((x): x is string => x !== null)
            .join(" · ") + ")",
          v.totales.interes.texto,
          "",
          null,
          null,
        );

  return [
    '<section class="zona2">',
    '<div class="titulo-zona" data-sin-marca>De dónde sale ese número</div>',
    '<table class="renglones">',
    variables,
    renglon(`Total del período ${v.periodo.etiqueta}`, v.totales.delPeriodo.texto, "subtotal", null, null),
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
    '<span class="titulo-zona" data-sin-marca>Qué cubre</span>',
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

function instrumento(inst: InstrumentoPago): string {
  if (inst.tipo === "texto") {
    return `<div><span class="et">${escapar(inst.etiqueta)}</span> <span class="cifra">${escapar(inst.valor)}</span></div>`;
  }
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

/** Las aclaraciones de los instrumentos de texto, en un solo renglón al pie del bloque. */
function aclaracionesDePago(textos: readonly InstrumentoPago[]): string {
  const partes = textos
    .filter((i): i is Extract<InstrumentoPago, { tipo: "texto" }> => i.tipo === "texto" && i.nota !== null)
    .map((i) => `${escapar(i.etiqueta)}: ${escapar(i.nota ?? "")}`);
  return partes.length === 0 ? "" : `<div class="nota">${partes.join(" · ")}</div>`;
}

function bloqueDePago(v: VistaBoleta): string {
  const b = v.bloquePago;
  // El QR se ubica al costado del bloque de datos; los símbolos lineales van debajo, a lo ancho.
  // **Nada se pone al costado del código de barras**: su zona muda es parte de su propio SVG.
  const lineales = b.instrumentos.filter((i) => i.tipo === "simbolo" && i.simbologia !== "qrcode");
  const qr = b.instrumentos.filter((i) => i.tipo === "simbolo" && i.simbologia === "qrcode");
  const textos = b.instrumentos.filter((i) => i.tipo === "texto");

  return [
    // La zona de exclusión completa (doc 09 §E.6). El renderizador la lee para no estampar nada
    // encima: una marca de agua sobre el código de barras es un vecino que no puede pagar.
    '<div class="exclusion" data-exclusion>',
    // Troquel: el rótulo va EN LA LÍNEA, entre dos tramos punteados, con la tijera de cada lado.
    // Son los dos únicos agregados permitidos alrededor del instrumento (doc 09 §E.6).
    '<div class="troquel">',
    '<span class="corte"></span>',
    glifoTijera(),
    "<span>PRESENTÁ ESTA PARTE EN LA CAJA</span>",
    glifoTijera(),
    '<span class="corte"></span>',
    "</div>",
    '<section class="zona5" data-desborde="cupon">',
    '<div class="datos">',
    '<div class="textos-pago">',
    `<div><span class="et">Vencimiento</span> <span class="cifra">${escapar(b.fechas.vencimiento.texto)}</span></div>`,
    `<div><span class="et">Importe</span> <span class="imp cifra">$ ${escapar(b.importes.alVencimiento.texto)}</span></div>`,
    b.fechas.tope && b.importes.alTope
      ? `<div><span class="et">Fecha tope</span> <span class="cifra">${escapar(b.fechas.tope.texto)}</span> — <span class="cifra">$ ${escapar(b.importes.alTope.texto)}</span></div>`
      : "<div></div>",
    "</div>",
    `<div class="textos-pago">${textos.map(instrumento).join("")}</div>`,
    aclaracionesDePago(textos),
    b.logos
      .map((l) => `<img src="${l.dataUri}" alt="" style="max-height:${l.altoMaxMm}mm;max-width:${l.anchoMaxMm}mm">`)
      .join(""),
    `<div class="leyendas">${b.leyendas.map((l) => `<div>${escapar(l)}</div>`).join("")}</div>`,
    "</div>",
    `<div class="qr">${qr.map(instrumento).join("")}</div>`,
    // `data-desborde` va en el contenedor de los símbolos y no solo en la zona: el desborde de
    // ancho ocurre acá adentro, y medirlo un nivel más arriba no lo ve.
    `<div class="simbolos" data-desborde="simbolos">${lineales.map(instrumento).join("")}</div>`,
    "</section>",
    '<section class="talon">',
    `<div>PARA LA ADMINISTRACIÓN — ${escapar(v.marca.emisor.razonSocial)} · ${escapar(v.unidad.etiqueta)} · ` +
      `${escapar(v.unidad.destinatario)} · Período ${escapar(v.periodo.etiqueta)}` +
      (v.emision.comprobante ? ` · Comprobante ${escapar(v.emision.comprobante)}` : "") +
      "</div>",
    `<div>Vencimiento ${escapar(b.fechas.vencimiento.texto)} — <span class="cifra">$ ${escapar(b.importes.alVencimiento.texto)}</span>` +
      (b.fechas.tope && b.importes.alTope
        ? ` · Fecha tope ${escapar(b.fechas.tope.texto)} — <span class="cifra">$ ${escapar(b.importes.alTope.texto)}</span>`
        : "") +
      "</div>",
    "</section>",
    "</div>",
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

  return [
    '<article class="boleta">',
    cabecera(v),
    titular(v),
    composicion(v),
    detalle(v),
    '<section class="zona4">',
    leyendasDelFrente.map((l) => `<div>${escapar(l)}</div>`).join(""),
    "</section>",
    bloqueDePago(v),
    "</article>",
  ].join("");
}
