-- =====================================================================
-- SR GESTORÍA · Actualización v1.1: CUENTAS CORRIENTES (fiado y cobros) y PAGO DIVIDIDO
-- Desarrollo: JMM Gestiones & Tecnología · Jorge Matías Maldonado
--
-- Cómo usarlo: SQL Editor → New query → pegar todo → Run.
-- No borra ni cambia nada de lo ya cargado. Se puede correr más de una vez.
--
-- Qué agrega:
--   · clientes_cc: los clientes que llevan fiado (nombre y teléfono).
--     Sólo los ve el comercio dueño. La administración NO ve los nombres.
--   · Ventas con medio "cta_cte" (fiado, cuentan como venta del día).
--   · Movimientos de tipo "cobro" (pago total o parcial de una deuda).
--   · sr_saldos_cc(): total adeudado por comercio (sin nombres) para la Mesa.
--   · Pago dividido: una venta pagada con varios medios (parte efectivo, parte
--     transferencia, parte fiado…) se guarda en partes con el mismo "grupo".
-- =====================================================================

-- ---------- Clientes de cuenta corriente ----------
create table if not exists public.clientes_cc (
  id          uuid primary key default gen_random_uuid(),   -- lo puede generar el celular (carga sin señal)
  comercio_id uuid not null references public.comercios (id),
  nombre      text not null check (length(btrim(nombre)) > 0),
  telefono    text,
  activo      boolean not null default true,
  creado      timestamptz not null default now(),
  creado_por  uuid default auth.uid()
);
create index if not exists clientes_cc_comercio_idx on public.clientes_cc (comercio_id);

-- ---------- Movimientos: cliente, tipo "cobro" y medio "cta_cte" ----------
alter table public.movimientos add column if not exists cliente_id uuid references public.clientes_cc (id);
create index if not exists mov_cliente_idx on public.movimientos (cliente_id) where cliente_id is not null;

alter table public.movimientos drop constraint if exists movimientos_tipo_check;
alter table public.movimientos add  constraint movimientos_tipo_check  check (tipo in ('venta', 'gasto', 'cobro'));
alter table public.movimientos drop constraint if exists movimientos_medio_check;
alter table public.movimientos add  constraint movimientos_medio_check check (medio in ('efectivo', 'transferencia', 'debito', 'credito', 'qr', 'cta_cte'));
alter table public.movimientos drop constraint if exists mov_gasto_categoria;
alter table public.movimientos add  constraint mov_gasto_categoria     check (tipo <> 'gasto' or categoria is not null);
alter table public.movimientos drop constraint if exists mov_venta_sin_categoria;
alter table public.movimientos add  constraint mov_venta_sin_categoria check (tipo = 'gasto' or categoria is null);
alter table public.movimientos drop constraint if exists mov_cta_cte;
alter table public.movimientos add  constraint mov_cta_cte check (medio <> 'cta_cte' or (tipo = 'venta' and cliente_id is not null and cuenta_id is null));
alter table public.movimientos drop constraint if exists mov_cobro;
alter table public.movimientos add  constraint mov_cobro   check (tipo <> 'cobro' or (cliente_id is not null and medio <> 'cta_cte'));
alter table public.movimientos drop constraint if exists mov_cliente_solo_cc;
alter table public.movimientos add  constraint mov_cliente_solo_cc check (cliente_id is null or medio = 'cta_cte' or tipo = 'cobro');

-- ---------- Pago dividido: las partes de una misma venta comparten "grupo" ----------
alter table public.movimientos add column if not exists grupo text;
create index if not exists mov_grupo_idx on public.movimientos (grupo) where grupo is not null;
alter table public.movimientos drop constraint if exists mov_grupo_solo_ventas;
alter table public.movimientos add  constraint mov_grupo_solo_ventas check (grupo is null or tipo = 'venta');

-- ---------- Reglas automáticas (reemplazan a las anteriores) ----------
create or replace function public.sr_mov_validar(m public.movimientos) returns public.movimientos
language plpgsql security definer set search_path = public as $$
begin
  if m.medio in ('efectivo', 'cta_cte') then m.cuenta_id := null; end if;
  if m.tipo <> 'gasto' then m.categoria := null; end if;
  if not (m.medio = 'cta_cte' or m.tipo = 'cobro') then m.cliente_id := null; end if;
  if m.tipo in ('venta', 'cobro') and m.medio not in ('efectivo', 'cta_cte') and m.cuenta_id is null then
    raise exception 'Falta la cuenta de destino';
  end if;
  if m.cuenta_id is not null and not exists
     (select 1 from public.cuentas where id = m.cuenta_id and comercio_id = m.comercio_id) then
    raise exception 'La cuenta no pertenece a este comercio';
  end if;
  if (m.medio = 'cta_cte' or m.tipo = 'cobro') then
    if m.cliente_id is null then raise exception 'Falta elegir el cliente de la cuenta corriente'; end if;
    if not exists (select 1 from public.clientes_cc where id = m.cliente_id and comercio_id = m.comercio_id) then
      raise exception 'El cliente no pertenece a este comercio';
    end if;
  end if;
  return m;
end $$;

create or replace function public.sr_mov_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := public.sr_rol();
begin
  if r = 'comercio' then
    new.comercio_id := public.sr_comercio();
    new.anulado := false;
  elsif r <> 'admin' and auth.uid() is not null then
    raise exception 'Usuario sin permiso para cargar';
  end if;
  new.creado_por := auth.uid();
  new.actualizado_por := auth.uid();
  new.creado := now();
  new.actualizado := clock_timestamp();
  new := public.sr_mov_validar(new);
  return new;
end $$;

create or replace function public.sr_mov_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := public.sr_rol();
begin
  new.uid := old.uid;
  new.comercio_id := old.comercio_id;
  new.creado_por := old.creado_por;
  new.creado := old.creado;
  new.actualizado := clock_timestamp();
  new.actualizado_por := auth.uid();
  new := public.sr_mov_validar(new);
  if r = 'comercio' then
    if old.anulado and new.anulado then
      raise exception 'Este movimiento está anulado; sólo la administración puede modificarlo';
    end if;
    if old.anulado and not new.anulado then
      raise exception 'Sólo la administración puede reactivar un movimiento anulado';
    end if;
    if coalesce(btrim(new.motivo), '') = '' then
      raise exception 'Indicá el motivo de la corrección o anulación';
    end if;
  end if;
  return new;
end $$;

create or replace function public.sr_mov_registro() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r text := public.sr_rol();
  acc text;
  mail text := (select email from public.perfiles where user_id = auth.uid());
begin
  if (old.tipo, old.fecha, old.hora, old.monto, old.medio, old.cuenta_id, old.categoria, old.detalle, old.anulado, old.cliente_id, old.grupo)
     is not distinct from
     (new.tipo, new.fecha, new.hora, new.monto, new.medio, new.cuenta_id, new.categoria, new.detalle, new.anulado, new.cliente_id, new.grupo) then
    return new;
  end if;
  acc := case
    when new.anulado and not old.anulado then 'anulacion'
    when old.anulado and not new.anulado then 'reactivacion'
    else 'correccion' end;
  insert into public.historial (uid, comercio_id, accion, antes, despues, motivo, usuario, email, rol)
  values (new.uid, new.comercio_id, acc, to_jsonb(old), to_jsonb(new), new.motivo, auth.uid(), mail, r);
  if r = 'comercio' then
    insert into public.avisos (comercio_id, uid, accion, antes, despues, motivo, usuario, email)
    values (new.comercio_id, new.uid, acc, to_jsonb(old), to_jsonb(new), new.motivo, auth.uid(), mail);
  end if;
  return new;
end $$;

-- Un cliente siempre queda en el comercio de quien lo carga
create or replace function public.sr_cliente_cc() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.sr_rol() = 'comercio' then
    if tg_op = 'INSERT' then new.comercio_id := public.sr_comercio(); new.creado_por := auth.uid();
    else new.comercio_id := old.comercio_id; end if;
  end if;
  new.nombre := btrim(new.nombre);
  return new;
end $$;
drop trigger if exists sr_cliente_cc on public.clientes_cc;
create trigger sr_cliente_cc before insert or update on public.clientes_cc
  for each row execute function public.sr_cliente_cc();

-- ---------- Seguridad ----------
alter table public.clientes_cc enable row level security;
revoke all on public.clientes_cc from anon, authenticated;
grant select, insert, update on public.clientes_cc to authenticated;     -- sin DELETE: se archivan
drop policy if exists "sr ver"       on public.clientes_cc;
drop policy if exists "sr alta"      on public.clientes_cc;
drop policy if exists "sr modificar" on public.clientes_cc;
-- Sólo el comercio dueño ve los nombres de sus clientes (la administración ve únicamente totales)
create policy "sr ver" on public.clientes_cc for select to authenticated
  using (public.sr_rol() = 'comercio' and comercio_id = public.sr_comercio());
create policy "sr alta" on public.clientes_cc for insert to authenticated
  with check (public.sr_rol() = 'comercio' and comercio_id = public.sr_comercio());
create policy "sr modificar" on public.clientes_cc for update to authenticated
  using (public.sr_rol() = 'comercio' and comercio_id = public.sr_comercio())
  with check (public.sr_rol() = 'comercio' and comercio_id = public.sr_comercio());

-- ---------- Total adeudado por comercio (sin nombres) ----------
create or replace function public.sr_saldos_cc()
returns table (comercio_id uuid, fiado numeric, cobrado numeric, saldo numeric, clientes_con_deuda integer)
language sql stable security definer set search_path = public as $$
  with por_cliente as (
    select m.comercio_id, m.cliente_id,
           sum(case when m.tipo = 'venta' then m.monto else 0 end) as fiado,
           sum(case when m.tipo = 'cobro' then m.monto else 0 end) as cobrado
    from public.movimientos m
    where m.cliente_id is not null and not m.anulado
      and (public.sr_rol() = 'admin' or m.comercio_id = public.sr_comercio())
    group by m.comercio_id, m.cliente_id
  )
  select comercio_id, sum(fiado), sum(cobrado), sum(fiado - cobrado),
         count(*) filter (where fiado - cobrado > 0)::integer
  from por_cliente group by comercio_id;
$$;
revoke all on function public.sr_saldos_cc() from public, anon;
grant execute on function public.sr_saldos_cc() to authenticated;
revoke all on function public.sr_mov_validar(public.movimientos) from public, anon, authenticated;

-- Permisos para la función segura (sr-usuarios) sobre la tabla nueva
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Control
select 'clientes_cc' as tabla, count(*) from public.clientes_cc
union all select 'ventas fiadas', count(*) from public.movimientos where medio = 'cta_cte'
union all select 'cobros', count(*) from public.movimientos where tipo = 'cobro'
union all select 'partes de ventas divididas', count(*) from public.movimientos where grupo is not null;
