# remote

Turn any device (an iPad, say) into a remote-controlled camera. Open the site on the camera device, set up a project, then scan the QR code from your phone to take photos, record video, or run a timelapse. Everything is captured at full resolution on the camera device and uploaded to R2: `project-files/remote/<project-name>/`.

Cloudflare Worker + Durable Object (one per session code, relays WebRTC signaling and commands) + R2 + static assets. No build step.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler deploy      # serves remote.bobsabayesian.io (custom domain in wrangler.jsonc)
```

Needs the `project-files` R2 bucket to exist and `bobsabayesian.io` to be a zone on your Cloudflare account. Local dev: `npm run dev` (simulated R2, http://localhost:8787; camera access needs HTTPS or localhost).

### Optional: TURN for live view on cellular / strict networks

The live preview is WebRTC. On the same Wi-Fi or most home networks it connects with STUN alone. If the phone is on cellular and the preview stays blank, add Cloudflare Calls TURN (controls and captures work either way):

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_API_TOKEN
```

## Retention & downloads

Each session's Durable Object runs a daily alarm that deletes files more than 7 days after upload (`RETENTION_DAYS` var overrides it). When a project's folder is empty and it's been idle 7 days, the project and its code are removed and the name is freed. No cron or R2 lifecycle rule needed.

The Files tab downloads single files, a whole timelapse as a zip, or the entire project as a zip (zipped in the browser, 4 GB limit).

## How it works

- **Session code**: 8 characters (`ABCD-EFGH`), the only credential. Anyone with it can view the camera and the files, so treat it like a password. Rejoin any time from the home page, using the code.
- **Folder**: `remote/<slug-of-project-name>/`, or `remote/<session-code>/` if no name was given. Names must be unique; the code lets you return to an existing project.
- **Photos**: `photo-<timestamp>.jpg`. **Video**: `video-<timestamp>.mp4` (`.webm` on Chromium), streamed to R2 as multipart in 8 MB parts while recording. **Timelapse**: `timelapse-<timestamp>/frame-000001.jpg`, ...
- Failed uploads retry with backoff, so a Wi-Fi drop doesn't lose frames (up to 300 queued in memory).
- A video only appears in R2 once recording stops and the upload completes; if the camera page is closed mid-recording the partial upload is discarded by R2.

### Timelapse frames to video

```bash
ffmpeg -framerate 30 -pattern_type glob -i 'frame-*.jpg' -c:v libx264 -pix_fmt yuv420p timelapse.mp4
```

## Camera device tips

Keep the page open and the screen on (the page requests a wake lock, which iOS 16.4+ honours). Plug it in. For long timelapses disable Auto-Lock or use Guided Access.
