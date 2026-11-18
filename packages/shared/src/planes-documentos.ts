/**
 * Los documentos de un plan de pagos (encargo P2a-3): el modelo de cláusulas, cómo se completa y los
 * esquemas de lo que llega de los formularios. Sin E/S.
 *
 * El modelo es uno por administración y por estudio, con el general de la administración como respaldo
 * (`plan_modelo_clausulas`, `0096`). Nace con `CLAUSULAS_BORRADOR` y con la leyenda «Texto a validar por
 * el estudio» hasta que alguien lo marca validado: el borrador lo escribió el sistema, no un abogado.
 *
 * Las cláusulas llevan variables entre llaves (`{deuda}`, `{cuotasParaCaer}`…). Las completa el armado
 * de la vista del PDF con las cifras del plan (`completarClausula`); una variable que no existe se
 * rechaza al guardar, para que no salga impresa entre llaves.
 */

import { z } from "zod";
import { idSchema } from "./consultas.ts";

/** Lo que dice el PDF y la pantalla mientras el modelo no está validado. */
export const LEYENDA_TEXTO_A_VALIDAR = "Texto a validar por el estudio";

export const MAXIMO_CLAUSULAS = 20;
export const MAXIMO_TITULO_CLAUSULA = 120;
export const MAXIMO_TEXTO_CLAUSULA = 4000;

export type Clausula = { readonly titulo: string; readonly texto: string };

/** Las variables que se pueden usar en una cláusula, con lo que dicen (la ayuda de la pantalla). */
export const VARIABLES_DE_CLAUSULA = {
  barrio: "El nombre del barrio.",
  unidad: "La unidad (manzana y lote).",
  titular: "Quién figura como titular de la unidad.",
  deuda: "La deuda que entra al plan, en pesos.",
  quita: "Lo que se perdona, en pesos.",
  totalDelPlan: "Lo que suma el cronograma, en pesos.",
  cuotas: "La cantidad de cuotas, sin el anticipo.",
  cuotasParaCaer: "Con cuántas cuotas vencidas sin pagar se puede dar el plan por caído, con la palabra («2 cuotas vencidas»).",
} as const;
export type VariableDeClausula = keyof typeof VARIABLES_DE_CLAUSULA;
export const NOMBRES_DE_VARIABLES = Object.keys(VARIABLES_DE_CLAUSULA) as VariableDeClausula[];

/**
 * El borrador con el que nace todo modelo: las tres cláusulas que pidió el titular (encargo P2a-3) y
 * que P1 dejó anotadas como decisión abierta (HANDOFF, «El texto del acuerdo»): el plan no reemplaza la
 * deuda original, la quita depende de cumplirlo y la caída tiene su cargo.
 *
 * Redactado en positivo y sin el vocabulario que el sistema no usa en sus documentos
 * (`lenguaje-prohibido.ts`): ni intimaciones ni medidas que nadie decidió. Lo valida el estudio.
 */
export const CLAUSULAS_BORRADOR: readonly Clausula[] = [
  {
    titulo: "El plan no reemplaza la deuda original",
    texto:
      "Este plan no reemplaza la deuda de la unidad {unidad} con {barrio}, que es de {deuda} y sale de los meses que detalla el anexo: " +
      "solo fija cómo se paga. Cada cuota que se paga cancela la parte de esa deuda que indica el anexo.",
  },
  {
    titulo: "La quita depende de cumplir el plan",
    // Sirve con quita y sin ella (UX): un plan del catálogo no perdona nada y la cláusula no puede decir
    // «acepta no cobrar $ 0,00».
    texto:
      "Si este plan incluye una quita (en este caso, {quita}), queda perdonada recién cuando se paga la última cuota. " +
      "Si el plan no se cumple, la quita deja de valer.",
  },
  {
    titulo: "Si el plan cae, tiene su cargo",
    texto:
      "Si quedan {cuotasParaCaer} sin pagar, {barrio} puede dar el plan por caído. Entonces lo pagado se " +
      "imputa a la deuda original, la quita deja de valer y la deuda vuelve a llevar el interés por mora que fija {barrio} " +
      "desde el vencimiento de cada expensa: ese es el cargo de la caída.",
  },
];

/** Las variables entre llaves que no existen, en el orden en que aparecen y sin repetir. */
export function variablesDesconocidas(texto: string): string[] {
  const vistas = new Set<string>();
  for (const m of texto.matchAll(/\{([^{}]*)\}/g)) {
    const nombre = m[1] ?? "";
    // `Object.hasOwn` y no `in`: `{constructor}` o `{toString}` existen en el prototipo (code-reviewer).
    if (!Object.hasOwn(VARIABLES_DE_CLAUSULA, nombre)) vistas.add(nombre);
  }
  return [...vistas];
}

/** Completa las variables de una cláusula. Lo que no es una variable conocida queda como está. */
export function completarClausula(texto: string, valores: Readonly<Record<VariableDeClausula, string>>): string {
  return texto.replace(/\{([^{}]*)\}/g, (entera, nombre: string) =>
    Object.hasOwn(VARIABLES_DE_CLAUSULA, nombre) ? valores[nombre as VariableDeClausula] : entera,
  );
}

const clausulaSchema = z.object({
  titulo: z.string().trim().min(1, "Cada cláusula lleva un título.").max(MAXIMO_TITULO_CLAUSULA, `El título, hasta ${MAXIMO_TITULO_CLAUSULA} caracteres.`),
  texto: z.string().trim().min(1, "Cada cláusula lleva su texto.").max(MAXIMO_TEXTO_CLAUSULA, `El texto, hasta ${MAXIMO_TEXTO_CLAUSULA} caracteres.`),
});

/** Crear el modelo de una administración (general) o de un estudio, con el borrador. */
export const crearModeloDeClausulasSchema = z.object({
  administracionId: idSchema,
  estudioId: z.preprocess((v) => (v === "" || v === "general" ? null : v), idSchema.nullable()),
});
export type CrearModeloDeClausulas = z.input<typeof crearModeloDeClausulasSchema>;

/**
 * Guardar un modelo. Las cláusulas llegan como JSON: la acción lo arma con los campos `titulo.N` y
 * `texto.N` del editor (`configuracion/estudios/modelos.tsx`). El «validado» es un sí o un no.
 */
export const guardarModeloDeClausulasSchema = z
  .object({
    modeloId: idSchema,
    clausulas: z.preprocess(
      (v) => {
        if (typeof v !== "string") return v;
        try {
          return JSON.parse(v) as unknown;
        } catch {
          return null;
        }
      },
      z
        .array(clausulaSchema, { message: "Cargá las cláusulas del modelo." })
        .min(1, "El modelo lleva al menos una cláusula.")
        .max(MAXIMO_CLAUSULAS, `Hasta ${MAXIMO_CLAUSULAS} cláusulas.`),
    ),
    textoValidado: z.enum(["si", "no"], { message: "Elegí una opción." }).transform((v) => v === "si"),
  })
  .superRefine((v, ctx) => {
    v.clausulas.forEach((c, i) => {
      const malas = variablesDesconocidas(`${c.titulo} ${c.texto}`);
      if (malas.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["clausulas"],
          message: `La cláusula ${i + 1} usa {${malas[0]}}, que no es una de las variables. Las que hay: ${NOMBRES_DE_VARIABLES.map((n) => `{${n}}`).join(", ")}.`,
        });
      }
    });
  });
export type GuardarModeloDeClausulas = z.input<typeof guardarModeloDeClausulasSchema>;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Los documentos del plan
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Las clases de documento (`plan_documento.clase`). `acuerdo` y `anexo` los arma el sistema (los dos
 * caminos); `firmado` y `del_estudio` se suben.
 */
export const CLASES_DOCUMENTO_PLAN = ["acuerdo", "anexo", "firmado", "del_estudio"] as const;
export type ClaseDocumentoPlan = (typeof CLASES_DOCUMENTO_PLAN)[number];

export const TEXTO_CLASE_DOCUMENTO_PLAN: Record<ClaseDocumentoPlan, string> = {
  acuerdo: "Acuerdo con el modelo de cláusulas y el anexo",
  anexo: "Anexo con las cifras (para el documento del estudio)",
  firmado: "Acuerdo firmado",
  del_estudio: "Documento del estudio",
};

/** Los dos caminos del PDF que arma el sistema (encargo P2a-3, punto 3). */
export const CAMINOS_DEL_ACUERDO = ["modelo", "anexo"] as const;
export type CaminoDelAcuerdo = (typeof CAMINOS_DEL_ACUERDO)[number];

/** Pedir el PDF del plan por uno de los dos caminos. */
export const armarDocumentoDelPlanSchema = z.object({
  planId: idSchema,
  camino: z.enum(CAMINOS_DEL_ACUERDO, { message: "Elegí qué documento armar." }),
});
export type ArmarDocumentoDelPlan = z.input<typeof armarDocumentoDelPlanSchema>;

/** Los tipos de archivo que se suben (los mismos del comprobante y del adjunto de una gestión). */
export const TIPOS_DE_DOCUMENTO_SUBIDO = ["application/pdf", "image/jpeg", "image/png"] as const;

/** Pedir la clave para subir un documento del plan (paso previo, como el adjunto de una gestión). */
export const prepararSubidaDeDocumentoDelPlanSchema = z.object({
  planId: idSchema,
  contentType: z.enum(TIPOS_DE_DOCUMENTO_SUBIDO, { message: "El archivo tiene que ser un PDF, JPG o PNG." }),
});
export type PrepararSubidaDeDocumentoDelPlan = z.input<typeof prepararSubidaDeDocumentoDelPlanSchema>;

/** Agregar un documento subido: el firmado o el del estudio. */
export const agregarDocumentoDelPlanSchema = z.object({
  planId: idSchema,
  clase: z.enum(["firmado", "del_estudio"], { message: "Elegí qué documento es." }),
  clave: z.string().min(1, "Elegí el archivo y esperá a que diga «listo para enviar».").max(300),
  nombre: z.string().trim().min(1, "Falta el nombre del archivo.").max(200, "El nombre del archivo, hasta 200 caracteres."),
});
export type AgregarDocumentoDelPlan = z.input<typeof agregarDocumentoDelPlanSchema>;
