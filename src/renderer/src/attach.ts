import type { ChatFile } from '../../shared/types'

// Files dropped, pasted or picked into a chat, made ready to store. Images
// are shrunk here, to the 1568px long side the models work at, so what's
// stored and sent each turn is small; ones already that size stay as they are.

const MAX_SIDE = 1568
const AS_IS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const AS_IS_BYTES = 3.5 * 1024 * 1024
const MAX_BYTES = 30 * 1024 * 1024

export async function prepare(
  file: File
): Promise<{ name: string; mime: string; data: Uint8Array }> {
  if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(file)
    } catch {
      throw new Error(`${file.name} is an image Orcha can't open. Save it as a PNG or JPEG.`)
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && AS_IS.includes(file.type) && file.size <= AS_IS_BYTES) {
      bitmap.close()
      return { name: file.name, mime: file.type, data: new Uint8Array(await file.arrayBuffer()) }
    }
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
    return { name: file.name, mime: 'image/webp', data: new Uint8Array(await blob.arrayBuffer()) }
  }
  if (file.size > MAX_BYTES)
    throw new Error(`${file.name} is too big to attach (the limit is 30 MB).`)
  return { name: file.name, mime: file.type, data: new Uint8Array(await file.arrayBuffer()) }
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

// Where a stored image is shown from (main serves orcha-file://).
export const imageUrl = (file: ChatFile): string =>
  `orcha-file://f/${file.hash}.${IMAGE_EXT[file.mime] ?? 'png'}`

// "PDF · 12 pages", "Text · 4k characters": what a file chip says under its name.
export function fileMeta(file: Pick<ChatFile, 'kind' | 'pages' | 'chars' | 'name'>): string {
  if (file.kind === 'pdf')
    return file.pages ? `PDF · ${file.pages} page${file.pages === 1 ? '' : 's'}` : 'PDF'
  const ext = /\.([^.]+)$/.exec(file.name)?.[1].toUpperCase() ?? 'Text'
  const chars = file.chars ?? 0
  return chars >= 1000 ? `${ext} · ${Math.round(chars / 1000)}k characters` : ext
}
