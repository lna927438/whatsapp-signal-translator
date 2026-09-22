<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { t, uiError } from '../lib/uiLocale'
const api = window.desktopAPI
const info = ref<any>(null), notice = ref<any>(null), action = ref(''), error = ref(''), message = ref('')
let disposed = false, poll: ReturnType<typeof setInterval> | undefined, polling = false
const busy = computed(() => !!action.value || info.value?.busy === true)
const available = computed(() => notice.value?.verified === true && notice.value.status === 'available')
const currentVersion = computed(() => info.value?.currentVersion || notice.value?.currentVersion || t('读取中…'))
const matchedManifest = computed(() => available.value && info.value?.newer === true && info.value.manifest?.channel === 'stable' && info.value.manifest.version === notice.value.latestVersion)
const installerReady = computed(() => matchedManifest.value && ['verified','opened'].includes(info.value?.phase))
const phaseLabels = computed<Record<string,string>>(() => ({available:t('待下载'),downloading:t('下载中'),interrupted:t('下载中断，可续传'),verified:t('校验通过'),opened:t('安装结果待确认'),installed:t('已安装')}))
function stopPolling() { if (poll) clearInterval(poll); poll = undefined }
function syncPolling() {
  if (disposed || !info.value?.busy && action.value !== 'download') { stopPolling(); return }
  if (!poll) poll = setInterval(() => {
    if (polling) return
    polling = true
    void readInfo().catch(reason => { if (!disposed) error.value = uiError(reason?.message || t('操作未完成，请重试。')) }).finally(() => { polling = false })
  }, 1000)
}
async function readInfo() {
  const value = await api.updateInfo()
  if (disposed) return
  info.value = value; syncPolling()
}
async function readSnapshot(force = false) {
  const results = await Promise.allSettled([api.updateInfo(), api.updateNotice(force)])
  if (disposed) return
  if (results[0].status === 'fulfilled') info.value = results[0].value
  if (results[1].status === 'fulfilled') notice.value = results[1].value
  else notice.value = null
  syncPolling()
  const failed = results.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  if (notice.value?.verified !== true || notice.value?.status === 'unknown') throw new Error(t('暂时无法确认最新版本，请重新检查。'))
}
async function run(name: string, work: () => Promise<void>) {
  if (busy.value) return
  action.value = name; error.value = ''; message.value = ''
  try { await work() }
  catch (reason: any) { if (!disposed) error.value = uiError(reason?.message || t('操作未完成，请重试。')) }
  finally { if (!disposed) { action.value = ''; syncPolling() } }
}
async function checkFresh() {
  await readSnapshot(true)
  if (disposed || !available.value) return false
  await api.checkUpdate('stable')
  if (disposed) return false
  await readInfo()
  if (!matchedManifest.value) throw new Error(t('版本信息已变化，请重新检查。'))
  return true
}
function check() { return run('check', async () => { await checkFresh() }) }
function website() { return run('website', async () => { await api.openOfficialWebsite() }) }
function restart() { return run('restart', async () => { await api.restartApp() }) }
function download() { return run('download', async () => {
  if (!await checkFresh()) return
  syncPolling()
  await api.downloadUpdate()
  if (disposed) return
  await readInfo(); message.value = t('下载和校验已完成。')
}) }
function install() { return run('install', async () => {
  if (!await checkFresh()) return
  if (!installerReady.value) throw new Error(t('请先完成下载和校验。'))
  // Reuse registered setting/account/Signal draft preparation before opening the installer.
  await window.__HELLODOG_PREPARE_RESTART__?.()
  if (disposed) return
  await api.openUpdateInstaller()
  if (disposed) return
  await readInfo(); message.value = t('安装程序已打开，请按提示完成更新。')
}) }
function recovery() { return run('recovery', async () => { await api.openUpdateRecovery() }) }
onMounted(() => { void run('initial', () => readSnapshot()) })
onUnmounted(() => { disposed = true; stopPolling() })
</script>

<template>
  <section class="settings-updates" :aria-label="t('版本与更新')" :aria-busy="busy">
    <div class="version-summary">
      <div><small>HelloDog</small><h3>{{ t('当前版本 ') }}{{ currentVersion }}</h3></div>
      <button class="secondary" type="button" :disabled="busy" @click="check">{{ action === 'check' ? t('检查中…') : t('检查更新') }}</button>
    </div>
    <p v-if="available" class="version-status">{{ t('发现新版本 {0}', notice.latestVersion) }}</p>
    <p v-else-if="notice?.verified && notice.status === 'current'" class="version-status">{{ t('已是当前最新版本') }}</p>
    <p v-else-if="notice?.verified && notice.status === 'ahead'" class="version-status">{{ t('本机版本较新') }}</p>
    <p v-else class="version-status">{{ t('版本检查尚未完成') }}</p>
    <p>{{ t('自动检查官网稳定版；发现新版本会提醒，可稍后更新。') }}</p>
    <section v-if="available" class="version-release">
      <p v-if="notice.notes" class="release-notes">{{ notice.notes }}</p>
      <div class="version-actions">
        <button class="primary" type="button" :disabled="busy" @click="website">{{ t('前往官网更新') }}</button>
        <button v-if="!installerReady" class="secondary" type="button" :disabled="busy" @click="download">{{ info?.phase === 'interrupted' && matchedManifest ? t('继续下载') : t('下载并校验') }}</button>
        <button v-else class="secondary" type="button" :disabled="busy" @click="install">{{ t('打开已校验的安装包') }}</button>
      </div>
      <div v-if="matchedManifest" class="download-state"><p>{{ phaseLabels[info.phase] || t('待下载') }} · {{ (info.manifest.size / 1048576).toFixed(1) }} MiB</p><progress v-if="info.busy || action === 'download' || info.phase === 'interrupted'" :value="info.received || 0" :max="info.manifest.size" :aria-label="t('下载进度')" /></div>
    </section>
    <div class="version-tools">
      <div><h3>{{ t('软件操作') }}</h3><p>{{ t('重启前会保存草稿和设置。保存未完成时，软件会保持运行并说明原因。') }}</p></div>
      <div class="version-actions"><button class="secondary" type="button" :disabled="busy" @click="restart">{{ action === 'restart' ? t('正在保存并重启…') : t('一键重启') }}</button><button class="secondary" type="button" :disabled="busy" @click="website">{{ t('前往官网') }}</button></div>
    </div>
    <details v-if="info?.recoveryDirectory" class="version-recovery"><summary>{{ t('安装恢复') }}</summary><p>{{ t('上一版程序文件已保留。先退出 HelloDog，再从恢复目录运行 Restore-HelloDog.cmd。') }}</p><button type="button" class="secondary" :disabled="busy" @click="recovery">{{ t('打开恢复目录') }}</button></details>
    <p v-if="error" class="version-error" role="alert">{{ error }}</p>
    <p v-else-if="message" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.settings-updates{display:grid;gap:16px;min-width:0}.settings-updates h3,.settings-updates p{margin:0}.settings-updates p{line-height:1.65}.version-summary{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--border)}.version-summary small{display:block;margin-bottom:8px}.version-status{font-size:16px;font-weight:600}.version-release{display:grid;gap:16px;padding:16px;background:var(--raised);border:1px solid var(--border);border-radius:10px}.release-notes{white-space:pre-wrap;overflow-wrap:anywhere}.version-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.version-actions button{min-height:36px}.version-tools{display:grid;gap:16px;padding-top:18px;border-top:1px solid var(--border)}.version-tools h3{margin-bottom:8px}.download-state{display:grid;gap:10px}.download-state progress{width:100%}.settings-updates .version-error{color:#f2b39b}.version-recovery summary{cursor:pointer}.version-recovery p{margin:10px 0}.version-summary button{flex-shrink:0}@media(max-width:540px){.version-summary{align-items:flex-start;flex-direction:column}}
</style>
