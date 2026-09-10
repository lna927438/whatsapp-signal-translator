import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { database, reset, asRole, USER } from './fixture.ts'

let db: Awaited<ReturnType<typeof database>>
before(async () => { db = await database() })
beforeEach(async () => { await reset(db) })
after(async () => { await db?.close() })

test('all ten business tables deny destructive privileges to ordinary roles', async () => {
  const { rows } = await db.query<{ table_name: string; allowed: boolean }>(`
    select c.relname as table_name,
      has_table_privilege('authenticated',c.oid,'TRUNCATE,TRIGGER,REFERENCES') or
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') as allowed
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'
  `)
  assert.equal(rows.length, 10)
  assert.ok(rows.every(r => !r.allowed))
  await assert.rejects(asRole(db, 'authenticated', 'truncate public.wallets'), /permission denied/)
})

test('users can read their own rows and edit only the three self-service profile fields', async () => {
  const result = await asRole<{ id: string }>(db, 'authenticated', 'select id from public.profiles')
  assert.deepEqual(result.rows, [{ id: USER }])
  await asRole(db, 'authenticated', "update public.profiles set username='renamed',display_name='Test',avatar_url='https://example.invalid/a'")
  for (const field of ['status','plan_code','email']) {
    await assert.rejects(asRole(db, 'authenticated', `update public.profiles set ${field}='changed'`), /permission denied/)
  }
  await assert.rejects(asRole(db, 'authenticated', 'update public.wallets set balance=999999'), /permission denied/)
  await assert.rejects(asRole(db, 'anon', 'select * from public.profiles'), /permission denied/)
})

test('ordinary roles cannot execute privileged RPCs or read replayed translations', async () => {
  const result = await db.query<{ name: string; allowed: boolean }>(`
    select p.proname as name,
      has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') as allowed
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('begin_translation','complete_translation','fail_translation',
      'consume_characters','credit_characters','handle_new_user','sync_profile_email_from_auth','set_updated_at')
  `)
  assert.equal(result.rows.length,8)
  assert.ok(result.rows.every(r => !r.allowed))
  await assert.rejects(asRole(db, 'authenticated', 'select * from translator_private.translation_requests'), /permission denied/)
  await assert.rejects(asRole(db, 'authenticated', "select public.consume_characters($1,1,'attempt')", [USER]), /permission denied/)
})
