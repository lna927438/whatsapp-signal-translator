import { PGlite } from '@electric-sql/pglite'
import { readdir, readFile } from 'node:fs/promises'

export const USER = '10000000-0000-4000-8000-000000000001'
export const OTHER = '10000000-0000-4000-8000-000000000002'

export async function database() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    grant usage on schema auth to authenticated, service_role;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `)
  const directory = new URL('../supabase/migrations/', import.meta.url)
  for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
    // gen_random_uuid is built into PostgreSQL. The historical migration's only
    // pgcrypto dependency is that function; PGlite does not bundle pgcrypto.
    const sql = (await readFile(new URL(name, directory), 'utf8')).replace('create extension if not exists pgcrypto;', '')
    await db.transaction(tx => tx.exec(sql))
  }
  return db
}

export async function reset(db: PGlite) {
  await db.exec('delete from auth.users')
  await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [USER, 'first@example.invalid', OTHER, 'second@example.invalid'])
  await db.exec('update public.wallets set balance = 100, lifetime_credited = 100')
}

export async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated' | 'service_role', query: string, values: unknown[] = [], user = USER) {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${role}`)
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user])
    return tx.query<T>(query, values)
  })
}

const signatures: Record<string, string[]> = {
  begin_translation: ['p_user_id','p_request_id','p_payload_hash','p_characters','p_claim_token','p_metadata'],
  complete_translation: ['p_user_id','p_request_id','p_claim_token','p_translation','p_model','p_latency_ms'],
  fail_translation: ['p_user_id','p_request_id','p_claim_token','p_error_code']
}

export async function rpc(db: PGlite, name: string, args: Record<string, unknown>) {
  const params = signatures[name]
  if (!params) throw new Error('Unexpected RPC')
  const result = await asRole<{ result: any }>(db, 'service_role',
    `select public.${name}(${params.map((_,i) => '$'+(i+1)).join(',')}) as result`,
    params.map(p => typeof args[p] === 'object' ? JSON.stringify(args[p]) : args[p]))
  return result.rows[0].result
}

export async function wallet(db: PGlite, user = USER) {
  return (await db.query<{ balance: number; reserved_characters: number; lifetime_debited: number }>(
    'select balance::integer, reserved_characters::integer, lifetime_debited::integer from public.wallets where user_id=$1', [user])).rows[0]
}
