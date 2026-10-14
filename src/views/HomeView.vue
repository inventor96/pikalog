<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { AlertCircle, ArrowDownRight, ArrowUpRight, RefreshCw } from '@lucide/vue'

type Category = {
  id: number
  key: string
  name: string
  overlap_allowed: number
}

type Overview = {
  packageCount: number
  eventCount: number
}

const categories = ref<Category[]>([])
const overview = ref<Overview | null>(null)
const isLoading = ref(false)
const errorMessage = ref('')
const refreshedAt = ref('')

const todayLabel = computed(() =>
  new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()),
)

async function loadCategories() {
  isLoading.value = true
  errorMessage.value = ''

  try {
    const [categoriesResponse, overviewResponse] = await Promise.all([
      fetch('/api/categories'),
      fetch('/api/overview'),
    ])
    if (!categoriesResponse.ok || !overviewResponse.ok) {
      throw new Error('Could not load supply categories.')
    }

    const [categoryData, overviewData] = await Promise.all([
      categoriesResponse.json() as Promise<{ categories: Category[] }>,
      overviewResponse.json() as Promise<Overview>,
    ])
    categories.value = categoryData.categories
    overview.value = overviewData
    refreshedAt.value = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date())
  } catch {
    errorMessage.value = 'The inventory service is unavailable. Try refreshing.'
  } finally {
    isLoading.value = false
  }
}

onMounted(loadCategories)
</script>

<template>
  <div id="overview" class="overview-page">
    <header class="topbar">
      <div class="breadcrumb"><span>PIKALOG</span><span class="breadcrumb-divider">/</span><span>OVERVIEW</span></div>
      <div class="topbar-status"><span class="status-dot"></span>Private workspace</div>
    </header>

    <section class="page-intro">
      <div>
        <p class="eyebrow">SUPPLY LEDGER</p>
        <h1>Your supplies, in view.</h1>
        <p class="date-line">{{ todayLabel }}</p>
      </div>
      <button class="refresh-button" type="button" :disabled="isLoading" @click="loadCategories">
        <RefreshCw :size="16" :class="{ 'is-spinning': isLoading }" aria-hidden="true" />
        <span>Refresh</span>
      </button>
    </section>

    <section class="metrics-row" aria-label="Supply summary">
      <div class="metric">
        <div class="metric-label">UNITS ON HAND</div>
        <div class="metric-value metric-value--pending">—</div>
        <div class="metric-note">Awaiting first receipt</div>
      </div>
      <div class="metric">
        <div class="metric-label">RUN-OUT</div>
        <div class="metric-value metric-value--pending">—</div>
        <div class="metric-note">Not enough history yet</div>
      </div>
      <div class="metric">
        <div class="metric-label">NEXT PICK</div>
        <div class="metric-value metric-value--pending">—</div>
        <div class="metric-note">No active inventory</div>
      </div>
    </section>

    <section id="inventory" class="ledger-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">CURRENT STOCK</p>
          <h2>Inventory</h2>
        </div>
        <span class="section-count">{{ overview ? `${overview.packageCount} PACKAGES` : '— PACKAGES' }}</span>
      </div>

      <div v-if="overview?.eventCount === 0" class="empty-ledger">
        <div class="empty-symbol" aria-hidden="true">
          <ArrowDownRight :size="25" :stroke-width="1.5" />
          <ArrowUpRight :size="25" :stroke-width="1.5" />
        </div>
        <div>
          <h3>No supply events yet</h3>
          <p>Once a package is received, its remaining units and expiry will be derived from the ledger.</p>
        </div>
        <span class="empty-code">LEDGER EMPTY</span>
      </div>
      <div v-else-if="overview" class="activity-note">{{ overview.eventCount }} ledger events recorded.</div>
    </section>

    <section id="categories" class="ledger-section category-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">TRACKING SCOPE</p>
          <h2>Supply categories</h2>
        </div>
        <span class="section-count">{{ categories.length }} CATEGORIES</span>
      </div>

      <div v-if="errorMessage" class="load-error" role="alert">
        <AlertCircle :size="17" aria-hidden="true" />
        <span>{{ errorMessage }}</span>
        <button type="button" @click="loadCategories">Retry</button>
      </div>
      <div v-else-if="isLoading && categories.length === 0" class="category-loading" aria-live="polite">
        <span class="status-dot"></span>Loading categories
      </div>
      <div v-else class="category-list">
        <div v-for="(category, index) in categories" :key="category.id" class="category-row">
          <span class="category-index">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="category-name">{{ category.name }}</span>
          <code>{{ category.key }}</code>
          <span class="category-policy">{{ category.overlap_allowed ? 'Overlap allowed' : 'Single active unit' }}</span>
        </div>
      </div>
      <p v-if="refreshedAt" class="refresh-time">Updated {{ refreshedAt }}</p>
    </section>

    <section id="activity" class="ledger-section activity-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">EVENT HISTORY</p>
          <h2>Recent activity</h2>
        </div>
        <span class="section-count">{{ overview ? `${overview.eventCount} EVENTS` : '— EVENTS' }}</span>
      </div>
      <p class="activity-note">Events will appear here as packages are received and units are used.</p>
    </section>

      <section id="outlook" class="ledger-section activity-section">
        <div class="section-heading">
          <div>
            <p class="eyebrow">EXPIRY-AWARE FORECAST</p>
            <h2>Run-out outlook</h2>
          </div>
          <span class="section-count">ESTIMATE</span>
        </div>
        <p class="activity-note">A forecast will be available once supply receipts and usage are recorded.</p>
      </section>

    <footer class="disclaimer">
      <span>Not a medical device. Projections are estimates; follow the manufacturer's instructions for use.</span>
      <a href="https://github.com/inventor96/pikalog" target="_blank" rel="noreferrer">Pikalog on GitHub</a>
    </footer>
  </div>
</template>
