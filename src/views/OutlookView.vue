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
  excludedUnits: number
  softExpiryRiskUnits: number
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
  nextPickAtRisk: boolean
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
            <span class="forecast-measure-label">Category / stock</span>
            <strong>{{ forecast.categoryName }}</strong>
            <span>{{ forecast.stockUnits }} forecast-eligible units · {{ forecast.activeUnits }} active</span>
          </div>
          <div class="forecast-measure">
            <span class="forecast-measure-label">Estimated run-out</span>
            <strong>{{ forecast.runOutDate ? formatShortDate(forecast.runOutDate) : '—' }}</strong>
            <span>{{ forecast.stockDays === null ? 'duration unavailable' : `${Math.ceil(forecast.stockDays)} estimated days` }}</span>
          </div>
          <div class="forecast-measure">
            <span class="forecast-measure-label">Next to use</span>
            <strong>{{ forecast.nextPickProduct ?? 'No pick' }}</strong>
            <span>{{ forecast.nextPick === 'filler' ? `${forecast.fillerSlotsSafe} safe filler slots` : forecast.nextPick === 'hard' ? 'hard-expiry stock first' : 'No pick recommended' }}</span>
            <span v-if="forecast.nextPickAtRisk">Selected soft-expiry item may be used past its date.</span>
          </div>
          <div class="forecast-measure">
            <span class="forecast-measure-label">Expiry waste (units)</span>
            <strong>{{ forecast.wasteForecast.preferred }} / {{ forecast.wasteForecast.tolerated }}</strong>
            <span>recommended / last-chance estimate</span>
          </div>
          <div class="forecast-measure">
            <span class="forecast-measure-label">Quarterly surplus</span>
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
            <li v-if="forecast.expiredUnits">
              {{ forecast.expiredUnits }} past-date units; {{ forecast.excludedUnits }} excluded from forecast
            </li>
            <li v-for="assumption in forecast.assumptions" :key="assumption">{{ assumption }}</li>
          </ul>
        </article>
      </div>
      <p v-else class="activity-note">Receive stock to see run-out and expiry-aware pick estimates.</p>
      <p v-if="categoryForecasts.length && includeProjectedReceipts && !hasProjectedReceipts" class="activity-note">
        Projected receipts need two distinct dates after the first receipt date per product.
      </p>
      <aside v-if="categoryForecasts.length" class="forecast-key" aria-label="Forecast metric definitions">
        <p class="eyebrow">HOW TO READ</p>
        <dl>
          <div>
            <dt>Category / stock</dt>
            <dd>Forecast-eligible units on hand; active units are already in use.</dd>
          </div>
          <div>
            <dt>Estimated run-out</dt>
            <dd>Expected date and remaining days, based on estimated product wear.</dd>
          </div>
          <div>
            <dt>Next to use</dt>
            <dd>Expiry-aware pick recommendation; safe filler slots can be used before hard-expiry stock.</dd>
          </div>
          <div class="forecast-key-wide">
            <dt>Expiry waste</dt>
            <dd><strong>Recommended (first number):</strong> Units likely to be wasted if you follow the product's use-by guidance. For "finish by" items, use is scheduled early enough to finish before printed expiry; for "start by" items, it must begin by that date.</dd>
            <dd><strong>Last-chance (second number):</strong> Units likely to be wasted even if you start using them on or before the printed expiry date. This allows "finish by" items to be started later, even if use may continue past expiry.</dd>
            <dd><strong>Why compare them:</strong> The difference shows how many units depend on using stock later than the recommended timing. Use the first number for a stricter rotation plan; the second is a more lenient best case. For "start by" items, the estimates may be the same.</dd>
          </div>
          <div>
            <dt>Quarterly surplus</dt>
            <dd>Projected incoming units minus expected use over 90 days. A dash means rates are unavailable.</dd>
          </div>
        </dl>
      </aside>
    </section>

  </PageLayout>
</template>