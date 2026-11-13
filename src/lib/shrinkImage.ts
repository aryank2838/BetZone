/** Largest file we will try to shrink; anything bigger is rejected outright. */
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
/** Upload limit enforced by the payment-screenshots bucket. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Size of the image after scaling so its longest side is at most `maxSide`. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * Shrinks a payment screenshot before upload so it goes up quickly on mobile
 * data. The longest side is capped at 2000px, which keeps UTR numbers and
 * amounts easy to read. Small files are left alone, and if anything fails
 * (old browser, unreadable image) the original file is returned unchanged.
 */
export async function shrinkImage(file: File, { maxSide = 2000, quality = 0.85, skipBelowBytes = 500 * 1024 } = {}): Promise<File> {
  try {
    const image = await decode(file);
    try {
      const target = fitWithin(image.width, image.height, maxSide);
      const needsResize = target.width !== image.width || target.height !== image.height;
      if (!needsResize && file.size <= skipBelowBytes) return file;

      const canvas = document.createElement('canvas');
      canvas.width = target.width;
      canvas.height = target.height;
      const context = canvas.getContext('2d');
      if (!context) return file;
      context.fillStyle = '#ffffff'; // transparent PNG areas would turn black in JPEG
      context.fillRect(0, 0, target.width, target.height);
      context.drawImage(image.source, 0, 0, target.width, target.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob || blob.size >= file.size) return file;
      const name = file.name.replace(/\.[^.]+$/, '') || 'screenshot';
      return new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
    } finally {
      image.close();
    }
  } catch {
    return file;
  }
}
