-- 0076 — Quién abrió el período (encargo 14, BL-033 del titular).
--
-- `periodo_expensa` guardaba quién lo emitió (`emitida_por`, 0013) pero no quién lo abrió. La
-- columna la escribe la base al insertar, desde `app.current_user_id()`, igual que `emitida_por`:
-- quien inserta no la elige. Y no cambia después.
--
-- Solo DDL. Los períodos existentes quedan con `abierto_por` nulo —no se sabe quién los abrió— y
-- la pantalla no muestra autor. No se inventa uno. Si lo abrió solo `abrirMesEnCurso` al entrar
-- alguien, la pantalla lo dice así («Se abrió solo al entrar X») y no como una decisión de esa persona.
alter table periodo_expensa add column abierto_por uuid;
--> statement-breakpoint
comment on column periodo_expensa.abierto_por is
  'Quién abrió el período. La escribe trg_periodo_nace_en_borrador desde app.current_user_id(); nula en los abiertos antes de 0076.';
--> statement-breakpoint
create or replace function app.periodo_nace_en_borrador() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if new.estado <> 'borrador' then
    raise exception 'un período nace en borrador (llegó en %): emitir es una transición, no un estado inicial', new.estado;
  end if;
  -- Las marcas de emisión y distribución las pone la base al transicionar, no quien inserta.
  new.emitida_at := null;
  new.emitida_por := null;
  new.distribuida_at := null;
  -- Y la de apertura, la base al insertar (0076).
  new.abierto_por := app.current_user_id();
  return new;
end; $$;
--> statement-breakpoint
create or replace function app.periodo_abierto_por_fijo() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if new.abierto_por is distinct from old.abierto_por then
    raise exception 'quién abrió el período no se cambia';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_periodo_abierto_por_fijo before update of abierto_por on periodo_expensa
  for each row execute function app.periodo_abierto_por_fijo();
