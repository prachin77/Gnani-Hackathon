import { config } from "./config";
import { logger } from "./logger";

/**
 * REST base for the Gnani Batch API. Derived from `GNANI_STT_URL`
 * (wss://api.vachana.ai/stt/v3/stream -> https://api.vachana.ai), since
 * Node's fetch cannot use a ws:// or wss:// scheme.
 */
function restBaseFromSttUrl(url: string): string {
  try {
    const parsed = new URL(url.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://"));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "https://api.vachana.ai";
  }
}

const GNANI_BASE = restBaseFromSttUrl(config.stt.url);

interface DiarizeJob {
  job_id: string;
  status: string;
  message?: string;
}

interface JobStatus {
  job_id: string;
  status: string;
  progress?: { completed_files: number; total_files: number };
  cancel_reason?: string;
}

interface JobFile {
  file_id: string;
  job_id: string;
  original_path: string;
  language_code: string;
  duration_seconds: number | string | null;
  model: string;
  mode: string;
  transcript_url: string | null;
  status: string;
  error_message?: string | null;
  error_code?: string | null;
}

interface TranscriptDocument {
  full_transcript: string;
  model: string;
  language_code: string;
  language_detected?: string;
  duration_seconds: number;
  segments: Array<{
    segment_id: number;
    start_time: number;
    end_time: number;
    text: string;
    speaker_id: number | null;
    confidence: number | null;
    language_detected: string | null;
  }>;
}

/**
 * Headers for Gnani Batch REST API. The API key never leaves the server.
 */
function batchHeaders(): Record<string, string> {
  return {
    "x-api-key-id": config.stt.apiKey,
  };
}

/** Gnani rate-limits bursts (429). Retry transparently with backoff. */
const RETRY_LIMIT = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gnaniFetch(url: string, init: RequestInit = {}, retries = RETRY_LIMIT): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, init);
    if (res.status === 429 && attempt < retries) {
      const retryAfterRaw = Number(res.headers.get("retry-after"));
      const waitSec = Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? retryAfterRaw : 2 + attempt * 2;
      logger.warn("Gnani rate limited; retrying", { url, attempt: attempt + 1, waitSec });
      res.body?.cancel().catch(() => undefined);
      await sleep(Math.min(30_000, waitSec * 1000));
      continue;
    }
    return res;
  }
}

/**
 * Detects the real audio container from magic bytes. Files such as WhatsApp
 * voice notes often carry a wrong extension (e.g. ".mpeg"), and the Gnani
 * Batch API rejects unknown extensions — this returns the correct one.
 */
export function detectAudioExtension(buf: Uint8Array): string | null {
  if (buf.length < 12) return null;

  const readAscii = (offset: number, length: number) => {
    let out = "";
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(buf[offset + i] ?? 0);
    return out;
  };

  if (readAscii(0, 4) === "OggS") return ".ogg";
  if (readAscii(0, 3) === "AMR") return ".amr"; // "#!AMR\n"
  if (readAscii(0, 4) === "fLaC") return ".flac";
  if (readAscii(0, 4) === "RIFF") {
    return readAscii(8, 4) === "WAVE" ? ".wav" : ".webm";
  }
  if (readAscii(4, 4) === "ftyp") return ".mp4"; // covers .m4a/.mp4 containers
  // MPEG audio: ID3 tag or frame sync 0xFF Ex/Fx.
  if (readAscii(0, 3) === "ID3") return ".mp3";
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return ".mp3";
  if (readAscii(0, 4) === "\x1a\x45\xdf\xa3") return ".webm"; // EBML
  return null;
}

/**
 * Returns a filename whose extension is guaranteed to be one Gnani accepts,
 * remapping wrong extensions by sniffing the file's real container.
 */
export function normalizeAudioFilename(name: string, buf: Uint8Array): string {
  const supported = [".aac", ".amr", ".flac", ".m4a", ".mp3", ".mp4", ".ogg", ".opus", ".wav", ".webm"];
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  if (supported.includes(ext)) return name;

  const stem = dot >= 0 ? name.slice(0, dot) : name;
  const detected = detectAudioExtension(buf);
  // Opus in an Ogg container is consistently reported as ".opus" by Gnani's
  // own accept list; ".ogg" is also accepted. Prefer ".ogg" (plain container).
  return `${stem}${detected ?? ".ogg"}`;
}

/**
 * Build the multipart form body for a diarization batch job. Callers pass a
 * browser `File` or a Node.js `Buffer` + name + mime type.
 */
export function buildDiarizeJobForm(
  fileData: File | { buffer: Buffer | ArrayBuffer; name: string; type?: string },
  options: {
    languageCode?: string;
    numSpeakers?: number;
  } = {},
): FormData {
  const { languageCode = "indic-auto", numSpeakers = 5 } = options;

  const configJson = JSON.stringify({
    model: "prisma-v3.0",
    language_code: languageCode,
    format: "transcribe",
    mode: "transcribe",
    with_diarization: true,
    num_speakers: numSpeakers,
  });

  const form = new FormData();
  form.append("config", configJson);

  if ("buffer" in fileData) {
    // Node.js path: multer gives us a Buffer.
    const bytes = new Uint8Array(
      fileData.buffer instanceof ArrayBuffer ? fileData.buffer : new Uint8Array(fileData.buffer),
    );
    const blob = new Blob([bytes], { type: fileData.type ?? "application/octet-stream" });
    form.append("files", blob, fileData.name);
  } else {
    // Browser path: a File object.
    form.append("files", fileData);
  }

  return form;
}

/**
 * Create a diarization batch job on Gnani. The file is uploaded directly to
 * Gnani (multipart/form-data) with `with_diarization: true`.
 *
 * Gnani's direct-upload limit is 10 MB per file, so callers should reject
 * larger files before reaching this function.
 */
export async function createDiarizeJob(formData: FormData): Promise<DiarizeJob> {
  const res = await gnaniFetch(`${GNANI_BASE}/stt/v3/batch/jobs`, {
    method: "POST",
    headers: batchHeaders(),
    body: formData,
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`Gnani batch create failed (${res.status}): ${detail}`);
  }

  const body = (await res.json()) as DiarizeJob;
  logger.info("Gnani batch job created", { job_id: body.job_id, status: body.status });
  return body;
}

/**
 * Start a created batch job.
 */
export async function startDiarizeJob(jobId: string): Promise<DiarizeJob> {
  const res = await gnaniFetch(`${GNANI_BASE}/stt/v3/batch/jobs/${encodeURIComponent(jobId)}/start`, {
    method: "POST",
    headers: batchHeaders(),
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`Gnani batch start failed (${res.status}): ${detail}`);
  }

  return (await res.json()) as DiarizeJob;
}

/**
 * Poll job status. Returns the job status object.
 */
export async function getDiarizeJobStatus(jobId: string): Promise<JobStatus> {
  const res = await gnaniFetch(
    `${GNANI_BASE}/stt/v3/batch/jobs/${encodeURIComponent(jobId)}`,
    {
      method: "GET",
      headers: batchHeaders(),
    },
  );

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`Gnani batch status failed (${res.status}): ${detail}`);
  }

  return (await res.json()) as JobStatus;
}

/**
 * Cancel a running batch job (best effort).
 */
export async function cancelDiarizeJob(jobId: string): Promise<DiarizeJob> {
  const res = await gnaniFetch(`${GNANI_BASE}/stt/v3/batch/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: { ...batchHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ reason: "Cancelled by user" }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`Gnani batch cancel failed (${res.status}): ${detail}`);
  }

  return (await res.json()) as DiarizeJob;
}

/**
 * Get completed file results for a job, including transcript URLs.
 */
export async function getDiarizeJobFiles(jobId: string): Promise<JobFile[]> {
  const res = await gnaniFetch(
    `${GNANI_BASE}/stt/v3/batch/jobs/${encodeURIComponent(jobId)}/files?status=COMPLETED`,
    {
      method: "GET",
      headers: batchHeaders(),
    },
  );

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`Gnani batch files failed (${res.status}): ${detail}`);
  }

  const body = (await res.json()) as { data: JobFile[] };
  return body.data ?? [];
}

/**
 * Get failed/skipped file results for a job, including `error_message`.
 * Gnani exposes per-file failure reasons only through `/files`.
 */
export async function getDiarizeJobFailures(jobId: string): Promise<JobFile[]> {
  const res = await gnaniFetch(
    `${GNANI_BASE}/stt/v3/batch/jobs/${encodeURIComponent(jobId)}/files`,
    {
      method: "GET",
      headers: batchHeaders(),
    },
  );

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`Gnani batch files failed (${res.status}): ${detail}`);
  }

  const body = (await res.json()) as { data: JobFile[] };
  return (body.data ?? []).filter((file) => file.status !== "COMPLETED");
}

/**
 * Download a single transcript document from a transcript_url.
 */
export async function downloadDiarizeTranscript(transcriptUrl: string): Promise<TranscriptDocument> {
  const res = await fetch(transcriptUrl, {
    method: "GET",
  });

  if (!res.ok) {
    throw new Error(`Transcript download failed (${res.status})`);
  }

  return (await res.json()) as TranscriptDocument;
}
