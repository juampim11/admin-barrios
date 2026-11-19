/**
 * La «Hoja del ensayo» (encargo F3, tramo 1): al terminar la siembra, una tabla por tema con el enlace
 * directo a cada pantalla que la guía del ensayo nombra. Como los ids de la demo son fijos
 * (`seed-ids-fijos.ts`), dos siembras seguidas dejan la hoja idéntica: por eso se versiona
 * (`docs/demo/hoja-del-ensayo.md`, datos inventados) y la coordinación puede poner los enlaces en la guía.
 *
 * Lo que NO lleva, a propósito: cifras de interés ni de saldos (dependen del día en que se siembra) ni
 * ninguna fecha. Solo ids, nombres y estados que no cambian entre siembras.
 */
import type pg from "pg";
import { claveDeBarrio, claveDeUnidad } from "./seed-ids-fijos.ts";

/** Dónde corre la web en desarrollo (`pnpm dev` del `apps/web`). */
const BASE = "http://localhost:4000";

/**
 * Las unidades que la guía nombra y para qué sirve cada una. Las del encargo F3 (plan a medida de Los Talas,
 * los dos planes del estudio, la derivada de Los Espinillos) y las que ya usaba la guía.
 */
const UNIDADES_CLAVE: ReadonlyArray<{ barrio: string; manzana: string; lote: string; paraQue: string }> = [
  { barrio: "talas", manzana: "1", lote: "1", paraQue: "De la guía del ensayo" },
  { barrio: "talas", manzana: "1", lote: "4", paraQue: "Plan de pagos vigente (3 cuotas fijas)" },
  { barrio: "talas", manzana: "1", lote: "6", paraQue: "Plan de pagos cumplido (2 cuotas fijas)" },
  { barrio: "talas", manzana: "1", lote: "8", paraQue: "Plan de pagos caído (francés al 2 %)" },
  { barrio: "talas", manzana: "1", lote: "11", paraQue: "Plan que cobra el estudio (12 cuotas) · rendición confirmada" },
  { barrio: "talas", manzana: "2", lote: "1", paraQue: "Plan que cobra el estudio (12 cuotas) · rendición pendiente" },
  { barrio: "talas", manzana: "1", lote: "20", paraQue: "Plan a medida pendiente de aprobar (la mora se perdona)" },
  { barrio: "talas", manzana: "1", lote: "3", paraQue: "Saldo a favor aplicado en la boleta del mes en curso ($ 25.000)" },
  { barrio: "aromos", manzana: "25", lote: "10", paraQue: "De la guía del ensayo" },
  { barrio: "aromos", manzana: "9", lote: "24", paraQue: "De la guía del ensayo" },
  { barrio: "aromos", manzana: "11", lote: "2", paraQue: "De la guía del ensayo" },
  { barrio: "aromos", manzana: "16", lote: "15", paraQue: "De la guía del ensayo" },
  { barrio: "aromos", manzana: "8", lote: "21", paraQue: "De la guía del ensayo" },
  { barrio: "espinillos", manzana: "1", lote: "1", paraQue: "De la guía del ensayo" },
  { barrio: "espinillos", manzana: "1", lote: "2", paraQue: "De la guía del ensayo" },
  { barrio: "espinillos", manzana: "1", lote: "3", paraQue: "De la guía del ensayo" },
  { barrio: "espinillos", manzana: "4", lote: "6", paraQue: "Para derivar a un estudio (debe los dos meses)" },
];

const celda = (texto: string): string => texto.replaceAll("|", "\\|");
const tabla = (cabecera: readonly string[], filas: readonly (readonly string[])[]): string =>
  [
    `| ${cabecera.join(" | ")} |`,
    `| ${cabecera.map(() => "---").join(" | ")} |`,
    ...filas.map((f) => `| ${f.map(celda).join(" | ")} |`),
  ].join("\n");
const enlace = (ruta: string): string => `${BASE}${ruta}`;

/** Arma la hoja leyendo la base ya sembrada y con los ids ya fijos. Falla si falta una unidad clave. */
export async function armarHojaDelEnsayo(cliente: pg.Client, mesEnCurso: string): Promise<string> {
  // El mes como distancia al actual, no «2026-11»: la hoja versionada no cambia de un mes a otro.
  const meses = (p: string): number => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7));
  const distancia = (p: string): number => meses(p) - meses(mesEnCurso);
  const mesDe = (p: string): string => {
    const d = distancia(p);
    if (d === 0) return "Mes en curso";
    if (d === -1) return "Mes anterior";
    return d < 0 ? `${-d} meses atrás` : d === 1 ? "Mes siguiente" : `${d} meses adelante`;
  };
  const { rows: barrios } = await cliente.query<{ id: string; nombre: string }>(
    "select id, nombre from tenant_node where tipo = 'barrio'",
  );
  const porClave = new Map(barrios.map((b) => [claveDeBarrio(b.nombre), b]));
  const ordenados = [...porClave.entries()].sort(([a], [b]) => a.localeCompare(b, "es"));

  const filasBarrios = ordenados.map(([, b]) => [b.nombre, `\`${b.id}\``, enlace(`/${b.id}/tablero`)]);

  const { rows: unidades } = await cliente.query<{ id: string; barrio_id: string; manzana: string; lote: string; tiene_plan: boolean }>(
    `select u.id, u.barrio_id, u.manzana, u.lote,
            exists (select 1 from plan_pago p where p.unidad_funcional_id = u.id) as tiene_plan
       from unidad_funcional u`,
  );
  const unidadDe = new Map(
    unidades.map((u) => {
      const b = barrios.find((x) => x.id === u.barrio_id);
      return [claveDeUnidad(b ? claveDeBarrio(b.nombre) : u.barrio_id, u.manzana, u.lote), u] as const;
    }),
  );
  const filasUnidades = UNIDADES_CLAVE.map((k) => {
    const barrio = porClave.get(k.barrio);
    const u = unidadDe.get(claveDeUnidad(k.barrio, k.manzana, k.lote));
    if (!barrio || !u) throw new Error(`seed: la hoja del ensayo nombra ${k.barrio} Mza ${k.manzana} · Lote ${k.lote} y no está sembrada`);
    return [
      barrio.nombre,
      `Mza ${k.manzana} · Lote ${k.lote}`,
      k.paraQue,
      enlace(`/${barrio.id}/mora/${u.id}`),
      u.tiene_plan ? enlace(`/${barrio.id}/mora/${u.id}/plan`) : "—",
    ];
  });

  const { rows: periodos } = await cliente.query<{ barrio_id: string; id: string; periodo: string; estado: string }>(
    "select barrio_id, id, periodo, estado::text as estado from periodo_expensa where origen = 'mensual'",
  );
  const filasMeses = periodos
    .map((p) => ({ p, b: barrios.find((x) => x.id === p.barrio_id)! }))
    .sort((x, y) => x.b.nombre.localeCompare(y.b.nombre, "es") || distancia(x.p.periodo) - distancia(y.p.periodo))
    .map(({ p, b }) => [b.nombre, mesDe(p.periodo), p.estado, enlace(`/${b.id}/liquidacion/${p.id}`)]);

  const { rows: rendiciones } = await cliente.query<{ id: string; barrio_id: string; periodo: string; estado: string; estudio: string }>(
    `select r.id, r.barrio_id, r.periodo, r.estado, e.nombre as estudio
       from plan_rendicion r join estudio_juridico e on e.id = r.estudio_id`,
  );
  const filasRendiciones = rendiciones
    .map((r) => ({ r, b: barrios.find((x) => x.id === r.barrio_id)! }))
    .sort(
      (x, y) =>
        x.b.nombre.localeCompare(y.b.nombre, "es") || distancia(x.r.periodo) - distancia(y.r.periodo) || x.r.estado.localeCompare(y.r.estado, "es"),
    )
    .map(({ r, b }) => [b.nombre, r.estudio, mesDe(r.periodo), r.estado, enlace(`/${b.id}/rendiciones/${r.id}`)]);

  return [
    "# Hoja del ensayo",
    "",
    "> Generada por `pnpm db:seed` (`packages/data/scripts/seed-hoja-del-ensayo.ts`). **No se edita a mano.**",
    "> Los datos son inventados y los ids son fijos (UUID v5 de una clave legible), iguales en cada siembra:",
    `> los enlaces valen mientras la web corra en \`${BASE}\`. No lleva cifras de interés ni fechas porque dependen del día.`,
    "",
    "## Barrios",
    "",
    tabla(["Barrio", "Id", "Tablero"], filasBarrios),
    "",
    "## Unidades clave",
    "",
    "La ficha de mora de cada unidad y, si tiene plan de pagos, su plan.",
    "",
    tabla(["Barrio", "Unidad", "Para qué", "Ficha de mora", "Plan de pagos"], filasUnidades),
    "",
    "## Meses",
    "",
    "La liquidación de cada mes de cada barrio. El mes va como distancia al mes en curso (no como año-mes), para que la hoja y los ids no cambien de un mes a otro.",
    "",
    tabla(["Barrio", "Mes", "Estado", "Liquidación"], filasMeses),
    "",
    "## Rendiciones de estudios",
    "",
    tabla(["Barrio", "Estudio", "Mes", "Estado", "Rendición"], filasRendiciones),
    "",
  ].join("\n");
}
