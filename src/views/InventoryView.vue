<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { AlertCircle, PackageOpen, RefreshCw } from '@lucide/vue'
import { useRouter } from 'vue-router'
import PageLayout from '@/components/PageLayout.vue'
import { formatShortDate } from '@/domain/date-format'
import { groupInventoryForListing, type InventoryListBox, type InventoryListPackage } from '@/domain/inventory-list'

const router = useRouter()
const packages = ref<InventoryListPackage[]>([])
const isLoading = ref(false)
const errorMessage = ref('')

function todayIsoDate(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const todayLabel = computed(() => formatShortDate(todayIsoDate()))
const groupedInventory = computed(() => groupInventoryForListing(packages.value, todayIsoDate()))
const boxCount = computed(() => groupedInventory.value.reduce((total, category) => total + category.boxCount, 0))

function boxLabel(box: InventoryListBox): string {
  if (box.serial) return box.serial
  if (box.lot) return box.lot
  return 'No lot / serial'
}

async function loadInventory() {
  isLoading.value = true
  errorMessage.value = ''
  try {
    const response = await fetch('/api/inventory')
    if (!response.ok) {
      if (response.status === 401) {
        await router.replace({ name: 'login' })
        return
      }
      throw new Error('Could not load the inventory.')
    }
    const data = await response.json() as { packages: InventoryListPackage[] }
    packages.value = data.packages
  } catch {
    errorMessage.value = 'The inventory service is unavailable. Try refreshing.'
  } finally {
    isLoading.value = false
  }
}

onMounted(loadInventory)
</script>

<template>
  <PageLayout section="INVENTORY" eyebrow="EVERY BOX AND ITEM" title="All boxes and items" :detail="todayLabel">
    <template #actions>
      <button class="refresh-button" type="button" :disabled="isLoading" @click="loadInventory">
        <RefreshCw :size="16" :class="{ 'is-spinning': isLoading }" aria-hidden="true" />
        <span>Refresh</span>
      </button>
    </template>

    <div v-if="errorMessage" class="load-error" role="alert">
      <AlertCircle :size="17" aria-hidden="true" />
      <span>{{ errorMessage }}</span>
      <button type="button" @click="loadInventory">Retry</button>
    </div>

    <section class="ledger-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">CURRENT STOCK</p>
          <h2>Items in inventory</h2>
        </div>
        <span class="section-count">{{ boxCount }} BOXES</span>
      </div>

      <div v-if="isLoading && groupedInventory.length === 0" class="category-loading" aria-live="polite">
        <span class="status-dot"></span>Loading inventory
      </div>
      <div v-else-if="groupedInventory.length === 0" class="empty-ledger">
        <div class="empty-symbol" aria-hidden="true">
          <PackageOpen :size="25" :stroke-width="1.5" />
        </div>
        <div>
          <h3>No boxes in stock</h3>
          <p>Once a package is received and still has units remaining, it will be listed here.</p>
        </div>
        <span class="empty-code">STOCK EMPTY</span>
      </div>
      <div v-else class="inventory-table-wrap">
        <table class="inventory-table box-list-table">
          <thead>
            <tr>
              <th scope="col">Box · lot / serial</th>
              <th scope="col">Expiry</th>
              <th scope="col">Received</th>
              <th scope="col">Units</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody v-for="category in groupedInventory" :key="category.categoryKey">
            <tr class="inventory-category-row">
              <th scope="row">{{ category.categoryName }}</th>
              <td colspan="4" data-label="Total">
                {{ category.boxCount }} box{{ category.boxCount === 1 ? '' : 'es' }} ·
                {{ category.unitsRemaining }} units
              </td>
            </tr>
            <template v-for="product in category.products" :key="product.groupKey">
              <tr class="inventory-product-row">
                <th scope="row">
                  <span>{{ product.manufacturer }} {{ product.productName }}</span>
                  <small v-if="product.gtin">{{ product.gtin }}</small>
                </th>
                <td colspan="4" data-label="Product total">
                  {{ product.boxCount }} box{{ product.boxCount === 1 ? '' : 'es' }} ·
                  {{ product.unitsRemaining }} units
                </td>
              </tr>
              <tr v-for="box in product.boxes" :key="box.id" class="box-list-row">
                <td data-label="Lot / serial">{{ boxLabel(box) }}</td>
                <td data-label="Expiry">
                  <span :class="{ 'is-past-expiry': box.isExpired }">
                    {{ box.expiry ? formatShortDate(box.expiry) : '—' }}
                  </span>
                </td>
                <td data-label="Received">{{ formatShortDate(box.receivedOn) }}</td>
                <td data-label="Units">{{ box.unitsRemaining }}</td>
                <td data-label="Status">
                  <span v-if="box.isExpired" class="box-status box-status--expired">Expired</span>
                  <span v-else class="box-status" :class="box.isOpen ? 'box-status--open' : 'box-status--ok'">
                    {{ box.isOpen ? 'Opened' : 'Unopened' }}
                  </span>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>
  </PageLayout>
</template>
