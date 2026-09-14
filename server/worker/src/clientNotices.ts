export async function noticeReceiptBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return null
  const reader=request.body?.getReader();if(!reader)return null
  const chunks:Uint8Array[]=[];let length=0
  try { while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>1024){await reader.cancel();return null}chunks.push(value)} }
  finally {reader.releaseLock()}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  try {
    const value=JSON.parse(new TextDecoder().decode(bytes))
    if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='id,revision,state'
      ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
      ||!Number.isSafeInteger(value.revision)||value.revision<1||value.revision>2147483647||!['displayed','dismissed'].includes(value.state))return null
    return {id:String(value.id),revision:Number(value.revision),state:String(value.state)}
  }catch{return null}
}
