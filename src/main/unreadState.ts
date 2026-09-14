/** Platform counts are snapshots, never increments derived from translation events. */
export class UnreadState {
  private counts = new Map<string,number>()
  set(id: string, count: number) {
    if (!id || !Number.isSafeInteger(count) || count < 0 || count > 99999) return false
    const previous = this.counts.get(id)
    this.counts.set(id,count)
    return previous !== undefined && count > previous
  }
  snapshot() { return Object.fromEntries(this.counts) }
  get total() { return [...this.counts.values()].reduce((sum,count) => sum + count,0) }
  remove(id?: string) { if (id) this.counts.delete(id); else this.counts.clear() }
}

/** BGRA bitmap for Windows taskbar/tray; no font, file or network dependency. */
export function unreadBitmap(count: number, size = 32): Buffer {
  const bytes = Buffer.alloc(size * size * 4)
  const set = (x:number,y:number,white=false) => { if (x<0||y<0||x>=size||y>=size)return; const i=(y*size+x)*4; bytes[i]=white?255:74;bytes[i+1]=white?255:65;bytes[i+2]=white?255:220;bytes[i+3]=255 }
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)if((x-size/2+.5)**2+(y-size/2+.5)**2<(size/2-1)**2)set(x,y)
  const glyphs:Record<string,string[]> = {
    '0':['111','101','101','101','111'],'1':['010','110','010','010','111'],'2':['111','001','111','100','111'],
    '3':['111','001','111','001','111'],'4':['101','101','111','001','001'],'5':['111','100','111','001','111'],
    '6':['111','100','111','101','111'],'7':['111','001','010','010','010'],'8':['111','101','111','101','111'],
    '9':['111','101','111','001','111'],'+':['000','010','111','010','000']
  }
  const label = count > 99 ? '99+' : String(Math.max(0,count)), scale=label.length>2?2:3
  const left=Math.floor((size-(label.length*4-1)*scale)/2),top=Math.floor((size-5*scale)/2)
  Array.from(label).forEach((digit,index)=>glyphs[digit].forEach((row,y)=>Array.from(row).forEach((pixel,x)=>{if(pixel==='1')for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++)set(left+(index*4+x)*scale+dx,top+y*scale+dy,true)})))
  return bytes
}
