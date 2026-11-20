import { validateUpload } from '../factory/attachments'

// Host images for a request or feedback: { images: [{ type, data }] } → { urls }.
// Nothing is written under the repo or .factory/; the bytes go only to GitHub.
export default defineEventHandler(async (event) => {
  const f = await useFactory()
  const images = validateUpload(await readBody(event))
  if (typeof images === 'string') throw createError({ statusCode: 400, statusMessage: images })
  return guarded(async () => ({ urls: await f.github.uploadImages(images) }))
})
