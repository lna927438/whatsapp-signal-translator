import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mainHarness } from './main-harness.ts'
const require = createRequire(import.meta.url)
const { formatUi, formatUiError, resolveUiLanguage, normalizeUiPreference } = require('../src/shared/uiLocale.ts')

test('interface locale follows the OS only when requested and never changes inserted user text', () => {
  for (const system of ['zh-CN','zh-TW','zh-HK']) assert.equal(resolveUiLanguage('system',system),'zh-CN')
  for (const system of ['en-US','fr-FR','es-MX']) assert.equal(resolveUiLanguage('system',system),'en')
  assert.equal(resolveUiLanguage('en','zh-CN'),'en')
  assert.equal(resolveUiLanguage('zh-CN','en-US'),'zh-CN')
  assert.equal(normalizeUiPreference('invalid'),'system')
  const text = '用户 {1} <script> 🐶'
  assert.equal(formatUi('en','移除「{0}」？',text,'other'),'Remove “'+text+'”?')
  assert.equal(formatUi('zh-CN','移除「{0}」？',text,'other'),'移除「'+text+'」？')
  assert.equal(formatUi('en','unregistered diagnostic'),'unregistered diagnostic')
  assert.equal(formatUiError('en',"Error invoking remote method 'send:submit': Error: 翻译结果为空，草稿已保留。"),'The translation was empty. Your draft is saved.')
  assert.equal(formatUiError('zh-CN',"Error invoking remote method 'send:submit': Error: 翻译结果为空，草稿已保留。"),'翻译结果为空，草稿已保留。')
})

test('queued language changes persist across stores without replacing saved credentials or translation preferences', async () => {
  const h = mainHarness()
  try {
    const { SettingsStore } = h.load('src/main/storage/settingsStore.ts')
    const first = new SettingsStore(), second = new SettingsStore()
    const initial = await first.get()
    const preferences = { ...initial, targetLanguage:'es-MX', previewSend:false, quickReplies:['保持原文 🐶'], openaiApiKey:'fixture-key-not-a-real-credential' }
    await Promise.all([first.save(preferences), second.setUiLanguage('en')])
    const restored = await new SettingsStore().get()
    assert.equal(restored.uiLanguage,'en')
    assert.equal(restored.openaiApiKey, undefined, 'retired OpenAI credentials must stay removed during queued locale updates')
    assert.equal(restored.targetLanguage,'es-MX')
    assert.deepEqual([...restored.quickReplies], preferences.quickReplies)
    assert.equal((await second.runtime()).uiLanguage,'en')
    await assert.rejects(second.setUiLanguage('invalid'), /Invalid interface language/)
    assert.equal((await first.get()).uiLanguage,'en')
    await first.setUiLanguage('zh-CN')
    assert.equal((await second.runtime()).uiLanguage,'zh-CN')
  } finally { rmSync(h.directory,{recursive:true,force:true}) }
})
