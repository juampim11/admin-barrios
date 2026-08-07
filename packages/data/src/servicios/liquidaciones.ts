/**
 * La grilla de revisión: una fila por unidad liquidada, con sus subtotales y su total.
 *
 * Es la pantalla donde el administrador decide si emite o no, así que cada cifra tiene que poder
 * explicarse. Por eso la fila trae **los seis subtotales por separado** y no solo el total: sin el
 * desglose, "¿por qué esta unidad paga $ 240.000?" no se puede contestar sin abrir la boleta.
 *
 * **Qué NO trae, y por qué.** Los `item_liquidacion` —el renglón por renglón— no entran acá. Con 200
 * unidades son ~4.000 filas, y la pantalla no los muestra: para eso está la vista previa de una
 * boleta, que ya existe (`armarVistaBoleta`, ADR-0001 §5). Traerlos "por si acaso" sería exactamente
 * la consulta ancha que la regla de recursos §2.b prohíbe.
 *
 * **Los totales del período se calculan en memoria, con `shared/dinero`.** No con `sum()` en SQL y
 * no con `Number()`: los importes son `numeric` leídos como string, y la suma exacta se hace en
 * centavos con `bigint`. Que el total de la pantalla salga de las mismas filas que la pantalla
 * muestra —y no de una agregación aparte— es lo que hace que el administrador pueda auditarlo
 * sumando la columna a mano.
 */

import { sql } from "drizzle-orm";
import { sumarMontos } from "@admin-barrios/shared/dinero";
import { consultaLiquidacionesSchema, type ConsultaLiquidaciones } from "@admin-barrios/shared/consultas";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import type { DbConIdentidad } from "../client.ts";

export type LiquidacionDeGrilla = {
  readonly id: string;
  readonly unidadFuncionalId: string;
  readonly manzana: string;
  readonly lote: string;
  readonly etiqueta: string;
  /** A quién se le notifica. `null` = la unidad no tiene obligado notificado cargado. */
  readonly destinatario: string | null;
  /** 9 decimales, como string. El formateo a 4 para impresión es de `shared/dinero`. */
  readonly coeficienteAplicado: string;
  readonly numeroComprobante: string | null;
  readonly subtotalCuotaFija: string;
  readonly subtotalOrdinarias: string;
  readonly subtotalExtraordinarias: string;
  readonly subtotalFondoReserva: string;
  readonly subtotalCargos: string;
  /** **Negativo**: es lo que se descuenta. Sin el signo, el neto no cierra. */
  readonly subtotalDescuentos: string;
  readonly saldoAnterior: string;
  /** De dónde sale el saldo: `carga_manual` | `sin_movimientos` (no hay cuenta corriente todavía). */
  readonly saldoAnteriorOrigen: string;
  /** `null` **solo** con `moraPendienteDefinicion`: el barrio no tiene tasa y no se inventa una. */
  readonly interesMora: string | null;
  readonly moraPendienteDefinicion: boolean;
  readonly diasAtraso: number | null;
  readonly total: string;
};

/** Los mismos seis subtotales, sumados sobre la página devuelta. Todos como string exacto. */
export type TotalesDeGrilla = {
  readonly cuotaFija: string;
  readonly ordinarias: string;
  readonly extraordinarias: string;
  readonly fondoReserva: string;
  readonly cargos: string;
  readonly descuentos: string;
  readonly saldoAnterior: string;
  readonly interesMora: string;
  readonly total: string;
};

export type GrillaLiquidaciones = {
  readonly liquidaciones: readonly LiquidacionDeGrilla[];
  readonly total: number;
  readonly limite: number;
  readonly desplazamiento: number;
  /** Sumas de la **página devuelta**, no del período entero. Ver la nota de abajo. */
  readonly totales: TotalesDeGrilla;
  /**
   * Cuántas unidades del **período entero** —no de la página— quedaron con la mora pendiente de
   * definición, o sea sin tasa cargada al liquidar.
   *
   * Sale de un `count(*) filter` en SQL y no de contar el arreglo devuelto, y la diferencia importa:
   * es una alerta, y una alerta que solo mira la página **subcuenta en silencio** justo en el barrio
   * grande, que es donde más caro sale. Con 3.000 unidades y el techo de 500 por página, "3 unidades
   * sin tasa" cuando hay 12 es un número sin origen en la pantalla donde se decide emitir.
   */
  readonly conMoraPendiente: number;
};

type Fila = {
  id: string;
  unidad_funcional_id: string;
  manzana: string;
  lote: string;
  destinatario: string | null;
  coeficiente_aplicado: string;
  numero_comprobante: string | null;
  subtotal_cuota_fija: string;
  subtotal_ordinarias: string;
  subtotal_extraordinarias: string;
  subtotal_fondo_reserva: string;
  subtotal_cargos: string;
  subtotal_descuentos: string;
  saldo_anterior: string;
  saldo_anterior_origen: string;
  interes_mora: string | null;
  mora_pendiente_definicion: boolean;
  dias_atraso: number | null;
  total: string;
};

/**
 * Las liquidaciones de un período — pantalla `…/revision`.
 *
 * El orden es `manzana, lote`: **el mismo que recorre `armarVistasDelPeriodo()`**. Que la fila 37 de
 * la pantalla sea la boleta 37 del lote de PDFs no es cosmético; es lo que permite comparar una
 * contra otra cuando algo no cuadra.
 *
 * Sobre `totales`: son de la página, y el tipo lo dice. Un total "del período entero" tendría que
 * salir de un `sum()` aparte, y entonces la pantalla mostraría una cifra que **no** es la suma de lo
 * que se ve — que es exactamente la clase de número suelto que la regla de trazabilidad prohíbe. Con
 * el límite por defecto (500) un barrio normal entra entero en una página.
 */
export async function listarLiquidaciones(
  tx: DbConIdentidad,
  parametros: Partial<ConsultaLiquidaciones> & { periodoId: string },
): Promise<GrillaLiquidaciones> {
  const { periodoId, limite, desplazamiento } = consultaLiquidacionesSchema.parse(parametros);

  // Las dos cifras "del período entero" salen de la MISMA consulta: un `count(*)` y un
  // `count(*) filter`, sin round-trip extra y sin posibilidad de que se calculen sobre conjuntos
  // distintos.
  const agregados = (
    await tx.execute<{ n: number; con_mora_pendiente: number }>(sql`
      select count(*)::int as n,
             count(*) filter (where l.mora_pendiente_definicion)::int as con_mora_pendiente
        from liquidacion l
       where l.periodo_id = ${periodoId}
    `)
  ).rows[0];

  const { rows } = await tx.execute<Fila>(sql`
    select l.id, l.unidad_funcional_id, u.manzana, u.lote,
           o.nombre as destinatario,
           l.coeficiente_aplicado::text, l.numero_comprobante,
           l.subtotal_cuota_fija::text, l.subtotal_ordinarias::text,
           l.subtotal_extraordinarias::text, l.subtotal_fondo_reserva::text,
           l.subtotal_cargos::text, l.subtotal_descuentos::text,
           l.saldo_anterior::text, l.saldo_anterior_origen,
           l.interes_mora::text, l.mora_pendiente_definicion, l.dias_atraso,
           l.total::text
      from liquidacion l
      join unidad_funcional u on u.id = l.unidad_funcional_id
      left join obligado o on o.id = l.obligado_id
     where l.periodo_id = ${periodoId}
     order by u.manzana, u.lote
     limit ${limite} offset ${desplazamiento}
  `);

  const liquidaciones = rows.map((f) => ({
    id: f.id,
    unidadFuncionalId: f.unidad_funcional_id,
    manzana: f.manzana,
    lote: f.lote,
    etiqueta: etiquetaUnidad(f.manzana, f.lote),
    destinatario: f.destinatario,
    coeficienteAplicado: f.coeficiente_aplicado,
    numeroComprobante: f.numero_comprobante,
    subtotalCuotaFija: f.subtotal_cuota_fija,
    subtotalOrdinarias: f.subtotal_ordinarias,
    subtotalExtraordinarias: f.subtotal_extraordinarias,
    subtotalFondoReserva: f.subtotal_fondo_reserva,
    subtotalCargos: f.subtotal_cargos,
    subtotalDescuentos: f.subtotal_descuentos,
    saldoAnterior: f.saldo_anterior,
    saldoAnteriorOrigen: f.saldo_anterior_origen,
    interesMora: f.interes_mora,
    moraPendienteDefinicion: f.mora_pendiente_definicion,
    diasAtraso: f.dias_atraso,
    total: f.total,
  }));

  const columna = (elegir: (l: LiquidacionDeGrilla) => string | null): string =>
    // El `?? "0.00"` NO fabrica una cifra: solo aparece en `interesMora`, que es `null` exactamente
    // cuando la mora está pendiente de definición — o sea, cuando el aporte de esa unidad al total
    // de intereses es cero porque no se calculó ninguno. La fila igual lo declara con su bandera.
    sumarMontos(...liquidaciones.map((l) => elegir(l) ?? "0.00"));

  return {
    liquidaciones,
    // `?? 0` y no `?? liquidaciones.length`: la rama es inalcanzable (un `count(*)` siempre devuelve
    // una fila), pero si se alcanzara, devolver el tamaño de la página como total haría que la
    // paginación dijera "hay 500" cuando hay 3.000. Un default que miente es peor que un cero obvio.
    total: agregados?.n ?? 0,
    limite,
    desplazamiento,
    totales: {
      cuotaFija: columna((l) => l.subtotalCuotaFija),
      ordinarias: columna((l) => l.subtotalOrdinarias),
      extraordinarias: columna((l) => l.subtotalExtraordinarias),
      fondoReserva: columna((l) => l.subtotalFondoReserva),
      cargos: columna((l) => l.subtotalCargos),
      descuentos: columna((l) => l.subtotalDescuentos),
      saldoAnterior: columna((l) => l.saldoAnterior),
      interesMora: columna((l) => l.interesMora),
      total: columna((l) => l.total),
    },
    conMoraPendiente: agregados?.con_mora_pendiente ?? 0,
  };
}
