import { createApp,createSSRApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import HomeView from './views/HomeView.vue'
import AuthView from './views/AuthView.vue'
import AccountView from './views/AccountView.vue'
import DownloadView from './views/DownloadView.vue'
import GuideView from './views/GuideView.vue'
import UpdatesView from './views/UpdatesView.vue'
import './style.css'
import './auth-recovery.css'
import './hellodog.css'
import './knowledge.css'
import {updatePageSeo} from './seo'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/admin/:section?', component: () => import('./admin/AdminView.vue') },
    { path: '/security-check', component: () => import('./views/SecurityCheckView.vue') },
    { path: '/', component: HomeView },
    { path: '/login', component: AuthView },
    { path: '/account', component: AccountView },
    { path: '/download', component: DownloadView },
    { path: '/guide', component: GuideView },
    { path: '/updates', component: UpdatesView }
  ],
  scrollBehavior: to => to.hash ? { el: to.hash, top: 105 } : { top: 0 }
})

router.afterEach(to=>updatePageSeo(to.path))
const app=(document.getElementById('app')?.hasAttribute('data-prerender')?createSSRApp:createApp)(App)
app.use(router)
void router.isReady().then(()=>app.mount('#app'))
