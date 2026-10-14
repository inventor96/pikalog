import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import LoginView from '../views/LoginView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
    {
      path: '/login',
      name: 'login',
      component: LoginView,
    },
  ],
})

router.beforeEach(async (to) => {
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store' })
    if (!response.ok) throw new Error('Could not check the session.')
    const session = await response.json() as { configured: boolean; authenticated: boolean }

    if (!session.configured || !session.authenticated) {
      return to.name === 'login'
        ? true
        : { name: 'login', query: to.name === 'login' ? undefined : { redirect: to.fullPath } }
    }

    if (to.name === 'login') {
      const redirect = to.query.redirect
      return typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//') && redirect !== '/login'
        ? redirect
        : { name: 'home' }
    }
    return true
  } catch {
    return to.name === 'login' ? true : { name: 'login' }
  }
})

export default router
