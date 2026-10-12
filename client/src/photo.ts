import { PHOTO_MAX_BYTES, PHOTO_SIZE } from "../../shared/types";

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    // Applies the photo's EXIF rotation, so phone selfies come out upright.
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Turns any photo from the camera or library into a small square JPEG,
 * cropped around the centre (nudged up a little, where faces usually are).
 */
export async function prepareSelfie(file: File): Promise<Blob> {
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await decode(file);
  } catch {
    throw new Error("That photo couldn't be opened. Try taking a new one.");
  }
  const w = source.width;
  const h = source.height;
  const side = Math.min(w, h);
  const sx = (w - side) / 2;
  const sy = Math.max(0, (h - side) / 2 - (h - side) * 0.2);

  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This phone couldn't process the photo.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  if ("close" in source) source.close();

  for (const quality of [0.86, 0.72, 0.58]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (blob && blob.size <= PHOTO_MAX_BYTES) return blob;
  }
  throw new Error("That photo is too large. Try another.");
}

export async function uploadSelfie(blob: Blob, token: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/photo", {
      method: "POST",
      headers: { "content-type": "image/jpeg", authorization: `Bearer ${token}` },
      body: blob,
    });
  } catch {
    throw new Error("The upload didn't go through. Check your connection and try again.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "The upload didn't go through. Try again.");
  }
}
