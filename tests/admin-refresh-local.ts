// Development-only refresh of admin view/RPC definitions in an existing local preview.
// Preserves all sample rows and refuses paths outside this workspace's verification directory.
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve,relative,isAbsolute } from 'node:path'
const root=fileURLToPath(new URL('../verification/',import.meta.url))
const folder=resolve(root,process.argv[2]||'admin-preview-v1','data')
const rel=relative(root,folder)
if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Local verification directory required')
const db=new PGlite(folder)
try{
  const local=await db.query("select 1 from auth.users where email='owner@example.invalid' and id='20000000-0000-4000-8000-000000000001'")
  if(local.rows.length!==1)throw new Error('Not a HelloDog sample database')
  const sql=await readFile(new URL('../supabase/migrations/20260911153034_admin_console.sql',import.meta.url),'utf8')
  const functions=Array.from(sql.matchAll(/create function (?:public|translator_private)\.[\s\S]*?\$\$;/g),m=>m[0].replace('create function','create or replace function'))
  const view=sql.match(/create view translator_private\.admin_translation_rows[\s\S]*?from rows join public\.profiles p on p\.id=rows\.user_id;/)?.[0].replace('create view','create or replace view')
  if(functions.length!==3||!view)throw new Error('Unexpected migration structure')
  await db.transaction(async tx=>{await tx.exec(view);for(const fn of functions)await tx.exec(fn)})
  console.log('Local admin definitions refreshed; sample records preserved.')
}finally{await db.close()}
