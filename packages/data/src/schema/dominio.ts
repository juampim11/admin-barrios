/**
 * Esquema de DOMINIO del barrio — padrón. Ver `docs/diseno/03-modelo-datos.md` §B y
 * `knowledge/cordoba/REQUISITOS-MODELO-DATOS.md` §1, §3 y §9.
 *
 * Todo lo de acá son **datos dentro de un barrio**, no nodos de tenancía: llevan `barrio_id`
 * (FK a `tenant_node`) y la RLS filtra por igualdad sobre esa columna.
 *
 * Reglas del dominio que el esquema hace cumplir (no quedan libradas a la app):
 *  - Los 5 ejes del barrio se **versionan**; la columna del barrio es un cache derivado.
 *  - Una unidad **baldía sigue integrando el padrón** (art. 2077).
 *  - Puede haber **varios obligados a la vez** por unidad, con histórico (arts. 2049/2050).
 *  - Un juego de coeficientes **no se cierra si no cuadra** (arts. 2046 inc. c, 2081).
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ADECUACIONES_2075,
  BASES_COEFICIENTE,
  EJES_BARRIO,
  ENCUADRES_URBANISTICOS,
  ESTADOS_UNIDAD,
  FIGURAS_JURIDICAS,
  SERVICIOS_INTERNOS,
  TIPOS_DOCUMENTO_BARRIO,
  TIPOS_OBLIGADO,
  TITULARIDADES_ESPACIOS_COMUNES,
} from "@admin-barrios/shared/barrio";
import { app, tenantNode } from "./tenancy.ts";

const comoEnum = (valores: readonly string[]) => [...valores] as [string, ...string[]];

export const figuraJuridica = app.enum("figura_juridica", comoEnum(FIGURAS_JURIDICAS));
export const adecuacion2075 = app.enum("adecuacion_2075", comoEnum(ADECUACIONES_2075));
export const encuadreUrbanistico = app.enum("encuadre_urbanistico", comoEnum(ENCUADRES_URBANISTICOS));
export const serviciosInternos = app.enum("servicios_internos", comoEnum(SERVICIOS_INTERNOS));
export const ejeBarrio = app.enum("eje_barrio", comoEnum(EJES_BARRIO));
export const titularidadEspaciosComunes = app.enum(
  "titularidad_espacios_comunes",
  comoEnum(TITULARIDADES_ESPACIOS_COMUNES),
);
export const estadoUnidad = app.enum("estado_unidad", comoEnum(ESTADOS_UNIDAD));
export const tipoObligado = app.enum("tipo_obligado", comoEnum(TIPOS_OBLIGADO));
export const baseCoeficiente = app.enum("base_coeficiente", comoEnum(BASES_COEFICIENTE));
export const tipoDocumentoBarrio = app.enum("tipo_documento_barrio", comoEnum(TIPOS_DOCUMENTO_BARRIO));

/**
 * Atributos de dominio del barrio. La fila **extiende** al nodo de tenancía de tipo `barrio`:
 * misma clave (`barrio_id` = `tenant_node.id`), así no hay dos identidades del mismo barrio.
 *
 * Las columnas de los 5 ejes son el **valor vigente** (lectura rápida y validada por enum); la
 * fuente de verdad histórica es `barrio_atributo_vigencia`, y un trigger las mantiene sincronizadas.
 */
export const barrio = pgTable(
  "barrio",
  {
    barrioId: uuid("barrio_id")
      .primaryKey()
      .references(() => tenantNode.id, { onDelete: "restrict" }),
    jurisdiccion: text("jurisdiccion").notNull().default("cordoba"),

    // --- Los 5 ejes (cache derivado de barrio_atributo_vigencia) ---
    figuraJuridica: figuraJuridica("figura_juridica").notNull(),
    adecuadoArt2075: adecuacion2075("adecuado_art_2075").notNull(),
    encuadreUrbanistico: encuadreUrbanistico("encuadre_urbanistico").notNull(),
    /** Slug del municipio (`knowledge/<juris>/municipal/<slug>`). No es enum: la lista crece. */
    municipio: text("municipio").notNull(),
    serviciosInternosACargoDe: serviciosInternos("servicios_internos_a_cargo_de").notNull(),

    titularidadEspaciosComunes: titularidadEspaciosComunes("titularidad_espacios_comunes"),
    /**
     * Cómo se llama el concepto que se cobra ("expensa", "cuota social", "aporte"). Se guarda por
     * barrio porque depende de la figura y del instrumento; el sistema sugiere solo donde hay fuente.
     */
    denominacionConcepto: text("denominacion_concepto"),

    // --- Hechos que pesan en la ejecutividad. NULL = "no informado" (no es lo mismo que "no"). ---
    reglamentoInscripto: boolean("reglamento_inscripto"),
    pactoEjecutividad: boolean("pacto_ejecutividad"),
    tieneEspaciosComunesExclusivos: boolean("tiene_espacios_comunes_exclusivos"),

    tieneConsejo: boolean("tiene_consejo").notNull().default(false),
    tieneFondoReserva: boolean("tiene_fondo_reserva").notNull().default(false),

    cuit: text("cuit"),
    domicilioSede: text("domicilio_sede"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_barrio_municipio").on(t.municipio),
    check("barrio_cuit_chk", sql`${t.cuit} is null or ${t.cuit} ~ '^[0-9]{11}$'`),
    check("barrio_municipio_chk", sql`${t.municipio} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

/**
 * Historial de vigencias de los 5 ejes: **la fuente de verdad**. Permite contestar "qué figura regía
 * en julio de 2024" para liquidar o encuadrar un acto con el valor de su momento.
 */
export const barrioAtributoVigencia = pgTable(
  "barrio_atributo_vigencia",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    eje: ejeBarrio("eje").notNull(),
    valor: text("valor").notNull(),
    vigenteDesde: date("vigente_desde", { mode: "string" }).notNull(),
    /** NULL = vigente hoy. Lo cierra el trigger cuando entra una vigencia posterior. */
    vigenteHasta: date("vigente_hasta", { mode: "string" }),
    /** Documento que respalda el cambio (acta, constancia de adecuación, ordenanza…). */
    documentoId: uuid("documento_id"),
    registradoPor: uuid("registrado_por"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_vigencia_barrio_eje").on(t.barrioId, t.eje),
    // Un solo valor abierto por eje: es lo que hace que "el vigente" no sea ambiguo.
    uniqueIndex("uq_vigencia_abierta").on(t.barrioId, t.eje).where(sql`vigente_hasta is null`),
    check("vigencia_rango_chk", sql`${t.vigenteHasta} is null or ${t.vigenteHasta} >= ${t.vigenteDesde}`),
  ],
);

/**
 * Unidad funcional. **Baldía o en construcción integra el padrón y genera expensas igual**
 * (art. 2077). `manzana`/`lote` son estructurados (exigencia de la IPJ), no dirección libre.
 */
export const unidadFuncional = pgTable(
  "unidad_funcional",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    manzana: text("manzana").notNull(),
    lote: text("lote").notNull(),
    nomenclaturaCatastral: text("nomenclatura_catastral"),
    estadoUnidad: estadoUnidad("estado_unidad").notNull(),
    superficieM2: numeric("superficie_m2", { precision: 12, scale: 2 }),
    /** Baja del padrón (unificación de lotes, error de carga). Nunca borrado físico. */
    bajaAt: timestamp("baja_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Manzana/lote es único DENTRO del barrio, no globalmente.
    uniqueIndex("uq_uf_barrio_manzana_lote").on(t.barrioId, t.manzana, t.lote),
    index("idx_uf_barrio").on(t.barrioId),
    index("idx_uf_barrio_activas").on(t.barrioId).where(sql`baja_at is null`),
  ],
);

/** Emails de contacto de la unidad (1..N) — a estos va la liquidación (distribución 1‑a‑1). */
export const unidadContacto = pgTable(
  "unidad_contacto",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    unidadFuncionalId: uuid("unidad_funcional_id")
      .notNull()
      .references(() => unidadFuncional.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    nombre: text("nombre"),
    principal: boolean("principal").notNull().default(false),
    activo: boolean("activo").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_contacto_uf_email").on(t.unidadFuncionalId, sql`lower(${t.email})`),
    index("idx_contacto_barrio").on(t.barrioId),
    check("contacto_email_chk", sql`${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`),
  ],
);

/** Persona (humana o jurídica) que responde por una o varias unidades. Contiene PII → RLS estricta. */
export const obligado = pgTable(
  "obligado",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    nombre: text("nombre").notNull(),
    esPersonaJuridica: boolean("es_persona_juridica").notNull().default(false),
    tipoDocumento: text("tipo_documento"),
    numeroDocumento: text("numero_documento"),
    cuitCuil: text("cuit_cuil"),
    email: text("email"),
    telefono: text("telefono"),
    domicilioNotificaciones: text("domicilio_notificaciones"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_obligado_barrio").on(t.barrioId),
    uniqueIndex("uq_obligado_barrio_cuit").on(t.barrioId, t.cuitCuil).where(sql`cuit_cuil is not null`),
    check("obligado_cuit_chk", sql`${t.cuitCuil} is null or ${t.cuitCuil} ~ '^[0-9]{11}$'`),
  ],
);

/**
 * Vínculo unidad ↔ obligado, con **histórico** y **varios simultáneos**: el propietario no se libera
 * porque haya un poseedor (art. 2050) y **la deuda no se reinicia** al cambiar de dueño (art. 2049)
 * — por eso la deuda cuelga de la unidad y este vínculo solo dice quién responde y desde cuándo.
 *
 * Se crea así desde el día uno aunque la UI del MVP cargue un solo obligado (doc 05, nota 6C).
 */
export const unidadObligado = pgTable(
  "unidad_obligado",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    unidadFuncionalId: uuid("unidad_funcional_id")
      .notNull()
      .references(() => unidadFuncional.id, { onDelete: "restrict" }),
    obligadoId: uuid("obligado_id")
      .notNull()
      .references(() => obligado.id, { onDelete: "restrict" }),
    tipo: tipoObligado("tipo").notNull(),
    desde: date("desde", { mode: "string" }).notNull(),
    /** NULL = vínculo vigente. */
    hasta: date("hasta", { mode: "string" }),
    /** Quién recibe la liquidación de esta unidad (puede haber uno solo a la vez). */
    esNotificado: boolean("es_notificado").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_unidad_obligado_uf").on(t.unidadFuncionalId),
    index("idx_unidad_obligado_barrio").on(t.barrioId),
    uniqueIndex("uq_unidad_obligado_vigente")
      .on(t.unidadFuncionalId, t.obligadoId, t.tipo)
      .where(sql`hasta is null`),
    uniqueIndex("uq_unidad_notificado").on(t.unidadFuncionalId).where(sql`hasta is null and es_notificado`),
    check("unidad_obligado_rango_chk", sql`${t.hasta} is null or ${t.hasta} >= ${t.desde}`),
  ],
);

/**
 * Juego de coeficientes con vigencia. Se **cierra** solo si cuadra (`app.validar_coeficientes`), y
 * una vez cerrado no se toca: si el reglamento cambia, se abre una versión nueva.
 */
export const coeficienteVersion = pgTable(
  "coeficiente_version",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    base: baseCoeficiente("base").notNull(),
    descripcion: text("descripcion"),
    vigenteDesde: date("vigente_desde", { mode: "string" }).notNull(),
    vigenteHasta: date("vigente_hasta", { mode: "string" }),
    documentoId: uuid("documento_id"),
    /** Solo una versión cerrada y abierta a la vez puede usarse para liquidar. */
    cerrada: boolean("cerrada").notNull().default(false),
    cerradaAt: timestamp("cerrada_at", { withTimezone: true }),
    cerradaPor: uuid("cerrada_por"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_coef_version_barrio").on(t.barrioId),
    uniqueIndex("uq_coef_version_vigente").on(t.barrioId).where(sql`cerrada and vigente_hasta is null`),
    check("coef_version_rango_chk", sql`${t.vigenteHasta} is null or ${t.vigenteHasta} >= ${t.vigenteDesde}`),
  ],
);

/** Coeficiente de una unidad dentro de una versión. 9 decimales: prorrateos finos sin redondeo previo. */
export const coeficiente = pgTable(
  "coeficiente",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => coeficienteVersion.id, { onDelete: "cascade" }),
    unidadFuncionalId: uuid("unidad_funcional_id")
      .notNull()
      .references(() => unidadFuncional.id, { onDelete: "restrict" }),
    valor: numeric("valor", { precision: 18, scale: 9 }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_coeficiente_version_uf").on(t.versionId, t.unidadFuncionalId),
    index("idx_coeficiente_barrio").on(t.barrioId),
    check("coeficiente_positivo_chk", sql`${t.valor} > 0`),
  ],
);

/** Documentos del barrio como dato de primera clase (`REQUISITOS §9`), no adjuntos sueltos. */
export const documentoBarrio = pgTable(
  "documento_barrio",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    tipo: tipoDocumentoBarrio("tipo").notNull(),
    titulo: text("titulo").notNull(),
    /** Clave en `ObjectStorage` (S3/MinIO). El archivo nunca se guarda en la base. */
    storageKey: text("storage_key"),
    fechaDocumento: date("fecha_documento", { mode: "string" }),
    inscripto: boolean("inscripto"),
    notas: text("notas"),
    subidoPor: uuid("subido_por"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_documento_barrio").on(t.barrioId, t.tipo)],
);

/**
 * Mandato de administración: el vínculo administrador↔barrio **no es permanente** — se designa y se
 * remueve por asamblea (arts. 2065/2066), así que se versiona y se ata al acta (`REQUISITOS §2`).
 */
export const mandatoAdministracion = pgTable(
  "mandato_administracion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    administradorId: uuid("administrador_id")
      .notNull()
      .references(() => tenantNode.id, { onDelete: "restrict" }),
    desde: date("desde", { mode: "string" }).notNull(),
    hasta: date("hasta", { mode: "string" }),
    actaDocumentoId: uuid("acta_documento_id").references(() => documentoBarrio.id, { onDelete: "set null" }),
    notas: text("notas"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_mandato_barrio").on(t.barrioId),
    uniqueIndex("uq_mandato_vigente").on(t.barrioId).where(sql`hasta is null`),
    check("mandato_rango_chk", sql`${t.hasta} is null or ${t.hasta} >= ${t.desde}`),
  ],
);

export type BarrioRow = typeof barrio.$inferSelect;
export type UnidadFuncionalRow = typeof unidadFuncional.$inferSelect;
export type ObligadoRow = typeof obligado.$inferSelect;
export type UnidadObligadoRow = typeof unidadObligado.$inferSelect;
export type CoeficienteVersionRow = typeof coeficienteVersion.$inferSelect;
export type CoeficienteRow = typeof coeficiente.$inferSelect;
export type DocumentoBarrioRow = typeof documentoBarrio.$inferSelect;
export type MandatoAdministracionRow = typeof mandatoAdministracion.$inferSelect;
