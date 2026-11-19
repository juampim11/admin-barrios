/**
 * Identificadores fijos de la demo (encargo F3, tramo 1).
 *
 * Por qué existe: la guía del ensayo trae enlaces directos a pantallas (`/{barrio}/mora/{unidad}`…) y
 * los ids nacían al azar en cada `pnpm db:seed`, así que los enlaces se rompían con cada siembra.
 * Ahora cada barrio, unidad, período, plan y rendición de la demo sale con un UUID v5 que se calcula
 * de una clave legible («talas/mza1-lote4»): la misma en cada siembra.
 *
 * Cómo: el seed inserta con id fijo lo que inserta él (los barrios de arriba). Lo que crean los
 * servicios de dominio —que no reciben un id— se **renumera después**: se cambia el id y todas las
 * columnas que lo apuntan, que se leen del catálogo de claves foráneas (no se escriben a mano: la lista
 * a mano se quedaba atrás cada vez que nacía una tabla). Es el mismo patrón que ya usa el seed para los
 * estudios, y corre con la puerta de mantenimiento (`session_replication_role = replica`), solo en local.
 *
 * Lo que NO se toca (y por qué):
 *  - Las claves de almacenamiento de períodos y pagos (`…/periodos/<uuid>/…`): son punteros opacos y los
 *    checks solo piden «un uuid». Los de planes y rendiciones sí se reescriben, porque el check de la
 *    tabla los ata al id de la propia fila.
 *  - Ninguna cifra, ningún cálculo, ninguna migración.
 */
import { createHash } from "node:crypto";
import type pg from "pg";

/** Espacio de nombres de los UUID v5 de la demo. Inventado y fijo: cambiarlo cambia TODOS los ids. */
const ESPACIO_DE_LA_DEMO = "6f1d3c52-8a0e-4b7a-9d34-2c5e1f7a9b10";

/** UUID v5 (RFC 4122 §4.3): SHA-1 del espacio de nombres seguido de la clave. */
export function idFijo(clave: string): string {
  const espacio = Buffer.from(ESPACIO_DE_LA_DEMO.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(espacio).update(clave, "utf8").digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // versión 5
  b[8] = (b[8]! & 0x3f) | 0x80; // variante RFC 4122
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const sinAcentos = (t: string): string => t.normalize("NFD").replace(/\p{Diacritic}/gu, "");
const kebab = (t: string): string =>
  sinAcentos(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** «Barrio Demo Los Talas» → «talas». La clave legible del barrio, igual a la `clave` de los de arriba. */
export function claveDeBarrio(nombre: string): string {
  return kebab(nombre.replace(/^Barrio Demo\s+/i, "").replace(/^(Los|Las|El|La)\s+/i, ""));
}

/** La clave de una unidad: «talas/mza1-lote4». */
export const claveDeUnidad = (barrio: string, manzana: string, lote: string): string =>
  `${barrio}/mza${kebab(manzana)}-lote${kebab(lote)}`;

/**
 * El mes como distancia al mes en curso: «mes0» es el actual, «mes-1» el anterior. Las claves de períodos y
 * rendiciones usan esto y no «2026-11»: con el mes calendario, sembrar el mes siguiente cambiaría el id de
 * todos y los enlaces de la guía se romperían cada mes.
 */
export function mesRelativo(periodo: string, mesEnCurso: string): string {
  const meses = (p: string): number => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7));
  return `mes${meses(periodo) - meses(mesEnCurso)}`;
}

type Columna = { readonly tabla: string; readonly columna: string };
type Par = { readonly viejo: string; readonly nuevo: string };

/** Las columnas de otras tablas que apuntan, por clave foránea, a `tabla.columna` (una por cada par de la clave). */
async function columnasQueApuntan(cliente: pg.Client, tabla: string, columna: string): Promise<Columna[]> {
  const { rows } = await cliente.query<{ tabla: string; columna: string }>(
    `select cr.relname as tabla, ca.attname as columna
       from pg_constraint k
       join pg_class cr on cr.oid = k.conrelid
       join pg_namespace n on n.oid = cr.relnamespace and n.nspname = 'public'
       join pg_class pr on pr.oid = k.confrelid
       cross join lateral unnest(k.conkey, k.confkey) as p(ck, pk)
       join pg_attribute ca on ca.attrelid = k.conrelid and ca.attnum = p.ck
       join pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = p.pk
      where k.contype = 'f' and pr.relname = $1 and pa.attname = $2`,
    [tabla, columna],
  );
  return rows;
}

/** La columna raíz y todo lo que la apunta, directa o indirectamente (`tenant_node.id` → `barrio.barrio_id` → …). */
async function cierreDeColumnas(cliente: pg.Client, raiz: Columna): Promise<Columna[]> {
  const vistas = new Map<string, Columna>([[`${raiz.tabla}.${raiz.columna}`, raiz]]);
  const pendientes: Columna[] = [raiz];
  while (pendientes.length > 0) {
    const actual = pendientes.pop()!;
    for (const c of await columnasQueApuntan(cliente, actual.tabla, actual.columna)) {
      const clave = `${c.tabla}.${c.columna}`;
      if (vistas.has(clave)) continue;
      vistas.set(clave, c);
      pendientes.push(c);
    }
  }
  return [...vistas.values()];
}

const entrecomillar = (nombre: string): string => `"${nombre.replaceAll('"', '""')}"`;

/**
 * Cambia el id de las filas de `raiz.tabla` (`pares`) y de todo lo que las apunta.
 *
 * `claveEmbebida`: columnas de texto que llevan el id adentro y que un CHECK ata a la fila (la clave de
 * almacenamiento de un plan o de una rendición). Se reescriben **en la misma sentencia** que el id,
 * porque un CHECK se evalúa por sentencia y no se puede diferir.
 */
export async function renumerar(
  cliente: pg.Client,
  raiz: Columna,
  pares: readonly Par[],
  claveEmbebida: Readonly<Record<string, string>> = {},
): Promise<void> {
  if (pares.length === 0) return;
  const columnas = await cierreDeColumnas(cliente, raiz);
  await cliente.query("create temp table if not exists _renumeracion (viejo uuid primary key, nuevo uuid not null)");
  await cliente.query("truncate _renumeracion");
  await cliente.query("insert into _renumeracion (viejo, nuevo) select * from unnest($1::uuid[], $2::uuid[])", [
    pares.map((p) => p.viejo),
    pares.map((p) => p.nuevo),
  ]);
  await cliente.query("set session_replication_role = replica");
  try {
    for (const { tabla, columna } of columnas) {
      const texto = claveEmbebida[`${tabla}.${columna}`];
      const t = entrecomillar(tabla);
      const c = entrecomillar(columna);
      const extra = texto ? `, ${entrecomillar(texto)} = replace(${t}.${entrecomillar(texto)}, r.viejo::text, r.nuevo::text)` : "";
      await cliente.query(`update ${t} set ${c} = r.nuevo${extra} from _renumeracion r where ${t}.${c} = r.viejo`);
    }
  } finally {
    await cliente.query("set session_replication_role = origin");
  }
}

/**
 * Un barrio recién creado por un servicio (que le puso un id al azar): se le fija el de su clave.
 * Se llama justo después de crearlo, cuando no tiene nada colgando más que su ficha: sin documentos, sin
 * claves de almacenamiento y sin nada emitido.
 */
export async function fijarBarrio(cliente: pg.Client, idActual: string, nombre: string): Promise<string> {
  const nuevo = idFijo(`barrio/${claveDeBarrio(nombre)}`);
  if (nuevo !== idActual) await renumerar(cliente, { tabla: "tenant_node", columna: "id" }, [{ viejo: idActual, nuevo }]);
  return nuevo;
}

/**
 * Al final de la siembra: unidades, períodos, planes y rendiciones con su id fijo. Todos salen de una
 * clave que se arma con lo que la demo ya tiene de estable (barrio, manzana y lote, mes, orden de
 * creación dentro de lo que se repite).
 */
export async function fijarIdsDelEnsayo(cliente: pg.Client, mesEnCurso: string): Promise<void> {
  const { rows: barrios } = await cliente.query<{ id: string; nombre: string }>(
    "select id, nombre from tenant_node where tipo = 'barrio'",
  );
  const slug = new Map(barrios.map((b) => [b.id, claveDeBarrio(b.nombre)]));
  const de = (barrioId: string): string => slug.get(barrioId) ?? barrioId;

  // Unidades: «talas/mza1-lote4».
  const { rows: unidades } = await cliente.query<{ id: string; barrio_id: string; manzana: string; lote: string }>(
    "select id, barrio_id, manzana, lote from unidad_funcional",
  );
  const etiquetaDe = new Map(unidades.map((u) => [u.id, claveDeUnidad(de(u.barrio_id), u.manzana, u.lote)]));
  await renumerar(
    cliente,
    { tabla: "unidad_funcional", columna: "id" },
    unidades.map((u) => ({ viejo: u.id, nuevo: idFijo(`unidad/${etiquetaDe.get(u.id)!}`) })),
  );

  // Períodos: «talas/mes0/mensual». Los de plan se repiten en el mes: se numeran por orden de creación
  // (y, si empatan, por la primera unidad que tienen). Con las unidades ya renumeradas, esa unidad es estable.
  const { rows: periodos } = await cliente.query<{ id: string; barrio_id: string; periodo: string; origen: string; n: string; total: string }>(
    `select pe.id, pe.barrio_id, pe.periodo, pe.origen,
            row_number() over (partition by pe.barrio_id, pe.periodo, pe.origen
                               order by pe.created_at,
                                        (select min(u.manzana || '-' || u.lote) from liquidacion l
                                           join unidad_funcional u on u.id = l.unidad_funcional_id where l.periodo_id = pe.id),
                                        pe.id)::text as n,
            count(*) over (partition by pe.barrio_id, pe.periodo, pe.origen)::text as total
       from periodo_expensa pe`,
  );
  await renumerar(
    cliente,
    { tabla: "periodo_expensa", columna: "id" },
    periodos.map((p) => ({
      viejo: p.id,
      nuevo: idFijo(`periodo/${de(p.barrio_id)}/${mesRelativo(p.periodo, mesEnCurso)}/${p.origen}${Number(p.total) > 1 ? `/${p.n}` : ""}`),
    })),
  );

  // Planes: «talas/mza1-lote4/plan1». Los ids de las claves de almacenamiento de sus documentos se reescriben igual.
  const { rows: planes } = await cliente.query<{ id: string; unidad_funcional_id: string; n: string }>(
    `select id, unidad_funcional_id,
            row_number() over (partition by unidad_funcional_id order by created_at, id)::text as n
       from plan_pago`,
  );
  const { rows: unidadesNuevas } = await cliente.query<{ id: string; barrio_id: string; manzana: string; lote: string }>(
    "select id, barrio_id, manzana, lote from unidad_funcional",
  );
  const etiquetaNueva = new Map(unidadesNuevas.map((u) => [u.id, claveDeUnidad(de(u.barrio_id), u.manzana, u.lote)]));
  await renumerar(
    cliente,
    { tabla: "plan_pago", columna: "id" },
    planes.map((p) => ({ viejo: p.id, nuevo: idFijo(`plan/${etiquetaNueva.get(p.unidad_funcional_id)!}/${p.n}`) })),
    { "plan_documento.plan_id": "storage_key" },
  );

  // Rendiciones: «talas/mes0/confirmada/1».
  const { rows: rendiciones } = await cliente.query<{ id: string; barrio_id: string; periodo: string; estado: string; n: string }>(
    `select id, barrio_id, periodo, estado,
            row_number() over (partition by barrio_id, periodo, estado order by created_at, id)::text as n
       from plan_rendicion`,
  );
  await renumerar(
    cliente,
    { tabla: "plan_rendicion", columna: "id" },
    rendiciones.map((r) => ({ viejo: r.id, nuevo: idFijo(`rendicion/${de(r.barrio_id)}/${mesRelativo(r.periodo, mesEnCurso)}/${r.estado}/${r.n}`) })),
    {
      "plan_rendicion.id": "documento_clave",
      "plan_rendicion_ingreso.rendicion_id": "comprobante_clave",
    },
  );
}
