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
import {
  editarConceptoBoletaSchema,
  revisarComoEntraElConcepto,
  type DestinatarioConcepto,
  type EditarConceptoBoleta,
  type MetodoConceptoBoleta,
  type ModoDelMes,
  type UnidadDeUso,
} from "@admin-barrios/shared/conceptos";
import type { DbConIdentidad } from "../client.ts";
import { registrarCambioDeCatalogo } from "./grupos.ts";
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
  /** A quién va y cómo entra cada mes (encargo 16b). Lo que no se cargó se lee como «una unidad, a mano». */
  readonly destinatario: DestinatarioConcepto;
  readonly grupoId: string | null;
  readonly grupoNombre: string | null;
  /** Cuántas unidades activas tiene el grupo, si va a un grupo. */
  readonly grupoUnidades: number | null;
  readonly modoMes: ModoDelMes;
  readonly unidadUso: UnidadDeUso | null;
  /** Es el concepto de la bonificación por pago en término: se cambia en «Cómo se devenga», no acá. */
  readonly deLaRegla: boolean;
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
    destinatario: DestinatarioConcepto | null;
    grupo_id: string | null;
    grupo_nombre: string | null;
    grupo_unidades: number | null;
    modo_mes: ModoDelMes | null;
    unidad_uso: UnidadDeUso | null;
    de_la_regla: boolean;
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
           c.destinatario, c.grupo_id, g.nombre as grupo_nombre, c.modo_mes, c.unidad_uso,
           c.regla_barrio is not null as de_la_regla,
           case when c.grupo_id is not null then
             (select count(*)::int from grupo_unidades_miembro m join unidad_funcional u on u.id = m.unidad_funcional_id
               where m.grupo_id = c.grupo_id and u.baja_at is null) end as grupo_unidades,
           v.id as valor_id, v.monto_fijo::text, v.porcentaje::text, v.precio_unitario::text,
           v.tope::text, v.vigente_desde::text
      from concepto_boleta c
      left join grupo_unidades g on g.id = c.grupo_id
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
    // La bonificación por pago en término va a «las que están al día» y la aplica su regla.
    destinatario: f.destinatario ?? (f.de_la_regla ? "todas" : "una_unidad"),
    grupoId: f.grupo_id,
    grupoNombre: f.grupo_nombre,
    grupoUnidades: f.grupo_id === null ? null : (f.grupo_unidades ?? 0),
    modoMes: f.modo_mes ?? "mano",
    unidadUso: f.unidad_uso,
    deLaRegla: f.de_la_regla,
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
                                   clasificacion_fiscal, financiamiento, requiere_admin, orden_impresion,
                                   destinatario, grupo_id, modo_mes, unidad_uso)
      values (${p.barrioId}, ${p.nombre}, ${p.clase}::app.clase_concepto_boleta,
              ${p.metodo}::app.metodo_concepto_boleta,
              ${p.baseCalculo}::app.base_calculo_concepto,
              ${p.clasificacionFiscal}::app.clasificacion_fiscal,
              ${p.financiamiento}::app.financiamiento_descuento,
              ${p.requiereAdmin}, ${p.ordenImpresion},
              ${p.destinatario}, ${p.grupoId}::uuid, ${p.modoMes}, ${p.unidadUso})
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
    // El valor de un concepto que aplica una regla del barrio (la bonificación por pago en término) se
    // cambia en «Cómo se devenga», con su motivo y su mes de vigencia: acá entraría sin ninguno de los
    // dos, y la emisión lo rechazaría por no coincidir (`app.validar_emision`, `0081`).
    const { rows: deRegla } = await tx.execute<{ id: string }>(sql`
      select id from concepto_boleta where id = ${p.conceptoBoletaId} and regla_barrio is not null
    `);
    if (deRegla.length > 0) {
      rechazar(
        "dato_invalido",
        "El valor de la bonificación por pago en término se cambia en Configuración → Cómo se devenga.",
        "Ahí se elige desde qué mes rige y queda el motivo en el historial.",
      );
    }
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

/**
 * Edita un concepto de boleta (encargo 16b): el nombre, si está activo, y a quién va y cómo entra cada
 * mes. **El importe no se edita acá**: se carga un valor nuevo con su vigencia (`registrarValorConcepto`).
 * Ni la clase ni el método cambian: son lo que el concepto es.
 *
 * Lo ya aplicado no se toca: cada aplicación guarda su copia del concepto. Lo que cambia es lo que se
 * aplique desde ahora, y en un concepto que se aplica solo, lo que resulte al volver a calcular un mes
 * sin emitir. El catálogo lo define la administración (lo hace cumplir la RLS de `concepto_boleta`).
 */
export async function editarConceptoBoleta(tx: DbConIdentidad, parametros: EditarConceptoBoleta): Promise<void> {
  const p = editarConceptoBoletaSchema.parse(parametros);
  await enBase(async () => {
    type Antes = {
      barrio_id: string; nombre: string; activo: boolean; destinatario: string | null; grupo_id: string | null; modo_mes: string | null; unidad_uso: string | null;
      clase: "cargo" | "descuento"; metodo: MetodoConceptoBoleta; de_la_regla: boolean;
    };
    const { rows } = await tx.execute<Antes>(sql`
      select barrio_id, nombre, activo, destinatario, grupo_id, modo_mes, unidad_uso,
             clase::text as clase, metodo::text as metodo, regla_barrio is not null as de_la_regla
        from concepto_boleta where id = ${p.conceptoBoletaId}
    `);
    const actual = rows[0];
    if (!actual) rechazar("concepto_no_encontrado", "Ese concepto no existe o no tenés acceso.", "Recargá el catálogo de conceptos del barrio.");
    if (actual.de_la_regla) {
      rechazar(
        "dato_invalido",
        "La bonificación por pago en término se cambia en Configuración → Cómo se devenga.",
        "Ahí se elige desde qué mes rige y queda el motivo en el historial.",
      );
    }
    const problemas = revisarComoEntraElConcepto({ clase: actual.clase, metodo: actual.metodo, destinatario: p.destinatario, grupoId: p.grupoId, modoMes: p.modoMes, unidadUso: p.unidadUso });
    if (problemas[0]) rechazar("dato_invalido", problemas[0].mensaje, "Revisá a quién va el concepto y cómo entra cada mes.", { campo: problemas[0].campo });
    const resultado = await tx.execute(sql`
      update concepto_boleta
         set nombre = ${p.nombre}, activo = ${p.activo},
             destinatario = ${p.destinatario}, grupo_id = ${p.grupoId}::uuid, modo_mes = ${p.modoMes}, unidad_uso = ${p.unidadUso}
       where id = ${p.conceptoBoletaId}
    `);
    if ((resultado.rowCount ?? 0) === 0) {
      rechazar("sin_permiso", "El catálogo de conceptos lo define la administración del barrio.", "Pedíselo a quien administra el barrio.");
    }
    // Quién cambió a quién va el concepto o cómo entra: decide a quién se le cobra (security-engineer, 3).
    const cambio = (rotulo: string, antes: string | boolean | null, ahora: string | boolean | null) =>
      (antes ?? "") === (ahora ?? "") ? null : `${rotulo}: ${String(antes ?? "sin cargar")} → ${String(ahora ?? "sin cargar")}`;
    const cambios = [
      cambio("nombre", actual.nombre, p.nombre),
      cambio("activo", actual.activo, p.activo),
      cambio("a quién va", actual.destinatario, p.destinatario),
      cambio("grupo", actual.grupo_id, p.grupoId),
      cambio("cada mes", actual.modo_mes, p.modoMes),
      cambio("unidad de uso", actual.unidad_uso, p.unidadUso),
    ].filter((x): x is string => x !== null);
    if (cambios.length > 0) {
      await registrarCambioDeCatalogo(tx, actual.barrio_id, `Concepto «${actual.nombre}»: ${cambios.join("; ")}.`, { conceptoBoletaId: p.conceptoBoletaId });
    }
  });
}
