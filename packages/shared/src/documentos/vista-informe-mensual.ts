/**
 * `VistaInformeMensual` — el modelo de vista del **informe mensual del barrio**.
 *
 * Es el documento que la administración manda junto con la boleta, y el que responde la pregunta que
 * la boleta individual no puede responder: *"¿en qué se gastó la plata de todos?"*. Hoy circula como
 * "Estado de cuentas" y arrastra siete defectos verificados; este tipo existe para que **cinco de
 * ellos sean imposibles de cometer otra vez**, y no para que alguien se acuerde de evitarlos:
 *
 *  1. **Nunca calcula el resultado del período.** Acá `resultado` es un campo obligatorio y el
 *     invariante lo obliga a ser `ingresos − egresos`. No hay documento sin ese número.
 *  2. **Mezcla devengado y percibido sin rotularlo.** Son dos secciones separadas por tipo
 *     (`devengado` y `financiero`) y **entre las dos hay un puente explícito** (`conciliacion`), con
 *     su diferencia sin explicar declarada en vez de disimulada.
 *  3. **Repite el mismo cuadro dos veces.** Hay **un** cuadro de fondos y el tipo no admite otro.
 *  4. **Renglones de gasto sin jerarquía.** Los gastos entran agrupados, con dos reglas que el
 *     `superRefine` hace cumplir: los honorarios de administración llevan renglón propio **siempre**,
 *     y todo grupo que pese más de `PISO_DESAGREGACION` del gasto **se desagrega sí o sí**.
 *  5. **Nombres de personas en renglones de gasto.** El proveedor de una línea desagregada es una
 *     unión discriminada: cuando es persona humana, el tipo **no tiene dónde poner el nombre** —
 *     lleva una cantidad. La razón social de una empresa sí se publica.
 *
 * Los dos que no se resuelven en el tipo sino en el documento: el período y la fecha de corte van en
 * el encabezado (`periodo.corte`, obligatorio), y los denominadores que no existen viajan como
 * `DatoFaltante` en vez de inventarse.
 */

import { z } from "zod";
import { aCentavos, deCentavos, formatearDecimal } from "../dinero.ts";
import { FIGURAS_JURIDICAS } from "../barrio.ts";
import { cifraOFaltanteSchema, datoFaltanteSchema, esFaltante, montoSiHay, motivosFaltantes } from "./faltantes.ts";
import { cifraSchema, fechaImpresaSchema } from "./primitivas.ts";
import { serieHistoricaSchema } from "./series.ts";
import { marcaDocumentoSchema } from "./vista-boleta.ts";

/** Viaja con el documento guardado: un cambio incompatible sube el número (ADR-0001 §6). */
export const VERSION_VISTA_INFORME = "informe-mensual/1";

/**
 * Peso a partir del cual un grupo de gasto **tiene que mostrar de qué está hecho**, en centésimas de
 * punto porcentual del gasto total (500 = 5,00 %).
 *
 * El número no es arbitrario: con el gasto de un barrio real, 5 % separa los cuatro o cinco rubros
 * que explican el 80 % del presupuesto —y sobre los que el vecino efectivamente pregunta— del resto,
 * que agrupado informa más que desagregado. Un contrato de seguridad de 91 millones escondido dentro
 * de "seguridad y control" es exactamente lo que la agrupación no puede producir.
 */
export const PISO_DESAGREGACION_BP = 500;

/** El grupo que **siempre** lleva renglón propio: diluirlo destruye la confianza (doc 07 §D). */
export const CLAVE_HONORARIOS_ADMINISTRACION = "honorarios_administracion";

// --- El proveedor de una línea: el nombre propio no tiene dónde entrar --------------------------

/**
 * Quién cobró una línea desagregada del gasto.
 *
 * **La unión es la defensa, no una comodidad de modelado.** El informe real trae un renglón que
 * nombra a tres empleados con su costo conjunto: es el sueldo de tres personas identificadas,
 * publicado a todo el barrio. Con este tipo eso **no se puede representar** — la variante
 * `persona_humana` lleva una cantidad y no tiene campo de nombre, así que la línea sale
 * "Personal de mantenimiento (3 personas)" o no sale.
 *
 * La razón social de una empresa **sí se publica**: es información de contratación del barrio, no un
 * dato personal, y ocultarla convertiría el informe en otra cosa.
 */
// `.strict()` y sin `.readonly()`: `discriminatedUnion` necesita un `ZodObject` crudo para poder
// leer la clave discriminante. `.strict()` sí queda, y acá importa más que en ningún lado — la vista
// se congela en `jsonb`, y un schema permisivo persistiría un `nombre` que la plantilla no imprime
// pero que queda legible en la base, en cualquier backup y en cualquier export.
export const proveedorImpresoSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("razon_social"), nombre: z.string().min(1) }).strict(),
  z.object({ tipo: z.literal("persona_humana"), cantidad: z.number().int().positive() }).strict(),
  z.object({ tipo: z.literal("sin_identificar") }).strict(),
]);
export type ProveedorImpreso = z.infer<typeof proveedorImpresoSchema>;

export const lineaDesagregadaSchema = z
  .object({
    concepto: z.string().min(1),
    proveedor: proveedorImpresoSchema,
    importe: cifraSchema,
  })
  .readonly();
export type LineaDesagregada = z.infer<typeof lineaDesagregadaSchema>;

// --- Los grupos ---------------------------------------------------------------------------------

export const grupoImporteSchema = z
  .object({
    clave: z.string().regex(/^[a-z0-9_]+$/, "la clave del grupo es un identificador estable"),
    etiqueta: z.string().min(1),
    importe: cifraSchema,
    /**
     * Participación sobre el total de su columna, en porcentaje con 2 decimales: `"50,55"`. Se arma
     * con `participacion()` — que la calcule el modelo y no la plantilla es lo que hace que el
     * número impreso salga del mismo denominador que el total impreso.
     */
    participacionTexto: z.string().min(1),
    /**
     * De qué está hecho el grupo. Vacío es legítimo **solo** por debajo del piso de desagregación;
     * por arriba, el `superRefine` lo exige y verifica que las líneas sumen el importe del grupo.
     */
    desagregado: z.array(lineaDesagregadaSchema).readonly(),
    /** Cuántas líneas del origen colapsó este renglón. Es lo que hace visible la agrupación. */
    lineasDeOrigen: z.number().int().positive(),
  })
  .readonly();
export type GrupoImporte = z.infer<typeof grupoImporteSchema>;

/**
 * Participación de una parte sobre un total, en porcentaje con 2 decimales.
 *
 * En centavos y con `bigint`: el mismo criterio que el resto del dinero del proyecto. Un total en
 * cero devuelve `"0,00"` en vez de dividir por cero — un informe sin gasto es raro, pero no es un
 * error del que haya que morirse.
 */
export function participacion(parte: string, total: string): string {
  const t = aCentavos(total);
  if (t === 0n) return formatearDecimal("0", 2);
  const escala = 1_000_000n;
  const bruto = (aCentavos(parte) * 100n * escala) / t;
  const negativo = bruto < 0n;
  const abs = negativo ? -bruto : bruto;
  const entero = abs / escala;
  const resto = (abs % escala).toString().padStart(6, "0");
  return formatearDecimal(`${negativo ? "-" : ""}${entero}.${resto}`, 2);
}

// --- Observaciones: lo que no cierra, dicho en voz alta -----------------------------------------

/**
 * Una cifra que el informe publica y que **no se pudo verificar**.
 *
 * Existe porque el material real las tiene y hoy nadie las ve: el bloque financiero de un mes repite
 * exactamente el del mes anterior, y la deuda a proveedores abre con un saldo distinto del que cerró
 * el mes pasado. Callarlas es lo que las vuelve peligrosas; el documento las señala en el renglón y
 * las lista al pie.
 */
export const CLAVES_OBSERVACION = ["no_concilia", "repite_periodo_anterior", "sin_respaldo"] as const;

export const observacionSchema = z
  .object({
    clave: z.enum(CLAVES_OBSERVACION),
    /** A qué renglón o bloque apunta. La plantilla lo usa para poner el marcador en su lugar. */
    ancla: z.string().min(1),
    marcador: z.number().int().positive(),
    texto: z.string().min(1),
  })
  .readonly();
export type Observacion = z.infer<typeof observacionSchema>;

// --- (a) Resultado del período (devengado) ------------------------------------------------------

export const resultadoDevengadoSchema = z
  .object({
    ingresos: z.array(grupoImporteSchema).min(1).readonly(),
    egresos: z.array(grupoImporteSchema).min(1).readonly(),
    totalIngresos: cifraSchema,
    totalEgresos: cifraSchema,
    /**
     * **El número que el informe de hoy nunca calcula.** Positivo = superávit del período; negativo =
     * déficit. Es obligatorio y el invariante lo ata a los dos totales: no hay forma de emitir este
     * documento sin restar.
     */
    resultado: cifraSchema,
  })
  .readonly();
export type ResultadoDevengado = z.infer<typeof resultadoDevengadoSchema>;

// --- El puente: de lo devengado a lo percibido --------------------------------------------------

/**
 * Un renglón del puente. `signo` es del renglón, no del importe: un aumento de la deuda con
 * proveedores **suma** fondos (se devengó y no se pagó) aunque el importe sea positivo, y así es como
 * hay que leerlo. Tenerlo explícito evita la discusión de signos que hace ilegibles estos puentes.
 */
export const renglonConciliacionSchema = z
  .object({
    etiqueta: z.string().min(1),
    /** Qué explica el renglón, en criollo: "lo que se devengó y todavía no se cobró". */
    aclaracion: z.string().min(1).nullable(),
    importe: cifraOFaltanteSchema,
    signo: z.enum(["suma", "resta"]),
    marcadorObservacion: z.number().int().positive().nullable(),
  })
  .readonly();
export type RenglonConciliacion = z.infer<typeof renglonConciliacionSchema>;

export const conciliacionSchema = z
  .object({
    /** Siempre arranca en el resultado devengado: es el renglón que ata las dos secciones. */
    partida: cifraSchema,
    renglones: z.array(renglonConciliacionSchema).readonly(),
    /** El movimiento de fondos del período, que la sección (b) tiene que confirmar. */
    movimientoDeFondos: cifraSchema,
    /**
     * Lo que el puente **no** explica. `null` significa "cierra exacto"; una cifra significa que el
     * documento publica su propio residuo en vez de ajustarlo contra un renglón cualquiera. Cuando
     * algún renglón es un hueco, esto es lo único honesto que se puede imprimir.
     */
    diferenciaSinExplicar: cifraSchema.nullable(),
  })
  .readonly();
export type Conciliacion = z.infer<typeof conciliacionSchema>;

// --- (b) Situación financiera (percibido) -------------------------------------------------------

/**
 * **Un solo cuadro de fondos.** El informe de hoy imprime dos —"Movimientos de la Cuenta del Banco"
 * y "Movimientos de Fondos del Período"— con las mismas cinco cifras, y quien lo lee busca la
 * diferencia entre ambos hasta que se rinde. El tipo tiene uno y no admite el segundo.
 */
export const movimientoFondosSchema = z
  .object({
    saldoInicial: cifraOFaltanteSchema,
    ingresos: cifraOFaltanteSchema,
    egresos: cifraOFaltanteSchema,
    saldoFinal: cifraOFaltanteSchema,
    /** De dónde salen: "Resumen de cuenta corriente bancaria". */
    fuente: z.string().min(1),
    marcadorObservacion: z.number().int().positive().nullable(),
  })
  .readonly();

/** Rueda de la deuda con proveedores: abre, se devenga, se paga, cierra. */
export const deudaProveedoresSchema = z
  .object({
    saldoInicial: cifraOFaltanteSchema,
    devengadoDelPeriodo: cifraSchema,
    pagadoEnElPeriodo: cifraOFaltanteSchema,
    saldoFinal: cifraOFaltanteSchema,
    /**
     * El cierre del mes anterior, cuando se conoce. Sirve para lo único que importa acá: verificar
     * que el saldo con el que abre este informe sea el que cerró el anterior. En el material real
     * **no lo es en ninguno de los cuatro meses**, y hasta ahora nadie lo veía.
     */
    cierreDelPeriodoAnterior: cifraOFaltanteSchema,
    marcadorObservacion: z.number().int().positive().nullable(),
  })
  .readonly();

export const situacionFinancieraSchema = z
  .object({
    fondos: movimientoFondosSchema,
    deudaProveedores: deudaProveedoresSchema,
  })
  .readonly();
export type SituacionFinanciera = z.infer<typeof situacionFinancieraSchema>;

// --- Denominadores: sin ellos, 166 millones no significan nada ----------------------------------

/**
 * Un número por sí solo no dice nada; con su denominador, sí. El tipo acepta el hueco a propósito:
 * el informe real no trae ni la cantidad de unidades, y **poner un número plausible ahí sería el
 * peor de los errores posibles** en este documento.
 */
export const denominadorSchema = z
  .object({
    clave: z.string().regex(/^[a-z0-9_]+$/),
    etiqueta: z.string().min(1),
    /** Ya formateado: puede ser dinero, un conteo o un porcentaje, así que viaja como texto. */
    valorTexto: z.union([z.string().min(1), datoFaltanteSchema]),
    /**
     * Lo que acompaña al número y **no es número**: "días de gasto", "% de la cuota". Va aparte
     * porque se imprime en la sans y el valor en la monoespaciada — meterlo dentro de `valorTexto`
     * hacía que "5,2 días de gasto" saliera entero en mono, ocupara tres renglones y rompiera la caja.
     */
    unidad: z.string().min(1).nullable(),
    /** Cómo se calcula, para que el vecino pueda rehacerlo: "cuotas ordinarias ÷ unidades". */
    comoSeCalcula: z.string().min(1),
    marcadorObservacion: z.number().int().positive().nullable(),
  })
  .readonly();
export type Denominador = z.infer<typeof denominadorSchema>;

// --- Las series de las tiras: historia congelada, nunca recalculada -----------------------------

/**
 * Las dos series que el informe puede dibujar al lado de sus cifras de cierre (G-2 y G-3).
 *
 * **Cada una es un dato de entrada ya congelado**, no algo que este documento calcule: sus puntos son
 * las cifras que otros informes ya emitieron. Ver `series.ts` para el porqué completo — resumido:
 * un informe emitido no se edita, así que si la serie se recalculara, la historia cambiaría sola y
 * algún día una tira contradiría un PDF que el barrio ya repartió.
 *
 * **Hoy el sistema no las tiene** (hueco F-7, doc 10 §I.9): quien conecte la fuente real tiene que
 * leer valores guardados al cerrar cada período. Mientras no existan, van en `null` y el documento se
 * comporta como hasta ahora — sin tira y sin una palabra de más.
 *
 * **Dos y no tres:** existió una tercera, la cobranza del período (G-4), y se descartó con la pieza
 * generada delante — doc 10 §I.4, descarte 9. Un ratio que se mueve entre 94 % y 102 % dibuja, con el
 * eje desde cero que este producto exige, cuatro columnas del mismo alto. **No se agrega acá una
 * serie sin haber mirado antes qué forma toma**, que es el error que ese descarte documenta.
 */
export const seriesInformeSchema = z
  .object({
    /** Resultado del período: *"¿este superávit es lo normal o es raro?"* (G-2). */
    resultado: serieHistoricaSchema.nullable(),
    /** Deuda con proveedores al cierre: *"¿se está estabilizando o se está yendo?"* (G-3). */
    deudaProveedores: serieHistoricaSchema.nullable(),
  })
  .strict()
  .readonly();
export type SeriesInforme = z.infer<typeof seriesInformeSchema>;

/** Un informe sin historia guardada. Es el estado normal mientras F-7 siga abierto. */
export const SIN_SERIES: SeriesInforme = { resultado: null, deudaProveedores: null };

// --- El documento -------------------------------------------------------------------------------

export const vistaInformeMensualSchema = z
  .object({
    version: z.literal(VERSION_VISTA_INFORME),
    marca: marcaDocumentoSchema,
    barrio: z
      .object({
        nombre: z.string().min(1),
        figuraJuridica: z.enum(FIGURAS_JURIDICAS),
        domicilio: z.string().min(1).nullable(),
      })
      .readonly(),
    /**
     * **El período y la fecha de corte van en el encabezado y en grande.** No es una preferencia de
     * maquetación: este informe cierra hasta dos meses antes que la boleta con la que viaja, y quien
     * lo recibe asume que es del mes que está pagando. `corte` es obligatorio por eso.
     */
    periodo: z
      .object({
        codigo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        etiqueta: z.string().min(1),
        corte: fechaImpresaSchema,
        denominacionConcepto: z.string().min(1),
      })
      .readonly(),
    emision: z.object({ fecha: fechaImpresaSchema.nullable() }).readonly(),
    devengado: resultadoDevengadoSchema,
    conciliacion: conciliacionSchema,
    financiero: situacionFinancieraSchema,
    denominadores: z.array(denominadorSchema).readonly(),
    /**
     * La historia de las dos cifras de cierre, **ya congelada** (ver `seriesInformeSchema`). Tiene
     * default porque hoy ningún productor la tiene: F-7 sigue abierto y el informe sale sin tiras.
     */
    series: seriesInformeSchema.default(SIN_SERIES),
    observaciones: z.array(observacionSchema).readonly(),
    notas: z.array(z.object({ marcador: z.number().int().positive(), texto: z.string().min(1) }).readonly()).readonly(),
    leyendas: z.array(z.string().min(1)).readonly(),
    /** Huecos a nivel documento, como en `VistaBoleta.faltantes`. No se imprimen acá. */
    faltantes: z.array(z.string().min(1)).readonly(),
  })
  .superRefine((v, ctx) => {
    const error = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    // --- (1) El resultado del período existe y es la resta ------------------------------------
    const sumar = (grupos: readonly GrupoImporte[]) =>
      grupos.reduce<bigint>((a, g) => a + aCentavos(g.importe.monto), 0n);

    const ingresos = sumar(v.devengado.ingresos);
    if (ingresos !== aCentavos(v.devengado.totalIngresos.monto)) {
      error(["devengado", "totalIngresos"], `los grupos de ingreso suman ${deCentavos(ingresos)} y el total dice ${v.devengado.totalIngresos.monto}`);
    }
    const egresos = sumar(v.devengado.egresos);
    if (egresos !== aCentavos(v.devengado.totalEgresos.monto)) {
      error(["devengado", "totalEgresos"], `los grupos de gasto suman ${deCentavos(egresos)} y el total dice ${v.devengado.totalEgresos.monto}`);
    }
    const resultado = aCentavos(v.devengado.totalIngresos.monto) - aCentavos(v.devengado.totalEgresos.monto);
    if (resultado !== aCentavos(v.devengado.resultado.monto)) {
      error(
        ["devengado", "resultado"],
        `ingresos menos egresos da ${deCentavos(resultado)} y el resultado del período dice ${v.devengado.resultado.monto}`,
      );
    }

    /**
     * Lo que vale para **todo** grupo de primer nivel, ingrese o egrese.
     *
     * La regla del signo no es formalismo: un grupo negativo arriba deja el denominador en **neto**,
     * y entonces sus hermanos superan el 100 %. En el informe real se veía así —"Cuota ordinaria de
     * lista … 102,93 %" y abajo "Bonificación por pago en término … −7,72 %"—, con el total en
     * 100,00 %. Es aritméticamente impecable y el lector lo lee como un error de cálculo, que en un
     * documento cuyo único trabajo es dar confianza cuesta más caro que un error de verdad.
     *
     * La salida no es cambiar el denominador (el total dejaría de cerrar): es que **una deducción
     * viaje adentro del concepto que la origina**, como línea desagregada. La bonificación es una
     * deducción de la cuota ordinaria, no un ingreso hermano de la cuota; puesta adentro, el grupo
     * publica su neto, el desagregado muestra las dos puntas y ningún porcentaje pasa de 100.
     */
    const revisarGrupo = (g: GrupoImporte, i: number, bloque: "ingresos" | "egresos", total: string) => {
      const esperado = participacion(g.importe.monto, total);
      if (g.participacionTexto !== esperado) {
        error([`devengado`, bloque, i, "participacionTexto"], `la participación impresa dice ${g.participacionTexto} % y sobre el total del documento da ${esperado} %`);
      }
      if (aCentavos(g.importe.monto) < 0n) {
        error(
          ["devengado", bloque, i, "importe"],
          `"${g.etiqueta}" es un grupo negativo de primer nivel: una deducción (bonificación, ` +
            "nota de crédito, recupero) va como línea desagregada del concepto que la origina, no " +
            "como grupo hermano — arriba deja el denominador en neto y hace que los demás grupos " +
            "impriman más de 100 %",
        );
      }
      if (g.desagregado.length > 0) {
        const suma = g.desagregado.reduce<bigint>((a, l) => a + aCentavos(l.importe.monto), 0n);
        if (suma !== aCentavos(g.importe.monto)) {
          error(["devengado", bloque, i, "desagregado"], `el desagregado de "${g.etiqueta}" suma ${deCentavos(suma)} y el grupo dice ${g.importe.monto}`);
        }
        if (g.desagregado.length > g.lineasDeOrigen) {
          error(["devengado", bloque, i, "lineasDeOrigen"], `"${g.etiqueta}" declara ${g.lineasDeOrigen} líneas de origen y desagrega ${g.desagregado.length}`);
        }
      }
    };

    // --- (4) Jerarquía del gasto: piso de desagregación y honorarios con renglón propio --------
    const totalEgresos = aCentavos(v.devengado.totalEgresos.monto);
    v.devengado.egresos.forEach((g, i) => {
      revisarGrupo(g, i, "egresos", v.devengado.totalEgresos.monto);
      // El piso se mide en centésimas de punto para no pasar por `number` en una decisión de dinero,
      // y **en valor absoluto**: la guarda de signo de `revisarGrupo` ya no deja entrar un grupo
      // negativo, pero el valor absoluto es gratis y mantiene la regla cierta si algún día el signo
      // se admite bajo otra condición.
      const bruto = aCentavos(g.importe.monto) * 10_000n;
      const pesoBp = totalEgresos === 0n ? 0n : (bruto < 0n ? -bruto : bruto) / (totalEgresos < 0n ? -totalEgresos : totalEgresos);
      if (pesoBp >= BigInt(PISO_DESAGREGACION_BP) && g.desagregado.length === 0) {
        error(
          ["devengado", "egresos", i, "desagregado"],
          `"${g.etiqueta}" pesa ${participacion(g.importe.monto, v.devengado.totalEgresos.monto)} % del gasto y va sin ` +
            `desagregar: por encima de ${PISO_DESAGREGACION_BP / 100} % el detalle no es opcional`,
        );
      }
    });

    if (!v.devengado.egresos.some((g) => g.clave === CLAVE_HONORARIOS_ADMINISTRACION)) {
      error(
        ["devengado", "egresos"],
        `falta el grupo "${CLAVE_HONORARIOS_ADMINISTRACION}": los honorarios de administración llevan ` +
          "renglón propio siempre, aunque valgan cero. Diluirlos en otro rubro destruye la confianza",
      );
    }

    v.devengado.ingresos.forEach((g, i) => revisarGrupo(g, i, "ingresos", v.devengado.totalIngresos.monto));

    // --- (2) El puente: arranca en el resultado devengado y llega al movimiento de fondos ------
    if (aCentavos(v.conciliacion.partida.monto) !== aCentavos(v.devengado.resultado.monto)) {
      error(["conciliacion", "partida"], `el puente arranca en ${v.conciliacion.partida.monto} y el resultado devengado es ${v.devengado.resultado.monto}`);
    }

    // Un hueco NO se trata como cero: si algún renglón falta, el puente no puede afirmar que cierra
    // y la diferencia sin explicar es obligatoria.
    const hayHueco = v.conciliacion.renglones.some((r) => esFaltante(r.importe));
    const acumulado = v.conciliacion.renglones.reduce<bigint>((a, r) => {
      const monto = montoSiHay(r.importe);
      if (monto === null) return a;
      return a + (r.signo === "suma" ? aCentavos(monto) : -aCentavos(monto));
    }, aCentavos(v.conciliacion.partida.monto));

    const residuo = aCentavos(v.conciliacion.movimientoDeFondos.monto) - acumulado;
    const declarado = v.conciliacion.diferenciaSinExplicar === null ? 0n : aCentavos(v.conciliacion.diferenciaSinExplicar.monto);
    if (residuo !== declarado) {
      error(
        ["conciliacion", "diferenciaSinExplicar"],
        `el puente deja ${deCentavos(residuo)} sin explicar y el documento declara ` +
          `${v.conciliacion.diferenciaSinExplicar === null ? "que cierra exacto" : v.conciliacion.diferenciaSinExplicar.monto}`,
      );
    }
    // Vale tanto para `null` como para un `0,00` explícito: las dos formas afirman que el puente
    // cierra, y con un renglón faltante adentro no se puede afirmar.
    if (hayHueco && declarado === 0n) {
      error(
        ["conciliacion"],
        "el puente tiene un renglón faltante y aun así se declara cerrado: un hueco no es un cero",
      );
    }

    // --- (3) Un solo cuadro de fondos, y tiene que cerrar --------------------------------------
    const f = v.financiero.fondos;
    const inicio = montoSiHay(f.saldoInicial);
    const entra = montoSiHay(f.ingresos);
    const sale = montoSiHay(f.egresos);
    const fin = montoSiHay(f.saldoFinal);
    // Con un hueco en el cuadro de fondos, el puente A→B queda **sin verificar**. Abstenerse está
    // bien; publicarlo callado, no: el documento tiene que decir que ese control no corrió, igual
    // que hace la rueda de proveedores cuando el enganche no ata.
    if ((inicio === null || entra === null || sale === null || fin === null) && f.marcadorObservacion === null) {
      error(
        ["financiero", "fondos", "marcadorObservacion"],
        "el cuadro de fondos tiene un renglón sin dato, así que el puente entre A y B no se pudo " +
          "verificar: eso se señala con una observación, no se publica como si el control hubiera corrido",
      );
    }
    if (inicio !== null && entra !== null && sale !== null && fin !== null) {
      const esperado = aCentavos(inicio) + aCentavos(entra) - aCentavos(sale);
      if (esperado !== aCentavos(fin)) {
        error(["financiero", "fondos", "saldoFinal"], `saldo inicial + ingresos − egresos da ${deCentavos(esperado)} y el saldo final dice ${fin}`);
      }
      const movimiento = aCentavos(fin) - aCentavos(inicio);
      if (movimiento !== aCentavos(v.conciliacion.movimientoDeFondos.monto)) {
        error(
          ["conciliacion", "movimientoDeFondos"],
          `el cuadro de fondos se movió ${deCentavos(movimiento)} y el puente dice ${v.conciliacion.movimientoDeFondos.monto}`,
        );
      }
    }

    const d = v.financiero.deudaProveedores;
    if (aCentavos(d.devengadoDelPeriodo.monto) !== aCentavos(v.devengado.totalEgresos.monto)) {
      error(
        ["financiero", "deudaProveedores", "devengadoDelPeriodo"],
        `la rueda de proveedores devenga ${d.devengadoDelPeriodo.monto} y el gasto del período es ${v.devengado.totalEgresos.monto}`,
      );
    }
    const dIni = montoSiHay(d.saldoInicial);
    const dPag = montoSiHay(d.pagadoEnElPeriodo);
    const dFin = montoSiHay(d.saldoFinal);
    if (dIni !== null && dPag !== null && dFin !== null) {
      const esperado = aCentavos(dIni) + aCentavos(d.devengadoDelPeriodo.monto) - aCentavos(dPag);
      if (esperado !== aCentavos(dFin)) {
        error(["financiero", "deudaProveedores", "saldoFinal"], `abre + devengado − pagado da ${deCentavos(esperado)} y el saldo final dice ${dFin}`);
      }
    }
    // El enganche con el mes anterior no se corrige en silencio: si no ata, tiene que estar señalado.
    const dCierreAnterior = montoSiHay(d.cierreDelPeriodoAnterior);
    if (dIni !== null && dCierreAnterior !== null && aCentavos(dIni) !== aCentavos(dCierreAnterior) && d.marcadorObservacion === null) {
      error(
        ["financiero", "deudaProveedores", "marcadorObservacion"],
        `la deuda a proveedores abre en ${dIni} y el período anterior cerró en ${dCierreAnterior}: ` +
          "la diferencia se señala con una observación, no se publica como si nada",
      );
    }

    // --- Las tiras terminan en el número que el informe imprime --------------------------------
    //
    // Es lo que hace que una tira no pueda ser un gráfico suelto (doc 10 §I.3): está pegada a una
    // cifra que ya está impresa, y su última columna **es** esa cifra. Sin este control, una serie
    // vieja —el caso normal cuando alguien cachea— dibujaría una historia que termina en otro mes que
    // el del encabezado, y nadie lo vería: la tira no lleva números por columna a propósito (§I.5.4).
    const revisarSerie = (
      serie: { readonly puntos: readonly { readonly periodo: string; readonly texto: string | null }[] } | null,
      clave: string,
      esperado: string | null,
    ) => {
      if (serie === null) return;
      const ultimo = serie.puntos[serie.puntos.length - 1];
      if (!ultimo) return;
      if (ultimo.periodo !== v.periodo.codigo) {
        error(
          ["series", clave],
          `la tira termina en ${ultimo.periodo} y el informe es de ${v.periodo.codigo}: la última columna ` +
            "de una tira es la cifra de este documento, no la del mes que se haya guardado último",
        );
      }
      if (esperado !== null && ultimo.texto !== null && ultimo.texto !== esperado) {
        error(
          ["series", clave],
          `la última columna de la tira dice ${ultimo.texto} y el documento imprime ${esperado}: la forma ` +
            "se alimenta del mismo texto publicado que la cifra (doc 10 §I.8.2)",
        );
      }
    };
    revisarSerie(v.series.resultado, "resultado", v.devengado.resultado.texto);
    revisarSerie(
      v.series.deudaProveedores,
      "deudaProveedores",
      esFaltante(d.saldoFinal) ? null : d.saldoFinal.texto,
    );

    // --- Los marcadores apuntan a algo que existe ----------------------------------------------
    const observaciones = new Set(v.observaciones.map((o) => o.marcador));
    const notas = new Set(v.notas.map((n) => n.marcador));
    const revisar = (m: number | null, path: (string | number)[], universo: Set<number>, que: string) => {
      if (m !== null && !universo.has(m)) error(path, `el marcador (${m}) no tiene ${que} que lo explique`);
    };
    v.conciliacion.renglones.forEach((r, i) =>
      revisar(r.marcadorObservacion, ["conciliacion", "renglones", i], observaciones, "observación"),
    );
    v.denominadores.forEach((x, i) => revisar(x.marcadorObservacion, ["denominadores", i], observaciones, "observación"));
    revisar(f.marcadorObservacion, ["financiero", "fondos"], observaciones, "observación");
    revisar(d.marcadorObservacion, ["financiero", "deudaProveedores"], observaciones, "observación");
    if (v.notas.length !== notas.size) error(["notas"], "hay marcadores de nota repetidos");
    if (v.observaciones.length !== observaciones.size) error(["observaciones"], "hay marcadores de observación repetidos");

    // --- Emisión bloqueada por figura jurídica (misma regla que la boleta, doc 07 §E) ----------
    if (v.barrio.figuraJuridica === "fideicomiso") {
      error(
        ["barrio", "figuraJuridica"],
        "fideicomiso: la emisión se bloquea — no hay fuente cargada de denominación ni órganos",
      );
    }
  });

export type VistaInformeMensual = z.infer<typeof vistaInformeMensualSchema>;

/** Valida y devuelve la vista. Único borde por el que entra un informe a renderizarse. */
export function parsearVistaInformeMensual(entrada: unknown): VistaInformeMensual {
  return vistaInformeMensualSchema.parse(entrada);
}

/** Todos los textos que un humano va a leer impresos. Entrada del filtro de doc 07 §E. */
export function textosImpresosDeInforme(v: VistaInformeMensual): string[] {
  return [
    ...v.leyendas,
    ...v.marca.pie,
    ...v.notas.map((n) => n.texto),
    ...v.observaciones.map((o) => o.texto),
    ...v.devengado.ingresos.map((g) => g.etiqueta),
    ...v.devengado.egresos.flatMap((g) => [
      g.etiqueta,
      ...g.desagregado.map((l) => l.concepto),
      ...g.desagregado.map((l) => (l.proveedor.tipo === "razon_social" ? l.proveedor.nombre : "")),
    ]),
    ...v.conciliacion.renglones.flatMap((r) => [r.etiqueta, r.aclaracion ?? ""]),
    ...v.denominadores.flatMap((x) => [x.etiqueta, x.comoSeCalcula]),
    // Los rótulos de las tiras también se imprimen —el primer período y el último— y llegan como
    // texto libre del productor. Un texto impreso que no pasa por el filtro es exactamente el hueco
    // por el que se cuela una palabra que este documento no puede decir (doc 07 §E).
    ...[v.series.resultado, v.series.deudaProveedores].flatMap((s) =>
      s === null ? [] : s.puntos.map((p) => p.etiqueta),
    ),
    // Los motivos de los huecos se imprimen en la celda: pasan por el filtro como cualquier texto.
    ...motivosFaltantes(v),
  ].filter((t) => t.trim().length > 0);
}
