<script setup lang="ts">
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES } from '~~/server/factory/attachments'
import type { PendingImage } from '~~/server/factory/attachments'

// Wraps an input (its default slot): images pasted or dropped anywhere inside it,
// or captured with the button, become pending attachments sent on submit.
const images = defineModel<PendingImage[]>({ required: true })
const toast = useToast()
const canCapture = ref(false)
const capturing = ref(false)

onMounted(() => {
  canCapture.value = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
})

const FULL = `At most ${MAX_IMAGES} images per message.`

// Same limits as the server, so a refused image is never read or uploaded.
function problem(type: string, size: number, label: string): string | null {
  if (images.value.length >= MAX_IMAGES) return FULL
  if (!IMAGE_TYPES.includes(type)) return `${label} is ${type || 'not an image'}; attach PNG, JPEG or WebP.`
  if (size > MAX_IMAGE_BYTES) return `${label} is over 5 MB.`
  return null
}

function refuse(description: string) {
  toast.add({ title: 'Image not attached', description, color: 'error' })
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('could not read the image'))
    reader.readAsDataURL(blob)
  })
}

async function addBlobs(blobs: Array<{ blob: Blob, label: string }>) {
  for (const { blob, label } of blobs) {
    const why = problem(blob.type, blob.size, label)
    if (why) {
      refuse(why)
      continue
    }
    const data = await base64(blob)
    // Another paste or drop may have filled the list while this one was read.
    if (images.value.length >= MAX_IMAGES) {
      refuse(FULL)
      continue
    }
    images.value = [...images.value, { type: blob.type, data }]
  }
}

const addFiles = (files: FileList | undefined) => addBlobs([...files ?? []].map(blob => ({ blob, label: blob.name || 'The image' })))

function onPaste(e: ClipboardEvent) {
  // Only a pasted file is ours; pasting text keeps the field's default behaviour.
  if (!e.clipboardData?.files.length) return
  e.preventDefault()
  void addFiles(e.clipboardData.files)
}

function onDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
}

function onDrop(e: DragEvent) {
  if (!e.dataTransfer?.files.length) return
  e.preventDefault()
  void addFiles(e.dataTransfer.files)
}

async function capture() {
  if (images.value.length >= MAX_IMAGES) return refuse(FULL)
  // Busy from the picker on, so a second click can't open another one.
  capturing.value = true
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
  } catch (err) {
    capturing.value = false
    // Cancelling the picker rejects with NotAllowedError; that is not a failure.
    if ((err as DOMException).name !== 'NotAllowedError') refuse(String(err))
    return
  }
  try {
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    await video.play()
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (blob) await addBlobs([{ blob, label: 'The screenshot' }])
  } finally {
    // One frame only: stopping every track ends the browser's sharing indicator.
    for (const track of stream.getTracks()) track.stop()
    capturing.value = false
  }
}

function remove(i: number) {
  images.value = images.value.filter((_, j) => j !== i)
}
</script>

<template>
  <div
    class="space-y-3"
    @paste="onPaste"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <slot />
    <div class="flex flex-wrap items-center gap-2">
      <UButton
        v-if="canCapture"
        type="button"
        label="Add screenshot"
        icon="i-lucide-screen-share"
        color="neutral"
        variant="subtle"
        size="sm"
        :loading="capturing"
        :disabled="capturing"
        @click="capture"
      />
      <span class="text-xs text-muted">
        or paste / drop images: PNG, JPEG or WebP, up to {{ MAX_IMAGES }}, 5 MB each
      </span>
    </div>
    <ul
      v-if="images.length"
      class="flex flex-wrap gap-3"
    >
      <li
        v-for="(img, i) in images"
        :key="i"
        class="relative"
      >
        <img
          :src="`data:${img.type};base64,${img.data}`"
          :alt="`Screenshot ${i + 1}`"
          class="h-20 max-w-40 rounded-md border border-default object-cover"
        >
        <UButton
          type="button"
          icon="i-lucide-x"
          size="xs"
          color="neutral"
          class="absolute -end-2 -top-2 rounded-full"
          :aria-label="`Remove screenshot ${i + 1}`"
          @click="remove(i)"
        />
      </li>
    </ul>
    <p
      v-if="images.length"
      class="flex items-start gap-1.5 text-xs text-muted"
    >
      <UIcon
        name="i-lucide-info"
        class="mt-0.5 shrink-0"
      />
      When you send, these images are uploaded to GitHub as attachments of this project's repository.
      Anyone who can see the repository can open them: everyone if it is public, people with access if it is private.
    </p>
  </div>
</template>
