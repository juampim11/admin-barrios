/**
 * `VistaBoleta` — el modelo de vista de la boleta de expensas (ADR-0001 §4.1).
 *
 * **Es la pieza que sobrevive a todo.** El dominio no produce HTML ni PDF: produce este objeto
 * plano, validado con Zod, con todo ya resuelto y formateado. De acá salen el PDF, el email HTML y
 * la vista web, y por eso los tres dicen exactamente lo mismo, con o sin Chromium. Se congela junto
 * con el documento emitido (`documento_liquidacion.vista`), que es lo que permite explicar una
 * boleta de hace un año sin volver a correr la liquidación.
 *
 * Tres reglas que este archivo hace cumplir, y que no dependen de que nadie se acuerde:
 *
 *  1. **El dinero cierra.** Las líneas suman el total del período; el total a pagar es el total del
 *     período más saldo anterior más interés; y el importe del cupón es **el mismo** que el del
 *     titular (doc 09 §E.6 — si alguna vez difieren, es un bug, no un caso).
 *  2. **Nada se omite aunque valga cero** (doc 07 §B): saldo anterior, interés y los dos totales
 *     son campos obligatorios del tipo, no renglones opcionales de la plantilla.
 *  3. **Lo que el sistema no sabe, no se inventa.** El interés `null` significa "pendiente de
 *     definición", no cero; los datos que el diseño pide y el modelo todavía no guarda (doc 09
 *     §E.11) están declarados **opcionales y enumerados en `faltantes`**.
 */

import { z } from "zod";
import { aCentavos, deCentavos } from "../dinero.ts";
import { FIGURAS_JURIDICAS } from "../barrio.ts";
import { ESTADOS_PERIODO } from "../liquidacion.ts";
import { bloquePagoSchema } from "./bloque-pago.ts";
import {
  cifraSchema,
  coeficienteImpresoSchema,
  fechaImpresaSchema,
  logoDocumentoSchema,
} from "./primitivas.ts";

/** Viaja con el documento guardado: un cambio incompatible sube el número (ADR-0001 §6). */
export const VERSION_VISTA_BOLETA = "boleta/1";

// --- Marca (white-label, doc 09 §E.9) -----------------------------------------------------------

/**
 * La marca es de **dos niveles**, no de uno (doc 09 §E.9.0). El barrio es la identidad que el vecino
 * reconoce y va arriba y grande; la administración es el **emisor legal** y va en letra chica. Un
 * administrador gestiona varios barrios y cada uno conserva su identidad: confundirlos produce
 * boletas donde el vecino no sabe de quién es la cuenta.
 *
 * *(ADR-0001 §4.3 ilustra un `MarcaDocumento` de un solo nivel; se implementa el de dos porque doc
 * 09 §E.9.0 lo corrigió el mismo día y da una hoja distinta. Anotado en el handoff.)*
 */
export const marcaDocumentoSchema = z
  .object({
    barrio: z
      .object({
        /** Nombre comercial: **el logo ya lo dice, pero va igual en texto real** (§E.9.2.bis). */
        nombre: z.string().min(1),
        logo: logoDocumentoSchema.nullable(),
        /** Ya normalizado a ≥ 4,5:1 contra blanco por `acentoImpreso()`. */
        acentoHex: z.string().regex(/^#[0-9a-f]{6}$/, "el acento va como #rrggbb en minúsculas"),
      })
      .readonly(),
    emisor: z
      .object({
        razonSocial: z.string().min(1),
        cuit: z.string().regex(/^\d{11}$/).nullable(),
        domicilio: z.string().min(1).nullable(),
        contacto: z.string().min(1).nullable(),
        logo: logoDocumentoSchema.nullable(),
      })
      .readonly(),
    /** Leyendas propias de la administración. Pasan por el filtro del doc 07 §E igual que las nuestras. */
    pie: z.array(z.string().min(1)).readonly(),
  })
  .readonly();
export type MarcaDocumento = z.infer<typeof marcaDocumentoSchema>;

// --- Líneas del detalle -------------------------------------------------------------------------

/** De dónde sale la línea. Espejo exacto de `item_liquidacion.clase_item`. */
export const CLASES_ITEM_BOLETA = ["prorrateo", "cuota_fija", "cargo", "descuento"] as const;
export const claseItemBoletaSchema = z.enum(CLASES_ITEM_BOLETA);
export type ClaseItemBoleta = (typeof CLASES_ITEM_BOLETA)[number];

/**
 * La clasificación del art. 2048 **tal como se imprime** en la columna "Tipo". Es obligatoria
 * (doc 07 §C.1); la clasificación **fiscal** no va en el PDF de la unidad.
 *
 * `no_corresponde` es el residuo honesto: un alquiler de quincho no es ordinaria ni extraordinaria,
 * y meterlo en el enum contaminaría el subtotal de ordinarias y, con eso, el certificado de deuda.
 */
export const CLASIFICACIONES_2048 = ["ordinaria", "extraordinaria", "fondo_reserva", "no_corresponde"] as const;
export const clasificacion2048Schema = z.enum(CLASIFICACIONES_2048);
export type Clasificacion2048 = (typeof CLASIFICACIONES_2048)[number];

export const lineaDetalleSchema = z
  .object({
    concepto: z.string().min(1),
    clase: claseItemBoletaSchema,
    clasificacion2048: clasificacion2048Schema,
    /**
     * El gasto **entero del barrio** que se repartió — no algo que se le cobra a esta unidad. Por
     * eso el encabezado dice "Gasto del período" y no "Base" (doc 07 §B). `null` cuando la línea no
     * sale de un prorrateo.
     */
    gastoDelPeriodo: cifraSchema.nullable(),
    coeficiente: coeficienteImpresoSchema.nullable(),
    importe: cifraSchema,
    /** `gasto × coeficiente` redondeado: la cuenta que se rehace con calculadora. */
    importeTeorico: cifraSchema.nullable(),
    /** `importe − importeTeorico`: el resto del reparto, explícito en vez de escondido. */
    ajusteRedondeo: cifraSchema,
    /** Respaldo **en positivo** (doc 07 §D): "Acta de Asamblea N.º 47 del 12/05/2026". */
    respaldo: z.string().min(1).nullable(),
    /** El hecho que originó un cargo: "sáb 12/07 · 1 turno" (doc 08 §K). */
    detalleHecho: z.string().min(1).nullable(),
    marcadorNota: z.number().int().positive().nullable(),
  })
  .readonly();
export type LineaDetalle = z.infer<typeof lineaDetalleSchema>;

// --- Zona 2: la composición del total -----------------------------------------------------------

export const renglonComposicionSchema = z
  .object({
    etiqueta: z.string().min(1),
    importe: cifraSchema,
    /**
     * Renglón que **se imprime y no suma**. Hoy el único caso es la bonificación no aplicada, que
     * el sistema todavía no puede producir: no es un `item_liquidacion` (violaría el signo y la
     * biyección) y no tiene dónde guardarse (doc 09 §E.11 ítem 5). El tipo lo contempla para que el
     * día que exista la pieza no haya que tocar el contrato.
     */
    informativo: z.boolean(),
    /** "no aplicada · evaluada al 30/06/2026". */
    aclaracion: z.string().min(1).nullable(),
    marcadorNota: z.number().int().positive().nullable(),
  })
  .readonly();
export type RenglonComposicion = z.infer<typeof renglonComposicionSchema>;

export const totalesSchema = z
  .object({
    delPeriodo: cifraSchema,
    saldoAnterior: cifraSchema,
    /**
     * `null` = **pendiente de definición**: el barrio no tiene tasa cargada a la fecha de emisión.
     * Un `0,00` sería afirmar que no hay interés, y el sistema no puede afirmarlo (doc 09 §E.4.2,
     * caso E). Espejo de `liquidacion.mora_pendiente_definicion`.
     */
    interes: cifraSchema.nullable(),
    aPagar: cifraSchema,
  })
  .readonly();

/**
 * El interés **siempre** declara base, tasa, días y hasta qué fecha se computó (doc 07 §B).
 *
 * Los tres últimos son **nullable, y eso no es laxitud**: el check de la base
 * (`liquidacion_mora_verificable_chk`) exime del par (días, fecha de corte) al caso
 * `interes_mora = 0`, así que el camino cotidiano —unidad al día, con tasa cargada— llega sin fecha
 * de corte. La hoja tiene que poder decir "no corresponde" en vez de inventar la fecha de hoy: un
 * dato faltante se declara faltante (doc 01 §3.4).
 */
export const detalleInteresSchema = z
  .object({
    base: cifraSchema,
    /** Tasa mensual ya formateada: `"3,0000"` (el `%` y la palabra "mensual" los pone la plantilla). */
    tasaMensualTexto: z.string().min(1).nullable(),
    dias: z.number().int().nonnegative().nullable(),
    computadoHasta: fechaImpresaSchema.nullable(),
  })
  .readonly();

// --- Zona 1: bandas de estado -------------------------------------------------------------------

export const CLAVES_BANDA = [
  "al_dia",
  "saldo_anterior",
  "bonificacion_aplicada",
  "bonificacion_no_aplicada",
  "interes_pendiente",
  "vista_previa",
] as const;

/**
 * Marca no cromática de la banda. **Nunca se comunica solo por color** (doc 09 §E.8.3): la hoja en
 * escala de grises tiene que decir lo mismo. Es una clave semántica, no un glifo: un glifo faltante
 * se renderiza como **nada** y perderíamos justo la marca que importa (doc 07 §B).
 */
export const MARCAS_BANDA = ["ok", "atencion", "estrella", "info", "pregunta", "borrador"] as const;

export const bandaEstadoSchema = z
  .object({
    clave: z.enum(CLAVES_BANDA),
    marca: z.enum(MARCAS_BANDA),
    titulo: z.string().min(1),
    texto: z.string().min(1),
  })
  .readonly();
export type BandaEstado = z.infer<typeof bandaEstadoSchema>;

// --- La vista completa --------------------------------------------------------------------------

export const notaDocumentoSchema = z
  .object({ marcador: z.number().int().positive(), texto: z.string().min(1) })
  .readonly();

export const vistaBoletaSchema = z
  .object({
    version: z.literal(VERSION_VISTA_BOLETA),
    marca: marcaDocumentoSchema,
    barrio: z
      .object({
        nombre: z.string().min(1),
        figuraJuridica: z.enum(FIGURAS_JURIDICAS),
        domicilio: z.string().min(1).nullable(),
      })
      .readonly(),
    /** Del PDF sale **solo el mínimo**: unidad y nombre del obligado (doc 07 §F). */
    unidad: z
      .object({
        etiqueta: z.string().min(1),
        destinatario: z.string().min(1),
        /**
         * **Opcional a propósito.** El wireframe imprime "PÉREZ, ANA — propietaria", pero
         * `liquidacion.obligado_id` guarda "el obligado notificado" sin rol imprimible: ese rótulo
         * hoy es una suposición (doc 09 §E.11 ítem 9). Mientras no exista el dato, no se imprime.
         */
        rolDestinatario: z.string().min(1).optional(),
      })
      .readonly(),
    periodo: z
      .object({
        codigo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        etiqueta: z.string().min(1),
        /** "expensa" / "cuota social" / "aporte": snapshot congelado del período. */
        denominacionConcepto: z.string().min(1),
        estado: z.enum(ESTADOS_PERIODO),
      })
      .readonly(),
    emision: z
      .object({
        /** `null` mientras el período no se emitió: **no se rellena con la fecha de hoy**. */
        fecha: fechaImpresaSchema.nullable(),
        /**
         * Hoy `liquidacion.numero_comprobante` es texto libre **nullable**, sin serie ni
         * correlativo (doc 09 §E.11 ítem 4). Se imprime lo que haya, o nada.
         */
        comprobante: z.string().min(1).nullable(),
      })
      .readonly(),
    /** Máximo 3, con orden fijo y slots de altura reservada (doc 09 §E.4.1). */
    bandas: z.array(bandaEstadoSchema).max(3).readonly(),
    composicion: z.array(renglonComposicionSchema).min(1).readonly(),
    totales: totalesSchema,
    interes: detalleInteresSchema.nullable(),
    detalle: z
      .object({
        /** "El barrio gastó $X en 07/2026": `periodo_expensa.total_gastos`. */
        gastoDelBarrio: cifraSchema,
        coeficiente: coeficienteImpresoSchema,
        lineas: z.array(lineaDetalleSchema).readonly(),
        /** El detalle desbordó el alto de la zona 3 y sigue al dorso. */
        continuaAlDorso: z.boolean(),
      })
      .readonly(),
    bloquePago: bloquePagoSchema,
    notas: z.array(notaDocumentoSchema).readonly(),
    /** Redactadas **solo en positivo** (doc 07 §E). */
    leyendas: z.array(z.string().min(1)).readonly(),
    /**
     * Datos que el diseño pide y el sistema **todavía no guarda** (doc 09 §E.11), con el nombre del
     * hueco. Viaja congelado con el documento: el día que el dato exista, se sabe exactamente qué
     * boletas se emitieron sin él. No se imprime.
     */
    faltantes: z.array(z.string().min(1)).readonly(),
  })
  .superRefine((v, ctx) => {
    const error = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    // --- El dinero cierra ---------------------------------------------------------------------
    const sumaLineas = v.detalle.lineas.reduce((a, l) => a + aCentavos(l.importe.monto), 0n);
    if (sumaLineas !== aCentavos(v.totales.delPeriodo.monto)) {
      error(
        ["totales", "delPeriodo"],
        `las líneas suman ${deCentavos(sumaLineas)} y el total del período dice ${v.totales.delPeriodo.monto}`,
      );
    }

    const sumaComposicion = v.composicion
      .filter((r) => !r.informativo)
      .reduce((a, r) => a + aCentavos(r.importe.monto), 0n);
    if (sumaComposicion !== aCentavos(v.totales.delPeriodo.monto)) {
      error(
        ["composicion"],
        `la composición suma ${deCentavos(sumaComposicion)} y el total del período dice ${v.totales.delPeriodo.monto}`,
      );
    }

    const interesCentavos = v.totales.interes ? aCentavos(v.totales.interes.monto) : 0n;
    const aPagarEsperado =
      aCentavos(v.totales.delPeriodo.monto) + aCentavos(v.totales.saldoAnterior.monto) + interesCentavos;
    if (aPagarEsperado !== aCentavos(v.totales.aPagar.monto)) {
      error(
        ["totales", "aPagar"],
        `total del período + saldo anterior + interés da ${deCentavos(aPagarEsperado)}, no ${v.totales.aPagar.monto}`,
      );
    }

    // --- Una sola fuente para el importe repetido (doc 09 §E.6) --------------------------------
    if (v.bloquePago.importes.alVencimiento.monto !== v.totales.aPagar.monto) {
      error(
        ["bloquePago", "importes", "alVencimiento"],
        "el importe del cupón no es el mismo que el TOTAL A PAGAR: si difieren, es un bug, no un caso",
      );
    }

    // --- El interés se explica o se declara pendiente ------------------------------------------
    if (v.totales.interes === null && v.interes !== null) {
      error(["interes"], "el interés está pendiente de definición: no puede traer base, tasa y días");
    }
    if (v.totales.interes !== null && v.interes === null) {
      error(["interes"], "todo interés declara base, tasa, días y fecha de corte (doc 07 §B)");
    }
    if (v.totales.interes !== null && v.interes !== null && v.interes.base.monto !== v.totales.saldoAnterior.monto) {
      error(["interes", "base"], "la base del interés tiene que ser el saldo anterior que se imprime");
    }
    // Un interés que se cobra tiene que poder rehacerse: sin tasa, sin días o sin fecha de corte, la
    // cifra no es verificable y no se imprime (doc 07 §B). En cero, en cambio, el par (días, fecha)
    // puede faltar legítimamente y la hoja lo dice.
    if (v.totales.interes !== null && aCentavos(v.totales.interes.monto) !== 0n && v.interes !== null) {
      const falta = [
        v.interes.tasaMensualTexto === null ? "la tasa" : null,
        v.interes.dias === null ? "los días" : null,
        v.interes.computadoHasta === null ? "la fecha de corte" : null,
      ].filter((x): x is string => x !== null);
      if (falta.length > 0) {
        error(["interes"], `se cobra interés y no se puede rehacer la cuenta: falta ${falta.join(", ")}`);
      }
    }

    // --- Coherencia línea por línea ------------------------------------------------------------
    v.detalle.lineas.forEach((l, i) => {
      const esProrrateo = l.clase === "prorrateo";
      if (esProrrateo !== (l.gastoDelPeriodo !== null)) {
        error(["detalle", "lineas", i, "gastoDelPeriodo"], "el gasto del período existe si y solo si la línea es un prorrateo");
      }
      if (esProrrateo !== (l.coeficiente !== null)) {
        error(["detalle", "lineas", i, "coeficiente"], "el coeficiente existe si y solo si la línea es un prorrateo");
      }
      if (l.importeTeorico !== null) {
        const esperado = aCentavos(l.importeTeorico.monto) + aCentavos(l.ajusteRedondeo.monto);
        if (esperado !== aCentavos(l.importe.monto)) {
          error(
            ["detalle", "lineas", i, "importe"],
            `importe teórico + ajuste de redondeo da ${deCentavos(esperado)}, no ${l.importe.monto}`,
          );
        }
      }
      if (l.clase === "descuento" && aCentavos(l.importe.monto) > 0n) {
        error(["detalle", "lineas", i, "importe"], "un descuento se imprime en negativo (doc 08 §J)");
      }
    });

    // --- Los marcadores de nota apuntan a una nota que existe -----------------------------------
    const marcadores = new Set(v.notas.map((n) => n.marcador));
    const revisarMarcador = (m: number | null, path: (string | number)[]) => {
      if (m !== null && !marcadores.has(m)) error(path, `el marcador (${m}) no tiene nota que lo explique`);
    };
    v.detalle.lineas.forEach((l, i) => revisarMarcador(l.marcadorNota, ["detalle", "lineas", i, "marcadorNota"]));
    v.composicion.forEach((r, i) => revisarMarcador(r.marcadorNota, ["composicion", i, "marcadorNota"]));

    // --- Emisión bloqueada por figura jurídica (doc 07 §E) --------------------------------------
    if (v.barrio.figuraJuridica === "fideicomiso") {
      error(
        ["barrio", "figuraJuridica"],
        "fideicomiso: la emisión se bloquea — no hay fuente cargada de denominación ni órganos, y el sistema no cae al texto de PH por defecto",
      );
    }
  });

export type VistaBoleta = z.infer<typeof vistaBoletaSchema>;

/** Valida y devuelve la vista. Es el único borde por el que entra un documento a renderizarse. */
export function parsearVistaBoleta(entrada: unknown): VistaBoleta {
  return vistaBoletaSchema.parse(entrada);
}
