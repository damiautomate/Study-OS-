// Browser upload with real progress + stall detection.
// supabase-js's upload() gives no progress and can hang silently on big files,
// so we mint a signed upload URL and PUT with XHR.

export const MAX_UPLOAD_MB = 50; // Supabase's default per-file limit (raise in Storage settings if your plan allows)

export function checkFileSize(f: File): string | null {
  const mb = f.size / (1024 * 1024);
  if (mb > MAX_UPLOAD_MB) {
    return `"${f.name}" is ${mb.toFixed(0)}MB — over the ${MAX_UPLOAD_MB}MB per-file upload limit. Zip it (compression usually fixes it), split it, or raise the limit in Supabase → Storage → Settings.`;
  }
  return null;
}

export async function uploadWithProgress(
  supabase: any,
  bucket: string,
  path: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path);
  if (error || !data?.token) throw new Error(error?.message ?? "could not start upload");

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const url = `${base}/storage/v1/object/upload/sign/${bucket}/${path}?token=${encodeURIComponent(data.token)}`;

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastTick = Date.now();
    const stallTimer = setInterval(() => {
      if (Date.now() - lastTick > 90_000) { // no bytes moved for 90s
        clearInterval(stallTimer);
        xhr.abort();
        reject(new Error(`upload of "${file.name}" stalled — check your connection and try again`));
      }
    }, 5_000);

    xhr.upload.onprogress = (e) => {
      lastTick = Date.now();
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      clearInterval(stallTimer);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let msg = `upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText)?.message ?? msg; } catch { /* */ }
        reject(new Error(`${file.name}: ${msg}`));
      }
    };
    xhr.onerror = () => { clearInterval(stallTimer); reject(new Error(`network error uploading "${file.name}"`)); };
    xhr.onabort = () => clearInterval(stallTimer);

    xhr.open("PUT", url);
    xhr.setRequestHeader("x-upsert", "false");
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    xhr.send(file);
  });
}
