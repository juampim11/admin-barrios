/**
 * Los gastos de un período: cargarlos, corregirlos y borrarlos mientras el período sea editable.
 *
 * **El patrón que fijan estos tres servicios, y que siguen los de `cargos.ts` y `conceptos-boleta.ts`:**
 *
 * 1. **Zod parsea la forma, la base decide el fondo.** Acá no hay ni un `if` que replique una regla
 *    que la base ya hace cumplir. Que el período sea editable lo decide `app.periodo_editable`; que
 *    una extraordinaria sin acta quede marcada, `app.gasto_respaldo_extraordinaria`; que el rol
 *    alcance, la policy de `insert`. Un chequeo previo en TypeScript no agregaría seguridad —la base
 *    lo vuelve a verificar— y sí agregaría una segunda definición de la regla, que es la que se
 *    olvida de actualizar el día que la primera cambia.
 *
 * 2. **El `barrioId` no viaja en el parámetro: se deriva del período, en la misma sentencia.** El
 *    `insert … select … from periodo_expensa where id = $1` hace dos cosas de un saque: el barrio
 *    sale de la fila (bajo RLS, ADR-0002 §3.4) y, si el usuario no puede leer ese período, no hay
 *    fila de origen y no se inserta nada. Un `barrioId` por parámetro sería el aislamiento
 *    dependiendo de un valor que manda el cliente.
 *
 * 3. **Cero filas afectadas es un error, no un éxito silencioso.** Bajo RLS, un `update … where id =
 *    $1` sobre una fila que el usuario no puede ver actualiza cero filas y **no lanza nada**. Sin la
 *    guarda, el servicio devolvería éxito, la pantalla diría "listo" y no habría pasado nada. Es el
 *    modo de falla más caro de todo este archivo porque se ve exactamente igual que el camino feliz.
 *
 * 4. **`enBase()` envuelve la escritura**, así todo fallo *de la base* sale como `ErrorDeNegocio`, con
 *    un mensaje que una persona puede leer y el error crudo guardado en el log (ver `errores.ts`). La
 *    traducción es parte del contrato del servicio y no algo que el llamador tenga que recordar.
 *
 *    **El `.parse()` de Zod queda deliberadamente AFUERA de `enBase`**, y por lo tanto un `ZodError`
 *    sí sale sin traducir. Es lo que corresponde: un error de validación no es un fallo, es la
 *    respuesta a un formulario mal completado, y trae `issues` **por campo** — que es justo lo que la
 *    Server Action necesita para marcar el input equivocado (ADR-0002 §4.2 paso 1). Envolverlo lo
 *    aplanaría a un mensaje único y la persona perdería la indicación de qué campo corregir.
 */

import { sql } from "drizzle-orm";
import {
  anularGastoSchema,
  corregirGastoSchema,
  registrarGastoSchema,
  type AnularGasto,
  type CorregirGasto,
  type RegistrarGasto,
} from "@admin-barrios/shared/escrituras";
import { consultaBarrioSchema } from "@admin-barrios/shared/consultas";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar, rechazarPeriodoInaccesible } from "../errores.ts";

/**
 * Lo que devuelve cargar o corregir un gasto.
 *
 * `sinRespaldoAsamblea` viaja de vuelta **a propósito**: la marca la pone el trigger, así que el
 * servicio no la sabe hasta que la base se la devuelve, y la pantalla la necesita para avisar en el
 * acto que esa extraordinaria quedó marcada. Una extraordinaria sin acta se carga igual —pasa en la
 * operatoria real, doc 08 §A.0— pero pesa al reclamar la deuda (art. 2048), y enterarse recién al
 * emitir es tarde.
 */
export type GastoEscrito = {
  readonly id: string;
  readonly sinRespaldoAsamblea: boolean;
};

type FilaEscrita = { id: string; sin_respaldo_asamblea: boolean };

/** Concepto del catálogo de gastos del barrio — lo que elige el formulario de carga. */
export type ConceptoDeGasto = {
  readonly id: string;
  readonly nombre: string;
  /** `ordinaria` | `extraordinaria`. Una extraordinaria pide acta (y sin acta queda marcada). */
  readonly tipo: string;
  readonly esFondoReserva: boolean;
  readonly clasificacionFiscal: string;
  readonly activo: boolean;
};

/**
 * El catálogo de conceptos de gasto del barrio — el desplegable de la pantalla de carga.
 *
 * Trae también los inactivos, con su bandera: un período viejo puede tener gastos de un concepto que
 * después se desactivó, y la pantalla que los muestre tiene que poder nombrarlos. Filtrar acá dejaría
 * un renglón sin nombre en una boleta ya emitida.
 */
export async function listarConceptos(
  tx: DbConIdentidad,
  parametros: { barrioId: string },
): Promise<ConceptoDeGasto[]> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);

  const { rows } = await tx.execute<{
    id: string;
    nombre: string;
    tipo: string;
    es_fondo_reserva: boolean;
    clasificacion_fiscal: string;
    activo: boolean;
  }>(sql`
    select id, nombre, tipo::text as tipo, es_fondo_reserva,
           clasificacion_fiscal::text as clasificacion_fiscal, activo
      from concepto
     where barrio_id = ${barrioId}
     order by tipo, nombre
  `);

  return rows.map((c) => ({
    id: c.id,
    nombre: c.nombre,
    tipo: c.tipo,
    esFondoReserva: c.es_fondo_reserva,
    clasificacionFiscal: c.clasificacion_fiscal,
    activo: c.activo,
  }));
}

/**
 * Carga un gasto en un período.
 *
 * **El `acta_documento_id` es opcional y eso es una decisión de dominio, no un descuido**: una
 * extraordinaria puede existir sin asamblea previa (doc 08 §A.0 punto 2 — "una bomba que se rompe no
 * espera a la asamblea"). El sistema la carga y la **marca**; lo que no hace es fingir que hay
 * respaldo.
 */
export async function registrarGasto(
  tx: DbConIdentidad,
  parametros: RegistrarGasto,
): Promise<GastoEscrito> {
  const p = registrarGastoSchema.parse(parametros);

  return enBase(async () => {
    // Una sola sentencia: el barrio sale del período bajo RLS y, si el período no es legible, no hay
    // fila de origen y no se inserta nada. Con dos sentencias habría una ventana entre leer el barrio
    // y usarlo, y una consulta de más por cada gasto cargado.
    const { rows } = await tx.execute<FilaEscrita>(sql`
      insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto,
                                 proveedor_nombre, comprobante, acta_documento_id)
      select pe.barrio_id, pe.id, ${p.conceptoId}, ${p.descripcion}, ${p.monto}::numeric,
             ${p.proveedorNombre}, ${p.comprobante}, ${p.actaDocumentoId}
        from periodo_expensa pe
       where pe.id = ${p.periodoId}
      returning id, sin_respaldo_asamblea
    `);

    const fila = rows[0];
    // No hay forma de distinguir "no existe" de "no lo podés ver", y **no se intenta**: si el
    // servicio los diferenciara, el uuid de un período ajeno sería un oráculo de existencia.
    if (!fila) rechazarPeriodoInaccesible();
    return { id: fila.id, sinRespaldoAsamblea: fila.sin_respaldo_asamblea };
  });
}

/**
 * Corrige un gasto ya cargado.
 *
 * **No se puede cambiar el concepto**, y por eso no está en el esquema: el concepto define el tipo
 * (ordinaria / extraordinaria), el encuadre fiscal y si es fondo de reserva. Cambiarlo no es corregir
 * un gasto: es cargar otro. Mientras el período está en borrador, borrarlo y volver a cargarlo cuesta
 * lo mismo y deja el dato coherente.
 *
 * El `where` no lleva `periodo_id` ni `barrio_id`: la RLS ya decide qué filas alcanza este usuario, y
 * agregarlos sería filtrar por un valor que manda el cliente sobre un conjunto que la base ya acotó.
 */
export async function corregirGasto(
  tx: DbConIdentidad,
  parametros: CorregirGasto,
): Promise<GastoEscrito> {
  const p = corregirGastoSchema.parse(parametros);

  return enBase(async () => {
    // El trigger `trg_gasto_respaldo` es `before insert or update`: sacar el acta de una
    // extraordinaria vuelve a marcarla sola. Por eso el `returning` la trae de nuevo en vez de
    // devolver la que se mandó.
    const { rows } = await tx.execute<FilaEscrita>(sql`
      update gasto_periodo
         set descripcion = ${p.descripcion},
             monto = ${p.monto}::numeric,
             proveedor_nombre = ${p.proveedorNombre},
             comprobante = ${p.comprobante},
             acta_documento_id = ${p.actaDocumentoId}
       where id = ${p.gastoId}
      returning id, sin_respaldo_asamblea
    `);

    const fila = rows[0];
    if (!fila) {
      rechazar(
        "gasto_no_encontrado",
        "Ese gasto no existe, ya se borró, o no tenés permiso para modificarlo.",
        "Recargá la lista de gastos del período.",
      );
    }
    return { id: fila.id, sinRespaldoAsamblea: fila.sin_respaldo_asamblea };
  });
}

/**
 * Borra un gasto del período.
 *
 * **Se llama `borrarGasto` y no `anularGasto`** —que es como lo nombra el inventario del ADR-0002
 * §7— porque eso es lo que hace: un `delete`. Un gasto no deja rastro de anulación, a diferencia de
 * `anularAplicacion`, que sí escribe un evento con motivo y autor. Llamarlo "anular" prometería una
 * auditoría que no existe, y esa promesa se cobra el día que alguien pregunte quién sacó un gasto de
 * $ 5.000.000.
 *
 * Que se pueda borrar sin dejar rastro **no es un agujero mientras el período esté en borrador**: un
 * borrador todavía no le fue comunicado a nadie y se regenera entero. `app.periodo_editable` es el
 * que impide borrar después de emitir, y por eso el grant de `delete` que 0005 §5 le da a
 * `gasto_periodo` no abre nada.
 */
export async function borrarGasto(tx: DbConIdentidad, parametros: AnularGasto): Promise<void> {
  const { gastoId } = anularGastoSchema.parse(parametros);

  await enBase(async () => {
    const resultado = await tx.execute(sql`delete from gasto_periodo where id = ${gastoId}`);
    if ((resultado.rowCount ?? 0) === 0) {
      rechazar(
        "gasto_no_encontrado",
        "Ese gasto no existe, ya se borró, o no tenés permiso para borrarlo.",
        "Recargá la lista de gastos del período.",
      );
    }
  });
}
