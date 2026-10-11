export const chatPlatforms = ['whatsapp', 'signal', 'telegram'] as const
export type ChatPlatform = typeof chatPlatforms[number]
const labels: Readonly<Record<string, string>> = { whatsapp: 'WhatsApp', signal: 'Signal', telegram: 'Telegram' }
export const platformLabel = (platform: string): string => labels[platform] || platform
export function isEmbeddedChat(platform?: string): platform is 'whatsapp' | 'telegram' {
  return platform === 'whatsapp' || platform === 'telegram'
}
