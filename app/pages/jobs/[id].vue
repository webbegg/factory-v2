<script setup lang="ts">
// Old job links open the job in the board's panel; the redirect replaces this entry, so Back skips it.
definePageMeta({
  redirect: to => ({ path: '/', query: { job: String(to.params.id) } })
})
</script>
