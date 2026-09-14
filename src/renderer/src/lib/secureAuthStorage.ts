import type { KeyStorage } from './authStorage'
interface SecureBridge { authStorageGet(key:string):Promise<string|null>;authStorageSet(key:string,value:string|null):Promise<void> }
const preferenceKey='translator-remember-login'
export class SecureAuthStorage {
  private keys=new Set<string>()
  constructor(private persistent:KeyStorage,private temporary:KeyStorage,private bridge:SecureBridge){}
  setRemember(remember:boolean){this.persistent.setItem(preferenceKey,String(remember))}
  async getItem(key:string):Promise<string|null>{
    this.keys.add(key)
    const temporary=this.temporary.getItem(key)
    if(temporary!==null)return temporary
    const secure=await this.bridge.authStorageGet(key)
    if(secure!==null){this.persistent.removeItem(key);return secure}
    const legacy=this.persistent.getItem(key)
    if(legacy!==null){await this.bridge.authStorageSet(key,legacy);this.persistent.removeItem(key)}
    return legacy
  }
  async setItem(key:string,value:string){
    this.keys.add(key)
    if(this.persistent.getItem(preferenceKey)==='false'){
      this.temporary.setItem(key,value);await this.bridge.authStorageSet(key,null)
    }else{await this.bridge.authStorageSet(key,value);this.temporary.removeItem(key)}
    this.persistent.removeItem(key)
  }
  async removeItem(key:string){this.keys.add(key);await this.bridge.authStorageSet(key,null);this.persistent.removeItem(key);this.temporary.removeItem(key)}
  async clearSession(){for(const key of this.keys)await this.removeItem(key)}
}
