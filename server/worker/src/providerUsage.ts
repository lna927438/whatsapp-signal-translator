// Only counters and provider identifiers are retained. Never persist response text here.
export interface ProviderReceipt {
  model: string; responseId: string | null; requestId: string | null; createdAt: string | null
  inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null
  totalTokens: number | null; reasoningTokens: number | null; httpStatus: number | null
}
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000 ? v : null
const identifier = (v: unknown): string | null => typeof v === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(v) ? v : null
export function providerReceipt(model: string): ProviderReceipt {
  return {model, responseId:null, requestId:null, createdAt:null, inputTokens:null, cachedTokens:null,
    outputTokens:null, totalTokens:null, reasoningTokens:null, httpStatus:null}
}
export function captureProviderReceipt(receipt:ProviderReceipt, payload:any, response:Response, started:number, now=Date.now()) {
  receipt.httpStatus=response.status
  receipt.responseId=identifier(payload?.id)
  receipt.requestId=identifier(response.headers.get('x-request-id'))
  receipt.model=identifier(payload?.model)||receipt.model
  const createdValue=payload?.created_at ?? payload?.created
  const created=typeof createdValue==='number'?createdValue*1000:NaN
  if(Number.isFinite(created) && created>=started-60_000 && created<=now+60_000)receipt.createdAt=new Date(created).toISOString()
  const usage=payload?.usage && typeof payload.usage==='object' && !Array.isArray(payload.usage) ? payload.usage : undefined
  // Keep the actual counters from either official API wire format. Never estimate
  // tokens from characters, and never mix two partially conflicting formats.
  const responses=usage && ('input_tokens' in usage || 'output_tokens' in usage)
  receipt.inputTokens=count(responses?usage?.input_tokens:usage?.prompt_tokens)
  receipt.outputTokens=count(responses?usage?.output_tokens:usage?.completion_tokens)
  receipt.totalTokens=count(usage?.total_tokens)
  receipt.cachedTokens=count(responses?usage?.input_tokens_details?.cached_tokens:usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens)
  receipt.reasoningTokens=count(responses?usage?.output_tokens_details?.reasoning_tokens:usage?.completion_tokens_details?.reasoning_tokens)
  if(receipt.inputTokens!==null && receipt.cachedTokens!==null && receipt.cachedTokens>receipt.inputTokens)receipt.cachedTokens=null
  if(receipt.reasoningTokens!==null && receipt.outputTokens!==null && receipt.reasoningTokens>receipt.outputTokens)receipt.reasoningTokens=null
  if(receipt.inputTokens!==null && receipt.outputTokens!==null && receipt.totalTokens!==receipt.inputTokens+receipt.outputTokens) {
    // A conflicting total must not become a seemingly exact financial record.
    if(receipt.totalTokens!==null){receipt.inputTokens=null;receipt.outputTokens=null;receipt.cachedTokens=null}
  }
}
