<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { uiError, uiLanguage } from '../lib/uiLocale'
import type { GoogleVoiceWindow, GoogleVoiceWindowOptions, GoogleVoiceNetwork } from '../lib/googleVoiceWorkspace'
import { parseGoogleVoiceProxyImport } from '../../../shared/googleVoiceProxyImport'
const props = defineProps<{ record?: GoogleVoiceWindow; network?: GoogleVoiceNetwork; save: (value: GoogleVoiceWindowOptions) => Promise<boolean> }>()
const emit = defineEmits<{ close: [] }>()
const text = (zh: string, en: string) => uiLanguage.value === 'en' ? en : zh
const panel = ref<HTMLElement>(), busy = ref(false), testing = ref(false), error = ref(''), pasted = ref('')
const tested = ref<{ ip: string; latencyMs: number; checkedAt: number }>()
const importError = ref(''), importNotice = ref('')
const importFeedback = ref<HTMLElement>()
const draft = reactive({ label: props.record?.label || 'Google Voice', proxy: { enabled: false, protocol: 'http' as 'http'|'https'|'socks5', host: '', port: 8080, username: '', hasPassword: false, ...props.record?.proxy, password: '', clearPassword: false } })
const locked = computed(() => busy.value || testing.value)
let disposed = false
watch(() => JSON.stringify(draft.proxy), () => { tested.value = undefined })
watch(() => draft.proxy.password, value => { if (value) draft.proxy.clearPassword = false })
watch(pasted, () => { importError.value = ''; importNotice.value = '' }, { flush: 'sync' })
function close() { if (!locked.value) emit('close') }
function proxyInput() {
  const input = JSON.parse(JSON.stringify(draft.proxy))
  if (input.enabled && input.protocol === 'socks5') {
    const retained = input.hasPassword && !input.clearPassword
    if (!!input.username !== !!(input.password || retained)) throw new Error(text('SOCKS5 认证需要同时填写账号和密码；免认证时请同时清除账号和密码。', 'SOCKS5 authentication requires both username and password. Clear both for no authentication.'))
    if (new TextEncoder().encode(input.username).length > 255 || new TextEncoder().encode(input.password).length > 255) throw new Error(text('SOCKS5 账号和密码各不能超过 255 个 UTF-8 字节。', 'SOCKS5 username and password must each fit within 255 UTF-8 bytes.'))
  }
  return input
}
function parse() {
  if (locked.value) return
  error.value = ''; importError.value = ''; importNotice.value = ''
  try {
    const value = parseGoogleVoiceProxyImport(pasted.value, draft.proxy.protocol)
    Object.assign(draft.proxy, value)
    pasted.value = ''
    importNotice.value = text('已填入代理配置，请先检测，再保存使用。', 'Proxy fields filled. Test the configuration, then save it.')
  } catch (e) { importError.value = text(e instanceof Error ? e.message : '代理格式无效，请检查地址和端口。', 'Check the proxy format, host, port and credentials. Your existing fields have not changed.') }
  void nextTick(() => { if (!disposed) importFeedback.value?.scrollIntoView({ block: 'nearest' }) })
}
async function test() {
  if (locked.value) return
  testing.value = true; error.value = ''; tested.value = undefined
  try {
    const input = proxyInput()
    const result = await window.desktopAPI.testGoogleVoiceProxy(input, props.record?.id)
    if (!disposed && JSON.stringify(input) === JSON.stringify(draft.proxy)) tested.value = result
  } catch (e: any) { if (!disposed) error.value = uiError(e?.message) }
  finally { if (!disposed) testing.value = false }
}
async function checkCurrent() {
  if (locked.value || !props.record) return
  testing.value = true; error.value = ''
  try {
    const result = await window.desktopAPI.checkGoogleVoiceNetwork(props.record.id)
    if (!disposed && result.status === 'error') error.value = result.message
  } catch (e: any) { if (!disposed) error.value = uiError(e?.message) }
  finally { if (!disposed) testing.value = false }
}
async function submit() {
  if (locked.value) return
  busy.value = true; error.value = ''
  try {
    const saved = await props.save({ label: draft.label.trim(), proxy: proxyInput() })
    if (!disposed && saved) { draft.proxy.password = ''; pasted.value = ''; emit('close') }
    else if (!disposed) error.value = text('设置未保存，请核对代理地址、端口和认证信息。', 'Settings were not saved. Check the proxy host, port and credentials.')
  } catch (e: any) { if (!disposed) error.value = uiError(e?.message) }
  finally { if (!disposed) busy.value = false }
}
function trap(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const items = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') || [])], first = items[0], last = items.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(async () => { await nextTick(); panel.value?.querySelector<HTMLInputElement>('input')?.focus() })
onUnmounted(() => { disposed = true; draft.proxy.password = ''; pasted.value = '' })
</script>

<template>
  <div class="modal-backdrop" @click.self="close" @keydown.esc.stop="close">
    <form ref="panel" class="panel voice-window-setup" role="dialog" aria-modal="true" :aria-label="text(record ? '窗口与 IP' : '新增 Google Voice 窗口', record ? 'Window and IP' : 'New Google Voice window')" @submit.prevent="submit" @keydown="trap">
      <header><h2>{{ text(record ? '窗口与 IP' : '新增 Google Voice 窗口', record ? 'Window and IP' : 'New Google Voice window') }}</h2><button type="button" :disabled="locked" :aria-label="text('关闭','Close')" @click="close">×</button></header>
      <fieldset :disabled="locked">
        <label>{{ text('窗口名称','Window name') }}<input v-model="draft.label" maxlength="60" required /></label>
        <label class="switch"><span><b>{{ text('独立代理 IP','Dedicated proxy') }}</b><small>{{ text('仅作用于此 Google Voice 窗口；关闭时使用系统网络。','Applies only to this Google Voice window. Off uses the system network.') }}</small></span><input v-model="draft.proxy.enabled" type="checkbox" role="switch" /></label>
        <div v-if="draft.proxy.enabled" class="proxy-settings">
          <div class="grid"><label>{{ text('协议','Protocol') }}<select v-model="draft.proxy.protocol"><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option></select></label><label>{{ text('端口','Port') }}<input v-model.number="draft.proxy.port" type="number" min="1" max="65535" required /></label></div>
          <label>{{ text('代理地址','Proxy host') }}<input v-model="draft.proxy.host" placeholder="proxy.example.com" autocomplete="off" required /></label>
          <div class="grid"><label>{{ text('代理账号','Proxy username') }}<input v-model="draft.proxy.username" autocomplete="off" maxlength="256" /></label><label>{{ text('代理密码','Proxy password') }}<input v-model="draft.proxy.password" type="password" autocomplete="new-password" maxlength="1024" :placeholder="text(draft.proxy.hasPassword ? '已保存，留空保留' : '可选', draft.proxy.hasPassword ? 'Saved; leave blank to keep' : 'Optional')" /></label></div>
          <label v-if="draft.proxy.hasPassword" class="clear"><input v-model="draft.proxy.clearPassword" type="checkbox" />{{ text('清除已保存的代理密码','Clear saved proxy password') }}</label>
          <div class="import"><input v-model="pasted" type="password" autocomplete="off" :aria-label="text('导入代理链接','Import proxy URL')" :aria-invalid="!!importError" aria-describedby="voice-proxy-import-help" :placeholder="text('粘贴代理地址或完整链接','Paste proxy address or full URL')" /><button type="button" class="secondary" :disabled="!pasted.trim()" @click="parse">{{ text('解析','Parse') }}</button></div>
          <p id="voice-proxy-import-help" class="hint">{{ text('支持：地址:端口:账号:密码、账号:密码@地址:端口，或完整代理链接。没有协议前缀时使用上方所选协议。', 'Accepts host:port:username:password, username:password@host:port, or a full proxy URL. Without a prefix, the selected protocol is used.') }}</p>
          <p v-if="importError" ref="importFeedback" class="error" role="alert">{{ importError }}</p>
          <p v-else-if="importNotice" ref="importFeedback" class="result" role="status">{{ importNotice }}</p>
          <button type="button" class="secondary" @click="test">{{ text(testing ? '正在检测…' : '检测此配置', testing ? 'Checking…' : 'Test this configuration') }}</button>
          <p v-if="tested" class="result" role="status">{{ text('检测出口 IP：','Test exit IP: ') }}{{ tested.ip }} · {{ tested.latencyMs }} ms</p>
          <p class="hint">{{ text('支持带账号密码的 SOCKS5。代理断开时不会自动直连；检测成功后再保存使用。出口 IP 检测不代表 Google 账号或图片服务可用。','Authenticated SOCKS5 is supported. No automatic direct fallback; test before saving. An exit IP check does not verify access to your Google account or image services.') }}</p>
        </div>
      </fieldset>
      <section v-if="record" class="current-network">
        <b>{{ text('当前窗口连接','Current window connection') }}</b>
        <p v-if="network?.status === 'checked'">{{ network.ip }} · {{ network.latencyMs }} ms <small>{{ text('检测于 ','Checked at ') }}{{ new Date(network.checkedAt!).toLocaleTimeString() }}</small></p>
        <p v-else>{{ text(network?.status === 'checking' ? '正在核实出口 IP…' : network?.status === 'error' ? '出口 IP 检测未通过' : '尚未核实出口 IP', network?.status === 'checking' ? 'Checking exit IP…' : network?.status === 'error' ? 'Exit IP check failed' : 'Exit IP has not been checked') }}</p>
        <button type="button" class="secondary" :disabled="locked" @click="checkCurrent">{{ text('刷新当前 IP','Refresh current IP') }}</button>
      </section>
      <p class="hint">{{ text('云端翻译继续使用 HelloDog 服务线路。', 'Cloud translation continues through HelloDog services.') }}<span v-if="record"> {{ text('保存将重新连接此窗口，请先结束通话并保存草稿。','Saving reconnects this window. Finish calls and save drafts first.') }}</span></p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <footer><button type="button" class="secondary" :disabled="locked" @click="close">{{ text('取消','Cancel') }}</button><button class="primary" :disabled="locked || !draft.label.trim()" type="submit">{{ text(busy ? '正在保存…' : record ? '保存并重连' : '创建窗口', busy ? 'Saving…' : record ? 'Save and reconnect' : 'Create window') }}</button></footer>
    </form>
  </div>
</template>

<style scoped>
.voice-window-setup{width:min(550px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:24px;background:var(--panel,#19232a);color:var(--text);border:1px solid var(--border);border-radius:14px}header{display:flex;align-items:center;justify-content:space-between;padding:0;margin-bottom:20px}h2{margin:0;font-size:20px}header button{background:none;border:0;color:inherit;font-size:24px}fieldset{border:0;padding:0;margin:0;min-width:0;display:grid;gap:20px}label{display:grid;gap:7px;font-size:13px}input:not([type=checkbox]),select{width:100%;min-width:0;box-sizing:border-box;background:var(--field);border:1px solid var(--border);border-radius:7px;color:inherit;padding:10px;font:inherit}.switch{display:flex;justify-content:space-between;align-items:center;gap:20px}.switch small{display:block;margin-top:6px;color:var(--muted);line-height:1.6}.switch input,.clear input{accent-color:#65bc9c;width:18px;height:18px;flex-shrink:0}.proxy-settings{padding:16px;background:var(--field);border:1px solid var(--border);border-radius:10px;display:grid;gap:14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.import{display:flex;gap:8px}.import button{flex-shrink:0}.clear{display:flex;align-items:center}.hint{font-size:12px;color:var(--muted);line-height:1.7;margin:8px 0 0}.result{color:var(--accent);font-size:13px;overflow-wrap:anywhere;margin:0}.current-network{margin-top:20px;padding-top:16px;border-top:1px solid var(--border);font-size:13px}.current-network small{display:block;color:var(--muted);margin-top:5px}.error{color:#f1a499;font-size:13px;line-height:1.6}footer{display:flex;justify-content:flex-end;gap:10px;padding:0;margin-top:22px}button:disabled{opacity:.5;cursor:default}@media(max-width:480px){.grid{grid-template-columns:1fr}.voice-window-setup{padding:18px}}
</style>
