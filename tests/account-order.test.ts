import test from 'node:test'
import assert from 'node:assert/strict'
import {mainHarness} from './main-harness.ts'
import {orderedAccounts,moveAccount} from '../src/shared/accountOrder.ts'

test('manual account order persists through reload without changing account settings or the other platform',async()=>{
 const h=mainHarness(),{AccountManager}=h.load('src/main/accounts/accountManager.ts'),accounts=new AccountManager()
 const a=await accounts.add('whatsapp','First',undefined,{pinned:true,contactLanguages:{}}),b=await accounts.add('whatsapp','Second'),s=await accounts.add('signal','Signal')
 const list=await accounts.reorder('whatsapp',[b.id,a.id])
 assert.deepEqual(orderedAccounts(list.filter((row:any)=>row.platform==='whatsapp')).map(row=>row.id),[b.id,a.id])
 const reloaded=new AccountManager(),saved=await reloaded.list()
 assert.deepEqual(orderedAccounts(saved.filter((row:any)=>row.platform==='whatsapp')).map(row=>row.id),[b.id,a.id])
 assert.equal(saved.find((row:any)=>row.id===a.id).pinned,true);assert.equal(saved.find((row:any)=>row.id===s.id).tabOrder,undefined)
 await Promise.all([reloaded.update(a.id,{label:'Renamed',note:'Retired note',caption:'Retired caption'}),reloaded.reorder('whatsapp',[a.id,b.id])])
 const again=await reloaded.list(),renamed=again.find((row:any)=>row.id===a.id)
 assert.equal(renamed.label,'Renamed');assert.equal(renamed.note,undefined);assert.equal(renamed.caption,undefined)
 assert.deepEqual(orderedAccounts(again.filter((row:any)=>row.platform==='whatsapp')).map(row=>row.id),[a.id,b.id])
 await reloaded.update(b.id,{pinned:true});assert.deepEqual(orderedAccounts((await reloaded.list()).filter((row:any)=>row.platform==='whatsapp')).map(row=>row.id),[b.id,a.id])
})

test('account reorder rejects stale, duplicate, foreign-platform and invalid inputs without losing accounts',async()=>{
 const h=mainHarness(),{AccountManager}=h.load('src/main/accounts/accountManager.ts'),accounts=new AccountManager()
 const a=await accounts.add('whatsapp','First'),b=await accounts.add('whatsapp','Second'),s=await accounts.add('signal','Signal')
 for(const ids of [[a.id],[a.id,a.id],[a.id,s.id],[a.id,'missing']])await assert.rejects(accounts.reorder('whatsapp',ids))
 await assert.rejects(accounts.reorder('invalid',[a.id,b.id]));await assert.rejects(accounts.reorder('whatsapp',null))
 assert.equal((await accounts.list()).length,3)
 assert.deepEqual(moveAccount(['a','b','c'],'a','c'),['b','c','a']);assert.deepEqual(moveAccount(['a','b'],'unknown','b'),['a','b'])
})
