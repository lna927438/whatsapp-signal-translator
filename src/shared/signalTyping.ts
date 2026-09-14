export type SignalTyping = { account: string; peer: string; sender: string; started: boolean; expiresAt: number; timestamp: number }
export function readSignalTyping(account:string,envelope:any,now=Date.now()):SignalTyping|undefined {
  const value=envelope?.typingMessage, sender=envelope?.sourceNumber || envelope?.sourceUuid || envelope?.source
  if(!account || typeof sender!=='string' || !value || !['STARTED','STOPPED'].includes(value.action) || !Number.isSafeInteger(value.timestamp))return
  if(value.timestamp<now-15000 || value.timestamp>now+60000)return
  if(value.groupId!==undefined && (typeof value.groupId!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.groupId)))return
  return {account,peer:value.groupId?'group:'+value.groupId:sender.replace(/^aci:/,''),sender:sender.replace(/^aci:/,''),started:value.action==='STARTED',expiresAt:Math.min(now+15000,value.timestamp+15000),timestamp:value.timestamp}
}
export class SignalTypingState {
  private values=new Map<string,SignalTyping>()
  update(value:SignalTyping) { const key=JSON.stringify([value.account,value.peer,value.sender]),prior=this.values.get(key);if(prior&&prior.timestamp>value.timestamp)return;this.values.set(key,value) }
  snapshot(now=Date.now()) { for(const [key,value] of this.values)if(value.expiresAt<=now)this.values.delete(key);return [...this.values.values()].filter(value=>value.started) }
  clear() { this.values.clear() }
}
