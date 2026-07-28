/**
 * Los barrios que el usuario administra, y el detalle de uno.
 *
 * Son las dos primeras lecturas del recorrido (ADR-0002 §7, pantallas 2 y 3) y las dos que fijan el
 * patrón para todo lo que venga después:
 *
 * **1. Nadie filtra por barrio a mano.** No hay un `where barrio_id = <el del usuario>` en ninguna
 * parte. La lista sale de lo que la RLS deja ver, y `leerBarrio` recibe el uuid del segmento de la
 * URL y **no lo usa para autorizar**: lo usa para elegir cuál mirar. Si el usuario no tiene acceso,
 * la policy devuelve cero filas y el servicio devuelve `null` — la autorización la hizo la base
 * (ADR-0002 §3.4, que corrige la nota `[fe]` del doc 06 §c.1).
 *
 * **2. `null` en vez de `throw` cuando no hay fila.** El llamador tiene que poder hacer `notFound()`
 * **después** de que la transacción cerró: `notFound()` de Next funciona lanzando, y un throw
 * adentro del callback dispara el `ROLLBACK` (ADR-0002 §3.1). Un servicio que lanza obliga a
 * capturar, y un `catch` ancho alrededor de `conSesion` se traga el `NEXT_REDIRECT` del login.
 *
 * **3. El rol se lee de `membership`, no se calcula por fila.** `app.has_role_on()` es
 * `SECURITY DEFINER` y Postgres nunca la inlinea: es una llamada real por cada fila evaluada
 * (migración 0018 midió ×124 y ×209 en las tablas grandes). Acá se traen las membresías del usuario
 * —que son pocas y las devuelve siempre la policy de `membership`— en **una** consulta aparte, y el
 * cruce con el subárbol se hace en memoria sobre el `path`. Dos consultas fijas, sin N+1.
 */

import { sql } from "drizzle-orm";
import { consultaBarrioSchema } from "@admin-barrios/shared/consultas";
import type { RolMembership } from "@admin-barrios/shared/tenancy";
import type { DbConIdentidad } from "../client.ts";

/**
 * Roles con los que el usuario llega a un barrio. Puede ser más de uno (membresía directa en el
 * barrio + membresía heredada del administrador), y **es por nodo**: la misma persona puede ser
 * `admin_barrio` en uno y `contador` en otro. Por eso no cabe en un claim del token y por eso el rol
 * no viaja en la sesión (ADR-0002 §2.2).
 *
 * Es dato **para la UI** —qué botones mostrar—, nunca la autorización: esa la hace la base en cada
 * consulta y en cada escritura.
 *
 * Es un alias de `RolMembership` y **no una lista escrita a mano**: esa constante ya es la fuente de
 * verdad —`packages/data/src/schema/tenancy.ts` construye el `pgEnum` desde ella—, así que copiarla
 * acá haría que agregar un rol al enum de Postgres dejara a este servicio devolviendo un string que
 * su propio tipo dice que no existe.
 */
export type RolEnBarrio = RolMembership;

export type BarrioAccesible = {
  readonly id: string;
  readonly nombre: string;
  readonly figuraJuridica: string;
  readonly municipio: string;
  /** Cómo se llama lo que se cobra en este barrio ("expensa", "cuota social"). */
  readonly denominacionConcepto: string | null;
  /**
   * Estudio con mandato **vigente**, si lo hay. `null` = el barrio se autoadministra.
   *
   * Hasta la migración `0020` esto podía venir `null` **aunque el mandato existiera**, y no era un
   * bug de este servicio: `mandato_administracion` se lee con `readable_tenant_ids()` sobre el
   * `barrio_id` —así que la fila sí era visible—, pero el `nombre` vive en `tenant_node`, cuya policy
   * alcanzaba al subárbol y a los hijos directos y **no a los ancestros**. El nodo del estudio está
   * por encima del barrio.
   *
   * No era cosmético: `vista-boleta.ts` hace el mismo `left join` y la boleta imprime al
   * administrador como emisor; un `operador` —rol que SÍ puede emitir— generaba los PDF con el
   * emisor cayendo al nombre del barrio. `0020` abre la lectura del nodo ancestro **con mandato
   * abierto**, con tres guardas (tipo, ancestría real y rol de gestión) para que abrir el nombre no
   * abra ni la estructura del estudio ni sus otros barrios.
   *
   * ⚠ **Lo que sigue pendiente**: esto resuelve la pantalla, no la reimpresión. El día que cambia el
   * estudio, el nombre del emisor de una boleta ya emitida se vuelve ilegible (hay un test que lo
   * fija). La salida es congelar la marca del emisor en la liquidación al emitir —que es lo que
   * `FALTANTES_CONOCIDOS.mandatoNoCongelado` ya venía pidiendo, y la única forma de que el CUIT y el
   * domicilio del emisor lleguen a la hoja: `tenant_node` no tiene esas columnas.
   */
  readonly administrador: { readonly id: string; readonly nombre: string } | null;
  readonly unidadesActivas: number;
  readonly roles: readonly RolEnBarrio[];
};

export type DetalleBarrio = BarrioAccesible & {
  readonly adecuadoArt2075: string;
  readonly encuadreUrbanistico: string;
  readonly serviciosInternosACargoDe: string;
  readonly titularidadEspaciosComunes: string | null;
  readonly tieneConsejo: boolean;
  readonly tieneFondoReserva: boolean;
  readonly reglamentoInscripto: boolean | null;
  readonly pactoEjecutividad: boolean | null;
  readonly tieneEspaciosComunesExclusivos: boolean | null;
  readonly cuit: string | null;
  readonly domicilioSede: string | null;
  /** Unidades dadas de baja: siguen en el padrón porque su deuda sigue existiendo (art. 2049). */
  readonly unidadesDeBaja: number;
  /** Hay una versión de coeficientes cerrada y vigente: sin esto no se puede liquidar. */
  readonly tieneCoeficientesVigentes: boolean;
  /** Hay tasa de mora vigente. Si no, la liquidación sale con la mora pendiente de definición. */
  readonly tieneTasaMoraVigente: boolean;
};

type FilaBarrio = {
  id: string;
  path: string;
  nombre: string;
  figura_juridica: string;
  municipio: string;
  denominacion_concepto: string | null;
  administrador_id: string | null;
  administrador_nombre: string | null;
  unidades_activas: number;
};

type FilaMembresia = { rol: RolEnBarrio; path: string };

/**
 * Membresías activas del usuario, con el `path` del nodo sobre el que las tiene.
 *
 * La policy de `membership` (0018 §5) siempre devuelve las propias, con cualquier rol: el login las
 * necesita para saber a qué barrios entra y con qué. Traerlas enteras y cruzarlas en memoria es más
 * barato que preguntar el rol por fila, y además es correcto para el caso central del producto —un
 * administrador de estudio con membresía en el nodo padre, que hereda hacia todo el subárbol—.
 */
async function leerMembresias(tx: DbConIdentidad): Promise<FilaMembresia[]> {
  const { rows } = await tx.execute<FilaMembresia>(sql`
    select m.rol::text as rol, n.path
      from membership m
      join tenant_node n on n.id = m.tenant_node_id
     where m.user_id = app.current_user_id()
       and m.activo
       and n.deleted_at is null
  `);
  return rows;
}

/** Una membresía alcanza al barrio si su nodo es el barrio o un ancestro (materialized path). */
function rolesDe(membresias: readonly FilaMembresia[], pathBarrio: string): RolEnBarrio[] {
  const roles = new Set<RolEnBarrio>();
  for (const m of membresias) {
    if (pathBarrio === m.path || pathBarrio.startsWith(`${m.path}.`)) roles.add(m.rol);
  }
  return [...roles].sort();
}

/**
 * Los barrios que el usuario puede administrar — la pantalla `/`.
 *
 * **No devuelve todos los barrios sobre los que tiene membresía, sino los que puede LEER.** La
 * diferencia es la de 0018: `barrio` está gateada por `app.readable_tenant_ids()`, que exige un rol
 * de gestión. Una membresía `propietario` no trae ni una fila acá, y eso es lo correcto hasta que
 * exista el vínculo usuario → unidad (ADR-0002 §3.5).
 *
 * El `join` a `tenant_node` no relaja nada: `tenant_node` sí es visible con cualquier membresía
 * (0018 §5 lo deja abierto a propósito, para el futuro portal del residente), pero es un `inner
 * join` contra `barrio`, que es la tabla gateada. El filtro efectivo lo pone la más restrictiva.
 */
export async function listarBarriosAccesibles(tx: DbConIdentidad): Promise<BarrioAccesible[]> {
  const [{ rows }, membresias] = await Promise.all([
    tx.execute<FilaBarrio>(sql`
      select n.id, n.path, n.nombre,
             b.figura_juridica::text as figura_juridica, b.municipio, b.denominacion_concepto,
             adm.id   as administrador_id,
             adm.nombre as administrador_nombre,
             (select count(*)
                from unidad_funcional u
               where u.barrio_id = b.barrio_id and u.baja_at is null)::int as unidades_activas
        from barrio b
        join tenant_node n on n.id = b.barrio_id
        left join mandato_administracion m on m.barrio_id = b.barrio_id and m.hasta is null
        left join tenant_node adm on adm.id = m.administrador_id
       where n.deleted_at is null
       order by n.nombre
    `),
    leerMembresias(tx),
  ]);

  return rows.map((f) => armarAccesible(f, membresias));
}

function armarAccesible(f: FilaBarrio, membresias: readonly FilaMembresia[]): BarrioAccesible {
  return {
    id: f.id,
    nombre: f.nombre,
    figuraJuridica: f.figura_juridica,
    municipio: f.municipio,
    denominacionConcepto: f.denominacion_concepto,
    administrador:
      f.administrador_id && f.administrador_nombre
        ? { id: f.administrador_id, nombre: f.administrador_nombre }
        : null,
    unidadesActivas: f.unidades_activas,
    roles: rolesDe(membresias, f.path),
  };
}

/**
 * El detalle de un barrio — la cabecera que arma el `layout.tsx` de `/[barrio]`.
 *
 * `null` = el barrio no existe **o** el usuario no lo puede leer, y **son indistinguibles a
 * propósito**: si el servicio diferenciara los dos casos, el uuid de un barrio ajeno se convertiría
 * en un oráculo de existencia. El llamador hace `notFound()` con el resultado vacío, ya afuera de la
 * transacción.
 */
export async function leerBarrio(tx: DbConIdentidad, parametros: { barrioId: string }): Promise<DetalleBarrio | null> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);

  type FilaDetalle = FilaBarrio & {
    adecuado_art_2075: string;
    encuadre_urbanistico: string;
    servicios_internos_a_cargo_de: string;
    titularidad_espacios_comunes: string | null;
    tiene_consejo: boolean;
    tiene_fondo_reserva: boolean;
    reglamento_inscripto: boolean | null;
    pacto_ejecutividad: boolean | null;
    tiene_espacios_comunes_exclusivos: boolean | null;
    cuit: string | null;
    domicilio_sede: string | null;
    unidades_de_baja: number;
    tiene_coeficientes_vigentes: boolean;
    tiene_tasa_mora_vigente: boolean;
  };

  const [{ rows }, membresias] = await Promise.all([
    tx.execute<FilaDetalle>(sql`
      select n.id, n.path, n.nombre,
             b.figura_juridica::text as figura_juridica, b.municipio, b.denominacion_concepto,
             b.adecuado_art_2075::text as adecuado_art_2075,
             b.encuadre_urbanistico::text as encuadre_urbanistico,
             b.servicios_internos_a_cargo_de::text as servicios_internos_a_cargo_de,
             b.titularidad_espacios_comunes::text as titularidad_espacios_comunes,
             b.tiene_consejo, b.tiene_fondo_reserva, b.reglamento_inscripto, b.pacto_ejecutividad,
             b.tiene_espacios_comunes_exclusivos, b.cuit, b.domicilio_sede,
             adm.id     as administrador_id,
             adm.nombre as administrador_nombre,
             (select count(*) from unidad_funcional u
               where u.barrio_id = b.barrio_id and u.baja_at is null)::int as unidades_activas,
             (select count(*) from unidad_funcional u
               where u.barrio_id = b.barrio_id and u.baja_at is not null)::int as unidades_de_baja,
             exists (select 1 from coeficiente_version cv
                      where cv.barrio_id = b.barrio_id and cv.cerrada and cv.vigente_hasta is null)
               as tiene_coeficientes_vigentes,
             exists (select 1 from tasa_mora t
                      where t.barrio_id = b.barrio_id and t.vigente_hasta is null)
               as tiene_tasa_mora_vigente
        from barrio b
        join tenant_node n on n.id = b.barrio_id
        left join mandato_administracion m on m.barrio_id = b.barrio_id and m.hasta is null
        left join tenant_node adm on adm.id = m.administrador_id
       where b.barrio_id = ${barrioId}
         and n.deleted_at is null
    `),
    leerMembresias(tx),
  ]);

  const f = rows[0];
  if (!f) return null;

  return {
    ...armarAccesible(f, membresias),
    adecuadoArt2075: f.adecuado_art_2075,
    encuadreUrbanistico: f.encuadre_urbanistico,
    serviciosInternosACargoDe: f.servicios_internos_a_cargo_de,
    titularidadEspaciosComunes: f.titularidad_espacios_comunes,
    tieneConsejo: f.tiene_consejo,
    tieneFondoReserva: f.tiene_fondo_reserva,
    reglamentoInscripto: f.reglamento_inscripto,
    pactoEjecutividad: f.pacto_ejecutividad,
    tieneEspaciosComunesExclusivos: f.tiene_espacios_comunes_exclusivos,
    cuit: f.cuit,
    domicilioSede: f.domicilio_sede,
    unidadesDeBaja: f.unidades_de_baja,
    tieneCoeficientesVigentes: f.tiene_coeficientes_vigentes,
    tieneTasaMoraVigente: f.tiene_tasa_mora_vigente,
  };
}
