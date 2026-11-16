/**
 * Mora y estudios jurídicos (`0091`, encargo E-a). **Nada de esto entra al cálculo de la plata**: la
 * deuda la calcula `deudaALaFecha` y la foto de la derivación la guarda como dato.
 *
 * Lo que Drizzle no modela (los triggers que exigen que el estudio trabaje en el barrio, que las
 * gestiones solo se agreguen, la RLS y `app.buscar_estudio_exacto`) vive en la migración SQL.
 */
import { sql } from "drizzle-orm";
import { boolean, date, index, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { barrio } from "./dominio.ts";
import { tenantNode } from "./tenancy.ts";

/** Un estudio jurídico: cuenta propia, no cuelga de ninguna administración. */
export const estudioJuridico = pgTable(
  "estudio_juridico",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    nombre: text("nombre").notNull(),
    /** 11 dígitos, sin guiones. Único entre todas las administraciones. */
    cuit: text("cuit").notNull(),
    creadoPor: uuid("creado_por").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("uq_estudio_juridico_cuit").on(t.cuit)],
);

/** Con qué estudios trabaja cada administración. */
export const estudioAdministracion = pgTable(
  "estudio_administracion",
  {
    estudioId: uuid("estudio_id")
      .notNull()
      .references(() => estudioJuridico.id, { onDelete: "restrict" }),
    administracionId: uuid("administracion_id")
      .notNull()
      .references(() => tenantNode.id, { onDelete: "restrict" }),
    correoAvisos: text("correo_avisos").notNull(),
    telefonoBoleta: text("telefono_boleta"),
    /** `cada_derivacion` | `cada_derivacion_y_resumen` | `solo_resumen`. */
    preferenciaAviso: text("preferencia_aviso").notNull().default("cada_derivacion"),
    activo: boolean("activo").notNull().default(true),
    vinculadoPor: uuid("vinculado_por").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.estudioId, t.administracionId] }),
    index("idx_estudio_administracion_admin").on(t.administracionId),
    index("idx_estudio_administracion_correo").on(t.correoAvisos),
  ],
);

/** Qué estudios trabajan en cada barrio; uno solo por defecto. */
export const estudioBarrio = pgTable(
  "estudio_barrio",
  {
    estudioId: uuid("estudio_id")
      .notNull()
      .references(() => estudioJuridico.id, { onDelete: "restrict" }),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    porDefecto: boolean("por_defecto").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.estudioId, t.barrioId] }),
    index("idx_estudio_barrio_barrio").on(t.barrioId),
    uniqueIndex("uq_estudio_barrio_por_defecto").on(t.barrioId).where(sql`por_defecto`),
  ],
);

/** El criterio general para proponer derivaciones y el texto base del aviso de la boleta. */
export const moraCriterioAdministracion = pgTable("mora_criterio_administracion", {
  administracionId: uuid("administracion_id")
    .primaryKey()
    .references(() => tenantNode.id, { onDelete: "restrict" }),
  meses: smallint("meses").notNull(),
  montoMinimo: numeric("monto_minimo", { precision: 14, scale: 2 }).notNull(),
  pedirIntimacion: boolean("pedir_intimacion").notNull().default(true),
  leyendaBoleta: text("leyenda_boleta").notNull(),
  cargadoPor: uuid("cargado_por").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** El criterio y el aviso propios de un barrio (null = los de la administración). */
export const moraBarrio = pgTable("mora_barrio", {
  barrioId: uuid("barrio_id")
    .primaryKey()
    .references(() => barrio.barrioId, { onDelete: "restrict" }),
  meses: smallint("meses"),
  montoMinimo: numeric("monto_minimo", { precision: 14, scale: 2 }),
  pedirIntimacion: boolean("pedir_intimacion"),
  leyendaBoleta: text("leyenda_boleta"),
  cargadoPor: uuid("cargado_por").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Una unidad derivada a un estudio; el retiro se escribe una vez. */
export const derivacion = pgTable(
  "derivacion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    unidadFuncionalId: uuid("unidad_funcional_id").notNull(),
    estudioId: uuid("estudio_id")
      .notNull()
      .references(() => estudioJuridico.id, { onDelete: "restrict" }),
    tandaId: uuid("tanda_id").notNull(),
    motivo: text("motivo").notNull(),
    nota: text("nota"),
    derivadaPor: uuid("derivada_por").notNull(),
    derivadaAt: timestamp("derivada_at", { withTimezone: true }).notNull().defaultNow(),
    retiroMotivo: text("retiro_motivo"),
    retiroNota: text("retiro_nota"),
    retiradaPor: uuid("retirada_por"),
    retiradaAt: timestamp("retirada_at", { withTimezone: true }),
  },
  (t) => [
    unique("uq_derivacion_id_barrio").on(t.id, t.barrioId),
    uniqueIndex("uq_derivacion_vigente").on(t.unidadFuncionalId).where(sql`retirada_at is null`),
    index("idx_derivacion_barrio").on(t.barrioId, t.derivadaAt.desc()),
    index("idx_derivacion_estudio").on(t.estudioId).where(sql`retirada_at is null`),
  ],
);

/** La deuda mes por mes al derivar (`FotoDeDerivacion` en el servicio). Inmutable. */
export const derivacionFoto = pgTable("derivacion_foto", {
  derivacionId: uuid("derivacion_id").primaryKey(),
  barrioId: uuid("barrio_id")
    .notNull()
    .references(() => barrio.barrioId, { onDelete: "restrict" }),
  foto: jsonb("foto").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Una gestión de cobranza (Aclade `gestiones`). Solo se agregan filas. */
export const gestion = pgTable(
  "gestion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    unidadFuncionalId: uuid("unidad_funcional_id").notNull(),
    /** `administracion` | `estudio`. */
    autorTipo: text("autor_tipo").notNull(),
    estudioId: uuid("estudio_id").references(() => estudioJuridico.id, { onDelete: "restrict" }),
    canal: text("canal").notNull(),
    resultado: text("resultado"),
    nota: text("nota"),
    fecha: date("fecha").notNull(),
    promesaFecha: date("promesa_fecha"),
    promesaMonto: numeric("promesa_monto", { precision: 14, scale: 2 }),
    adjuntoClave: text("adjunto_clave"),
    adjuntoSha256: text("adjunto_sha256"),
    adjuntoNombre: text("adjunto_nombre"),
    adjuntoTipo: text("adjunto_tipo"),
    derivacionId: uuid("derivacion_id"),
    registradoPor: uuid("registrado_por").notNull(),
    registradoAt: timestamp("registrado_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_gestion_id_barrio").on(t.id, t.barrioId),
    index("idx_gestion_unidad").on(t.unidadFuncionalId, t.registradoAt.desc()),
    index("idx_gestion_barrio").on(t.barrioId, t.registradoAt.desc()),
    index("idx_gestion_promesas").on(t.barrioId, t.promesaFecha).where(sql`promesa_fecha is not null`),
  ],
);

/** La anulación de una gestión: otra fila, con motivo. */
export const gestionAnulacion = pgTable(
  "gestion_anulacion",
  {
    gestionId: uuid("gestion_id").primaryKey(),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    autorTipo: text("autor_tipo").notNull(),
    motivo: text("motivo").notNull(),
    anuladaPor: uuid("anulada_por").notNull(),
    anuladaAt: timestamp("anulada_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_gestion_anulacion_barrio").on(t.barrioId)],
);
