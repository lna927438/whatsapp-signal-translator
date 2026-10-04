import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const {checkedWalletState}=createRequire(import.meta.url)('../src/renderer/src/lib/cloudApi.ts')
test('wallet display accepts confirmed integer characters and rejects missing, fractional or corrupt counters',()=>{
 const state={wallet:{balance:100,lifetime_debited:12,lifetime_credited:112}}
 assert.equal(checkedWalletState(state),state)
 for(const value of [null,undefined,'',' ',true,false,'1.5','1e3','0x10','-1','Infinity','9007199254740992',NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
  for(const key of ['balance','lifetime_debited','lifetime_credited']) assert.throws(()=>checkedWalletState({wallet:{...state.wallet,[key]:value}}),/校验/)
 }
 assert.throws(()=>checkedWalletState({}),/校验/)
})

test('management reductions are a separate optional counter compatible with older snapshots',()=>{
 const state={wallet:{balance:75,lifetime_debited:0,lifetime_credited:100,lifetime_adjusted_down:25}}
 assert.equal(checkedWalletState(state),state)
 for(const value of [null,'',false,NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>checkedWalletState({wallet:{...state.wallet,lifetime_adjusted_down:value}}),/校验/)
})

test('confirmed zero balances and integer-string counters are accepted without inventing missing values',()=>{
 const zero={wallet:{balance:0,lifetime_debited:0,lifetime_credited:0}}
 assert.equal(checkedWalletState(zero),zero)
 const strings={profile:{username:'fixture'},wallet:{balance:'0',lifetime_debited:'125',lifetime_credited:'125',lifetime_adjusted_down:'0',updated_at:'fixture-date'}}
 const parsed=checkedWalletState(strings)
 assert.deepEqual(parsed,{profile:strings.profile,wallet:{balance:0,lifetime_debited:125,lifetime_credited:125,lifetime_adjusted_down:0,updated_at:'fixture-date'}})
 assert.equal(strings.wallet.balance,'0','parsing cannot mutate a shared response')
 assert.equal(checkedWalletState({wallet:{balance:'9007199254740991',lifetime_debited:'0',lifetime_credited:'9007199254740991'}}).wallet.balance,Number.MAX_SAFE_INTEGER)
 for(const wallet of [null,undefined,[],{}, {balance:0}])assert.throws(()=>checkedWalletState({wallet}),/校验/)
})
