// Uploads a video clip from the control room in chunks (Block 4). Each chunk
// is one request, well under the Workers request limit, and one stored row.

import { VIDEO_MAX_BYTES, VIDEO_TYPES } from "../../shared/types";
import { storage } from "./net";

/** Reads the clip's length in the browser, if it can. */
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (ms: number | null) => {
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    v.preload = "metadata";
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    v.src = url;
  });
}

export async function uploadVideo(file: File, onProgress: (fraction: number) => void): Promise<string> {
  const type = file.type || (file.name.toLowerCase().endsWith(".mov") ? "video/quicktime" : "");
  if (!(VIDEO_TYPES as readonly string[]).includes(type)) throw new Error("Videos must be MP4, WebM or MOV files.");
  if (file.size > VIDEO_MAX_BYTES) throw new Error(`Videos can be up to ${Math.round(VIDEO_MAX_BYTES / 1024 / 1024)} MB. Trim it or lower its quality first.`);
  const token = storage("fm.hostToken").get() ?? "";
  const auth = { authorization: `Bearer ${token}` };
  const durationMs = await probeDuration(file);
  const name = file.name.replace(/\.[^.]+$/, "");

  const begin = await fetch("/api/video", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name, type, size: file.size, durationMs }),
  }).catch(() => null);
  if (!begin) throw new Error("The upload didn't start. Check your connection.");
  const info = (await begin.json().catch(() => ({}))) as { id?: string; chunkSize?: number; chunks?: number; error?: string };
  if (!begin.ok || !info.id || !info.chunkSize || !info.chunks) throw new Error(info.error ?? "The upload didn't start.");

  for (let i = 0; i < info.chunks; i++) {
    const part = file.slice(i * info.chunkSize, (i + 1) * info.chunkSize);
    let ok = false;
    let error = "Part of the upload failed. Try again.";
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const res = await fetch(`/api/video/${info.id}/chunk/${i}`, { method: "PUT", headers: { ...auth, "content-type": "application/octet-stream" }, body: part }).catch(() => null);
      ok = !!res?.ok;
      if (res && !res.ok) error = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? error;
    }
    if (!ok) throw new Error(error);
    onProgress((i + 1) / info.chunks);
  }

  const done = await fetch(`/api/video/${info.id}/done`, { method: "POST", headers: auth }).catch(() => null);
  const body = (await done?.json().catch(() => ({}))) as { id?: string; error?: string } | undefined;
  if (!done?.ok) throw new Error(body?.error ?? "The upload didn't finish. Try again.");
  return info.id;
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
