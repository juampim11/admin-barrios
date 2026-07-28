-- =============================================================================================
-- 0019_usuario_demo — el elenco de la demo, y el ÚNICO candado del ADR-0002 §2.4 que aguanta solo.
--
-- QUÉ RESUELVE
-- El sustituto de desarrollo (`dev-suplantacion`) tiene que dejar entrar sin autenticación real, y
-- ese atajo no puede llegar nunca a producción. De las cuatro vueltas del candado (§2.4), tres son
-- de configuración o de CI: el gate por `APP_ENTORNO` vale lo que valga la variable, el chequeo de
-- `Host` se rodea con un header, y el test de imports existe para proteger al gate. La vuelta que
-- **no** depende de que nadie se haya acordado de nada es esta tabla:
--
--   en producción está VACÍA, así que no hay a quién suplantar.
--
-- Falla cerrado por DATOS, no por configuración. Lo peor que puede pasar es que nadie entre.
--
-- POR QUÉ NO UNA LISTA EN EL CÓDIGO NI UNA VARIABLE DE ENTORNO
-- Una lista en el código viaja adentro del contenedor. Una variable de entorno se puede setear. Una
-- fila que solo escribe el dueño del esquema —y el único que se conecta como dueño del esquema es el
-- seed, que a su vez se niega a correr con `APP_ENTORNO <> 'local'`— simplemente NO ESTÁ.
--
-- LA ÚNICA POLICY `using (true)` DE TODO EL ESQUEMA, Y POR QUÉ NO ES UN AGUJERO
-- Se lee SIN identidad porque es la pantalla de entrada: todavía no hay nadie, y preguntar por
-- `membership` requeriría `accessible_tenant_ids()`, que requiere identidad — el huevo y la gallina.
-- Que no sea un agujero descansa en cuatro cosas VERIFICABLES, no en este comentario:
--   (a) es la única policy permisiva con `qual = 'true'` del esquema;
--   (b) las columnas son exactamente las cinco de acá abajo, todas del elenco ficticio: ni PII real,
--       ni dinero, ni nada de un barrio;
--   (c) no hay grant de `insert`/`update`/`delete` para NINGÚN rol de la app — ni `app_request` ni
--       `app_job` (este último importa solo por el grant: con BYPASSRLS las policies ni se miran);
--   (d) en el arranque de la app, si `APP_ENTORNO <> 'local'` y la tabla tiene filas, el proceso
--       lanza (`apps/web/src/servidor/configuracion.ts`).
-- Las tres primeras son tests del proyecto `db` (`test/usuario-demo.test.ts`); la cuarta, un test
-- unitario. Es a propósito que sea "se verifica" y no "se argumenta".
--
-- Y NO se lee con la conexión `BYPASSRLS` para armar el login. Ni una vez, ni en desarrollo: eso es
-- exactamente el patrón que el ADR-0002 §3 prohíbe. Se lee con la MISMA conexión de request, sin
-- identidad puesta (`sinUsuario()`), que es una conexión sin privilegio, no una privilegiada.
--
-- Fuentes: docs/arquitectura/02-aplicacion-web-del-administrador.md §2.3, §2.4 y §3.1.
-- =============================================================================================

CREATE TABLE "usuario_demo" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"nombre" text NOT NULL,
	"descripcion" text NOT NULL,
	"creado_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usuario_demo_email_unique" UNIQUE("email")
);
--> statement-breakpoint

comment on table usuario_demo is
  'Elenco de la demo. La escribe SOLO el seed, con el rol dueño del esquema. En produccion esta '
  'vacia, y por eso el adapter dev-suplantacion no puede suplantar a nadie aunque alguien lo '
  'habilite. No es la tabla de usuarios de la plataforma: esa no existe todavia (ADR-0002 §2.5).';
--> statement-breakpoint

-- `force` además de `enable`: sin él, el dueño de la tabla saltea sus propias policies. Acá el
-- efecto práctico es chico (la policy de lectura es `true`), pero la regla del esquema es que TODA
-- tabla las lleve — la que se olvida del `force` es la que después se convierte en la excepción.
alter table usuario_demo enable row level security;
--> statement-breakpoint
alter table usuario_demo force row level security;
--> statement-breakpoint

-- Solo SELECT. No hay policy de insert/update/delete para nadie: aunque mañana alguien agregara el
-- grant por error, sin policy la escritura sigue rebotando (los dos controles son independientes).
create policy usuario_demo_sel on usuario_demo for select using (true);
--> statement-breakpoint

grant select on table usuario_demo to app_request;
--> statement-breakpoint

-- Deliberadamente NO se le da NADA a `app_job`. El worker no tiene ningún motivo para mirar el
-- elenco de la demo, y `app_job` tiene BYPASSRLS: para él, el único control que queda en pie es el
-- grant. Dejarlo en cero es lo que hace que el punto (c) de arriba sea verificable de verdad.
