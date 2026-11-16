/**
 * Grupos de unidades del barrio (encargo 16b, `0083`): «Lotes baldíos», «Frente al lago».
 *
 * Un grupo es una lista de unidades del padrón con nombre. Lo usa un concepto de boleta que se aplica
 * solo a ese grupo (el corte de pasto a los lotes baldíos): al calcular el mes, el grupo se expande a
 * sus unidades activas. Los arma la administración del barrio eligiendo unidades; la base hace cumplir
 * el permiso (RLS) y que todas las unidades sean del mismo barrio (FK compuestas).
 */

import { sql } from "drizzle-orm";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { consultaBarrioSchema, idSchema } from "@admin-barrios/shared/consultas";
import {
  crearGrupoDeUnidadesSchema,
  editarGrupoDeUnidadesSchema,
  type CrearGrupoDeUnidades,
  type EditarGrupoDeUnidades,
} from "@admin-barrios/shared/conceptos";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";
import { ordenNaturalDeUnidad } from "./orden-de-unidades.ts";

export type GrupoDeUnidades = {
  readonly id: string;
  readonly nombre: string;
  /** Las unidades activas del grupo, en el orden del padrón. */
  readonly unidades: readonly { readonly id: string; readonly etiqueta: string }[];
  /** Los conceptos de boleta que van a este grupo. Con alguno, el grupo no se puede borrar. */
  readonly usadoPor: readonly string[];
};

/** Los grupos del barrio, por nombre. */
export async function listarGruposDeUnidades(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<GrupoDeUnidades[]> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);
  const { rows: grupos } = await tx.execute<{ id: string; nombre: string; usado_por: string[] | null }>(sql`
    select g.id, g.nombre,
           (select array_agg(cb.nombre order by cb.nombre) from concepto_boleta cb where cb.grupo_id = g.id) as usado_por
      from grupo_unidades g where g.barrio_id = ${barrioId}
     order by lower(g.nombre)
  `);
  const { rows: miembros } = await tx.execute<{ grupo_id: string; id: string; manzana: string; lote: string }>(sql`
    select m.grupo_id, u.id, u.manzana, u.lote
      from grupo_unidades_miembro m join unidad_funcional u on u.id = m.unidad_funcional_id
     where m.barrio_id = ${barrioId} and u.baja_at is null
     order by ${ordenNaturalDeUnidad(sql`u.manzana`, sql`u.lote`)}
  `);
  return grupos.map((g) => ({
    id: g.id,
    nombre: g.nombre,
    unidades: miembros.filter((m) => m.grupo_id === g.id).map((m) => ({ id: m.id, etiqueta: etiquetaUnidad(m.manzana, m.lote) })),
    usadoPor: g.usado_por ?? [],
  }));
}

async function exigirAdministracionDelBarrio(tx: DbConIdentidad, barrioId: string): Promise<void> {
  const { rows } = await tx.execute<{ puede: boolean }>(sql`
    select app.has_role_on(${barrioId}::uuid, array['admin_plataforma','admin_barrio']::app.rol_membership[]) as puede
  `);
  if (!rows[0]?.puede) {
    rechazar(
      "sin_permiso",
      "Los grupos de unidades los arma la administración del barrio.",
      "Pedíselo a quien administra el barrio.",
    );
  }
}

/**
 * Deja escrito quién cambió qué (panel `security-engineer`, 3): un grupo decide a quién se le cobra un
 * concepto, y sin esto lo único que quedaba era la anulación de la aplicación, firmada por quien
 * volvió a calcular y no por quien cambió el grupo. Va al historial del barrio (`padron_evento`,
 * `configuracion_barrio`), que solo se agrega y que firma la base.
 */
export async function registrarCambioDeCatalogo(tx: DbConIdentidad, barrioId: string, detalle: string, datos: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`
    insert into padron_evento (barrio_id, unidad_funcional_id, tipo, detalle, datos)
    values (${barrioId}, null, 'configuracion_barrio', ${detalle.slice(0, 1000)}, ${JSON.stringify(datos)}::jsonb)
  `);
}

const etiquetasDe = async (tx: DbConIdentidad, ids: readonly string[]): Promise<string[]> =>
  ids.length === 0
    ? []
    : (
        await tx.execute<{ manzana: string; lote: string }>(sql`
          select manzana, lote from unidad_funcional where id = any(${sql.param([...ids])}::uuid[])
           order by ${ordenNaturalDeUnidad(sql`manzana`, sql`lote`)}
        `)
      ).rows.map((u) => etiquetaUnidad(u.manzana, u.lote));

/** Deja en el grupo exactamente estas unidades: saca las que sobran y agrega las que faltan. Devuelve qué cambió. */
async function fijarMiembros(
  tx: DbConIdentidad,
  barrioId: string,
  grupoId: string,
  unidades: readonly string[],
): Promise<{ entran: string[]; salen: string[] }> {
  const pedidas = [...new Set(unidades)];
  const { rows: actuales } = await tx.execute<{ id: string }>(sql`select unidad_funcional_id as id from grupo_unidades_miembro where grupo_id = ${grupoId}`);
  const antes = new Set(actuales.map((a) => a.id));
  const entran = pedidas.filter((u) => !antes.has(u));
  const salen = [...antes].filter((u) => !pedidas.includes(u));
  const { rows: validas } = await tx.execute<{ id: string }>(sql`
    select id from unidad_funcional
     where barrio_id = ${barrioId} and baja_at is null and id = any(${sql.param(pedidas)}::uuid[])
  `);
  if (validas.length !== pedidas.length) {
    rechazar("dato_invalido", "Alguna de las unidades elegidas no es de este barrio o está dada de baja.", "Recargá la lista y volvé a elegir.", {
      campo: "unidades",
    });
  }
  await tx.execute(sql`
    delete from grupo_unidades_miembro
     where grupo_id = ${grupoId} and not (unidad_funcional_id = any(${sql.param(pedidas)}::uuid[]))
  `);
  if (pedidas.length > 0) {
    await tx.execute(sql`
      insert into grupo_unidades_miembro (grupo_id, unidad_funcional_id, barrio_id)
      select ${grupoId}, u, ${barrioId} from unnest(${sql.param(pedidas)}::uuid[]) as u
      on conflict (grupo_id, unidad_funcional_id) do nothing
    `);
  }
  return { entran: await etiquetasDe(tx, entran), salen: await etiquetasDe(tx, salen) };
}

/** Crea un grupo con sus unidades. El nombre no se repite en el barrio. */
export async function crearGrupoDeUnidades(tx: DbConIdentidad, parametros: CrearGrupoDeUnidades): Promise<{ readonly grupoId: string }> {
  const p = crearGrupoDeUnidadesSchema.parse(parametros);
  return enBase(async () => {
    await exigirAdministracionDelBarrio(tx, p.barrioId);
    await exigirNombreLibre(tx, p.barrioId, p.nombre, null);
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into grupo_unidades (barrio_id, nombre) values (${p.barrioId}, ${p.nombre}) returning id
    `);
    const grupoId = rows[0]?.id;
    if (!grupoId) rechazar("desconocido", "No se pudo crear el grupo.", "Recargá la pantalla y volvé a intentar.");
    const { entran } = await fijarMiembros(tx, p.barrioId, grupoId, p.unidades);
    await registrarCambioDeCatalogo(tx, p.barrioId, `Grupo de unidades «${p.nombre}»: se crea con ${entran.length} ${entran.length === 1 ? "unidad" : "unidades"}${entran.length > 0 ? ` (${entran.join(", ")})` : ""}.`, {
      grupoId,
      entran,
    });
    return { grupoId };
  });
}

async function exigirNombreLibre(tx: DbConIdentidad, barrioId: string, nombre: string, salvoId: string | null): Promise<void> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    select id from grupo_unidades
     where barrio_id = ${barrioId} and lower(btrim(nombre)) = lower(btrim(${nombre})) and (${salvoId}::uuid is null or id <> ${salvoId}::uuid)
  `);
  if (rows.length > 0) {
    rechazar("dato_invalido", "Ya hay un grupo con ese nombre en el barrio.", "Elegí otro nombre, o editá el grupo que ya existe.", { campo: "nombre" });
  }
}

async function barrioDelGrupo(tx: DbConIdentidad, grupoId: string): Promise<string> {
  const { rows } = await tx.execute<{ barrio_id: string }>(sql`select barrio_id from grupo_unidades where id = ${grupoId}`);
  const barrioId = rows[0]?.barrio_id;
  if (!barrioId) rechazar("dato_invalido", "Ese grupo no existe o no tenés acceso.", "Recargá la lista de grupos.");
  return barrioId;
}

/** Cambia el nombre y la lista de unidades del grupo. Rige para los meses que se calculen desde ahora. */
export async function editarGrupoDeUnidades(tx: DbConIdentidad, parametros: EditarGrupoDeUnidades): Promise<void> {
  const p = editarGrupoDeUnidadesSchema.parse(parametros);
  await enBase(async () => {
    const barrioId = await barrioDelGrupo(tx, p.grupoId);
    await exigirAdministracionDelBarrio(tx, barrioId);
    await exigirNombreLibre(tx, barrioId, p.nombre, p.grupoId);
    const { rows: antes } = await tx.execute<{ nombre: string }>(sql`select nombre from grupo_unidades where id = ${p.grupoId}`);
    const nombreAntes = antes[0]?.nombre ?? p.nombre;
    await tx.execute(sql`update grupo_unidades set nombre = ${p.nombre} where id = ${p.grupoId} and nombre <> ${p.nombre}`);
    const { entran, salen } = await fijarMiembros(tx, barrioId, p.grupoId, p.unidades);
    const cambios = [
      nombreAntes !== p.nombre ? `pasa a llamarse «${p.nombre}»` : null,
      entran.length > 0 ? `entran ${entran.join(", ")}` : null,
      salen.length > 0 ? `salen ${salen.join(", ")}` : null,
    ].filter((x): x is string => x !== null);
    if (cambios.length > 0) {
      await registrarCambioDeCatalogo(tx, barrioId, `Grupo de unidades «${nombreAntes}»: ${cambios.join("; ")}.`, { grupoId: p.grupoId, entran, salen });
    }
  });
}

/** Borra un grupo que ningún concepto usa. */
export async function borrarGrupoDeUnidades(tx: DbConIdentidad, parametros: { readonly grupoId: string }): Promise<void> {
  const grupoId = idSchema.parse(parametros.grupoId);
  await enBase(async () => {
    const barrioId = await barrioDelGrupo(tx, grupoId);
    await exigirAdministracionDelBarrio(tx, barrioId);
    const { rows } = await tx.execute<{ nombre: string }>(sql`select nombre from concepto_boleta where grupo_id = ${grupoId} order by nombre limit 3`);
    if (rows.length > 0) {
      rechazar(
        "dato_invalido",
        `El grupo lo usa ${rows.length === 1 ? "el concepto" : "los conceptos"} ${rows.map((r) => `«${r.nombre}»`).join(", ")}.`,
        "Cambiá a quién va ese concepto antes de borrar el grupo.",
      );
    }
    const { rows: borrado } = await tx.execute<{ nombre: string }>(sql`delete from grupo_unidades where id = ${grupoId} returning nombre`);
    if (borrado[0]) await registrarCambioDeCatalogo(tx, barrioId, `Grupo de unidades «${borrado[0].nombre}»: se borra.`, { grupoId });
  });
}
