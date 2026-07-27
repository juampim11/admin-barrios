/**
 * `VistaListadoMora` — el modelo de vista del **listado de saldos pendientes**.
 *
 * Es el documento más delicado que emite el producto: una nómina de personas con lo que deben, que
 * circula en papel y por correo. Va **separado de la boleta y en otro envío**: nunca dentro del mismo
 * mensaje que la boleta individual de una unidad (doc 07 §F).
 *
 * ## La decisión del cliente, y por qué el tipo la trata como política
 *
 * En el barrio piloto el listado va **nominado** —nombre y manzana/lote—, como convención adoptada
 * por el barrio para incentivar el pago. Es una decisión tomada y no se discute acá. Lo que sí hace
 * este archivo es **convertirla en configuración**: `modo`, `destinatarios`, `pisoImporte` y
 * `excluirPlanAlDia` son política del barrio, y la política viaja congelada con el documento. Eso es
 * lo que vuelve al producto vendible a un barrio con la política opuesta sin tocar una línea.
 *
 * ## La pieza estructural: `detalle` es una unión discriminada, no un objeto con campos opcionales
 *
 * La rama `agregado` **no tiene `filas`**, ni `titular`, ni `unidad`, ni ningún identificador por
 * caso — ni siquiera un uuid o un hash. No es que no se impriman: **no existen en el tipo**, así que
 * no pueden filtrarse por una plantilla distraída, ni quedar escritos en el `jsonb` congelado, ni
 * salir en un dump de la base. En un barrio el lote **es** la dirección: tachar el nombre y dejar la
 * manzana no anonimiza nada, y por eso las dos ramas no comparten un tipo base que cargue identidad.
 *
 * ## k-anonimato
 *
 * En modo agregado, ninguna celda publicable puede describir a menos de `kAnonimato` unidades
 * (piso duro `K_ANONIMATO_MINIMO`). Un tramo de antigüedad con dos unidades es una nómina de dos
 * personas escrita de otra manera. Las celdas chicas **se funden con la vecina**, nunca se suprimen:
 * suprimir y publicar el total deja la celda suprimida calculable por diferencia.
 */

import { z } from "zod";
import { aCentavos, deCentavos } from "../dinero.ts";
import { FIGURAS_JURIDICAS } from "../barrio.ts";
import {
  cifraOFaltanteSchema,
  datoFaltanteSchema,
  esFaltante,
  montoSiHay,
  motivosFaltantes,
} from "./faltantes.ts";
import { cifraSchema, fechaImpresaSchema } from "./primitivas.ts";
import { participacion as participacionSobreTotal } from "./vista-informe-mensual.ts";
import { marcaDocumentoSchema } from "./vista-boleta.ts";

/** Viaja con el documento guardado: un cambio incompatible sube el número (ADR-0001 §6). */
export const VERSION_VISTA_LISTADO_MORA = "listado-mora/1";

/**
 * El título impreso **no es configurable**, igual que `MARCA_MUESTRA`.
 *
 * "Listado de mora" sirve como nombre interno del documento; impreso, califica a las personas que
 * enumera, y doc 07 §E prohíbe exactamente eso. El papel dice qué hay: saldos pendientes a una fecha.
 */
export const TITULO_LISTADO_MORA = "Estado de saldos pendientes";

/**
 * Piso duro de k-anonimato. Configurable **sólo hacia arriba**.
 *
 * 3 no alcanza en un barrio: cualquier vecino conoce la situación de dos o tres lotes de su cuadra y
 * con eso desarma la celda. 10 funde todos los tramos en uno solo en un barrio de 100–300 unidades y
 * deja el documento inservible. 5 es el piso habitual de supresión de celda chica y todavía deja
 * tramos usables.
 */
export const K_ANONIMATO_MINIMO = 5;

// --- Política del barrio ------------------------------------------------------------------------

export const MODOS_LISTADO = ["nominado", "agregado"] as const;
export type ModoListado = (typeof MODOS_LISTADO)[number];

/**
 * A quién se le manda. **Hoy sólo `directorio` es emitible** y el resto se rechaza en runtime: no
 * existe el vínculo usuario → unidad funcional (doc 07 §F, ADR-0001 §13), así que armar el envío a
 * "los propietarios" obligaría a aparear dos listas por índice — que es justo lo que doc 07 §F.2
 * prohíbe. Los valores viven en el tipo porque la configuración del barrio ya los contempla; la
 * emisión los rechaza hasta que el vínculo exista.
 */
export const DESTINATARIOS_LISTADO = ["directorio", "propietarios", "propietarios_y_residentes"] as const;
export type DestinatariosListado = (typeof DESTINATARIOS_LISTADO)[number];

export const politicaListadoSchema = z
  .object({
    modo: z.enum(MODOS_LISTADO),
    destinatarios: z.enum(DESTINATARIOS_LISTADO),
    /**
     * Excluye los saldos residuales. `null` = apagado.
     *
     * No es una comodidad estética: en el material real, las unidades que deben menos de $ 15.000
     * ocupan una parte grande del listado y aportan una fracción despreciable de la deuda. Incluirlas
     * le quita fuerza al mecanismo, y de paso mete en una nómina a alguien por un saldo de arrastre.
     */
    pisoImporte: cifraSchema.nullable(),
    /** Quien arregló y está cumpliendo no aparece. Apagable. */
    excluirPlanAlDia: z.boolean(),
    /** Se congela con el documento: sin esto no se puede auditar qué se publicó con qué umbral. */
    kAnonimato: z.number().int().min(K_ANONIMATO_MINIMO),
    /**
     * Los importes agregados se redondean a este múltiplo (en pesos). Un importe exacto es una
     * huella: se cruza contra el listado nominado de otro mes o contra una boleta que alguien mostró.
     */
    redondeoAgregado: z.number().int().positive(),
  })
  .strict()
  .readonly();
export type PoliticaListado = z.infer<typeof politicaListadoSchema>;

// --- Vocabulario tipado: nada de texto libre por caso -------------------------------------------

/**
 * Instancia de gestión, de la más temprana a la más avanzada.
 *
 * **Catálogo cerrado, no texto libre.** En el material real la misma etapa aparece escrita de tres
 * formas distintas en tres meses distintos ("administrativos", "Abogados", "Estudio Jurídico"), así
 * que ni siquiera se puede contar cuántos casos hay en cada una.
 *
 * Dos cosas que la etapa **no** es: no la mueve el importe (un saldo grande y reciente no es un caso
 * judicial; uno chico de catorce meses sí es un caso que alguien abandonó), y no retrocede sola —
 * sólo por pago total o por convenio firmado.
 *
 * Sobre los rótulos: la etapa que operativamente se llama "intimación fehaciente" acá es
 * `aviso_formal`. No es un eufemismo de conveniencia — "intimación" y "notificación fehaciente" están
 * las dos en la lista prohibida del doc 07 §E, y un documento que las imprime no se emite.
 */
export const INSTANCIAS_GESTION = ["vencido", "gestion_administrativa", "aviso_formal", "prejudicial", "judicial"] as const;
export type InstanciaGestion = (typeof INSTANCIAS_GESTION)[number];

/**
 * **El orden en que se trabaja el listado**, que NO es el orden de las etapas ni el del importe.
 *
 * El listado de hoy va por importe descendente: pone arriba los casos que ya están en el estudio
 * jurídico —sobre los que la administración no va a hacer nada esta semana— y hunde al final los
 * casos frescos que todavía se recuperan con un llamado. Es un orden para mirar, no para trabajar.
 *
 * Acá las etapas recuperables van primero y las terminales al final, en modo lectura. Que sea un
 * array aparte y no el orden de `INSTANCIAS_GESTION` es a propósito: son dos criterios distintos que
 * hoy coinciden y mañana pueden no coincidir.
 */
export const ORDEN_DE_TRABAJO: readonly InstanciaGestion[] = [
  "vencido",
  "gestion_administrativa",
  "aviso_formal",
  "prejudicial",
  "judicial",
];

/**
 * Tramos de antigüedad **en períodos, no en días**.
 *
 * La expensa vence una vez por mes: "90 días" *es* "3 cuotas", y decirlo en días obliga al lector y
 * al administrador a hacer la división mentalmente. Los cortes de cobranza comercial (30/60/90) no
 * describen esta operatoria. La antigüedad en días sigue existiendo para una sola cosa —el cálculo
 * del interés, que corre por día— y ésa no es un tramo de gestión.
 *
 * Fijos y versionados por barrio: si los cortes se recalculan cada mes, comparar dos meses
 * reidentifica aunque cada mes cumpla `k` por separado.
 */
export const TRAMOS_ANTIGUEDAD = ["un_periodo", "dos_periodos", "de_3_a_6", "de_7_a_12", "mas_de_12"] as const;
export type TramoAntiguedad = (typeof TRAMOS_ANTIGUEDAD)[number];

/**
 * El convenio de pago es un estado **paralelo** a la etapa, no una etapa.
 *
 * Es la falla más grave del listado actual: un vecino que arregló y viene pagando aparece exactamente
 * igual que uno que no atiende el teléfono. De acá sale además el `excluirPlanAlDia` de la política.
 */
export const ESTADOS_CONVENIO = ["vigente", "en_riesgo", "caido"] as const;
export type EstadoConvenio = (typeof ESTADOS_CONVENIO)[number];

/**
 * Qué se hizo y qué sigue. **Es un enum y no texto libre, a propósito.**
 *
 * Una columna de observaciones es donde un operador escribe "no atiende el teléfono" o "ya le
 * mandamos carta documento": queda congelado en el `jsonb` para siempre y sale impreso en un papel
 * que circula. Con vocabulario cerrado la columna informa lo mismo y no puede calificar a nadie.
 */
export const ACCIONES_GESTION = [
  "sin_gestion_registrada",
  "aviso_por_correo",
  "llamado",
  "nota_impresa",
  "reunion",
  "acuerdo_de_pago",
  "derivacion",
] as const;
export type AccionGestion = (typeof ACCIONES_GESTION)[number];

export const gestionSchema = z
  .object({ accion: z.enum(ACCIONES_GESTION), fecha: fechaImpresaSchema })
  .strict()
  .readonly();

export const proximaAccionSchema = z
  .object({ accion: z.enum(ACCIONES_GESTION), fechaPrevista: fechaImpresaSchema })
  .strict()
  .readonly();

// --- La fila nominada ---------------------------------------------------------------------------

/** Cómo se movió el saldo contra el corte anterior. */
export const CLASES_VARIACION = ["nueva", "aumento", "baja", "sin_cambio"] as const;

export const variacionFilaSchema = z
  .object({ clase: z.enum(CLASES_VARIACION), importe: cifraSchema })
  .strict()
  .readonly();

/**
 * La composición del saldo en columnas separadas.
 *
 * **Es la condición para poder emitir un certificado de deuda sobre el saldo puro**: capital,
 * intereses, multas y cargos tienen tratamientos distintos y un total indiviso no se puede recortar
 * después. Los cuatro aceptan el hueco porque el sistema de origen todavía no los separa — y un cero
 * ahí afirmaría que no hay intereses, que es una afirmación sobre dinero que nadie verificó.
 */
export const composicionSaldoSchema = z
  .object({
    total: cifraSchema,
    capital: cifraOFaltanteSchema,
    intereses: cifraOFaltanteSchema,
    multas: cifraOFaltanteSchema,
    cargos: cifraOFaltanteSchema,
  })
  .strict()
  .readonly();

export const filaMoraSchema = z
  .object({
    /** "Mza 73 · Lote 10". Es la dirección del vecino: sólo existe en la rama nominada. */
    unidad: z.string().min(1),
    titular: z.string().min(1),
    saldo: composicionSaldoSchema,
    antiguedad: z.union([z.enum(TRAMOS_ANTIGUEDAD), datoFaltanteSchema]),
    instancia: z
      .object({ clave: z.enum(INSTANCIAS_GESTION), derivadaEl: z.union([fechaImpresaSchema, datoFaltanteSchema]) })
      .strict()
      .readonly(),
    ultimaGestion: z.union([gestionSchema, datoFaltanteSchema]),
    proximaAccion: z.union([proximaAccionSchema, datoFaltanteSchema]),
    /** `null` cuando no hay corte anterior con el que comparar. */
    variacion: variacionFilaSchema.nullable(),
  })
  .strict()
  .readonly();
export type FilaMora = z.infer<typeof filaMoraSchema>;

// --- El resumen (lo publican los dos modos) -----------------------------------------------------

/**
 * Una celda agregada. **Sólo cantidad y suma**: cualquier estadístico de orden —máximo, mínimo,
 * mediana, "el mayor de este tramo"— *es* el importe de una unidad concreta escrito de otra forma.
 */
export const celdaAgregadaSchema = z
  .object({
    etiqueta: z.string().min(1),
    unidades: z.number().int().nonnegative(),
    importe: cifraSchema,
    /** `true` cuando la celda absorbió otra que no llegaba a `k`. Se dice, no se disimula. */
    fusionada: z.boolean(),
  })
  .strict()
  .readonly();
export type CeldaAgregada = z.infer<typeof celdaAgregadaSchema>;

/**
 * Concentración: qué parte de la deuda explican las unidades de mayor saldo.
 *
 * Es un **bloque de al menos `k` unidades**, nunca un ranking ni un "top 5" (doc 07 §F prohíbe el
 * ranking, y un bloque de menos de k publica un importe individual). Con el bloque, el vecino
 * entiende si la deuda es de todos o de unos pocos, que es la pregunta real.
 */
export const concentracionSchema = z
  .object({
    unidades: z.number().int().positive(),
    importe: cifraSchema,
    /** Participación sobre el total, con 2 decimales: `"59,60"`. */
    participacionTexto: z.string().min(1),
  })
  .strict()
  .readonly();

/**
 * Evolución contra el corte anterior. **Vive acá, a nivel documento, y no dentro de cada tramo.**
 *
 * Publicar el movimiento tramo por tramo es *differencing* mes contra mes: convierte "un tramo de
 * seis" en "esta unidad concreta viene subiendo". A nivel total no reidentifica a nadie y contesta la
 * pregunta que el listado de hoy no contesta —hoy no hay ni una fila de total.
 */
export const evolucionSchema = z
  .object({
    corteAnterior: fechaImpresaSchema,
    totalAnterior: cifraSchema,
    variacionImporte: cifraSchema,
    variacionTexto: z.string().min(1),
    unidadesAnterior: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const resumenMoraSchema = z
  .object({
    total: cifraSchema,
    unidades: z.number().int().nonnegative(),
    evolucion: z.union([evolucionSchema, datoFaltanteSchema]),
    tramos: z.array(z.union([celdaAgregadaSchema, datoFaltanteSchema])).readonly(),
    porInstancia: z.array(celdaAgregadaSchema).readonly(),
    concentracion: z.union([concentracionSchema, datoFaltanteSchema]),
  })
  .strict()
  .readonly();
export type ResumenMora = z.infer<typeof resumenMoraSchema>;

// --- El detalle: la unión que hace imposible la fuga --------------------------------------------

/**
 * Dónde quedó escrita la convención del barrio. **Campo obligatorio de la rama nominada.**
 *
 * Publicar la nómina es una decisión del barrio, no una capacidad del software (doc 10 §E.4): el
 * sistema no la sugiere ni la discute, pero **exige que esté declarado dónde se tomó**. Es lo que
 * permite contestar "¿con qué autoridad aparezco en esta lista?" con un dato en vez de con una
 * política.
 *
 * Acepta el hueco a propósito y **no es una puerta de atrás**: cuando el instrumento no está cargado,
 * el documento sale igual pero **lo dice en la cara**, con el mismo patrón de dato pendiente que el
 * resto de la familia. La alternativa —bloquear la emisión— haría que alguien escriba "Acta s/n" para
 * destrabarla, que es peor: un respaldo inventado se lee igual que uno real.
 */
export const respaldoDecisionSchema = z
  .object({
    tipo: z.enum(["acta", "asamblea", "reglamento"]),
    referencia: z.string().min(1),
    fecha: fechaImpresaSchema,
  })
  .strict()
  .readonly();

export const detalleListadoSchema = z.discriminatedUnion("modo", [
  z
    .object({
      modo: z.literal("nominado"),
      /** Ordenadas para **trabajar**: instancia más avanzada primero, después antigüedad, después importe. */
      filas: z.array(filaMoraSchema).readonly(),
      respaldoDecision: z.union([respaldoDecisionSchema, datoFaltanteSchema]),
      /**
       * Identificador del ejemplar. Es lo único que vuelve rastreable un reenvío, y por eso el
       * nominado se emite **para un destinatario o no se emite**: un PDF genérico no se rastrea.
       * Es **inerte**: no resuelve a ninguna URL ni a ningún QR; el mapa token → destinatario vive
       * del lado del servidor.
       */
      copia: z.string().regex(/^[A-Z0-9]{4}-[0-9]{1,4}$/, "el identificador de copia va como ABCD-12"),
    })
    .strict(),
  z
    .object({
      modo: z.literal("agregado"),
      // Sin `filas`. Sin `titular`. Sin `unidad`. Sin id de ninguna clase. Y sin un tipo base común
      // con la rama de arriba, que es como esto se rompe en el mes cuatro.
    })
    .strict(),
]);
export type DetalleListado = z.infer<typeof detalleListadoSchema>;

// --- El documento -------------------------------------------------------------------------------

export const vistaListadoMoraSchema = z
  .object({
    version: z.literal(VERSION_VISTA_LISTADO_MORA),
    marca: marcaDocumentoSchema,
    barrio: z
      .object({
        nombre: z.string().min(1),
        figuraJuridica: z.enum(FIGURAS_JURIDICAS),
        domicilio: z.string().min(1).nullable(),
      })
      .strict()
      .readonly(),
    /** La fecha a la que están medidos los saldos. Va en el encabezado y en grande. */
    corte: fechaImpresaSchema,
    emision: z.object({ fecha: fechaImpresaSchema.nullable() }).strict().readonly(),
    politica: politicaListadoSchema,
    resumen: resumenMoraSchema,
    detalle: detalleListadoSchema,
    notas: z
      .array(z.object({ marcador: z.number().int().positive(), texto: z.string().min(1) }).strict().readonly())
      .readonly(),
    leyendas: z.array(z.string().min(1)).readonly(),
    faltantes: z.array(z.string().min(1)).readonly(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const error = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    // --- La política del documento es la que se ejecutó ----------------------------------------
    if (v.politica.modo !== v.detalle.modo) {
      error(["detalle", "modo"], `la política dice "${v.politica.modo}" y el detalle salió "${v.detalle.modo}"`);
    }

    const k = v.politica.kAnonimato;

    if (v.detalle.modo === "nominado") {
      const filas = v.detalle.filas;

      // --- El total existe y sale de las filas -------------------------------------------------
      const suma = filas.reduce<bigint>((a, f) => a + aCentavos(f.saldo.total.monto), 0n);
      if (suma !== aCentavos(v.resumen.total.monto)) {
        error(["resumen", "total"], `las filas suman ${deCentavos(suma)} y el total dice ${v.resumen.total.monto}`);
      }
      if (filas.length !== v.resumen.unidades) {
        error(["resumen", "unidades"], `hay ${filas.length} filas y el resumen declara ${v.resumen.unidades} unidades`);
      }

      filas.forEach((f, i) => {
        // --- La composición cierra cuando existe ----------------------------------------------
        const partes = [f.saldo.capital, f.saldo.intereses, f.saldo.multas, f.saldo.cargos].map(montoSiHay);
        if (partes.every((p) => p !== null)) {
          const compuesto = partes.reduce<bigint>((a, p) => a + aCentavos(p as string), 0n);
          if (compuesto !== aCentavos(f.saldo.total.monto)) {
            error(["detalle", "filas", i, "saldo"], `capital + intereses + multas + cargos da ${deCentavos(compuesto)} y el total dice ${f.saldo.total.monto}`);
          }
        }
        // --- El piso se aplicó de verdad ------------------------------------------------------
        if (v.politica.pisoImporte !== null && aCentavos(f.saldo.total.monto) < aCentavos(v.politica.pisoImporte.monto)) {
          error(["detalle", "filas", i, "saldo", "total"], `la fila queda por debajo del piso de $ ${v.politica.pisoImporte.texto} y aun así se publica`);
        }
      });

      // --- Ordenado para trabajar, no por importe ---------------------------------------------
      // `ORDEN_DE_TRABAJO` primero: las etapas **recuperables** arriba y las terminales al final, en
      // modo lectura. Después la deuda más vieja, y recién ahí el importe. Un listado por importe
      // pone arriba lo que ya está en el estudio jurídico y hunde lo que todavía se recupera con un
      // llamado: se lee como un ranking y no se puede trabajar.
      //
      // La antigüedad desconocida va **al fondo de su bloque, no al frente**: `0` la empataba con
      // `un_periodo` —el tramo más fresco— y el listado terminaba afirmando que una fila de la que no
      // sabemos nada es la más nueva. `1` la deja por detrás de todos los tramos conocidos.
      const clave = (f: FilaMora): [number, number, bigint] => [
        ORDEN_DE_TRABAJO.indexOf(f.instancia.clave),
        esFaltante(f.antiguedad) ? 1 : -TRAMOS_ANTIGUEDAD.indexOf(f.antiguedad),
        -aCentavos(f.saldo.total.monto),
      ];
      for (let i = 1; i < filas.length; i++) {
        const previa = filas[i - 1];
        const actual = filas[i];
        if (!previa || !actual) continue;
        const a = clave(previa);
        const b = clave(actual);
        const desordenada = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
        if (desordenada) {
          error(["detalle", "filas", i], "el listado no está en orden de trabajo (instancia, después antigüedad, después importe)");
          break;
        }
      }
    } else {
      // --- Modo agregado: ninguna celda describe a menos de k unidades ------------------------
      //
      // Empezando por la que se imprime más grande y más arriba: **el conteo del documento**. Sin
      // esto, un listado con las dos listas de celdas vacías publicaba "$ 100.000,00 — 3 unidades
      // con saldo al corte", que es una nómina de tres personas escrita en agregado.
      if (v.resumen.unidades > 0 && v.resumen.unidades < k) {
        error(["resumen", "unidades"], `el documento describe ${v.resumen.unidades} unidades y el piso es ${k}`);
      }
      if (!esFaltante(v.resumen.evolucion)) {
        const anterior = v.resumen.evolucion.unidadesAnterior;
        if (anterior > 0 && anterior < k) {
          error(["resumen", "evolucion", "unidadesAnterior"], `el corte anterior describe ${anterior} unidades y el piso es ${k}`);
        }
      }
      v.resumen.tramos.forEach((t, i) => {
        if (esFaltante(t)) return;
        if (t.unidades > 0 && t.unidades < k) {
          error(["resumen", "tramos", i], `el tramo "${t.etiqueta}" describe ${t.unidades} unidades y el piso es ${k}: se funde con el adyacente, no se suprime`);
        }
      });
      v.resumen.porInstancia.forEach((c, i) => {
        if (c.unidades > 0 && c.unidades < k) {
          error(["resumen", "porInstancia", i], `la celda "${c.etiqueta}" describe ${c.unidades} unidades y el piso es ${k}`);
        }
      });
      if (!esFaltante(v.resumen.concentracion) && v.resumen.concentracion.unidades < k) {
        error(["resumen", "concentracion"], `la concentración se calcula sobre ${v.resumen.concentracion.unidades} unidades y el piso es ${k}: por debajo publica el saldo de alguien`);
      }
      // Importes redondeados: un importe exacto es una huella cruzable contra otro documento.
      const multiplo = BigInt(v.politica.redondeoAgregado) * 100n;
      const redondeado = (c: string) => aCentavos(c) % multiplo === 0n;
      if (!redondeado(v.resumen.total.monto)) {
        error(["resumen", "total"], `en modo agregado el total va redondeado al múltiplo de ${v.politica.redondeoAgregado}`);
      }
      v.resumen.tramos.forEach((t, i) => {
        if (!esFaltante(t) && !redondeado(t.importe.monto)) {
          error(["resumen", "tramos", i, "importe"], `en modo agregado los importes van redondeados al múltiplo de ${v.politica.redondeoAgregado}`);
        }
      });
      v.resumen.porInstancia.forEach((c, i) => {
        if (!redondeado(c.importe.monto)) {
          error(["resumen", "porInstancia", i, "importe"], `en modo agregado los importes van redondeados al múltiplo de ${v.politica.redondeoAgregado}`);
        }
      });
      // La concentración es **el bloque de mayor saldo del barrio**: su importe exacto es la huella
      // más cruzable de todo el documento, y era justo la única celda que se publicaba sin redondear.
      if (!esFaltante(v.resumen.concentracion) && !redondeado(v.resumen.concentracion.importe.monto)) {
        error(["resumen", "concentracion", "importe"], `en modo agregado los importes van redondeados al múltiplo de ${v.politica.redondeoAgregado}`);
      }
      // La evolución también, y **por el mismo motivo con un paso más**: un total redondeado junto a
      // una variación exacta devuelve el total anterior exacto por diferencia, y el redondeo deja de
      // servir para lo único que servía.
      if (!esFaltante(v.resumen.evolucion)) {
        const e = v.resumen.evolucion;
        if (!redondeado(e.totalAnterior.monto) || !redondeado(e.variacionImporte.monto)) {
          error(
            ["resumen", "evolucion"],
            "en modo agregado el total anterior y la variación van redondeados: con la variación exacta, " +
              "el total anterior se recupera por diferencia",
          );
        }
      }
    }

    // --- Las celdas del resumen no pueden contradecir al total ---------------------------------
    //
    // **Esto es lo que hace que la fusión de celdas chicas sea una regla y no una intención.** Si los
    // tramos publicados no tienen que sumar el total, suprimir una celda por debajo de `k` y publicar
    // el resto deja la celda suprimida —sus unidades y su importe— calculable por resta. El control
    // corre en los DOS modos: apagarlo en agregado, que es donde importa, lo volvía decorativo.
    const publicables = v.resumen.tramos.filter((t): t is CeldaAgregada => !esFaltante(t));
    if (publicables.length > 0) {
      const unidadesTramos = publicables.reduce((a, t) => a + t.unidades, 0);
      if (unidadesTramos !== v.resumen.unidades) {
        error(["resumen", "tramos"], `los tramos describen ${unidadesTramos} unidades y el resumen declara ${v.resumen.unidades}`);
      }
      const sumaTramos = publicables.reduce<bigint>((a, t) => a + aCentavos(t.importe.monto), 0n);
      // En agregado los importes vienen redondeados: la suma de las partes puede diferir del total
      // hasta un múltiplo por celda, y esa tolerancia —y no más— es la que se admite.
      const tolerancia =
        v.detalle.modo === "agregado" ? BigInt(v.politica.redondeoAgregado) * 100n * BigInt(publicables.length + 1) : 0n;
      const desvio = sumaTramos - aCentavos(v.resumen.total.monto);
      if ((desvio < 0n ? -desvio : desvio) > tolerancia) {
        error(["resumen", "tramos"], `los tramos suman ${deCentavos(sumaTramos)} y el total dice ${v.resumen.total.monto}`);
      }
    }
    const unidadesInstancia = v.resumen.porInstancia.reduce((a, c) => a + c.unidades, 0);
    if (v.resumen.porInstancia.length > 0 && unidadesInstancia !== v.resumen.unidades) {
      error(["resumen", "porInstancia"], `las instancias suman ${unidadesInstancia} unidades y el resumen declara ${v.resumen.unidades}`);
    }
    // Un bloque de concentración más grande que el propio listado no describe nada; y su porcentaje
    // es una cifra de dinero impresa, así que sale del mismo denominador que el total (CLAUDE.md §1.4).
    if (!esFaltante(v.resumen.concentracion)) {
      const c = v.resumen.concentracion;
      if (c.unidades > v.resumen.unidades) {
        error(["resumen", "concentracion", "unidades"], `la concentración toma ${c.unidades} unidades y el listado tiene ${v.resumen.unidades}`);
      }
      const esperado = participacionSobreTotal(c.importe.monto, v.resumen.total.monto);
      if (c.participacionTexto !== esperado) {
        error(["resumen", "concentracion", "participacionTexto"], `la participación impresa dice ${c.participacionTexto} % y sobre el total del documento da ${esperado} %`);
      }
    }

    // --- Los marcadores apuntan a una nota que existe ------------------------------------------
    const marcadores = new Set(v.notas.map((n) => n.marcador));
    if (marcadores.size !== v.notas.length) error(["notas"], "hay marcadores de nota repetidos");

    // --- Emisión bloqueada por figura jurídica (doc 07 §E) -------------------------------------
    if (v.barrio.figuraJuridica === "fideicomiso") {
      error(["barrio", "figuraJuridica"], "fideicomiso: la emisión se bloquea — no hay fuente cargada de denominación ni órganos");
    }
  });

export type VistaListadoMora = z.infer<typeof vistaListadoMoraSchema>;

/** Valida y devuelve la vista. Único borde por el que entra un listado a renderizarse. */
export function parsearVistaListadoMora(entrada: unknown): VistaListadoMora {
  return vistaListadoMoraSchema.parse(entrada);
}

/**
 * Todos los textos que un humano va a leer impresos. Entrada del filtro de doc 07 §E.
 *
 * **El nombre del titular no entra.** No es un texto del documento sino un dato de una persona: si
 * alguien se apellida "Veraz" o "Moroso", el filtro bloquearía la emisión de todo el listado por un
 * apellido — y de paso dejaría escrito en el log que ese apellido está en la nómina.
 */
export function textosImpresosDeListadoMora(v: VistaListadoMora): string[] {
  return [
    TITULO_LISTADO_MORA,
    ...v.leyendas,
    ...v.marca.pie,
    ...v.notas.map((n) => n.texto),
    ...v.resumen.tramos.map((t) => (esFaltante(t) ? t.motivo : t.etiqueta)),
    ...v.resumen.porInstancia.map((c) => c.etiqueta),
    // **Los motivos de los huecos también se imprimen** —en la celda, y enteros al pie— así que
    // pasan por el filtro como cualquier otro texto. Sin esto, un motivo cargado a mano
    // ("no se registró desde cuándo el moroso dejó de pagar") salía impreso sin que nadie lo mirara,
    // que es exactamente el caso que el filtro existe para atajar.
    ...motivosFaltantes(v),
    ...(v.detalle.modo === "nominado" && !esFaltante(v.detalle.respaldoDecision)
      ? [v.detalle.respaldoDecision.referencia]
      : []),
  ].filter((t) => t.trim().length > 0);
}
