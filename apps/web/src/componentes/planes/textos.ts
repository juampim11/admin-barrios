/**
 * Los textos de un plan de pagos en la ficha de la unidad (P2a-1; maqueta de planes, pantalla 4).
 * Funciones puras: lo que dice la pantalla sale de lo que devuelve el servicio, sin cuentas propias.
 */
import type { DocumentosDelPlan } from "@admin-barrios/data/servicios/planes-documentos";
import type { CuotaDeUnidad, EstadoDeCuota, PlanDeUnidad } from "@admin-barrios/data/servicios/planes";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { formatearFecha, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import type { Tono } from "@admin-barrios/ui";

type Etiqueta = { readonly tono: Tono; readonly texto: string };

/** «1 de 12», o «Anticipo» para la cuota 0. */
export function numeroDeCuota(c: Pick<CuotaDeUnidad, "numero">, cantidad: number): string {
  return c.numero === 0 ? "Anticipo" : `${c.numero} de ${cantidad}`;
}

export const TEXTO_ESTADO_DE_CUOTA: Record<EstadoDeCuota, string> = {
  pagada: "Pagada",
  pagada_rendicion: "Pagada · rendición",
  parcial_rendicion: "Pago parcial · rendición",
  cancelada: "Cancelada por la caída",
  vencida: "Vencida · genera mora",
  a_vencer: "A vencer",
  sin_emitir: "A vencer · sale con la boleta de su mes",
};

export const TONO_ESTADO_DE_CUOTA: Record<EstadoDeCuota, Tono> = {
  pagada: "exito",
  pagada_rendicion: "exito",
  parcial_rendicion: "alerta",
  cancelada: "neutro",
  vencida: "peligro",
  a_vencer: "neutro",
  sin_emitir: "neutro",
};

export const TEXTO_ESTADO_DEL_PLAN: Record<PlanDeUnidad["estado"], string> = {
  pendiente: "Pendiente de aprobación",
  vigente: "Vigente",
  cumplido: "Cumplido",
  caido: "Caído",
  rechazado: "Rechazado",
  retirado: "Retirado",
};

/** «12 cuotas al 2 %», «Hasta 6 cuotas sin interés» (el nombre del catálogo) o «A medida». */
export function nombreDelPlan(p: Pick<PlanDeUnidad, "nombre">): string {
  return p.nombre ?? "A medida";
}

/** Las cuotas sin el anticipo. */
const cuotasSinAnticipo = (p: Pick<PlanDeUnidad, "cuotas">) => p.cuotas.filter((c) => c.numero > 0);

/** Los chips de la cabecera de la ficha cuando la unidad tiene un plan vigente. */
export function etiquetasDelPlan(p: Pick<PlanDeUnidad, "estado" | "nombre" | "cuotas" | "cuotasVencidas" | "cuotasParaCaer">): Etiqueta[] {
  if (p.estado !== "vigente") return [];
  const cuotas = cuotasSinAnticipo(p);
  const pagadas = cuotas.filter((c) => c.estado === "pagada").length;
  const etiquetas: Etiqueta[] = [{ tono: "info", texto: `En plan · ${nombreDelPlan(p)} · ${pagadas} de ${cuotas.length} pagadas` }];
  if (p.cuotasVencidas > 0) {
    // Ámbar mientras falten cuotas para que caiga; rojo cuando ya se puede declarar caído (como el aviso).
    const tono: Tono = p.cuotasVencidas >= p.cuotasParaCaer ? "peligro" : "alerta";
    etiquetas.push({ tono, texto: p.cuotasVencidas === 1 ? "1 cuota vencida" : `${p.cuotasVencidas} cuotas vencidas` });
  }
  return etiquetas;
}

/**
 * El aviso de la caída: cuál venció y cuántas faltan para poder declararlo caído, o que ya se puede.
 * null si no hay ninguna cuota vencida impaga.
 */
export function avisoDeCaida(p: Pick<PlanDeUnidad, "estado" | "cuotas" | "cuotasVencidas" | "cuotasParaCaer">): string | null {
  if (p.estado !== "vigente" || p.cuotasVencidas === 0) return null;
  const vencidas = p.cuotas.filter((c) => c.estado === "vencida");
  const primera = vencidas[0]!;
  const cual =
    vencidas.length === 1
      ? `${primera.numero === 0 ? "El anticipo" : `La cuota ${primera.numero}`} venció el ${formatearFecha(primera.vencimiento)} y no está paga.`
      : `${vencidas.length} cuotas vencidas sin pagar, la primera el ${formatearFecha(primera.vencimiento)}.`;
  const faltan = p.cuotasParaCaer - p.cuotasVencidas;
  const regla = `Con ${p.cuotasParaCaer === 1 ? "1 cuota impaga" : `${p.cuotasParaCaer} cuotas impagas`} el plan cae`;
  return faltan > 0 ? `${cual} ${regla}: ${faltan === 1 ? "falta 1" : `faltan ${faltan}`}.` : `${cual} ${regla}: ya se puede declarar caído.`;
}

/** «junio a octubre 2026», «junio 2026», «noviembre 2026 a enero 2027». */
export function rangoDeMeses(meses: readonly string[]): string {
  if (meses.length === 0) return "—";
  const ordenados = [...meses].sort();
  const desde = ordenados[0]!;
  const hasta = ordenados[ordenados.length - 1]!;
  const nombre = (m: string) => nombreDelPeriodo(m).toLowerCase();
  if (desde === hasta) return nombre(desde);
  if (desde.slice(0, 4) === hasta.slice(0, 4)) return `${nombre(desde).split(" ")[0]} a ${nombre(hasta)}`;
  return `${nombre(desde)} a ${nombre(hasta)}`;
}

/**
 * «Del catálogo · con Estudio Jurídico Demo · cobra el estudio y rinde.» [P2a-2, UX] Sin «acordado por»:
 * el plan guarda el estudio solo si cobra él, así que no se sabe quién lo negoció. El tipo «A medida» ya
 * está en el título.
 */
export function descripcionDelPlan(p: Pick<PlanDeUnidad, "tipo" | "estudio" | "modoCobro">): string {
  const cobra = p.modoCobro === "estudio" ? "cobra el estudio y rinde" : "cobra el barrio, en la boleta";
  const texto = [p.tipo === "catalogo" ? "Del catálogo" : null, p.estudio ? `con ${p.estudio}` : null, cobra].filter((x) => x !== null).join(" · ");
  return `${texto.charAt(0).toUpperCase()}${texto.slice(1)}.`;
}

/** [P2a-2, UX] Las cuotas de un plan pendiente todavía no salen en ninguna boleta. */
export const TEXTO_CUOTA_PROPUESTA = "Propuesta · todavía no sale en la boleta";

/**
 * [P2a-2] El aviso de un plan a medida pendiente: cuánto se perdona y si falta el acta que exige el
 * barrio. Hasta que se apruebe, la deuda de la unidad no cambia.
 */
export function avisoDelPendiente(
  p: Pick<PlanDeUnidad, "estado" | "quita" | "pideActa" | "actaReferencia" | "deuda" | "totalCuotas" | "meses">,
): string | null {
  if (p.estado !== "pendiente") return null;
  const deuda = `una deuda de $ ${formatearMonto(p.deuda)} (${rangoDeMeses(p.meses)})`;
  const quita =
    p.quita === "0.00"
      ? `El cronograma suma $ ${formatearMonto(p.totalCuotas)} y cubre ${deuda}: no se perdona nada.`
      : `Se perdonan $ ${formatearMonto(p.quita)} de ${deuda}: el cronograma suma $ ${formatearMonto(p.totalCuotas)}.`;
  const acta = p.pideActa
    ? p.actaReferencia
      ? ` El acta de aprobación del barrio ya está cargada (${p.actaReferencia}).`
      : " El barrio exige el acta de aprobación (de la comisión directiva, el directorio o la asamblea) para perdonar: todavía no se cargó."
    : "";
  return `${quita}${acta} Hasta que se apruebe, la deuda de la unidad sigue como estaba.`;
}

// [P2a-3] Va acá y no en la isla: la llama la página, en el servidor.
/**
 * El documento que se abre desde la cabecera, y cómo se llama el botón (UX): el firmado si hay uno; si no,
 * el último acuerdo; si no, el último anexo. Cada uno con su nombre, para no decir «acuerdo» de un anexo.
 */
export function documentoParaVer(d: Pick<DocumentosDelPlan, "documentos">) {
  for (const [clase, rotulo] of [
    ["firmado", "Ver el acuerdo firmado"],
    ["acuerdo", "Ver el acuerdo (PDF)"],
    ["anexo", "Ver el anexo (PDF)"],
  ] as const) {
    const doc = d.documentos.find((x) => x.clase === clase);
    if (doc) return { doc, rotulo };
  }
  return null;
}
