<script setup lang="ts">
import type { GoogleVoiceNetworkCheck, GoogleVoiceNetworkProbe, GoogleVoiceProbeCode, GoogleVoiceProbeName } from '../../../shared/googleVoiceNetwork'
import { uiLanguage } from '../lib/uiLocale'
defineProps<{ result: Partial<GoogleVoiceNetworkCheck> }>()
const text = (zh: string, en: string) => uiLanguage.value === 'en' ? en : zh
const rows: { name: GoogleVoiceProbeName; zh: string; en: string }[] = [
  { name: 'exitIp', zh: '出口 IP', en: 'Exit IP' },
  { name: 'signIn', zh: 'Google 账号服务', en: 'Google account service' },
  { name: 'voice', zh: 'Google Voice 页面', en: 'Google Voice endpoint' }
]
function reason(probe: GoogleVoiceNetworkProbe) {
  const { code, httpStatus } = probe
  if (code === 'http-error' && typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) {
    const detail = `HTTP ${httpStatus}`
    if (httpStatus === 401) return text(`已收到响应，请在页面确认登录（${detail}）`, `Response received; check sign-in on the page (${detail})`)
    if (httpStatus === 403) return text(`已收到响应，请在页面确认访问限制（${detail}）`, `Response received; check access restrictions on the page (${detail})`)
    if (httpStatus === 429) return text(`检测请求受限，请稍后重试（${detail}）`, `Check rate-limited; try again later (${detail})`)
    return text(`服务返回异常（${detail}）`, `Unexpected service response (${detail})`)
  }
  const labels: Record<GoogleVoiceProbeCode, [string, string]> = {
    'proxy-auth': ['代理认证失败，请核对账号和密码', 'Proxy authentication failed; check credentials'],
    'proxy-connect': ['代理无法连接，请检查线路', 'Proxy connection failed; check the route'],
    'network-error': ['网络连接失败', 'Network connection failed'],
    timeout: ['连接超时', 'Connection timed out'],
    'http-error': ['服务暂未正常响应', 'The service did not respond successfully'],
    'invalid-response': ['无法确认响应', 'The response could not be verified'],
    'redirect-blocked': ['跳转未通过检查', 'Redirect could not be verified'],
    cancelled: ['检测已取消', 'Check cancelled']
  }
  return code ? text(...labels[code]) : text('检测未通过', 'Check failed')
}
</script>

<template>
  <div class="voice-network-results" role="status" aria-live="polite">
    <ul>
      <li v-for="row in rows" :key="row.name" :data-probe="row.name" :class="{ failed: result.checks?.[row.name]?.status === 'failed' }">
        <span>{{ text(row.zh, row.en) }}</span>
        <b v-if="result.checks?.[row.name]?.status === 'reachable'">{{ row.name === 'exitIp' && result.ip ? result.ip : text('可连接', 'Reachable') }}<small>{{ result.checks[row.name].latencyMs }} ms</small></b>
        <b v-else-if="result.checks?.[row.name]?.status === 'failed'">{{ reason(result.checks[row.name]) }}</b>
        <b v-else>{{ text('尚未检测', 'Not checked') }}</b>
      </li>
    </ul>
    <small v-if="result.checkedAt">{{ text('检测于 ', 'Checked at ') }}{{ new Date(result.checkedAt).toLocaleTimeString() }}</small>
    <p>{{ text('这些结果仅表示网络可连接。登录、短信收发和图片上传仍需在官方页面实际确认。', 'These checks confirm network reachability only. Sign-in, texting and image uploads still need to be verified on the official page.') }}</p>
  </div>
</template>

<style scoped>
.voice-network-results{font-size:12px;line-height:1.6}.voice-network-results ul{list-style:none;padding:0;margin:8px 0;display:grid;gap:8px}.voice-network-results li{display:flex;justify-content:space-between;gap:12px}.voice-network-results b{color:var(--accent);font-weight:500;text-align:right;overflow-wrap:anywhere;min-width:0}.voice-network-results b small{display:block;color:var(--muted)}.voice-network-results li.failed b{color:#f1a499}.voice-network-results>small,.voice-network-results p{color:var(--muted)}.voice-network-results p{margin:8px 0 0}.voice-network-results li>span{flex-shrink:0}
</style>
