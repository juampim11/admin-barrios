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

type FilaTrabajo = {
  id: string;
  estado: EstadoTrabajo;
  hechos: number;
  total: number | null;
  solicitado_at: string;
  iniciado_at: string | null;
  terminado_at: string | null;
  error: string | null;
};

function comoTrabajo(f: FilaTrabajo): Trabajo {
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

const COLUMNAS = sql`id, estado, hechos, total,
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
  return enBase(async () => {
    const fila = (
      await tx.execute<FilaTrabajo>(sql`
        select ${COLUMNAS} from trabajo
         where referencia_id = ${periodoId} and tipo = 'emitir_documentos_periodo'
         order by solicitado_at desc
         limit 1
      `)
    ).rows[0];
    return fila ? comoTrabajo(fila) : null;
  });
}
