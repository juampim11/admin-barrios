/**
 * Cargos y descuentos de boleta aplicados a una unidad: aplicarlos, anularlos y listarlos.
 *
 * ## Lo único que este servicio manda, y por qué es tan poco
 *
 * El `insert` tiene **siete columnas**: período, unidad, concepto, fecha del hecho, cantidad, detalle
 * y origen de la evaluación. Las otras dieciocho —nombre, clase, método, monto fijo, porcentaje,
 * precio unitario, tope, encuadre fiscal, financiamiento, base de cálculo, la firma del autor, el
 * momento, y **el importe**— las escribe `app.cbu_antes()` copiándolas del catálogo y del valor
 * vigente a la fecha del hecho (migración `0017` §5, doc 08 §AC).
 *
 * Eso no es una convención que este archivo respeta por prolijidad: **`app_request` perdió el UPDATE
 * sobre esas columnas** (`0017` §7) y lo que mande el request en ellas se pisa. La primera versión
 * del modelo dejaba que el cliente escribiera el snapshot, y la auditoría lo rompió en un renglón:
 * aplicar el concepto legítimo *Alquiler de quincho ($38.000)* mandando `precio_unitario =
 * 9.500.000`. Entraba, y todos los controles cerraban, porque el check verificaba la fila contra sí
 * misma y el cuadre comparaba la boleta contra ese mismo importe inventado.
 *
 * **Consecuencia para quien construya la pantalla:** el importe de un descuento porcentual **no se
 * conoce al aplicarlo**. Sale de la base de cálculo de la liquidación de esa unidad, que todavía no
 * existe. Lo resuelve `app.resolver_aplicaciones()` cuando se genera el borrador. Si la pantalla
 * necesita mostrar "esto le va a descontar $X", tiene que pedirle el número al mismo cálculo que
 * después lo escribe, nunca estimarlo por su cuenta (doc 08 §AC punto 1): dos aritméticas distintas
 * terminan siempre en un vecino reclamando.
 *
 * ## La coherencia de tenant no se verifica acá
 *
 * `app.cbu_antes()` deriva `barrio_id` **del concepto**. Que el período y la unidad sean del mismo
 * barrio lo hacen cumplir las FKs compuestas de `0016` §1 (`fk_cbu_periodo_barrio` y
 * `fk_cbu_uf_barrio`, las dos contra `(id, barrio_id)`): un período o una unidad de otro barrio
 * **violan la FK**, venga el `insert` de esta pantalla, de un script o de una consola. El servicio no
 * lo revalida; lo que sí hace es traducir esa violación a un mensaje que se entienda (`errores.ts`).
 */

import { sql } from "drizzle-orm";
import {
  anularAplicacionSchema,
  aplicarConceptoAUnidadSchema,
  type AnularAplicacion,
  type AplicarConceptoAUnidad,
} from "@admin-barrios/shared/escrituras";
import { consultaPeriodoSchema } from "@admin-barrios/shared/consultas";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";

/**
 * Lo que quedó congelado al aplicar. **Es lo que escribió la base, releído**, no lo que mandó el
 * request: es la única forma de que la pantalla muestre el precio que de verdad se congeló y no el
 * que la persona creía estar eligiendo.
 */
export type AplicacionEscrita = {
  readonly id: string;
  readonly nombreConcepto: string;
  readonly clase: "cargo" | "descuento";
  readonly metodo: string;
  /** Techo del descuento, si el catálogo lo tiene. En un cargo es siempre `null`. */
  readonly tope: string | null;
  /**
   * Lo que va a costar, **si se puede saber ya**. `null` en el método `porcentaje`: ese importe sale
   * de la liquidación de la unidad, que todavía no existe.
   *
   * Lo calcula **la base**, con `app.cbu_importe_bruto()` — la misma y única definición de la
   * aritmética que usa el cálculo real y el `CHECK` (migración `0017` §2). Que salga de ahí y no de
   * una multiplicación en TypeScript es lo que garantiza que el número que se muestra al aplicar sea
   * el mismo que después aparece en la boleta.
   */
  readonly importeEstimado: string | null;
  /**
   * El cargo superó el umbral de monto inusual del barrio y entró **con confirmación explícita**
   * (migración `0025`). Lo escribe la base, no el request: si el cargo era normal queda en `false`
   * aunque el formulario haya mandado la confirmación. Sirve para que la pantalla lo deje dicho
   * ("se aplicó confirmando un importe inusual") en vez de que el dato solo exista en la base.
   */
  readonly confirmadoPorMontoInusual: boolean;
};

/** Una aplicación tal como la muestra la pantalla de cargos y descuentos. */
export type AplicacionDeLista = {
  readonly id: string;
  readonly unidadFuncionalId: string;
  readonly manzana: string;
  readonly lote: string;
  readonly nombreConcepto: string;
  readonly clase: "cargo" | "descuento";
  readonly metodo: string;
  readonly cantidad: string | null;
  readonly fechaHecho: string;
  readonly detalle: string;
  /** El importe ya resuelto contra la liquidación. `null` = todavía no se generó el borrador. */
  readonly importeResuelto: string | null;
  /** Con signo: negativo en un descuento. Es lo que suma en la boleta. */
  readonly montoResuelto: string | null;
  /** Lo que habría valido sin el tope. Si difiere de `importeResuelto`, el tope mordió. */
  readonly importeSinTope: string | null;
  /** El cargo entró por encima del umbral de monto inusual, confirmado por quien lo aplicó (`0025`). */
  readonly confirmadoPorMontoInusual: boolean;
  /** Como la entrega Postgres, no como `Date`: ver la nota de `emitidaAt` en `periodos.ts`. */
  readonly anuladoAt: string | null;
  readonly motivoAnulacion: string | null;
};

/**
 * Las aplicaciones de un período — pantalla `…/cargos`.
 *
 * **Trae también las anuladas**, con su fecha y su motivo. Ocultarlas dejaría la pantalla mostrando
 * una historia distinta de la que muestra el registro de eventos, y el motivo de una anulación es
 * justamente lo que hay que poder mirar cuando alguien pregunta por qué esa plata no se cobró.
 */
export async function listarAplicaciones(
  tx: DbConIdentidad,
  parametros: { periodoId: string },
): Promise<AplicacionDeLista[]> {
  const { periodoId } = consultaPeriodoSchema.parse(parametros);

  type Fila = {
    id: string;
    unidad_funcional_id: string;
    manzana: string;
    lote: string;
    nombre_concepto: string;
    clase: "cargo" | "descuento";
    metodo: string;
    cantidad: string | null;
    fecha_hecho: string;
    detalle: string;
    importe_resuelto: string | null;
    monto_resuelto: string | null;
    importe_sin_tope: string | null;
    confirmacion_monto_inusual: boolean;
    anulado_at: string | null;
    motivo_anulacion: string | null;
  };

  // Un `join` a `unidad_funcional` y nada más: el nombre del concepto ya está congelado en la fila
  // (por eso se congela), así que traerlo del catálogo de hoy mostraría un nombre distinto del que
  // va a salir impreso.
  const { rows } = await tx.execute<Fila>(sql`
    select c.id, c.unidad_funcional_id, u.manzana, u.lote,
           c.nombre_concepto, c.clase::text as clase, c.metodo::text as metodo,
           c.cantidad::text, c.fecha_hecho::text, c.detalle,
           c.importe_resuelto::text, c.monto_resuelto::text, c.importe_sin_tope::text,
           c.confirmacion_monto_inusual, c.anulado_at::text, c.motivo_anulacion
      from concepto_boleta_unidad c
      join unidad_funcional u on u.id = c.unidad_funcional_id
     where c.periodo_id = ${periodoId}
     order by u.manzana, u.lote, c.aplicado_at
  `);

  return rows.map((f) => ({
    id: f.id,
    unidadFuncionalId: f.unidad_funcional_id,
    manzana: f.manzana,
    lote: f.lote,
    nombreConcepto: f.nombre_concepto,
    clase: f.clase,
    metodo: f.metodo,
    cantidad: f.cantidad,
    fechaHecho: f.fecha_hecho,
    detalle: f.detalle,
    importeResuelto: f.importe_resuelto,
    montoResuelto: f.monto_resuelto,
    importeSinTope: f.importe_sin_tope,
    confirmadoPorMontoInusual: f.confirmacion_monto_inusual,
    anuladoAt: f.anulado_at,
    motivoAnulacion: f.motivo_anulacion,
  }));
}

/**
 * Aplica un concepto del catálogo a una unidad en un período.
 *
 * `barrio_id` **no se manda aunque la columna sea `NOT NULL`**: la escribe `app.cbu_antes()`, que es
 * un trigger `before`, y las restricciones de nulidad se evalúan después de los `before`. Es el mismo
 * `insert` que ya usa el seed, a propósito: el camino de la demo y el de la pantalla son uno solo.
 *
 * ## El tope de un cargo y la confirmación (migración `0025`)
 *
 * Dos controles distintos, y la pantalla los tiene que tratar distinto:
 *
 * - **`tope_operador` / `sin_limite_de_aplicacion` → es un "no podés".** Un `operador` tiene techo de
 *   cargos por unidad y período, acumulado, y falla cerrado si el barrio no lo cargó. No hay nada que
 *   reintentar: lo tiene que aplicar un administrador.
 * - **`cargo_requiere_confirmacion` → es un "¿seguro?".** El cargo supera el umbral de monto inusual
 *   del barrio (por defecto, 3 veces la expensa de esa unidad). El error trae la cifra concreta; la
 *   pantalla la muestra y reintenta con `confirmarMontoInusual: true` si la persona confirma.
 *
 * **El servicio no calcula si el cargo es inusual, y eso es deliberado.** Lo hace `app.cbu_antes()`
 * con `app.cbu_importe_bruto()` — la misma y única definición de la aritmética que después escribe el
 * importe de la boleta (`0017` §2). Calcularlo también acá sería la segunda aritmética que el doc 08
 * §AC prohíbe: el día que difieran, la pantalla dice "normal" y la base cobra otra cosa. Y estando en
 * la base, el candado también corre para un script, un job o una consola.
 */
export async function aplicarConceptoAUnidad(
  tx: DbConIdentidad,
  parametros: AplicarConceptoAUnidad,
): Promise<AplicacionEscrita> {
  const p = aplicarConceptoAUnidadSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<{
      id: string;
      nombre_concepto: string;
      clase: "cargo" | "descuento";
      metodo: string;
      tope: string | null;
      importe_estimado: string | null;
      confirmacion_monto_inusual: boolean;
    }>(sql`
      insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id,
                                          fecha_hecho, cantidad, detalle, origen_evaluacion,
                                          confirmacion_monto_inusual)
      values (${p.periodoId}, ${p.unidadFuncionalId}, ${p.conceptoBoletaId},
              -- Sin fecha del hecho —el caso de un descuento— se congela el valor vigente al
              -- PRIMER DÍA DEL PERÍODO. Se resuelve acá, en el mismo insert, y no en la pantalla:
              -- es lo que fija el precio, y una segunda definición de esta regla en el cliente
              -- sería una fecha distinta el día que alguien la toque.
              coalesce(
                ${p.fechaHecho ?? null}::date,
                (select (pe.periodo || '-01')::date from periodo_expensa pe where pe.id = ${p.periodoId})
              ),
              ${p.cantidad}::numeric, ${p.detalle}, ${p.origenEvaluacion},
              -- La intención de quien carga. La base la evalúa y la normaliza: si el cargo no era
              -- inusual, la fila queda en falso aunque el formulario haya mandado la confirmación.
              ${p.confirmarMontoInusual})
      returning id, nombre_concepto, clase::text as clase, metodo::text as metodo, tope::text,
                confirmacion_monto_inusual,
                -- La base de cálculo va en null porque todavía no existe: con el método
                -- porcentaje la función devuelve null, que es exactamente lo que hay que
                -- mostrar ("todavía no se sabe") y no un cero.
                app.cbu_importe_bruto(metodo, monto_fijo, porcentaje, precio_unitario, cantidad,
                                      null)::text as importe_estimado
    `);

    const fila = rows[0];
    if (!fila) {
      // `desconocido`: el `insert` no insertó y no rebotó. No es "la aplicación no existe" —todavía
      // no existía ninguna—, y ese código haría que la pantalla recargue una lista en vez de avisar.
      rechazar("desconocido", "No se pudo aplicar el concepto.", "Recargá la pantalla y volvé a intentar. Si sigue pasando, pasale el código de referencia a quien te da soporte.");
    }
    return {
      id: fila.id,
      nombreConcepto: fila.nombre_concepto,
      clase: fila.clase,
      metodo: fila.metodo,
      tope: fila.tope,
      importeEstimado: fila.importe_estimado,
      confirmadoPorMontoInusual: fila.confirmacion_monto_inusual,
    };
  });
}

/**
 * Anula una aplicación, con motivo. **Es el único camino para sacar un cargo**, porque una aplicación
 * no se edita (doc 08 §Y y §AC punto 2): editar destruye la evidencia de qué se aprobó.
 *
 * El `where` lleva `anulado_at is null` y eso **no es una comodidad**: sin esa condición, un `update`
 * sobre una fila ya anulada reescribe `motivo_anulacion` sin disparar ningún evento —el trigger
 * `app.cbu_evento()` solo registra la transición de "no anulada" a "anulada"—, o sea que el motivo
 * archivado se podría cambiar después sin dejar rastro. Que hoy el candado esté en TypeScript es una
 * debilidad conocida y está anotada para que suba a la base (ver `0021_anulacion_inmutable.sql`).
 *
 * `anulado_at` y `anulado_por` los pisa el trigger igual (la fecha de anulación no es retrodatable y
 * el autor sale de la sesión). Se mandan de todos modos porque `cbu_anulacion_chk` exige que las tres
 * columnas viajen juntas, y porque escribirlo así deja a la vista que la firma no la elige el cliente.
 */
export async function anularAplicacion(
  tx: DbConIdentidad,
  parametros: AnularAplicacion,
): Promise<void> {
  const p = anularAplicacionSchema.parse(parametros);

  await enBase(async () => {
    const resultado = await tx.execute(sql`
      update concepto_boleta_unidad
         set anulado_at = now(),
             anulado_por = app.current_user_id(),
             motivo_anulacion = ${p.motivo}
       where id = ${p.aplicacionId}
         and anulado_at is null
    `);
    if ((resultado.rowCount ?? 0) > 0) return;

    // Solo en el camino de error: una consulta más para poder decir cuál de los dos casos es. Que
    // "ya anulada" y "no existe" den mensajes distintos no filtra nada — la fila, si existe, este
    // usuario ya la puede leer bajo RLS.
    const { rows } = await tx.execute<{ anulada: boolean }>(sql`
      select anulado_at is not null as anulada from concepto_boleta_unidad where id = ${p.aplicacionId}
    `);
    if (rows[0]?.anulada) {
      rechazar(
        "aplicacion_ya_anulada",
        "Ese cargo ya estaba anulado.",
        "Una anulación no se revierte ni se reescribe. Si hay que volver a cobrarlo, aplicá el concepto de nuevo.",
      );
    }
    rechazar(
      "aplicacion_no_encontrada",
      "Ese cargo no existe o no tenés permiso para anularlo.",
      "Recargá la lista de cargos y descuentos del período.",
    );
  });
}
