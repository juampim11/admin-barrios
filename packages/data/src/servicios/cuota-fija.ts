/**
 * La **cuota fija** de un barrio: qué rige hoy y cómo se define la del mes que viene.
 *
 * ## Lo que este servicio no hace, que es lo primero que hay que entender
 *
 * **No divide los gastos por las unidades.** En un barrio de cuota fija la cuota la fija el
 * directorio; el sistema la multiplica, la compara contra el gasto y avisa si no alcanza
 * (`evaluarSuficienciaDeLaCuota`), pero nunca la deduce. Al revés sería el otro modelo —`variable`,
 * el del prorrateo— y ese ya existe.
 *
 * ## Por qué el porcentaje se aplica unidad por unidad
 *
 * Un barrio puede tener una sola cuota para todos (el caso del piloto) o importes distintos por
 * unidad —lotes de distinta categoría, cocheras que pagan la mitad, una unidad con una quita
 * acordada—. "Aumentar un 3,2 %" tiene una sola lectura que no inventa nada: aplicarlo a lo que cada
 * unidad paga hoy. Promediar, o tomar "la" cuota cuando hay varias, sería el sistema decidiendo por
 * el barrio en silencio, y sería una decisión sobre plata de terceros.
 *
 * Cargar un **importe directo**, en cambio, iguala a todos. No está mal —es lo que se hace en el
 * primer período, cuando no hay contra qué aplicar un porcentaje— pero cuando hay importes distintos
 * los borra. Por eso la lectura devuelve `importeUnico` en `null` en ese caso y la lista completa de
 * `cuotas`: con eso la pantalla avisa antes de igualarlas, no después.
 *
 * ## Qué queda guardado
 *
 * Tres cosas, porque ninguna se deduce de las otras: el **importe** (lo que se cobra), el
 * **porcentaje** (la explicación, lo que se contesta cuando el vecino pregunta por qué cambió) y el
 * **redondeo** (una decisión que cambia lo que se cobra, no un detalle de presentación). Ver la
 * migración `0028`.
 *
 * La versión anterior la cierra el trigger `app.cuota_fija_version_antes` (migración `0007` §1) —acá
 * no se hace un `update` de cierre, igual que en el resto de las vigencias del proyecto: cerrar desde
 * la app deja una ventana en la que hay dos versiones abiertas.
 */

import { sql } from "drizzle-orm";
import { ajustarCuota, type RedondeoDeCuota } from "@admin-barrios/shared/liquidacion";
import { definirCuotaFijaSchema, type DefinirCuotaFija } from "@admin-barrios/shared/escrituras";
import { aCentavos, sumarMontos } from "@admin-barrios/shared/dinero";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";

/** Valor absoluto de un `bigint`: no hay `Math.abs` para enteros grandes. */
const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/** Lo que paga una unidad hoy. */
export type CuotaDeUnidad = {
  readonly unidadFuncionalId: string;
  readonly etiqueta: string;
  /** `null` si la unidad se dio de alta después de la versión vigente y todavía no tiene importe. */
  readonly importe: string | null;
};

/** La foto de la cuota vigente, que es contra lo que se decide la próxima. */
export type CuotaFijaVigente = {
  readonly versionId: string | null;
  readonly descripcion: string | null;
  readonly vigenteDesde: string | null;
  /** El porcentaje con el que se llegó a esta cuota, si se cargó así. */
  readonly ajustePorcentaje: string | null;
  readonly redondeo: RedondeoDeCuota | null;
  /** Unidades activas del barrio (las de baja no pagan y no entran en ninguna cuenta). */
  readonly unidadesActivas: number;
  /**
   * La cuota que pagan **todas** las unidades, cuando es una sola. `null` cuando hay importes
   * distintos: decir "la cuota" ahí sería elegir cuál.
   */
  readonly importeUnico: string | null;
  /** Cuánto se factura por mes con la cuota de hoy. `null` si alguna unidad no tiene importe. */
  readonly totalMensual: string | null;
  /** Unidades activas sin importe en la versión vigente: altas posteriores. */
  readonly unidadesSinImporte: number;
  readonly cuotas: readonly CuotaDeUnidad[];
  /**
   * El mes que viene, `YYYY-MM`, **según el reloj de la base**. Es el valor por omisión de "rige
   * desde", y sale de Postgres y no de `new Date()` por la regla 7 del test de arquitectura: una
   * fecha de negocio calculada con el reloj del proceso web depende de la zona horaria del contenedor
   * y puede caer un día antes que la del resto del sistema.
   */
  readonly proximoMes: string;
};

type FilaVigente = {
  version_id: string | null;
  descripcion: string | null;
  vigente_desde: string | null;
  ajuste_porcentaje: string | null;
  redondeo: string | null;
  unidad_funcional_id: string;
  manzana: string;
  lote: string;
  importe: string | null;
};

/**
 * Lee la cuota vigente del barrio, unidad por unidad.
 *
 * Sale de un `left join` desde las **unidades activas**, no desde `cuota_fija`: así una unidad dada
 * de alta después de la última versión aparece con importe `null` en vez de desaparecer. Que falte
 * es un dato —hay que decidir qué paga— y esconderlo lo convertiría en una unidad que no se factura
 * y que nadie extraña hasta que el vecino llama.
 */
export async function cuotaFijaVigente(
  tx: DbConIdentidad,
  barrioId: string,
): Promise<CuotaFijaVigente> {
  const proximo = await tx.execute<{ proximo_mes: string }>(
    sql`select to_char(date_trunc('month', current_date) + interval '1 month', 'YYYY-MM') as proximo_mes`,
  );

  const { rows } = await tx.execute<FilaVigente>(sql`
    with vigente as (
      select id, descripcion, vigente_desde::text, ajuste_porcentaje::text, redondeo
        from cuota_fija_version
       where barrio_id = ${barrioId} and vigente_hasta is null
       limit 1
    )
    select v.id as version_id, v.descripcion, v.vigente_desde, v.ajuste_porcentaje, v.redondeo,
           uf.id as unidad_funcional_id, uf.manzana, uf.lote,
           cf.importe::text as importe
      from unidad_funcional uf
      left join vigente v on true
      left join cuota_fija cf on cf.unidad_funcional_id = uf.id and cf.version_id = v.id
     where uf.barrio_id = ${barrioId} and uf.baja_at is null
     order by uf.manzana, uf.lote
  `);

  const cuotas = rows.map((f) => ({
    unidadFuncionalId: f.unidad_funcional_id,
    etiqueta: etiquetaUnidad(f.manzana, f.lote),
    importe: f.importe,
  }));
  const primera = rows[0];
  const importes = cuotas.map((c) => c.importe);
  const distintos = new Set(importes.filter((i): i is string => i !== null));
  const faltantes = importes.filter((i) => i === null).length;

  return {
    versionId: primera?.version_id ?? null,
    descripcion: primera?.descripcion ?? null,
    vigenteDesde: primera?.vigente_desde ?? null,
    ajustePorcentaje: primera?.ajuste_porcentaje ?? null,
    redondeo: (primera?.redondeo as RedondeoDeCuota | null) ?? null,
    unidadesActivas: cuotas.length,
    // "Una sola cuota" exige que **ninguna** unidad quede sin importe: con una faltante, el número
    // único describiría a las demás y no al barrio.
    importeUnico: distintos.size === 1 && faltantes === 0 ? [...distintos][0]! : null,
    totalMensual:
      faltantes > 0 || cuotas.length === 0
        ? null
        : importes.reduce<string>((acc, i) => sumarMontos(acc, i!), "0.00"),
    unidadesSinImporte: faltantes,
    cuotas,
    proximoMes: proximo.rows[0]?.proximo_mes ?? "",
  };
}

/** Lo que quedó escrito, releído de la base — no lo que mandó el formulario. */
export type CuotaFijaEscrita = {
  readonly versionId: string;
  readonly unidades: number;
  readonly totalMensual: string;
  readonly importeUnico: string | null;
};

/**
 * Define la cuota que rige desde una fecha.
 *
 * Todo pasa dentro de la transacción que ya trae el llamador: leer la vigente y escribir la nueva no
 * pueden quedar separadas por otra escritura, o el porcentaje se aplicaría sobre una base que ya
 * cambió.
 */
export async function definirCuotaFija(
  tx: DbConIdentidad,
  parametros: DefinirCuotaFija,
): Promise<CuotaFijaEscrita> {
  const p = definirCuotaFijaSchema.parse(parametros);

  return enBase(async () => {
    const vigente = await cuotaFijaVigente(tx, p.barrioId);

    if (vigente.unidadesActivas === 0) {
      rechazar(
        "sin_unidades",
        "El barrio no tiene unidades activas: no hay a quién cobrarle la cuota.",
        "Cargá el padrón antes de definir la cuota.",
      );
    }

    /*
     * **La cuota se versiona hacia adelante.** Una versión nueva no puede empezar antes que la que
     * viene a reemplazar: el trigger `app.cuota_fija_version_antes` solo cierra las que empezaron
     * antes o el mismo día, así que una fecha anterior deja dos versiones abiertas y choca contra
     * `uq_cuota_fija_version_abierta` — un 23505 cuyo mensaje ("ese dato ya existe") dice lo
     * contrario de lo que pasó. Se corta acá, con la explicación correcta.
     *
     * Es el mismo criterio que ya tenía el catálogo de conceptos: corregir el pasado cambiaría lo
     * que ya se cobró. Retrodatar **dentro** de la versión abierta sigue permitido —definir el 4 de
     * agosto la cuota que rige desde el 1 es la operatoria normal— porque no reescribe nada.
     */
    // El período llega como `YYYY-MM` y se guarda como el día 1: la columna es `date` y la
    // liquidación busca la vigente al primer día del mes que liquida.
    const rigeDesde = `${p.rigeDesde}-01`;
    if (vigente.vigenteDesde !== null && rigeDesde < vigente.vigenteDesde) {
      rechazar(
        "cuota_retroactiva",
        `El valor vigente rige desde ${vigente.vigenteDesde.slice(0, 7)} y el nuevo no puede empezar antes.`,
        "Elegí ese mes o uno posterior. Un período ya liquidado se corrige en el siguiente, no cambiándole el valor hacia atrás.",
      );
    }

    // Qué le toca a cada unidad. Es la única parte con aritmética, y toda pasa por `ajustarCuota`
    // (centavos con `bigint`): acá no se multiplica nada a mano.
    let nuevas: { unidadFuncionalId: string; importe: string }[];

    if (p.forma === "importe") {
      nuevas = vigente.cuotas.map((c) => ({ unidadFuncionalId: c.unidadFuncionalId, importe: p.importe }));
    } else {
      if (vigente.versionId === null) {
        rechazar(
          "sin_cuota_anterior",
          "Todavía no hay una cuota vigente, así que no hay sobre qué aplicar un porcentaje.",
          "Cargá el importe de la primera cuota; a partir del mes que viene vas a poder ajustarla por porcentaje.",
        );
      }
      if (vigente.unidadesSinImporte > 0) {
        // Se rechaza en vez de inventar una base. La tentación es usar el importe único o el
        // promedio; las dos le asignan a una unidad real una cuota que nadie decidió.
        rechazar(
          "unidades_sin_cuota",
          `Hay ${vigente.unidadesSinImporte} unidad(es) activas sin cuota en la versión vigente: no hay ` +
            "sobre qué aplicarles el porcentaje.",
          "Cargá una cuota por importe para dejarlas todas con un valor, y después ajustá por porcentaje.",
        );
      }
      const ajustes = vigente.cuotas.map((c) => ({
        unidadFuncionalId: c.unidadFuncionalId,
        ajuste: ajustarCuota({
          cuotaVigente: c.importe!,
          porcentaje: p.porcentaje,
          redondeo: p.redondeo,
        }),
      }));

      /*
       * **Un redondeo que pesa más que el ajuste dejó de redondear.**
       *
       * El paso se elige en la pantalla y no mira la magnitud de la cuota, así que hay combinaciones
       * donde el paso se come el resultado: un 0 % al mil sobre una cuota de $500 la deja en $1.000
       * —la duplica sin que nadie haya pedido un aumento— y un 3,2 % al mil sobre una de $400 la
       * deja en cero. Las dos entran limpias en `numeric(14,2)` y las dos pasan el `check` de la
       * base; ninguna es un ajuste del 3,2 % ni del 0 %.
       *
       * La regla es la que se puede explicar en una línea: **el redondeo no puede mover la cuota más
       * de lo que la mueve el ajuste**. Se compara contra el peor caso del barrio, no contra el
       * promedio: si el paso arruina una sola unidad, el paso está mal elegido.
       */
      const peor = ajustes.reduce<{ efecto: bigint; diferencia: bigint } | null>((acc, { ajuste }) => {
        const efecto = abs(aCentavos(ajuste.efectoDelRedondeo));
        return acc && acc.efecto >= efecto
          ? acc
          : { efecto, diferencia: abs(aCentavos(ajuste.diferencia)) };
      }, null);
      if (peor && peor.efecto > peor.diferencia) {
        rechazar(
          "redondeo_desproporcionado",
          "El redondeo elegido mueve la cuota más que el ajuste: con ese paso el resultado ya no es " +
            `un ${p.porcentaje} %.`,
          "Elegí un paso de redondeo más chico (al peso, o al centavo para no redondear).",
        );
      }

      nuevas = ajustes.map((a) => ({ unidadFuncionalId: a.unidadFuncionalId, importe: a.ajuste.nueva }));
    }

    /*
     * **Dejar la cuota en cero necesita que alguien lo diga en voz alta.**
     *
     * Cero es un valor posible —un barrio puede suspender la cuota un mes— pero también es lo que
     * sale de un −100 %, de un redondeo al mil sobre una cuota chica, o de un campo mal tipeado. La
     * diferencia entre las dos cosas no la puede ver el sistema: la ve la persona. Y esta es la
     * única pantalla de dinero del módulo cuyo número se multiplica por **todas** las unidades del
     * barrio, así que se le pone la misma puerta que la migración `0025` le puso a un cargo sobre
     * una sola unidad.
     *
     * No bloquea: pide confirmación explícita y se reintenta (`confirmarCuotaEnCero`).
     */
    const enCero = nuevas.filter((n) => aCentavos(n.importe) === 0n).length;
    if (enCero > 0 && !p.confirmarCuotaEnCero) {
      rechazar(
        "cuota_en_cero",
        enCero === nuevas.length
          ? `Con esto las ${nuevas.length} unidades del barrio quedan en $ 0,00: el barrio deja de facturar.`
          : `Con esto ${enCero} de ${nuevas.length} unidades quedan en $ 0,00 y dejan de pagar.`,
        "Si es a propósito, confirmalo. Si no, revisá el porcentaje o el importe.",
        { unidadesEnCero: String(enCero), unidades: String(nuevas.length) },
      );
    }

    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into cuota_fija_version (barrio_id, descripcion, vigente_desde,
                                      ajuste_porcentaje, redondeo, version_anterior_id, aprobada_por)
      values (${p.barrioId}, ${p.descripcion}, ${rigeDesde}::date,
              ${p.forma === "porcentaje" ? p.porcentaje : null}::numeric,
              ${p.forma === "porcentaje" ? p.redondeo : null},
              ${p.forma === "porcentaje" ? vigente.versionId : null}::uuid,
              app.current_user_id())
      returning id
    `);
    /*
     * El aislamiento **no lo hace este `if`**, y decirlo importa porque el `insert … returning` se
     * parece a los `update … where` del resto del módulo, donde cero filas sí significa "la RLS no
     * te dejó". Acá no: un `with check` violado en un `insert` **lanza** (SQLSTATE 42501), y lo
     * traduce la regla de `errores.ts` con el mensaje de permisos. Esta guarda existe solo para que
     * el tipo no sea `| undefined` — si alguna vez se dispara, es un `insert` que no devolvió su
     * propia fila, o sea algo que no debería poder pasar.
     */
    const version = rows[0];
    if (!version) {
      rechazar(
        "cuota_no_escrita",
        "No se pudo definir la cuota de este barrio.",
        "Volvé a intentarlo. Si sigue pasando, avisá a soporte con el identificador del error.",
      );
    }

    // Un solo `insert` con todas las unidades: quinientas sentencias sueltas serían quinientos
    // round-trips y, peor, quinientas chances de que la mitad entre.
    const valores = sql.join(
      nuevas.map((n) => sql`(${p.barrioId}, ${version.id}, ${n.unidadFuncionalId}, ${n.importe}::numeric)`),
      sql`, `,
    );
    await tx.execute(sql`
      insert into cuota_fija (barrio_id, version_id, unidad_funcional_id, importe)
      values ${valores}
    `);

    // Se relee en vez de devolver lo calculado: es lo que de verdad quedó, ya pasado por los checks y
    // por el `numeric(14,2)` de la columna.
    const escrita = await cuotaFijaVigente(tx, p.barrioId);
    return {
      versionId: version.id,
      unidades: escrita.unidadesActivas,
      totalMensual: escrita.totalMensual ?? "0.00",
      importeUnico: escrita.importeUnico,
    };
  });
}
