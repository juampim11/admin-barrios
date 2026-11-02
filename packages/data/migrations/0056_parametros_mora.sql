-- =============================================================================================
-- 0056_parametros_mora — las formas de la mora configurable (tanda T1, ADR-0006).
--
-- LAS FORMAS ACÁ, LAS REGLAS EN `0057`, LO QUE SE VA EN `0058`. Mismo reparto que `0052`/`0053`.
--
-- Cuatro tablas nuevas y dos columnas en `liquidacion`. Lo que conviene retener de conjunto:
--
--   · **Una sola columna de nodo** (`nodo_id` → `tenant_node`), sea la administración o el barrio
--     (panel de arquitectura, CAMBIO 1). La administración de un barrio es su padre en la
--     tenancía y se resuelve al consultar: guardarla en cada fila del barrio sería una segunda
--     fuente de verdad que queda vieja el día que el barrio cambia de estudio.
--   · **Append-only**. Un valor no se edita ni se borra: se agrega uno nuevo con su fecha, o se
--     anula uno PROGRAMADO (todavía no rige) con una fila en `parametro_anulacion`.
--   · **`valor` NULL solo en el barrio**, y quiere decir "vuelve a heredar de la administración".
--   · **El respaldo** (de qué instrumento sale una tasa) es obligatorio al fijar o cambiar una tasa
--     — lo exige `app.fijar_parametro()` en `0057`, no un `check`: las filas de la carga inicial y
--     de la migración no lo tienen y no hay de dónde sacarlo.
-- =============================================================================================

CREATE TABLE "parametro_registro" (
	"clave" text PRIMARY KEY NOT NULL,
	"valor_inicial" jsonb NOT NULL,
	"requiere_respaldo" boolean NOT NULL,
	CONSTRAINT "parametro_registro_clave_chk" CHECK ("parametro_registro"."clave" ~ '^[a-z_]+\.[a-z_]+$')
);
--> statement-breakpoint

CREATE TABLE "parametro_valor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Orden de alta: con la misma vigencia gana la última creada.
	"orden" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
	"nodo_id" uuid NOT NULL,
	"clave" text NOT NULL,
	"valor" jsonb,
	"vigente_desde" date NOT NULL,
	"motivo" text NOT NULL,
	"carga" text DEFAULT 'usuario' NOT NULL,
	"respaldo_tipo" text,
	"respaldo_referencia" text,
	"respaldo_adjunto" text,
	"creado_por" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "uq_parametro_valor_orden" UNIQUE ("orden"),
	CONSTRAINT "parametro_valor_desde_chk" CHECK ("parametro_valor"."vigente_desde" between '2000-01-01' and '2200-12-31'),
	CONSTRAINT "parametro_valor_motivo_chk" CHECK (length(btrim("parametro_valor"."motivo")) between 1 and 500),
	CONSTRAINT "parametro_valor_carga_chk" CHECK ("parametro_valor"."carga" in ('usuario', 'inicial', 'migrado')),
	-- Quien cargó a mano queda firmado; la siembra y la migración no tienen persona.
	CONSTRAINT "parametro_valor_firma_chk" CHECK (("parametro_valor"."carga" = 'usuario') = ("parametro_valor"."creado_por" is not null)),
	CONSTRAINT "parametro_valor_respaldo_tipo_chk" CHECK ("parametro_valor"."respaldo_tipo" is null or "parametro_valor"."respaldo_tipo" in ('reglamento', 'acta_asamblea', 'acta_comision', 'otro')),
	-- Tipo y referencia viajan juntos; el adjunto es opcional pero nunca sin los otros dos.
	CONSTRAINT "parametro_valor_respaldo_par_chk" CHECK (("parametro_valor"."respaldo_tipo" is null) = ("parametro_valor"."respaldo_referencia" is null)),
	CONSTRAINT "parametro_valor_respaldo_adjunto_chk" CHECK ("parametro_valor"."respaldo_adjunto" is null or "parametro_valor"."respaldo_tipo" is not null),
	CONSTRAINT "parametro_valor_respaldo_referencia_chk" CHECK ("parametro_valor"."respaldo_referencia" is null or length(btrim("parametro_valor"."respaldo_referencia")) between 3 and 300),
	-- La clave del adjunto cuelga del propio nodo: un respaldo no puede apuntar al archivo de otro.
	CONSTRAINT "parametro_valor_respaldo_storage_key_chk" CHECK ("parametro_valor"."respaldo_adjunto" is null or "parametro_valor"."respaldo_adjunto" ~
          ('^(barrios|administraciones)/' || "parametro_valor"."nodo_id"::text || '/parametros/respaldos/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$'))
);
--> statement-breakpoint

CREATE TABLE "parametro_anulacion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fila_id" uuid NOT NULL,
	"nodo_id" uuid NOT NULL,
	"motivo" text NOT NULL,
	"anulado_por" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "uq_parametro_anulacion_fila" UNIQUE ("fila_id"),
	CONSTRAINT "parametro_anulacion_motivo_chk" CHECK (length(btrim("parametro_anulacion"."motivo")) between 1 and 500)
);
--> statement-breakpoint

-- Mismo patrón que `subida_comprobante_solicitada` (`0041`): la clave que se firma para subir queda
-- registrada ANTES de devolverse, así `fijar_parametro` puede exigir que el adjunto sea uno que se
-- pidió para este mismo nodo.
CREATE TABLE "subida_respaldo_solicitada" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nodo_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"solicitado_por" uuid NOT NULL,
	"solicitado_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subida_respaldo_content_type_chk" CHECK ("subida_respaldo_solicitada"."content_type" in ('application/pdf','image/jpeg','image/png')),
	CONSTRAINT "subida_respaldo_storage_key_chk" CHECK ("subida_respaldo_solicitada"."storage_key" ~
          ('^(barrios|administraciones)/' || "subida_respaldo_solicitada"."nodo_id"::text || '/parametros/respaldos/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$'))
);
--> statement-breakpoint

ALTER TABLE "parametro_valor" ADD CONSTRAINT "parametro_valor_nodo_id_tenant_node_id_fk" FOREIGN KEY ("nodo_id") REFERENCES "public"."tenant_node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parametro_valor" ADD CONSTRAINT "parametro_valor_clave_parametro_registro_clave_fk" FOREIGN KEY ("clave") REFERENCES "public"."parametro_registro"("clave") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parametro_anulacion" ADD CONSTRAINT "parametro_anulacion_fila_id_parametro_valor_id_fk" FOREIGN KEY ("fila_id") REFERENCES "public"."parametro_valor"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parametro_anulacion" ADD CONSTRAINT "parametro_anulacion_nodo_id_tenant_node_id_fk" FOREIGN KEY ("nodo_id") REFERENCES "public"."tenant_node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subida_respaldo_solicitada" ADD CONSTRAINT "subida_respaldo_solicitada_nodo_id_tenant_node_id_fk" FOREIGN KEY ("nodo_id") REFERENCES "public"."tenant_node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- La resolución: "la última fila del nodo para esta clave con vigente_desde ≤ fecha". A lo sumo dos
-- de estas por consulta (barrio y administración), cada una un `Limit` sobre este índice.
CREATE INDEX "idx_parametro_valor_resolver" ON "parametro_valor" USING btree ("nodo_id","clave","vigente_desde" DESC,"orden" DESC);--> statement-breakpoint
CREATE INDEX "idx_parametro_anulacion_nodo" ON "parametro_anulacion" USING btree ("nodo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subida_respaldo_storage_key" ON "subida_respaldo_solicitada" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "idx_subida_respaldo_nodo" ON "subida_respaldo_solicitada" USING btree ("nodo_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- `liquidacion`: «No se cobra» y los parámetros usados.
--
-- **«No se cobra» es interés NULL + `mora_no_se_cobra`, no `interes_mora = 0`** (decisión de la
-- tanda, ADR-0006 §5): "no se calculó porque la administración decidió no cobrar" no es lo mismo
-- que "se calculó y dio cero", y así ninguna cifra de dinero de las liquidaciones existentes ni de
-- sus tests cambia de valor — solo cambia la marca que explica el NULL.
--
-- **`parametros_mora` en la liquidación y no en el período** (ADR-0006 §5): la liquidación ya se
-- congela entera al emitir (`trg_liquidacion_editable`, `0005`), así que el registro de con qué se
-- calculó queda inmutable sin tocar la lista de columnas congeladas del período. Es la misma copia
-- en todas las unidades de un período, más el desglose compensatorio/punitorio de cada una. NULL =
-- liquidación anterior a esta tanda: lo usado está en `tasa_mora_aplicada`.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "liquidacion" ADD COLUMN "mora_no_se_cobra" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD COLUMN "parametros_mora" jsonb;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD CONSTRAINT "liquidacion_mora_estado_chk" CHECK (
  (not "liquidacion"."mora_pendiente_definicion" and not "liquidacion"."mora_no_se_cobra" and "liquidacion"."interes_mora" is not null)
  or ("liquidacion"."mora_pendiente_definicion" and not "liquidacion"."mora_no_se_cobra" and "liquidacion"."interes_mora" is null)
  or ("liquidacion"."mora_no_se_cobra" and not "liquidacion"."mora_pendiente_definicion" and "liquidacion"."interes_mora" is null
      and "liquidacion"."tasa_mora_aplicada" is null and "liquidacion"."dias_atraso" is null and "liquidacion"."parametros_mora" is not null)
);--> statement-breakpoint
ALTER TABLE "liquidacion" ADD CONSTRAINT "liquidacion_parametros_mora_chk" CHECK ("liquidacion"."parametros_mora" is null or jsonb_typeof("liquidacion"."parametros_mora") = 'object');--> statement-breakpoint
-- El check nuevo cubre los dos casos del viejo y suma el tercero. Primero el nuevo, después se va el
-- viejo: las filas existentes cumplen los dos.
ALTER TABLE "liquidacion" DROP CONSTRAINT "liquidacion_mora_chk";
