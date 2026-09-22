import {test} from 'node:test'
import assert from 'node:assert/strict'
import {usd,currencyAmount} from '../website/src/admin/money.ts'
import {sumOfficialAmounts} from '../website/src/admin/officialBills.ts'
import {fundingDecimal} from '../website/src/admin/providerFunding.ts'

test('admin money always displays two decimals with exact decimal rounding and carries',()=>{
  for(const [value,expected] of [
    ['20','$20.00'],['19.70','$19.70'],['0.30','$0.30'],['000012.3','$12.30'],
    ['1.005','$1.01'],['2.675','$2.68'],['0.004999999999','$0.00'],['0.005','$0.01'],
    ['9.995','$10.00'],['999999999999.999999999999','$1,000,000,000,000.00'],
    ['123456789123456789.125','$123,456,789,123,456,789.13'],
    ['-1.005','-$1.01'],['-999.995','-$1,000.00'],['-0.004999999999','$0.00'],
    ['-0.000000000001','$0.00'],['-0','$0.00'],['0.000000000001','$0.00']
  ])assert.equal(usd(value),expected,value)
  assert.equal(currencyAmount('999999999999.999999999999','USD'),'USD 1,000,000,000,000.00')
  assert.equal(currencyAmount('-2.675','CNY'),'CNY -2.68')
  assert.equal(currencyAmount('-0.000000000001','CNY'),'CNY 0.00')
})

test('legacy numbers avoid binary toFixed boundary errors and intermediate twelve-place double rounding',()=>{
  for(const [value,expected] of [
    [1.005,'$1.01'],[2.675,'$2.68'],[-1.005,'-$1.01'],[0.0049999999999,'$0.00'],
    [-0.0049999999999,'$0.00'],[0.0050000000001,'$0.01'],[0.1+0.2,'$0.30'],
    [1e-7,'$0.00'],[-5e-7,'$0.00'],[Number.MIN_VALUE,'$0.00'],[-0,'$0.00'],
    [1e21,'$1,000,000,000,000,000,000,000.00']
  ] as const)assert.equal(usd(value),expected,String(value))
  assert.match(usd(Number.MAX_VALUE),/^\$[\d,]+\.00$/)
})

test('unknown, malformed and unsupported values never turn into a zero balance',()=>{
  const object={toString(){throw Error('must not coerce untrusted objects')}}
  for(const value of [null,undefined,NaN,Infinity,-Infinity,'',' ','1e-3','NaN','Infinity','1,000.00','+1','.5','1.','0.0000000000001',true,false,[],{},object]){
    assert.equal(usd(value),'待核算')
    assert.equal(currencyAmount(value,'USD'),'待核对')
  }
  assert.equal(currencyAmount(1.23,'USD'),'待核对')
  for(const currency of ['EUR','usd',null,undefined,{},['USD']])assert.equal(currencyAmount('1',currency),'待核对')
})

test('presentation never truncates ledger values or rounds before totals and funding differences',()=>{
  const ledger=Object.freeze({topUps:'20.000000000001',balance:'19.999999999999',items:Object.freeze(['0.0049','0.0049'])})
  const before=JSON.stringify(ledger)
  assert.equal(usd(ledger.topUps),'$20.00');assert.equal(currencyAmount(ledger.balance,'USD'),'USD 20.00')
  assert.equal(fundingDecimal(ledger.topUps)!-fundingDecimal(ledger.balance)!,2n)
  assert.equal(sumOfficialAmounts([...ledger.items]),'0.0098')
  assert.equal(usd(sumOfficialAmounts([...ledger.items])),'$0.01')
  assert.deepEqual(ledger.items.map(usd),['$0.00','$0.00'])
  assert.equal(JSON.stringify(ledger),before)
})
