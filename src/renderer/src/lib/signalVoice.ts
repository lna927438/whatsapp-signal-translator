/** Convert browser recording into mono PCM WAV, which does not depend on the
 * receiving phone having a WebM decoder. Recording never leaves this device. */
export async function signalVoiceWav(recording: Blob): Promise<Blob> {
  const decoder = new AudioContext()
  try {
    const decoded = await decoder.decodeAudioData(await recording.arrayBuffer())
    const rate = 24000, length = Math.ceil(decoded.duration * rate)
    if (!length || length > rate * 301) throw new Error('录音时长无效。')
    const offline = new OfflineAudioContext(1,length,rate), source = offline.createBufferSource()
    source.buffer=decoded; source.connect(offline.destination); source.start()
    const samples=(await offline.startRendering()).getChannelData(0), bytes=new Uint8Array(44+samples.length*2), view=new DataView(bytes.buffer)
    const text=(at:number,value:string)=>{for(let i=0;i<value.length;i++)bytes[at+i]=value.charCodeAt(i)}
    text(0,'RIFF'); view.setUint32(4,bytes.length-8,true); text(8,'WAVEfmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true)
    view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true)
    for(let i=0;i<samples.length;i++){const value=Math.max(-1,Math.min(1,samples[i]));view.setInt16(44+i*2,value*(value<0?32768:32767),true)}
    return new Blob([bytes],{type:'audio/wav'})
  } finally { await decoder.close() }
}
