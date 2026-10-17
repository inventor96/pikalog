<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { AlertCircle, RefreshCw } from '@lucide/vue'
import { useRouter } from 'vue-router'
import PageLayout from '@/components/PageLayout.vue'
import { formatShortDate } from '@/domain/date-format'

type ActivityEvent = {
  id: number
  type: string
  occurredOn: string
  inferred: number
  productName: string
  unitSerial: string | null
  serial: string | null
  lot: string | null
  endReason: string | null
  undone: number
  undoOfEventId: number | null
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
const undoingId = ref<number | null>(null)

const reversibleTypes = new Set(['received', 'discarded', 'unit_started', 'adjusted'])

function activityLabel(type: string, inferred: number): string {
  if (type === 'discarded' && inferred) return 'Marked used'
  switch (type) {
    case 'received': return 'Received'
    case 'opened': return 'Opened package'
    case 'unit_started': return 'Started unit'
    case 'unit_ended': return 'Ended unit'
    case 'discarded': return 'Discarded'
    default: return 'Stock adjusted'
  }
}

function eventLabel(event: ActivityEvent): string {
  if (event.undoOfEventId === null) return activityLabel(event.type, event.inferred)
  const target = events.value.find((candidate) => candidate.id === event.undoOfEventId)
  return target ? `Undid ${activityLabel(target.type, target.inferred)}` : 'Undid event'
}

function identifierFor(event: ActivityEvent): string {
  return [event.unitSerial ?? event.serial, event.lot].filter(Boolean).join(' · ')
}

function canUndo(event: ActivityEvent): boolean {
  return !event.undone && event.undoOfEventId === null && reversibleTypes.has(event.type)
}

function todayIsoDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

async function undoEvent(event: ActivityEvent) {
  const label = eventLabel(event)
  if (!window.confirm(`Undo "${label}"? A correcting entry will be appended to the ledger.`)) return
  undoingId.value = event.id
  errorMessage.value = ''
  try {
    const response = await fetch(`/api/events/${event.id}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ occurredOn: todayIsoDate() }),
    })
    if (response.status === 401) {
      await router.replace({ name: 'login' })
      return
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { reason?: string } | null
      throw new Error(payload?.reason ?? '')
    }
    await loadActivity()
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    errorMessage.value = reason === 'package_has_history'
      ? 'This receipt cannot be undone because the package has later activity.'
      : reason === 'structural_event'
        ? 'This action cannot be undone.'
        : 'The action could not be undone. Try again.'
  } finally {
    undoingId.value = null
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
          <span class="event-date">{{ formatShortDate(event.occurredOn) }}</span>
          <span class="event-type">{{ eventLabel(event) }}</span>
          <span class="event-product">{{ event.productName }}<template v-if="identifierFor(event)"> · {{ identifierFor(event) }}</template></span>
          <span v-if="event.inferred" class="event-reason">Inferred</span>
          <span v-if="event.endReason" class="event-reason">{{ event.endReason.replace('_', ' ') }}</span>
          <span v-if="event.undone" class="event-undone">Undone</span>
          <button v-if="canUndo(event)" class="event-undo" type="button" :disabled="undoingId !== null" @click="undoEvent(event)">Undo</button>
        </article>
      </div>
      <p v-else class="activity-note">No ledger events yet.</p>
    </section>
  </PageLayout>
</template>