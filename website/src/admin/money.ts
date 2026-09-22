/** Expand only legacy numeric inputs; exact ledger strings never pass through Number. */
function numberDecimal(value:number):string {
  const text=String(value)
  const match=/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(text)
  if(!match)return text
  const digits=match[2]+(match[3]||''),point=match[2].length+Number(match[4])
  const decimal=point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point)
  return match[1]+decimal
}

/** Display only: round decimal digits to cents, with half cents away from zero.
 * Never use this result for arithmetic, editing, storage, reconciliation or export. */
function displayCents(value:unknown):{sign:string;amount:string}|null {
  if(typeof value!=='string'&&typeof value!=='number')return null
  if(typeof value==='number'&&!Number.isFinite(value))return null
  const text=typeof value==='number'?numberDecimal(value):value
  const match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  // Preserve the server's exact-string contract; legacy numbers may expand further.
  if(!match||typeof value==='string'&&(match[3]?.length||0)>12)return null
  const fraction=match[3]||''
  let cents=BigInt(match[2])*100n+BigInt(fraction.slice(0,2).padEnd(2,'0'))
  if(fraction.length>2&&fraction[2]>='5')cents+=1n
  const whole=(cents/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',')
  return {sign:match[1]&&cents!==0n?'-':'',amount:`${whole}.${(cents%100n).toString().padStart(2,'0')}`}
}

/** Shared admin presentation: always two decimals; unknown values remain unknown. */
export function usd(value:unknown):string {
  const display=displayCents(value)
  return display?`${display.sign}$${display.amount}`:'待核算'
}

/** Official balances retain their original decimal strings outside presentation. */
export function currencyAmount(value:unknown,currency:unknown):string {
  if(typeof value!=='string'||currency!=='USD'&&currency!=='CNY')return '待核对'
  const display=displayCents(value)
  return display?`${currency} ${display.sign}${display.amount}`:'待核对'
}
