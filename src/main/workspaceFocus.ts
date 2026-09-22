export type WorkspaceFocusResult={state:string;[key:string]:unknown}
export type WorkspaceFocusLease={current:()=>boolean;retarget:(key:string)=>boolean}
type Selection={key:string;cancel:()=>void;cancelled:Promise<WorkspaceFocusResult>}

/** Navigation commits synchronously; a slow page never owns the next selection. */
export class WorkspaceFocus {
  private selection?:Selection
  constructor(private readonly hide:()=>void,private readonly alive:()=>boolean,private readonly timeoutMs=5000){}
  isCurrent(key:string):boolean{return this.alive()&&this.selection?.key===key}
  invalidate():void{
    this.selection?.cancel();this.selection=undefined
    if(this.alive())this.hide()
  }
  select(key:string,action:(lease:WorkspaceFocusLease)=>Promise<WorkspaceFocusResult>):Promise<WorkspaceFocusResult>{
    this.invalidate()
    if(!this.alive())return Promise.resolve({state:'cancelled'})
    let cancel!:()=>void
    const cancelled=new Promise<WorkspaceFocusResult>(resolve=>{cancel=()=>resolve({state:'cancelled'})})
    const selection={key,cancel,cancelled};this.selection=selection
    return this.run(selection,action)
  }
  runCurrent(key:string,action:(lease:WorkspaceFocusLease)=>Promise<WorkspaceFocusResult>):Promise<WorkspaceFocusResult>{
    const selection=this.selection
    return selection&&this.isCurrent(key)?this.run(selection,action):Promise.resolve({state:'cancelled'})
  }
  private async run(selection:Selection,action:(lease:WorkspaceFocusLease)=>Promise<WorkspaceFocusResult>):Promise<WorkspaceFocusResult>{
    const current=()=>this.alive()&&this.selection===selection
    let timer:ReturnType<typeof setTimeout>|undefined
    const retarget=(key:string)=>{if(!current())return false;selection.key=key;return true}
    const work=Promise.resolve().then(()=>current()?action({current,retarget}):{state:'cancelled'}).then(
      result=>current()?result:{state:'cancelled'},error=>{if(!current())return {state:'cancelled'};throw error})
    const waiting=new Promise<WorkspaceFocusResult>(resolve=>{timer=setTimeout(()=>resolve(current()?{state:'loading'}:{state:'cancelled'}),this.timeoutMs)})
    try{return await Promise.race([work,selection.cancelled,waiting])}
    finally{clearTimeout(timer)}
  }
}
