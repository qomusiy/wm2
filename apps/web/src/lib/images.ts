import { LIMITS } from '@watchroom/protocol';

export interface PreparedImage {
  blob: Blob;
  type: string;
  width: number;
  height: number;
}

const MAX_SIDE = 1600;
const ACCEPTED = /^image\/(png|jpeg|gif|webp|avif|heic|heif|bmp)$/;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Shrink and re-encode a picture before it leaves this device: keeps the host's upload free for video and
 * removes metadata such as GPS location (re-encoding drops EXIF). Animated GIFs are sent as they are.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!ACCEPTED.test(file.type)) throw new Error('Only pictures can be shared (JPEG, PNG, GIF, WebP).');
  if (file.type === 'image/gif') {
    if (file.size > LIMITS.imageMaxBytes) throw new Error('That GIF is too large (8 MB max).');
    const bmp = await createImageBitmap(file);
    const out = { blob: file, type: 'image/gif', width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This picture could not be opened.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot prepare pictures.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  // WebP where the browser can encode it, otherwise JPEG (or PNG when there is transparency to keep).
  let blob = await canvasToBlob(canvas, 'image/webp', 0.82);
  if (!blob || blob.type !== 'image/webp') blob = await canvasToBlob(canvas, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
  if (!blob) throw new Error('This picture could not be prepared.');
  if (blob.size > LIMITS.imageMaxBytes) throw new Error('That picture is too large to send.');
  return { blob, type: blob.type, width, height };
}

export async function uploadImage(img: PreparedImage): Promise<{ id: string; width: number; height: number }> {
  const res = await fetch('/api/chat/images', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': img.type }, body: img.blob,
  });
  if (res.status === 429) throw new Error('You are sending pictures too fast. Wait a moment.');
  if (!res.ok) throw new Error('The picture could not be sent.');
  return res.json() as Promise<{ id: string; width: number; height: number }>;
}

export function imageFromClipboard(e: ClipboardEvent | React.ClipboardEvent): File | null {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}
