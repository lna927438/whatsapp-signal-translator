export function balanceRpcResponse(url:string,body:string){
 if(!/\/(claim|finish)_deepseek_balance_refresh$/.test(url))return null
 const args=JSON.parse(body),result=args.p_result,at=new Date().toISOString()
 return Response.json({provider:'deepseek',available:result?.available??null,balances:result?.balances??[],fetchedAt:result?.fetchedAt??null,snapshotAt:result?.fetchedAt??null,checkedAt:at,stale:!result,
  sync:{status:args.p_error?'error':result?'fresh':'refreshing',lastAttemptAt:at,lastError:args.p_error??null,lastErrorAt:args.p_error?at:null,nextRefreshAt:at,refreshIntervalSeconds:30,staleAfterSeconds:120},
  ...(url.endsWith('/claim_deepseek_balance_refresh')?{claimed:true}:{})})
}
