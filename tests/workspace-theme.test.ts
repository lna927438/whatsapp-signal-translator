import test from 'node:test'
import assert from 'node:assert/strict'
import {mainHarness} from './main-harness.ts'

test('dark theme persists and exports without changing translation settings or leaking secrets',async()=>{
 const h=mainHarness(),{SettingsStore}=h.load('src/main/storage/settingsStore.ts'),{makeSettingsBackup,parseSettingsBackup}=h.load('src/main/storage/settingsBackup.ts')
 const store=new SettingsStore(),initial=await store.get()
 await store.save({...initial,workspaceTheme:'soft',deeplApiKey:'synthetic-private-key'})
 const saved=await new SettingsStore().get();assert.equal(saved.workspaceTheme,'soft');assert.equal(saved.receiveAutoTranslate,initial.receiveAutoTranslate)
 const backup=makeSettingsBackup(saved);assert.equal(backup.settings.workspaceTheme,'soft');assert.equal(JSON.stringify(backup).includes('synthetic-private-key'),false)
 assert.equal(parseSettingsBackup(JSON.stringify(backup)).settings.workspaceTheme,'soft')
 await assert.rejects(store.save({...saved,workspaceTheme:'invalid'}));assert.equal((await store.get()).workspaceTheme,'soft')
})
