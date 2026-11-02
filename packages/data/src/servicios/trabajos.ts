/**
 * La cola de trabajos: encolar la emisión de los documentos de un período y mirar cómo va.
 *
 * **Lo único que el request manda es `tipo` y `referenciaId`.** El barrio y la identidad los escribe
 * la base (`app.trabajo_antes_insert()`, migración 0027), y no por prolijidad: `solicitado_por` es la
 * identidad **bajo la cual el worker corre el lote**, no una firma de auditoría. Si quien encola
 * pudiera escribirla, un `operador` encolaría con el uuid de un `admin_plataforma` y la emisión
 * entera correría con esa identidad (ADR-0002 §6.4 punto 2).
 *
 * Por lo mismo **este módulo no tiene ninguna función que actualice un trabajo**: el rol de request
 * no tiene `update` sobre la tabla, ni policy ni grant. Avanzar un trabajo es del worker, y vive en
 * `apps/worker/src/servidor/cola.ts`, que es el único lugar del sistema que toca la conexión con
 * BYPASSRLS.
 */

import { sql } from "drizzle-orm";
import { consultaPeriodoSchema, idSchema } from "@admin-barrios/shared/consultas";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar, rechazarPeriodoInaccesible } from "../errores.ts";

/** Los estados por los que pasa un trabajo. Espejo del enum `app.estado_trabajo`. */
export type EstadoTrabajo = "encolado" | "corriendo" | "terminado" | "fallado";

export type Trabajo = {
  readonly id: string;
  readonly estado: EstadoTrabajo;
  /** Documentos escritos hasta ahora. Avanza **por chunk**, así que puede ir un poco atrás. */
  readonly hechos: number;
  /** Cuántos son en total. `null` mientras el worker no arrancó: la pantalla dice "preparando". */
  readonly total: number | null;
  readonly solicitadoAt: string;
  readonly iniciadoAt: string | null;
  readonly terminadoAt: string | null;
  /** Mensaje ya traducido por el worker. Nunca un `e.message` crudo (ADR-0002 §4.2). */
  readonly error: string | null;
};

/**
 * Exportada (junto con `comoTrabajo` y `COLUMNAS`, abajo) para que `encolarEmisionDeRecibo()`
 * (`cobros.ts`) devuelva el mismo `Trabajo` sin repetir el `select` ni el mapeo — sigue siendo este
 * archivo, y no `cobros.ts`, el único lugar que conoce la forma de la fila de `trabajo`.
 */
export type FilaTrabajo = {
  id: string;
  estado: EstadoTrabajo;
  hechos: number;
  total: number | null;
  solicitado_at: string;
  iniciado_at: string | null;
  terminado_at: string | null;
  error: string | null;
};

export function comoTrabajo(f: FilaTrabajo): Trabajo {
  return {
    id: f.id,
    estado: f.estado,
    hechos: f.hechos,
    total: f.total,
    solicitadoAt: f.solicitado_at,
    iniciadoAt: f.iniciado_at,
    terminadoAt: f.terminado_at,
    error: f.error,
  };
}

export const COLUMNAS = sql`id, estado, hechos, total,
                     solicitado_at::text as solicitado_at,
                     iniciado_at::text   as iniciado_at,
                     terminado_at::text  as terminado_at,
                     error`;

/**
 * Encola la generación de los documentos de un período.
 *
 * **No recibe `barrioId`**, igual que el resto de los servicios del período: el barrio lo deriva la
 * base de la propia referencia, bajo RLS (ADR-0002 §3.4). Un servicio que recibe un `barrioId` que
 * no usa es una invitación a que el próximo lo use para filtrar.
 *
 * Las dos compuertas de acá arriba no reemplazan a la base —el trigger y las policies mandan— pero
 * dan un mensaje que sirve: "el período todavía está en borrador" es accionable, "no se pudo derivar
 * el barrio" no.
 */
export async function encolarEmisionDeDocumentos(
  tx: DbConIdentidad,
  entrada: { periodoId: string },
): Promise<Trabajo> {
  const { periodoId } = consultaPeriodoSchema.parse(entrada);

  return enBase(async () => {
    const periodo = (
      await tx.execute<{ estado: string; liquidaciones: string }>(sql`
        select p.estado::text as estado,
               (select count(*) from liquidacion l where l.periodo_id = p.id)::text as liquidaciones
          from periodo_expensa p
         where p.id = ${periodoId}
      `)
    ).rows[0];

    // Cero filas bajo RLS = "no existe" y "no es tuyo" son el mismo caso, a propósito.
    if (!periodo) rechazarPeriodoInaccesible();

    if (periodo.estado !== "emitida" && periodo.estado !== "distribuida") {
      rechazar(
        "transicion_invalida",
        "Todavía no se pueden generar los documentos: el período no está emitido.",
        "Terminá de revisar el borrador y emití el período. Los documentos salen de lo que quedó emitido.",
        { estado: periodo.estado },
      );
    }

    if (Number(periodo.liquidaciones) === 0) {
      rechazar(
        "periodo_sin_liquidaciones",
        "El período no tiene ninguna liquidación: no hay documentos que generar.",
        "Generá el borrador primero, en el paso «Revisar y emitir».",
      );
    }

    const fila = (
      await tx.execute<FilaTrabajo>(sql`
        insert into trabajo (tipo, referencia_id)
        values ('emitir_documentos_periodo', ${periodoId})
        returning ${COLUMNAS}
      `)
    ).rows[0];

    // Un `insert` que no insertó y no rebotó no debería existir. Si pasa, es un camino nuevo.
    if (!fila) {
      rechazar(
        "desconocido",
        "No se pudo encolar la generación de documentos.",
        "Recargá la pantalla y volvé a intentar.",
      );
    }
    return comoTrabajo(fila);
  });
}

/** El estado de un trabajo. Es lo que consulta el polling de la pantalla de emisión. */
export async function leerTrabajo(tx: DbConIdentidad, trabajoId: string): Promise<Trabajo> {
  // Un segmento de URL sin forma de uuid es "no existe", no un error del sistema: sin esto revienta
  // el cast de Postgres y sale un 500 con código de soporte por un enlace mal escrito.
  const parseado = idSchema.safeParse(trabajoId);
  if (!parseado.success) {
    rechazar(
      "trabajo_no_encontrado",
      "Ese trabajo de emisión no existe o no tenés acceso.",
      "Volvé al período y mirá el estado de la emisión desde ahí.",
    );
  }
  const id = parseado.data;
  return enBase(async () => {
    const fila = (
      await tx.execute<FilaTrabajo>(sql`select ${COLUMNAS} from trabajo where id = ${id}`)
    ).rows[0];
    if (!fila) {
      rechazar(
        "trabajo_no_encontrado",
        "Ese trabajo de emisión no existe o no tenés acceso.",
        "Volvé al período y mirá el estado de la emisión desde ahí.",
      );
    }
    return comoTrabajo(fila);
  });
}

/**
 * El último trabajo de emisión de un período, si hay alguno.
 *
 * Devuelve `null` y no lanza cuando no hay ninguno: "todavía no se emitió" es un estado normal de la
 * pantalla, no un error.
 */
export async function leerUltimoTrabajoDelPeriodo(
  tx: DbConIdentidad,
  periodoId: string,
): Promise<Trabajo | null> {
  return leerUltimoTrabajoDelPeriodoPorTipo(tx, periodoId, "emitir_documentos_periodo");
}

/**
 * Los cuatro trabajos que cuelgan de un período. Espejo del `trabajo_tipo_chk` (`0053`), menos
 * `emitir_recibo_pago`, que referencia un pago y no un período.
 *
 * **Son cuatro tipos y no uno con un parámetro**, y el motivo está escrito en `0053`: el tope de
 * reintentos y el estado `fallado` son **por fila**. Con un solo trabajo, un fallo al armar el ZIP
 * quemaría un intento del envío y reintentarlo volvería a recorrer destinatarios.
 */
export type TipoTrabajoDePeriodo =
  | "emitir_documentos_periodo"
  | "emitir_informe_periodo"
  | "armar_paquete_periodo"
  | "distribuir_liquidaciones";

/**
 * El último trabajo **de un tipo** en un período, si hay alguno.
 *
 * Por tipo y no "el último de cualquiera": la pantalla de distribución sigue los tres pasos a la vez
 * y cada uno tiene su propia barra. Sin el filtro, encolar el ZIP haría saltar el seguimiento del
 * informe al trabajo equivocado.
 *
 * Devuelve `null` y no lanza cuando no hay ninguno: "todavía no se hizo" es un estado normal de la
 * pantalla, no un error.
 */
export async function leerUltimoTrabajoDelPeriodoPorTipo(
  tx: DbConIdentidad,
  periodoId: string,
  tipo: TipoTrabajoDePeriodo,
): Promise<Trabajo | null> {
  return enBase(async () => {
    const fila = (
      await tx.execute<FilaTrabajo>(sql`
        select ${COLUMNAS} from trabajo
         where referencia_id = ${periodoId} and tipo = ${tipo}
         order by solicitado_at desc
         limit 1
      `)
    ).rows[0];
    return fila ? comoTrabajo(fila) : null;
  });
}

/**
 * Encola uno de los tres trabajos de la distribución: el informe mensual, el ZIP o los correos.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * **NO HAY NINGUNA COMPUERTA EN TYPESCRIPT ACÁ, Y ES A PROPÓSITO.**
 *
 * `encolarEmisionDeDocumentos()` (arriba) sí las tiene, y esa asimetría es deliberada. Todas las
 * precondiciones de estos tres —el período emitido, que haya boletas, que exista el informe, que el
 * paquete esté armado, y el gate de rol de la distribución— viven en `app.trabajo_antes_insert()`
 * (`0053`), que es el único lugar que no se puede saltear: el rol de request puede insertar en
 * `trabajo` directo, así que un chequeo escrito acá es un chequeo que la próxima ruta se olvida
 * (`security-engineer`, B-5). Repetirlos también en TypeScript sería una segunda definición de las
 * mismas reglas, y el día que una cambie en la base va a quedar la otra contestando lo viejo.
 *
 * Lo que sí hace falta es que el rechazo **se lea**: los cinco mensajes del trigger tienen su regla
 * en `errores.ts`, así que llegan a la pantalla como un mensaje y una salida, no como un código de
 * soporte.
 */
export async function encolarTrabajoDelPeriodo(
  tx: DbConIdentidad,
  entrada: { periodoId: string; tipo: TipoTrabajoDePeriodo },
): Promise<Trabajo> {
  const { periodoId } = consultaPeriodoSchema.parse({ periodoId: entrada.periodoId });
  const tipo = entrada.tipo;

  return enBase(async () => {
    const fila = (
      await tx.execute<FilaTrabajo>(sql`
        insert into trabajo (tipo, referencia_id)
        values (${tipo}, ${periodoId})
        returning ${COLUMNAS}
      `)
    ).rows[0];

    // Un `insert` que no insertó y no rebotó no debería existir. Si pasa, es un camino nuevo.
    if (!fila) {
      rechazar(
        "desconocido",
        "No se pudo encolar el trabajo.",
        "Recargá la pantalla y volvé a intentar.",
      );
    }
    return comoTrabajo(fila);
  });
}
