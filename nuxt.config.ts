// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui'
  ],

  // A local single-page board served by the `factory` CLI.
  ssr: false,

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  devServer: {
    host: '127.0.0.1'
  },

  compatibilityDate: '2026-06-30',

  nitro: {
    preset: 'bun'
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  // No server icon endpoint in a SPA: ship every icon the source uses in the client bundle.
  icon: {
    mode: 'svg',
    provider: 'none',
    clientBundle: { scan: true }
  }
})
