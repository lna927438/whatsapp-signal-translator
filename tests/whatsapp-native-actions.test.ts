import {test} from 'node:test'
import assert from 'node:assert/strict'
import {rmSync} from 'node:fs'
import {mainHarness} from './main-harness.ts'
import {createRequire} from 'node:module'
const {equivalentDisplayText,wrongTargetScript,reusableDisplayOriginal}=createRequire(import.meta.url)('../src/shared/translationResult.ts')

test('image, media, editing and link menu actions target the right account and guard unavailable media',()=>{
 const calls:any[]=[],h=mainHarness({clipboard:{writeText:(v:any)=>calls.push(['clipboard',v])},shell:{openExternal:async(v:any)=>calls.push(['open',v])}});
 const contents:any={isDestroyed:()=>false,copyImageAt:(x:number,y:number)=>calls.push(['image',x,y]),downloadURL:(url:string)=>calls.push(['download',url])};
 for(const action of ['copy','paste','pasteAndMatchStyle','cut','undo','redo','selectAll'])contents[action]=()=>calls.push([action]);
 const params={x:42,y:75,mediaType:'image',hasImageContents:true,srcURL:'blob:https://web.whatsapp.com/unique',linkURL:'',selectionText:'',isEditable:false,editFlags:{canCopy:true,canCut:true,canPaste:true,canUndo:true,canRedo:false,canSelectAll:true}};
 try{
  const {whatsAppContextMenu}=h.load('src/main/platforms/whatsapp/contextMenu.ts');
  const image=whatsAppContextMenu(contents,params);image[0].click();image[1].click();
  assert.deepEqual(calls,[['image',42,75],['download',params.srcURL]]);
  assert.equal(whatsAppContextMenu(contents,{...params,hasImageContents:false})[0].enabled,false);
  const menu=whatsAppContextMenu(contents,{...params,mediaType:'none',isEditable:true,linkURL:'https://example.org/page'});
  menu.find((m:any)=>m.label==='粘贴为纯文本').click();menu.find((m:any)=>m.label==='复制链接地址').click();
  assert.ok(calls.some(c=>c[0]==='pasteAndMatchStyle'));assert.ok(calls.some(c=>c[0]==='clipboard'));
  assert.equal(menu.find((m:any)=>m.label==='重做').enabled,false);
  assert.equal(whatsAppContextMenu(contents,{...params,mediaType:'none',linkURL:'file:///C:/private.txt'}).length,0);
  assert.equal(whatsAppContextMenu(contents,{...params,mediaType:'none',linkURL:'javascript:alert(1)'}).length,0);
  contents.isDestroyed=()=>true;const before=calls.length;image[0].click();assert.equal(calls.length,before);
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('display validation rejects untranslated sentences but permits proper nouns, literal data and genuine translations',()=>{
 assert.equal(equivalentDisplayText("You're very direct, George!",'You’re very direct, George！'),true);
 for(const text of ["You're very direct, George!",'Show me','What are you doing?'])assert.equal(wrongTargetScript(text,'zh-CN'),true,text);
 for(const text of ['George','Bank of America','HelloDog','https://example.com','👍','123.45','你很直接，George！'])assert.equal(wrongTargetScript(text,'zh-CN'),false,text);
 assert.equal(reusableDisplayOriginal('You are very direct','You are really direct','zh-CN'),false);
 assert.equal(reusableDisplayOriginal('你很直接','You are really direct','zh-CN'),true);
 assert.equal(wrongTargetScript('You are very direct','en-US'),false);
})
