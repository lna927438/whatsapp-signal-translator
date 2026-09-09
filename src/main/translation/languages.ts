export const languages = [
  { code: 'auto', name: 'Auto Detect', zhName: '自动检测' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', zhName: '中文（简体）' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', zhName: '中文（繁体）' },
  { code: 'en-US', name: 'English (US)', zhName: '英语（美国）' },
  { code: 'en-GB', name: 'English (UK)', zhName: '英语（英国）' },
  { code: 'es', name: 'Spanish', zhName: '西班牙语' },
  { code: 'fr', name: 'French', zhName: '法语' },
  { code: 'de', name: 'German', zhName: '德语' },
  { code: 'it', name: 'Italian', zhName: '意大利语' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', zhName: '葡萄牙语（巴西）' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)', zhName: '葡萄牙语（葡萄牙）' },
  { code: 'ja', name: 'Japanese', zhName: '日语' },
  { code: 'ko', name: 'Korean', zhName: '韩语' },
  { code: 'ru', name: 'Russian', zhName: '俄语' },
  { code: 'ar', name: 'Arabic', zhName: '阿拉伯语' },
  { code: 'th', name: 'Thai', zhName: '泰语' },
  { code: 'vi', name: 'Vietnamese', zhName: '越南语' },
  { code: 'id', name: 'Indonesian', zhName: '印度尼西亚语' },
  { code: 'nl', name: 'Dutch', zhName: '荷兰语' },
  { code: 'pl', name: 'Polish', zhName: '波兰语' },
  { code: 'tr', name: 'Turkish', zhName: '土耳其语' }
]

export function languageName(code: string): string {
  return languages.find((l) => l.code === code)?.name || code
}
