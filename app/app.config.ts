export default defineAppConfig({
  ui: {
    colors: {
      primary: 'orange',
      neutral: 'stone'
    },
    scrollArea: {
      slots: {
        // The inset outline keeps the focus ring visible inside clipping parents.
        root: 'scrollbar-auto-hide focus-visible:-outline-offset-3'
      }
    }
  }
})
