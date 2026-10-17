<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { ChartNoAxesCombined, ClipboardList, LayoutDashboard, PackageOpen, Settings } from '@lucide/vue'

const route = useRoute()
</script>

<template>
  <div class="app-shell">
    <aside class="side-rail">
      <RouterLink class="brand" to="/" aria-label="Pikalog overview">
        <img class="brand-mark" src="/favicon.svg" alt="" aria-hidden="true">
        <span class="brand-name">pikalog</span>
      </RouterLink>

      <div class="rail-section-label">WORKSPACE</div>
      <nav class="primary-nav" aria-label="Main navigation">
        <RouterLink
          to="/#overview"
          class="nav-link"
          :class="{ 'nav-link--active': route.name === 'home' && (!route.hash || route.hash === '#overview') }"
          :aria-current="route.name === 'home' && (!route.hash || route.hash === '#overview') ? 'page' : undefined"
        >
          <LayoutDashboard :size="18" :stroke-width="1.8" />
          <span>Overview</span>
        </RouterLink>
        <RouterLink
          to="/inventory"
          class="nav-link"
          :class="{ 'nav-link--active': route.name === 'inventory' }"
          :aria-current="route.name === 'inventory' ? 'page' : undefined"
        >
          <PackageOpen :size="18" :stroke-width="1.8" />
          <span>Inventory</span>
        </RouterLink>
        <RouterLink
          to="/activity"
          class="nav-link"
          :class="{ 'nav-link--active': route.name === 'activity' }"
          :aria-current="route.name === 'activity' ? 'page' : undefined"
        >
          <ClipboardList :size="18" :stroke-width="1.8" />
          <span>Activity</span>
        </RouterLink>
        <RouterLink
          to="/outlook"
          class="nav-link"
          :class="{ 'nav-link--active': route.name === 'outlook' }"
          :aria-current="route.name === 'outlook' ? 'page' : undefined"
        >
          <ChartNoAxesCombined :size="18" :stroke-width="1.8" />
          <span>Outlook</span>
        </RouterLink>
        <RouterLink
          to="/configuration"
          class="nav-link"
          :class="{ 'nav-link--active': route.name === 'configuration' }"
          :aria-current="route.name === 'configuration' ? 'page' : undefined"
        >
          <Settings :size="18" :stroke-width="1.8" />
          <span>Configuration</span>
        </RouterLink>
      </nav>

      <div class="rail-footer" id="about">
        <span class="privacy-mark" aria-hidden="true"></span>
        <p>Your inventory stays in your Cloudflare account.</p>
      </div>
    </aside>

    <main class="main-panel">
      <RouterView />
    </main>
  </div>
</template>
