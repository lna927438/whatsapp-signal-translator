export function percentile95(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a,b)=>a-b)
  return Math.round(sorted[Math.ceil(sorted.length*.95)-1])
}
export class PerformanceSamples {
  private switches: number[] = []
  private samples: Array<{at:number;memory:number;cpu:number;accounts:number}> = []
  switch(ms: number) { if(Number.isFinite(ms)&&ms>=0) { this.switches.push(ms);if(this.switches.length>500)this.switches.shift() } }
  record(memory: number, cpu: number, accounts: number, at = Date.now()) {
    const last = this.samples.at(-1)
    if (!last || at-last.at>=30000 || last.accounts!==accounts) {
      this.samples.push({at,memory,cpu,accounts})
      if(this.samples.length>2880)this.samples.shift()
    }
    const same = this.samples.filter(item=>item.accounts===accounts)
    const baseline = same.find(item=>item.at-same[0].at>=300000)
    return { switchP95Ms:percentile95(this.switches),switchSamples:this.switches.length,
      samples:this.samples.length,observedMinutes: Math.floor(((last?.at || at)-(this.samples[0]?.at || at))/60000),
      accountCount:accounts,peakMemoryMiB:Math.max(...same.map(item=>item.memory)),cpuP95:percentile95(same.map(item=>item.cpu)),
      baselineMemoryMiB:baseline?.memory??null,memoryGrowthPercent:baseline&&baseline.memory>0?Math.round((memory/baseline.memory-1)*1000)/10:null }
  }
}
