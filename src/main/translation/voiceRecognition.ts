import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'fs/promises'
import { join, resolve, relative } from 'path'
import { validateVoiceWav } from '../../shared/voiceAudio'
import expectedManifest from '../../../resources/voice/manifest.json'

interface VoiceManifest { files: Record<string, string>; model: string; executable: string }
export interface RecognizedVoice { text: string; language?: string }
export function recognizedVoice(value: unknown): RecognizedVoice {
  const language = (value as { result?: { language?: unknown } })?.result?.language
  return { text: voiceTranscript(value), ...(typeof language === 'string' && /^[a-z]{2,3}$/.test(language) ? { language } : {}) }
}
export function voiceTranscript(value: unknown): string {
  const rows = (value as {transcription?: unknown})?.transcription
  if (!Array.isArray(rows) || rows.length > 2000) throw new Error('语音识别没有返回完整结果，请重试。')
  const text = rows.map(row => typeof row?.text === 'string' ? row.text : '').join('').replace(/\[BLANK_AUDIO\]|\[silence\]/gi,'').trim()
  if (!text || !/\p{L}/u.test(text)) throw new Error('没有识别到清晰的人声，请播放确认后重试。')
  if (Array.from(text).length > 12000) throw new Error('识别结果过长，请选择较短的语音。')
  return text
}

/** One bounded local CPU job at a time. No audio/text is logged or retained on
 * disk after completion. The only accepted input format is canonical PCM WAV. */
export class VoiceRecognition {
  private running = false
  private disposed = false
  private active?: { cancelled: boolean; interrupt?: () => void; finished: Promise<void>; finish: () => void }
  private verified?: Promise<VoiceManifest>
  constructor(private resources: string, private temporaryRoot: string) {}
  get busy(): boolean { return this.running }
  /** Final window/app shutdown must stop the native child immediately and wait
   * for its close plus temporary-file cleanup, not a later polling interval. */
  dispose(): Promise<void> {
    this.disposed = true
    const active = this.active
    if (!active) return Promise.resolve()
    active.cancelled = true
    active.interrupt?.()
    return active.finished
  }
  private manifest() {
    return this.verified ||= (async () => {
      // This manifest is embedded in the packaged application bundle, not read
      // beside the native executable where both files could be replaced.
      const manifest: VoiceManifest = expectedManifest
      if (manifest.executable !== 'whisper-cli.exe' || manifest.model !== 'ggml-base.bin' || !manifest.files?.[manifest.executable] || !manifest.files?.[manifest.model]) throw new Error('语音组件清单无效，请重新安装最新版。')
      if((await readdir(this.resources)).some(name=>!/^[a-zA-Z0-9._-]+$/.test(name)||!Object.hasOwn(manifest.files,name)))throw new Error('语音组件目录包含未通过验证的文件，请重新安装最新版。')
      for (const [name, expected] of Object.entries(manifest.files)) {
        if (!/^[a-zA-Z0-9._-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('语音组件清单无效。')
        const digest=createHash('sha256').update(await readFile(join(this.resources,name))).digest('hex')
        if (digest!==expected) throw new Error('语音组件校验失败，请重新安装最新版。')
      }
      return manifest
    })().catch(error => {this.verified=undefined;throw error})
  }
  async recognize(input: unknown, authorized: () => boolean): Promise<string> {
    return (await this.recognizeWithLanguage(input, authorized)).text
  }
  async recognizeWithLanguage(input: unknown, authorized: () => boolean): Promise<RecognizedVoice> {
    if (this.disposed) throw new Error('语音组件已关闭，请重新打开 HelloDog。')
    if (this.running) throw new Error('上一条语音正在识别，请完成后重试。')
    if (!authorized()) throw new Error('登录状态已变化，请重新打开当前聊天。')
    const bytes=validateVoiceWav(input); this.running=true
    let finish!: () => void
    const active: NonNullable<VoiceRecognition['active']> = { cancelled: false, finished: new Promise<void>(resolve => { finish = resolve }), finish: () => finish() }
    this.active = active
    const current = () => !active.cancelled && !this.disposed && authorized()
    let directory=''
    try {
      this.verified=undefined
      const manifest=await this.manifest()
      if (!current()) throw new Error('登录状态已变化。')
      await mkdir(this.temporaryRoot,{recursive:true}); directory=await mkdtemp(join(this.temporaryRoot,'voice-'))
      if (!current()) throw new Error('登录状态已变化。')
      const wav=join(directory,'input.wav'), output=join(directory,'result')
      await writeFile(wav,bytes,{mode:0o600})
      if (!current()) throw new Error('登录状态已变化。')
      await new Promise<void>((fulfill,reject)=>{
        // whisper.cpp's Windows model loader cannot reliably open a UTF-8
        // absolute path containing Chinese characters. cwd is set by Node's
        // Unicode process API; the verified ASCII basename works from there.
        const child=spawn(join(this.resources,manifest.executable),['-m',manifest.model,'-f',wav,'-l','auto','-t','2','-ng','-oj','-of',output,'-np'],{windowsHide:true,stdio:'ignore',cwd:this.resources,shell:false})
        let reason='',ended=false
        const timeout=setTimeout(()=>{reason='语音识别超时，请选择较短的语音再试。';child.kill()},180000)
        const check=setInterval(()=>{if(!current()){reason='登录状态已变化，已停止语音识别。';child.kill()}},250)
        const done=(error?:Error)=>{if(ended)return;ended=true;active.interrupt=undefined;clearTimeout(timeout);clearInterval(check);error?reject(error):fulfill()}
        child.once('error',()=>done(new Error('无法启动语音组件，请重新安装最新版。')))
        child.once('close',code=>done(reason?new Error(reason):code===0?undefined:new Error('语音识别未完成，请重试。')))
        active.interrupt=()=>{if(!ended){reason='登录状态已变化，已停止语音识别。';child.kill()}}
      })
      if (!current()) throw new Error('登录状态已变化。')
      const text=await readFile(output+'.json','utf8');if(!current())throw new Error('登录状态已变化。');if(text.length>2_000_000)throw new Error('语音识别结果过大。')
      return recognizedVoice(JSON.parse(text))
    } finally {
      if(directory){const relativePath=relative(resolve(this.temporaryRoot),resolve(directory));if(/^voice-[a-zA-Z0-9]+$/.test(relativePath))await rm(directory,{recursive:true,force:true}).catch(()=>undefined)}
      this.running=false
      if(this.active===active)this.active=undefined
      active.finish()
    }
  }
}
