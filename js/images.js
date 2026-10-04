// Product photos are stored as small JPEG data URLs so they show offline and
// don't depend on Open Food Facts staying online. ~10–20 KB each.
const SIZE = 240;

function toDataUrl(source, w, h) {
  // Centre-crop to a square, then scale down.
  const side = Math.min(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(SIZE, side);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, (w - side) / 2, (h - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.75);
}

async function blobToThumb(blob) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    return toDataUrl(bmp, bmp.width, bmp.height);
  } finally {
    bmp.close?.();
  }
}

// From a photo the user took or picked.
export function fileToThumb(file) {
  return blobToThumb(file);
}

// Downloads a remote image (e.g. from Open Food Facts) and stores a local copy.
// Falls back to the original URL if it can't be fetched.
export async function cacheRemoteImage(url, timeoutMs = 6000) {
  if (!url || url.startsWith('data:')) return url;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, mode: 'cors' });
    if (!res.ok) return url;
    return await blobToThumb(await res.blob());
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}
