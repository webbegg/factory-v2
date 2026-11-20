export default defineAppConfig({
  ui: {
    colors: {
      primary: 'orange',
      neutral: 'stone'
    },
    scrollArea: {
      slots: {
        // Full-strength and inset, so the focus ring is readable and not clipped by parents.
        root: 'scrollbar-auto-hide focus-visible:outline-primary focus-visible:-outline-offset-3'
      }
    }
  }
})
