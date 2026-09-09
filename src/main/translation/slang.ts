import type { TranslationRequest } from '../types'

const EN_TO_ZH: Record<string, string> = {
  'simp': '舔狗',
  'wtf': '他妈的什么鬼',
  'tf': '搞什么鬼',
  'lol': '笑死',
  'lmao': '笑死我了',
  'rofl': '笑疯了',
  'bro': '兄弟',
  'dude': '哥们',
  'idiot': '白痴',
  'fool': '蠢货',
  'moron': '蠢货',
  'dumbass': '傻逼',
  'asshole': '混蛋',
  'bastard': '混蛋',
  'fuck you': '去你妈的',
  'f you': '去你妈的',
  'stfu': '他妈的闭嘴',
  'shut up': '闭嘴',
  'bs': '胡扯',
  'bullshit': '狗屁',
  'sus': '可疑',
  'cap': '吹牛',
  'no cap': '真没骗你',
  'based': '够硬气',
  'cringe': '尴尬死了',
  'npc': '像个没脑子的路人甲',
  'deadass': '说真的',
  'fr': '真的',
  'imo': '我觉得',
  'imho': '依我看',
  'idk': '我不知道',
  'ikr': '就是啊',
  'nvm': '算了',
  'brb': '马上回来',
  'omg': '我的天',
  'smh': '无语了'
}

const ZH_LATIN_TO_EN: Record<string, string> = {
  'sb': 'idiot',
  'nmsl': 'fuck your mother',
  'cnm': 'fuck your mother',
  'tmd': 'fucking',
  'tm': 'fucking'
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?。！？]+$/g, '').replace(/\s+/g, ' ')
}

export function deterministicChatTranslation(request: TranslationRequest): string | undefined {
  const key = normalize(request.text)
  if (!key) return undefined

  if ((request.targetLanguage === 'zh-CN' || request.targetLanguage === 'zh-TW') && request.sourceLanguage !== 'zh-CN' && request.sourceLanguage !== 'zh-TW') {
    return EN_TO_ZH[key]
  }

  if ((request.sourceLanguage === 'zh-CN' || request.sourceLanguage === 'zh-TW') && request.targetLanguage.startsWith('en')) {
    return ZH_LATIN_TO_EN[key]
  }

  return undefined
}
