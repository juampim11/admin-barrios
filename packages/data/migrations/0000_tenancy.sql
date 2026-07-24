CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TYPE "app"."rol_membership" AS ENUM('admin_plataforma', 'admin_barrio', 'operador', 'contador', 'auditor', 'propietario', 'residente');--> statement-breakpoint
CREATE TYPE "app"."tipo_tenant" AS ENUM('administrador', 'barrio', 'subsector');--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_node_id" uuid NOT NULL,
	"rol" "app"."rol_membership" NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"origen_id" uuid NOT NULL,
	"destino_id" uuid NOT NULL,
	"alcance" text NOT NULL,
	"motivo" text NOT NULL,
	"otorgado_por" uuid NOT NULL,
	"vigente_desde" timestamp with time zone DEFAULT now() NOT NULL,
	"vigente_hasta" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_grant_distinto_chk" CHECK ("tenant_grant"."origen_id" <> "tenant_grant"."destino_id")
);
--> statement-breakpoint
CREATE TABLE "tenant_node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "tenant_node_nid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"parent_id" uuid,
	"tipo" "app"."tipo_tenant" NOT NULL,
	"nombre" text NOT NULL,
	"path" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_node_root_chk" CHECK (("tenant_node"."tipo" = 'administrador' and "tenant_node"."parent_id" is null) or ("tenant_node"."tipo" <> 'administrador' and "tenant_node"."parent_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_tenant_node_id_tenant_node_id_fk" FOREIGN KEY ("tenant_node_id") REFERENCES "public"."tenant_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_grant" ADD CONSTRAINT "tenant_grant_origen_id_tenant_node_id_fk" FOREIGN KEY ("origen_id") REFERENCES "public"."tenant_node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_grant" ADD CONSTRAINT "tenant_grant_destino_id_tenant_node_id_fk" FOREIGN KEY ("destino_id") REFERENCES "public"."tenant_node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_node" ADD CONSTRAINT "tenant_node_parent_id_tenant_node_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tenant_node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_membership_user_node_rol" ON "membership" USING btree ("user_id","tenant_node_id","rol");--> statement-breakpoint
CREATE INDEX "idx_membership_user_activo" ON "membership" USING btree ("user_id") WHERE activo;--> statement-breakpoint
CREATE INDEX "idx_membership_node" ON "membership" USING btree ("tenant_node_id");--> statement-breakpoint
CREATE INDEX "idx_tenant_grant_origen" ON "tenant_grant" USING btree ("origen_id");--> statement-breakpoint
CREATE INDEX "idx_tenant_grant_destino" ON "tenant_grant" USING btree ("destino_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tenant_node_nid" ON "tenant_node" USING btree ("nid");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tenant_node_path" ON "tenant_node" USING btree ("path");--> statement-breakpoint
CREATE INDEX "idx_tenant_node_path_prefix" ON "tenant_node" USING btree ("path" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "idx_tenant_node_parent" ON "tenant_node" USING btree ("parent_id");