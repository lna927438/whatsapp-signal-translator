import {test} from 'node:test'
import assert from 'node:assert/strict'
import {officialCostCards,unattributedCostRecords,costRecordCount,deepseekOfficialAmount,officialAmount,providerReceipt,receiptCost} from '../website/src/admin/costCards.ts'
import {officialBillDelayed,officialBillNotice,officialBillStatus} from '../website/src/admin/officialBills.ts'
import {costsFixture,officialBillFixture,nativeMonthFixture} from './admin-costs-fixture.ts'
const period={from:'2026-09-01',to:'2026-09-15',timezone:'UTC',provider:''}
function fixture(){const value=costsFixture(period);value.officialBills=[officialBillFixture('deepseek','1.65',value),officialBillFixture('openai','0.05',value)];return value}

test('DeepSeek official display truncates exactly like the verified export, retaining original precision elsewhere',()=>{
 for(const [value,expected] of [['1.658919574','$1.65'],['1.661454678','$1.66'],['9.999999999999','$9.99'],['0001.2','$1.20'],['-1.658919574','-$1.65'],['-0.009','$0.00'],['999999999999.999999999999','$999,999,999,999.99']])assert.equal(deepseekOfficialAmount(value),expected)
 for(const value of [null,undefined,1.658919574,'NaN','1e-3','1.0000000000001'])assert.equal(deepseekOfficialAmount(value),'待核算')
 const data=fixture();data.officialBills[0].official_usd_exact='1.658919574';data.officialBills[1].official_usd_exact='0.005'
 const result=officialCostCards(data,period);assert.equal(result.total,'1.663919574')
 assert.equal(officialAmount(result.items.find(item=>item.provider==='deepseek')!),'$1.65')
 assert.equal(officialAmount(result.items.find(item=>item.provider==='openai')!),'$0.01')
 assert.equal(data.officialBills[0].official_usd_exact,'1.658919574')
})

test('two-channel official headline never uses receipts, a balance delta or a one-channel subtotal',()=>{
 const value=fixture();assert.equal(officialCostCards(value,period).total,'1.7')
 value.officialBills.pop();const partial=officialCostCards(value,period)
 assert.equal(partial.complete,false);assert.equal(partial.total,null);assert.equal(partial.partial,'1.65');assert.deepEqual(partial.missing,['openai'])
 assert.equal(officialCostCards({...value,enabledProviders:['deepseek']},period).complete,false)
 assert.equal(officialCostCards(fixture(),{...period,provider:'deepseek'}).total,null)
 assert.equal(officialCostCards({...value,officialBills:[]},period).partial,null)
})

test('only existing verified current-account native-period bill validation can feed the headline',()=>{
 for(const patch of [{currentAccount:false},{periodComplete:false},{currency:'CNY'},{timezone:'UTC'},{period_from:'2026-09-01T00:00:00Z'},{source:'receipt_estimate'},{official_usd_exact:1.65},{fetched_at:null}]){
  const value=fixture();Object.assign(value.officialBills[0],patch)
  const result=officialCostCards(value,period);assert.equal(result.total,null);assert.equal(result.partial,'0.05');assert.deepEqual(result.missing,['deepseek'])
 }
 const value=fixture();value.officialBills.push({...value.officialBills[0]});assert.equal(officialCostCards(value,period).total,null)
 assert.equal(officialCostCards(fixture(),{...period,to:'2026-09-16'}).partial,null)
 assert.equal(officialCostCards(fixture(),{...period,timezone:'Asia/Shanghai'}).partial,null)
})

test('official true zero remains a complete bill rather than a missing snapshot',()=>{
 const value=fixture();value.officialBills.forEach(row=>{row.official_usd_exact='0'})
 const result=officialCostCards(value,period);assert.equal(result.complete,true);assert.equal(result.total,'0')
})

test('live receipt cards preserve zero only as a known subtotal when pricing is incomplete, and missing data stays unknown',()=>{
 assert.deepEqual(receiptCost({known_cost_usd_exact:'0',unpriced_requests:7}),{amount:'0',pending:7,partial:true})
 assert.deepEqual(receiptCost({known_cost_usd_exact:'1.830000000001',unpriced_requests:0}),{amount:'1.830000000001',pending:0,partial:false})
 for(const row of [undefined,{}, {unpriced_requests:0}, {known_cost_usd_exact:'NaN',unpriced_requests:0}])assert.equal(receiptCost(row).amount,null)
 assert.equal(receiptCost({known_cost_usd_exact:'1.83'}).partial,true)
 assert.equal(providerReceipt({totals:{},providers:undefined},'deepseek'),null)
 assert.deepEqual(receiptCost(providerReceipt({totals:{},providers:[]},'deepseek')),{amount:'0',pending:0,partial:false})
 assert.equal(providerReceipt({totals:{},providers:[{provider:'deepseek'},{provider:'deepseek'}]},'deepseek'),null)
})

test('rereading a manual current-period bill does not renew its freshness or imply automatic sync',()=>{
 const now=Date.parse('2026-09-15T10:00:00Z'),data=fixture();data.snapshotAt=new Date(now).toISOString()
 data.officialBills=[officialBillFixture('deepseek','1.658919574',data)];data.officialBills[0].fetched_at=new Date(now-11*60000).toISOString()
 const official=officialCostCards(data,period,now)
 assert.equal(officialBillDelayed(official,period,now),true)
 assert.match(officialBillNotice(official.items[0],period,now),/手动账单不会自动更新.*重新导入/)
 assert.equal(officialBillDelayed(official,{...period,to:'2026-09-14'},now),false)
 assert.equal(official.items[0].amount,'1.658919574')
 assert.equal(officialBillStatus(official.items[0],period,now),'上次导出金额 · 待更新')
 assert.equal(officialBillStatus({...official.items[0],fetchedAt:new Date(now-60000).toISOString()},period,now),'官方导出快照')
 assert.equal(officialBillStatus(undefined,period,now),'尚未同步')
 assert.equal(officialBillStatus({...official.items[0],provider:'openai',source:'openai_costs_api',timezone:'UTC'},period,now),'同步延迟 · 保留上次金额')
 assert.equal(officialBillStatus({...official.items[0],provider:'openai',source:'openai_costs_api',timezone:'UTC',fetchedAt:new Date(now).toISOString()},period,now),'官方自动同步')
})

test('native month overview matches each official timezone while receipt UTC and arbitrary date filters remain separate',()=>{
 const now=Date.parse('2026-09-30T17:00:00Z'),range={from:'2026-09-01',to:'2026-09-30',timezone:'UTC',provider:'',officialCurrentMonth:'true'}
 const data=nativeMonthFixture(costsFixture(range),now);data.snapshotAt=new Date(now).toISOString()
 data.officialBills=[officialBillFixture('deepseek','0.01',data),officialBillFixture('openai','1.55',data)]
 data.officialBills.forEach(item=>{item.fetched_at=data.snapshotAt})
 const result=officialCostCards(data,range,now)
 assert.equal(result.total,'1.56')
 assert.deepEqual(result.items.map(item=>[item.provider,item.from,item.to]),[['openai','2026-09-01','2026-09-30'],['deepseek','2026-10-01','2026-10-01']])
 assert.equal(data.from,'2026-09-01T00:00:00.000Z','Receipt query remains UTC September')
 assert.equal(officialCostCards(data,{...range,officialCurrentMonth:undefined},now).total,null,'A native current-month response cannot masquerade as an arbitrary selected period')
 const changed=structuredClone(data);(changed.officialBillingBasis as any).periods.deepseek={from:'2026-09-01',to:'2026-09-30',timezone:'Asia/Shanghai'}
 assert.deepEqual(officialCostCards(changed,range,now).missing,['deepseek'])
 const old=costsFixture(range);old.snapshotAt=data.snapshotAt;old.officialBills=[officialBillFixture('deepseek','5',old)];old.officialBills[0].fetched_at=data.snapshotAt
 assert.equal(officialCostCards(old,range,now).total,null,'A server without the native-current-month contract stays explicitly unknown')
})

test('historical unassigned count is a nonnegative safe difference, never inferred from money',()=>{
 const totals={unpriced_requests:536},providers=[{provider:'deepseek',unpriced_requests:466},{provider:'openai',unpriced_requests:57},{provider:null,unpriced_requests:13}]
 assert.equal(unattributedCostRecords(totals,providers),13)
 assert.equal(unattributedCostRecords({unpriced_requests:'536'},providers),13)
 assert.equal(unattributedCostRecords({unpriced_requests:500},providers),0)
 assert.equal(unattributedCostRecords({unpriced_requests:0},[]),0)
 assert.equal(unattributedCostRecords(totals,[...providers,providers[0]]),null)
 assert.equal(unattributedCostRecords(totals,undefined),null)
 for(const value of [undefined,null,'',-1,1.2,NaN,Infinity,'1e2','-1',Number.MAX_SAFE_INTEGER+1]){
  assert.equal(costRecordCount(value),null)
  assert.equal(unattributedCostRecords({unpriced_requests:value},providers),null)
  assert.equal(unattributedCostRecords(totals,[{provider:'deepseek',unpriced_requests:value}]),null)
 }
 assert.equal(unattributedCostRecords({unpriced_requests:Number.MAX_SAFE_INTEGER},[{provider:'deepseek',unpriced_requests:Number.MAX_SAFE_INTEGER},{provider:'openai',unpriced_requests:1}]),null)
})
