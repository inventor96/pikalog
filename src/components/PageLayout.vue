<script setup lang="ts">
import { ref } from 'vue'
import { AlertCircle, LogOut } from '@lucide/vue'
import { useRouter } from 'vue-router'

defineProps<{
  section: string
  eyebrow: string
  title: string
  detail?: string
}>()

const router = useRouter()
const isSigningOut = ref(false)
const signOutError = ref('')

async function signOut() {
  isSigningOut.value = true
  signOutError.value = ''
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST' })
    if (!response.ok) throw new Error('Could not sign out.')
    await router.replace({ name: 'login' })
  } catch {
    signOutError.value = 'Could not sign out. Check the connection and try again.'
  } finally {
    isSigningOut.value = false
  }
}
</script>

<template>
  <div class="overview-page">
    <header class="topbar">
      <div class="breadcrumb"><span>PIKALOG</span><span class="breadcrumb-divider">/</span><span>{{ section }}</span></div>
      <div class="topbar-status">
        <button class="signout-button" type="button" :disabled="isSigningOut" @click="signOut">
          <LogOut :size="14" aria-hidden="true" />
          <span>{{ isSigningOut ? 'Signing out' : 'Sign out' }}</span>
        </button>
      </div>
    </header>

    <div v-if="signOutError" class="load-error" role="alert">
      <AlertCircle :size="17" aria-hidden="true" />
      <span>{{ signOutError }}</span>
    </div>

    <section class="page-intro">
      <div>
        <p class="eyebrow">{{ eyebrow }}</p>
        <h1>{{ title }}</h1>
        <p v-if="detail" class="date-line">{{ detail }}</p>
      </div>
      <div v-if="$slots.actions" class="page-actions">
        <slot name="actions" />
      </div>
    </section>

    <slot />

    <footer class="disclaimer">
      <span>Not a medical device. Projections are estimates; follow the manufacturer's instructions for use.</span>
      <a href="https://github.com/inventor96/pikalog" target="_blank" rel="noreferrer">Pikalog on GitHub</a>
    </footer>
  </div>
</template>