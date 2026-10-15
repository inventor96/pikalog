<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { AlertCircle } from '@lucide/vue'
import { useRouter } from 'vue-router'
import PageLayout from '@/components/PageLayout.vue'

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

const router = useRouter()
const categories = ref<Category[]>([])
const products = ref<Product[]>([])
const categoriesLoading = ref(true)
const productsLoading = ref(true)
const categoriesError = ref('')
const productsError = ref('')

async function loadCategories() {
  categoriesLoading.value = true
  categoriesError.value = ''
  try {
    const response = await fetch('/api/categories')
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
    const response = await fetch('/api/products')
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
})
</script>

<template>
  <PageLayout section="CONFIGURATION" eyebrow="CATALOG" title="Configuration" class="configuration-page">
    <section class="ledger-section category-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">TRACKING SCOPE</p>
          <h2>Categories</h2>
        </div>
        <span class="section-count">{{ categories.length }} CATEGORIES</span>
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
      <div v-else class="category-list">
        <div v-for="(category, index) in categories" :key="category.id" class="category-row">
          <span class="category-index">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="category-name">{{ category.name }}</span>
          <code>{{ category.key }}</code>
          <span class="category-policy">{{ category.overlap_allowed ? 'Overlap allowed' : 'Single active unit' }}</span>
        </div>
      </div>
    </section>

    <section class="ledger-section configuration-products">
      <div class="section-heading">
        <div>
          <p class="eyebrow">CATALOG</p>
          <h2>Products</h2>
        </div>
        <span class="section-count">{{ products.length }} PRODUCTS</span>
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
      <div v-else class="product-list">
        <article v-for="product in products" :key="product.id" class="product-row">
          <div class="product-identity">
            <strong>{{ product.name }}</strong>
            <span>{{ product.manufacturer }} · {{ product.category_name }}</span>
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
        </article>
      </div>
    </section>
  </PageLayout>
</template>