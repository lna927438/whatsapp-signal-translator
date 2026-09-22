import {test} from 'node:test'
import assert from 'node:assert/strict'
import {providerCapabilities,providerPlan,requestProviderPlan,type ProviderEnv} from '../server/worker/src/providerConfig.ts'

const USER='10000000-0000-4000-8000-000000000001',OTHER='10000000-0000-4000-8000-000000000002'
const env:ProviderEnv={TRANSLATION_PROVIDER:'deepseek',TRANSLATION_SELECTABLE_PROVIDERS:'deepseek,openai',
  OPENAI_API_KEY:'synthetic-openai',DEEPSEEK_API_KEY:'synthetic-deepseek'}

test('an omitted trial setting retains existing public capabilities and routing',()=>{
  assert.deepEqual(providerCapabilities(env).translationProviders,['deepseek','openai'])
  assert.deepEqual(requestProviderPlan(env,'openai').map(row=>row.provider),['openai'])
})

test('trial UUIDs are exact account identities, with whitespace and case normalized',()=>{
  const value={...env,OPENAI_TRIAL_USER_IDS:' '+USER.toUpperCase()+' , '+USER+' '}
  assert.deepEqual(providerCapabilities(value,USER).translationProviders,['deepseek','openai'])
  for(const identity of [undefined,OTHER,USER.slice(0,-1),USER+'x','']) {
    assert.deepEqual(providerCapabilities(value,identity).translationProviders,['deepseek'])
    assert.throws(()=>requestProviderPlan(value,'openai',identity),/provider_not_available/)
  }
})

test('present but empty, oversized or malformed trial settings fail closed without disabling DeepSeek',()=>{
  for(const setting of ['', ' ', '*', USER+',', USER+',bad', '"'+USER+'"', Array(102).fill(USER).join(','), 'x'.repeat(10001)]) {
    const value={...env,OPENAI_TRIAL_USER_IDS:setting}
    assert.deepEqual(providerCapabilities(value,USER).translationProviders,['deepseek'])
    assert.throws(()=>requestProviderPlan(value,'openai',USER),/provider_not_available/)
    assert.deepEqual(requestProviderPlan(value,'deepseek',USER).map(row=>row.provider),['deepseek'])
  }
})

test('both primary and implicit backup plans apply the same trial boundary',()=>{
  for(const [primary,backup] of [['openai','deepseek'],['deepseek','openai']]) {
    const value={...env,OPENAI_TRIAL_USER_IDS:USER,TRANSLATION_PROVIDER:primary,TRANSLATION_FALLBACK_PROVIDER:backup}
    assert.deepEqual(providerPlan(value,USER).map(row=>row.provider),[primary,backup])
    assert.deepEqual(providerPlan(value,OTHER).map(row=>row.provider),['deepseek'])
    assert.deepEqual(providerPlan(value).map(row=>row.provider),['deepseek'])
  }
})
