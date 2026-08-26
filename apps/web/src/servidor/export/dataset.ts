import "server-only";

/**
 * El **dataset** del libro de movimientos: de las filas de la base a la estructura que se serializa.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * ESTA CAPA NO SABE QUÉ ES UN XLSX
 *
 * Devuelve hojas con columnas tipadas, filas y bloques de texto. Quién convierte eso en celdas,
 * `numFmt` y solapas es `xlsx.ts`, y es el único archivo que importa `exceljs`. La separación es la
 * del sistema de gas (dataset puro → serializador → ruta) y existe para algo concreto: el día que
 * haga falta otro formato, **se reusa todo este archivo**.
 *
 * Acá se aplican las tres cosas que el panel de dominio pidió y que no son datos sino decisiones:
 * los rótulos ("a cuenta", `SIN CLASIFICAR — requiere definición`), el saneado de fórmula, y los
 * **subtotales calculados server-side** — nunca como fórmula de Excel, porque una fórmula puede
 * recalcularse distinto en la máquina del contador y dejar de coincidir con lo que dice el sistema
 * (CLAUDE.md §1.4).
 */

import {
  montoANumeroDePlanilla,
  restarMontos,
  sumarMontos,
} from "@admin-barrios/shared/dinero";
import { sanearNombreDeArchivo, sanearTextoDePlanilla } from "@admin-barrios/shared/planilla";
import type { LibroDeMovimientos } from "@admin-barrios/data/servicios/exportaciones";

/**
 * De qué tipo es una celda. **`identificador` no es `texto` por comodidad**: es la diferencia entre
 * un CBU que se lee y uno que Excel redondeó. Ver `xlsx.ts`.
 */
export type TipoDeColumna = "texto" | "identificador" | "fecha" | "monto" | "entero" | "bool";

export type Columna = { readonly header: string; readonly tipo: TipoDeColumna };
export type Celda = string | number | boolean | null;

export type Hoja = {
  /** Nombre de la solapa. Excel corta en 31 caracteres. */
  readonly nombre: string;
  /** Renglones de contexto antes de la tabla: encabezado del libro, avisos, subtotales. */
  readonly bloquePrevio: readonly string[];
  readonly columnas: readonly Columna[];
  readonly filas: readonly Celda[][];
  /** Renglones de cierre: los totales, ya calculados. */
  readonly bloquePosterior: readonly string[];
};

export type LibroParaPlanilla = {
  readonly nombreArchivo: string;
  readonly hojas: readonly Hoja[];
};

const SIN_CLASIFICAR = "SIN CLASIFICAR — requiere definición";

/** Cómo se lee cada valor del enum en la planilla. La leyenda las explica una por una. */
const ETIQUETA_FISCAL: Record<string, string> = {
  alcanzado: "Alcanzado",
  no_alcanzado: "No alcanzado",
  ingreso_ajeno: "Ingreso ajeno",
  no_gravado: "No gravado",
  sin_clasificar: SIN_CLASIFICAR,
};

const ETIQUETA_ORIGEN_CLASIFICACION = {
  snapshot: "Congelada al emitir",
  catalogo: "Catálogo vigente (borrador)",
} as const;

/**
 * El libro completo, listo para serializar.
 *
 * `selloDeExtraccion` entra por parámetro y no se calcula acá: tiene que ser **el mismo instante**
 * que se registró en la traza, porque es lo único que permite atar un archivo que anda dando vueltas
 * por un mail a su fila de auditoría.
 */
export function construirLibro(
  libro: LibroDeMovimientos,
  rango: { readonly periodoDesde: string; readonly periodoHasta: string },
  selloDeExtraccion: string,
): LibroParaPlanilla {
  const { cabecera } = libro;
  const provisorio = cabecera.incluyeProvisorio;

  const encabezado = [
    `Libro de movimientos — ${sanearTextoDePlanilla(cabecera.barrioNombre)}`,
    ...(provisorio
      ? [
          "PROVISORIO — el rango incluye períodos no emitidos. La clasificación fiscal de esas líneas " +
            "proviene del catálogo vigente al momento de la extracción y puede diferir de la que se " +
            "congele al emitir.",
        ]
      : []),
    `Período: ${rango.periodoDesde} a ${rango.periodoHasta}`,
    `Figura jurídica vigente en el período: ${sanearTextoDePlanilla(cabecera.figuraJuridica)}`,
    `CUIT: ${cabecera.barrioCuit ?? "(no cargado)"} · Municipio: ${sanearTextoDePlanilla(cabecera.municipio)}`,
    `Modelo de expensa del período: ${cabecera.modelosDePeriodo.join(", ") || "(sin períodos en el rango)"}`,
    "Moneda: pesos argentinos (ARS)",
    `Extraído el: ${selloDeExtraccion}`,
    "Este archivo es un extracto de movimientos registrados. NO es una liquidación impositiva ni una " +
      "declaración jurada. Contiene datos personales — uso interno del barrio.",
  ];

  return {
    nombreArchivo: nombreDeArchivo(cabecera.barrioNombre, rango, provisorio, selloDeExtraccion),
    hojas: [
      hojaCobranzas(libro, encabezado),
      hojaImputadas(libro, encabezado),
      hojaEgresos(libro, encabezado),
      hojaAnulaciones(libro, encabezado),
      hojaLeyenda(),
    ],
  };
}

/**
 * Hoja A — **una línea por pago**. Es la única que se puede cruzar contra el extracto bancario, que
 * es lo primero que hace el contador con este archivo: un pago que cubrió tres boletas fue **un**
 * movimiento en el banco, no tres.
 *
 * El pago sin imputar se rotula **"a cuenta"** y no "sin imputar" ni con el concepto vacío: un
 * blanco se lee como error de carga, "a cuenta" se lee como lo que es —plata que entró y todavía no
 * se aplicó a una boleta— y es además como se lo nombra en la operatoria.
 */
function hojaCobranzas(libro: LibroDeMovimientos, encabezado: readonly string[]): Hoja {
  const totalCobrado = sumarTodos(libro.ingresos.map((i) => i.monto));
  const totalAplicado = sumarTodos(libro.ingresos.map((i) => i.montoImputado));
  const totalACuenta = restarMontos(totalCobrado, totalAplicado);

  return {
    nombre: "Cobranzas (percibido)",
    bloquePrevio: [...encabezado, "", `Cobranzas registradas: ${libro.ingresos.length}`],
    columnas: [
      { header: "Fecha de pago", tipo: "fecha" },
      { header: "Unidad", tipo: "texto" },
      { header: "Obligado", tipo: "texto" },
      { header: "CUIT/CUIL", tipo: "identificador" },
      { header: "Importe cobrado", tipo: "monto" },
      { header: "Importe aplicado", tipo: "monto" },
      { header: "A cuenta", tipo: "monto" },
      { header: "Aplicación", tipo: "texto" },
      { header: "Períodos aplicados", tipo: "texto" },
      { header: "Origen", tipo: "texto" },
      { header: "Conciliación", tipo: "texto" },
    ],
    filas: libro.ingresos.map((i) => {
      const aCuenta = restarMontos(i.monto, i.montoImputado);
      return [
        i.fecha,
        sanearTextoDePlanilla(i.unidadEtiqueta),
        sanearTextoDePlanilla(i.obligadoNombre),
        i.obligadoCuit,
        montoANumeroDePlanilla(i.monto),
        montoANumeroDePlanilla(i.montoImputado),
        montoANumeroDePlanilla(aCuenta),
        etiquetaDeAplicacion(i.montoImputado, i.monto, i.periodosImputados),
        sanearTextoDePlanilla(i.periodosImputados),
        i.origen,
        i.estadoConciliacion,
      ];
    }),
    // La fila de control: es el puente con la hoja B, y lo que le permite al contador confiar en ella.
    bloquePosterior: [
      `Total cobrado: ${totalCobrado}`,
      `Total aplicado: ${totalAplicado}`,
      `Total a cuenta: ${totalACuenta}`,
      "Control: total cobrado = total aplicado + total a cuenta.",
    ],
  };
}

/**
 * Hoja B — **una línea por imputación**, más una fila residual "a cuenta" por cada pago que no se
 * aplicó del todo. Esa fila residual es la que hace que esta hoja **sume exactamente igual** que la
 * A, y esa identidad es el producto de la exportación.
 *
 * **No se llama "devengado" en ningún rótulo**: es caja asignada a un devengado anterior. El
 * devengado real es la liquidación emitida, que es otro dato.
 *
 * **La composición de la boleta va tal cual, sin prorratear.** `pago_imputacion` imputa contra la
 * liquidación entera y no contra el ítem, así que **no está registrado a qué rubro fue el dinero**.
 * Cuando el pago cubre la boleta completa la composición es exacta y la columna lo dice; cuando es
 * parcial, el contador ve que lo es y prorratea con su criterio. Repartir acá en silencio sería
 * exactamente la cifra sin origen que CLAUDE.md §1.4 prohíbe.
 */
function hojaImputadas(libro: LibroDeMovimientos, encabezado: readonly string[]): Hoja {
  const filas: Celda[][] = libro.imputaciones.map((im) => {
    const cubreCompleta = im.montoImputado === im.liquidacionTotal;
    return [
      im.fechaPago,
      sanearTextoDePlanilla(im.unidadEtiqueta),
      im.periodoOrigen,
      im.numeroComprobante,
      montoANumeroDePlanilla(im.montoImputado),
      cubreCompleta ? "Cubre la boleta completa" : "Aplicación parcial",
      montoANumeroDePlanilla(im.liquidacionTotal),
      montoANumeroDePlanilla(im.subtotalOrdinarias),
      montoANumeroDePlanilla(im.subtotalExtraordinarias),
      montoANumeroDePlanilla(im.subtotalFondoReserva),
      im.interesMora === null ? null : montoANumeroDePlanilla(im.interesMora),
    ];
  });

  // La residual: lo que de cada pago no se aplicó a ninguna boleta.
  for (const i of libro.ingresos) {
    const aCuenta = restarMontos(i.monto, i.montoImputado);
    if (aCuenta === "0.00") continue;
    filas.push([
      i.fecha,
      sanearTextoDePlanilla(i.unidadEtiqueta),
      "(sin aplicar)",
      null,
      montoANumeroDePlanilla(aCuenta),
      "A cuenta — todavía no aplicado a una boleta",
      null,
      null,
      null,
      null,
      null,
    ]);
  }

  const total = sumarTodos(libro.ingresos.map((i) => i.monto));

  return {
    nombre: "Cobranzas imputadas",
    bloquePrevio: [
      ...encabezado,
      "",
      "Cada línea es la aplicación de un cobro a la boleta de un período. Las líneas «a cuenta» son " +
        "cobros todavía no aplicados: están para que esta hoja sume igual que «Cobranzas (percibido)».",
      "Los subtotales por rubro son la COMPOSICIÓN DE LA BOLETA cubierta, no el detalle de la " +
        "aplicación: el sistema registra a qué boleta fue el pago, no a qué rubro dentro de ella.",
    ],
    columnas: [
      { header: "Fecha de pago", tipo: "fecha" },
      { header: "Unidad", tipo: "texto" },
      { header: "Período de origen", tipo: "texto" },
      { header: "Comprobante", tipo: "identificador" },
      { header: "Importe aplicado", tipo: "monto" },
      { header: "Alcance", tipo: "texto" },
      { header: "Total de la boleta", tipo: "monto" },
      { header: "Boleta: ordinarias", tipo: "monto" },
      { header: "Boleta: extraordinarias", tipo: "monto" },
      { header: "Boleta: fondo de reserva", tipo: "monto" },
      { header: "Boleta: interés por mora", tipo: "monto" },
    ],
    filas,
    bloquePosterior: [`Total de la hoja (aplicado + a cuenta): ${total}`, "Coincide con «Total cobrado» de la hoja «Cobranzas (percibido)»."],
  };
}

/**
 * Egresos del rango.
 *
 * **Tres columnas de fecha, y ninguna miente.** `Fecha de pago` sale solo de `orden_pago.pagada_at`
 * y queda vacía cuando no hay orden de pago; `Fecha de comprobante` está siempre vacía porque el
 * modelo **no guarda la fecha de la factura del proveedor**; `Fecha de carga` es `created_at` y se
 * llama así. Una sola columna "fecha" que a veces es una cosa y a veces otra es un total que no se
 * puede auditar, porque desde la planilla no hay forma de saber qué fila es de qué tipo.
 *
 * **Los ajustes de una orden de pago anulada salen como reversión**, con la descripción y el período
 * del gasto que revierten a la vista. Nunca un negativo suelto (CLAUDE.md §1.4).
 */
function hojaEgresos(libro: LibroDeMovimientos, encabezado: readonly string[]): Hoja {
  const sinClasificar = libro.egresos.filter((e) => e.clasificacionFiscal === "sin_clasificar");
  const totalSinClasificar = sumarTodos(sinClasificar.map((e) => e.monto));
  const sinRespaldo = libro.egresos.filter((e) => e.sinRespaldoDocumental);
  const totalSinRespaldo = sumarTodos(sinRespaldo.map((e) => e.monto));

  return {
    nombre: "Egresos",
    bloquePrevio: [
      ...encabezado,
      "",
      `Conceptos pendientes de encuadre fiscal: ${sinClasificar.length} líneas, ${totalSinClasificar}`,
      `Egresos sin respaldo documental declarado: ${sinRespaldo.length} líneas, ${totalSinRespaldo}`,
      "«Fecha de comprobante» va vacía: el sistema todavía no registra la fecha de la factura del proveedor.",
    ],
    columnas: [
      { header: "Período", tipo: "texto" },
      { header: "Fecha de pago", tipo: "fecha" },
      { header: "Fecha de comprobante", tipo: "fecha" },
      { header: "Fecha de carga", tipo: "fecha" },
      { header: "Concepto", tipo: "texto" },
      { header: "Tipo (art. 2048)", tipo: "texto" },
      { header: "Fondo de reserva", tipo: "bool" },
      { header: "Descripción", tipo: "texto" },
      { header: "Proveedor", tipo: "texto" },
      { header: "CUIT proveedor", tipo: "identificador" },
      { header: "N° de factura", tipo: "identificador" },
      { header: "Importe", tipo: "monto" },
      { header: "Movimiento", tipo: "texto" },
      { header: "Revierte a", tipo: "texto" },
      { header: "Clasificación fiscal declarada", tipo: "texto" },
      { header: "Origen de la clasificación", tipo: "texto" },
      { header: "Respaldo documental", tipo: "texto" },
      { header: "Respaldo de asamblea", tipo: "texto" },
    ],
    filas: libro.egresos.map((e) => {
      const esReversion = e.revierteDescripcion !== null;
      return [
        e.periodo,
        e.fechaPago,
        null, // hueco declarado: no existe la fecha de la factura en el modelo
        e.fechaRegistracion,
        sanearTextoDePlanilla(e.conceptoNombre),
        e.conceptoTipo,
        e.esFondoReserva,
        sanearTextoDePlanilla(e.descripcion),
        sanearTextoDePlanilla(e.proveedorNombre),
        e.proveedorCuit,
        sanearTextoDePlanilla(e.numeroFactura),
        montoANumeroDePlanilla(e.monto),
        esReversion ? "Reversión de una orden de pago anulada" : "Egreso",
        esReversion
          ? sanearTextoDePlanilla(`${e.revierteDescripcion} (período ${e.revierteperiodo ?? "s/d"})`)
          : null,
        ETIQUETA_FISCAL[e.clasificacionFiscal] ?? e.clasificacionFiscal,
        ETIQUETA_ORIGEN_CLASIFICACION[e.origenClasificacion],
        e.sinRespaldoDocumental
          ? `Declarado sin factura: ${sanearTextoDePlanilla(e.motivoSinRespaldo)}`
          : "Con respaldo o pendiente",
        e.sinRespaldoAsamblea ? "Extraordinaria SIN acta de asamblea" : "",
      ];
    }),
    bloquePosterior: [`Total de egresos del rango: ${sumarTodos(libro.egresos.map((e) => e.monto))}`],
  };
}

/**
 * Los pagos **anulados dentro del rango, aunque su fecha sea anterior** — el caso que más molesta en
 * la operatoria: un pago de mayo anulado en agosto cambia una planilla de mayo que el contador ya
 * procesó. Van en su hoja, **fuera de todo total**, y nunca borrados en silencio.
 */
function hojaAnulaciones(libro: LibroDeMovimientos, encabezado: readonly string[]): Hoja {
  return {
    nombre: "Anulaciones",
    bloquePrevio: [
      ...encabezado,
      "",
      "Cobros ANULADOS dentro de este rango, aunque su fecha de pago sea anterior. NO están incluidos " +
        "en ningún total de las otras hojas: se listan para explicar por qué una extracción anterior " +
        "del mismo período pudo haber dado distinto.",
    ],
    columnas: [
      { header: "Fecha de anulación", tipo: "fecha" },
      { header: "Fecha del pago original", tipo: "fecha" },
      { header: "Unidad", tipo: "texto" },
      { header: "Importe anulado", tipo: "monto" },
      { header: "Motivo", tipo: "texto" },
    ],
    filas: libro.anulaciones.map((a) => [
      a.anuladoAt,
      a.fecha,
      sanearTextoDePlanilla(a.unidadEtiqueta),
      montoANumeroDePlanilla(a.monto),
      sanearTextoDePlanilla(a.motivoAnulacion),
    ]),
    bloquePosterior: [`Anulaciones en el rango: ${libro.anulaciones.length}`],
  };
}

/**
 * La leyenda. Existe por una razón puntual: que `sin clasificar` **no se lea como una afirmación
 * fiscal**. Un blanco o un guion lo lee cualquiera como "no corresponde", y eso es precisamente
 * afirmar un encuadre por omisión — que es lo que el enum, al no llevar default, fue diseñado para
 * impedir.
 */
function hojaLeyenda(): Hoja {
  return {
    nombre: "Leyenda",
    bloquePrevio: [
      "Cómo leer este archivo",
      "",
      "La columna «Clasificación fiscal declarada» es un dato que cargó el administrador. NO constituye " +
        "una liquidación del Impuesto sobre los Ingresos Brutos ni de ningún otro tributo.",
    ],
    columnas: [
      { header: "Valor", tipo: "texto" },
      { header: "Qué significa", tipo: "texto" },
    ],
    filas: [
      ["Alcanzado", "El administrador declaró que el concepto está alcanzado."],
      ["No alcanzado", "El administrador declaró que el concepto no está alcanzado."],
      ["Ingreso ajeno", "Ingreso que no es propio del barrio (se cobra por cuenta de un tercero)."],
      ["No gravado", "El administrador declaró que el concepto no está gravado."],
      [
        SIN_CLASIFICAR,
        "Nadie definió el encuadre todavía. NO es una afirmación de que el concepto esté fuera del " +
          "alcance del Impuesto sobre los Ingresos Brutos.",
      ],
      ["", ""],
      ["Congelada al emitir", "La clasificación quedó fija cuando se emitió el período."],
      [
        "Catálogo vigente (borrador)",
        "El período no está emitido: la clasificación se tomó del catálogo al momento de extraer y " +
          "puede cambiar cuando se emita.",
      ],
      ["", ""],
      [
        "A cuenta",
        "Cobro registrado que todavía no se aplicó a la boleta de ningún período.",
      ],
      [
        "Reversión de una orden de pago anulada",
        "Contrapartida de un egreso anterior que se anuló después de emitido su período. La columna " +
          "«Revierte a» dice cuál.",
      ],
    ],
    bloquePosterior: [],
  };
}

// --- Auxiliares ---------------------------------------------------------------------------------

function sumarTodos(montos: readonly string[]): string {
  return montos.length === 0 ? "0.00" : sumarMontos(...montos);
}

function etiquetaDeAplicacion(
  imputado: string,
  total: string,
  periodos: string | null,
): string {
  if (imputado === "0.00") return "A cuenta — sin aplicar";
  if (imputado !== total) return "Aplicación parcial";
  return (periodos ?? "").includes(",") ? "Aplicado a varios períodos" : "Aplicado a un período";
}

/**
 * El nombre del archivo. Lleva el barrio (lo hace usable en una carpeta de Descargas) y **nunca el
 * nombre de una persona**. El `PROVISORIO` y el sello van adentro del nombre a propósito: es la
 * única defensa cuando hay tres versiones del mismo período en la misma carpeta.
 */
function nombreDeArchivo(
  barrio: string,
  rango: { readonly periodoDesde: string; readonly periodoHasta: string },
  provisorio: boolean,
  sello: string,
): string {
  const selloCompacto = sello.replace(/[:\s]/g, "-");
  const partes = [
    "movimientos",
    barrio,
    rango.periodoDesde,
    rango.periodoHasta,
    ...(provisorio ? ["PROVISORIO", selloCompacto] : []),
  ];
  return `${sanearNombreDeArchivo(partes.join("_"))}.xlsx`;
}
