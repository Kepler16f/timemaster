-- 只提供数据库健康状态与服务端时间；不访问用户、日程或邮件，不写任何业务数据。
begin;

create or replace function public.reunion_healthcheck()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'ok', true,
    'checked_at', pg_catalog.statement_timestamp()
  );
$$;

revoke all on function public.reunion_healthcheck() from public;
grant execute on function public.reunion_healthcheck() to anon, authenticated;
comment on function public.reunion_healthcheck() is 'Reunion read-only uptime probe; exposes no user data';
notify pgrst, 'reload schema';

commit;
