# 📻 Wavelength: Live Podcast Studio

Host a live podcast with a remote guest. Listeners tune in live with real-time audio and reactions, and every finished show is automatically saved as an episode.

---

## ⚡ Quick Start (Local)

```bash
npm install
npm start
```

Open **http://localhost:3000** in your browser.

---

## 🚀 Deployment Guide (Production)

Modern browsers strictly require **HTTPS** (or `localhost`) to access microphones (`getUserMedia`). Deploy with HTTPS so guests and hosts can connect from anywhere.

### Option 1: Render (Recommended)
1. Push this repository to GitHub.
2. In Render Dashboard, click **New +** → **Blueprint** or **Web Service**.
3. Point to your repository (Render will detect `render.yaml` automatically).
4. Set persistent disk:
   - Mount Path: `/var/data`
   - Env Vars: `DATA_DIR=/var/data`, `REC_DIR=/var/data/recordings`
5. Render provides free HTTPS certificates out of the box!

### Option 2: Railway
1. Click **New Project** → **Deploy from GitHub repo**.
2. Railway detects `package.json` and `Procfile`.
3. Add a volume mounted to `/app/recordings` and `/app/data` to preserve recorded episodes.

### Option 3: Docker & Docker Compose
```bash
docker compose up -d --build
```
The container runs on port `3000` with persistent volumes mounted for `./data` and `./recordings`.

### Option 4: Linux VPS (Ubuntu / Debian / Nginx / Caddy)
1. Install Node.js 18+ and clone the repo.
2. Run with PM2:
   ```bash
   npm install -g pm2
   pm2 start server.js --name wavelength
   pm2 save
   pm2 startup
   ```
3. Set up Caddy (automatic HTTPS) or Nginx with Let's Encrypt reverse proxying to `http://127.0.0.1:3000`. Ensure WebSocket upgrades (`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`) are enabled.

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port for HTTP & WebSocket server |
| `HOST` | `0.0.0.0` | Network interface to bind to |
| `DATA_DIR` | `./data` | Directory for JSON database |
| `REC_DIR` | `./recordings` | Directory for audio recording files |
| `TURN_URL` | - | Optional TURN server URL for strict corporate/mobile firewalls |
| `TURN_USER`| - | Username for TURN server |
| `TURN_PASS`| - | Password for TURN server |

---

## 🎙️ How to Use

1. **Host:** Click **"Start a podcast"**, enter your title and name, and enter your studio.
2. **Guest:** Copy the **Guest Link** from the studio panel and send it to your guest. They open the link, test their mic, and join.
3. **Listeners:** Copy the **Listener Link** or have them visit the home page to tune in.
4. **Go Live:** Click **"Go live"** when ready. The host mixer records both voices in sync and streams chunks to all listeners.
5. **Wrap Up:** Click **"End show"**. The audio file is automatically saved and appears in the Episodes list.
6. **Uploads:** You can also upload existing audio files directly from the home page.

---

## 🛡️ Production Hardening Features Included

- **0.0.0.0 Host Binding:** Compatible with Docker, Kubernetes, Fly.io, Railway, and Render.
- **`/health` Endpoint:** Automatic cloud health monitoring and uptime checks.
- **WebSocket Crash Prevention:** Protected upgrade handlers, client error traps, and safe sender wrappers so bad network disconnects never bring down the server.
- **WebRTC Candidate Queueing:** Resilient SDP offer/answer exchange that never hangs even on out-of-order ICE arrival.
- **Graceful Shutdown:** `SIGTERM` and `SIGINT` signals cleanly flush recording streams to disk before exiting.
- **Automatic Fallback Clipboard:** Works across secure HTTPS and legacy clipboard environments.
