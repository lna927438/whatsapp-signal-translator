const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),{parse}=require('vue/compiler-sfc'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),exportsUi={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'src/shared/uiEnglish.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:exportsUi});
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'src/shared/uiEnglishExtra.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:exportsUi});
const catalog={...exportsUi.uiEnglish,...exportsUi.uiEnglishExtra},missing=new Set(),rawText=[];
function source(text,file){
 const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 function walk(node){if(ts.isCallExpression(node)&&node.expression.getText(ast)==='t'&&ts.isStringLiteral(node.arguments[0])) {const key=node.arguments[0].text;if(catalog[key]===undefined)missing.add(key);}
 ts.forEachChild(node,walk);}
 walk(ast);
}
for(const file of fs.readdirSync(path.join(root,'src/renderer/src/components')).filter(f=>f.endsWith('.vue')).map(f=>'src/renderer/src/components/'+f).concat(['src/renderer/src/App.vue','src/renderer/src/Root.vue','src/main/index.ts','src/main/desktopRuntime.ts','src/main/ipc.ts','src/main/reliabilityIpc.ts'])){
 const content=fs.readFileSync(path.join(root,file),'utf8');
 if(file.endsWith('.vue')){const d=parse(content).descriptor;if(d.scriptSetup)source(d.scriptSetup.content,file);
 if(file.endsWith('ChatHelp.vue')||file.endsWith('UiLanguagePicker.vue'))continue;
 function walk(node){if(node.type===2&&/\p{Script=Han}/u.test(node.content))rawText.push({file,text:node.content});
 if(node.type===5)source(node.content.content,file);
 for(const prop of node.props||[]){if(prop.type===7&&prop.exp)source(prop.exp.content,file);if(prop.type===6&&prop.value&&/\p{Script=Han}/u.test(prop.value.content)&&!['Language / 语言'].includes(prop.value.content))rawText.push({file,text:prop.value.content});}
 for(const child of node.children||[])walk(child);}
 if(d.template)walk(d.template.ast);
 }else source(content,file);
}
const report=path.resolve(process.argv[2]||path.join(root,'verification/release-0.5.3/locale-audit.json'));
fs.mkdirSync(path.dirname(report),{recursive:true});
fs.writeFileSync(report,JSON.stringify({catalogSize:Object.keys(catalog).length,missing:[...missing],rawText},null,2));
console.log(JSON.stringify({missing:[...missing],rawText},null,2));
if(missing.size||rawText.length)process.exitCode=1;
