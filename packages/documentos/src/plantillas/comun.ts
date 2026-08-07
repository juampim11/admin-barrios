/**
 * Lo que comparten **todos** los documentos de la familia: la boleta, el informe mensual del barrio
 * y el listado de saldos pendientes.
 *
 * La razón de que este archivo exista es una regla de diseño, no una comodidad: los tres documentos
 * viajan en el mismo envío y **no pueden tener dos idiomas gráficos**. Si el escapado, la pila
 * tipográfica, la caja del logo o la tinta de los filetes viven copiados en cada plantilla, en tres
 * meses divergen — y el vecino recibe un sobre donde cada hoja parece de otra administración.
 *
 * Lo que NO vive acá: nada específico de un documento. La zona del instrumento de pago es de la
 * boleta y sólo de ella; la tabla de conceptos es del informe. Acá está el sustrato.
 */

import { z } from "zod";
import {
  ANCHO_UTIL_ARCHIVO_MM,
  fontSizePrint as fp,
  printFila,
  printInk as tinta,
  printPatron,
} from "@admin-barrios/design-tokens";
import type { MarcaDocumento } from "@admin-barrios/shared/documentos";
import { esFaltante, motivosFaltantes, type DatoFaltante } from "@admin-barrios/shared/documentos";

export { ANCHO_UTIL_ARCHIVO_MM };

/** Escapa **todo** campo de origen humano. Sin excepciones: el markup lo arma el sistema, no el dato. */
export function escapar(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/**
 * Una fuente ya embebida como `data:`. **Nunca una URL** (ADR-0001 §3.2): la red está apagada en el
 * renderizador, así que una fuente remota no cargaría — y el plan B degrada a la fuente por defecto
 * **en silencio** cuando no puede resolverla (doc 07 §B). Una hoja que reflowea sin avisar es peor
 * que una que falla.
 */
export const fuenteEmbebidaSchema = z
  .object({
    familia: z.string().regex(/^[A-Za-z0-9 _-]{1,64}$/, "nombre de familia inválido para un @font-face"),
    peso: z.number().int().min(1).max(1000),
    formato: z.enum(["woff2", "truetype"]),
    dataUri: z
      .string()
      // Los mismos tres mediatypes que deja pasar el interceptor del renderizador. **Sin
      // `application/octet-stream`**: en la práctica es un comodín.
      .regex(
        /^data:font\/(woff2|woff|ttf);base64,[A-Za-z0-9+/=]+$/,
        "la fuente tiene que venir como data:font/... (la red está apagada en el renderizador)",
      ),
  })
  .readonly();
export type FuenteEmbebida = z.infer<typeof fuenteEmbebidaSchema>;

/**
 * Pila tipográfica de reserva: las familias que `fonts-liberation` deja en la imagen del worker
 * (ADR-0001 §3.2), así que **no sale ningún request de red** aunque no haya `@font-face`.
 */
export const PILA_SANS = "'Liberation Sans', 'DejaVu Sans', Arial, Helvetica, sans-serif";
export const PILA_MONO = "'Liberation Mono', 'DejaVu Sans Mono', 'Courier New', monospace";

export function bloqueFuentes(fuentes: readonly FuenteEmbebida[]): string {
  return fuentes
    .map((cruda) => {
      const f = fuenteEmbebidaSchema.parse(cruda);
      return `@font-face{font-family:'${f.familia}';font-weight:${f.peso};font-display:block;src:url(${f.dataUri}) format('${f.formato}')}`;
    })
    .join("");
}

export function familiaSans(fuentes: readonly FuenteEmbebida[]): string {
  return fuentes.length > 0 ? `'${fuentes[0]?.familia}', ${PILA_SANS}` : PILA_SANS;
}

// --- El sustrato de CSS -------------------------------------------------------------------------

/**
 * CSS que comparten los documentos **multipágina** de la familia (informe y listado).
 *
 * Dos decisiones de maquetación que hay que leer juntas, porque una compensa a la otra:
 *
 * 1. **Los márgenes laterales los pone el `padding` del documento**, no `@page`. El padding
 *    horizontal de una caja que se parte entre páginas se aplica en **todas** sus páginas, así que
 *    con `@page{margin:0}` —que es lo que el generador emite para que la franja de acento salga a
 *    sangre— los 18/14 mm siguen valiendo en la hoja 7.
 * 2. **El aire de arriba y de abajo de cada página lo ponen el encabezado y el pie corridos**, que
 *    Chromium repite en cada página vía `display:table-header-group` / `table-footer-group`. El
 *    padding **vertical** de una caja partida sólo aparece en la primera y en la última página: si
 *    el margen superior dependiera de él, de la hoja 2 en adelante el texto arrancaría pegado al
 *    borde del papel.
 */
export function estilosFamilia(fuentes: readonly FuenteEmbebida[] = []): string {
  const sans = familiaSans(fuentes);
  const m = { top: 12, right: 14, bottom: 12, left: 18 };
  return [
    bloqueFuentes(fuentes),
    "*{box-sizing:border-box}",
    `html,body{margin:0;padding:0;background:${tinta.paper};color:${tinta.textPrimary};font-family:${sans};font-size:${fp.base}pt;line-height:1.3;-webkit-print-color-adjust:exact;print-color-adjust:exact}`,
    // Un documento = un `<article>` que fluye por N páginas. El salto va después de cada uno menos
    // el último, igual que en la boleta: es lo que permite concatenar documentos en una sola pasada.
    `.doc{position:relative;width:210mm;padding:0 ${m.right}mm 0 ${m.left}mm;page-break-after:always;break-after:page}`,
    ".doc:last-of-type{page-break-after:auto;break-after:auto}",
    // Toda cifra en monoespaciada: es lo único que sostiene la alineación de columnas en este motor.
    `.cifra{font-family:${PILA_MONO};font-variant-numeric:tabular-nums;white-space:nowrap}`,
    ".glifo{width:4mm;height:4mm;flex:0 0 auto;display:block}",

    // --- La hoja: encabezado y pie corridos ----------------------------------------------------
    // El `thead`/`tfoot` repetido **no puede** llevar `position`, `overflow` ni `transform`:
    // Chromium deja de repetirlo. Y con `border-collapse:collapse` los bordes del `thead` se pierden
    // en las páginas 2..n, así que el filete va como `border-bottom` de la celda.
    // `table-layout:fixed` no es cosmético y costó un PDF: con el layout automático, la celda de la
    // hoja **se ensancha para acomodar a su contenido** —un `flex` con doce cajas de 40 mm de mínimo
    // pide 480 mm— y el documento entero se sale del papel por la derecha. Con el layout fijo la
    // celda mide lo que mide la hoja y el contenido se acomoda adentro. La guarda de desbordes del
    // renderizador lo atrapó antes de que saliera un PDF; esto es el arreglo, no el parche.
    ".hoja{width:100%;table-layout:fixed;border-collapse:collapse}",
    ".hoja > thead{display:table-header-group}",
    ".hoja > tfoot{display:table-footer-group}",
    ".hoja > thead > tr > td,.hoja > tfoot > tr > td,.hoja > tbody > tr > td{padding:0}",
    `.corrido{min-height:${printFila.encabezadoRepetido}mm;padding:${m.top}mm 0 1.6mm;border-bottom:.4pt solid ${tinta.hairline};line-height:1.25}`,
    `.corrido .l1{font-size:${fp.base}pt;font-weight:600;display:flex;flex-wrap:wrap;gap:0 2.5mm}`,
    `.corrido .l2{font-size:${fp.xs}pt;color:${tinta.textSecondary};display:flex;flex-wrap:wrap;gap:0 2.5mm;margin-top:.4mm}`,
    ".corrido .doc-tipo{text-transform:uppercase;letter-spacing:.05em}",
    `.pie{min-height:${printFila.pieRepetido}mm;padding:1.4mm 0 ${m.bottom}mm;border-top:.4pt solid ${tinta.hairline};font-size:${fp.xs}pt;color:${tinta.textSecondary};display:flex;justify-content:space-between;gap:0 4mm}`,
    // Hueco reservado para "Página N de M". Lo estampa el renderizador con pdf-lib, porque ni CSS ni
    // la plantilla pueden numerar páginas: Chromium no implementa las cajas de margen de `@page`.
    ".pie .folio{width:30mm;text-align:right}",

    // --- Franja de acento: 4 mm a sangre, SOLO en la primera página ----------------------------
    // No se repite en las 2..n a propósito. Editorialmente, una franja a sangre dice "acá empieza un
    // documento"; repetida ocho veces dice "acá empiezan ocho documentos". Y técnicamente un `thead`
    // repetido no puede sangrar al margen del papel: el margen lo pone `@page` y nada del flujo
    // entra ahí. En las páginas siguientes el documento se identifica por el encabezado corrido.
    // Absoluta y anclada al borde: sangra sobre el margen superior de la PRIMERA página, que es
    // donde la franja dice «acá empieza un documento». En el flujo normal quedaría debajo del
    // encabezado corrido, leyéndose como un separador cualquiera.
    ".franja{position:absolute;top:0;left:0;right:0;height:4mm}",

    // --- Zona 0 · identidad (sólo primera página) ----------------------------------------------
    // `center` y no `flex-start`: sin el nombre del barrio en texto, a los costados del logo queda un
    // solo renglón de cada lado, y alineados arriba flotaban contra 20 mm de caja.
    `.zona0{display:flex;gap:5mm;align-items:center;padding:3mm 0 2.5mm;border-bottom:.4pt solid ${tinta.hairline}}`,
    `.logo{width:auto;max-width:45mm;height:20mm;flex:0 0 auto;display:flex;align-items:center;background:${tinta.paper}}`,
    ".logo img{max-width:45mm;max-height:20mm;object-fit:contain}",
    `.logotipo{display:flex;align-items:center;justify-content:center;width:45mm;height:20mm;flex:0 0 auto;color:${tinta.paper};font-weight:600;font-size:${fp.xl}pt;line-height:1.2;text-align:center;padding:2mm}`,
    ".identidad{min-width:0;flex:1 1 auto}",
    `.emisor{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.25}`,
    `.identidad-der{flex:0 0 auto;text-align:right;font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.3}`,

    // --- Zona P · la capa "sin zoom" de un multipágina (período/corte, fecha de corte) ---------
    // 18 pt y no 10: es lo que un lector tiene que poder leer sin zoom en un teléfono, y en estos
    // documentos es la fecha a la que están medidas las cifras — no el importe, que nadie paga.
    ".zona-p{display:flex;gap:10mm;margin-top:4mm}",
    `.zona-p .et{font-size:${fp.lg}pt;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:${tinta.textSecondary};line-height:1.2}`,
    `.zona-p .v{font-size:${fp["2xl"]}pt;font-weight:700;line-height:1.15}`,

    // --- Rótulos de sección --------------------------------------------------------------------
    `.seccion{margin-top:5mm}`,
    `.rotulo{font-size:${fp.lg}pt;font-weight:600;text-transform:uppercase;letter-spacing:.045em;line-height:1.2;break-after:avoid}`,
    `.definicion{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.25;margin:.4mm 0 1.6mm;break-after:avoid}`,

    // --- Bandas: el mismo componente de la boleta, un punto más chico --------------------------
    // Doc 09 §E.4.1 las fija en 14 pt porque son la capa "sin zoom" de la boleta. Acá la capa sin
    // zoom es otra (el período/corte y la cifra que titula), así que a 14 pt las bandas gritan.
    `.banda{display:flex;align-items:center;gap:2mm;border:.4pt solid ${tinta.hairline};border-left-width:1.2mm;border-left-color:${tinta.textSecondary};padding:1mm 2.5mm;font-size:${fp.lg}pt;line-height:1.2;break-inside:avoid}`,
    ".banda .t{font-weight:600;text-transform:uppercase;letter-spacing:.03em}",
    `.banda .d{font-size:${fp.base}pt;font-weight:400}`,

    // --- Renglones con guía de puntos (el patrón de la zona 2 de la boleta) --------------------
    `.renglones{width:100%;border-collapse:collapse;font-size:${fp.base}pt;line-height:1.25}`,
    ".renglones td{padding:.35mm 0;vertical-align:baseline}",
    ".renglones tr{break-inside:avoid}",
    ".renglones td.imp{text-align:right;width:38mm;white-space:nowrap}",
    ".renglones .lin{display:flex;align-items:baseline;gap:2mm}",
    `.renglones .lin .guia{flex:1 1 auto;border-bottom:.4pt dotted ${tinta.hairline};transform:translateY(-.8mm)}`,
    `.renglones .lin .aclara{font-size:${fp.xs}pt;color:${tinta.textSecondary};white-space:nowrap}`,
    `.renglones tr.subtotal td{border-top:.4pt solid ${tinta.hairline};font-weight:700;padding-top:1mm}`,
    // El renglón que **concluye**: encajonado con filete de 0,8 pt arriba y abajo, sin fondo y sin
    // trama. Un fondo grita "error del sistema" y la administración pide sacarlo; dos filetes dicen
    // "esta línea es una conclusión". Y 0,8 se distingue de 0,4 después de una fotocopia; 0,6 no.
    `.renglones tr.conclusion td{border-top:${printPatron.conclusionFilete}pt solid ${tinta.textPrimary};border-bottom:${printPatron.conclusionFilete}pt solid ${tinta.textPrimary};font-weight:700;padding:1mm 0}`,

    // --- Tablas largas -------------------------------------------------------------------------
    `.tabla{width:100%;border-collapse:collapse;font-size:${fp.sm}pt;line-height:1.25}`,
    ".tabla > thead{display:table-header-group}",
    // **El `tfoot` NO se repite, y es lo contrario de lo que hace el `thead`.** Un encabezado
    // repetido rotula columnas: es verdadero en todas las páginas. Un pie repetido afirma un
    // **total**, y en la página 1 de un cuadro de doce rubros ese total aparece debajo de cinco
    // filas — con las barras de participación al lado, se lee como si esos cinco sumaran los 180
    // millones. Es la regla dura del proyecto (CLAUDE.md §1.4) rota por un default del navegador.
    //
    // `table-row-group` lo saca del grupo repetido y lo deja **una sola vez, al final de verdad** de
    // la tabla. Y no se pone un subtotal parcial en su lugar: el HTML no sabe dónde va a caer el
    // corte de página, así que la única cifra que se podría imprimir ahí sería inventada o el mismo
    // total con otro nombre. La continuidad la declara el `thead` repetido, que sí es verdadero.
    ".tabla > tfoot{display:table-row-group}",
    `.tabla th{font-size:${fp.xs}pt;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:${tinta.textSecondary};text-align:left;border-bottom:.4pt solid ${tinta.hairline};padding:0 0 .8mm;vertical-align:bottom}`,
    `.tabla td{padding:.5mm 0;border-bottom:.4pt solid ${tinta.hairlineSoft};vertical-align:top}`,
    // Sin zebra striping (doc 09 §E.7.1): un fondo al 8 % fotocopiado sale sucio y al 4 % desaparece,
    // así que en los dos casos deja de agrupar y sólo ensucia. Agrupa un filete cada N filas.
    `.tabla tr.grupo td{border-bottom-color:${tinta.hairline}}`,
    ".tabla tr{break-inside:avoid}",
    ".tabla .num{text-align:right;white-space:nowrap;padding-left:3mm}",
    `.tabla .sub{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.2;padding-left:16mm}`,
    `.tabla tfoot td{border-top:.4pt solid ${tinta.textPrimary};border-bottom:none;font-weight:700;padding-top:1mm}`,

    // --- Dato pendiente: el patrón que hace que un hueco se lea deliberado ---------------------
    // La palabra en minúscula, en la sans (nunca la monoespaciada, nunca `$`, nunca `0,00`, nunca un
    // guion), alineada a la derecha como el número que reemplaza, sobre la trama de 45°.
    `.pendiente{background:${printPatron.pendienteFondo};border-bottom:.6pt dotted ${printPatron.pendienteSubrayado};` +
      `color:${tinta.textSecondary};font-family:${familiaSans(fuentes)};font-style:italic;` +
      `padding:.2mm 1.4mm;white-space:nowrap;display:inline-block}`,
    `.no-aplica{color:${tinta.textSecondary};text-align:right}`,
    `.recuento{font-size:${fp.xs}pt;color:${tinta.textSecondary};margin-top:1mm;line-height:1.25}`,
    `.notas{font-size:${fp.xs}pt;color:${tinta.textSecondary};margin-top:2mm;line-height:1.3}`,
    ".notas div{margin-top:.5mm}",

    // --- Cifra que titula un documento que nadie paga ------------------------------------------
    ".titular-doc{margin:4mm 0}",
    `.titular-doc .et{font-size:${fp.lg}pt;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:${tinta.textSecondary}}`,
    `.titular-doc .monto{font-size:${fp["3xl"]}pt;font-weight:700;line-height:1.1;display:flex;align-items:center;gap:2mm}`,
    `.titular-doc .denominador{font-size:${fp.base}pt;color:${tinta.textSecondary};line-height:1.3}`,
    ".titular-doc .glifo{width:5mm;height:5mm}",
  ].join("");
}

// --- Piezas de markup compartidas ---------------------------------------------------------------

/** La caja del logo o su reemplazo tipográfico (doc 09 §E.9.2). Idéntica a la de la boleta. */
export function marcaDelBarrio(marca: MarcaDocumento): string {
  const { barrio } = marca;
  return barrio.logo === null
    ? `<div class="logotipo" style="background:${barrio.acentoHex}">${escapar(barrio.nombre.toUpperCase())}</div>`
    : `<div class="logo"><img src="${barrio.logo.dataUri}" alt="${escapar(barrio.nombre)}" style="max-width:${barrio.logo.anchoMaxMm}mm;max-height:${barrio.logo.altoMaxMm}mm"></div>`;
}

/** Los datos del emisor: **dato legal**, no elemento de marca (doc 09 §E.9.0). Letra chica. */
export function datosDelEmisor(marca: MarcaDocumento): string {
  return [
    `Administra: ${escapar(marca.emisor.razonSocial)}`,
    marca.emisor.cuit ? `CUIT ${escapar(marca.emisor.cuit)}` : null,
    marca.emisor.domicilio ? escapar(marca.emisor.domicilio) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

/**
 * Zona 0: identidad completa. **Sólo en la primera página.**
 *
 * La caja de logo cuesta 20 mm por página, y el logo responde "¿de quién es esto?" una vez: después
 * esa pregunta la contesta el encabezado corrido. El CUIT y el domicilio son dato legal obligatorio
 * **una vez** en el documento, no una vez por hoja.
 *
 * **Acá NO va el nombre del barrio en texto, y eso no rompe §E.9.0.** En un multipágina el
 * encabezado corrido ya abre cada hoja con el nombre del barrio en negrita, tres milímetros arriba
 * de esta caja: repetirlo acá en 12 pt producía el tartamudeo que se veía en el papel — "Las
 * Corzuelas / Las Corzuelas" con el logo en el medio. Los dos niveles de marca siguen enteros: el
 * **barrio** lo sostienen el logo (20 mm) y esa línea en negrita —y cuando el barrio no tiene logo,
 * `marcaDelBarrio()` compone el logotipo tipográfico **con el nombre del barrio adentro**, así que
 * nunca desaparece—; la **administración** sigue en letra chica como emisor legal. La boleta, que no
 * tiene encabezado corrido, conserva el nombre en 12 pt junto al logo tal como manda §E.9.0.
 */
export function cabeceraDeIdentidad(marca: MarcaDocumento, derecha: readonly string[]): string {
  const emisor = datosDelEmisor(marca);
  // La columna derecha no repite nada que el renglón del emisor ya diga. El caso que lo motivó es
  // frecuente y no es un error de carga: cuando la administración funciona en el barrio, el domicilio
  // del barrio **es** el del emisor, y la cabecera lo imprimía dos veces en la misma banda.
  const der = derecha.filter((l) => l.trim() !== "" && !emisor.includes(l));
  return [
    '<header class="zona0" data-desborde="identidad">',
    marcaDelBarrio(marca),
    `<div class="identidad"><div class="emisor">${emisor}</div></div>`,
    `<div class="identidad-der">${der.map((l) => `<div>${l}</div>`).join("")}</div>`,
    "</header>",
  ].join("");
}

/** Lo que hace interpretable **una hoja suelta** arrancada de la carpeta. */
export type EncabezadoCorrido = {
  readonly barrio: string;
  /** "Informe mensual" · "Estado de saldos pendientes". Va en versalitas. */
  readonly documento: string;
  /** "Período 05/2026". `null` en documentos que no son de un período. */
  readonly periodo: string | null;
  readonly corte: string;
  /**
   * De qué están medidas las cifras de esta página: "Devengado", "Percibido", "Saldos al corte".
   * **Es el que todos se olvidan**, y sin él una hoja suelta de columnas de dinero no se puede leer
   * — más todavía en un documento donde conviven los dos criterios.
   */
  readonly criterio: string;
  /**
   * Fecha de emisión, o `null` si el documento **todavía no se emitió**.
   *
   * El estado sin emitir se dice **acá**, junto al resto de los metadatos del documento y en todas
   * las páginas. Antes salía como un `Sin emitir` suelto arriba a la derecha del bloque del logo,
   * donde no tenía con qué contrastar: pegado a la razón social y a la figura jurídica se leía como
   * un dato del emisor —"esta administración no emite"— y no como lo que es, el estado de esta hoja.
   */
  readonly emitido: string | null;
  /** Aclaraciones que una hoja suelta necesita tanto como la primera (desfasaje, alcance). */
  readonly advertencias: readonly string[];
};

export function encabezadoCorrido(e: EncabezadoCorrido): string {
  const l1 = [
    `<span>${escapar(e.barrio)}</span>`,
    `<span class="doc-tipo">${escapar(e.documento)}</span>`,
    e.periodo === null ? null : `<span class="cifra">${escapar(e.periodo)}</span>`,
    `<span class="cifra">Corte ${escapar(e.corte)}</span>`,
  ].filter((x): x is string => x !== null);
  // **Sin `Administra:`.** El emisor es dato legal y va una vez, en el bloque de identidad de la
  // primera página; acá no cumplía ninguna función de hoja suelta —una hoja se identifica por su
  // barrio, no por quién la administra— y empujaba esta línea a un tercer renglón en cada página.
  const l2 = [
    "Importes en pesos",
    escapar(e.criterio),
    ...e.advertencias.map(escapar),
    e.emitido === null ? "Documento sin emitir" : `Emitido ${escapar(e.emitido)}`,
  ];
  return (
    '<div class="corrido">' +
    `<div class="l1">${l1.join("")}</div>` +
    `<div class="l2">${l2.map((x) => `<span>${x}</span>`).join("")}</div>` +
    "</div>"
  );
}

/**
 * Pie corrido. La izquierda repite barrio · documento · corte **a propósito**: una hoja fotocopiada
 * con el margen superior cortado sigue diciendo de qué es.
 */
export function pieCorrido(izquierda: string): string {
  return (
    '<div class="pie">' +
    `<span>${escapar(izquierda)}</span>` +
    '<span class="folio cifra"></span>' +
    "</div>"
  );
}

/**
 * El cierre de un documento de la familia: los huecos declarados, las notas, las leyendas y el pie
 * del emisor, en ese orden.
 *
 * Estaba copiado en las dos plantillas y **ya había divergido**: la copia del informe condicionaba
 * el bloque entero a que hubiera `leyendas`, así que un documento sin leyendas se llevaba puesto el
 * pie legal del emisor. Cada trozo se imprime si tiene algo que decir, y ninguno depende de otro.
 */
export function cierreDelDocumento(v: {
  readonly notas: readonly { readonly marcador: number; readonly texto: string }[];
  readonly leyendas: readonly string[];
  readonly marca: MarcaDocumento;
}): string {
  const bloque = (lineas: readonly string[]) =>
    lineas.length === 0 ? "" : `<div class="notas">${lineas.map((l) => `<div>${l}</div>`).join("")}</div>`;
  return [
    huecosDeclarados(v),
    bloque(v.notas.map((n) => `(${n.marcador}) ${escapar(n.texto)}`)),
    bloque([...v.leyendas, ...v.marca.pie].map(escapar)),
  ].join("");
}

/**
 * El resumen de lo que el documento **no tiene**, al pie y en criollo.
 *
 * Sale de recorrer la vista entera con `motivosFaltantes()`, así que no hay una lista escrita a mano
 * que pueda quedar desactualizada respecto de lo que se imprimió: el día que el dato exista, el
 * renglón desaparece solo. Deduplicado, porque un mismo motivo repetido en cien filas es **un**
 * hueco y no cien — y el recuento es lo que separa un documento que declara lo que le falta de una
 * hoja que parece rota.
 */
export function huecosDeclarados(vista: unknown): string {
  const motivos = motivosFaltantes(vista);
  if (motivos.length === 0) return "";
  return (
    '<div class="notas">' +
    `<div><strong>Qué falta cargar (${motivos.length}):</strong></div>` +
    motivos.map((m) => `<div>· ${escapar(m)}</div>`).join("") +
    "</div>"
  );
}

/** La franja de acento, a sangre y sólo en la primera página. Va **fuera** de la tabla de la hoja. */
export function franjaDeAcento(marca: MarcaDocumento): string {
  return `<div class="franja" style="background:${marca.barrio.acentoHex}"></div>`;
}

/** Cómo se nombra la figura jurídica en el papel. El enum crudo (`sa`) no se imprime nunca. */
export const ETIQUETA_FIGURA: Record<string, string> = {
  ph_especial: "Propiedad horizontal especial",
  sa: "Sociedad anónima",
  asociacion_civil: "Asociación civil",
  fideicomiso: "Fideicomiso",
};

/** Envuelve el contenido en la tabla que hace que el encabezado y el pie se repitan por página. */
export function hojaConCorridos(encabezado: string, pie: string, contenido: string): string {
  return (
    '<table class="hoja">' +
    `<thead><tr><td>${encabezado}</td></tr></thead>` +
    `<tfoot><tr><td>${pie}</td></tr></tfoot>` +
    `<tbody><tr><td>${contenido}</td></tr></tbody>` +
    "</table>"
  );
}

// --- Celdas: los cuatro estados de un dato ------------------------------------------------------

/**
 * Los cuatro estados de una celda, y lo que hace que no se confundan entre sí:
 *
 * | Se imprime | Significa |
 * |---|---|
 * | `1.234,56` en monoespaciada | medido |
 * | `0,00` en monoespaciada | **medido y da cero** |
 * | `—` | **no aplica** a este barrio o período |
 * | `pendiente` sobre trama, con marcador | **existe y todavía no está cargado** |
 *
 * `s/d` queda prohibido: es críptico y se confunde con "sin deuda".
 */
export function celdaCifra(valor: { readonly texto: string } | DatoFaltante, marcador: number | null): string {
  if (esFaltante(valor)) {
    return `<span class="pendiente">pendiente${marcador === null ? "" : ` (${marcador})`}</span>`;
  }
  return `<span class="cifra">${escapar(valor.texto)}</span>`;
}

/** Un dato que no aplica. Nunca un cero: un cero afirma que se midió. */
export const NO_APLICA = '<span class="no-aplica">—</span>';

/**
 * Recuento de pendientes al pie de una sección.
 *
 * **Es el elemento que separa "deliberado" de "roto".** Un lector que ve el recuento sabe que la
 * omisión la midió alguien; sin recuento, el mismo hueco se lee como una falla del software.
 */
export function recuentoPendientes(pendientes: number, total: number): string {
  if (pendientes === 0) return "";
  return `<div class="recuento">${pendientes} de ${total} renglones sin dato al cierre. El total no los incluye.</div>`;
}
