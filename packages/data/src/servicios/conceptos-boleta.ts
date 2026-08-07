/**
 * El catálogo de conceptos de boleta del barrio: darlos de alta con su valor, versionar el valor, y
 * listarlos.
 *
 * **Por qué existe este archivo si el ADR-0002 §8 dejaba el alta del catálogo fuera del incremento.**
 * Porque sin catálogo no hay nada que aplicar: `app.cbu_antes()` rechaza toda aplicación de un
 * concepto sin valor vigente, y hoy los dos únicos conceptos del sistema los escribe el seed con la
 * conexión del dueño del esquema. La pantalla de cargos y descuentos —que sí está en el recorrido—
 * sería un desplegable vacío en cualquier barrio que no sea el de la demo. Queda anotado como
 * divergencia consciente del §8, no como alcance que se estiró solo.
 *
 * **El patrón catálogo → valor versionado → aplicación** (doc 08 §K) es lo que permite que editar el
 * precio del quincho en julio no reescriba lo que decía la boleta de marzo: la aplicación congela el
 * valor que estaba vigente **a la fecha del hecho**, no el de hoy.
 */

import { sql } from "drizzle-orm";
import {
  crearConceptoBoletaSchema,
  registrarValorConceptoSchema,
  type CrearConceptoBoleta,
  type RegistrarValorConcepto,
} from "@admin-barrios/shared/escrituras";
import { consultaBarrioSchema } from "@admin-barrios/shared/consultas";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";

export type ConceptoBoletaDeLista = {
  readonly id: string;
  readonly nombre: string;
  readonly clase: "cargo" | "descuento";
  readonly metodo: string;
  readonly baseCalculo: string;
  readonly clasificacionFiscal: string;
  readonly financiamiento: string | null;
  /** Solo lo puede aplicar un `admin_barrio`, nunca un `operador`. */
  readonly requiereAdmin: boolean;
  readonly ordenImpresion: number;
  readonly activo: boolean;
  /**
   * El valor vigente **hoy**. `null` = el concepto no se puede aplicar con fecha de hoy, y la
   * pantalla lo tiene que decir: `app.cbu_antes()` lo va a rechazar.
   *
   * Es el valor a **hoy** y no "el último cargado" a propósito: un valor con `vigente_desde` futuro
   * existe y no se puede usar todavía, y mostrarlo como si estuviera vigente haría que el rechazo
   * llegara recién al aplicar.
   */
  readonly valorVigente: {
    readonly id: string;
    readonly montoFijo: string | null;
    readonly porcentaje: string | null;
    readonly precioUnitario: string | null;
    readonly tope: string | null;
    readonly vigenteDesde: string;
  } | null;
};

/**
 * El catálogo de conceptos de boleta del barrio, con su valor vigente hoy — pantalla `…/cargos`.
 *
 * Una consulta, sin N+1: el valor vigente entra por un `left join lateral` con `limit 1` sobre
 * `idx_concepto_boleta_valor_vigencia (concepto_boleta_id, vigente_desde desc)`, que es exactamente
 * el índice que ese orden necesita. Con una subconsulta por columna serían cinco viajes por concepto.
 */
export async function listarConceptosBoleta(
  tx: DbConIdentidad,
  parametros: { barrioId: string },
): Promise<ConceptoBoletaDeLista[]> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);

  type Fila = {
    id: string;
    nombre: string;
    clase: "cargo" | "descuento";
    metodo: string;
    base_calculo: string;
    clasificacion_fiscal: string;
    financiamiento: string | null;
    requiere_admin: boolean;
    orden_impresion: number;
    activo: boolean;
    valor_id: string | null;
    monto_fijo: string | null;
    porcentaje: string | null;
    precio_unitario: string | null;
    tope: string | null;
    vigente_desde: string | null;
  };

  const { rows } = await tx.execute<Fila>(sql`
    select c.id, c.nombre, c.clase::text as clase, c.metodo::text as metodo,
           c.base_calculo::text as base_calculo,
           c.clasificacion_fiscal::text as clasificacion_fiscal,
           c.financiamiento::text as financiamiento,
           c.requiere_admin, c.orden_impresion, c.activo,
           v.id as valor_id, v.monto_fijo::text, v.porcentaje::text, v.precio_unitario::text,
           v.tope::text, v.vigente_desde::text
      from concepto_boleta c
      left join lateral (
        select id, monto_fijo, porcentaje, precio_unitario, tope, vigente_desde
          from concepto_boleta_valor
         where concepto_boleta_id = c.id
           and vigente_desde <= current_date
           -- Mayor estricto, no mayor-o-igual: vigente_hasta es EXCLUSIVO en todo el modelo
           -- (0018 §6) y el trigger que cierra la vigencia anterior escribe
           -- vigente_hasta = vigente_desde de la nueva. Con el inclusivo, el día del traspaso las
           -- DOS filas matcheaban: la pantalla podía mostrar un precio mientras la boleta congelaba
           -- el otro (migración 0023, agujero 3).
           and (vigente_hasta is null or vigente_hasta > current_date)
         order by vigente_desde desc
         limit 1
      ) v on true
     where c.barrio_id = ${barrioId}
     order by c.clase, c.orden_impresion, c.nombre
  `);

  return rows.map((f) => ({
    id: f.id,
    nombre: f.nombre,
    clase: f.clase,
    metodo: f.metodo,
    baseCalculo: f.base_calculo,
    clasificacionFiscal: f.clasificacion_fiscal,
    financiamiento: f.financiamiento,
    requiereAdmin: f.requiere_admin,
    ordenImpresion: f.orden_impresion,
    activo: f.activo,
    valorVigente:
      f.valor_id && f.vigente_desde
        ? {
            id: f.valor_id,
            montoFijo: f.monto_fijo,
            porcentaje: f.porcentaje,
            precioUnitario: f.precio_unitario,
            tope: f.tope,
            vigenteDesde: f.vigente_desde,
          }
        : null,
  }));
}

/**
 * Da de alta un concepto **con su primer valor vigente**, en una sola transacción.
 *
 * Van juntos porque separarlos deja un estado intermedio que no sirve para nada y confunde: un
 * concepto sin valor aparece en el catálogo, se puede elegir, y falla al aplicarlo con "no tiene
 * valor vigente al …". Si el segundo `insert` rebota, el primero se va con él — es la misma
 * transacción de request.
 *
 * **`aprobada_por` la escribe el servidor desde `app.current_user_id()`, no desde un parámetro.** Es
 * la misma regla que la firma de `emitida_por` (0013 §3) y la de `aplicado_por` (0016 §5): un valor
 * de catálogo es lo que va a terminar cobrándose, y una firma que manda el cliente no es una firma.
 * Acá no hay trigger que lo imponga, así que lo impone la sentencia: `app.current_user_id()` lee el
 * GUC de la transacción, que el cliente no puede tocar.
 */
export async function crearConceptoBoleta(
  tx: DbConIdentidad,
  parametros: CrearConceptoBoleta,
): Promise<{ readonly conceptoId: string; readonly valorId: string }> {
  const p = crearConceptoBoletaSchema.parse(parametros);

  return enBase(async () => {
    const { rows: conceptos } = await tx.execute<{ id: string; barrio_id: string }>(sql`
      insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo,
                                   clasificacion_fiscal, financiamiento, requiere_admin, orden_impresion)
      values (${p.barrioId}, ${p.nombre}, ${p.clase}::app.clase_concepto_boleta,
              ${p.metodo}::app.metodo_concepto_boleta,
              ${p.baseCalculo}::app.base_calculo_concepto,
              ${p.clasificacionFiscal}::app.clasificacion_fiscal,
              ${p.financiamiento}::app.financiamiento_descuento,
              ${p.requiereAdmin}, ${p.ordenImpresion})
      returning id, barrio_id
    `);
    const concepto = conceptos[0];
    if (!concepto) {
      // `desconocido`: un `insert` que no insertó y no rebotó no es "el concepto no existe".
      rechazar("desconocido", "No se pudo crear el concepto.", "Recargá la pantalla y volvé a intentar. Si sigue pasando, pasale el código de referencia a quien te da soporte.");
    }

    const { rows: valores } = await tx.execute<{ id: string }>(sql`
      insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, monto_fijo, porcentaje,
                                         precio_unitario, tope, vigente_desde, aprobada_por)
      values (${concepto.barrio_id}, ${concepto.id}, ${p.metodo}::app.metodo_concepto_boleta,
              ${p.montoFijo}::numeric, ${p.porcentaje}::numeric, ${p.precioUnitario}::numeric,
              ${p.tope}::numeric, ${p.vigenteDesde}::date, app.current_user_id())
      returning id
    `);
    const valor = valores[0];
    if (!valor) {
      rechazar("desconocido", "No se pudo cargar el valor del concepto.", "Recargá la pantalla y volvé a intentar. Si sigue pasando, pasale el código de referencia a quien te da soporte.");
    }
    return { conceptoId: concepto.id, valorId: valor.id };
  });
}

/**
 * Carga un valor nuevo para un concepto que ya existe. **La vigencia anterior la cierra la base**
 * (`app.concepto_boleta_valor_antes`, 0016 §5) poniéndole `vigente_hasta = vigente_desde` del nuevo.
 *
 * Por eso no hay un parámetro `vigenteHasta`: cerrarla desde el request permitiría dejar un hueco de
 * vigencia, y en ese hueco el concepto deja de poder aplicarse sin que nadie lo haya decidido —el
 * rechazo aparecería recién en la pantalla de cargos, semanas después y sin explicación.
 *
 * El `barrio_id` y el `metodo` se derivan del propio concepto en la misma sentencia: el método lo ata
 * además una FK (`fk_cbv_concepto_metodo`), así que mandarlo desde el cliente sería ofrecer un campo
 * que no puede tener otro valor.
 */
export async function registrarValorConcepto(
  tx: DbConIdentidad,
  parametros: RegistrarValorConcepto,
): Promise<{ readonly valorId: string }> {
  const p = registrarValorConceptoSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, monto_fijo, porcentaje,
                                         precio_unitario, tope, vigente_desde, aprobada_por)
      select cb.barrio_id, cb.id, cb.metodo,
             ${p.montoFijo}::numeric, ${p.porcentaje}::numeric, ${p.precioUnitario}::numeric,
             ${p.tope}::numeric, ${p.vigenteDesde}::date, app.current_user_id()
        from concepto_boleta cb
       where cb.id = ${p.conceptoBoletaId}
      returning id
    `);
    const fila = rows[0];
    if (!fila) {
      rechazar(
        "concepto_no_encontrado",
        "Ese concepto no existe o no tenés acceso.",
        "Recargá el catálogo de conceptos del barrio.",
      );
    }
    return { valorId: fila.id };
  });
}
