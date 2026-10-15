<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { AlertCircle, ArrowDownRight, ArrowUpRight, Camera, ExternalLink, RefreshCw, X } from '@lucide/vue'
import { useRouter } from 'vue-router'
import BarcodeScanner from '@/components/BarcodeScanner.vue'
import PageLayout from '@/components/PageLayout.vue'
import type { BarcodeParseResult } from '@/barcode/ingest'
import { buildCatalogSuggestionUrl } from '@/domain/catalog-contribution'
import { summarizeInventory } from '@/domain/inventory-summary'

type Category = {
  id: number
  key: string
  name: string
  overlap_allowed: number
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
const packages = ref<InventoryPackage[]>([])
const isLoading = ref(false)
const errorMessage = ref('')
const scanNotice = ref('')
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
const router = useRouter()

function todayIsoDate(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const todayLabel = computed(() =>
  new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()),
)
const inventorySummary = computed(() => summarizeInventory(packages.value, products.value))
const containedProducts = computed(() => products.value.filter((product) =>
  product.category_id === Number(categoryId.value) && product.contains_product_id === null,
))
const hasScanProblem = computed(() => {
  const result = scannedBarcode.value
  return result?.kind === 'invalid'
    || result?.kind === 'unknown'
    || (result?.kind === 'gs1' && result.warnings.length > 0)
})
const catalogSuggestionUrl = computed(() => matchedProduct.value
  ? null
  : buildCatalogSuggestionUrl({
    barcode: scannedBarcode.value,
    manufacturer: manufacturer.value,
    productName: productName.value,
  }))

async function loadDashboard() {
  isLoading.value = true
  errorMessage.value = ''

  try {
    const [categoriesResponse, productsResponse, inventoryResponse] = await Promise.all([
      fetch('/api/categories'),
      fetch('/api/products'),
      fetch('/api/inventory'),
    ])
    if (!categoriesResponse.ok || !productsResponse.ok || !inventoryResponse.ok) {
      if ([categoriesResponse.status, productsResponse.status, inventoryResponse.status].includes(401)) {
        await router.replace({ name: 'login' })
        return
      }
      throw new Error('Could not load the inventory.')
    }

    const [categoryData, productData, inventoryData] = await Promise.all([
      categoriesResponse.json() as Promise<{ categories: Category[] }>,
      productsResponse.json() as Promise<{ products: Product[] }>,
      inventoryResponse.json() as Promise<{ packages: InventoryPackage[] }>,
    ])
    categories.value = categoryData.categories
    products.value = productData.products
    packages.value = inventoryData.packages
    if (!categoryId.value && categories.value[0]) categoryId.value = String(categories.value[0].id)
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

onMounted(loadDashboard)
</script>

<template>
  <PageLayout id="overview" section="OVERVIEW" eyebrow="SUPPLY LEDGER" title="Your supplies, in view." :detail="todayLabel">
    <template #actions>
      <button class="refresh-button" type="button" :disabled="isLoading" @click="loadDashboard">
        <RefreshCw :size="16" :class="{ 'is-spinning': isLoading }" aria-hidden="true" />
        <span>Refresh</span>
      </button>
      <button class="scan-button" type="button" @click="scannerOpen = true">
        <Camera :size="16" aria-hidden="true" />
        <span>Scan</span>
      </button>
    </template>
    <p v-if="scanNotice" class="scan-notice" role="status">{{ scanNotice }}</p>

    <section id="inventory" class="ledger-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">CURRENT STOCK</p>
          <h2>Inventory</h2>
        </div>
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
      <div v-else class="inventory-table-wrap">
        <table class="inventory-table">
          <thead>
            <tr>
              <th scope="col">Category / individual product</th>
              <th scope="col">Items on hand</th>
              <th scope="col">Available boxes</th>
            </tr>
          </thead>
          <tbody v-for="category in inventorySummary" :key="category.categoryId ?? category.categoryName">
            <tr class="inventory-category-row">
              <th scope="row">{{ category.categoryName }}</th>
              <td>{{ category.itemCount }}</td>
              <td>{{ category.availableBoxCount }}</td>
            </tr>
            <template v-if="category.products.length > 1">
              <tr v-for="product in category.products" :key="product.groupKey" class="inventory-product-row">
                <th scope="row">
                  <span>{{ product.manufacturer }} {{ product.productName }}</span>
                  <small v-if="product.gtin">{{ product.gtin }}</small>
                </th>
                <td>{{ product.itemCount }}</td>
                <td>{{ product.availableBoxCount }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

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
        <a
          v-if="catalogSuggestionUrl"
          class="catalog-contribution-link"
          :href="catalogSuggestionUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink :size="14" aria-hidden="true" />
          Report catalog gap
        </a>
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
  </PageLayout>
</template>
