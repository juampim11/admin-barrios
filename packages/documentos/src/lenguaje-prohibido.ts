/**
 * Lenguaje prohibido en la boleta (doc 07 §E, `legal-ph`).
 *
 * El sistema **nunca afirma que la deuda es ejecutable**. La lista es de **frases**, no de palabras
 * sueltas, porque banear a ciegas rompe usos legítimos ("presupuesto vs. ejecutado" en el reporte,
 * "acciones" como títulos societarios en un barrio-SA).
 *
 * Se aplica a **todo** lo que se imprime, incluido el texto que carga el cliente: un administrador
 * escribiendo "bajo apercibimiento de acciones legales" en el pie es más probable que nosotros, y es
 * exactamente el riesgo que este filtro existe para evitar (doc 09 §E.9.4).
 */

export type GrupoProhibido = "ejecutividad" | "intimacion" | "judicial" | "sanciones" | "normativa" | "sin_respaldo" | "calificacion";

export type FraseProhibida = { readonly grupo: GrupoProhibido; readonly frase: string; readonly enLugarDe?: string };

/** Grupos A–G del doc 07 §E. */
export const FRASES_PROHIBIDAS: readonly FraseProhibida[] = [
  // A — ejecutividad
  { grupo: "ejecutividad", frase: "titulo ejecutivo" },
  { grupo: "ejecutividad", frase: "via ejecutiva" },
  { grupo: "ejecutividad", frase: "deuda ejecutable" },
  { grupo: "ejecutividad", frase: "merito ejecutivo" },
  { grupo: "ejecutividad", frase: "apremio" },
  { grupo: "ejecutividad", frase: "certificado de deuda" },
  // B — intimación
  { grupo: "intimacion", frase: "intimacion" },
  { grupo: "intimacion", frase: "intimar" },
  { grupo: "intimacion", frase: "emplazamiento" },
  { grupo: "intimacion", frase: "bajo apercibimiento" },
  { grupo: "intimacion", frase: "plazo perentorio" },
  { grupo: "intimacion", frase: "constituido en mora" },
  { grupo: "intimacion", frase: "notificacion fehaciente" },
  // C — judicial
  { grupo: "judicial", frase: "acciones legales" },
  { grupo: "judicial", frase: "acciones judiciales" },
  { grupo: "judicial", frase: "embargo" },
  { grupo: "judicial", frase: "subasta" },
  { grupo: "judicial", frase: "veraz" },
  { grupo: "judicial", frase: "nosis" },
  // D — sanciones y corte de servicios (art. 2049)
  { grupo: "sanciones", frase: "corte de servicio" },
  { grupo: "sanciones", frase: "restriccion de acceso" },
  { grupo: "sanciones", frase: "bloqueo de credencial" },
  { grupo: "sanciones", frase: "suspension del uso" },
  // E — normativa mal atribuida
  { grupo: "normativa", frase: "ley 13.512" },
  { grupo: "normativa", frase: "ley 13512" },
  // F — afirmaciones sin respaldo
  { grupo: "sin_respaldo", frase: "exento de iibb" },
  { grupo: "sin_respaldo", frase: "el pago implica conformidad" },
  { grupo: "sin_respaldo", frase: "no modifica el importe liquidado" },
  // G — calificación de la persona
  { grupo: "calificacion", frase: "moroso", enLugarDe: "saldo pendiente" },
  { grupo: "calificacion", frase: "morosa", enLugarDe: "saldo pendiente" },
  { grupo: "calificacion", frase: "deudor", enLugarDe: "saldo pendiente" },
  { grupo: "calificacion", frase: "deudora", enLugarDe: "saldo pendiente" },
  { grupo: "calificacion", frase: "incumplidor", enLugarDe: "saldo pendiente" },
];

/** Normaliza para comparar: minúsculas, sin tildes y con los espacios colapsados. */
export function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Devuelve las frases prohibidas encontradas. Vacío = el texto se puede imprimir.
 *
 * Las de un solo término (grupo G) se buscan como **palabra completa**: "moroso" no puede colarse,
 * pero tampoco puede saltar por dentro de otra palabra.
 */
export function revisarLenguaje(texto: string): FraseProhibida[] {
  const normalizado = normalizarTexto(texto);
  return FRASES_PROHIBIDAS.filter(({ frase }) =>
    frase.includes(" ")
      ? normalizado.includes(frase)
      : new RegExp(`(^|[^a-z0-9])${frase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(normalizado),
  );
}

/** Todos los textos de un documento, de una. Devuelve motivos legibles para el administrador. */
export function revisarTextosImpresos(textos: readonly string[]): string[] {
  return textos.flatMap((texto) =>
    revisarLenguaje(texto).map(
      (f) =>
        `lenguaje prohibido (${f.grupo}): "${f.frase}" en "${texto.slice(0, 80)}"` +
        (f.enLugarDe ? ` — se dice "${f.enLugarDe}"` : ""),
    ),
  );
}

/**
 * Todos los textos que un humano va a leer impresos en una boleta.
 *
 * **Se revisa al emitir, no al re-abrir.** Es una decisión, no un descuido: la lista de frases
 * prohibidas va a crecer, y si el filtro viviera dentro de `parsearVistaBoleta` —que es lo que se
 * corre sobre las vistas **congeladas** que se releen de `documento_liquidacion.vista`—, el día que
 * se agregue una frase **todas las boletas viejas que la contengan dejarían de poder abrirse**, que
 * es justo lo contrario de lo que promete ADR-0001 §6. `parsearVistaBoleta` valida estructura y
 * aritmética, que son invariantes atemporales; el lenguaje es política y se evalúa cuando el
 * administrador todavía puede corregirlo.
 *
 * Incluye lo que carga el cliente —`marca.pie`, el nombre de un concepto, el respaldo de un acta,
 * el detalle de un cargo—, que es exactamente el texto de más riesgo y el que doc 07 §E no cubría
 * (doc 09 §E.9.4).
 */
export function textosImpresosDeBoleta(v: {
  readonly leyendas: readonly string[];
  readonly marca: { readonly pie: readonly string[] };
  readonly notas: readonly { readonly texto: string }[];
  readonly bandas: readonly { readonly titulo: string; readonly texto: string }[];
  readonly composicion: readonly { readonly etiqueta: string; readonly aclaracion: string | null }[];
  readonly detalle: {
    readonly lineas: readonly {
      readonly concepto: string;
      readonly respaldo: string | null;
      readonly detalleHecho: string | null;
    }[];
  };
  readonly bloquePago: {
    readonly leyendas: readonly string[];
    readonly instrumentos: readonly { readonly etiqueta: string; readonly nota?: string | null }[];
  };
}): string[] {
  return [
    ...v.leyendas,
    ...v.marca.pie,
    ...v.notas.map((n) => n.texto),
    ...v.bandas.flatMap((b) => [b.titulo, b.texto]),
    ...v.composicion.flatMap((r) => [r.etiqueta, r.aclaracion ?? ""]),
    ...v.detalle.lineas.flatMap((l) => [l.concepto, l.respaldo ?? "", l.detalleHecho ?? ""]),
    ...v.bloquePago.leyendas,
    ...v.bloquePago.instrumentos.flatMap((i) => [i.etiqueta, i.nota ?? ""]),
  ].filter((t) => t.trim().length > 0);
}
