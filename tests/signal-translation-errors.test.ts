import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {createRequire} from 'node:module'
import ts from 'typescript'
const require=createRequire(import.meta.url)
const {signalTranslationErrorMessage:safe,signalTranslationErrorFallback:fallback}=require('../src/main/platforms/signal/signalTranslationErrors.ts') as typeof import('../src/main/platforms/signal/signalTranslationErrors.ts')
const {translationFailureMessage,quarantinedTranslationMessage}=require('../src/main/translation/providers/cloudflare.ts') as typeof import('../src/main/translation/providers/cloudflare.ts')
const {validateTranslation}=require('../src/main/translation/translationValidation.ts') as typeof import('../src/main/translation/translationValidation.ts')
const {SessionUnavailableError}=require('../src/main/network/sessionRefresh.ts') as typeof import('../src/main/network/sessionRefresh.ts')

test('native Signal preserves every current fixed provider failure category and free-correction guidance',()=>{
  for(const code of ['translation_failed','translation_outcome_unknown','provider_auth','provider_quota','provider_rate_limit','provider_model','provider_permission','provider_request','provider_timeout','provider_unavailable','provider_empty','protected_literal_mismatch','provider_wrong_language','provider_not_translation']){
    const message=translationFailureMessage(code);assert.equal(safe(new Error(message)),message);
  }
  assert.equal(safe(new Error(quarantinedTranslationMessage)),quarantinedTranslationMessage);
})

test('native Signal preserves actual protected-literal validation and expired-session errors',()=>{
  let thrown:unknown;try{validateTranslation({text:'Open https://example.invalid/test',targetLanguage:'zh-CN'},'请打开')}catch(error){thrown=error}
  assert.ok(thrown instanceof Error);assert.match(safe(thrown),/链接、号码或术语不完整/);
  for(const message of ['登录会话已失效，请重新登录。草稿与翻译记录已保留。','在线登录状态已过期，请重新登录。','暂时无法恢复在线登录，请检查网络或重新登录。草稿已保留。'])assert.equal(safe(new SessionUnavailableError(message)),message);
})

test('unknown text, token, provider data, stack and forged known-prefix errors never cross the native boundary',()=>{
  const privateText='SYNTHETIC_PRIVATE_BODY',token='SYNTHETIC_SECRET_TOKEN',known=translationFailureMessage('provider_wrong_language');
  for(const error of [new Error(privateText+' '+token),new Error(known+' '+token),new Error(known+'\nstack '+privateText),{message:{toString:()=>token}},known,{name:'TranslationOutcomeError',code:'provider_wrong_language',message:privateText},null,undefined]){
    assert.equal(safe(error),fallback);assert.ok(!safe(error).includes(token));assert.ok(!safe(error).includes(privateText));
  }
  let evaluated=false;assert.equal(safe({get message(){evaluated=true;return token}}),fallback);assert.equal(evaluated,false);
  const approved=Object.assign(new Error(known),{stack:token,cause:privateText});assert.equal(safe(approved),known);
})

test('the actual host translation reply uses the safe classifier without serializing extra error fields',async()=>{
  const source=readFileSync(new URL('../src/main/platforms/signal/signalDesktopHost.ts',import.meta.url),'utf8');
  const begin=source.indexOf("      if(raw.type==='translate'"),end=source.indexOf("      if(raw.type==='conversation'",begin);assert.ok(begin>0&&end>begin);
  for(const message of [quarantinedTranslationMessage,translationFailureMessage('provider_wrong_language'),'SYNTHETIC_PRIVATE_BODY SYNTHETIC_SECRET_TOKEN']){
    const replies:any[]=[];
    const block=ts.transpileModule(`async function receive(raw:any){${source.slice(begin,end)}};exports.receive=receive`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    const exports:any={};runInNewContext(block,{exports,record:{id:'signal-fixture'},item:{startedAt:1},reply:(value:any)=>replies.push(value),signalTranslationErrorMessage:safe});
    await exports.receive.call({translate:async()=>{throw Object.assign(new Error(message),{stack:'SYNTHETIC_STACK',body:'SYNTHETIC_BODY'})}},
      {type:'translate',id:'bridge-fixture',request:{id:'message-fixture',conversationId:'conversation-fixture',direction:'outgoing',text:'synthetic input'}});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(replies.length,1);assert.equal(replies[0].error,safe(new Error(message)));
    assert.equal(JSON.stringify(replies).includes('SYNTHETIC_STACK'),false);assert.equal(JSON.stringify(replies).includes('SYNTHETIC_BODY'),false);
    assert.deepEqual(Object.keys(replies[0]).sort(),['error','id','type']);
  }
})
