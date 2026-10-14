import { Hono } from 'hono'

type Category = {
	id: number
	key: string
	name: string
	overlap_allowed: number
}

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (context) => {
	return context.json({ status: 'ok' })
})

app.get('/api/overview', async (context) => {
	const [packages, events] = await Promise.all([
		context.env.DB.prepare('SELECT COUNT(*) AS count FROM packages').first<{ count: number }>(),
		context.env.DB.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>(),
	])

	return context.json({
		packageCount: packages?.count ?? 0,
		eventCount: events?.count ?? 0,
	})
})

app.get('/api/categories', async (context) => {
	const { results } = await context.env.DB.prepare(
		'SELECT id, key, name, overlap_allowed FROM categories ORDER BY id',
	).all<Category>()

	return context.json({ categories: results })
})

export default app
