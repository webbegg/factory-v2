import { appendImages } from '~~/server/factory/attachments'
import type { PendingImage } from '~~/server/factory/attachments'

/** Uploading a draft's images before the action that carries its text. */
export function useAttachments() {
  const { act } = useBoard()

  /** The text with the uploaded images appended, or null when the upload was refused (already toasted). */
  async function withImages(text: string, images: PendingImage[]): Promise<string | null> {
    if (!images.length) return text
    const res = await act<{ urls: string[] }>('/api/uploads', { images: images.map(({ type, data }) => ({ type, data })) })
    return res ? appendImages(text, res.urls) : null
  }

  return { withImages }
}
