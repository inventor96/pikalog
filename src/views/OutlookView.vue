<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { AlertCircle, RefreshCw } from '@lucide/vue'
import { useRouter } from 'vue-router'
import PageLayout from '@/components/PageLayout.vue'
import { formatShortDate } from '@/domain/date-format'

type CategoryForecast = {
  categoryId: number
  categoryName: string
  stockUnits: number
  activeUnits: number
  expiredUnits: number
  surplusPerQuarter: number | null
  projectedReceipts: Array<{
    productName: string
    arrivalOn: string
    expiry: string | null
    quantity: number
  }>
  stockDays: number | null
  runOutDate: string | null
  nextPick: 'filler' | 'hard' | 'none'
  nextPickProduct: string | null
  fillerSlotsSafe: number
  wasteForecast: { preferred: number; tolerated: number }
  assumptions: string[]
}

const router = useRouter()
const categoryForecasts = ref<CategoryForecast[]>([])
const includeProjectedReceipts = ref(true)
const isLoading = ref(false)
const isSavingProjectionSetting = ref(false)
const errorMessage = ref('')

const hasProjectedReceipts = computed(() => categoryForecasts.value.some((forecast) => forecast.projectedReceipts.length > 0))

function todayIsoDate(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

async function loadOutlook() {
  isLoading.value = true
  errorMessage.value = ''
  try {
    const forecastResponse = await fetch(`/api/forecast?today=${todayIsoDate()}`)
    if (!forecastResponse.ok) {
      if (forecastResponse.status === 401) {
        await router.replace({ name: 'login' })
        return
      }
      throw new Error('Could not load the outlook.')
    }
    const forecastData = await forecastResponse.json() as { categories: CategoryForecast[]; includeProjectedReceipts: boolean }
    categoryForecasts.value = forecastData.categories
    includeProjectedReceipts.value = forecastData.includeProjectedReceipts
  } catch {
    errorMessage.value = 'The outlook could not be loaded. Try again.'
  } finally {
    isLoading.value = false
  }
}

async function saveProjectionSetting(event: Event) {
  const checkbox = event.target as HTMLInputElement
  const previousValue = includeProjectedReceipts.value
  isSavingProjectionSetting.value = true
  errorMessage.value = ''
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeProjectedReceipts: checkbox.checked }),
    })
    if (response.status === 401) {
      await router.replace({ name: 'login' })
      return
    }
    if (!response.ok) throw new Error('Could not save the projection setting.')
    includeProjectedReceipts.value = checkbox.checked
    await loadOutlook()
  } catch {
    checkbox.checked = previousValue
    errorMessage.value = 'Could not save the projection setting. Try again.'
  } finally {
    isSavingProjectionSetting.value = false
  }
}

onMounted(loadOutlook)
</script>

<template>
  <PageLayout section="OUTLOOK" eyebrow="EXPIRY-AWARE FORECAST" title="Run-out outlook" class="outlook-page">
    <template #actions>
      <button class="refresh-button" type="button" :disabled="isLoading" @click="loadOutlook">
        <RefreshCw :size="16" :class="{ 'is-spinning': isLoading }" aria-hidden="true" />
        <span>Refresh</span>
      </button>
    </template>

    <div v-if="errorMessage" class="load-error" role="alert">
      <AlertCircle :size="17" aria-hidden="true" />
      <span>{{ errorMessage }}</span>
      <button type="button" @click="loadOutlook">Retry</button>
    </div>

    <section class="ledger-section activity-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">SUPPLY FORECAST</p>
          <h2>By category</h2>
        </div>
        <div class="forecast-controls">
          <label class="projection-toggle">
            <input
              type="checkbox"
              :checked="includeProjectedReceipts"
              :disabled="isSavingProjectionSetting"
              @change="saveProjectionSetting"
            />
            <span>Include projected receipts</span>
          </label>
        </div>
      </div>

      <div v-if="isLoading && categoryForecasts.length === 0" class="category-loading" aria-live="polite">
        <span class="status-dot"></span>Loading outlook
      </div>
      <div v-else-if="categoryForecasts.length" class="forecast-list">
        <article v-for="forecast in categoryForecasts" :key="forecast.categoryId" class="forecast-row">
          <div class="forecast-category">
            <strong>{{ forecast.categoryName }}</strong>
            <span>{{ forecast.stockUnits }} unstarted units · {{ forecast.activeUnits }} active</span>
          </div>
          <div class="forecast-measure">
            <strong>{{ forecast.runOutDate ? formatShortDate(forecast.runOutDate) : '—' }}</strong>
            <span>{{ forecast.stockDays === null ? 'duration unavailable' : `${Math.ceil(forecast.stockDays)} estimated days` }}</span>
          </div>
          <div class="forecast-measure">
            <strong>{{ forecast.nextPickProduct ?? 'No pick' }}</strong>
            <span>{{ forecast.nextPick === 'filler' ? `${forecast.fillerSlotsSafe} safe filler slots` : forecast.nextPick === 'hard' ? 'hard-expiry stock first' : 'no unexpired stock' }}</span>
          </div>
          <div class="forecast-measure">
            <strong>{{ forecast.wasteForecast.preferred }} / {{ forecast.wasteForecast.tolerated }}</strong>
            <span>preferred / tolerated waste</span>
          </div>
          <div class="forecast-measure">
            <strong>{{ forecast.surplusPerQuarter === null ? '—' : forecast.surplusPerQuarter.toFixed(1) }}</strong>
            <span>
              {{ forecast.wasteForecast.preferred > 0 && forecast.fillerSlotsSafe === 0 && (forecast.surplusPerQuarter ?? 0) > 0
                ? 'Supply outpaces use per quarter'
                : 'estimated surplus units per quarter' }}
            </span>
          </div>
          <div v-if="forecast.projectedReceipts.length" class="projected-receipt-list">
            <span class="projected-receipt-label">ESTIMATED ARRIVALS</span>
            <span v-for="receipt in forecast.projectedReceipts" :key="`${receipt.productName}-${receipt.arrivalOn}`">
              {{ formatShortDate(receipt.arrivalOn) }} · {{ receipt.productName }} × {{ receipt.quantity }}<template v-if="receipt.expiry"> · expiry {{ formatShortDate(receipt.expiry) }}</template>
            </span>
          </div>
          <ul v-if="forecast.assumptions.length || forecast.expiredUnits" class="forecast-assumptions">
            <li v-if="forecast.expiredUnits">{{ forecast.expiredUnits }} expired units excluded</li>
            <li v-for="assumption in forecast.assumptions" :key="assumption">{{ assumption }}</li>
          </ul>
        </article>
      </div>
      <p v-else class="activity-note">Receive stock to see run-out and expiry-aware pick estimates.</p>
      <p v-if="categoryForecasts.length && includeProjectedReceipts && !hasProjectedReceipts" class="activity-note">
        Projected receipts need two distinct dates after the first receipt date per product.
      </p>
    </section>

  </PageLayout>
</template>