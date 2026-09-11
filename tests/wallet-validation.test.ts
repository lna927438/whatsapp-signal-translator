import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const {checkedWalletState}=createRequire(import.meta.url)('../src/renderer/src/lib/cloudApi.ts')
test('wallet display accepts confirmed integer characters and rejects missing, fractional or corrupt counters',()=>{
 const state={wallet:{balance:100,lifetime_debited:12,lifetime_credited:112}}
 assert.equal(checkedWalletState(state),state)
 for(const value of [null,undefined,'100',NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
  for(const key of ['balance','lifetime_debited','lifetime_credited']) assert.throws(()=>checkedWalletState({wallet:{...state.wallet,[key]:value}}),/校验/)
 }
 assert.throws(()=>checkedWalletState({}),/校验/)
})
