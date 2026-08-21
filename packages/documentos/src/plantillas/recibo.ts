/**
 * La plantilla del recibo: `VistaRecibo` → HTML.
 *
 * **Reusa el mismo andamiaje de impresión que la boleta, no lo reinventa.** Mismas opciones de
 * `page.pdf()` (las pone el adapter, sin cambios: `crearGeneradorChromium` no distingue de qué
 * plantilla vino un `DocumentoSolicitado`), mismos márgenes base (`MARGENES_BOLETA_MM`, en
 * `emision-recibo.ts`), misma familia tipográfica y los mismos tokens de `@admin-barrios/design-tokens`
 * (`fontSizePrint`, `printInk`). Lo que cambia es el **contenido**: un recibo es una sola operación ya
 * ocurrida, no una liquidación con líneas variables, así que no hay zona de detalle elástica, ni
 * cupón, ni instrumento de pago — eso es lo que la boleta ofrece para que alguien pague; el recibo
 * solo confirma que ya se pagó.
 *
 * Reglas que este archivo no puede romper (mismas que `boleta.ts`):
 *
 *  - **No formatea dinero ni fechas.** Todo llega ya resuelto en la `VistaRecibo`; acá solo se
 *    imprime `.texto`.
 *  - **No emite ninguna URL externa.** La red está apagada en el renderizador.
 *  - **No inventa tamaños ni tintas.** Salen de `@admin-barrios/design-tokens`. El acento del barrio
 *    es la única excepción y va inline, nunca en el CSS.
 *  - **`4xl` (32 pt) queda exclusivo del TOTAL A PAGAR de la boleta** (`fontSizePrint`, comentario en
 *    el token). El importe recibido usa `3xl`, la misma categoría que "la cifra que titula un
 *    documento que nadie paga" en el informe mensual y el listado de saldos — un recibo no es un
 *    instrumento de cobro, es la constancia de que ya se cobró.
 */

import { fontSizePrint as fp, printInk as tinta } from "@admin-barrios/design-tokens";
import type { VistaRecibo } from "@admin-barrios/shared/documentos";
import type { OrigenPago } from "@admin-barrios/shared/cobros";
import { bloqueFuentes, escapar, familiaSans, type FuenteEmbebida } from "./comun.ts";
import { acentoTenue, inicialesDelBarrio } from "./boleta.ts";

// `escapar`, `fuenteEmbebidaSchema`, `PILA_MONO`, `PILA_SANS` y `FuenteEmbebida` NO se re-exportan
// acá: `boleta.ts` ya los re-exporta desde `comun.ts`, y los dos archivos conviven en el mismo
// barrel (`packages/documentos/src/index.ts`) — un segundo `export` del mismo nombre es un choque
// de módulos, no una redundancia inofensiva.

/** Cómo se nombra cada origen en el papel. El valor crudo (`manual`) no se imprime nunca. */
const ETIQUETA_ORIGEN: Record<OrigenPago, string> = {
  manual: "Carga manual",
  extracto: "Extracto bancario",
};

/**
 * CSS del documento. Se emite **una sola vez por lote**, mismo motivo que la boleta (ADR-0001 §2.2):
 * el *subsetting* de fuentes se paga una vez, no una por recibo.
 */
/** A5, en mm — la mitad exacta de un A4 (recorte natural si algún día se imprimen dos por hoja). */
const PAGINA_MM = { ancho: 148, alto: 210 } as const;

export function estilosRecibo(fuentes: readonly FuenteEmbebida[] = []): string {
  const sans = familiaSans(fuentes);
  return [
    bloqueFuentes(fuentes),
    /*
     * **El tamaño de página es A5, no A4 — y esto NO toca el generador compartido con la boleta.**
     *
     * `crearGeneradorChromium()` llama a `page.pdf()` con `preferCSSPageSize: true`: cuando ese flag
     * está activo, Chromium usa el `@page{size:...}` que declare el CSS del documento y **ignora**
     * el `format` que le pasó el adapter. `cssDeMargenes()` ya inyecta `@page{size:A4;margin:0}` en
     * el mismo bloque `<style>`, antes de estos estilos; como es la MISMA regla `@page` sin selector
     * nombrado, CSS la resuelve en cascada por propiedad — este `size` de acá gana (viene después),
     * y el `margin:0` de `cssDeMargenes()` sigue intacto. Nada en `generador.ts` ni en
     * `chromium.ts` se toca.
     *
     * Un recibo es un talón de una sola operación, no una liquidación — forzarlo a un A4 completo
     * dejaba la hoja mayormente vacía sin importar cómo se acomodara el contenido adentro.
     *
     * ⚠ **`DocumentoSolicitado.formato` sigue diciendo `"A4"`** (`emision-recibo.ts`): es un
     * `z.literal("A4")` en el esquema del generador, compartido con toda la familia, y no es este
     * archivo el lugar para tocarlo. El tamaño físico real de la hoja lo decide este `@page`, no ese
     * campo — que para el recibo queda, a partir de acá, puramente nominal.
     */
    `@page{size:${PAGINA_MM.ancho}mm ${PAGINA_MM.alto}mm}`,
    // Los márgenes llegan como variables desde `cssDeMargenes(doc.margenesMm)` — mismo mecanismo que
    // la boleta, mismos números (`MARGENES_BOLETA_MM`): la plantilla no conoce el milímetro exacto.
    "*{box-sizing:border-box}",
    `html,body{margin:0;padding:0;background:${tinta.paper};color:${tinta.textPrimary};font-family:${sans};font-size:${fp.base}pt;line-height:1.4;-webkit-print-color-adjust:exact;print-color-adjust:exact}`,
    /*
     * Un recibo = una página A5. Mismo mecanismo de la boleta para el salto entre documentos
     * (`page-break-after` después de cada artículo menos el último), pero **centrado verticalmente**
     * y no anclado arriba: `justify-content:center` reparte el aire sobrante arriba y abajo de la
     * tarjeta por igual, en vez de dejarlo todo al pie. Un recibo compacto centrado en la hoja se lee
     * como una constancia depositada a propósito; anclado arriba se lee como un documento que arranca
     * y se corta.
     *
     * `padding` lleva `var(--m-top)` explícito (a diferencia de la boleta, que lo deja en `0` porque
     * ahí lo repone la franja de acento a sangre): este recibo NO lleva franja — ver el comentario de
     * `cabecera()` sobre por qué se sacó — así que el margen superior real de la página lo tiene que
     * poner el propio `padding`, no una franja que ya no existe.
     */
    `.recibo{position:relative;display:flex;flex-direction:column;justify-content:center;width:${PAGINA_MM.ancho}mm;height:${PAGINA_MM.alto}mm;padding:var(--m-top) var(--m-right) var(--m-bottom) var(--m-left);overflow:hidden;page-break-after:always;break-after:page}`,
    ".recibo:last-of-type{page-break-after:auto;break-after:auto}",
    ".recibo > *{flex:0 0 auto}",
    ".cifra{font-variant-numeric:tabular-nums;white-space:nowrap}",

    /*
     * --- La tarjeta: contiene TODO el contenido, en vez de dejarlo flotando en la hoja ----------
     *
     * Un recibo dice mucho menos que una boleta, y la hoja A5 entera queda casi vacía debajo. Sin
     * un borde que la contenga, ese vacío se lee como "documento a medio hacer" — con la tarjeta,
     * el vacío pasa a ser el margen alrededor de una constancia completa, que es justo lo que un
     * recibo de papel real transmite (una hoja chica, con aire, no un formulario sin terminar).
     * Sin `margin-top` fijo: el centrado vertical de `.recibo` ya la ubica, un margen fijo acá
     * competiría con eso y la empujaría hacia abajo del centro real.
     */
    `.tarjeta{border:.6pt solid ${tinta.hairline};border-radius:2mm;padding:8mm}`,

    // --- Zona 0 · identidad: mismo sello de 16 mm que la boleta, misma caja fija ----------------
    `.zona0{flex:0 0 18mm;display:flex;gap:5mm;align-items:flex-start;overflow:hidden;border-bottom:.4pt solid ${tinta.hairline};padding-bottom:2mm}`,
    `.sello{width:16mm;height:16mm;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border:.6pt solid;border-radius:3mm;font-size:${fp.lg}pt;font-weight:700;letter-spacing:.02em}`,
    `.logo{width:auto;max-width:45mm;height:16mm;flex:0 0 auto;display:flex;align-items:center;background:${tinta.paper}}`,
    ".logo img{max-width:45mm;max-height:16mm;object-fit:contain}",
    ".identidad{min-width:0;flex:1 1 auto}",
    `.barrio-nombre{font-size:${fp.xl}pt;font-weight:700;line-height:1.15}`,
    `.emisor{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.3;margin-top:.6mm}`,
    `.identidad-der{flex:0 0 auto;margin-left:auto;text-align:right;font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.5}`,
    `.identidad-der .doc-tipo{display:block;color:${tinta.textPrimary};font-size:${fp.sm}pt;font-weight:600;letter-spacing:.03em;text-transform:uppercase}`,

    // --- El cuerpo: quién pagó, cuánto, y qué unidad --------------------------------------------
    ".cuerpo{flex:0 0 auto;padding-top:6mm}",
    `.rotulo{font-size:${fp.xs}pt;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:${tinta.textSecondary};line-height:1.2}`,
    `.destinatario{font-size:${fp.lg}pt;font-weight:600;line-height:1.3;margin-top:1mm}`,
    `.destinatario .unidad-sub{font-weight:400;color:${tinta.textSecondary}}`,

    // La cifra que titula el documento — `3xl`, nunca `4xl` (ver el docstring de arriba).
    ".importe{margin-top:6mm}",
    `.importe .monto{display:flex;align-items:baseline;gap:2mm;font-size:${fp["3xl"]}pt;font-weight:700;line-height:1.15;letter-spacing:-.01em}`,
    `.importe .signo{font-size:${fp.xl}pt;font-weight:700}`,

    // Tres datos, en un renglón con guía de puntos — mismo lenguaje visual que la boleta y el resto
    // de la familia (`comun.ts`), reescrito acá porque el recibo no arrastra el resto del CSS de
    // `estilosBoleta()` (bandas, gráfico, cupón) que no le hace falta.
    ".datos{margin-top:7mm;border-top:.4pt solid " + tinta.hairline + ";padding-top:3mm}",
    `.datos .fila{display:flex;align-items:baseline;gap:2mm;font-size:${fp.base}pt;line-height:1.5;padding:.8mm 0;border-bottom:.3pt dotted ${tinta.hairline}}`,
    `.datos .fila .et{flex:0 0 auto;width:38mm;color:${tinta.textSecondary};font-size:${fp.xs}pt;text-transform:uppercase;letter-spacing:.04em}`,
    ".datos .fila .val{flex:1 1 auto;min-width:0;font-weight:600}",

    // --- Leyendas y pie legal, igual que el resto de la familia ---------------------------------
    // Sin `margin-top:auto`: ver el comentario de `.tarjeta` — ya no hace falta empujar nada al
    // fondo de la hoja, la tarjeta mide lo que su contenido pide.
    `.leyendas{margin-top:6mm;padding-top:4mm;border-top:.4pt solid ${tinta.hairline};font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.35}`,
    ".leyendas div{margin-top:.5mm}",
  ].join("");
}

// --- El cuerpo -----------------------------------------------------------------------------------

/*
 * **Sin franja de acento a sangre — se sacó, no se olvidó.** El primer borrador la copiaba de la
 * boleta (`franjaDeAcento()`/`.franja`) sin pensar de nuevo su función acá, y quedó como una banda
 * sólida separada de todo, sin ningún elemento que explicara qué es. En la boleta la franja cumple
 * un rol concreto: "acá empieza un documento", pegada directamente a la zona 0, reforzando que la
 * identidad de abajo es la primera cosa de la hoja. Acá la tarjeta está CENTRADA verticalmente
 * (ver `.recibo{justify-content:center}`), así que la franja quedaría flotando separada de la
 * tarjeta por el margen superior — pierde la conexión visual que le daba sentido en la boleta y no
 * gana ninguna otra. La identidad de marca del barrio sigue presente igual, en el color del sello
 * (`acentoTenue`/`inicialesDelBarrio`, abajo): no hace falta un segundo elemento para lo mismo.
 */

function cabecera(v: VistaRecibo): string {
  const { barrio, emisor } = v.marca;
  const marcaBarrio =
    barrio.logo === null
      ? `<div class="sello" style="color:${barrio.acentoHex};border-color:${barrio.acentoHex};background:${acentoTenue(barrio.acentoHex)}">` +
        `${escapar(inicialesDelBarrio(barrio.nombre))}</div>`
      : `<div class="logo"><img src="${barrio.logo.dataUri}" alt="${escapar(barrio.nombre)}" style="max-width:${barrio.logo.anchoMaxMm}mm;max-height:${barrio.logo.altoMaxMm}mm"></div>`;

  const datosEmisor = [
    `Administra: ${escapar(emisor.razonSocial)}`,
    emisor.cuit ? `CUIT ${escapar(emisor.cuit)}` : null,
    emisor.domicilio ? escapar(emisor.domicilio) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");

  return [
    '<header class="zona0" data-desborde="identidad">',
    marcaBarrio,
    '<div class="identidad">',
    `<div class="barrio-nombre">${escapar(barrio.nombre)}</div>`,
    `<div class="emisor">${datosEmisor}</div>`,
    "</div>",
    '<div class="identidad-der">',
    '<span class="doc-tipo">Recibo de pago</span>',
    `N.º <span class="cifra">${escapar(v.recibo.numero)}</span><br>`,
    `Emitido el <span class="cifra">${escapar(v.recibo.fecha.texto)}</span>`,
    "</div>",
    "</header>",
  ].join("");
}

function cuerpo(v: VistaRecibo): string {
  // Sin obligado vinculado, se declara en positivo — nunca se inventa un nombre (`pago.obligado_id`
  // es nullable: la unidad puede no tener uno vigente al momento de registrar el cobro).
  const destinatario =
    v.unidad.destinatario === null
      ? `A nombre de la unidad <span class="unidad-sub">· ${escapar(v.unidad.etiqueta)}</span>`
      : v.unidad.rolDestinatario
        ? `${escapar(v.unidad.destinatario)} — ${escapar(v.unidad.rolDestinatario)} ` +
          `<span class="unidad-sub">· ${escapar(v.unidad.etiqueta)}</span>`
        : `${escapar(v.unidad.destinatario)} <span class="unidad-sub">· ${escapar(v.unidad.etiqueta)}</span>`;

  const fila = (etiqueta: string, valor: string) =>
    `<div class="fila"><span class="et">${escapar(etiqueta)}</span><span class="val">${valor}</span></div>`;

  return [
    '<section class="cuerpo">',
    '<div class="rotulo" data-sin-marca>Recibí de</div>',
    `<div class="destinatario">${destinatario}</div>`,
    '<div class="importe" data-desborde="importe">',
    '<div class="rotulo" data-sin-marca>Importe recibido</div>',
    '<div class="monto cifra">' +
      '<span class="signo">$</span>' +
      `<span class="valor">${escapar(v.pago.monto.texto)}</span>` +
      "</div>",
    "</div>",
    '<div class="datos">',
    fila("Fecha del pago", `<span class="cifra">${escapar(v.pago.fecha.texto)}</span>`),
    fila("Unidad", `<span class="cifra">${escapar(v.unidad.etiqueta)}</span>`),
    fila("Origen del registro", escapar(ETIQUETA_ORIGEN[v.pago.origen])),
    "</div>",
    "</section>",
  ].join("");
}

function pie(v: VistaRecibo): string {
  const lineas = [...v.leyendas, ...v.marca.pie];
  if (lineas.length === 0) return "";
  return `<div class="leyendas">${lineas.map((l) => `<div>${escapar(l)}</div>`).join("")}</div>`;
}

/** Arma el `<article>` del recibo. Un `DocumentoSolicitado` por recibo (`emision-recibo.ts`). */
export function cuerpoRecibo(v: VistaRecibo): string {
  return `<article class="recibo"><div class="tarjeta">${cabecera(v)}${cuerpo(v)}${pie(v)}</div></article>`;
}
