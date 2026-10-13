import { IMAGE_MAX_BYTES, IMAGE_MAX_SIDE } from "../../shared/types";
import { storage } from "./net";

/** Shrinks a picture to fit the TV and uploads it. Returns the stored image id. */
export async function uploadQuizImage(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That picture couldn't be opened. Try a JPEG or PNG.");
  }
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser couldn't process the picture.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let blob: Blob | null = null;
  for (const q of [0.88, 0.75, 0.6]) {
    blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    if (blob && blob.size <= IMAGE_MAX_BYTES) break;
  }
  if (!blob || blob.size > IMAGE_MAX_BYTES) throw new Error("That picture is too large.");

  const token = storage("fm.hostToken").get() ?? "";
  const res = await fetch("/api/image", {
    method: "POST",
    headers: { "content-type": "image/jpeg", authorization: `Bearer ${token}` },
    body: blob,
  }).catch(() => null);
  if (!res) throw new Error("The upload didn't go through. Check your connection.");
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? "The upload didn't go through.");
  return body.id;
}
