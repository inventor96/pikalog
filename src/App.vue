<script setup lang="ts">
import { RouterView } from 'vue-router'
import { Boxes, ChartNoAxesCombined, ClipboardList, LayoutDashboard } from '@lucide/vue'
</script>

<template>
  <div class="app-shell">
    <aside class="side-rail">
      <a class="brand" href="#overview" aria-label="Pikalog overview">
        <span class="brand-mark" aria-hidden="true">p</span>
        <span class="brand-name">pikalog</span>
      </a>

      <div class="rail-section-label">WORKSPACE</div>
      <nav class="primary-nav" aria-label="Main navigation">
        <a class="nav-link nav-link--active" href="#overview">
          <LayoutDashboard :size="18" :stroke-width="1.8" />
          <span>Overview</span>
        </a>
        <a class="nav-link" href="#categories">
          <Boxes :size="18" :stroke-width="1.8" />
          <span>Categories</span>
        </a>
        <a class="nav-link" href="#activity">
          <ClipboardList :size="18" :stroke-width="1.8" />
          <span>Activity</span>
        </a>
        <a class="nav-link" href="#outlook">
          <ChartNoAxesCombined :size="18" :stroke-width="1.8" />
          <span>Outlook</span>
        </a>
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
