export interface VoiceManifest {
  files: Record<string, string>
  model: string
  executable: string
  platform?: string
  arch?: string
}

/** The build embeds the manifest; adjacent native files cannot redefine trust. */
export function validateNativeVoiceManifest(value: VoiceManifest, platform: string, arch: string): VoiceManifest {
  const executable = platform === 'win32' ? 'whisper-cli.exe' : platform === 'darwin' ? 'whisper-cli' : undefined
  if (!executable || value.executable !== executable || value.model !== 'ggml-base.bin'
    || (value.platform !== undefined && value.platform !== platform)
    || (value.arch !== undefined && value.arch !== arch)
    || (platform === 'darwin' && (value.platform !== 'darwin' || value.arch !== arch || !['arm64', 'x64'].includes(arch)))
    || !value.files?.[executable] || !value.files?.[value.model]
    || Object.entries(value.files).some(([name, hash]) => !/^[a-zA-Z0-9._-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('语音组件与当前系统不匹配，请安装适合此电脑的 HelloDog 版本。')
  }
  return value
}
