# Voice-to-Text — Gnani Prisma v3.0

Real-time and batch, multilingual **speech-to-text with automatic speaker diarization**, in the browser, powered by **Gnani Prisma v3.0**.

Two independent pipelines, one app:

| | Realtime | Batch (uploaded file) |
| --- | --- | --- |
| Input | Microphone (live) | Audio file **or the recorded live session** (≤ 10 MB) |
| Endpoint | `WS /ws/stt/realtime` → Gnani realtime WebSocket | `POST /api/stt/batch/diarize` → Gnani Batch Jobs REST API |
| Output | Live transcript, language per utterance | Full transcript + **`speaker_id` per segment** (diarized) + timestamps |
| Latency | Sub-second per utterance | Minutes (async job, polled every 10 s) |
| Languages | Auto-detected (`indic-auto`) | Auto-detected (`indic-auto`) |

No translation, no simulated text, no user accounts — and the **Gnani API key never leaves the server**.

---

## Quick start

**Requirements:** Node.js **20.19+** (or 22.12+), a microphone (for realtime), and a Gnani API key.

1. Put your key in `.env` at the project root (a file already exists — keep it out of version control):

   ```env
   GNANI_API_KEY=your-gnani-api-key
   PORT=8787
   ```

2. Install and run:

   ```bash
   npm install
   npm run dev
   ```

3. Open **http://localhost:5173**

   The Vite dev server proxies `/api` and `/ws` to the backend on port `8787`.

### Production-style run

```bash
npm run build
npm start
```

Open **http://localhost:8787** — Express serves the built frontend and hosts both the WebSocket proxy and the REST proxy on the same origin.

> Do **not** open the HTML file directly (`file://`). `getUserMedia` requires a secure context: `localhost` or HTTPS.

---

## Feature tour

### 1. Realtime microphone transcription

- Click **Record Audio** → your mic streams to Gnani through the secure proxy.
- Each finished utterance appears with a **language badge** (Prisma detects the language per utterance — Indian English, Hindi, Tamil, Telugu, Bengali, Marathi, Gujarati, Kannada, Malayalam, Punjabi, including code-switching).
- Live waveform, recording timer, speech/processing indicators, connection status.
- While recording, the **exact 16 kHz PCM** that is streamed to Gnani is also kept in memory, so the clip used for diarization is the same audio that produced the live transcript.
- On **Stop**, that PCM is encoded to **MP3** (16 kHz mono, 32 kbps). MP3 carries real duration metadata; `MediaRecorder`'s live WebM does not, and Gnani rejects such files with `file reports no usable duration ("")`.
- The stopped card offers **Download recording (MP3)** so you can verify the exact file the batch API receives.
- **Stop** finalizes gracefully: trailing silence → `commit` → wait for the last transcript → close, so the final sentence is never lost.

#### What happens on Stop (automatic)

1. The whole live session recording is uploaded to the server and turned into a Gnani **Batch STT job** (Prisma v3.0) — no extra click, no second upload.
2. The panel shows the usual diarization stages (*Uploading → Starting job → Diarizing → Fetching transcripts → Complete*).
3. When it finishes you get **two transcripts side by side**:
   - **Diarized transcript (speakers)** — green `Speaker N` badges and `start – end` timestamps. **This is the canonical text** to send to translation/summary.
   - **Live transcript (raw)** — exactly what streamed during recording, without speaker separation.
4. If the session captured no speech, only the raw transcript card is shown.

> The session is encoded to **MP3 at 32 kbps**, so even a 15-minute session stays around ~3.6 MB — comfortably under the 10 MB batch limit. The PCM buffer is ~28.8 MB per 15 minutes in browser memory (realtime sessions are capped by Gnani), and it is released on Reset/Done.

### 2. Batch upload with speaker diarization

1. Click **Upload Audio** and choose a file → the app validates it and shows a **ready state**. Nothing is sent yet in this confirmed two-step flow.
2. Click **Generate Transcript** → the file uploads to *your* server, which creates a Gnani **Batch STT job** (Prisma v3.0).
3. The panel tracks every stage — *Ready → Uploading → Starting job → Diarizing → Fetching transcripts → Complete* — with a progress bar. Status is polled every 10 s automatically.
4. When done, segments appear with green **Speaker N** badges and `start – end` timestamps. Cancel stops local polling **and** asks Gnani to cancel the running job (best effort).

**You upload once, click once.** Diarization is configured entirely on the backend — the frontend has no language, model or speaker options.

### 3. Transcript panel

- Copy the whole transcript (with clipboard fallback for older browsers), confirm-to-clear.
- Empty/error states explain what happened ("No speech detected", "No transcript produced").
- Realtime, live-session diarization and uploaded-file batch use **separate state**, so none can clear or interrupt the others.

---

## Architecture

```
REALTIME (streaming, unchanged flow)
Browser                          Node server                        Gnani
───────                          ───────────                        ─────
getUserMedia
  → AudioContext
  → AudioWorklet ──PCM 1 KB──►  /ws/stt/realtime  ──+ x-api-key-id ──►  wss://api.vachana.ai/stt/v3/stream
    mono 16 kHz                                                  ◄── connected / speech_start /
    s16le, 32 ms                                                     processing / transcript (JSON)

BATCH + DIARIZATION (REST jobs — uploaded file or recorded live session)
Browser                          Node server                        Gnani
───────                          ───────────                        ─────
live: streamed 16 kHz mono PCM (same frames sent to Gnani)
  → MP3 encode (32 kbps)        (uploaded file path is identical;
  → File("live-session.mp3")     the recording is just another file)
POST /api/stt/batch/diarize ──►  multipart forward ────────────►   POST /stt/v3/batch/jobs
   (original file bytes)             config: model prisma-v3.0     → 201 { job_id, CREATED }
                                     format transcribe
                                     with_diarization false (labels still
                                       produced by prisma-v3.0; prevents a
                                       diarization failure failing the file)
POST /:id/start ─────────────►  ─────────────────────────────►   POST /stt/v3/batch/jobs/:id/start
GET  /:id (every 10 s) ──────►  ───── polling ────────────────►  GET /stt/v3/batch/jobs/:id
GET  /:id/files ─────────────►  ─────────────────────────────►  GET .../files?status=COMPLETED
GET  /download?url=... ──────►  fetch transcript_url ─────────►  (presigned URL)
                                  ◄── segments[] with speaker_id ─
```

### What the server does for batch (all transparent to the user)

| Concern | Handling |
| --- | --- |
| Wrong file extensions | The real container is **sniffed from magic bytes** (`OggS`, `RIFF/WAVE`, `ID3`, `ftyp`, `fLaC`, `AMR`, EBML…) and the filename is normalized before upload — WhatsApp voice notes that masquerade as `.mpeg` are fixed automatically. |
| Gnani rate limits | Every Gnani REST call is wrapped in a retry: on **429** it retries up to **4 times** with backoff (honours `Retry-After`, otherwise 2 s → 4 s → 6 s → 8 s). Logged as `Gnani rate limited; retrying`. |
| Slow processing | Diarization is an async job; the frontend polls `/status` every **10 s** (Gnani's recommended minimum) for up to **30 minutes**. |
| Cancel | `Cancel` stops polling and calls Gnani's `/cancel` endpoint so the job stops server-side too. |
| Route safety | The literal `/download` route is registered **before** `/:jobId` routes so Express never parses `"download"` as a UUID. |
| Secrets | `x-api-key-id` is attached **only** on the server; the browser talks to your server, never to Gnani. |

### Realtime session tuning (server-side headers)

```
x-api-key-id:       GNANI_API_KEY   (from .env, never sent to the browser)
model:              prisma-v3.0
language_code:      indic-auto
x-sample-rate:      16000
format:             transcribe
x-min-silence-ms:   500
x-vad-threshold:    0.6
x-idle-timeout-sec: 300   ← keeps quiet sessions alive past Gnani's 60 s default
x-max-speech-s:     30    ← forces a transcript mid-monologue so results keep flowing
```

---

## Batch input requirements & limits

| Item | Value |
| --- | --- |
| Max file size | **10 MB** (Gnani's direct-upload limit) |
| Accepted extensions (browser picker) | `audio/*`, `.wav`, `.mp3`, `.m4a`, `.aac`, `.ogg`, `.oga`, `.opus`, `.flac`, `.webm`, `.mpeg`, `.mpga`, `.mp4` |
| Accepted by Gnani | `.aac .amr .flac .m4a .mp3 .mp4 .ogg .opus .wav .webm` — mismatched extensions are auto-corrected via magic-byte sniffing |
| Max speakers | Up to `num_speakers: 5` (Prisma v3.0 produces labels regardless; `with_diarization` is kept **false** so a diarization hiccup cannot fail the whole file) |
| Max audio duration | 4 h per file (Gnani), but 10 MB usually binds first — use MP3/OGG for long recordings |
| Poll interval | 10 s; job polling gives up after ~30 minutes |
| `transcript_url` expiry | 1 h — refunded automatically by re-fetching files |

**Why 10 MB?** Gnani's Batch API caps direct multipart uploads at 10 MB; larger files need their presigned-upload flow (`POST /stt/v3/batch/v2/jobs`), not yet implemented here.

---

## Project structure

```
.
├── server/
│   ├── server.ts              # Express app: static hosting, /api/health, batch diarization routes
│   ├── gnaniWebSocket.ts      # Realtime WS proxy (+ legacy /ws/stt/batch streaming path)
│   ├── gnaniBatch.ts          # Gnani Batch Jobs REST client: create/start/poll/files/download/cancel,
│   │                          #   magic-byte extension sniffing, 429 retry wrapper
│   ├── config.ts              # .env loading, Gnani session constants
│   └── logger.ts              # Structured JSON-ish console logger
├── src/
│   ├── App.tsx                # One app state: realtime or batch (disjoint), wiring
│   ├── components/
│   │   ├── BatchPanel.tsx     # Two-step upload→Generate, stage pills, progress, cancel/retry
│   │   ├── LiveTranscription.tsx  # Shared transcript panel; Speaker N badges + segment times
│   │   ├── StartActions.tsx   # Record / Upload entry cards
│   │   ├── RecordingPanel.tsx, AudioVisualizer.tsx, Header.tsx,
│   │   ├── StatusBadge.tsx, ErrorBanner.tsx
│   ├── hooks/
│   │   ├── useAudioStreaming.ts    # Realtime: capture → WS → segments (state machine)
│   │   │                           #   + PCM capture → MP3 for post-stop diarization
│   │   ├── useBatchDiarization.ts  # Batch: select → generate → upload → poll → download
│   │   └── useBatchProcessing.ts   # Legacy local-decode WS batch (unused by UI, kept for tests)
│   ├── lib/
│   │   ├── pcm.ts                 # Resampler, frame emitter, WS URL builder
│   │   ├── encode.ts              # 16 kHz mono PCM → MP3 (lamejs)
│   │   ├── batch.ts               # File validation, decode, downmix, resample (legacy path)
│   │   └── languages.ts, format.ts, errors.ts
│   ├── public/
│   │   ├── pcm-processor.js       # AudioWorklet: mono 16 kHz s16le, 512-sample frames
│   │   └── favicon.svg
│   ├── scripts/
│   │   ├── build.mjs              # Cross-platform typecheck + build
│   │   └── test-batch-audio.ts, test-batch-proxy.ts   # Offline tests (no Gnani calls)
│   ├── main.tsx
│   └── index.css
├── .env                        # GNANI_API_KEY (git-ignored)
└── .env.example
```

---

## API endpoints

### Backend (this server)

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | `{ status, model, language, sampleRate, configured }` |
| `WS /ws/stt/realtime` | Realtime browser audio (binary 1,024-byte PCM frames) + JSON control frames |
| `WS /ws/stt/batch` *(legacy)* | Uploaded-file streaming via the realtime Gnani socket, with `batch_ack` flow control |
| `POST /api/stt/batch/diarize` | Multipart upload (`file`) → creates a diarization job → `{ job_id, status }` |
| `POST /api/stt/batch/diarize/:jobId/start` | Starts the created job (`202 STARTING`) |
| `GET /api/stt/batch/diarize/:jobId` | Job status: `CREATED/STARTING/QUEUED/IN_PROGRESS/COMPLETED/PARTIAL_FAILURE/FAILED/...` |
| `GET /api/stt/batch/diarize/:jobId/files` | Completed files + `transcript_url`s |
| `POST /api/stt/batch/diarize/:jobId/cancel` | Cancel the Gnani job |
| `GET /api/stt/batch/diarize/download?url=…` | Proxies the presigned `transcript_url` and returns segment JSON |

Realtime WS accepts only exact **1,024-byte binary** frames and `{"type":"commit"}` text frames; batch WS sessions also emit `{"type":"batch_ack","frames":N}` for the client's in-flight window. Everything else is dropped and logged.

### Transcript document (downloaded JSON)

```json
{
  "full_transcript": "hello how can i help you today i am calling about my order",
  "model": "prisma-v3.0",
  "language_code": "en-IN",
  "segments": [
    {
      "segment_id": 0,
      "start_time": 0.0,
      "end_time": 0.71,
      "text": "hello",
      "speaker_id": 1,
      "language_detected": null
    }
  ]
}
```

The UI renders one card per segment: language badge (when known), **Speaker N** badge, `start – end` time range, text.

---

## Offline tests

```bash
npm run test:batch
```

Runs the legacy-path suites **without calling Gnani**:

- **Batch audio preparation** — stereo→mono downmix + padding to whole 512-sample frames, 48 kHz→16 kHz resampling, rejected formats/sizes/durations, cancellation mid-decode.
- **Batch proxy relay** — spins a fake upstream WS to prove every frame is relayed **in order** with a trailing `commit`, and that the realtime path is unaffected.

Useful for verifying the shared plumbing (resampler, framing, pacing, flow control) without network or quota concerns.

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | API (`tsx watch`, port 8787) + Vite frontend (port 5173), concurrently |
| `npm run build` | Typecheck frontend & server, then build to `dist/` |
| `npm start` | Serve `dist/` and all proxies on port 8787 |
| `npm run typecheck` | Typecheck both TypeScript projects |
| `npm run test:batch` | Offline suites for legacy audio conversion + proxy relay |
| `npm run preview` | Preview the Vite build |

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `GNANI_API_KEY` | — | **Required.** Gnani API key; verified at boot, server-side only |
| `PORT` | `8787` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `MAX_SESSIONS_PER_IP` | `2` | Concurrent realtime Gnani streams per client IP |
| `GNANI_STT_URL` | `wss://api.vachana.ai/stt/v3/stream` | Override the realtime upstream (its host is reused for batch REST calls) |
| `API_TARGET` (dev) | `http://localhost:8787` | Vite's proxy target for `/api` and `/ws` |

---

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| "Microphone access was blocked" / prompt never appears | Allow mic access in site settings; use `localhost` or HTTPS. Reload. |
| `401` / "API credentials rejected" | `GNANI_API_KEY` missing/invalid — check `.env`, restart. |
| `502` "Gnani batch… (400 INVALID_CONFIG) unsupported format" | Mixed-extension file; **rare now** — the server sniffs the magic bytes and renames before upload. If you still see it, the container is genuinely unusable by Gnani: re-encode to WAV/MP3. |
| `429 RATE_LIMITED` | Normal burst limiting. The server retries automatically (watch for `Gnani rate limited; retrying` logs). If it persists after 4 attempts, wait ~1 min and click Generate again. |
| Batch job stuck in `IN_PROGRESS` | Long files legitimately take minutes. Keep the tab open; polling continues. Cancel if needed. |
| `504` "Could not reach the transcription service" | Your server couldn't reach `api.vachana.ai` — check internet/proxy/firewall. |
| 422 "invalid character … `download`" | Should not occur (routes ordered correctly); means an old build is cached — rebuild (`npm run build`). |
| "This file is larger than 10 MB" | Batch direct upload is capped at 10 MB. Compress to MP3/OGG, trim, or split the recording. |
| "file reports no usable duration" | Can only come from an old/cached build that still uploads `MediaRecorder` WebM. The current build uploads `live-session.mp3` encoded from the streamed PCM, which always has a duration. Hard-reload the page (`Ctrl+Shift+R`). |
| Batch ends with `FAILED` / `START_FAILED` | You now see Gnani's per-file reason in the UI (e.g. `Empty transcript after 3 retries`), and it is logged as `Gnani batch job files failed` on the server. Silent/tone-only audio fails this way; re-record with audible speech. |
| Batch finishes with "No speech detected" | Processed fully but no utterances found — verify the file contains audible speech. |
| "Too many active recording sessions" | Realtime per-IP cap (`MAX_SESSIONS_PER_IP`, default 2). Stop another tab or wait a few seconds. |
| No transcript while speaking live | VAD emits per finished utterance: speak ≥ ~0.5 s then pause. Raise mic input level. |
| Live session stops but no diarized transcript appears | The session captured no speech (`0` segments ⇒ diarization is skipped) or the recording exceeded 10 MB. The raw live transcript is still shown. |
| Last sentence missing (realtime) | The trailing-silence + `commit` finalize handles it; a network drop can still beat the timeout — retry. |
| Port already in use | Set `PORT=xxxx` in `.env` and mirror it in `API_TARGET` for the dev proxy. |

Server logs include session ids, frame counts, upstream close codes, rate-limit retries and Gnani error bodies — enough to debug without exposing audio content or credentials.

---

## Security & privacy

- **Key isolation:** `GNANI_API_KEY` is read from `.env` and attached **only** by the Node server. It never appears in the frontend bundle, browser dev-tools, or logs.
- **Realtime:** raw 16 kHz PCM is relayed in memory only — nothing written to disk, nothing stored.
- **Live recording:** the captured PCM lives in browser memory, is encoded to MP3 on Stop, and is discarded when the session is reset or the tab closes.
- **Batch:** the uploaded file (including the auto-uploaded live session) lives in the server process memory (multer memory storage) only long enough to forward it to Gnani; transcripts are fetched, shaped, and discarded — never written to disk.
- **Auth to Gnani / to browser:** the browser only ever talks to *your* server; jobs are keyed only by knowledge of that API surface.
- **Transcript lifetime:** transcripts live in the tab's memory; clear or close the tab and they're gone.
- **Exposure:** intended for local/private deployment. If you expose it publicly: terminate TLS, add your own auth + rate limiting in front, and keep the Gnani key server-side.

---

## Scope & current limitations

- **Realtime diarization doesn't exist at Gnani** — diarization is a Gnani Batch Jobs API feature only. Live recording still streams the plain realtime transcript, and on **Stop** the captured session is sent through the batch path automatically so you get the diarized text too.
- Live-session diarization is skipped when the session captured no speech.
- A live session longer than ~40 minutes at 32 kbps can exceed the 10 MB batch cap; the live transcript is unaffected, but speaker separation will fail for that session.
- Batch direct upload is capped at **10 MB**; files needing more require Gnani's presigned-upload flow (not implemented).
- The legacy local-decode WebSocket batch path still exists (code + tests) but is not wired into the UI; the active batch path is the REST jobs flow above.
- No translation, no user accounts/auth, no persisted history.
- Language detection is automatic (`indic-auto`); realtime shows it per utterance, batch per segment (`language_detected`).
- Poll-based progress is coarse (job-level counters, not audio-level seek bars).

---

## Credits & references

- Powered by **Gnani Prisma v3.0** — Speech-to-Text for Indian languages.
- Batch API reference: <https://docs.gnani.ai/api/STTBatch/Introduction.md>
- Realtime WS reference: <https://docs.gnani.ai/api/STT/stt-websocket.md>
- Diarization use case: <https://docs.gnani.ai/api/use-cases/podcast-transcription.md>
- Gnani API dashboard: <https://app.gnani.ai/voice>
