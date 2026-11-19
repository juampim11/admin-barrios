/**
 * La plantilla de la boleta: `VistaBoleta` → HTML.
 *
 * **Una sola plantilla para PDF, email HTML y vista web** (ADR-0001 §3, fundamento 1). Es el mismo
 * markup, así que los tres dicen lo mismo por construcción y no por disciplina.
 *
 * Reglas que este archivo NO puede romper:
 *
 *  - **No formatea dinero ni fechas.** Todo llega ya resuelto en la `VistaBoleta`; acá solo se
 *    imprime `.texto`. Es lo que hace imposible el bug de ICU (doc 07 §A). La única excepción es el
 *    **nombre del mes**, que sale de `nombreDelPeriodo()` de `@admin-barrios/shared/fechas` sobre el
 *    código del período (sin `Intl`, igual que el resto de las fechas del producto).
 *  - **No tiene un `if` por banco.** Recorre `bloquePago.instrumentos` y pinta (ADR-0001 §4.4).
 *  - **No emite ninguna URL externa.** La red está apagada en el renderizador: una imagen por URL
 *    saldría en blanco y una hoja de estilo remota es la superficie de SSRF que el ADR §3.2 cierra.
 *  - **No estampa la marca de agua.** Eso lo hace el renderizador, no la plantilla (ADR-0001 §10).
 *  - **No inventa tamaños ni tintas.** Salen de `@admin-barrios/design-tokens` (`fontSizePrint`,
 *    `printInk`, `light`). El **acento del barrio** es la única excepción y entra **inline**, como la
 *    variable `--acento` del `<article>`: es dato del barrio, no diseño, y el CSS solo la nombra.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ IMPLEMENTA (encargo 16c, BL-046)
 *
 * **La maqueta aprobada `maquetas/boleta-nueva.html`** de la coordinación, portada y no parcheada
 * (un mock aprobado se porta: acercar la hoja vieja zona por zona no converge). Es el diseño del
 * aviso de cuota de Aclade, no su marca: una hoja A4, **sin talón troquelado**, con el cupón que
 * cobra solo el mes y la deuda de meses anteriores aparte, mes por mes.
 *
 * El orden de la hoja es el de la maqueta: cabecera → emisor → recuadro de la unidad → bloque grande
 * «total a pagar / vence el» → conceptos del mes → deuda de meses anteriores → cómo pagar → pie.
 *
 * Las diferencias deliberadas contra la maqueta están anotadas donde ocurren con la palabra
 * **DIFERENCIA**, para encontrarlas de un grep. En resumen:
 *
 *  1. **La composición del gasto existe** en un barrio que prorratea (gasto del barrio × coeficiente,
 *     con la barra G-8). La maqueta es un barrio de cuota fija y no la tiene; sin ella, en un barrio
 *     que reparte, el importe del mes no se explicaría con su origen (regla dura 4).
 *  2. **Sin `$` en las columnas de importes.** La cadena de dinero se imprime idéntica a la del
 *     modelo (`-15.000,00`, no `− $ 15.000,00`): el `$` va donde la cifra viaja sola.
 *  3. **El saldo y el interés no se omiten** cuando el cupón los cobra (doc 07 §B): van como
 *     renglones de los conceptos o, si la deuda viene mes por mes, en la fila «Total adeudado» de su
 *     tabla. Con «solo el mes» al día se dice «No registra deuda de meses anteriores» en vez de callar.
 *  4. **No se imprime «Cada mes adeudado se paga con su propio cupón… Pedilo a la administración»**
 *     (decisión del encargo 16): promete el cupón de deuda, que todavía no existe.
 *  5. **El N.º de acción y el CUIT del barrio se imprimen solo si vienen**: son opcionales en la vista
 *     (`unidad.numeroAccion`, `barrio.cuit`, con `null` en lo emitido antes) y sin ellos no queda hueco.
 *  6. **El piso de la capa «sin zoom»**: la fecha de vencimiento va en `printMinLegibleTitular`.
 *  7. **Las leyendas legales van en el pie**, en un párrafo, junto a «Consultas» y la emisión: un
 *     bloque propio, una por renglón, no entraba en la hoja de un barrio que prorratea.
 *  8. **Con «el mes más la deuda» la celda «Total» de la fila «Total adeudado» va vacía**: la vista no
 *     trae esa cifra suelta (ya sumó en el total a pagar) y la plantilla no suma dinero.
 *
 * Lo que la hoja vieja tenía y la maqueta no, y por eso se fue: la franja de acento a sangre, las
 * bandas en píldora («al día» y «saldo anterior» los dice la deuda, con su cifra; las demás son
 * avisos), la tarjeta de evolución mensual, el troquel con su tijera y el talón.
 */

import { fontSizePrint as fp, light, printInk as tinta, printMinLegibleTitular } from "@admin-barrios/design-tokens";
import type { BandaEstado, InstrumentoPago, VistaBoleta } from "@admin-barrios/shared/documentos";
import { nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { renderizarSimbolo } from "../simbolos.ts";
import { bloqueFuentes, escapar, familiaSans, PILA_MONO, type FuenteEmbebida } from "./comun.ts";
import { ANCHO_COLUMNA_BARRAS_MM, celdaBarra, estilosGraficos, llevaColumnaDeBarras } from "./graficos.ts";
import { glifoBanda } from "./glifos.ts";

/** Ancho útil de la hoja A4 con los márgenes de doc 09 §E.2.2 (210 − 14 − 14). */
export const ANCHO_UTIL_MM = 182;

/**
 * Las medidas que la hoja fija. La cabecera tiene **alto fijo** (el logo del cliente nunca define la
 * altura de la hoja) y la composición del gasto es la única zona con **tope**: si no entra, el
 * renderizador falla la emisión en vez de recortar una línea de dinero en silencio.
 */
export const PRESUPUESTO_MM = {
  /** Cabecera: logo o iniciales, nombre del barrio y el título del documento. */
  cabecera: 14,
  /** Tope de la composición del gasto (barrios que prorratean). */
  detalle: 56,
  /** Ancho que se le reserva a la cifra grande. De acá sale su cuerpo (`cuerpoDelTotal`). */
  celdaTotal: 76,
} as const;

// El escapado, la validación de fuentes embebidas y la pila tipográfica de reserva viven en
// `comun.ts`: son el sustrato de **toda** la familia de documentos. Se re-exportan desde acá porque
// eran parte de la cara pública de este módulo.
export { escapar, fuenteEmbebidaSchema, PILA_MONO, PILA_SANS, type FuenteEmbebida } from "./comun.ts";

/**
 * Avance de carácter de una monoespaciada, en `em`. La cifra grande va en la sans con `tabular-nums`
 * (~0,55 em por dígito, menos en los separadores), así que estimar con 0,62 queda del lado seguro.
 */
const AVANCE_MONO_EM = 0.62;

/** 1 pt = 25,4/72 mm. */
const MM_POR_PT = 25.4 / 72;

/** Lo que ocupan el `$` (en `2xl`) y su separación, dentro de la celda de la cifra grande. */
const ANCHO_SIGNO_MM = 5.5;

/**
 * Cuerpo de la cifra grande, en pt, para que **entre en su celda**: `4xl` (32 pt) es el techo
 * —doc 09 §E.5.3, la única cifra del producto que alguien paga— y de ahí baja solo lo necesario,
 * nunca por debajo del piso de la capa sin zoom (`printMinLegibleTitular`). Si ni con el piso entra,
 * la guarda de desbordes corta la emisión.
 */
export function cuerpoDelTotal(texto: string, anchoMm: number = PRESUPUESTO_MM.celdaTotal): number {
  const caracteres = Math.max(texto.length, 1);
  const cabeEn = (anchoMm - ANCHO_SIGNO_MM) / (caracteres * AVANCE_MONO_EM * MM_POR_PT);
  return Math.max(printMinLegibleTitular, Math.min(fp["4xl"], Math.floor(cabeEn * 10) / 10));
}

/**
 * Las tintas de los avisos. **El color nunca va solo** (doc 09 §E.8.3): cada aviso lleva su glifo y
 * su palabra, y la hoja en escala de grises dice lo mismo. El texto del aviso va en `textPrimary`
 * sobre el fondo tenue; la tinta de color queda en la barra y en el glifo.
 */
const TINTA_AVISO = {
  critico: { barra: light.danger, fondo: light.dangerSubtle },
  ok: { barra: light.success, fondo: light.successSubtle },
  atencion: { barra: light.warning, fondo: light.warningSubtle },
  info: { barra: tinta.textSecondary, fondo: tinta.hairlineSoft },
} as const;
type TonoAviso = keyof typeof TINTA_AVISO;

/** Qué banda de estado se imprime como aviso, y con qué tono. Las que no están, no se imprimen. */
const AVISO_DE_BANDA: Partial<Record<BandaEstado["clave"], TonoAviso>> = {
  bonificacion_no_aplicada: "critico",
  bonificacion_aplicada: "ok",
  vista_previa: "info",
  interes_pendiente: "atencion",
};

/**
 * CSS del documento. Se emite **una sola vez por lote**: con 200 boletas en una pasada, el
 * *subsetting* de fuentes se paga una vez y no 200 (ADR-0001 §2.2).
 */
export function estilosBoleta(fuentes: readonly FuenteEmbebida[] = []): string {
  const sans = familiaSans(fuentes);
  const p = PRESUPUESTO_MM;
  return [
    bloqueFuentes(fuentes),
    // La barra de participación de la composición del gasto (G-8).
    estilosGraficos(),
    "*{box-sizing:border-box}",
    `html,body{margin:0;padding:0;background:${tinta.paper};color:${tinta.textPrimary};font-family:${sans};font-size:${fp.base}pt;line-height:1.35;-webkit-print-color-adjust:exact;print-color-adjust:exact}`,
    // Una boleta = una página A4. Los márgenes llegan como variables desde `cssDeMargenes()`.
    `.boleta{position:relative;display:flex;flex-direction:column;gap:1.4mm;width:210mm;height:297mm;padding:var(--m-top) var(--m-right) var(--m-bottom) var(--m-left);overflow:hidden;page-break-after:always;break-after:page;font-variant-numeric:tabular-nums}`,
    ".boleta:last-of-type{page-break-after:auto;break-after:auto}",
    ".boleta > *{flex:0 0 auto}",
    ".cifra{font-variant-numeric:tabular-nums;white-space:nowrap}",
    ".glifo{width:3.2mm;height:3.2mm;flex:0 0 auto;display:block;margin-top:.3mm}",

    // --- Rótulos -------------------------------------------------------------------------------
    // Dos, como la maqueta: el rótulo chico que nombra un dato (`.etq`) y el título de sección
    // (`.sec`), en el acento del barrio.
    `.etq{display:block;font-size:${fp.xs}pt;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:${tinta.textSecondary};line-height:1.25}`,
    `.sec{display:block;margin:0 0 1mm;font-size:${fp.sm}pt;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--acento);line-height:1.2}`,

    // --- Cabecera (alto fijo: el logo NUNCA define la altura) ------------------------------------
    `.enc{height:${p.cabecera}mm;display:flex;align-items:center;justify-content:space-between;gap:5mm;border-bottom:1.2pt solid var(--acento);padding-bottom:1.8mm;overflow:hidden}`,
    ".marca{display:flex;align-items:center;gap:3.5mm;min-width:0}",
    // Las iniciales del barrio, cuando no hay logo: el bloque macizo de la maqueta, en su acento. El
    // acento llega normalizado a ≥ 4,5:1 contra blanco, así que el blanco encima también lo da.
    `.sello{width:11mm;height:11mm;flex:0 0 auto;border-radius:2.4mm;background:var(--acento);color:${tinta.paper};display:flex;align-items:center;justify-content:center;font-size:${fp.lg}pt;font-weight:700;letter-spacing:.04em}`,
    ".logo{height:11mm;max-width:45mm;flex:0 0 auto;display:flex;align-items:center;overflow:hidden}",
    ".logo img{max-height:11mm;max-width:45mm;object-fit:contain}",
    ".marca-texto{min-width:0}",
    `.barrio-nombre{font-size:${fp.lg}pt;font-weight:700;line-height:1.2}`,
    `.barrio-sub{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.3}`,
    ".titulo-doc{flex:0 0 auto;text-align:right}",
    `.titulo-doc .mes{font-size:${fp.xl}pt;font-weight:700;color:var(--acento);line-height:1.15;white-space:nowrap}`,
    // El emisor legal, en letra chica pegado a la cabecera (doc 09 §E.9.0).
    `.emisor{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.35;margin-top:-1mm}`,

    // --- Recuadro de la unidad ---------------------------------------------------------------------
    `.ident{display:flex;border:.6pt solid ${tinta.hairline};border-radius:1.5mm;overflow:hidden}`,
    `.ident > div{flex:1 1 0;min-width:0;padding:.8mm 3mm;background:${tinta.hairlineSoft};border-left:.6pt solid ${tinta.hairline}}`,
    ".ident > div:first-child{border-left:none}",
    ".ident > div.ancho{flex:2 1 0}",
    `.ident b{display:block;font-size:${fp.base}pt;font-weight:700;line-height:1.3;overflow-wrap:anywhere}`,

    // --- El bloque grande: total a pagar y vencimiento ----------------------------------------------
    ".pago{display:grid;grid-template-columns:1fr auto;gap:1.5mm 6mm;align-items:end;border:1.2pt solid var(--acento);border-radius:2mm;padding:1.8mm 4.5mm}",
    // Cada celda es su propia caja acotada: si algo no entra, la guarda de desbordes lo ve. El
    // `padding-bottom` no es aire: con 32 pt la mancha del glifo sobresale de su caja de línea.
    ".pago > .celda{min-width:0;overflow:hidden;padding-bottom:.8mm}",
    ".pago .monto{display:flex;align-items:baseline;gap:1.6mm;color:var(--acento);font-weight:700;line-height:1.05;letter-spacing:-.01em}",
    `.pago .signo{font-size:${fp["2xl"]}pt}`,
    ".pago .vence{text-align:right}",
    // **DIFERENCIA con la maqueta (15 px ≈ 10 pt):** la fecha de vencimiento es la capa que se lee
    // sin zoom en un teléfono, y su piso es `printMinLegibleTitular` (doc 09 §E.5.1).
    `.pago .vence .fecha{font-size:${printMinLegibleTitular}pt;font-weight:700;line-height:1.2}`,
    `.pago .aclara{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:1mm 6mm;font-size:${fp.sm}pt;color:${tinta.textSecondary};border-top:.4pt solid ${tinta.hairline};padding-top:1.4mm;line-height:1.3}`,
    `.pago .aclara b{color:${tinta.textPrimary}}`,

    // --- Avisos ----------------------------------------------------------------------------------
    `.aviso{display:flex;gap:2mm;align-items:flex-start;border-left:2.5pt solid;border-radius:0 1.5mm 1.5mm 0;padding:1mm 3mm;font-size:${fp.sm}pt;line-height:1.25;color:${tinta.textPrimary}}`,
    ".aviso + .aviso{margin-top:1.4mm}",
    ".avisos{display:block}",
    ".conceptos-bloque .aviso{margin-top:1.2mm}",
    ...Object.entries(TINTA_AVISO).flatMap(([tono, c]) => [
      `.aviso--${tono}{border-left-color:${c.barra};background:${c.fondo}}`,
      `.aviso--${tono} .glifo{color:${c.barra}}`,
    ]),

    // --- Tablas: conceptos del mes y deuda de meses anteriores ------------------------------------
    ".tabla{width:100%;border-collapse:collapse;line-height:1.2}",
    `.tabla th{font-size:${fp.xs}pt;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:${tinta.textSecondary};text-align:left;padding:0 0 .9mm;border-bottom:.4pt solid ${tinta.hairline}}`,
    `.tabla td{padding:.3mm 0;border-bottom:.4pt solid ${tinta.hairline};vertical-align:top}`,
    ".tabla .num{text-align:right;white-space:nowrap;padding-left:4mm}",
    `.tabla .det{display:block;font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.2}`,
    // Lo que se descuenta, en verde y con su signo: el color acompaña, el `-` es el dato.
    `.tabla tr.resta td.num{color:${light.success}}`,
    `.tabla tr.informativo td{color:${tinta.textSecondary}}`,
    `.tabla tr.subtotal td{border-top:.8pt solid ${tinta.textPrimary};font-weight:700}`,
    `.tabla tr.total td{border-top:.8pt solid ${tinta.textPrimary};border-bottom:none;font-weight:700;font-size:${fp.lg}pt;padding-top:1mm}`,
    `.notas{font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.3;margin-top:.8mm}`,
    `.sin-deuda{margin:0;font-size:${fp.sm}pt;color:${tinta.textSecondary}}`,
    // La deuda de meses anteriores: barra roja a la izquierda, título y total en rojo. Es aparte del
    // cupón, y el dibujo lo dice antes que el texto.
    `.deuda{border-left:2.5pt solid ${light.danger};padding-left:3.5mm}`,
    `.deuda .sec{color:${light.danger}}`,
    `.deuda tr.total td{color:${light.danger};border-top-color:${light.danger};font-size:${fp.base}pt}`,

    // --- Composición del gasto (barrios que prorratean): la única zona con tope ------------------
    `.zona3{max-height:${p.detalle}mm;overflow:hidden;display:flex;flex-direction:column}`,
    ".zona3 > *{flex:0 0 auto}",
    ".encabezado-zona{display:flex;align-items:baseline;gap:3mm;white-space:nowrap;overflow:hidden;margin-bottom:.4mm}",
    ".encabezado-zona .sec{margin-bottom:0}",
    `.encabezado-zona .sub{font-size:${fp.xs}pt;color:${tinta.textSecondary};min-width:0;overflow:hidden;text-overflow:ellipsis}`,
    `.detalle{font-size:${fp.sm}pt;line-height:1.05}`,
    // El rótulo «Gasto del período» (doc 07 §B) entra en su columna con el espaciado justo.
    ".detalle th{letter-spacing:.02em;white-space:nowrap}",
    ".detalle td{padding:.25mm 0}",
    ".detalle td.num,.detalle td.tipo{padding-left:2mm}",
    ".detalle .tipo{white-space:nowrap}",
    ".detalle tr.con-aclara > td{border-bottom:none;padding-bottom:0}",
    `.detalle td.aclara{font-size:${fp.xs}pt;color:${tinta.textSecondary};padding-top:.1mm}`,

    // --- Cómo pagar: la zona de exclusión del instrumento (doc 09 §E.6) ---------------------------
    // El renderizador la usa como límite de la marca de agua: nada estampado entra acá. Negro puro
    // sobre blanco puro para los datos del instrumento (doc 09 §E.5.3, regla 2).
    `.exclusion{flex:0 0 auto;color:${tinta.instrumentoInk};display:flex;flex-direction:column;gap:2mm}`,
    `.como{display:flex;gap:5mm;align-items:center;background:${tinta.hairlineSoft};border-radius:2mm;padding:1.8mm 4mm}`,
    `.como .qr{flex:0 0 auto;background:${tinta.paper};border:.4pt solid ${tinta.hairline};border-radius:1mm;line-height:0}`,
    ".como .datos{flex:1 1 auto;min-width:0}",
    `.instrucciones{font-size:${fp.sm}pt;line-height:1.3;margin-bottom:1.6mm}`,
    ".canales{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2mm 6mm}",
    ".canal{min-width:0}",
    // La mono acá sí: un CBU de 22 dígitos o un código de pago se tipean carácter por carácter.
    `.canal .val{display:block;font-family:${PILA_MONO};font-size:${fp.base}pt;font-weight:700;letter-spacing:.02em;line-height:1.3;overflow-wrap:anywhere}`,
    `.canal .nota-canal{display:block;font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.25}`,
    ".como .logos{margin-top:1.6mm}",
    ".como .logos img{margin-right:3mm;vertical-align:middle}",
    // Los símbolos lineales ocupan un RENGLÓN PROPIO, a lo ancho y sobre papel blanco: el código de
    // barras mide los 182 mm útiles y nada se pone a su costado (doc 09 §E.6).
    `.simbolos{min-width:0;background:${tinta.paper}}`,
    ".simbolo{margin:.2mm 0}",
    `.simbolo .et{font-size:${fp.xs}pt;color:${tinta.textSecondary};text-transform:uppercase;letter-spacing:.04em}`,
    `.simbolo .leible{font-family:${PILA_MONO};font-size:${fp.sm}pt;letter-spacing:.03em;line-height:1.2}`,

    // --- Leyendas y pie ----------------------------------------------------------------------------
    `.adjunto{border-left:2pt solid var(--acento);padding-left:2.5mm;margin-bottom:.6mm;color:${tinta.textPrimary}}`,
    ".texto-legal{margin:0}",
    // El pie sigue al contenido, como en la maqueta: sin troquel no hay nada que anclar al fondo, y
    // apoyado abajo dejaba media hoja en blanco entre «Cómo pagar» y el pie en una boleta corta.
    `.pie{margin-top:1.2mm;border-top:.4pt solid ${tinta.hairline};padding-top:1.2mm;font-size:${fp.xs}pt;color:${tinta.textSecondary};line-height:1.22}`,
    // La emisión flota a la derecha del primer renglón y las leyendas usan el ancho entero debajo:
    // en dos columnas, el texto legal de un barrio con cinco leyendas se pasaba de la hoja.
    ".pie-der{float:right;margin-left:6mm;white-space:nowrap}",
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

/** `"2026-10"` → `"octubre"`: el mes como se dice («Conceptos de octubre», «Cobra solo octubre»). */
const mesDe = (v: VistaBoleta) => (nombreDelPeriodo(v.periodo.codigo).split(" ")[0] ?? "").toLowerCase();

/**
 * Lo que cobra el cupón: con modo de cupón, su importe; sin él, el total a pagar de siempre. Con la
 * cuota del plan que cobra el barrio (encargo P2b), eso más la cuota.
 */
const importeDelCupon = (v: VistaBoleta) =>
  // F6: con saldo a favor, lo que se paga es el neto (lo arma la vista; la plantilla no resta).
  v.saldoAFavor?.totalAPagar ?? v.planDePagos?.aPagarConLaCuota ?? v.cupon?.importe ?? v.totales.aPagar;

/** F6: el renglón «Saldo a favor aplicado», en negativo, si la emisión aplicó crédito a esta boleta. */
const renglonSaldoAFavor = (v: VistaBoleta): string =>
  v.saldoAFavor !== null && v.saldoAFavor.aplicado.monto !== "0.00"
    ? renglon("Saldo a favor aplicado", `-${v.saldoAFavor.aplicado.texto}`, "resta", null, null)
    : "";

/**
 * F6: lo que la boleta dice del saldo a favor, debajo de los conceptos. Con «Se aplica en la boleta
 * siguiente», lo que cubrió de meses anteriores (con «solo el mes») y lo que queda para el mes
 * siguiente; con «No se aplica solo», cuánto tiene a favor, sin restarlo.
 */
function lineasSaldoAFavor(v: VistaBoleta): string {
  const s = v.saldoAFavor;
  if (s === null) return "";
  const lineas =
    s.modo === "manual"
      ? s.queda.monto === "0.00"
        ? []
        : [`Tiene $ ${s.queda.texto} a favor, a aplicar por la administración.`]
      : [
          // Una boleta en cero se dice en palabras: un «$ 0,00» solo confunde (contador, F6 tramo 2).
          ...(s.totalAPagar.monto === "0.00" ? ["Esta boleta está cubierta por su saldo a favor: no tiene que pagar nada."] : []),
          // Lo que cubrió de meses anteriores, si la boleta no lo muestra en la tabla de la deuda.
          ...(s.aplicadoADeudaAnterior.monto !== "0.00" && !(v.cupon?.modo === "solo_mes" && v.cupon.deudaNoIncluida.monto !== "0.00")
            ? [`Su saldo a favor cubrió $ ${s.aplicadoADeudaAnterior.texto} de meses anteriores.`]
            : []),
          ...(s.queda.monto === "0.00" ? [] : [`Saldo a favor para el mes siguiente: $ ${s.queda.texto}`]),
        ];
  return lineas.length === 0 ? "" : `<div class="notas saldo-a-favor">${lineas.map((l) => `<span>${escapar(l)}</span>`).join(" ")}</div>`;
}

/** La cuota del plan que cobra el barrio, si hay (encargo P2b): suma y va en renglón aparte. */
const cuotaDelBarrio = (v: VistaBoleta) => (v.planDePagos?.cobra === "barrio" ? v.planDePagos : null);

/**
 * El acento del barrio al 10 %. Lo usa el recibo (`recibo.ts`) para su sello; la boleta nueva pinta
 * las iniciales en el acento pleno, como la maqueta.
 */
export const acentoTenue = (acentoHex: string) => `${acentoHex}1a`;

/**
 * Las iniciales del barrio, cuando no hay logo cargado.
 *
 * **Es la única cosa que la plantilla deriva de un dato en vez de imprimirlo**, y por eso la regla es
 * chica y explícita: se descartan las palabras que **no distinguen a un barrio de otro** —el
 * sustantivo genérico con el que empiezan casi todos y los artículos y preposiciones— y se toman las
 * iniciales de las dos últimas que quedan, que es donde vive el nombre propio ("Barrio Los Talas" →
 * "T"; "Barrio Demo Los Aromos" → "DA").
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

/** Un renglón de tabla de importes: concepto con su detalle debajo, e importe a la derecha. */
function renglon(etiqueta: string, texto: string, clase: string, detalle: string | null, marcador: number | null): string {
  return (
    `<tr${clase ? ` class="${clase}"` : ""}><td>${escapar(etiqueta)}${marcador === null ? "" : ` (${marcador})`}` +
    (detalle ? `<span class="det">${escapar(detalle)}</span>` : "") +
    `</td><td class="num cifra">${escapar(texto)}</td></tr>`
  );
}

/** Un renglón sin cifra (interés pendiente o que no se cobra): se dice con palabras, sin importe. */
function renglonSinCifra(etiqueta: string, detalle: string | null, palabra: string): string {
  return (
    `<tr><td>${escapar(etiqueta)}` +
    (detalle ? `<span class="det">${escapar(detalle)}</span>` : "") +
    `</td><td class="num">${escapar(palabra)}</td></tr>`
  );
}

function aviso(tono: TonoAviso, marca: BandaEstado["marca"], titulo: string, texto: string): string {
  return (
    `<div class="aviso aviso--${tono}">${glifoBanda(marca)}` +
    `<span><b>${escapar(titulo)}.</b> ${escapar(texto)}</span></div>`
  );
}

/** Los avisos de las bandas pedidas, en el orden en que la vista las trae (doc 09 §E.4.1). */
function avisosDeBandas(v: VistaBoleta, claves: readonly BandaEstado["clave"][]): string {
  return v.bandas
    .filter((b) => claves.includes(b.clave))
    .map((b) => {
      const tono = AVISO_DE_BANDA[b.clave];
      return tono ? aviso(tono, b.marca, b.titulo, b.texto) : "";
    })
    .join("");
}

function cabecera(v: VistaBoleta): string {
  const { barrio, emisor } = v.marca;
  const marcaBarrio =
    barrio.logo === null
      ? `<div class="sello" aria-hidden="true">${escapar(inicialesDelBarrio(barrio.nombre))}</div>`
      : `<div class="logo"><img src="${barrio.logo.dataUri}" alt="${escapar(barrio.nombre)}" style="max-width:min(${barrio.logo.anchoMaxMm}mm,45mm);max-height:min(${barrio.logo.altoMaxMm}mm,11mm)"></div>`;

  // El emisor es el **dato legal**, no un elemento de marca: letra chica bajo la cabecera (doc 09
  // §E.9.0). Arriba y grande va el barrio, que es a quien el vecino le paga.
  const datosEmisor = [
    `Administra: ${escapar(emisor.razonSocial)}`,
    emisor.cuit ? `CUIT ${escapar(emisor.cuit)}` : null,
    emisor.domicilio ? escapar(emisor.domicilio) : null,
    emisor.contacto ? escapar(emisor.contacto) : null,
    v.emision.comprobante
      ? `Comprobante <span class="cifra">${escapar(v.emision.comprobante)}</span>`
      : "Comprobante: pendiente de numeración",
    // Mismas palabras que usan el informe y el listado para el mismo estado.
    v.emision.fecha === null ? "Documento sin emitir" : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");

  return [
    '<header class="enc" data-desborde="identidad">',
    '<div class="marca">',
    marcaBarrio,
    '<div class="marca-texto">',
    // `data-sin-marca` también acá: sin rótulos declarados, la marca de agua de una muestra elegía
    // la cabecera como «el hueco más alto» y tachaba el nombre del barrio.
    `<div class="barrio-nombre" data-sin-marca>${escapar(barrio.nombre)}</div>`,
    // El CUIT y el domicilio del barrio, en un renglón, con lo que venga: sin ninguno, no hay renglón.
    subBarrio(v),
    "</div>",
    "</div>",
    // A la derecha, **lo que la boleta ES**: la denominación del barrio y su mes, con el año.
    '<div class="titulo-doc">',
    `<span class="etq">${escapar(conMayuscula(v.periodo.denominacionConcepto))}</span>`,
    `<div class="mes" data-sin-marca>${escapar(nombreDelPeriodo(v.periodo.codigo))}</div>`,
    "</div>",
    "</header>",
    `<div class="emisor">${datosEmisor}</div>`,
  ].join("");
}

/** «CUIT 30-00000000-0 · Ruta Demo km 12»: lo que la vista traiga, en ese orden. Vacío, nada. */
function subBarrio(v: VistaBoleta): string {
  const partes = [v.barrio.cuit ? `CUIT ${escapar(v.barrio.cuit)}` : null, v.barrio.domicilio ? escapar(v.barrio.domicilio) : null].filter(
    (p): p is string => p !== null,
  );
  return partes.length > 0 ? `<div class="barrio-sub">${partes.join(" · ")}</div>` : "";
}

/**
 * El recuadro de la unidad: unidad, titular, N.º de acción y coeficiente. **Solo lo que la vista
 * trae**: un barrio sin N.º de acción (o una boleta emitida antes de que la vista lo tuviera) no deja
 * un casillero vacío en su lugar.
 */
function identificacion(v: VistaBoleta): string {
  const titular = v.unidad.rolDestinatario
    ? `${v.unidad.destinatario} — ${v.unidad.rolDestinatario}`
    : v.unidad.destinatario;
  return [
    '<section class="ident" aria-label="Unidad">',
    `<div><span class="etq" data-sin-marca>Unidad</span><b class="cifra">${escapar(v.unidad.etiqueta)}</b></div>`,
    `<div class="ancho"><span class="etq" data-sin-marca>Titular</span><b>${escapar(titular)}</b></div>`,
    v.unidad.numeroAccion
      ? `<div><span class="etq" data-sin-marca>N.º de acción</span><b class="cifra">${escapar(v.unidad.numeroAccion)}</b></div>`
      : "",
    `<div><span class="etq" data-sin-marca>Coeficiente</span><b class="cifra">${escapar(v.detalle.coeficiente.participacionTexto)} %</b></div>`,
    "</section>",
  ].join("");
}

/**
 * El bloque grande: **cuánto y cuándo**. Con «solo el mes» la cifra es lo devengado en el mes; con
 * «el mes más la deuda» (o sin modo de cupón) es el total, y la deuda queda como detalle debajo.
 */
function bloqueGrande(v: VistaBoleta): string {
  const total = importeDelCupon(v).texto;
  const b = v.bloquePago;
  const aclaraciones = [
    b.fechas.tope && b.importes.alTope
      ? b.importes.alTope.monto === b.importes.alVencimiento.monto
        ? `<span>2.º vencimiento <b class="cifra">${escapar(b.fechas.tope.texto)}</b>, mismo importe</span>`
        : `<span>2.º vencimiento <b class="cifra">${escapar(b.fechas.tope.texto)}</b>: <b class="cifra">$ ${escapar(b.importes.alTope.texto)}</b></span>`
      : null,
    // La fecha de corte (`0078`), **con año**: el corte de diciembre puede caer en enero.
    v.periodo.fechaCorte
      ? `<span>Se puede pagar hasta el <b class="cifra">${escapar(v.periodo.fechaCorte.texto)}</b></span>`
      : null,
    cuotaDelBarrio(v) ? "<span>Incluye la cuota del plan de pagos</span>" : null,
    v.cupon?.modo === "solo_mes"
      ? `<span>Cobra solo ${escapar(mesDe(v))}</span>`
      : v.totales.aPagar.monto !== v.totales.delPeriodo.monto
        ? "<span>Incluye la deuda de meses anteriores</span>"
        : null,
  ].filter((x): x is string => x !== null);

  return [
    '<section class="pago" aria-label="Qué pagar">',
    // `data-sin-marca`: los rótulos que la marca de agua no puede cruzar. La plantilla **declara**
    // cuáles son; dónde y de qué tamaño se estampa lo decide el renderizador (ADR-0001 §10).
    '<div class="celda" data-desborde="pago-total">',
    '<span class="etq" data-sin-marca>Total a pagar</span>',
    '<div class="monto cifra"><span class="signo">$</span>' +
      `<span class="importe" style="font-size:${cuerpoDelTotal(total)}pt">${escapar(total)}</span></div>`,
    "</div>",
    '<div class="celda vence" data-desborde="pago-vence">',
    '<span class="etq" data-sin-marca>Vence el</span>',
    `<div class="fecha cifra">${escapar(b.fechas.vencimiento.texto)}</div>`,
    "</div>",
    aclaraciones.length === 0 ? "" : `<div class="aclara">${aclaraciones.join("")}</div>`,
    "</section>",
  ].join("");
}

/** El renglón del interés: con su cuenta, pendiente de definición, o «no se cobra» (ADR-0006). */
function filaInteres(v: VistaBoleta): string {
  if ((v.totales.interes === null || v.interes === null) && v.interesNoSeCobra === true) {
    return renglonSinCifra("Interés por mora", "No se cobra en este barrio", "no se cobra");
  }
  if (v.totales.interes === null || v.interes === null) {
    return renglonSinCifra("Interés: pendiente de definición", "El barrio no tiene tasa cargada a la fecha de emisión", "pendiente");
  }
  const i = v.interes;
  // Cada parte se imprime solo si el sistema la tiene: con interés en cero es normal que no haya
  // días ni fecha de corte, y la hoja no los inventa.
  const cuenta = [
    i.arrastre && i.arrastre.pendiente.monto !== "0.00"
      ? `$ ${i.arrastre.pendiente.texto} pendiente de antes + $ ${i.arrastre.alCorte.texto} al corte`
      : null,
    `Base $ ${i.base.texto}`,
    i.tasaMensualTexto === null ? null : `${i.tasaMensualTexto} % mensual`,
    i.dias === null ? null : `${i.dias} días`,
    i.computadoHasta === null ? null : `al ${i.computadoHasta.texto}`,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
  return renglon("Interés", v.totales.interes.texto, "", cuenta, null);
}

/**
 * ¿La deuda de meses anteriores **suma** en la tabla del mes? Sí cuando el cupón la cobra: sin modo
 * de cupón, con «el mes más la deuda», y con «solo el mes» cuando la deuda no viene desglosada y
 * quedó entera adentro del cupón (un saldo traído de afuera del sistema, que no tiene meses).
 */
function laDeudaSuma(v: VistaBoleta): boolean {
  if (v.cupon?.modo !== "solo_mes") return true;
  return v.deudaAnterior === null && v.cupon.deudaNoIncluida.monto === "0.00";
}

/**
 * Con el cupón que cobra el total (o sin modo de cupón) y la deuda desglosada mes por mes, el saldo y
 * el interés **no se repiten** como renglones del mes: los imprime, con su cifra, la fila «Total
 * adeudado» de la tabla de la deuda, que es su detalle. Dos veces la misma cifra en la misma hoja se
 * comía el lugar que la composición del gasto necesita. Con el interés pendiente de definición sí va
 * el renglón: es lo único que dice que falta.
 */
function deudaDetalladaAbajo(v: VistaBoleta): boolean {
  return v.cupon?.modo !== "solo_mes" && v.deudaAnterior !== null && v.deudaAnterior.length > 0 && v.totales.interes !== null;
}

/**
 * Los conceptos del mes. **DIFERENCIA 2:** la columna de importes va sin `$`: la cadena de dinero es
 * idéntica a la del modelo (`-15.000,00`), y el `$` queda donde la cifra viaja sola.
 */
function conceptos(v: VistaBoleta): string {
  const mes = mesDe(v);
  const filas = v.composicion
    .map((r) =>
      renglon(
        r.etiqueta,
        r.importe.texto,
        [r.informativo ? "informativo" : "", r.importe.monto.startsWith("-") ? "resta" : ""].filter(Boolean).join(" "),
        r.aclaracion,
        r.marcadorNota,
      ),
    )
    .join("");

  /*
   * Cuando el cupón cobra la deuda, el saldo, el interés y el total a pagar **no se omiten aunque
   * valgan cero** (doc 07 §B, DIFERENCIA 3): un renglón de dinero ausente se lee como dato
   * escondido. Con «solo el mes» la deuda va en su propio bloque, aparte, y no suma.
   */
  /*
   * La cuota del plan que cobra el barrio (encargo P2b): un renglón aparte por cuota, después del
   * total del mes y de la deuda, antes del total a pagar. Sin cuota del barrio, la tabla de siempre.
   */
  const plan = cuotaDelBarrio(v);
  const cuotas = plan
    ? plan.cuotas.map((c) => renglon(c.etiqueta, c.importe.texto, "", `Vence el ${c.vencimiento.texto}`, null)).join("")
    : "";
  // F6: el saldo a favor aplicado va justo antes del total a pagar, que ya viene neto.
  const favor = renglonSaldoAFavor(v);
  const totalAPagar = favor + renglon("Total a pagar", importeDelCupon(v).texto, "total", null, null);
  const cola = !laDeudaSuma(v)
    ? plan || favor
      ? cuotas + totalAPagar
      : ""
    : plan
      ? deudaDetalladaAbajo(v)
        ? cuotas + totalAPagar
        : [renglon("Saldo de períodos anteriores", v.totales.saldoAnterior.texto, "", null, null), filaInteres(v), cuotas, totalAPagar].join("")
    : deudaDetalladaAbajo(v)
      ? totalAPagar
      : [
          renglon("Saldo de períodos anteriores", v.totales.saldoAnterior.texto, "", null, null),
          filaInteres(v),
          totalAPagar,
        ].join("");

  // Las notas corren en un párrafo, no una por renglón: son aclaraciones cortas.
  const notas = v.notas.map((n) => `<span>(${n.marcador}) ${escapar(n.texto)}</span>`).join(" ");

  return [
    '<section class="conceptos-bloque" aria-label="Conceptos del mes">',
    `<h2 class="sec" data-sin-marca>Conceptos de ${escapar(mes)}</h2>`,
    '<table class="tabla conceptos">',
    '<thead><tr><th>Concepto</th><th class="num">Importe</th></tr></thead>',
    "<tbody>",
    filas,
    renglon(`Total de ${mes}`, v.totales.delPeriodo.texto, laDeudaSuma(v) || plan || favor ? "subtotal" : "total", null, null),
    cola,
    "</tbody>",
    "</table>",
    notas ? `<div class="notas">${notas}</div>` : "",
    lineasSaldoAFavor(v),
    // «No recibiste la bonificación» solo cuando el barrio bonifica y la unidad no la recibió: lo
    // decide la vista con la banda, no la plantilla.
    avisosDeBandas(v, ["bonificacion_no_aplicada", "bonificacion_aplicada"]),
    cuotaDelEstudio(v),
    "</section>",
  ].join("");
}

/**
 * La cuota del plan que cobra el estudio (encargo P2b): se informa y **no suma**. Dice cuánto, cuándo
 * vence, a quién se le paga (nombre y teléfono que cargó la administración) y que no está en el total.
 */
function cuotaDelEstudio(v: VistaBoleta): string {
  const plan = v.planDePagos;
  if (plan?.cobra !== "estudio" || plan.estudio === null) return "";
  const estudio = plan.estudio;
  const cuotas = plan.cuotas.map((c) => `${c.etiqueta}: $ ${c.importe.texto}, vence el ${c.vencimiento.texto}.`).join(" ");
  const aQuien = `Esta cuota se paga a ${estudio.nombre}${estudio.contacto ? `, ${estudio.contacto}` : ""}. No está incluida en el total.`;
  return aviso("info", "info", "Se paga al estudio", `${cuotas} ${aQuien}`);
}

/** [F6] Con «solo el mes», el saldo a favor cubrió (parte de) la deuda de meses anteriores. */
const cubiertaPorElSaldo = (v: VistaBoleta): boolean =>
  v.cupon?.modo === "solo_mes" && v.saldoAFavor !== null && v.saldoAFavor.aplicadoADeudaAnterior.monto !== "0.00";

/** [F6] Los dos renglones de la deuda sin desglose: lo cubierto por el saldo a favor y lo que sigue adeudado. */
const renglonesDeLoCubierto = (v: VistaBoleta): string[] =>
  cubiertaPorElSaldo(v)
    ? [
        renglon("Cubierto por su saldo a favor", `-${v.saldoAFavor!.aplicadoADeudaAnterior.texto}`, "resta", null, null),
        renglon("Sigue adeudado", v.saldoAFavor!.deudaAnteriorQueda.texto, "total", null, null),
      ]
    : [];

/**
 * La deuda de meses anteriores, **aparte**, mes por mes, con la barra roja.
 *
 * - «Solo el mes»: no está incluida en el cupón, y el título lo dice. El total es lo que el cupón no
 *   cobra (`cupon.deudaNoIncluida`).
 * - «El mes más la deuda» (o sin modo de cupón): ya sumó arriba en el total a pagar, y la tabla queda
 *   como **detalle** del saldo y del interés de los conceptos.
 *
 * DIFERENCIA 4: no se imprime «Cada mes adeudado se paga con su propio cupón… Pedilo a la
 * administración». El cupón de deuda todavía no existe.
 */
function deudaAnterior(v: VistaBoleta): string {
  const meses = v.deudaAnterior;
  const soloElMes = v.cupon?.modo === "solo_mes";

  if (soloElMes && v.cupon !== null) {
    if (meses === null) {
      // Sin desglose: si quedó todo adentro del cupón ya sumó arriba; si quedó afuera, se informa.
      if (v.cupon.deudaNoIncluida.monto === "0.00") return "";
      return [
        '<section class="deuda" aria-label="Deuda de meses anteriores">',
        '<h2 class="sec" data-sin-marca>Deuda de meses anteriores · no incluida en este cupón</h2>',
        '<table class="tabla"><tbody>',
        renglon("Total adeudado", v.cupon.deudaNoIncluida.texto, cubiertaPorElSaldo(v) ? "" : "total", null, null),
        ...renglonesDeLoCubierto(v),
        "</tbody></table>",
        "</section>",
      ].join("");
    }
    // DIFERENCIA 3: al día, se dice. La maqueta oculta el bloque; un renglón de deuda ausente se lee
    // como dato escondido (doc 07 §B), así que va una línea.
    if (meses.length === 0) return '<p class="sin-deuda">No registra deuda de meses anteriores.</p>';
  } else if (meses === null || meses.length === 0) {
    return "";
  }

  const filas = (meses ?? [])
    .map(
      (m) =>
        `<tr><td>${escapar(m.etiqueta)}</td><td class="cifra">${escapar(m.vencimiento.texto)}</td>` +
        `<td class="num cifra">${escapar(m.capital.texto)}</td><td class="num cifra">${escapar(m.interes.texto)}</td>` +
        `<td class="num cifra">${escapar(m.total.texto)}</td></tr>`,
    )
    .join("");
  const corte = v.interes?.computadoHasta ? `Interés al ${v.interes.computadoHasta.texto}` : "Interés";
  const interesTotal = v.totales.interes?.texto ?? "—";
  // El total de la última columna es una cifra de la vista: con «solo el mes», lo que el cupón no
  // cobra. Sin cupón separado no hay una cifra única para la deuda (ya sumó arriba) y la celda queda
  // vacía antes que sumarla acá: la plantilla no suma dinero.
  const total = soloElMes && v.cupon !== null ? v.cupon.deudaNoIncluida.texto : "";

  return [
    '<section class="deuda" aria-label="Deuda de meses anteriores">',
    soloElMes
      ? '<h2 class="sec" data-sin-marca>Deuda de meses anteriores · no incluida en este cupón</h2>'
      : '<h2 class="sec" data-sin-marca>Deuda de meses anteriores · incluida en el total a pagar</h2>',
    '<table class="tabla">',
    `<thead><tr><th>Mes</th><th>Venció</th><th class="num">Capital</th><th class="num">${escapar(corte)}</th><th class="num">Total</th></tr></thead>`,
    "<tbody>",
    filas,
    `<tr${cubiertaPorElSaldo(v) ? "" : ' class="total"'}><td colspan="2">Total adeudado</td><td class="num cifra">${escapar(v.totales.saldoAnterior.texto)}</td>` +
      `<td class="num cifra">${escapar(interesTotal)}</td><td class="num cifra">${escapar(total)}</td></tr>`,
    // [F6] Lo que el saldo a favor cubrió de esta deuda y lo que sigue adeudado (cifras de la vista).
    ...(cubiertaPorElSaldo(v)
      ? [
          `<tr><td colspan="4">Cubierto por su saldo a favor</td><td class="num cifra resta">-${escapar(v.saldoAFavor!.aplicadoADeudaAnterior.texto)}</td></tr>`,
          `<tr class="total"><td colspan="4">Sigue adeudado</td><td class="num cifra">${escapar(v.saldoAFavor!.deudaAnteriorQueda.texto)}</td></tr>`,
        ]
      : []),
    "</tbody>",
    "</table>",
    "</section>",
  ].join("");
}

/**
 * Caracteres de concepto que entran en un renglón de la composición del gasto **con** la columna de
 * barras puesta: ~60 mm de columna en 9 pt (≈ 1,6 mm por carácter de la sans). Es una estimación del
 * lado seguro, no una medida: errar solo saca la barra, nunca recorta el nombre.
 */
export const LARGO_CONCEPTO_CON_BARRAS = 36;

/**
 * **La composición del gasto** (DIFERENCIA 1): en un barrio que prorratea, de dónde sale el importe
 * del mes — el gasto entero del barrio por el coeficiente de la unidad, línea por línea, con la barra
 * de participación G-8. **Si no hubo reparto, no se imprime**: en un barrio de valor fijo esas
 * columnas no existen. La condición se deriva del dato, no del modelo.
 */
function composicionDelGasto(v: VistaBoleta): string {
  const lineas = v.detalle.lineas.filter((l) => l.clase === "prorrateo" || l.clase === "cuota_fija");
  if (!lineas.some((l) => l.gastoDelPeriodo !== null || l.coeficiente !== null)) return "";

  // G-8: solo las líneas **ordinarias** son partes del total de la cuota ordinaria; las demás quedan
  // sin pista (una pista vacía ya significa "cero"). Es el elemento declarado sacrificable.
  //
  // **Y se cae cuando algún nombre de concepto no entra en su columna con la barra puesta** (doc 10
  // §I.6.1: "se cae la columna de participación, nunca el nombre"). Un nombre que envuelve suma un
  // renglón a la única zona con tope, y en un barrio real ("Poda de altura en los espacios verdes del
  // ingreso") eran los milímetros que hacían que la hoja no entrara.
  const totalOrdinarias = v.detalle.totalOrdinarias;
  const barras =
    totalOrdinarias !== null &&
    lineas.every((l) => l.concepto.length + (l.marcadorNota === null ? 0 : 4) <= LARGO_CONCEPTO_CON_BARRAS) &&
    llevaColumnaDeBarras(lineas.filter((l) => l.clasificacion2048 === "ordinaria").map((l) => l.importe.texto));
  const columnas = barras ? 6 : 5;

  const filas = lineas
    .map((l) => {
      // Las aclaraciones van en un renglón propio a lo ancho, no dentro de la celda del concepto:
      // así no dependen del ancho de esa columna.
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

  return [
    // `data-desborde`: si la zona no entra, la emisión falla con su nombre en vez de recortar.
    '<section class="zona3" data-desborde="detalle">',
    '<div class="encabezado-zona">',
    '<h2 class="sec" data-sin-marca>Composición del gasto</h2>',
    `<span class="sub">El barrio gastó $ <span class="cifra">${escapar(v.detalle.gastoDelBarrio.texto)}</span> en ${escapar(v.periodo.etiqueta)} · tu coeficiente es <span class="cifra">${escapar(v.detalle.coeficiente.participacionTexto)} %</span></span>`,
    "</div>",
    '<table class="tabla detalle">',
    '<colgroup><col><col style="width:24mm"><col style="width:29mm"><col style="width:16mm">' +
      (barras ? `<col style="width:${ANCHO_COLUMNA_BARRAS_MM}mm">` : "") +
      '<col style="width:23mm"></colgroup>',
    '<thead><tr><th>Concepto</th><th>Tipo</th><th class="num">Gasto del período</th><th class="num">Coef.</th>' +
      (barras ? "<th></th>" : "") +
      '<th class="num">Importe</th></tr></thead>',
    `<tbody>${filas}</tbody>`,
    "</table>",
    v.detalle.continuaAlDorso ? '<div class="notas">El detalle sigue al dorso.</div>' : "",
    "</section>",
  ].join("");
}

/** Un instrumento de texto (CBU, alias, código de pago): rótulo, valor y su nota debajo. */
function instrumentoTexto(inst: Extract<InstrumentoPago, { tipo: "texto" }>): string {
  return (
    '<div class="canal">' +
    `<span class="etq">${escapar(inst.etiqueta)}</span>` +
    `<span class="val">${escapar(inst.valor)}</span>` +
    (inst.nota === null ? "" : `<span class="nota-canal">${escapar(inst.nota)}</span>`) +
    "</div>"
  );
}

function instrumentoSimbolo(inst: Extract<InstrumentoPago, { tipo: "simbolo" }>): string {
  const simbolo = renderizarSimbolo(inst, { anchoUtilMm: ANCHO_UTIL_MM });
  return (
    // `data-simbologia` es el ancla del canario que decodifica el símbolo **desde la hoja impresa**
    // (`test/canario-cupon.test.ts`).
    //
    // El QR va sin rótulo impreso, como en la maqueta (lo nombra el título «Cómo pagar» que tiene al
    // lado), pero con su nombre accesible: en la boleta web y en el correo lo lee un lector de pantalla.
    (inst.simbologia === "qrcode"
      ? `<div class="simbolo" data-simbologia="qrcode" role="img" aria-label="${escapar(inst.etiqueta)}">`
      : `<div class="simbolo" data-simbologia="${escapar(inst.simbologia)}"><div class="et">${escapar(inst.etiqueta)}</div>`) +
    simbolo.svg +
    (inst.leible === null ? "" : `<div class="leible">${escapar(inst.leible)}</div>`) +
    "</div>"
  );
}

/**
 * «Cómo pagar»: el QR al costado de los datos, y los símbolos lineales debajo a lo ancho. Los
 * instrumentos se pintan **tal como los arma el medio de cobro**: la plantilla no sabe de qué red
 * salieron ni cambia lo que codifican.
 *
 * **Sin troquel ni talón** (la maqueta): el banco y las billeteras leen el código de pago o el QR.
 * `presentacion.troquel` y `presentacion.talon` siguen en la vista y la plantilla no los dibuja.
 */
function comoPagar(v: VistaBoleta): string {
  const b = v.bloquePago;
  const lineales = b.instrumentos.filter(
    (i): i is Extract<InstrumentoPago, { tipo: "simbolo" }> => i.tipo === "simbolo" && i.simbologia !== "qrcode",
  );
  const qr = b.instrumentos.filter(
    (i): i is Extract<InstrumentoPago, { tipo: "simbolo" }> => i.tipo === "simbolo" && i.simbologia === "qrcode",
  );
  const textos = b.instrumentos.filter((i): i is Extract<InstrumentoPago, { tipo: "texto" }> => i.tipo === "texto");

  return [
    // La zona de exclusión completa (doc 09 §E.6): el renderizador la lee para no estampar nada encima.
    '<div class="exclusion" data-exclusion>',
    '<section class="como" aria-label="Cómo pagar" data-desborde="cupon">',
    qr.length === 0 ? "" : `<div class="qr">${qr.map(instrumentoSimbolo).join("")}</div>`,
    '<div class="datos">',
    '<h2 class="sec" data-sin-marca>Cómo pagar</h2>',
    b.presentacion.instrucciones.length === 0
      ? ""
      : `<div class="instrucciones">${b.presentacion.instrucciones.map((i) => `<div>${escapar(i)}</div>`).join("")}</div>`,
    `<div class="canales">${textos.map(instrumentoTexto).join("")}</div>`,
    b.logos.length === 0
      ? ""
      : `<div class="logos">${b.logos
          .map((l) => `<img src="${l.dataUri}" alt="" style="max-height:${l.altoMaxMm}mm;max-width:${l.anchoMaxMm}mm">`)
          .join("")}</div>`,
    "</div>",
    "</section>",
    lineales.length === 0
      ? ""
      : `<div class="simbolos" data-desborde="simbolos">${lineales.map(instrumentoSimbolo).join("")}</div>`,
    "</div>",
  ].join("");
}

/**
 * El pie: a la izquierda las consultas, el aviso del adjunto y las leyendas (del documento, del medio
 * de cobro y de la administración, sin repetir ninguna); a la derecha, la emisión y el folio.
 *
 * Las leyendas viven en el pie y no en un bloque propio: son oraciones legales cortas y un renglón
 * aparte arriba del pie costaba seis milímetros que la composición del gasto necesita.
 */
function pie(v: VistaBoleta): string {
  const leyendas = [...new Set([...v.bloquePago.leyendas, ...v.leyendas, ...v.marca.pie])];
  /*
   * **El gancho a la liquidación del último mes cerrado** (requisito del usuario, 2026-08-05): la
   * boleta viaja con la liquidación de gastos del último mes cerrado, y la hoja lo dice. Sin cifras.
   * Hay un mes anterior del que hablar exactamente cuando hay evolución.
   */
  const anterior = v.evolucion?.puntos.at(-2)?.etiqueta ?? null;
  const izquierda = [
    v.marca.emisor.contacto ? `<div>Consultas: ${escapar(v.marca.emisor.contacto)}</div>` : "",
    anterior === null
      ? ""
      : `<div class="adjunto"><b>Va adjunta la liquidación de ${escapar(anterior)}</b>, el último mes cerrado: ahí está el detalle de los gastos.</div>`,
    leyendas.length === 0 ? "" : `<p class="texto-legal">${leyendas.map((l) => `<span>${escapar(l)}</span>`).join(" ")}</p>`,
  ].join("");
  const emitida = v.emision.fecha ? `Emitida el ${escapar(v.emision.fecha.texto)}` : "Documento sin emitir";
  return [
    '<footer class="pie">',
    `<div class="pie-der">${emitida} · página 1 de 1</div>`,
    izquierda,
    "</footer>",
  ].join("");
}

/** Fragmento HTML de **una** boleta. Es lo que se concatena en el lote de una sola pasada. */
export function cuerpoBoleta(v: VistaBoleta): string {
  return [
    // El acento del barrio entra como variable, inline: es dato, no diseño (el CSS solo la nombra).
    `<article class="boleta" style="--acento:${v.marca.barrio.acentoHex}">`,
    cabecera(v),
    identificacion(v),
    bloqueGrande(v),
    // «Vista previa» e «interés pendiente»: lo que cambia cómo se lee el bloque de arriba.
    (() => {
      const avisos = avisosDeBandas(v, ["vista_previa", "interes_pendiente"]);
      return avisos ? `<div class="avisos">${avisos}</div>` : "";
    })(),
    conceptos(v),
    deudaAnterior(v),
    composicionDelGasto(v),
    comoPagar(v),
    pie(v),
    "</article>",
  ].join("");
}
