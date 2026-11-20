export default defineAppConfig({
  ui: {
    colors: {
      primary: 'orange',
      neutral: 'stone'
    },
    scrollArea: {
      slots: {
        // Inset so parents don't clip it; orange-600 keeps 3:1 on white, where primary (500) falls short.
        root: 'scrollbar-auto-hide focus-visible:outline-orange-600 dark:focus-visible:outline-primary focus-visible:-outline-offset-3'
      }
    }
  }
})
