// Image uploads for requests and feedback. No Node or Nuxt imports: the board
// imports the limits from here, and the server re-checks every upload with it.

export const MAX_IMAGES = 5
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

/** An image as the board sends it: `data` is base64 without a `data:` prefix. */
export interface PendingImage {
  type: string
  data: string
}

/** A validated image; `name` is ours, never the client's. */
export interface UploadImage {
  name: string
  type: string
  bytes: Uint8Array
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
// A flat character class: grouped repetition overflows V8's regex stack on megabytes of data.
const BASE64 = /^[A-Z0-9+/]*={0,2}$/i

// A declared type is client-controlled; the leading bytes are what GitHub will serve.
function matchesSignature(type: string, b: Uint8Array): boolean {
  const at = (offset: number, sig: number[]) => sig.every((v, i) => b[offset + i] === v)
  const ascii = (s: string) => [...s].map(c => c.charCodeAt(0))
  if (type === 'image/png') return at(0, [0x89, 0x50, 0x4E, 0x47])
  if (type === 'image/jpeg') return at(0, [0xFF, 0xD8, 0xFF])
  return at(0, ascii('RIFF')) && at(8, ascii('WEBP'))
}

/** Checks a `POST /api/uploads` body; returns the decoded images or why it was refused. */
export function validateUpload(body: unknown): UploadImage[] | string {
  const list = (body as { images?: unknown } | null)?.images
  if (!Array.isArray(list)) return 'expected { images: [...] }'
  if (!list.length) return 'attach at least one image'
  if (list.length > MAX_IMAGES) return `attach at most ${MAX_IMAGES} images`
  const out: UploadImage[] = []
  for (const [i, entry] of list.entries()) {
    const n = i + 1
    const { type, data } = (entry ?? {}) as { type?: unknown, data?: unknown }
    if (typeof type !== 'string' || typeof data !== 'string') return `image ${n} needs a string type and data`
    if (!IMAGE_TYPES.includes(type)) return `image ${n}: ${type} is not allowed (png, jpeg or webp only)`
    if (!data || data.length % 4 || !BASE64.test(data)) return `image ${n}: data is not valid base64`
    // Check the decoded size before decoding, so an oversized body costs nothing.
    const size = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
    if (size > MAX_IMAGE_BYTES) return `image ${n} is over 5 MB`
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
    if (!matchesSignature(type, bytes)) return `image ${n} is not a ${type}`
    out.push({ name: `screenshot-${n}.${EXTENSIONS[type]}`, type, bytes })
  }
  return out
}

/** The text with one markdown image line per uploaded URL. */
export function appendImages(text: string, urls: string[]): string {
  if (!urls.length) return text
  return `${text}\n\n${urls.map((url, i) => `![screenshot-${i + 1}](${url})`).join('\n')}`
}
