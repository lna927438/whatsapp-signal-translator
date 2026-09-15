/** Preserve decimal ledger strings through display; round only numeric legacy inputs. */
export function usd(value:unknown):string {
  if(value===null||value===undefined)return '待核算'
  let text=String(value)
  if(typeof value==='number'){
    if(!Number.isFinite(value))return '待核算'
    text=value.toFixed(12)
  }
  const match=/^(-?)(\d+)(?:\.(\d{1,12}))?$/.exec(text)
  if(!match)return '待核算'
  const fraction=(match[3]||'').replace(/0+$/,'').padEnd(2,'0')
  return `${match[1]}$${match[2].replace(/^0+(?=\d)/,'').replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${fraction}`
}

/** Official balances arrive as decimal strings. Never coerce them to Number. */
export function currencyAmount(value:unknown,currency:unknown):string {
  if(typeof value!=='string'||!['USD','CNY'].includes(String(currency)))return '待核对'
  const match=/^(-?)(\d+)(?:\.(\d{1,12}))?$/.exec(value)
  if(!match)return '待核对'
  const fraction=(match[3]||'').replace(/0+$/,'').padEnd(2,'0')
  return `${currency} ${match[1]}${match[2].replace(/^0+(?=\d)/,'').replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${fraction}`
}
