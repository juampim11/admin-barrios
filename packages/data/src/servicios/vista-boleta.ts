/**
 * Armado de la `VistaBoleta` desde la base.
 *
 * Mismo patrón que `liquidacion.ts`: **lectura → armado puro → nada de escritura**. Corre dentro de
 * la transacción del request (`conUsuario`), y el `barrio_id` se deriva del período bajo RLS: este
 * servicio **no filtra por barrio a mano** y no lo recibe por parámetro (doc 07 §F.1).
 *
 * **Cuidado con lo que la RLS NO decide.** `app.accessible_tenant_ids()` mira que haya un
 * `membership` activo sobre el barrio, **no el rol**: un `propietario` o un `residente` pasan las
 * policies de `liquidacion` igual que un `admin_barrio`. Y emitir el padrón entero en PDF, con el
 * nombre del obligado de cada unidad, es una autorización sobre una **operación**, no sobre filas:
 * "puede leer la fila X" no es "puede exportar las N filas como documentos", y la RLS no expresa esa
 * diferencia. Por eso el gate de rol está acá abajo, explícito, y no se delega en la policy.
 *
 * **Sin N+1**: cuatro consultas para N boletas —período, suma de coeficientes, liquidaciones e
 * ítems— y el agrupado se hace en memoria. Con 200 unidades eso es 4 viajes a la base, no 800.
 *
 * Todo lo que el diseño (doc 09 §E) pide y el modelo todavía no guarda **se declara en `faltantes`**,
 * no se inventa ni se calcula mal.
 */

import { sql } from "drizzle-orm";
import { formatearDecimal, sumarMontos } from "@admin-barrios/shared/dinero";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import {
  acentoImpreso,
  cifra,
  coeficienteImpreso,
  fechaImpresa,
  parsearVistaBoleta,
  VERSION_VISTA_BOLETA,
  type BandaEstado,
  type Clasificacion2048,
  type LineaDetalle,
  type RenglonComposicion,
  type VistaBoleta,
} from "@admin-barrios/shared/documentos";
import { revisarTextosImpresos, textosImpresosDeBoleta } from "@admin-barrios/documentos";
import type { EntradaBloquePago, MedioCobranza } from "@admin-barrios/documentos/cobranza";
import type { DbConIdentidad } from "../client.ts";

/**
 * Huecos de modelo que este armador **no puede llenar**, con la referencia al lugar donde están
 * documentados. Viajan congelados en la vista: el día que el dato exista, se sabe exactamente qué
 * boletas se emitieron sin él.
 */
export const FALTANTES_CONOCIDOS = {
  fechaTope: "fecha tope de la red de cobranza — no existe como campo propio (doc 09 §E.11 ítem 1)",
  instrumento: "código de barras, código electrónico y convenio — no existe ningún campo (doc 09 §E.11 ítems 2–4)",
  numeracion: "numeración de comprobante con serie y correlativo — hoy es texto libre nullable (doc 09 §E.11 ítem 4)",
  bonificacionNoAplicada:
    "renglón informativo de bonificación NO aplicada — no existe y no puede ser un item_liquidacion (doc 09 §E.11 ítem 5)",
  origenEvaluacion: "origen de la evaluación del cumplidor — sin columna (doc 09 §E.11 ítem 6)",
  desgloseSaldo: "desglose del saldo anterior período por período — hoy es un solo número (doc 09 §E.11 ítem 7)",
  delta: "delta contra el período anterior (doc 09 §E.11 ítem 8)",
  rolDestinatario: "rol imprimible del destinatario (propietario / inquilino) (doc 09 §E.11 ítem 9)",
  marcaBarrio: "marca del barrio: logo, nombre comercial y color de acento — no existe (doc 09 §E.11 ítem 12)",
  marcaEmisor:
    "datos del emisor: CUIT, domicilio, contacto y logo de la administración — tenant_node solo tiene `nombre` (doc 09 §E.11 ítem 12.bis)",
  mandatoNoCongelado:
    "la marca del administrador con mandato vigente no se congela en la liquidación: una boleta vieja mostraría la administración de hoy (doc 09 §E.14 punto 8)",
  medioCobranzaPorBarrio: "variante de pago del barrio (P1–P5) y convenio de cobranza — sin modelo (doc 09 §E.11 ítems 13–14)",
} as const;

// --- Filas crudas -------------------------------------------------------------------------------

type FilaPeriodo = {
  periodo_id: string;
  barrio_id: string;
  periodo: string;
  estado: "borrador" | "revisada" | "emitida" | "distribuida";
  modelo: "variable" | "fija";
  denominacion_concepto: string | null;
  primer_vencimiento: string | null;
  segundo_vencimiento: string | null;
  total_gastos: string | null;
  coeficiente_version_id: string | null;
  fecha_emision: string | null;
  figura_juridica: "sa" | "asociacion_civil" | "ph_especial" | "fideicomiso" | "geodesia";
  domicilio_sede: string | null;
  tiene_fondo_reserva: boolean;
  barrio_nombre: string;
  administrador_nombre: string | null;
  /** Hay un mandato de administración abierto. Ver la compuerta 0 de `armarVistasDelPeriodo`. */
  tiene_mandato: boolean;
  puede_emitir: boolean;
};

/**
 * Roles que pueden emitir documentos del padrón. **No incluye `propietario` ni `residente`**: el día
 * que exista el portal del residente, ese camino tendrá que leer **su propia** liquidación (doc 08
 * §Y), que es una consulta distinta y no "el período entero en PDF".
 */
const ROLES_QUE_EMITEN = ["admin_plataforma", "admin_barrio", "operador"] as const;

type FilaLiquidacion = {
  id: string;
  manzana: string;
  lote: string;
  obligado_nombre: string | null;
  coeficiente_aplicado: string;
  numero_comprobante: string | null;
  subtotal_cuota_fija: string;
  subtotal_ordinarias: string;
  subtotal_extraordinarias: string;
  subtotal_fondo_reserva: string;
  subtotal_cargos: string;
  subtotal_descuentos: string;
  saldo_anterior: string;
  interes_mora: string | null;
  mora_pendiente_definicion: boolean;
  tasa_mora_aplicada: string | null;
  dias_atraso: number | null;
  fecha_corte_mora: string | null;
  total: string;
};

type FilaItem = {
  liquidacion_id: string;
  descripcion: string;
  clase_item: "prorrateo" | "cuota_fija" | "cargo" | "descuento";
  tipo: "ordinaria" | "extraordinaria" | null;
  es_fondo_reserva: boolean;
  acta_titulo: string | null;
  base_monto: string;
  coeficiente_aplicado: string | null;
  monto: string;
  monto_teorico: string | null;
  ajuste_redondeo: string;
  detalle_hecho: string | null;
  fecha_hecho: string | null;
};

// --- Helpers puros ------------------------------------------------------------------------------

/** `"0.030000"` (fracción) → `"3,0000"` (porcentaje impreso). Sin `number`: la tasa mueve plata. */
function tasaImpresa(fraccion: string): string {
  const [ent = "0", dec = ""] = fraccion.split(".");
  const digitos = ent + dec;
  const punto = ent.length + 2;
  const rellenado = digitos.padEnd(punto + 1, "0");
  const enteros = rellenado.slice(0, punto).replace(/^0+(?=\d)/, "");
  return formatearDecimal(`${enteros}.${rellenado.slice(punto)}`, 4);
}

function clasificacion2048De(item: FilaItem): Clasificacion2048 {
  if (item.clase_item === "cargo" || item.clase_item === "descuento") return "no_corresponde";
  if (item.es_fondo_reserva) return "fondo_reserva";
  return item.tipo === "extraordinaria" ? "extraordinaria" : "ordinaria";
}

// --- Consultas ----------------------------------------------------------------------------------

async function leerPeriodo(tx: DbConIdentidad, periodoId: string): Promise<FilaPeriodo> {
  const fila = (
    await tx.execute<FilaPeriodo>(sql`
      select p.id as periodo_id, p.barrio_id, p.periodo, p.estado, p.modelo, p.denominacion_concepto,
             p.primer_vencimiento::text, p.segundo_vencimiento::text, p.total_gastos::text,
             p.coeficiente_version_id,
             p.emitida_at::date::text as fecha_emision,
             b.figura_juridica, b.domicilio_sede, b.tiene_fondo_reserva,
             tb.nombre as barrio_nombre,
             ta.nombre as administrador_nombre,
             -- La fila del mandato SÍ se lee siempre (su policy mira barrio_id); el nombre del
             -- estudio vive en tenant_node y hasta 0020 no se veía desde el barrio. Traer las dos
             -- cosas por separado es lo que permite distinguir "no hay administrador" de "hay uno y
             -- no lo puedo leer" — dos situaciones que el left join colapsaba en un solo null.
             (m.id is not null) as tiene_mandato,
             app.has_role_on(p.barrio_id, ${sql.raw(`array[${ROLES_QUE_EMITEN.map((r) => `'${r}'`).join(",")}]::app.rol_membership[]`)}) as puede_emitir
        from periodo_expensa p
        join barrio b on b.barrio_id = p.barrio_id
        join tenant_node tb on tb.id = p.barrio_id
        left join mandato_administracion m on m.barrio_id = p.barrio_id and m.hasta is null
        left join tenant_node ta on ta.id = m.administrador_id
       where p.id = ${periodoId}
    `)
  ).rows[0];
  if (!fila) throw new Error("el período no existe o no es accesible");
  return fila;
}

/**
 * Suma de los coeficientes con los que **efectivamente se repartió**.
 *
 * El `join` a `unidad_funcional` con `baja_at is null` **no es opcional**: es exactamente el mismo
 * filtro que usa el prorrateo en `liquidacion.ts`. `unidad_funcional` tiene baja lógica y
 * `coeficiente` no tiene columna de vigencia, así que en cualquier barrio con una unidad dada de
 * baja después de cerrar la versión, sumar la tabla entera da un denominador **mayor** que el que
 * cobró: el porcentaje impreso quedaría por debajo del real y la cuenta dejaría de rehacerse con
 * una calculadora — por mucho más que el "$ 0,01 por unidad" que promete la leyenda fija.
 */
async function leerSumaCoeficientes(tx: DbConIdentidad, versionId: string): Promise<string> {
  const fila = (
    await tx.execute<{ suma: string | null }>(sql`
      select sum(c.valor)::text as suma
        from coeficiente c
        join unidad_funcional u on u.id = c.unidad_funcional_id
       where c.version_id = ${versionId} and u.baja_at is null
    `)
  ).rows[0];
  if (!fila?.suma) throw new Error("la versión de coeficientes del período no tiene unidades activas");
  return fila.suma;
}

// --- Armado -------------------------------------------------------------------------------------

export type OpcionesVistaBoleta = {
  /** Adapter que arma el bloque de pago. Se pasa explícito: el barrio todavía no tiene columna. */
  readonly medio: MedioCobranza;
  /** Solo estas unidades (por `liquidacion.id`). Vacío o ausente = todas las del período. */
  readonly liquidacionIds?: readonly string[];
};

/**
 * Arma la vista de **todas** las boletas de un período, en el orden en que se recorre el padrón
 * (manzana, lote).
 */
export async function armarVistasDelPeriodo(
  tx: DbConIdentidad,
  periodoId: string,
  opciones: OpcionesVistaBoleta,
): Promise<VistaBoleta[]> {
  const periodo = await leerPeriodo(tx, periodoId);

  if (!periodo.puede_emitir) {
    // La RLS ya dejó leer el período (hay membership sobre el barrio), pero emitir los documentos
    // del padrón es otra cosa: sale el nombre del obligado de **cada** unidad.
    throw new Error(
      "no tenés permiso para emitir documentos de este barrio: hace falta un rol de administración " +
        `(${ROLES_QUE_EMITEN.join(", ")})`,
    );
  }

  // Compuerta 0: **el emisor impreso no puede caer a un valor por defecto.**
  //
  // `marca.emisor.razonSocial` es un dato legal que va impreso en un comprobante. Hasta la migración
  // 0020, `tenant_node_sel` no alcanzaba a los ancestros y el nombre del estudio volvía `null` para
  // quien tuviera membresía solo en el barrio — un `operador`, que SÍ puede emitir. El `??` que había
  // más abajo lo tapaba con el nombre del barrio y emitía igual: un emisor equivocado, impreso, sin
  // que nadie se enterara.
  //
  // La distinción que importa, y que el `left join` no dejaba ver:
  //   · sin mandato abierto  → el barrio se autoadministra: el emisor ES el barrio, y es correcto.
  //   · con mandato y sin nombre legible → hay un administrador y no lo puedo leer. Imprimir el
  //     nombre del barrio sería afirmar algo falso, así que **no se emite**.
  //
  // Con 0020 aplicada, esta rama es inalcanzable por el camino normal. Queda igual: es el candado que
  // hace que el día que alguien vuelva a tocar la policy, falle la emisión y no el documento.
  if (periodo.tiene_mandato && !periodo.administrador_nombre) {
    throw new Error(
      "el barrio tiene un mandato de administración abierto pero el nombre del administrador no es " +
        "legible: la emisión se bloquea antes que imprimir un emisor equivocado. Las dos causas " +
        "posibles son que el nodo del estudio esté dado de baja (`deleted_at`) o que la policy de " +
        "`tenant_node` no alcance al ancestro (ADR-0002 §3.4, migración 0020 §2)",
    );
  }

  if (periodo.figura_juridica === "fideicomiso") {
    // Mismo criterio que el bloqueo por medio no configurado: el sistema no emite un documento que
    // tendría que afirmar algo que `knowledge/` no sostiene (doc 07 §E).
    throw new Error(
      "fideicomiso: la emisión está bloqueada hasta que exista la fuente cargada de denominación y órganos — " +
        "el sistema no cae al texto de PH por defecto",
    );
  }
  if (!periodo.coeficiente_version_id) {
    throw new Error("el período no tiene fijada la versión de coeficientes: hay que liquidarlo antes de emitir");
  }
  if (!periodo.primer_vencimiento) {
    throw new Error("el período no tiene primer vencimiento cargado: no se emite una boleta sin fecha de pago");
  }
  if (!periodo.total_gastos) {
    throw new Error("el período no tiene el total de gastos calculado: hay que liquidarlo antes de emitir");
  }

  const sumaCoeficientes = await leerSumaCoeficientes(tx, periodo.coeficiente_version_id);

  // El filtro por liquidación baja a los dos `where`: la vista previa de una boleta es un camino
  // interactivo (ADR-0001 §5) y traerse las 200 liquidaciones con sus ~4.000 ítems para renderizar
  // una sola es exactamente lo que la regla de recursos prohíbe.
  const ids = opciones.liquidacionIds ?? [];
  // `sql.param` es necesario: interpolar un array pelado en el template de Drizzle lo aplana en
  // un parámetro por elemento y Postgres recibe un uuid donde esperaba un array.
  const filtroLiq = ids.length > 0 ? sql` and l.id = any(${sql.param(ids)}::uuid[])` : sql``;

  const liquidaciones = (
    await tx.execute<FilaLiquidacion>(sql`
      select l.id, u.manzana, u.lote, o.nombre as obligado_nombre,
             l.coeficiente_aplicado::text, l.numero_comprobante,
             l.subtotal_cuota_fija::text, l.subtotal_ordinarias::text, l.subtotal_extraordinarias::text,
             l.subtotal_fondo_reserva::text, l.subtotal_cargos::text, l.subtotal_descuentos::text,
             l.saldo_anterior::text, l.interes_mora::text, l.mora_pendiente_definicion,
             l.tasa_mora_aplicada::text, l.dias_atraso, l.fecha_corte_mora::text, l.total::text
        from liquidacion l
        join unidad_funcional u on u.id = l.unidad_funcional_id
        left join obligado o on o.id = l.obligado_id
       where l.periodo_id = ${periodoId}${filtroLiq}
       order by u.manzana, u.lote
    `)
  ).rows;

  const elegidas = liquidaciones;
  if (elegidas.length === 0) return [];

  // Una sola consulta para TODOS los ítems del período: el agrupado se hace acá.
  const items = (
    await tx.execute<FilaItem>(sql`
      select i.liquidacion_id, i.descripcion, i.clase_item, i.tipo, i.es_fondo_reserva, i.acta_titulo,
             i.base_monto::text, i.coeficiente_aplicado::text, i.monto::text,
             i.monto_teorico::text, i.ajuste_redondeo::text,
             a.detalle as detalle_hecho, a.fecha_hecho::text
        from item_liquidacion i
        join liquidacion l on l.id = i.liquidacion_id
        left join concepto_boleta_unidad a on a.id = i.aplicacion_id
       where l.periodo_id = ${periodoId}${filtroLiq}
       order by i.liquidacion_id, i.clase_item, i.descripcion
    `)
  ).rows;

  const porLiquidacion = new Map<string, FilaItem[]>();
  for (const item of items) {
    const lista = porLiquidacion.get(item.liquidacion_id);
    if (lista) lista.push(item);
    else porLiquidacion.set(item.liquidacion_id, [item]);
  }

  return elegidas.map((liq) =>
    armarUna({
      periodo,
      liquidacion: liq,
      items: porLiquidacion.get(liq.id) ?? [],
      sumaCoeficientes,
      medio: opciones.medio,
    }),
  );
}

/** Arma la vista de **una** boleta. Útil para la vista previa desde la UI (ADR-0001 §5). */
export async function armarVistaBoleta(
  tx: DbConIdentidad,
  liquidacionId: string,
  opciones: Omit<OpcionesVistaBoleta, "liquidacionIds">,
): Promise<VistaBoleta> {
  const fila = (
    await tx.execute<{ periodo_id: string }>(sql`select periodo_id from liquidacion where id = ${liquidacionId}`)
  ).rows[0];
  if (!fila) throw new Error("la liquidación no existe o no es accesible");
  const [vista] = await armarVistasDelPeriodo(tx, fila.periodo_id, { ...opciones, liquidacionIds: [liquidacionId] });
  if (!vista) throw new Error("no se pudo armar la vista de la liquidación");
  return vista;
}

// --- El armado puro de una boleta ---------------------------------------------------------------

function armarUna(entrada: {
  periodo: FilaPeriodo;
  liquidacion: FilaLiquidacion;
  items: readonly FilaItem[];
  sumaCoeficientes: string;
  medio: MedioCobranza;
}): VistaBoleta {
  const { periodo, liquidacion: liq, items, sumaCoeficientes, medio } = entrada;

  // `numero_comprobante` es `text` nullable y libre: un `""` o un `"  "` no son un comprobante.
  const comprobante = liq.numero_comprobante?.trim() ? liq.numero_comprobante.trim() : null;
  const etiquetaPeriodo = formatearPeriodo(periodo.periodo);
  const denominacion = periodo.denominacion_concepto ?? "expensa";
  const unidadEtiqueta = etiquetaUnidad(liq.manzana, liq.lote);
  const coeficiente = coeficienteImpreso(liq.coeficiente_aplicado, sumaCoeficientes);

  // --- Notas con marcador -------------------------------------------------------------------
  // El respaldo de la extraordinaria se cita **en positivo** y anclado a su línea: con dos
  // extraordinarias, una con acta y otra sin, una caja única sería directamente incorrecta.
  const marcadorPorActa = new Map<string, number>();
  const notas: { marcador: number; texto: string }[] = [];
  for (const item of items) {
    if (item.clase_item !== "prorrateo" || item.tipo !== "extraordinaria" || !item.acta_titulo) continue;
    if (marcadorPorActa.has(item.acta_titulo)) continue;
    const marcador = notas.length + 1;
    marcadorPorActa.set(item.acta_titulo, marcador);
    notas.push({ marcador, texto: `Respaldo: ${item.acta_titulo}.` });
  }

  const hayDescuento = items.some((i) => i.clase_item === "descuento");
  let marcadorDescuento: number | null = null;
  if (hayDescuento) {
    marcadorDescuento = notas.length + 1;
    notas.push({
      marcador: marcadorDescuento,
      texto: "El importe ya está descontado del total del período.",
    });
  }

  // --- Líneas del detalle -------------------------------------------------------------------
  const lineas: LineaDetalle[] = items.map((item) => {
    const esProrrateo = item.clase_item === "prorrateo";
    const detalleHecho = [item.detalle_hecho, item.fecha_hecho].filter((x): x is string => !!x).join(" · ");
    return {
      concepto: item.descripcion,
      clase: item.clase_item,
      clasificacion2048: clasificacion2048De(item),
      gastoDelPeriodo: esProrrateo ? cifra(item.base_monto) : null,
      coeficiente: esProrrateo && item.coeficiente_aplicado ? coeficienteImpreso(item.coeficiente_aplicado, sumaCoeficientes) : null,
      importe: cifra(item.monto),
      importeTeorico: item.monto_teorico === null ? null : cifra(item.monto_teorico),
      ajusteRedondeo: cifra(item.ajuste_redondeo),
      respaldo: item.acta_titulo,
      detalleHecho: detalleHecho.length > 0 ? detalleHecho : null,
      marcadorNota:
        item.acta_titulo && marcadorPorActa.has(item.acta_titulo)
          ? (marcadorPorActa.get(item.acta_titulo) ?? null)
          : item.clase_item === "descuento"
            ? marcadorDescuento
            : null,
    };
  });

  // --- Zona 2: la composición ---------------------------------------------------------------
  // Renglones de altura fija con **ceros explícitos**: un renglón ausente se lee como dato
  // escondido (doc 07 §B). Los cargos y descuentos van uno por uno, con su nombre.
  const composicion: RenglonComposicion[] = [];
  const renglon = (etiqueta: string, monto: string, marcador: number | null = null, aclaracion: string | null = null) =>
    composicion.push({ etiqueta, importe: cifra(monto), informativo: false, aclaracion, marcadorNota: marcador });

  // Se imprime en el modelo `fija` y, además, siempre que tenga importe: si el subtotal existiera
  // en un período variable y el renglón no saliera, la composición no cerraría contra el total.
  if (periodo.modelo === "fija" || liq.subtotal_cuota_fija !== "0.00") {
    renglon("Cuota mensual", liq.subtotal_cuota_fija);
  }
  renglon(`${denominacion.charAt(0).toUpperCase()}${denominacion.slice(1)} ordinaria ${etiquetaPeriodo}`, liq.subtotal_ordinarias);
  if (periodo.tiene_fondo_reserva || liq.subtotal_fondo_reserva !== "0.00") {
    renglon("Aporte al fondo de reserva", liq.subtotal_fondo_reserva);
  }
  renglon("Cuotas extraordinarias", liq.subtotal_extraordinarias);
  for (const item of items) {
    if (item.clase_item !== "cargo" && item.clase_item !== "descuento") continue;
    const aclaracion = [item.detalle_hecho, item.fecha_hecho].filter((x): x is string => !!x).join(" · ");
    renglon(
      item.descripcion,
      item.monto,
      item.clase_item === "descuento" ? marcadorDescuento : null,
      aclaracion.length > 0 ? aclaracion : null,
    );
  }

  // --- Totales ------------------------------------------------------------------------------
  const totalDelPeriodo = sumarMontos(
    liq.subtotal_cuota_fija,
    liq.subtotal_ordinarias,
    liq.subtotal_extraordinarias,
    liq.subtotal_fondo_reserva,
    liq.subtotal_cargos,
    liq.subtotal_descuentos,
  );

  // Los tres campos van **tal como están en la base o en `null`**. Nada de `?? "0"` ni de
  // `?? fecha_emision`: eso fabricaría el respaldo de una cifra de dinero. `liquidacion_mora_
  // verificable_chk` exime del par (días, fecha de corte) al caso `interes_mora = 0`, así que el
  // camino cotidiano —unidad al día, con tasa cargada— llega acá **sin fecha de corte**, y la hoja
  // tiene que decir eso y no inventar la fecha de hoy del servidor.
  const interesDetalle =
    liq.mora_pendiente_definicion || liq.interes_mora === null
      ? null
      : {
          base: cifra(liq.saldo_anterior),
          tasaMensualTexto: liq.tasa_mora_aplicada === null ? null : tasaImpresa(liq.tasa_mora_aplicada),
          dias: liq.dias_atraso,
          computadoHasta: liq.fecha_corte_mora === null ? null : fechaImpresa(liq.fecha_corte_mora),
        };

  // --- Bandas de estado (orden fijo, máximo 3) ----------------------------------------------
  const bandas: BandaEstado[] = [];
  if (liq.saldo_anterior === "0.00") {
    bandas.push({
      clave: "al_dia",
      marca: "ok",
      titulo: "Al día",
      texto: `Esta boleta cubre solo el período ${etiquetaPeriodo}.`,
    });
  } else {
    bandas.push({
      clave: "saldo_anterior",
      marca: "atencion",
      titulo: "Incluye períodos anteriores",
      // Nunca "moroso", "deudor" ni "incumplidor" (doc 07 §E, grupo G).
      texto:
        `Incluye $ ${cifra(liq.saldo_anterior).texto} de períodos anteriores` +
        (liq.interes_mora ? ` y $ ${cifra(liq.interes_mora).texto} de interés.` : "."),
    });
  }
  if (hayDescuento) {
    const totalDescuentos = cifra(liq.subtotal_descuentos);
    bandas.push({
      clave: "bonificacion_aplicada",
      marca: "estrella",
      titulo: "Bonificación aplicada",
      texto: `$ ${totalDescuentos.texto} sobre el total del período.`,
    });
  }
  // Tercer slot, con prioridad explícita en vez de un `slice(0, 3)` que truncaba en silencio: si el
  // período está en borrador Y además la mora está pendiente, **gana "vista previa"**, que es la
  // única banda que dice "esto no es un comprobante de pago". El interés pendiente no se pierde: la
  // zona 2 lo imprime igual como renglón "pendiente de definición" (doc 09 §E.4.1).
  if (periodo.estado === "borrador" || periodo.estado === "revisada") {
    bandas.push({
      clave: "vista_previa",
      marca: "borrador",
      titulo: "Vista previa",
      texto: "No es un comprobante de pago.",
    });
  } else if (liq.mora_pendiente_definicion) {
    bandas.push({
      clave: "interes_pendiente",
      marca: "pregunta",
      titulo: "Interés pendiente de definición",
      texto: "El barrio no tiene tasa cargada a la fecha de emisión. No se estimó ningún importe.",
    });
  }
  if (bandas.length > 3) throw new Error("se armaron más bandas de las que tiene la zona 1: hay que decidir cuál se colapsa");

  // --- Bloque de pago -----------------------------------------------------------------------
  const entradaPago: EntradaBloquePago = {
    barrio: periodo.barrio_nombre,
    comprobante,
    periodo: periodo.periodo,
    vencimiento: periodo.primer_vencimiento ?? "",
    // La fecha tope **no es** el segundo vencimiento (doc 09 §B.6) y no tiene campo propio: se
    // declara ausente antes que imprimir una fecha que significa otra cosa.
    fechaTope: null,
    importe: liq.total,
  };
  const bloquePago = medio.armarBloquePago(entradaPago);

  // Compuerta 1 (ADR-0001 §7.2): si el instrumento no verifica, **esta unidad no se emite**.
  const verificacion = medio.verificar(bloquePago);
  if (!verificacion.ok) {
    throw new Error(
      `el bloque de pago de ${unidadEtiqueta} no verifica y la emisión se bloquea: ${verificacion.motivos.join("; ")}`,
    );
  }

  const vista = parsearVistaBoleta({
    version: VERSION_VISTA_BOLETA,
    marca: {
      barrio: {
        nombre: periodo.barrio_nombre,
        logo: null,
        // El barrio no tiene columna de color: sale el gris neutro, nunca la marca del producto.
        acentoHex: acentoImpreso(null),
      },
      emisor: {
        // El `??` NO es un fallback silencioso: la compuerta 0 de `armarVistasDelPeriodo` ya cortó el
        // caso "hay administrador y no lo puedo leer". Acá `null` significa exactamente una cosa —el
        // barrio no tiene administrador designado— y entonces el emisor es el barrio, que es correcto.
        razonSocial: periodo.administrador_nombre ?? periodo.barrio_nombre,
        cuit: null,
        domicilio: null,
        contacto: null,
        logo: null,
      },
      pie: [],
    },
    barrio: {
      nombre: periodo.barrio_nombre,
      figuraJuridica: periodo.figura_juridica,
      domicilio: periodo.domicilio_sede,
    },
    unidad: { etiqueta: unidadEtiqueta, destinatario: liq.obligado_nombre ?? "Titular de la unidad" },
    periodo: {
      codigo: periodo.periodo,
      etiqueta: etiquetaPeriodo,
      denominacionConcepto: denominacion,
      estado: periodo.estado,
    },
    emision: {
      // Un período en borrador **no tiene fecha de emisión**, y no se rellena con la de hoy: además
      // de ser un dato que el sistema no tiene, `current_date` es la fecha del servidor en su zona y
      // después de las 21:00 ART ya es el día siguiente — el bug que `shared/fechas.ts` existe para
      // evitar. La banda de "vista previa" ya dice que no es un comprobante.
      fecha: periodo.fecha_emision === null ? null : fechaImpresa(periodo.fecha_emision),
      comprobante,
    },
    bandas,
    composicion,
    totales: {
      delPeriodo: cifra(totalDelPeriodo),
      saldoAnterior: cifra(liq.saldo_anterior),
      interes: liq.interes_mora === null ? null : cifra(liq.interes_mora),
      aPagar: cifra(liq.total),
    },
    interes: interesDetalle,
    detalle: {
      gastoDelBarrio: cifra(periodo.total_gastos ?? "0.00"),
      coeficiente,
      lineas,
      // El 100 % de la barra de participación de la zona 3 (doc 10 §I.6.1). Son los dos subtotales
      // que el art. 2048 clasifica como **ordinarios** —la cuota fija del modelo `fija` y el reparto
      // del modelo variable—, que es exactamente el conjunto de líneas que llevan barra. En la
      // práctica uno de los dos vale cero, y el que no, es el renglón que la zona 2 imprime arriba.
      totalOrdinarias: cifra(sumarMontos(liq.subtotal_cuota_fija, liq.subtotal_ordinarias)),
      continuaAlDorso: false,
    },
    bloquePago,
    notas,
    leyendas: [
      "El pago de la presente no libera de obligaciones de períodos anteriores.",
      "Los intereses generados por el pago posterior al vencimiento se devengan en la boleta del período siguiente.",
      "El prorrateo usa el coeficiente con 9 decimales; acá se muestran 4. Diferencias de hasta $ 0,01 por unidad son el resto del reparto.",
    ],
    faltantes: Object.values(FALTANTES_CONOCIDOS),
  });

  // Doc 07 §E, aplicado **al emitir** y no al re-abrir: acá el administrador todavía puede corregir
  // el texto. Cubre lo que carga el cliente (leyendas propias, nombre del concepto, respaldo del
  // acta, detalle de un cargo), que es el de más riesgo (doc 09 §E.9.4).
  const motivos = revisarTextosImpresos(textosImpresosDeBoleta(vista));
  if (motivos.length > 0) {
    throw new Error(`la boleta de ${unidadEtiqueta} no se emite por el texto que lleva impreso: ${motivos.join("; ")}`);
  }

  return vista;
}
