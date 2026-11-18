/**
 * La plantilla del PDF de un plan de pagos (encargo P2a-3): `VistaAcuerdoPlan` → HTML.
 *
 * Dos caminos (`v.camino`):
 *  - **`modelo`**: la carátula del convenio —las partes, las cláusulas del modelo ya completadas, la
 *    leyenda «Texto a validar por el estudio» si el modelo no está validado, y las firmas— y, en hoja
 *    nueva, el anexo.
 *  - **`anexo`**: solo el anexo, con una línea que dice qué documento acompaña.
 *
 * Es un multipágina de la familia (`estilosFamilia`, encabezado y pie corridos, franja de acento en la
 * primera hoja, folio estampado por el renderizador), como el listado de saldos: el cronograma de un
 * plan de 60 cuotas no entra en una hoja.
 *
 * Mismas reglas que el resto de las plantillas: no formatea dinero ni fechas (todo llega con `.texto`),
 * no emite URLs externas y no inventa tamaños ni tintas (`@admin-barrios/design-tokens`).
 */

import { fontSizePrint as fp, printInk as tinta } from "@admin-barrios/design-tokens";
import { aCentavos } from "@admin-barrios/shared/dinero";
import { LEYENDA_TEXTO_A_VALIDAR } from "@admin-barrios/shared/planes-documentos";
import type { VistaAcuerdoPlan } from "@admin-barrios/shared/documentos";
import {
  cabeceraDeIdentidad,
  cierreDelDocumento,
  encabezadoCorrido,
  escapar,
  estilosFamilia,
  franjaDeAcento,
  hojaConCorridos,
  pieCorrido,
  type FuenteEmbebida,
} from "./comun.ts";

export const TITULO_CONVENIO_PLAN = "Convenio de plan de pagos";
export const TITULO_ANEXO_PLAN = "Anexo del plan de pagos";

/** El sello de cada hoja de un plan que todavía no se aprobó. */
export const MARCA_PROPUESTA = "PROPUESTA — TODAVÍA SIN APROBAR";

export function estilosAcuerdoPlan(fuentes: readonly FuenteEmbebida[] = []): string {
  return [
    estilosFamilia(fuentes),
    // --- Título del documento ----------------------------------------------------------------------
    ".titulo-doc{margin-top:5mm}",
    `.titulo-doc .t{font-size:${fp["2xl"]}pt;font-weight:700;line-height:1.15}`,
    `.titulo-doc .s{font-size:${fp.base}pt;color:${tinta.textSecondary};margin-top:1mm;line-height:1.3}`,
    // --- Las partes y las cláusulas ----------------------------------------------------------------
    `.partes{margin-top:4mm;font-size:${fp.base}pt;line-height:1.45}`,
    `.clausula{margin-top:3.5mm;font-size:${fp.base}pt;line-height:1.45;break-inside:avoid}`,
    `.clausula .n{font-weight:700}`,
    // Los saltos de línea que se escribieron en el editor se respetan (code-reviewer).
    ".clausula .tx{white-space:pre-line}",
    `.sin-firmas{margin-top:8mm;border-top:.4pt solid ${tinta.hairline};padding-top:2mm;font-size:${fp.base}pt;font-weight:600;break-inside:avoid}`,
    // La leyenda del modelo sin validar: filete grueso a la izquierda, sin fondo (un fondo fotocopiado
    // ensucia y un gris claro desaparece; ver `.banda` en `comun.ts`).
    `.a-validar{margin-top:4mm;border:.4pt solid ${tinta.hairline};border-left:1.2mm solid ${tinta.textPrimary};padding:1.5mm 3mm;font-size:${fp.base}pt;font-weight:600;break-inside:avoid}`,
    // --- Firmas ------------------------------------------------------------------------------------
    ".firmas{display:flex;gap:16mm;margin-top:22mm;break-inside:avoid}",
    `.firma{flex:1 1 0;border-top:.6pt solid ${tinta.textPrimary};padding-top:1.5mm;font-size:${fp.sm}pt;line-height:1.35}`,
    `.firma .rol{color:${tinta.textSecondary}}`,
    // --- El anexo, en hoja nueva cuando va después de la carátula ----------------------------------
    ".salto{break-before:page;page-break-before:always}",
    `.acompana{margin-top:3mm;font-size:${fp.base}pt;line-height:1.4}`,
  ].join("");
}

// --- Piezas ---------------------------------------------------------------------------------------

const pesos = (c: { readonly texto: string }) => `<span class="cifra">$ ${escapar(c.texto)}</span>`;

function renglon(etiqueta: string, valor: string, aclara?: string, clase?: string): string {
  return (
    `<tr${clase ? ` class="${clase}"` : ""}><td><div class="lin"><span>${escapar(etiqueta)}</span>` +
    (aclara ? `<span class="aclara">${escapar(aclara)}</span>` : "") +
    `<span class="guia"></span></div></td><td class="imp">${valor}</td></tr>`
  );
}

function datosDelPlan(v: VistaAcuerdoPlan): string {
  const lineas = [
    `${escapar(v.plan.descripcion)} · ${escapar(v.plan.financiacion)}`,
    escapar(v.plan.cobro),
    v.plan.fechaFirma ? `Aprobado el <span class="cifra">${escapar(v.plan.fechaFirma.texto)}</span>` : "Propuesta: todavía sin aprobar. Las cifras se vuelven a calcular con la deuda del día en que se aprueba.",
    v.plan.acta ? `Acta que aprueba la quita: ${escapar(v.plan.acta)}` : null,
  ].filter((x): x is string => x !== null);
  return `<div class="titulo-doc"><div class="s">${lineas.join("<br>")}</div></div>`;
}

/**
 * [P2b] Lo que sigue al nombre de la parte del barrio: su figura, su CUIT y quién la representa. Solo lo
 * que está cargado; nada se inventa.
 */
function parteDelBarrio(v: VistaAcuerdoPlan): string {
  const p = v.parte;
  if (!p) return "";
  const datos = [p.figura, p.cuit ? `CUIT ${p.cuit}` : null].filter((x): x is string => x !== null);
  return (
    (datos.length > 0 ? ` (${escapar(datos.join(", "))})` : "") +
    (p.representante ? `, con la representación de su administración, <strong>${escapar(p.representante)}</strong>,` : "")
  );
}

function caratula(v: VistaAcuerdoPlan): string {
  const titular = v.unidad.titular ? escapar(v.unidad.titular) : "quien figura como titular de la unidad";
  const firmaTitular = v.unidad.titular ? escapar(v.unidad.titular) : `Titular de la unidad ${escapar(v.unidad.etiqueta)}`;
  // Sin doble punto si el título ya termina en uno (code-reviewer).
  const conPunto = (t: string) => (/[.!?:]$/.test(t) ? t : `${t}.`);
  const clausulas = (v.clausulas ?? [])
    .map((c, i) => `<div class="clausula"><span class="n">${i + 1}. ${escapar(conPunto(c.titulo))}</span> <span class="tx">${escapar(c.texto)}</span></div>`)
    .join("");
  // Una propuesta no se firma (UX): al aprobarla las cifras se recalculan con la deuda de ese día, y el
  // papel firmado diría otros números. Se firma el que se arme después de aprobado.
  const firmas =
    v.plan.estado === "pendiente"
      ? '<div class="sin-firmas">Propuesta sin aprobar: se firma el convenio que se arme después de la aprobación.</div>'
      : [
          '<div class="firmas">',
          `<div class="firma">Por ${escapar(v.parte?.nombre ?? v.marca.barrio.nombre)}<br><span class="rol">` +
            (v.parte?.representante ? `${escapar(v.parte.representante)}, como su representante` : "Firma, aclaración y cargo") +
            "</span></div>",
          `<div class="firma">${firmaTitular}<br><span class="rol">Firma, aclaración y DNI</span></div>`,
          "</div>",
        ].join("");
  return [
    `<div class="titulo-doc"><div class="t">${TITULO_CONVENIO_PLAN}</div></div>`,
    datosDelPlan(v),
    '<div class="partes">',
    `Entre <strong>${escapar(v.parte?.nombre ?? v.marca.barrio.nombre)}</strong>${parteDelBarrio(v)} y <strong>${titular}</strong>, por la unidad ` +
      `<strong>${escapar(v.unidad.etiqueta)}</strong>, se acuerda pagar la deuda que detalla el anexo con el cronograma que ` +
      "ahí figura, en estas condiciones:",
    "</div>",
    clausulas,
    v.textoAValidar ? `<div class="a-validar">${escapar(LEYENDA_TEXTO_A_VALIDAR)}</div>` : "",
    firmas,
  ].join("");
}

function anexo(v: VistaAcuerdoPlan, tras: boolean): string {
  const meses = v.deuda.meses
    .map(
      (m) =>
        `<tr><td class="cifra">${escapar(m.periodo)}</td><td class="num">${pesos(m.capital)}</td>` +
        `<td class="num">${pesos(m.interes)}</td><td class="num">${pesos(m.total)}</td></tr>`,
    )
    .join("");
  const cuotas = v.cuotas
    .map(
      (q) =>
        `<tr><td>${q.numero === 0 ? "Anticipo" : `Cuota ${q.numero}`}</td>` +
        `<td class="cifra">${escapar(q.vencimiento.texto)}</td>` +
        `<td class="num">${pesos(q.capital)}</td><td class="num">${pesos(q.interes)}</td><td class="num">${pesos(q.importe)}</td></tr>`,
    )
    .join("");
  const hayQuita = aCentavos(v.quita.total.monto) > 0n;
  const hayFinanciacion = aCentavos(v.financiacion.monto) > 0n;

  return [
    `<section class="${tras ? "salto " : ""}seccion">`,
    `<div class="titulo-doc"><div class="t">${tras ? "Anexo · " : ""}Las cifras del plan</div></div>`,
    tras ? "" : datosDelPlan(v),
    v.camino === "anexo"
      ? `<div class="acompana">Acompaña ${v.estudio ? `el convenio redactado por <strong>${escapar(v.estudio)}</strong>` : "el convenio firmado por las partes"}, ` +
        `por la unidad <strong>${escapar(v.unidad.etiqueta)}</strong>${v.unidad.titular ? ` (${escapar(v.unidad.titular)})` : ""}. Las cifras son las que guarda el sistema.</div>`
      : "",
    "</section>",

    '<section class="seccion">',
    '<div class="rotulo">La deuda que entra</div>',
    `<div class="definicion">Mes por mes: el capital de la expensa y el interés por mora, con la tasa del barrio, ${v.plan.fechaFirma ? `al <span class="cifra">${escapar(v.plan.fechaFirma.texto)}</span>, el día de la aprobación` : "al día en que se propuso el plan"}.</div>`,
    '<table class="tabla"><thead><tr><th>Mes</th><th class="num">Capital</th><th class="num">Interés por mora</th><th class="num">Total</th></tr></thead>',
    `<tbody>${meses}</tbody>`,
    `<tfoot><tr><td>Total</td><td class="num">${pesos(v.deuda.capital)}</td><td class="num">${pesos(v.deuda.interes)}</td><td class="num">${pesos(v.deuda.total)}</td></tr></tfoot>`,
    "</table>",
    "</section>",

    '<section class="seccion">',
    '<div class="rotulo">El cuadre</div>',
    '<table class="renglones"><tbody>',
    renglon("Deuda que entra", pesos(v.deuda.total)),
    hayFinanciacion ? renglon("Más el interés de financiación", pesos(v.financiacion), v.plan.financiacion) : "",
    hayQuita
      ? renglon(
          "Menos lo que se perdona",
          pesos(v.quita.total),
          `${v.quita.porcentaje} % · interés $ ${v.quita.interes.texto} y capital $ ${v.quita.capital.texto}`,
        )
      : "",
    renglon("Total del plan", pesos(v.totalDelPlan), undefined, "conclusion"),
    "</tbody></table>",
    hayQuita
      ? '<div class="notas"><div>La quita va primero al interés por mora y después al capital, y vale si se cumple el plan.</div></div>'
      : "",
    "</section>",

    '<section class="seccion">',
    '<div class="rotulo">El cronograma</div>',
    // Quién cobra cambia lo que se dice (regla 6: ningún texto asume un modelo).
    `<div class="definicion">${v.plan.cobraElEstudio ? `Cada cuota la cobra ${escapar(v.plan.cobraElEstudio)}, que la rinde al barrio.` : "Cada cuota sale en la boleta del mes en que vence."} Con ${v.cuotasParaCaer} ${v.cuotasParaCaer === 1 ? "cuota vencida" : "cuotas vencidas"} sin pagar, el plan se puede dar por caído.</div>`,
    '<table class="tabla"><thead><tr><th></th><th>Vence</th><th class="num">Capital</th><th class="num">Interés</th><th class="num">Importe</th></tr></thead>',
    `<tbody>${cuotas}</tbody>`,
    `<tfoot><tr><td>Total</td><td></td><td class="num">${pesos(v.totalCuotas.capital)}</td><td class="num">${pesos(v.totalCuotas.interes)}</td><td class="num">${pesos(v.totalDelPlan)}</td></tr></tfoot>`,
    "</table>",
    "</section>",
  ].join("");
}

/** Arma el `<article>` del PDF del plan. Un `DocumentoSolicitado` por plan (`emision-acuerdo-plan.ts`). */
export function cuerpoAcuerdoPlan(v: VistaAcuerdoPlan): string {
  const titulo = v.camino === "modelo" ? TITULO_CONVENIO_PLAN : TITULO_ANEXO_PLAN;
  const corrido = encabezadoCorrido({
    barrio: v.marca.barrio.nombre,
    documento: titulo,
    periodo: null,
    corte: v.emitido.texto,
    criterio: `Unidad ${v.unidad.etiqueta}`,
    emitido: v.emitido.texto,
    // Lo que una hoja suelta tiene que decir: que es una propuesta y que el texto falta validar (UX).
    advertencias: [
      ...(v.plan.estado === "pendiente" ? ["Propuesta sin aprobar"] : []),
      ...(v.textoAValidar ? [LEYENDA_TEXTO_A_VALIDAR] : []),
    ],
  });
  const pie = pieCorrido(`${v.marca.barrio.nombre} · ${titulo} · ${v.unidad.etiqueta}`);
  const contenido = [
    cabeceraDeIdentidad(v.marca, []),
    v.camino === "modelo" ? caratula(v) + anexo(v, true) : anexo(v, false),
    cierreDelDocumento({ notas: [], leyendas: v.leyendas, marca: v.marca }),
  ].join("");
  return `<article class="doc">${franjaDeAcento(v.marca)}${hojaConCorridos(corrido, pie, contenido)}</article>`;
}

/** Todo lo que se lee impreso y escribió el sistema (el filtro de lenguaje). Las cláusulas no: ver `emision-acuerdo-plan.ts`. */
export function textosImpresosDelAcuerdo(v: VistaAcuerdoPlan): string[] {
  return [v.plan.descripcion, v.plan.financiacion, v.plan.cobro, ...v.leyendas, ...v.marca.pie];
}
