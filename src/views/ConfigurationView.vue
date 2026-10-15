<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { AlertCircle, Eye, EyeOff, Pencil, Plus, RefreshCw, RotateCcw, Save, Trash2, X } from '@lucide/vue'
import { useRouter } from 'vue-router'
import PageLayout from '@/components/PageLayout.vue'

type Category = {
  id: number
  key: string
  name: string
  overlap_allowed: number
  origin: 'catalog' | 'custom'
  hidden: number
  overridden_fields: string
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
  origin: 'catalog' | 'custom'
  hidden: number
  overridden_fields: string
}

type CatalogStatus = {
  version: string | null
  lastSyncedAt: string | null
  status: 'not_synced' | 'seeded' | 'success' | 'error' | string
  lastError: string | null
}

const router = useRouter()
const categories = ref<Category[]>([])
const products = ref<Product[]>([])
const categoriesLoading = ref(true)
const productsLoading = ref(true)
const categoriesError = ref('')
const productsError = ref('')
const actionError = ref('')
const isSaving = ref(false)
const catalogStatus = ref<CatalogStatus>({ version: null, lastSyncedAt: null, status: 'not_synced', lastError: null })
const catalogStatusError = ref('')
const isSyncingCatalog = ref(false)
const categoryFormOpen = ref(false)
const categoryEditorId = ref<number | null>(null)
const productFormOpen = ref(false)
const productEditorId = ref<number | null>(null)
const categoryForm = ref({ key: '', name: '', overlapAllowed: false })
const productForm = ref({
  categoryId: '',
  manufacturer: '',
  name: '',
  minSamples: 3,
  expiryRule: 'finish_by' as Product['expiry_rule'],
  expiryStrictness: 'hard' as Product['expiry_strictness'],
})

function overriddenFields(value: string): string[] {
  return value ? value.split(',') : []
}

async function send(path: string, method: string, body?: unknown): Promise<void> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 401) {
    await router.replace({ name: 'login' })
    throw new Error('Your session has expired.')
  }
  if (!response.ok) throw new Error('The change could not be saved. Check the item and try again.')
}

async function loadCatalogStatus() {
  catalogStatusError.value = ''
  try {
    const response = await fetch('/api/catalog/status')
    if (response.status === 401) {
      await router.replace({ name: 'login' })
      return
    }
    if (!response.ok) throw new Error('Could not load catalog status.')
    catalogStatus.value = await response.json() as CatalogStatus
  } catch {
    catalogStatusError.value = 'Catalog status could not be loaded.'
  }
}

async function syncCatalogNow() {
  isSyncingCatalog.value = true
  catalogStatusError.value = ''
  try {
    const response = await fetch('/api/catalog/sync', { method: 'POST' })
    if (response.status === 401) {
      await router.replace({ name: 'login' })
      return
    }
    if (!response.ok) throw new Error('Catalog sync failed.')
    await Promise.all([loadCatalogStatus(), loadCategories(), loadProducts()])
  } catch {
    await loadCatalogStatus()
    catalogStatusError.value = 'Catalog sync failed. The last available catalog is still in use.'
  } finally {
    isSyncingCatalog.value = false
  }
}

async function loadCategories() {
  categoriesLoading.value = true
  categoriesError.value = ''
  try {
    const response = await fetch('/api/categories?includeHidden=true')
    if (response.status === 401) {
      await router.replace({ name: 'login' })
      return
    }
    if (!response.ok) throw new Error('Could not load categories.')
    const data = await response.json() as { categories: Category[] }
    categories.value = data.categories
  } catch {
    categoriesError.value = 'Categories could not be loaded. Try again.'
  } finally {
    categoriesLoading.value = false
  }
}

async function loadProducts() {
  productsLoading.value = true
  productsError.value = ''
  try {
    const response = await fetch('/api/products?includeHidden=true')
    if (response.status === 401) {
      await router.replace({ name: 'login' })
      return
    }
    if (!response.ok) throw new Error('Could not load products.')
    const data = await response.json() as { products: Product[] }
    products.value = data.products
  } catch {
    productsError.value = 'Products could not be loaded. Try again.'
  } finally {
    productsLoading.value = false
  }
}

function startCategoryEdit(category: Category) {
  categoryEditorId.value = category.id
  categoryForm.value = { key: category.key, name: category.name, overlapAllowed: Boolean(category.overlap_allowed) }
  categoryFormOpen.value = true
  actionError.value = ''
}

function startCategoryAdd() {
  categoryEditorId.value = null
  categoryForm.value = { key: '', name: '', overlapAllowed: false }
  categoryFormOpen.value = true
  actionError.value = ''
}

async function saveCategory() {
  isSaving.value = true
  actionError.value = ''
  try {
    if (categoryEditorId.value === null) {
      await send('/api/categories', 'POST', categoryForm.value)
    } else {
      await send(`/api/categories/${categoryEditorId.value}`, 'PATCH', {
        name: categoryForm.value.name,
        overlapAllowed: categoryForm.value.overlapAllowed,
      })
    }
    categoryFormOpen.value = false
    await loadCategories()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : 'The category could not be saved.'
  } finally {
    isSaving.value = false
  }
}

async function startProductEdit(product: Product) {
  productEditorId.value = product.id
  productForm.value = {
    categoryId: String(product.category_id),
    manufacturer: product.manufacturer,
    name: product.name,
    minSamples: product.min_samples,
    expiryRule: product.expiry_rule,
    expiryStrictness: product.expiry_strictness,
  }
  productFormOpen.value = true
  actionError.value = ''
}

function startProductAdd() {
  productEditorId.value = null
  productForm.value = {
    categoryId: String(categories.value.find((category) => !category.hidden)?.id ?? ''),
    manufacturer: '',
    name: '',
    minSamples: 3,
    expiryRule: 'finish_by',
    expiryStrictness: 'hard',
  }
  productFormOpen.value = true
  actionError.value = ''
}

async function saveProduct() {
  isSaving.value = true
  actionError.value = ''
  try {
    const values = {
      categoryId: Number(productForm.value.categoryId),
      manufacturer: productForm.value.manufacturer,
      name: productForm.value.name,
      minSamples: productForm.value.minSamples,
      expiryRule: productForm.value.expiryRule,
      expiryStrictness: productForm.value.expiryStrictness,
    }
    if (productEditorId.value === null) await send('/api/products', 'POST', values)
    else await send(`/api/products/${productEditorId.value}`, 'PATCH', values)
    productFormOpen.value = false
    await Promise.all([loadCategories(), loadProducts()])
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : 'The product could not be saved.'
  } finally {
    isSaving.value = false
  }
}

async function toggleHidden(kind: 'categories' | 'products', item: Category | Product) {
  actionError.value = ''
  try {
    await send(`/api/${kind}/${item.id}`, 'PATCH', { hidden: !item.hidden })
    if (kind === 'categories') await loadCategories()
    else await loadProducts()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : 'Visibility could not be changed.'
  }
}

async function resetOverrides(kind: 'categories' | 'products', item: Category | Product) {
  if (!window.confirm('Reset all custom fields for this item to its official catalog values?')) return
  actionError.value = ''
  try {
    await send(`/api/${kind}/${item.id}/reset-overrides`, 'POST')
    if (kind === 'categories') await loadCategories()
    else await loadProducts()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : 'Overrides could not be reset.'
  }
}

async function deleteCustom(kind: 'categories' | 'products', item: Category | Product) {
  if (!window.confirm(`Delete this custom ${kind === 'categories' ? 'category' : 'product'}? This cannot be undone.`)) return
  actionError.value = ''
  try {
    await send(`/api/${kind}/${item.id}`, 'DELETE')
    if (kind === 'categories') await loadCategories()
    else await loadProducts()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : 'The item could not be deleted.'
  }
}

function productContents(product: Product): string {
  if (product.contains_product_id === null) return 'Single item'
  const containedProduct = products.value.find((item) => item.id === product.contains_product_id)
  const productName = containedProduct
    ? `${containedProduct.manufacturer} ${containedProduct.name}`
    : `Product #${product.contains_product_id}`
  return `${product.contains_qty ?? 1} x ${productName}`
}

function expiryRuleLabel(rule: Product['expiry_rule']): string {
  switch (rule) {
    case 'finish_by': return 'Finish by'
    case 'start_by': return 'Start by'
    case 'none': return 'None'
  }
}

onMounted(() => {
  void loadCategories()
  void loadProducts()
  void loadCatalogStatus()
})
</script>

<template>
  <PageLayout section="CONFIGURATION" eyebrow="CATALOG" title="Configuration" class="configuration-page">
    <div v-if="actionError" class="management-error" role="alert">
      <AlertCircle :size="17" aria-hidden="true" />
      <span>{{ actionError }}</span>
    </div>

    <section class="ledger-section catalog-management-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">DATA SOURCE</p>
          <h2>Official catalog</h2>
        </div>
        <button
          class="management-button management-button--primary"
          type="button"
          :disabled="isSyncingCatalog"
          @click="syncCatalogNow"
        >
          <RefreshCw :size="15" :class="{ 'is-spinning': isSyncingCatalog }" aria-hidden="true" />
          {{ isSyncingCatalog ? 'Syncing catalog' : 'Sync catalog' }}
        </button>
      </div>
      <div class="catalog-management-status" role="status">
        <strong>
          {{ catalogStatus.status === 'error' && catalogStatus.lastError === 'catalog_schema_unsupported'
            ? 'Update app to use catalog'
            : catalogStatus.status === 'error' ? 'Catalog sync failed'
              : catalogStatus.version ? `Catalog ${catalogStatus.version}` : 'Bundled catalog' }}
        </strong>
        <span v-if="catalogStatus.lastSyncedAt">Synced {{ catalogStatus.lastSyncedAt.slice(0, 10) }}</span>
        <span v-if="catalogStatus.lastError && catalogStatus.lastError !== 'catalog_schema_unsupported'">{{ catalogStatus.lastError }}</span>
        <span v-if="catalogStatusError" class="catalog-management-error">{{ catalogStatusError }}</span>
      </div>
    </section>

    <section class="ledger-section category-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">TRACKING SCOPE</p>
          <h2>Categories</h2>
        </div>
        <div class="section-tools">
          <span class="section-count">{{ categories.length }} CATEGORIES</span>
          <button type="button" class="management-button management-button--primary" @click="startCategoryAdd">
            <Plus :size="15" aria-hidden="true" />Add category
          </button>
        </div>
      </div>

      <div v-if="categoriesError" class="load-error" role="alert">
        <AlertCircle :size="17" aria-hidden="true" />
        <span>{{ categoriesError }}</span>
        <button type="button" @click="loadCategories">Retry</button>
      </div>
      <div v-else-if="categoriesLoading" class="category-loading" aria-live="polite">
        <span class="status-dot"></span>Loading categories
      </div>
      <div v-else-if="categories.length === 0" class="configuration-empty">No categories configured.</div>
      <div v-if="categories.length" class="category-list">
        <div v-for="(category, index) in categories" :key="category.id" class="category-row" :class="{ 'is-hidden': category.hidden }">
          <span class="category-index">{{ String(index + 1).padStart(2, '0') }}</span>
          <div class="managed-identity">
            <span class="category-name">{{ category.name }}</span>
            <div class="managed-badges">
              <span class="origin-badge" :class="`origin-badge--${category.origin}`">{{ category.origin === 'catalog' ? 'Official' : 'Custom' }}</span>
              <span v-if="category.hidden" class="state-badge">Hidden</span>
              <span v-if="overriddenFields(category.overridden_fields).length" class="override-note">
                Overrides: {{ overriddenFields(category.overridden_fields).join(', ') }}
              </span>
            </div>
          </div>
          <code>{{ category.key }}</code>
          <span class="category-policy">{{ category.overlap_allowed ? 'Overlap allowed' : 'Single active unit' }}</span>
          <div class="management-actions">
            <button type="button" class="icon-action" :aria-label="`Edit ${category.name}`" title="Edit" @click="startCategoryEdit(category)">
              <Pencil :size="15" aria-hidden="true" />
            </button>
            <button v-if="category.origin === 'catalog' && category.overridden_fields" type="button" class="icon-action" :aria-label="`Reset ${category.name} overrides`" title="Reset overrides" @click="resetOverrides('categories', category)">
              <RotateCcw :size="15" aria-hidden="true" />
            </button>
            <button type="button" class="icon-action" :aria-label="`${category.hidden ? 'Show' : 'Hide'} ${category.name}`" :title="category.hidden ? 'Show' : 'Hide'" @click="toggleHidden('categories', category)">
              <component :is="category.hidden ? Eye : EyeOff" :size="15" aria-hidden="true" />
            </button>
            <button v-if="category.origin === 'custom'" type="button" class="icon-action icon-action--danger" :aria-label="`Delete ${category.name}`" title="Delete" @click="deleteCustom('categories', category)">
              <Trash2 :size="15" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </section>

    <section class="ledger-section configuration-products">
      <div class="section-heading">
        <div>
          <p class="eyebrow">CATALOG</p>
          <h2>Products</h2>
        </div>
        <div class="section-tools">
          <span class="section-count">{{ products.length }} PRODUCTS</span>
          <button type="button" class="management-button management-button--primary" @click="startProductAdd">
            <Plus :size="15" aria-hidden="true" />Add product
          </button>
        </div>
      </div>

      <div v-if="productsError" class="load-error" role="alert">
        <AlertCircle :size="17" aria-hidden="true" />
        <span>{{ productsError }}</span>
        <button type="button" @click="loadProducts">Retry</button>
      </div>
      <div v-else-if="productsLoading" class="category-loading" aria-live="polite">
        <span class="status-dot"></span>Loading products
      </div>
      <div v-else-if="products.length === 0" class="configuration-empty">No products configured.</div>
      <div v-if="products.length" class="product-list">
        <article v-for="product in products" :key="product.id" class="product-row" :class="{ 'is-hidden': product.hidden }">
          <div class="product-identity">
            <strong>{{ product.name }}</strong>
            <span>{{ product.manufacturer }} · {{ product.category_name }}</span>
            <div class="managed-badges">
              <span class="origin-badge" :class="`origin-badge--${product.origin}`">{{ product.origin === 'catalog' ? 'Official' : 'Custom' }}</span>
              <span v-if="product.hidden" class="state-badge">Hidden</span>
              <span v-if="overriddenFields(product.overridden_fields).length" class="override-note">
                Overrides: {{ overriddenFields(product.overridden_fields).join(', ') }}
              </span>
            </div>
          </div>
          <dl class="product-facts">
            <div>
              <dt>GTIN</dt>
              <dd><code>{{ product.gtin ?? 'Not set' }}</code></dd>
            </div>
            <div>
              <dt>Contents</dt>
              <dd>{{ productContents(product) }}</dd>
            </div>
            <div>
              <dt>Rated wear</dt>
              <dd>{{ product.rated_wear_days === null ? 'Not set' : `${product.rated_wear_days} days` }}</dd>
            </div>
            <div>
              <dt>Min. samples</dt>
              <dd>{{ product.min_samples }}</dd>
            </div>
            <div>
              <dt>Expiry</dt>
              <dd>{{ expiryRuleLabel(product.expiry_rule) }} · {{ product.expiry_strictness }}</dd>
            </div>
          </dl>
          <div class="management-actions">
            <button type="button" class="icon-action" :aria-label="`Edit ${product.name}`" title="Edit" @click="startProductEdit(product)">
              <Pencil :size="15" aria-hidden="true" />
            </button>
            <button v-if="product.origin === 'catalog' && product.overridden_fields" type="button" class="icon-action" :aria-label="`Reset ${product.name} overrides`" title="Reset overrides" @click="resetOverrides('products', product)">
              <RotateCcw :size="15" aria-hidden="true" />
            </button>
            <button type="button" class="icon-action" :aria-label="`${product.hidden ? 'Show' : 'Hide'} ${product.name}`" :title="product.hidden ? 'Show' : 'Hide'" @click="toggleHidden('products', product)">
              <component :is="product.hidden ? Eye : EyeOff" :size="15" aria-hidden="true" />
            </button>
            <button v-if="product.origin === 'custom'" type="button" class="icon-action icon-action--danger" :aria-label="`Delete ${product.name}`" title="Delete" @click="deleteCustom('products', product)">
              <Trash2 :size="15" aria-hidden="true" />
            </button>
          </div>
        </article>
      </div>
    </section>

    <Teleport to="body">
      <div
        v-if="categoryFormOpen"
        class="receipt-backdrop management-modal-backdrop"
        tabindex="-1"
        @click.self="categoryFormOpen = false"
        @keydown.esc.stop="categoryFormOpen = false"
      >
        <section class="receipt-dialog management-dialog" role="dialog" aria-modal="true" aria-labelledby="category-editor-title">
          <header class="receipt-heading">
            <div>
              <p class="eyebrow">CATEGORY</p>
              <h2 id="category-editor-title">{{ categoryEditorId === null ? 'Add category' : 'Edit category' }}</h2>
            </div>
            <button type="button" class="receipt-close" aria-label="Close category form" :disabled="isSaving" @click="categoryFormOpen = false">
              <X :size="17" aria-hidden="true" />
            </button>
          </header>
          <form class="management-form management-modal-form" @submit.prevent="saveCategory">
            <label v-if="categoryEditorId === null">
              <span>Key</span>
              <input v-model="categoryForm.key" required maxlength="64" pattern="[a-z][a-z0-9_]{1,63}" autocomplete="off">
            </label>
            <label>
              <span>Name</span>
              <input v-model="categoryForm.name" required maxlength="100" autocomplete="off">
            </label>
            <label class="management-check">
              <input v-model="categoryForm.overlapAllowed" type="checkbox">
              <span>Allow overlapping units</span>
            </label>
            <div class="management-form-actions">
              <button type="submit" class="management-button management-button--primary" :disabled="isSaving">
                <Save :size="15" aria-hidden="true" />{{ isSaving ? 'Saving' : 'Save category' }}
              </button>
              <button type="button" class="management-button" :disabled="isSaving" @click="categoryFormOpen = false">
                <X :size="15" aria-hidden="true" />Cancel
              </button>
            </div>
          </form>
        </section>
      </div>

      <div
        v-if="productFormOpen"
        class="receipt-backdrop management-modal-backdrop"
        tabindex="-1"
        @click.self="productFormOpen = false"
        @keydown.esc.stop="productFormOpen = false"
      >
        <section class="receipt-dialog management-dialog" role="dialog" aria-modal="true" aria-labelledby="product-editor-title">
          <header class="receipt-heading">
            <div>
              <p class="eyebrow">PRODUCT</p>
              <h2 id="product-editor-title">{{ productEditorId === null ? 'Add product' : 'Edit product' }}</h2>
            </div>
            <button type="button" class="receipt-close" aria-label="Close product form" :disabled="isSaving" @click="productFormOpen = false">
              <X :size="17" aria-hidden="true" />
            </button>
          </header>
          <form class="management-form management-modal-form product-management-form" @submit.prevent="saveProduct">
            <label>
              <span>Category</span>
              <select v-model="productForm.categoryId" required>
                <option value="" disabled>Select category</option>
                <option v-for="category in categories" :key="category.id" :value="String(category.id)">{{ category.name }}{{ category.hidden ? ' (hidden)' : '' }}</option>
              </select>
            </label>
            <label>
              <span>Manufacturer</span>
              <input v-model="productForm.manufacturer" required maxlength="120" autocomplete="off">
            </label>
            <label>
              <span>Name</span>
              <input v-model="productForm.name" required maxlength="160" autocomplete="off">
            </label>
            <label>
              <span>Minimum samples</span>
              <input v-model.number="productForm.minSamples" type="number" min="1" max="100" required>
            </label>
            <label>
              <span>Expiry rule</span>
              <select v-model="productForm.expiryRule">
                <option value="finish_by">Finish by</option>
                <option value="start_by">Start by</option>
                <option value="none">None</option>
              </select>
            </label>
            <label>
              <span>Expiry strictness</span>
              <select v-model="productForm.expiryStrictness">
                <option value="hard">Hard</option>
                <option value="soft">Soft</option>
              </select>
            </label>
            <div class="management-form-actions">
              <button type="submit" class="management-button management-button--primary" :disabled="isSaving || !productForm.categoryId">
                <Save :size="15" aria-hidden="true" />{{ isSaving ? 'Saving' : 'Save product' }}
              </button>
              <button type="button" class="management-button" :disabled="isSaving" @click="productFormOpen = false">
                <X :size="15" aria-hidden="true" />Cancel
              </button>
            </div>
          </form>
        </section>
      </div>
    </Teleport>
  </PageLayout>
</template>