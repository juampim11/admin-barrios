/**
 * La rendición manual del estudio (encargo P2b, pantalla 5 de la maqueta de planes de pago).
 *
 * Cuando un plan lo cobra el estudio, la cuota no está en la boleta del barrio: el vecino le paga al
 * estudio, el estudio retiene sus honorarios (que **nunca** entran acá) y le rinde al barrio lo de las
 * cuotas. La rendición es ese informe: qué cuotas cobró (con pago parcial permitido), cómo le pagó el
 * vecino (solo un dato, es entre ellos) y cómo le llegó la plata al barrio (una o varias
 * transferencias o depósitos a su cuenta). En la v1 la carga la administración; el estudio todavía no
 * entra al sistema.
 *
 * Se confirma solo cuando la suma de las cuotas es igual a la de los ingresos. Al confirmarla, cada
 * pedazo de ingreso queda como un pago imputado directo a su cuota (`app.plan_rendicion_confirmar`).
 * Lo que decide de verdad lo decide la base (`0097`); estos esquemas validan la forma en el borde.
 */
import { z } from "zod";
import { idSchema } from "./consultas.ts";
import { aCentavos, montoSchema } from "./dinero.ts";
import { fechaIsoSchema } from "./fechas.ts";

/** Cómo le pagó el vecino al estudio: solo un dato. */
export const MEDIOS_DEL_VECINO = ["efectivo", "cheque", "transferencia", "deposito", "otro"] as const;
export type MedioDelVecino = (typeof MEDIOS_DEL_VECINO)[number];
export const NOMBRE_MEDIO_DEL_VECINO: Record<MedioDelVecino, string> = {
  efectivo: "efectivo",
  cheque: "cheque",
  transferencia: "transferencia",
  deposito: "depósito",
  otro: "otro medio",
};

/** Cómo le llega la plata al barrio: por banco, para que aparezca en el extracto. */
export const MEDIOS_DEL_INGRESO = ["transferencia", "deposito"] as const;
export type MedioDelIngreso = (typeof MEDIOS_DEL_INGRESO)[number];
export const NOMBRE_MEDIO_DEL_INGRESO: Record<MedioDelIngreso, string> = {
  transferencia: "Transferencia",
  deposito: "Depósito",
};

export const ESTADOS_RENDICION = ["borrador", "confirmada"] as const;
export type EstadoRendicion = (typeof ESTADOS_RENDICION)[number];

const importeSchema = montoSchema.refine((m) => aCentavos(m) > 0n, "El importe tiene que ser mayor que cero.");
const periodoSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Elegí el mes que rinde el estudio.");
/** El nombre original de un archivo: se guarda solo para mostrarlo, nunca va en la clave. */
export const nombreDeArchivoSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\\/\p{Cc}]/gu, "").slice(0, 200))
  .nullable();

export const crearRendicionSchema = z.object({
  barrioId: idSchema,
  estudioId: idSchema,
  periodo: periodoSchema,
  /**
   * F4 tramo 2: ya hay una rendición de ese estudio para ese mes y quien carga confirmó que es otra. Lista
   * cerrada de lo que cuenta como «sí»; la ausencia es «no confirmó».
   */
  confirmarOtraRendicion: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "on" || v === "1")
    .default(false),
});
export type CrearRendicion = z.input<typeof crearRendicionSchema>;

export const agregarCuotaARendicionSchema = z.object({
  rendicionId: idSchema,
  planCuotaId: z.string().min(1, "Elegí la cuota que cobró el estudio.").pipe(idSchema),
  importe: importeSchema,
  fechaCobro: fechaIsoSchema,
  medioVecino: z.enum(MEDIOS_DEL_VECINO, { message: "Elegí cómo le pagó el vecino al estudio." }),
});
export type AgregarCuotaARendicion = z.infer<typeof agregarCuotaARendicionSchema>;

export const prepararSubidaDeRendicionSchema = z.object({
  rendicionId: idSchema,
  /** El PDF firmado de la rendición, o el comprobante de un ingreso. */
  para: z.enum(["pdf", "ingreso"]),
  contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
});
export type PrepararSubidaDeRendicion = z.infer<typeof prepararSubidaDeRendicionSchema>;

export const adjuntarPdfDeRendicionSchema = z.object({
  rendicionId: idSchema,
  clave: z.string().min(1),
  nombre: nombreDeArchivoSchema,
});
export type AdjuntarPdfDeRendicion = z.infer<typeof adjuntarPdfDeRendicionSchema>;

export const agregarIngresoARendicionSchema = z.object({
  rendicionId: idSchema,
  fecha: fechaIsoSchema,
  medio: z.enum(MEDIOS_DEL_INGRESO, { message: "Elegí si fue una transferencia o un depósito." }),
  importe: importeSchema,
  clave: z.string().min(1, "Adjuntá el comprobante de la transferencia o la boleta de depósito."),
  nombre: nombreDeArchivoSchema,
});
export type AgregarIngresoARendicion = z.infer<typeof agregarIngresoARendicionSchema>;
