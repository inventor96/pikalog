import '@fontsource-variable/dm-sans'
import '@fontsource/ibm-plex-mono/400.css'
import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import router from './router'

const app = createApp(App)

app.use(router)

app.mount('#app')
