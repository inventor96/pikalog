<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { AlertCircle, ArrowDownRight, ArrowUpRight, Camera, LogOut, RefreshCw, X } from '@lucide/vue'
import { useRouter } from 'vue-router'
import BarcodeScanner from '@/components/BarcodeScanner.vue'
import type { BarcodeParseResult } from '@/barcode/ingest'

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

type ActivityEvent = {
  id: number
  type: string
  occurredOn: string
  qty: number
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
  lastTenMedianDays: number | null
  loggedSampleCount: number
  inferredSampleCount: number
  earlyFailureRate: number | null
}

type Product = {
  id: number
  category_id: number
  category_name: string
  manufacturer: string
  name: string
  gtin: string | null
  contains_product_id: number | null
  contains_qty: number | null
  rated_wear_days: number | null
  min_samples: number
  expiry_rule: 'finish_by' | 'start_by' | 'none'
  expiry_strictness: 'hard' | 'soft'
}

type InventoryPackage = {
  id: number
  product_id: number
  lot: string | null
  serial: string | null
  expiry: string | null
  manufacturer: string
  product_name: string
  gtin: string | null
  contains_qty: number | null
  units_remaining: number
  category_name: string
  received_on: string
  is_open: number
}

const categories = ref<Category[]>([])
const products = ref<Product[]>([])
const overview = ref<Overview | null>(null)
const packages = ref<InventoryPackage[]>([])
const activityEvents = ref<ActivityEvent[]>([])
const durationStats = ref<DurationStatistic[]>([])
const isLoading = ref(false)
const errorMessage = ref('')
const scanNotice = ref('')
const refreshedAt = ref('')
const scannerOpen = ref(false)
const isRescanningReceipt = ref(false)
const receiptDialogOpen = ref(false)
const scannedBarcode = ref<BarcodeParseResult | null>(null)
const matchedProduct = ref<Product | null>(null)
const categoryId = ref('')
const manufacturer = ref('')
const productName = ref('')
const containsQty = ref('1')
const containsProductId = ref('')
const ratedWearDays = ref('')
const expiryRule = ref<'finish_by' | 'start_by' | 'none'>('finish_by')
const expiryStrictness = ref<'hard' | 'soft'>('hard')
const receiptLot = ref('')
const receiptSerial = ref('')
const receiptExpiry = ref('')
const receivedOn = ref(todayIsoDate())
const isSavingReceipt = ref(false)
const receiptError = ref('')
const openingPackageId = ref<number | null>(null)
const isSigningOut = ref(false)
const router = useRouter()

function todayIsoDate(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const todayLabel = computed(() =>
  new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()),
)
const unitsOnHand = computed(() => packages.value.reduce((total, pkg) => total + pkg.units_remaining, 0))
const containedProducts = computed(() => products.value.filter((product) =>
  product.category_id === Number(categoryId.value) && product.contains_product_id === null,
))
const hasScanProblem = computed(() => {
  const result = scannedBarcode.value
  return result?.kind === 'invalid'
    || result?.kind === 'unknown'
    || (result?.kind === 'gs1' && result.warnings.length > 0)
})

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

async function loadDashboard() {
  isLoading.value = true
  errorMessage.value = ''

  try {
    const [categoriesResponse, productsResponse, overviewResponse, inventoryResponse, activityResponse] = await Promise.all([
      fetch('/api/categories'),
      fetch('/api/products'),
      fetch('/api/overview'),
      fetch('/api/inventory'),
      fetch('/api/activity'),
    ])
    if (!categoriesResponse.ok || !productsResponse.ok || !overviewResponse.ok || !inventoryResponse.ok || !activityResponse.ok) {
      if ([categoriesResponse.status, productsResponse.status, overviewResponse.status, inventoryResponse.status, activityResponse.status].includes(401)) {
        await router.replace({ name: 'login' })
        return
      }
      throw new Error('Could not load the inventory.')
    }

    const [categoryData, productData, overviewData, inventoryData, activityData] = await Promise.all([
      categoriesResponse.json() as Promise<{ categories: Category[] }>,
      productsResponse.json() as Promise<{ products: Product[] }>,
      overviewResponse.json() as Promise<Overview>,
      inventoryResponse.json() as Promise<{ packages: InventoryPackage[] }>,
      activityResponse.json() as Promise<{ events: ActivityEvent[]; durationStats: DurationStatistic[] }>,
    ])
    categories.value = categoryData.categories
    products.value = productData.products
    overview.value = overviewData
    packages.value = inventoryData.packages
    activityEvents.value = activityData.events
    durationStats.value = activityData.durationStats
    if (!categoryId.value && categories.value[0]) categoryId.value = String(categories.value[0].id)
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

async function handleBarcodeDetected(result: BarcodeParseResult, mode: 'receive' | 'open') {
  scannerOpen.value = false
  scanNotice.value = ''
  if (isRescanningReceipt.value) {
    await applyReceiptRescan(result)
    return
  }
  if (mode === 'open') {
    if (result.kind !== 'gs1' || !result.fields.gtin) {
      scanNotice.value = 'This code does not identify a received package. Open the package from inventory instead.'
      return
    }
    const productPackages = packages.value.filter((pkg) => pkg.gtin === result.fields.gtin)
    const identityMatches = productPackages.filter((pkg) => {
      if (result.fields.lot && result.fields.expiry) return pkg.lot === result.fields.lot && pkg.expiry === result.fields.expiry
      if (result.fields.expiry) return pkg.expiry === result.fields.expiry
      return true
    })
    const sortedMatches = [...identityMatches].sort((first, second) =>
      first.received_on.localeCompare(second.received_on) || first.id - second.id,
    )
    const target = sortedMatches.find((pkg) => !pkg.is_open)
    if (target) {
      await openPackage(target.id)
      return
    }
    if (sortedMatches.some((pkg) => pkg.is_open)) {
      scanNotice.value = 'This package is already open. Scan a unit barcode to start the next unit.'
      return
    }
    await startUnitFromScan(result)
    return
  }
  if (categories.value.length === 0) await loadDashboard()
  if (categories.value.length === 0) {
    scanNotice.value = 'Supply categories could not be loaded. Refresh the inventory and scan again.'
    return
  }

  scannedBarcode.value = result
  matchedProduct.value = null
  receiptLot.value = result.kind === 'gs1' ? result.fields.lot ?? '' : ''
  receiptSerial.value = result.kind === 'gs1' ? result.fields.serial ?? '' : ''
  receiptExpiry.value = result.kind === 'gs1' ? result.fields.expiry ?? '' : ''
  receivedOn.value = todayIsoDate()
  receiptError.value = ''
  manufacturer.value = ''
  productName.value = ''
  containsQty.value = '1'
  containsProductId.value = ''
  ratedWearDays.value = ''
  expiryRule.value = 'finish_by'
  expiryStrictness.value = 'hard'
  if (result.kind === 'gs1' && result.fields.gtin) {
    try {
      const response = await fetch('/api/products')
      if (response.status === 401) {
        await router.replace({ name: 'login' })
        return
      }
      if (response.ok) {
        const data = await response.json() as { products: Product[] }
        const existing = data.products.find((product) => product.gtin === result.fields.gtin)
        if (existing) matchedProduct.value = existing
      }
    } catch {
      receiptError.value = 'Could not look up this product. You can still add it as a custom product.'
    }
  }
  receiptDialogOpen.value = true
}

async function startUnitFromScan(result: Extract<BarcodeParseResult, { kind: 'gs1' }>) {
  const gtin = result.fields.gtin
  if (!gtin) {
    scanNotice.value = 'This scan has no GTIN. Open a package from inventory instead.'
    return
  }

  try {
    const response = await fetch('/api/unit-scans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gtin,
        lot: result.fields.lot,
        expiry: result.fields.expiry,
        serial: result.fields.serial,
        rawBarcode: result.raw,
        occurredOn: todayIsoDate(),
      }),
    })
    if (response.status === 401) {
      await router.replace({ name: 'login' })
      return
    }
    if (response.status === 404) {
      scanNotice.value = 'No unit product matches this GTIN yet. Receive the unit product first and link it to its pack.'
      return
    }
    if (!response.ok) throw new Error('Could not start this unit.')

    const data = await response.json() as {
      implicit: boolean
      matchedBy: 'lot_expiry' | 'expiry' | 'gtin' | null
      serialAlreadyUsed: boolean
    }
    scanNotice.value = data.implicit
      ? 'No received pack had units remaining, so this scan was recorded as an implicit unit.'
      : `Unit started from the matching pack (${data.matchedBy?.replace('_', ' and ')} match).`
    if (data.serialAlreadyUsed) scanNotice.value += ' This serial was already recorded.'
    await loadDashboard()
  } catch {
    scanNotice.value = 'The inventory service could not start this unit. Try again.'
  }
}

async function applyReceiptRescan(result: BarcodeParseResult) {
  const previousBarcode = scannedBarcode.value
  scannedBarcode.value = result
  receiptError.value = ''

  if (result.kind === 'gs1') {
    if (result.fields.lot !== undefined) receiptLot.value = result.fields.lot
    if (result.fields.serial !== undefined) receiptSerial.value = result.fields.serial
    if (result.fields.expiry !== undefined) receiptExpiry.value = result.fields.expiry

    if (result.fields.gtin) {
      const previousGtin = previousBarcode?.kind === 'gs1' ? previousBarcode.fields.gtin : undefined
      if (previousGtin !== result.fields.gtin) matchedProduct.value = null
      try {
        const response = await fetch('/api/products')
        if (response.status === 401) {
          await router.replace({ name: 'login' })
          return
        }
        if (response.ok) {
          const data = await response.json() as { products: Product[] }
          matchedProduct.value = data.products.find((product) => product.gtin === result.fields.gtin) ?? null
        }
      } catch {
        receiptError.value = 'Could not look up this product. You can still add it as a custom product.'
      }
    }
  }

  isRescanningReceipt.value = false
  receiptDialogOpen.value = true
}

function scanAgain() {
  if (isSavingReceipt.value) return
  isRescanningReceipt.value = true
  receiptDialogOpen.value = false
  scannerOpen.value = true
}

function closeScanner() {
  scannerOpen.value = false
  if (isRescanningReceipt.value) {
    isRescanningReceipt.value = false
    receiptDialogOpen.value = true
  }
}

async function openPackage(packageId: number) {
  if (openingPackageId.value !== null) return
  openingPackageId.value = packageId
  scanNotice.value = ''
  try {
    const response = await fetch(`/api/packages/${packageId}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ occurredOn: todayIsoDate() }),
    })
    if (response.status === 401) {
      await router.replace({ name: 'login' })
      return
    }
    if (response.status === 409) {
      scanNotice.value = 'This package needs an opening confirmation. Refresh inventory and try again.'
      return
    }
    if (!response.ok) throw new Error('Could not open this package.')
    scanNotice.value = 'Package opened and recorded in the supply ledger.'
    await loadDashboard()
  } catch {
    scanNotice.value = 'The inventory service could not open this package. Try again.'
  } finally {
    openingPackageId.value = null
  }
}

async function saveReceipt() {
  if (!scannedBarcode.value || isSavingReceipt.value) return
  isSavingReceipt.value = true
  receiptError.value = ''

  try {
    let productId = matchedProduct.value?.id ?? null
    if (productId === null) {
      const productResponse = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categoryId: Number(categoryId.value),
          manufacturer: manufacturer.value,
          name: productName.value,
          gtin: scannedBarcode.value.kind === 'gs1' ? scannedBarcode.value.fields.gtin : undefined,
          containsQty: Number(containsQty.value),
          containsProductId: containsProductId.value ? Number(containsProductId.value) : undefined,
          ratedWearDays: ratedWearDays.value ? Number(ratedWearDays.value) : undefined,
          minSamples: 3,
          expiryRule: expiryRule.value,
          expiryStrictness: expiryStrictness.value,
        }),
      })
      if (productResponse.status === 401) {
        await router.replace({ name: 'login' })
        return
      }
      if (!productResponse.ok) {
        receiptError.value = productResponse.status === 409
          ? 'A product with this GTIN already exists. Refresh the page and scan again.'
          : 'Could not create this product. Check the details and try again.'
        return
      }
      const data = await productResponse.json() as { product: Product }
      productId = data.product.id
      matchedProduct.value = {
        ...data.product,
        category_name: categories.value.find((category) => category.id === data.product.category_id)?.name ?? '',
      }
    }

    const receiptResponse = await fetch('/api/receipts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId,
        lot: receiptLot.value || undefined,
        serial: receiptSerial.value || undefined,
        expiry: receiptExpiry.value || undefined,
        rawBarcode: scannedBarcode.value.raw,
        receivedOn: receivedOn.value,
      }),
    })
    if (receiptResponse.status === 401) {
      await router.replace({ name: 'login' })
      return
    }
    if (!receiptResponse.ok) throw new Error('Could not save this receipt.')

    receiptDialogOpen.value = false
    scannedBarcode.value = null
    await loadDashboard()
  } catch {
    receiptError.value = 'The inventory service could not save this receipt. Try again.'
  } finally {
    isSavingReceipt.value = false
  }
}

function closeReceiptDialog() {
  if (isSavingReceipt.value) return
  receiptDialogOpen.value = false
  scannedBarcode.value = null
}

async function signOut() {
  isSigningOut.value = true
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST' })
    if (!response.ok) throw new Error('Could not sign out.')
    await router.replace({ name: 'login' })
  } catch {
    errorMessage.value = 'Could not sign out. Check the connection and try again.'
  } finally {
    isSigningOut.value = false
  }
}

onMounted(loadDashboard)
</script>

<template>
  <div id="overview" class="overview-page">
    <header class="topbar">
      <div class="breadcrumb"><span>PIKALOG</span><span class="breadcrumb-divider">/</span><span>OVERVIEW</span></div>
      <div class="topbar-status">
        <span class="status-dot"></span>Private workspace
        <button class="signout-button" type="button" :disabled="isSigningOut" @click="signOut">
          <LogOut :size="14" aria-hidden="true" />
          <span>{{ isSigningOut ? 'Signing out' : 'Sign out' }}</span>
        </button>
      </div>
    </header>

    <section class="page-intro">
      <div>
        <p class="eyebrow">SUPPLY LEDGER</p>
        <h1>Your supplies, in view.</h1>
        <p class="date-line">{{ todayLabel }}</p>
      </div>
      <button class="refresh-button" type="button" :disabled="isLoading" @click="loadDashboard">
        <RefreshCw :size="16" :class="{ 'is-spinning': isLoading }" aria-hidden="true" />
        <span>Refresh</span>
      </button>
      <button class="scan-button" type="button" @click="scannerOpen = true">
        <Camera :size="16" aria-hidden="true" />
        <span>Scan</span>
      </button>
    </section>
    <p v-if="scanNotice" class="scan-notice" role="status">{{ scanNotice }}</p>

    <section class="metrics-row" aria-label="Supply summary">
      <div class="metric">
        <div class="metric-label">UNITS ON HAND</div>
        <div class="metric-value" :class="{ 'metric-value--pending': unitsOnHand === 0 }">{{ unitsOnHand }}</div>
        <div class="metric-note">Across {{ packages.length }} received packages</div>
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

      <div v-if="packages.length === 0" class="empty-ledger">
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
      <div v-else class="inventory-list">
        <article v-for="pkg in packages" :key="pkg.id" class="inventory-row">
          <div class="inventory-product">
            <strong>{{ pkg.product_name }}</strong>
            <span>{{ pkg.manufacturer }} · {{ pkg.category_name }}</span>
          </div>
          <span class="inventory-quantity">{{ pkg.units_remaining }} / {{ pkg.contains_qty ?? 1 }} units</span>
          <span class="inventory-expiry">{{ pkg.expiry ? `Use by ${pkg.expiry}` : 'No expiry recorded' }}</span>
          <span class="inventory-meta">{{ pkg.lot ? `Lot ${pkg.lot}` : 'No lot' }}{{ pkg.serial ? ` · Serial ${pkg.serial}` : '' }} · received {{ pkg.received_on }}</span>
          <button
            v-if="!pkg.is_open"
            class="inventory-open"
            type="button"
            :disabled="openingPackageId !== null"
            @click="openPackage(pkg.id)"
          >{{ openingPackageId === pkg.id ? 'Opening' : 'Open' }}</button>
          <span v-else class="inventory-open-state">Opened</span>
        </article>
      </div>
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
        <button type="button" @click="loadDashboard">Retry</button>
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
      <div v-if="durationStats.length" class="duration-list">
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
      <div v-if="activityEvents.length" class="event-list" aria-label="Recent ledger events">
        <article v-for="event in activityEvents" :key="event.id" class="event-row">
          <span class="event-date">{{ event.occurredOn }}</span>
          <span class="event-type">{{ activityLabel(event.type) }}</span>
          <span class="event-product">{{ event.productName }}<template v-if="event.unitSerial"> · {{ event.unitSerial }}</template></span>
          <span v-if="event.inferred" class="event-reason">Inferred</span>
          <span v-if="event.endReason" class="event-reason">{{ event.endReason.replace('_', ' ') }}</span>
        </article>
      </div>
      <p v-else class="activity-note">No ledger events yet.</p>
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

    <BarcodeScanner
      v-if="scannerOpen"
      :initial-mode="isRescanningReceipt ? 'receive' : undefined"
      @close="closeScanner"
      @detected="handleBarcodeDetected"
    />

    <div v-if="receiptDialogOpen && scannedBarcode" class="receipt-backdrop" @click.self="closeReceiptDialog">
      <section class="receipt-dialog" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
        <header class="receipt-heading">
          <div>
            <p class="eyebrow">RECEIVE SUPPLY</p>
            <h2 id="receipt-title">Record package</h2>
          </div>
          <button class="receipt-close" type="button" aria-label="Close receipt form" @click="closeReceiptDialog">
            <X :size="18" aria-hidden="true" />
          </button>
        </header>

        <p class="receipt-code">{{ scannedBarcode.raw }}</p>
        <p v-if="scannedBarcode.kind === 'invalid'" class="receipt-warning">{{ scannedBarcode.reason }}</p>
        <p v-else-if="scannedBarcode.kind === 'unknown'" class="receipt-warning">No product fields were recognized. Add the product details to save this barcode.</p>
        <ul v-if="scannedBarcode.kind === 'gs1' && scannedBarcode.warnings.length" class="receipt-warnings">
          <li v-for="warning in scannedBarcode.warnings" :key="warning">{{ warning }}</li>
        </ul>
        <button v-if="hasScanProblem" class="receipt-rescan" type="button" @click="scanAgain">Scan Again</button>

        <form class="receipt-form" @submit.prevent="saveReceipt">
          <div v-if="matchedProduct" class="matched-product">
            <span>Matched product</span>
            <strong>{{ matchedProduct.name }}</strong>
            <small>{{ matchedProduct.manufacturer }} · {{ matchedProduct.category_name }}</small>
          </div>
          <template v-else>
            <label for="receipt-category">Category</label>
            <select id="receipt-category" v-model="categoryId" required>
              <option v-for="category in categories" :key="category.id" :value="String(category.id)">{{ category.name }}</option>
            </select>

            <div class="receipt-field-grid">
              <div>
                <label for="receipt-manufacturer">Manufacturer</label>
                <input id="receipt-manufacturer" v-model.trim="manufacturer" maxlength="120" required />
              </div>
              <div>
                <label for="receipt-product">Product</label>
                <input id="receipt-product" v-model.trim="productName" maxlength="160" required />
              </div>
            </div>

            <label for="receipt-quantity">Units in this package</label>
            <input id="receipt-quantity" v-model="containsQty" type="number" min="1" max="10000" required />
            <template v-if="Number(containsQty) > 1">
              <label for="receipt-contains-product">Product inside</label>
              <select id="receipt-contains-product" v-model="containsProductId">
                <option value="">Not specified</option>
                <option v-for="product in containedProducts" :key="product.id" :value="String(product.id)">
                  {{ product.manufacturer }} · {{ product.name }}
                </option>
              </select>
            </template>
            <div v-else class="receipt-field-grid">
              <div>
                <label for="receipt-rated-wear">Rated wear (days)</label>
                <input id="receipt-rated-wear" v-model="ratedWearDays" type="number" min="1" max="365" />
              </div>
              <div>
                <label for="receipt-expiry-rule">Expiry basis</label>
                <select id="receipt-expiry-rule" v-model="expiryRule">
                  <option value="finish_by">Finish by expiry</option>
                  <option value="start_by">Start by expiry</option>
                  <option value="none">No expiry constraint</option>
                </select>
              </div>
              <div>
                <label for="receipt-expiry-strictness">Expiry handling</label>
                <select id="receipt-expiry-strictness" v-model="expiryStrictness">
                  <option value="hard">Hard deadline</option>
                  <option value="soft">Soft preference</option>
                </select>
              </div>
            </div>
          </template>

          <div class="receipt-field-grid">
            <div>
              <label for="receipt-lot">Lot</label>
              <input id="receipt-lot" v-model.trim="receiptLot" maxlength="120" />
            </div>
            <div>
              <label for="receipt-serial">Serial</label>
              <input id="receipt-serial" v-model.trim="receiptSerial" maxlength="120" />
            </div>
          </div>
          <div class="receipt-field-grid">
            <div>
              <label for="receipt-expiry">Expiry</label>
              <input id="receipt-expiry" v-model="receiptExpiry" type="date" />
            </div>
          </div>
          <label for="receipt-date">Received on</label>
          <input id="receipt-date" v-model="receivedOn" type="date" required />

          <p v-if="receiptError" class="receipt-error" role="alert">{{ receiptError }}</p>
          <div class="receipt-actions">
            <button class="receipt-cancel" type="button" :disabled="isSavingReceipt" @click="closeReceiptDialog">Cancel</button>
            <button class="receipt-submit" type="submit" :disabled="isSavingReceipt">
              {{ isSavingReceipt ? 'Saving…' : 'Save receipt' }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </div>
</template>
