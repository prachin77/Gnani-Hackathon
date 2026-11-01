# Voice-to-Text

Real-time, multilingual speech-to-text in the browser, powered by **Gnani Prisma v3.0**.

Speak into your microphone and watch completed utterances appear as they are transcribed — with automatic language detection for Hindi, English, Gujarati, Tamil, Telugu, Kannada, Malayalam, Marathi, Bengali and Punjabi.

---

## What's included

- **Working microphone → Gnani → live transcript pipeline** (no simulated text)
- **Secure WebSocket proxy** — the API key stays on the server
- AudioWorklet capture: mono, resampled to **16 kHz**, **signed 16-bit LE PCM**, **1,024-byte frames** sent every **32 ms**
- Graceful stop: trailing silence → `commit` → wait for the final transcript → close
- Automatic language detection (`language_code=indic-auto`), language badge per segment
- Live waveform, recording timer, speech/processing indicators, connection status
- **Batch upload**: decode a file locally, stream it through the same Gnani session with flow control, show progress/status, and keep every transcript segment
- Transcript copy (with fallback for older browsers) and confirm-to-clear
- Responsive, minimal SaaS-style UI (React + TypeScript + Tailwind + Lucide)

---

## Quick start

**Requirements:** Node.js **20.19+** (or 22.12+), a microphone, and a Gnani API key.

1. Put your key in `.env` at the project root:

   ```env
   GNANI_API_KEY=your-gnani-api-key
   ```

   (An `.env` file is already present in this project. Keep it out of version control.)

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the development servers:

   ```bash
   npm run dev
   ```

4. Open **http://localhost:5173**

   The Vite dev server proxies `/api` and `/ws` to the backend on port `8787`.

### Production-style run

```bash
npm run build
npm start
```

Open **http://localhost:8787**. Express serves the built frontend and hosts the WebSocket proxy on the same origin.

> Do **not** open the HTML file directly (`file://`). `getUserMedia` requires a secure context: `localhost` or HTTPS.

---

## How it works

```
Browser                      Your Node server                 Gnani
───────                      ────────────────                 ─────
getUserMedia
  → AudioContext
  → AudioWorklet  ──PCM──►  /ws/stt/realtime  ──attaches x-api-key-id──►  wss://api.vachana.ai
    (mono, 16 kHz,                                          ◄──  connected / speech_start
     512 samples,                                                 processing / transcript
     1,024 bytes, 32 ms)   ◄──JSON events / commit──              (Prisma v3.0)
```

### Audio pipeline details

| Stage | Implementation |
| --- | --- |
| Capture | `navigator.mediaDevices.getUserMedia` with mono / echo cancellation / noise suppression |
| Processing | `AudioWorklet` (`public/pcm-processor.js`); falls back to `ScriptProcessorNode` if needed |
| Downmix | Stereo sources are averaged to mono |
| Resample | Stateful linear resampler from the device rate (often 48 kHz) to 16 kHz |
| Encoding | Signed 16-bit little-endian PCM |
| Framing | Exactly 512 samples = **1,024 bytes** |
| Pacing | Frames are emitted on the audio clock by the worklet — roughly one every 32 ms |

### Stop sequence

1. Microphone capture stops and audio resources are released.
2. ~512 ms of trailing silence is sent (paced at 32 ms per frame).
3. `{"type":"commit"}` is sent to finalize the open utterance.
4. The client waits for the final `transcript` (with a bounded timeout) before closing.
5. The browser socket closes; the proxy closes the Gnani socket.

This avoids losing the last sentence and prevents closing before the committed transcript arrives.

### Batch processing (uploaded files)

1. The selected file is read **in the browser** and decoded with the Web Audio API. The file itself is never posted to the server.
2. Channels are downmixed and resampled to the same realtime format: **mono, 16 kHz, signed 16-bit LE PCM, 512-sample (1,024-byte) frames**.
3. Frames stream through the dedicated `/ws/stt/batch` proxy. The server acknowledges frames and forwards only while the upstream socket has room, so uploaded audio is **never dropped** under backpressure.
4. Audio is sent **4× faster than real time**, in 12-minute chunks. Each chunk uses a fresh Gnani session (safely below the 15-minute realtime cap) and is finalized with trailing silence + `commit`.
5. The panel shows the current stage, percent complete, processed audio time, elapsed time, and the number of finished segments. Cancel stops immediately and keeps any completed segments.
6. Realtime recording and batch upload use separate state, so neither can interrupt or clear the other.

Batch limits: **100 MB** per file, **30 minutes** of audio, and any format the browser can decode (WAV, MP3, M4A, AAC, OGG, FLAC or WebM).

### Connection headers sent by the server

```
x-api-key-id:      GNANI_API_KEY   (from .env, never sent to the browser)
model:             prisma-v3.0
language_code:     indic-auto
x-sample-rate:     16000
format:            transcribe
x-min-silence-ms:  500
x-vad-threshold:   0.6
x-idle-timeout-sec: 300
x-max-speech-s:    30
```

In addition to the required headers, the idle timeout keeps quiet sessions alive past Gnani's 60-second default, and the 30-second speech cap keeps transcripts flowing during long monologues.

---

## Project structure

```
.
├── server/
│   ├── server.ts           # Express + HTTP server, static frontend, /api/health
│   ├── gnaniWebSocket.ts   # Secure WebSocket proxy, frame validation, relay
│   ├── config.ts           # Env loading and constants
│   └── logger.ts
├── src/
│   ├── components/
│   │   ├── Header.tsx
│   │   ├── StartActions.tsx
│   │   ├── RecordingPanel.tsx
│   │   ├── BatchPanel.tsx           # Batch progress, status, cancel/retry
│   │   ├── AudioVisualizer.tsx
│   │   ├── LiveTranscription.tsx
│   │   ├── StatusBadge.tsx
│   │   └── ErrorBanner.tsx
│   ├── hooks/
│   │   ├── useAudioStreaming.ts     # Realtime state machine, audio graph, socket, finalize
│   │   └── useBatchProcessing.ts    # Batch decode → stream → progress → results
│   ├── lib/
│   │   ├── pcm.ts                   # Resampler, frame emitter, WS URL
│   │   ├── batch.ts                 # File validation, decode, downmix, resample
│   │   ├── languages.ts
│   │   ├── format.ts
│   │   └── errors.ts                # User-friendly error mapping
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── public/
│   ├── pcm-processor.js    # AudioWorklet (16 kHz PCM framing)
│   └── favicon.svg
├── scripts/build.mjs        # Cross-platform typecheck + build
├── .env                    # GNANI_API_KEY (git-ignored)
└── .env.example
```

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | API (`tsx watch`, port 8787) + Vite frontend (port 5173) |
| `npm run build` | Typecheck frontend & server, then build to `dist/` |
| `npm start` | Serve `dist/` and the proxy on port 8787 |
| `npm run typecheck` | Typecheck both TypeScript projects |
| `npm run test:batch` | Offline tests for file conversion and the batch proxy relay |
| `npm run preview` | Preview the Vite build |

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `GNANI_API_KEY` | — | **Required.** Gnani API key, server-side only |
| `PORT` | `8787` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `MAX_SESSIONS_PER_IP` | `2` | Concurrent Gnani streams per client IP |
| `GNANI_STT_URL` | `wss://api.vachana.ai/stt/v3/stream` | Override the upstream endpoint |

For local frontend development, `API_TARGET` (default `http://localhost:8787`) can point Vite's proxy at another backend.

---

## API endpoints

- `GET /api/health` → `{ status, model, language, sampleRate, configured }`
- `WS /ws/stt/realtime` → realtime browser audio stream (binary 1,024-byte PCM frames) + JSON control frames
- `WS /ws/stt/batch` → uploaded-file stream with the same frames plus `batch_ack` flow-control frames

The proxy accepts only:

- binary frames of exactly **1,024 bytes**
- `{"type":"commit"}` control text frames

Everything else is rejected or dropped and logged server-side. Batch sessions additionally receive `{"type":"batch_ack","frames":N}` so the browser can keep a bounded in-flight window.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Microphone access was blocked" | Allow microphone access in the site settings, then reload. Look for the mic icon in the address bar. |
| Mic prompt never appears | Use `http://localhost` or HTTPS. Browsers block `getUserMedia` on plain HTTP (except localhost). |
| "No microphone was found" | Connect/enable an input device and check the OS input settings. |
| `401` / "API credentials rejected" | `GNANI_API_KEY` is missing or invalid. Check `.env` and restart the server. |
| "Too many active recording sessions" | A previous session is still open (or the per-IP cap was reached). Wait a few seconds / stop the other tab. |
| No transcript while speaking | Speak for at least ~0.5 s, then pause. VAD emits a transcript when an utterance ends. Raise your mic input level if needed. |
| Last sentence missing | It is finalized by trailing silence + `commit`; if the network dropped, the final wait times out. Try again. |
| Session ends after 15 minutes | Gnani caps realtime sessions at 15 minutes. Start a new recording. Batch files are split into 12-minute sessions automatically. |
| Batch upload says the file isn't audio | Use WAV, MP3, M4A, AAC, OGG, FLAC or WebM. Some browsers cannot decode certain codecs. |
| Batch decode fails | Re-encode the file to WAV/MP3 or try a different browser; the file is decoded locally by the browser. |
| Batch file rejected as too long | Batch files are limited to 30 minutes (100 MB). Trim the recording and try again. |
| Batch finishes with "No speech detected" | The file was processed but VAD found no utterances. Check that it contains audible speech at a reasonable level. |
| Port already in use | Set `PORT=xxxx` in `.env` and update `API_TARGET` if you also changed the dev proxy target. |

Server logs include session ids, frame counts, and upstream close codes — useful for debugging without exposing audio content or credentials.

---

## Security & privacy notes

- The Gnani API key is read from `.env` and attached **only** by the Node proxy. It is never included in the frontend bundle or sent to the browser.
- Uploaded files are decoded in the browser; only raw 16 kHz PCM frames are streamed to the proxy and Gnani. Files are not uploaded to or stored by this server.
- Raw audio is relayed in memory to Gnani and is not written to disk.
- Transcripts live in the browser tab's memory; clearing the transcript or closing the tab removes them.
- The proxy is intended for local/private deployment. If you expose it publicly, put it behind HTTPS and add your own auth/rate limiting.

---

## Scope / limitations

- Batch uploads are limited to 30 minutes / 100 MB and must be decodable by the browser.
- No translation, speaker diarization, or user accounts.
- Language detection is automatic (`indic-auto`); per-segment detection is shown from `detected_language_code`.
- Realtime sessions are limited to 15 minutes by Gnani; reconnect for longer use. Batch files are chunked into 12-minute sessions, so long uploads complete without hitting the cap.
