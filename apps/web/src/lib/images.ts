/**
 * Client-side image helpers for the "paste / attach a picture for scope"
 * flows (direct-ingest, gathering link-share, reviewer panel).
 *
 * Two jobs:
 *   - downscaleImage(): cap the long edge before upload. Vision models
 *     tokenise images by pixel area (and downscale anything past ~1568px
 *     themselves), so shrinking client-side keeps cost + upload size
 *     minimal with no accuracy loss. It also re-encodes formats the
 *     models reject (HEIC/BMP) into PNG so they don't get skipped server-
 *     side.
 *   - imageFromClipboard(): pull a pasted screenshot out of a paste event
 *     so "Cmd/Ctrl+V a screenshot" turns into a file upload.
 *
 * Everything degrades safely: a decode failure returns the original file
 * untouched rather than throwing, so a quirky image still uploads (the
 * server gives a clear skip message if it ultimately can't read it).
 */

/** MIME types the vision models accept directly. Anything else gets
 *  rasterised to PNG by downscaleImage. */
const MODEL_SUPPORTED = ['image/png', 'image/jpeg', 'image/webp'];

/** Long-edge cap. Matches Anthropic's recommended max (it downscales past
 *  this anyway) and keeps Gemini's image tiling cheap. Big enough that
 *  screenshot text stays legible to the model. */
const DEFAULT_MAX_EDGE = 1568;

/** Is this file an image we should route through the picture flow? Checks
 *  MIME first, then the extension (clipboard / octet-stream uploads). */
export function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(file.name);
}

/**
 * Downscale + normalise an image for upload. Returns a new File when it
 * resized or re-encoded, or the original File when it was already small
 * and in a supported format (or when decoding failed). Non-images,
 * animated GIFs, and SVGs are passed through untouched.
 */
export async function downscaleImage(file: File, maxEdge = DEFAULT_MAX_EDGE): Promise<File> {
  if (!file.type.startsWith('image/') && !isImageFile(file)) return file;
  // Keep animation (GIF) and vector (SVG) intact — rasterising them loses
  // information and they're rarely "scope screenshots" anyway.
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;

  try {
    const bitmap = await createImageBitmap(file);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const needsResize = longEdge > maxEdge;
    const needsReencode = !MODEL_SUPPORTED.includes(file.type);
    if (!needsResize && !needsReencode) {
      bitmap.close?.();
      return file;
    }

    const scale = needsResize ? maxEdge / longEdge : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    // Preserve JPEG for photos (smaller); everything else → PNG to keep
    // screenshot text crisp.
    const outType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outType, 0.92),
    );
    if (!blob) return file;

    return new File([blob], swapExtension(file.name, outType), { type: outType });
  } catch {
    // Browser couldn't decode (e.g. HEIC on a browser without support).
    // Return as-is; the server surfaces a clear "convert to PNG/JPEG".
    return file;
  }
}

/**
 * Pull the first image out of a paste event, or null if the clipboard
 * holds no image. Clipboard screenshots usually arrive with an empty
 * filename, so we synthesise one (the extension + S3 key + content-type
 * sniff all expect a real name).
 */
export function imageFromClipboard(
  e: React.ClipboardEvent | ClipboardEvent,
): File | null {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (!f) continue;
      if (!f.name || f.name === 'image.png') {
        const ext = f.type.split('/')[1] || 'png';
        return new File([f], `pasted-${Date.now()}.${ext}`, { type: f.type });
      }
      return f;
    }
  }
  return null;
}

/** Swap a filename's extension to match a re-encoded MIME type. Appends
 *  one when the original had none. */
function swapExtension(name: string, mime: string): string {
  const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
  const base = name.replace(/\.[^./\\]+$/, '');
  return `${base || 'image'}.${ext}`;
}
