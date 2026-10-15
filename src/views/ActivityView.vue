<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { AlertCircle, RefreshCw } from '@lucide/vue'
import { useRouter } from 'vue-router'
import PageLayout from '@/components/PageLayout.vue'

type ActivityEvent = {
  id: number
  type: string
  occurredOn: string
  inferred: number
  productName: string
  unitSerial: string | null
  endReason: string | null
}

type DurationStatistic = {
  productId: number
  productName: string
  sampleCount: number
  meanDays: number | null
  medianDays: number | null
  lastTenMeanDays: number | null
  loggedSampleCount: number
  inferredSampleCount: number
  earlyFailureRate: number | null
}

type Overview = {
  eventCount: number
}

const router = useRouter()
const events = ref<ActivityEvent[]>([])
const durationStats = ref<DurationStatistic[]>([])
const overview = ref<Overview | null>(null)
const isLoading = ref(false)
const errorMessage = ref('')

function activityLabel(type: string): string {
  switch (type) {
    case 'received': return 'Received'
    case 'opened': return 'Opened package'
    case 'unit_started': return 'Started unit'
    case 'unit_ended': return 'Ended unit'
    case 'discarded': return 'Discarded'
    default: return 'Stock adjusted'
  }
}

async function loadActivity() {
  isLoading.value = true
  errorMessage.value = ''
  try {
    const [activityResponse, overviewResponse] = await Promise.all([
      fetch('/api/activity'),
      fetch('/api/overview'),
    ])
    if (!activityResponse.ok || !overviewResponse.ok) {
      if (activityResponse.status === 401 || overviewResponse.status === 401) {
        await router.replace({ name: 'login' })
        return
      }
      throw new Error('Could not load activity.')
    }
    const [activityData, overviewData] = await Promise.all([
      activityResponse.json() as Promise<{ events: ActivityEvent[]; durationStats: DurationStatistic[] }>,
      overviewResponse.json() as Promise<Overview>,
    ])
    events.value = activityData.events
    durationStats.value = activityData.durationStats
    overview.value = overviewData
  } catch {
    errorMessage.value = 'Activity could not be loaded. Try again.'
  } finally {
    isLoading.value = false
  }
}

onMounted(loadActivity)
</script>

<template>
  <PageLayout section="ACTIVITY" eyebrow="EVENT HISTORY" title="Recent activity" class="activity-page">
    <template #actions>
      <button class="refresh-button" type="button" :disabled="isLoading" @click="loadActivity">
        <RefreshCw :size="16" :class="{ 'is-spinning': isLoading }" aria-hidden="true" />
        <span>Refresh</span>
      </button>
    </template>

    <div v-if="errorMessage" class="load-error" role="alert">
      <AlertCircle :size="17" aria-hidden="true" />
      <span>{{ errorMessage }}</span>
      <button type="button" @click="loadActivity">Retry</button>
    </div>

    <section class="ledger-section activity-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">WEAR HISTORY</p>
          <h2>Duration statistics</h2>
        </div>
        <span class="section-count">{{ durationStats.length }} PRODUCTS</span>
      </div>
      <div v-if="isLoading && durationStats.length === 0" class="category-loading" aria-live="polite">
        <span class="status-dot"></span>Loading duration statistics
      </div>
      <div v-else-if="durationStats.length" class="duration-list">
        <article v-for="stat in durationStats" :key="stat.productId" class="duration-row">
          <div class="duration-product">
            <strong>{{ stat.productName }}</strong>
            <span>{{ stat.sampleCount }} completed samples · {{ stat.loggedSampleCount }} logged · {{ stat.inferredSampleCount }} inferred</span>
          </div>
          <div class="duration-measure">
            <span class="duration-value">{{ stat.medianDays ?? '—' }}</span>
            <span>median days</span>
          </div>
          <div class="duration-measure">
            <span class="duration-value">{{ stat.meanDays?.toFixed(1) ?? '—' }}</span>
            <span>mean days</span>
          </div>
          <div class="duration-measure">
            <span class="duration-value">{{ stat.lastTenMeanDays?.toFixed(1) ?? '—' }}</span>
            <span>last 10 mean</span>
          </div>
          <div class="duration-measure">
            <span class="duration-value">{{ stat.earlyFailureRate === null ? '—' : `${Math.round(stat.earlyFailureRate * 100)}%` }}</span>
            <span>early failures</span>
          </div>
        </article>
      </div>
      <p v-else class="activity-note">Completed wear durations will appear after a unit ends or a new unit starts.</p>
    </section>

    <section class="ledger-section activity-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">LEDGER</p>
          <h2>Events</h2>
        </div>
        <span class="section-count">{{ overview ? `${overview.eventCount} EVENTS` : '— EVENTS' }}</span>
      </div>
      <div v-if="isLoading && events.length === 0" class="category-loading" aria-live="polite">
        <span class="status-dot"></span>Loading events
      </div>
      <div v-else-if="events.length" class="event-list" aria-label="Recent ledger events">
        <article v-for="event in events" :key="event.id" class="event-row">
          <span class="event-date">{{ event.occurredOn }}</span>
          <span class="event-type">{{ activityLabel(event.type) }}</span>
          <span class="event-product">{{ event.productName }}<template v-if="event.unitSerial"> · {{ event.unitSerial }}</template></span>
          <span v-if="event.inferred" class="event-reason">Inferred</span>
          <span v-if="event.endReason" class="event-reason">{{ event.endReason.replace('_', ' ') }}</span>
        </article>
      </div>
      <p v-else class="activity-note">No ledger events yet.</p>
    </section>
  </PageLayout>
</template>