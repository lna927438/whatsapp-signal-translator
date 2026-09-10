import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import HomeView from './views/HomeView.vue'
import AuthView from './views/AuthView.vue'
import AccountView from './views/AccountView.vue'
import DownloadView from './views/DownloadView.vue'
import './style.css'
import './auth-recovery.css'
import './hellodog.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: HomeView },
    { path: '/login', component: AuthView },
    { path: '/account', component: AccountView },
    { path: '/download', component: DownloadView }
  ],
  scrollBehavior: () => ({ top: 0 })
})

createApp(App).use(router).mount('#app')
