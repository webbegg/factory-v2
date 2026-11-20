// Uploads carry client-controlled bytes to GitHub, so the server re-checks
// every limit the board enforces and never trusts a declared type or name.
import { describe, expect, test } from 'bun:test'
import { appendImages, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, validateUpload } from './attachments'
import type { UploadImage } from './attachments'
import { FakeGitHub } from './testing'

const SIGNATURES: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
  'image/jpeg': [0xFF, 0xD8, 0xFF, 0xE0],
  'image/webp': [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]
}

function bytes(type: string, size = 32): Buffer {
  const b = Buffer.alloc(size)
  b.set(SIGNATURES[type]!)
  return b
}

const entry = (type: string, size?: number) => ({ type, data: bytes(type, size).toString('base64') })

function images(body: unknown): UploadImage[] {
  const res = validateUpload(body)
  if (typeof res === 'string') throw new Error(`refused: ${res}`)
  return res
}

describe('validateUpload', () => {
  test('limits', () => {
    expect(MAX_IMAGES).toBe(5)
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024)
    expect(IMAGE_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp'])
  })

  for (const type of IMAGE_TYPES) {
    test(`accepts 1 and 5 valid ${type} images and decodes them`, () => {
      const one = images({ images: [entry(type)] })
      expect(one).toHaveLength(1)
      expect(one[0]!.type).toBe(type)
      expect(Buffer.from(one[0]!.bytes).equals(bytes(type))).toBe(true)
      expect(images({ images: Array.from({ length: 5 }, () => entry(type)) })).toHaveLength(5)
    })
  }

  test('refuses a body that is not { images: [...] }', () => {
    for (const body of [null, 'x', [], {}, { images: 'x' }, { images: {} }]) {
      expect(validateUpload(body)).toBeTypeOf('string')
    }
  })

  test('refuses 0 and 6 images', () => {
    expect(validateUpload({ images: [] })).toContain('at least one')
    expect(validateUpload({ images: Array.from({ length: 6 }, () => entry('image/png')) })).toContain('at most 5')
  })

  test('refuses an entry without a string type and a string data', () => {
    for (const bad of [null, 'x', { data: entry('image/png').data }, { type: 'image/png' }, { type: 1, data: 'x' }, { type: 'image/png', data: 1 }]) {
      expect(validateUpload({ images: [bad] })).toContain('type and data')
    }
  })

  test('refuses image/gif and image/svg+xml', () => {
    expect(validateUpload({ images: [{ type: 'image/gif', data: 'R0lGODlh' }] })).toContain('image/gif')
    expect(validateUpload({ images: [{ type: 'image/svg+xml', data: btoa('<svg/>') }] })).toContain('image/svg+xml')
  })

  test('refuses bad base64', () => {
    for (const data of ['', 'not base64!', 'abc', 'iVBO=w==', `data:image/png;base64,${entry('image/png').data}`]) {
      expect(validateUpload({ images: [{ type: 'image/png', data }] })).toContain('base64')
    }
  })

  test('refuses MAX_IMAGE_BYTES + 1 decoded bytes and accepts MAX_IMAGE_BYTES', () => {
    expect(images({ images: [entry('image/png', MAX_IMAGE_BYTES)] })[0]!.bytes.length).toBe(MAX_IMAGE_BYTES)
    expect(validateUpload({ images: [entry('image/png', MAX_IMAGE_BYTES + 1)] })).toContain('5 MB')
  })

  test('refuses a type/signature mismatch', () => {
    expect(validateUpload({ images: [{ type: 'image/png', data: entry('image/jpeg').data }] })).toContain('not a image/png')
    expect(validateUpload({ images: [{ type: 'image/jpeg', data: entry('image/webp').data }] })).toContain('not a image/jpeg')
    const riffNotWebp = Buffer.from(bytes('image/webp')).fill(0x41, 8, 12).toString('base64')
    expect(validateUpload({ images: [{ type: 'image/webp', data: riffNotWebp }] })).toContain('not a image/webp')
  })

  test('never returns a client-supplied name', () => {
    const out = images({ images: [
      { ...entry('image/png'), name: '../../etc/passwd' },
      { ...entry('image/jpeg'), name: 'x.png' },
      entry('image/webp')
    ] })
    expect(out.map(i => i.name)).toEqual(['screenshot-1.png', 'screenshot-2.jpg', 'screenshot-3.webp'])
  })
})

describe('appendImages', () => {
  test('appends one markdown image line per URL, numbered in order', () => {
    expect(appendImages('Look', ['https://a/1', 'https://a/2']))
      .toBe('Look\n\n![screenshot-1](https://a/1)\n![screenshot-2](https://a/2)')
  })

  test('leaves the text alone without URLs', () => {
    expect(appendImages('Look', [])).toBe('Look')
  })
})

describe('FakeGitHub.uploadImages', () => {
  test('records the call and returns one URL per image in order', async () => {
    const gh = new FakeGitHub()
    const imgs = images({ images: [entry('image/png'), entry('image/jpeg')] })
    expect(await gh.uploadImages(imgs)).toEqual([
      'https://github.com/user-attachments/assets/fake-1-screenshot-1.png',
      'https://github.com/user-attachments/assets/fake-2-screenshot-2.jpg'
    ])
    expect(gh.calls).toEqual([['uploadImages', ['screenshot-1.png', 'screenshot-2.jpg']]])
  })
})
