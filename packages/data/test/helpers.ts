/**
 * Utilidades para los tests contra Postgres real.
 *
 * Tres conexiones, a propósito distintas:
 *  - `admin`  → DATABASE_URL      (dueño/superusuario local): SOLO para armar y limpiar fixtures.
 *  - `db`     → DATABASE_URL_APP  (rol `app_request_dev`, **sujeto a RLS**): lo que se está probando.
 *  - `job`    → DATABASE_URL_JOB  (rol `app_job`, BYPASSRLS): operaciones server-side.
 *
 * Si los tests armaran los fixtures con la conexión de app, no podrían crear el escenario "otro
 * barrio que no debería verse" — por eso el fixture se carga por fuera de la RLS.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { crearDbJob, crearDbRequest, type DbJob, type DbRequest } from "../src/client.ts";

export type Arbol = {
  /** Administrador "Estudio Pérez" (raíz). */
  adminA: { id: string; path: string };
  /** Barrio "Los Álamos" (de Estudio Pérez). */
  barrioA1: { id: string; path: string };
  /** Barrio "San Isidro" (de Estudio Pérez) — hermano de A1. */
  barrioA2: { id: string; path: string };
  /** Subsector "Náutica" dentro de Los Álamos. */
  subsectorA1: { id: string; path: string };
  /** Administrador "Otro Estudio" (raíz, sin relación con A). */
  adminB: { id: string; path: string };
  /** Barrio "Las Lomas" (de Otro Estudio). */
  barrioB1: { id: string; path: string };
  usuarios: {
    /** admin_barrio en el ADMINISTRADOR A → ve todos sus barrios. */
    adminEstudioA: string;
    /** admin_barrio solo en el barrio A1 → ve A1 y su subsector, nada más. */
    adminBarrioA1: string;
    /** operador en A1 → rol de gestión: lee el padrón y las expensas de A1, y opera. */
    operadorA1: string;
    /** contador en A1 → rol de gestión de SOLO LECTURA: lee, no escribe. */
    contadorA1: string;
    /** auditor en A1 → rol de gestión de SOLO LECTURA: lee, no escribe. */
    auditorA1: string;
    /**
     * propietario en A1 → desde 0018 **no lee ni una fila** de dominio ni de expensas: hace falta el
     * vínculo usuario→unidad, que todavía no existe (ADR-0002 §3.5).
     */
    propietarioA1: string;
    /** residente en A1 → mismo caso que `propietarioA1`: sin acceso. */
    residenteA1: string;
    /** admin_barrio en el administrador B → no ve nada de A. */
    adminEstudioB: string;
    /** membresía en A1 pero `activo = false` → no ve nada. */
    inactivoA1: string;
    /** sin ninguna membresía. */
    sinMembresia: string;
  };
  /** Ids creados, en orden de inserción (para borrarlos de hijo a padre al terminar). */
  creados: string[];
};

export function poolAdmin(): pg.Pool {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("Falta DATABASE_URL: los tests de base necesitan `pnpm db:up` y un .env");
  return new pg.Pool({ connectionString: url, max: 4 });
}

export function poolApp(): pg.Pool {
  const url = process.env["DATABASE_URL_APP"];
  if (!url) throw new Error("Falta DATABASE_URL_APP: correr `pnpm db:setup`");
  return new pg.Pool({ connectionString: url, max: 4 });
}

export function poolJob(): pg.Pool {
  const url = process.env["DATABASE_URL_JOB"];
  if (!url) throw new Error("Falta DATABASE_URL_JOB: correr `pnpm db:setup`");
  return new pg.Pool({ connectionString: url, max: 2 });
}

/** Conexión sujeta a RLS (rol `app_request_dev`): lo que se está probando. */
export function dbDe(pool: pg.Pool): DbRequest {
  return crearDbRequest(pool);
}

/** Conexión de jobs (BYPASSRLS): ve todos los barrios, no la acepta `conUsuario`. */
export function dbDeJob(pool: pg.Pool): DbJob {
  return crearDbJob(pool);
}


/**
 * Borra SOLO lo que creó este fixture (de hijo a padre; las membresías caen por cascada).
 * No vacía las tablas: así un archivo de test no puede pisarle el escenario a otro.
 */
export async function borrarArbol(admin: pg.Pool, arbol: Arbol): Promise<void> {
  const ids = arbol.creados;
  await admin.query("delete from tenant_grant where origen_id = any($1::uuid[]) or destino_id = any($1::uuid[])", [ids]);
  // Toda administración nace con sus parámetros de mora (trigger de `0057`), y esas filas apuntan
  // al nodo con `restrict`: se van antes que el árbol.
  await borrarParametrosDe(admin, ids);
  for (const id of [...ids].reverse()) {
    await admin.query("delete from tenant_node where id = $1", [id]);
  }
}

async function crearNodo(
  admin: pg.Pool,
  tipo: string,
  nombre: string,
  parentId: string | null,
): Promise<{ id: string; path: string }> {
  const { rows } = await admin.query<{ id: string; path: string }>(
    "insert into tenant_node (tipo, nombre, parent_id) values ($1, $2, $3) returning id, path",
    [tipo, nombre, parentId],
  );
  const fila = rows[0];
  if (!fila) throw new Error(`no se pudo crear el nodo ${nombre}`);
  return fila;
}

async function crearMembresia(
  admin: pg.Pool,
  userId: string,
  tenantNodeId: string,
  rol: string,
  activo = true,
): Promise<void> {
  await admin.query(
    "insert into membership (user_id, tenant_node_id, rol, activo) values ($1, $2, $3, $4)",
    [userId, tenantNodeId, rol, activo],
  );
}

/**
 * Árbol de prueba (el del doc 03 §A.1):
 *
 *   Estudio Pérez (A)            ├─ Otro Estudio (B)
 *    ├─ Los Álamos (A1)          │   └─ Las Lomas (B1)
 *    │    └─ Náutica (A1.sub)    │
 *    └─ San Isidro (A2)          │
 */
export async function crearArbol(admin: pg.Pool): Promise<Arbol> {
  const adminA = await crearNodo(admin, "administrador", "Estudio Pérez", null);
  const barrioA1 = await crearNodo(admin, "barrio", "Los Álamos", adminA.id);
  const barrioA2 = await crearNodo(admin, "barrio", "San Isidro", adminA.id);
  const subsectorA1 = await crearNodo(admin, "subsector", "Náutica interna", barrioA1.id);
  const adminB = await crearNodo(admin, "administrador", "Otro Estudio", null);
  const barrioB1 = await crearNodo(admin, "barrio", "Las Lomas", adminB.id);

  const usuarios = {
    adminEstudioA: randomUUID(),
    adminBarrioA1: randomUUID(),
    operadorA1: randomUUID(),
    contadorA1: randomUUID(),
    auditorA1: randomUUID(),
    propietarioA1: randomUUID(),
    residenteA1: randomUUID(),
    adminEstudioB: randomUUID(),
    inactivoA1: randomUUID(),
    sinMembresia: randomUUID(),
  };

  await crearMembresia(admin, usuarios.adminEstudioA, adminA.id, "admin_barrio");
  await crearMembresia(admin, usuarios.adminBarrioA1, barrioA1.id, "admin_barrio");
  await crearMembresia(admin, usuarios.operadorA1, barrioA1.id, "operador");
  await crearMembresia(admin, usuarios.contadorA1, barrioA1.id, "contador");
  await crearMembresia(admin, usuarios.auditorA1, barrioA1.id, "auditor");
  await crearMembresia(admin, usuarios.propietarioA1, barrioA1.id, "propietario");
  await crearMembresia(admin, usuarios.residenteA1, barrioA1.id, "residente");
  await crearMembresia(admin, usuarios.adminEstudioB, adminB.id, "admin_barrio");
  await crearMembresia(admin, usuarios.inactivoA1, barrioA1.id, "operador", false);

  const creados = [adminA, barrioA1, barrioA2, subsectorA1, adminB, barrioB1].map((n) => n.id);
  return { adminA, barrioA1, barrioA2, subsectorA1, adminB, barrioB1, usuarios, creados };
}

// ---------------------------------------------------------------------------------------------
// Padrón (dominio del barrio). Los fixtures se cargan con la conexión de admin, por fuera de la
// RLS: es la única forma de armar el escenario "otro barrio que no se tiene que ver".
// ---------------------------------------------------------------------------------------------

export type OpcionesBarrio = {
  figuraJuridica?: string;
  adecuadoArt2075?: string;
  encuadreUrbanistico?: string;
  municipio?: string;
  serviciosInternos?: string;
};

/** Da de alta los datos de dominio de un barrio sobre su nodo de tenancía. */
export async function crearBarrio(admin: pg.Pool, barrioId: string, opciones: OpcionesBarrio = {}): Promise<void> {
  await admin.query(
    `insert into barrio (barrio_id, figura_juridica, adecuado_art_2075, encuadre_urbanistico,
                         municipio, servicios_internos_a_cargo_de)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      barrioId,
      opciones.figuraJuridica ?? "ph_especial",
      opciones.adecuadoArt2075 ?? "en_tramite",
      opciones.encuadreUrbanistico ?? "ure",
      opciones.municipio ?? "villa-allende",
      opciones.serviciosInternos ?? "urbanizacion",
    ],
  );
}

/** Crea `cantidad` unidades correlativas (una de cada tres, baldía: el padrón las incluye igual). */
export async function crearUnidades(
  admin: pg.Pool,
  barrioId: string,
  cantidad: number,
  manzana = "1",
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= cantidad; i++) {
    const { rows } = await admin.query<{ id: string }>(
      `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
       values ($1, $2, $3, $4) returning id`,
      [barrioId, manzana, String(i), i % 3 === 0 ? "baldio" : "construido"],
    );
    const fila = rows[0];
    if (!fila) throw new Error("no se pudo crear la unidad");
    ids.push(fila.id);
  }
  return ids;
}

/** Versión de coeficientes con reparto uniforme que suma exactamente 1 (el resto va a la última). */
export async function crearCoeficientes(
  admin: pg.Pool,
  barrioId: string,
  unidades: readonly string[],
  base = "parte_indivisa",
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, $2, current_date) returning id`,
    [barrioId, base],
  );
  const version = rows[0];
  if (!version) throw new Error("no se pudo crear la versión de coeficientes");

  const parte = Math.floor(1_000_000_000 / unidades.length);
  let asignado = 0;
  for (const [i, unidadId] of unidades.entries()) {
    const bruto = i === unidades.length - 1 ? 1_000_000_000 - asignado : parte;
    asignado += parte;
    await admin.query(
      `insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1, $2, $3, $4)`,
      [barrioId, version.id, unidadId, (bruto / 1_000_000_000).toFixed(9)],
    );
  }
  return version.id;
}

/**
 * Borra las filas de parámetros de mora de unos nodos. Son append-only por trigger (`0057`), así que
 * se entra por la puerta de mantenimiento — modo réplica, solo superusuario, solo en tests — en una
 * conexión propia para que el modo no se filtre a otras consultas del pool.
 */
export async function borrarParametrosDe(admin: pg.Pool, nodos: readonly string[]): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    await c.query("delete from parametro_anulacion where nodo_id = any($1::uuid[])", [nodos]);
    await c.query("delete from parametro_valor where nodo_id = any($1::uuid[])", [nodos]);
    await c.query("delete from subida_respaldo_solicitada where nodo_id = any($1::uuid[])", [nodos]);
  } finally {
    await c.query("set session_replication_role = origin");
    c.release();
  }
}

/**
 * Carga un valor de parámetro sin pasar por `app.fijar_parametro` (que exige fecha ≥ hoy): para
 * armar un escenario con historia. Va como `carga = 'migrado'`, que es lo que es — un dato que no
 * cargó una persona.
 */
export async function cargarParametro(
  admin: pg.Pool,
  nodoId: string,
  clave: string,
  valor: unknown,
  desde = "2000-01-01",
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into parametro_valor (nodo_id, clave, valor, vigente_desde, motivo, carga)
     values ($1, $2, $3::jsonb, $4, 'Escenario de prueba', 'migrado') returning id`,
    [nodoId, clave, JSON.stringify(valor), desde],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no se pudo cargar el parámetro");
  return id;
}

/**
 * El comportamiento anterior a ADR-0006 para un barrio con tasa: «Cobra: Sí», esa tasa, sin gracia,
 * sin tolerancia, sin punitoria. Es lo que `0057` le deja a un barrio migrado.
 */
export async function cargarTasaComoAntes(admin: pg.Pool, barrioId: string, tasa: string, desde = "2000-01-01"): Promise<void> {
  await cargarParametro(admin, barrioId, "interes.cobra", true, desde);
  await cargarParametro(admin, barrioId, "interes.tasa_compensatoria", tasa, desde);
  await cargarParametro(admin, barrioId, "interes.tasa_punitoria", "0", desde);
  await cargarParametro(admin, barrioId, "interes.gracia_dias", 0, desde);
  await cargarParametro(admin, barrioId, "interes.tolerancia", "0.00", desde);
}

/** Saca las filas de una clave de un nodo (modo réplica): reproduce un nodo sin ese valor. */
export async function quitarParametro(admin: pg.Pool, nodoId: string, clave: string): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    await c.query(
      "delete from parametro_anulacion where fila_id in (select id from parametro_valor where nodo_id = $1 and clave = $2)",
      [nodoId, clave],
    );
    await c.query("delete from parametro_valor where nodo_id = $1 and clave = $2", [nodoId, clave]);
  } finally {
    await c.query("set session_replication_role = origin");
    c.release();
  }
}
