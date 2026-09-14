import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createRouter,createMemoryHistory } from 'vue-router'
import App from './App.vue'
import HomeView from './views/HomeView.vue'
import DownloadView from './views/DownloadView.vue'
import GuideView from './views/GuideView.vue'
import UpdatesView from './views/UpdatesView.vue'
import {publicPages} from './seo'
export { pageSeo,structuredData,siteOrigin,publicPages } from './seo'
export async function render(path:string){
  if(!publicPages.some(page=>page.path===path))throw new Error('Only public pages can be prerendered')
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:HomeView},{path:'/download',component:DownloadView},{path:'/guide',component:GuideView},{path:'/updates',component:UpdatesView},{path:'/login',component:{render:()=>null}},{path:'/account',component:{render:()=>null}}]})
  const app=createSSRApp(App);app.use(router);await router.push(path);await router.isReady();return renderToString(app)
}
