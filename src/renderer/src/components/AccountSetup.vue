<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
const props = defineProps<{ platform: 'whatsapp' | 'signal'; account?: any; languages: any[] }>()
const emit = defineEmits<{ close: []; saved: [account: any] }>()
const name = props.platform === 'whatsapp' ? 'WhatsApp' : 'Signal'
const initial = props.account || {}
const draft = reactive({ label: initial.label || name, localLanguage: initial.localLanguage || 'zh-CN', targetLanguage: initial.targetLanguage || 'en-US', receiveAutoTranslate: initial.receiveAutoTranslate ?? true, sendAutoTranslate: initial.sendAutoTranslate ?? true, blockChineseSend: initial.blockChineseSend ?? true, groupTranslate: initial.groupTranslate ?? false, fontSize: initial.fontSize || 13, translationColor: initial.translationColor || '#7eada0', proxy: { enabled: false, protocol: 'http', host: '', port: 8080, username: '', hasPassword: false, ...initial.proxy, password: '', clearPassword: false } })
const busy = ref(false), testing = ref(false), message = ref(''), proxyResult = ref(''), paste = ref('')
const form = ref<HTMLFormElement | null>(null)
const previousFocus = document.activeElement as HTMLElement | null
const toggles = [{ key: 'receiveAutoTranslate', label: '接收翻译', hint: '收到的消息显示译文' }, { key: 'sendAutoTranslate', label: '发送翻译', hint: '发送前转成对方的语言' }, { key: 'blockChineseSend', label: '拦截中文原文', hint: '避免翻译失败时误发原文' }, { key: 'groupTranslate', label: '群组翻译', hint: '也翻译群聊中的消息' }] as const
watch(() => JSON.stringify(draft.proxy), () => { proxyResult.value = '' })
watch(() => draft.proxy.protocol, protocol => {
  if (protocol === 'socks5') Object.assign(draft.proxy, { username: '', password: '', clearPassword: true })
})
function close() { if (!busy.value && !testing.value) emit('close') }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.stopPropagation(); close() }
  if (event.key === 'Tab') {
    const items = [...form.value!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].filter(el => el.offsetParent !== null)
    const first = items[0], last = items.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
onMounted(async () => { await nextTick(); form.value?.querySelector<HTMLInputElement>('[name="account-name"]')?.focus() })
onUnmounted(() => previousFocus?.focus())
function parse() {
  try {
    const url = new URL(paste.value.trim())
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname) throw new Error()
    Object.assign(draft.proxy, { enabled: true, protocol: url.protocol.slice(0, -1), host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : url.protocol === 'socks5:' ? 1080 : 80)), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), clearPassword: !url.password, hasPassword: false })
    paste.value = ''; proxyResult.value = ''; message.value = ''
  } catch { message.value = '使用 协议://账号:密码@主机:端口 格式；没有认证时可省略账号和密码。' }
}
async function testProxy() {
  testing.value = true; proxyResult.value = ''; message.value = ''
  const tested = JSON.stringify(draft.proxy)
  try { const result = await window.desktopAPI.testAccountProxy(JSON.parse(tested), initial.id); if (JSON.stringify(draft.proxy) === tested) proxyResult.value = `出口 IP：${result.ip} · ${result.latencyMs} ms`; else message.value = '配置已更改，请重新检测。' }
  catch (error: any) { message.value = error?.message || '代理检测失败' }
  finally { testing.value = false }
}
async function save() {
  if (busy.value || testing.value) return
  busy.value = true; message.value = ''
  try {
    const options = JSON.parse(JSON.stringify(draft))
    const account = initial.id ? await window.desktopAPI.updateAccount(initial.id, options) : await window.desktopAPI.addAccount({ platform: props.platform, label: draft.label, options })
    if (!account) throw new Error('账号不存在，请关闭面板后重试。')
    emit('saved', account)
  } catch (error: any) { message.value = error?.message || '保存失败，请重试。' }
  finally { busy.value = false }
}
</script>

<template>
  <div class="modal-backdrop account-setup-backdrop" @click.self="close">
    <form ref="form" class="account-setup" role="dialog" aria-modal="true" aria-labelledby="account-setup-title" :data-platform="platform" @submit.prevent="save" @keydown="keydown">
      <header class="setup-header"><span class="platform-avatar" :class="platform"><img :src="`./${platform}.svg`" :alt="name" /></span><div><h2 id="account-setup-title">{{ initial.id ? '账号设置' : '新建 ' + name + ' 窗口' }}</h2><p>为这一个账号设置语言与连接方式。</p></div><button type="button" class="icon-button" aria-label="关闭" :disabled="busy || testing" @click="close">×</button></header>
      <fieldset class="setup-body" :disabled="busy || testing">
        <section class="setup-section"><h3>基本信息</h3><label>窗口名称<input v-model="draft.label" name="account-name" maxlength="60" required autocomplete="off" /></label><div class="setup-provider"><span>翻译引擎</span><b>HelloDog 云端</b><small>账号独立设置，成功翻译按字符计费</small></div></section>
        <section class="setup-section"><h3>语言与翻译</h3><div class="setup-grid"><label>我的语言<select v-model="draft.localLanguage"><option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ language.zhName || language.name }}</option></select></label><label>对方的语言<select v-model="draft.targetLanguage"><option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ language.zhName || language.name }}</option></select></label></div><p class="setup-note">已为联系人单独设置的语言优先于账号默认语言。</p><div class="setup-grid"><label v-for="toggle in toggles" :key="toggle.key" class="setup-toggle"><span><b>{{ toggle.label }}</b><small>{{ toggle.hint }}</small></span><input v-model="draft[toggle.key]" type="checkbox" role="switch" /></label></div><div class="setup-grid display-setup"><label>译文字号<select v-model.number="draft.fontSize"><option v-for="size in [12,13,14,15,16,18]" :key="size" :value="size">{{ size }} px</option></select></label><label>译文颜色<input v-model="draft.translationColor" type="color" /></label></div></section>
        <section class="setup-section"><label class="setup-toggle proxy-heading"><span><b>独立代理 IP</b><small>{{ platform === 'whatsapp' ? '仅用于此 WhatsApp 窗口；关闭后使用系统网络' : 'Signal 独立代理暂不支持，当前使用系统网络' }}</small></span><input v-model="draft.proxy.enabled" type="checkbox" role="switch" :disabled="platform === 'signal'" /></label>
          <div v-if="draft.proxy.enabled && platform === 'whatsapp'" class="proxy-fields">
            <div class="setup-grid"><label>协议<select v-model="draft.proxy.protocol" @change="proxyResult = ''"><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5（免认证）</option></select></label><label>端口<input v-model.number="draft.proxy.port" type="number" min="1" max="65535" required /></label></div><label>主机地址<input v-model="draft.proxy.host" placeholder="例如 proxy.example.com" required autocomplete="off" /></label><div v-if="draft.proxy.protocol !== 'socks5'" class="setup-grid"><label>代理账号<input v-model="draft.proxy.username" autocomplete="off" placeholder="可选" /></label><label>代理密码<input v-model="draft.proxy.password" type="password" autocomplete="new-password" :placeholder="draft.proxy.hasPassword ? '已安全保存，留空则保留' : '可选'" /></label></div><label v-if="draft.proxy.hasPassword" class="setup-note"><input v-model="draft.proxy.clearPassword" type="checkbox" />清除已保存的代理密码</label>
            <div class="proxy-import"><input v-model="paste" type="password" autocomplete="off" aria-label="代理链接" placeholder="协议://账号:密码@主机:端口" /><button type="button" class="secondary" @click="parse">解析</button></div><div class="proxy-test"><button type="button" class="secondary" :disabled="testing || busy" @click="testProxy">{{ testing ? '正在检测…' : '检测出口 IP' }}</button><span role="status">{{ proxyResult }}</span></div><p class="setup-note">使用你自行购买或配置的代理。启用后连接失败不会自动直连；云端翻译请求仍使用 HelloDog 的服务线路。保存后将重新加载此窗口。</p>
          </div>
        </section>
        <p v-if="message" class="setup-error" role="alert">{{ message }}</p>
      </fieldset>
      <footer class="setup-footer"><button type="button" class="secondary" :disabled="busy || testing" @click="close">取消</button><button class="primary" type="submit" :disabled="busy || testing">{{ busy ? '正在保存…' : initial.id ? '保存设置' : '创建窗口' }}</button></footer>
    </form>
  </div>
</template>
