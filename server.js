'use strict';
/*
 * Wavelength server
 *  - REST: create shows, list live shows, list episodes, upload episodes, health check
 *  - WebSocket /ws: WebRTC signaling (host <-> guest), live audio relay (host -> listeners)
 *  - Recording: every live chunk is written to disk; when the show ends it becomes an episode
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const REC_DIR = process.env.REC_DIR || path.join(ROOT, 'recordings');
const MAX_UPLOAD = 300 * 1024 * 1024;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
try { fs.mkdirSync(REC_DIR, { recursive: true }); } catch (_) {}

/* ---------- tiny JSON "database" ---------- */
const DB_FILE = path.join(DATA_DIR, 'episodes.json');
let episodes = [];
try {
  if (fs.existsSync(DB_FILE)) {
    episodes = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
} catch (err) {
  console.warn('Could not read existing episodes database, initializing empty list:', err.message);
  episodes = [];
}

const saveEpisodes = () => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(episodes, null, 2));
  } catch (err) {
    console.error('Failed to write episodes database:', err.message);
  }
};

const uid = (n = 4) => crypto.randomBytes(n).toString('hex');
const clean = (s, max) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);

/* ---------- HTTP ---------- */
const app = express();
app.set('trust proxy', 1);

// Security & performance headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '50kb' }));
app.use('/recordings', express.static(REC_DIR, { maxAge: '1h' }));

// Support both root/public and wavelength/public seamlessly
const publicDir = fs.existsSync(path.join(ROOT, 'public'))
  ? path.join(ROOT, 'public')
  : path.join(ROOT, 'wavelength', 'public');
app.use(express.static(publicDir));

// Deployment Health Check (vital for Render, Railway, Fly.io, AWS, K8s, Docker)
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    liveRooms: [...rooms.values()].filter(r => r.live && !r.ended).length,
    totalEpisodes: episodes.length
  });
});

app.get('/api/config', (_req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  // Optional TURN relay for guests behind strict firewalls (set these env vars in production)
  if (process.env.TURN_URL) {
    const urls = process.env.TURN_URL.split(',').map(u => u.trim()).filter(Boolean);
    iceServers.push({
      urls,
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || ''
    });
  }
  res.json({ iceServers });
});

app.post('/api/rooms', (req, res) => {
  const title = clean(req.body.title, 90);
  const hostName = clean(req.body.hostName, 40);
  if (!title || !hostName) return res.status(400).json({ error: 'Add a show title and your name.' });
  const room = {
    id: uid(4), hostToken: uid(16), title, hostName,
    description: clean(req.body.description, 240),
    host: null, guest: null, guestName: '', guestCid: '', lastGuest: '',
    listeners: new Set(), live: false, ended: false, startedAt: 0,
    init: null, file: null, fileName: '', peak: 0, lastActive: Date.now()
  };
  rooms.set(room.id, room);
  res.json({ id: room.id, token: room.hostToken });
});

app.get('/api/live', (_req, res) => {
  res.json([...rooms.values()].filter(r => r.live && !r.ended).map(info));
});

app.get('/api/rooms/:id', (req, res) => {
  const r = rooms.get(req.params.id);
  if (!r || r.ended) return res.status(404).json({ error: 'not found' });
  res.json(info(r));
});

app.get('/api/episodes', (_req, res) => res.json(episodes));

// Upload an existing audio file as an episode (raw body, metadata in query string)
app.post('/api/upload', (req, res) => {
  const ext = String(req.query.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!['webm', 'mp3', 'wav', 'm4a', 'ogg', 'mp4', 'aac', 'opus'].includes(ext))
    return res.status(400).json({ error: 'Use an mp3, wav, m4a, ogg, aac or webm file.' });
  const title = clean(req.query.title, 120);
  if (!title) return res.status(400).json({ error: 'Add a title.' });
  const id = uid(6), fileName = `${id}.${ext}`, filePath = path.join(REC_DIR, fileName);
  const out = fs.createWriteStream(filePath);
  let size = 0, failed = false;
  const fail = (code, msg) => {
    if (failed) return; failed = true;
    try { req.unpipe(out); } catch (_) {}
    try { out.destroy(); } catch (_) {}
    fs.unlink(filePath, () => {});
    if (!res.headersSent) res.status(code).json({ error: msg });
  };
  req.on('data', c => { size += c.length; if (size > MAX_UPLOAD) fail(413, 'That file is over the 300 MB limit.'); });
  req.on('aborted', () => fail(400, 'Upload cancelled.'));
  req.pipe(out);
  out.on('error', (err) => fail(500, 'We could not save that file: ' + err.message));
  out.on('finish', () => {
    if (failed) return;
    const ep = {
      id, title, description: clean(req.query.description, 240),
      host: clean(req.query.host, 40) || 'Unknown host', guest: clean(req.query.guest, 40),
      date: new Date().toISOString(), duration: Math.round(Number(req.query.duration) || 0),
      file: fileName, source: 'upload', peak: 0
    };
    episodes.unshift(ep); saveEpisodes(); res.json(ep);
  });
});

/* ---------- rooms ---------- */
const rooms = new Map();
const info = r => ({
  id: r.id, title: r.title, description: r.description, hostName: r.hostName,
  guestName: r.guest ? r.guestName : null,
  hostPresent: !!r.host, guestPresent: !!r.guest,
  live: r.live, elapsed: r.live ? Date.now() - r.startedAt : 0,
  listeners: r.listeners.size
});
const everyone = r => [r.host, r.guest, ...r.listeners].filter(Boolean);
const send = (ws, obj) => {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
};
const broadcast = (r, obj) => {
  const m = JSON.stringify(obj);
  for (const ws of everyone(r)) {
    if (ws && ws.readyState === 1) {
      try { ws.send(m); } catch (_) {}
    }
  }
};
const pushStats = r => {
  r.peak = Math.max(r.peak, r.listeners.size);
  broadcast(r, { type: 'stats', ...info(r) });
};

function goLive(r) {
  if (r.live || r.ended) return;
  r.live = true; r.startedAt = Date.now(); r.init = null;
  r.fileName = `${uid(6)}.webm`;
  const filePath = path.join(REC_DIR, r.fileName);
  r.file = fs.createWriteStream(filePath);
  r.file.on('error', err => console.error(`Recording stream error in room ${r.id}:`, err.message));
  pushStats(r);
}

function endShow(r) {
  if (r.ended) return;
  r.ended = true;
  const wasLive = r.live;
  r.live = false;
  const finish = episode => {
    broadcast(r, { type: 'ended', episode });
    setTimeout(() => {
      everyone(r).forEach(ws => {
        try { ws.close(); } catch (_) {}
      });
      rooms.delete(r.id);
    }, 1500);
  };
  if (wasLive && r.file) {
    const duration = Math.round((Date.now() - r.startedAt) / 1000);
    const filePath = path.join(REC_DIR, r.fileName);
    try {
      r.file.end(() => {
        if (duration < 3) {
          fs.unlink(filePath, () => {});
          return finish(null);
        }
        const ep = {
          id: r.fileName.replace('.webm', ''), title: r.title, description: r.description,
          host: r.hostName, guest: r.lastGuest, date: new Date().toISOString(),
          duration, file: r.fileName, source: 'live', peak: r.peak
        };
        episodes.unshift(ep); saveEpisodes(); finish(ep);
      });
    } catch (_) {
      finish(null);
    }
  } else {
    finish(null);
  }
}

// Drop abandoned rooms
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (!r.live && everyone(r).length === 0 && now - r.lastActive > 30 * 60 * 1000) {
      rooms.delete(id);
    }
  }
}, 5 * 60 * 1000);

/* ---------- WebSocket ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {
    try { socket.destroy(); } catch (_) {}
  });

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    return socket.destroy();
  }

  if (url.pathname !== '/ws') return socket.destroy();
  try {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, url));
  } catch (err) {
    console.warn('WebSocket upgrade error:', err.message);
    try { socket.destroy(); } catch (_) {}
  }
});

const REACTIONS = ['❤️', '👏', '😂', '🔥', '🎉'];

wss.on('connection', (ws, _req, url) => {
  ws.on('error', err => console.warn('WebSocket client error:', err.message));

  const q = url.searchParams;
  const room = rooms.get(q.get('room'));
  const role = ['host', 'guest', 'listener'].includes(q.get('role')) ? q.get('role') : 'listener';
  const fail = (code, message) => {
    send(ws, { type: 'error', code, message });
    try { ws.close(); } catch (_) {}
  };
  if (!room || room.ended) return fail('no-room', 'This show has ended or the link is wrong.');

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  room.lastActive = Date.now();

  if (role === 'host') {
    if (q.get('token') !== room.hostToken) return fail('bad-token', 'Open the studio from the device where you created this show.');
    if (room.host && room.host !== ws) {
      room.host.replaced = true;
      try { room.host.close(); } catch (_) {}
    }
    room.host = ws;
    if (room.guest) send(ws, { type: 'guest-joined' });
  } else if (role === 'guest') {
    const cid = clean(q.get('cid'), 40);
    if (room.guest && room.guestCid !== cid) return fail('guest-taken', 'Someone else is already in the guest seat.');
    if (room.guest) {
      room.guest.replaced = true;
      try { room.guest.close(); } catch (_) {}
    }
    room.guest = ws; room.guestCid = cid;
    room.guestName = clean(q.get('name'), 40) || 'Guest';
    room.lastGuest = room.guestName;
    send(room.host, { type: 'guest-joined' });
  } else {
    room.listeners.add(ws);
  }
  send(ws, { type: 'hello', role });
  pushStats(room);

  ws.on('message', (data, isBinary) => {
    if (isBinary) { // live audio chunk from the host's mixer
      if (role !== 'host' || !room.live) return;
      if (!room.init) room.init = data;
      if (room.file && !room.file.destroyed) {
        try { room.file.write(data); } catch (_) {}
      }
      for (const l of room.listeners) {
        if (l.tuned && l.readyState === 1 && l.bufferedAmount < 4e6) {
          try { l.send(data, { binary: true }); } catch (_) {}
        }
      }
      return;
    }
    let msg; try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    switch (msg.type) {
      case 'signal':
        if (role === 'host') send(room.guest, { type: 'signal', data: msg.data });
        if (role === 'guest') send(room.host, { type: 'signal', data: msg.data });
        break;
      case 'peer-state':
        if (role === 'host') send(room.guest, { type: 'peer-state', muted: !!msg.muted });
        if (role === 'guest') send(room.host, { type: 'peer-state', muted: !!msg.muted });
        break;
      case 'go-live': if (role === 'host') goLive(room); break;
      case 'end': if (role === 'host') endShow(room); break;
      case 'tune':
        if (role === 'listener') {
          ws.tuned = true;
          if (room.live && room.init && ws.readyState === 1) {
            try { ws.send(room.init, { binary: true }); } catch (_) {}
          }
        }
        break;
      case 'react': {
        const now = Date.now();
        if (now - (ws.lastReact || 0) < 250 || !REACTIONS.includes(msg.emoji)) break;
        ws.lastReact = now;
        broadcast(room, { type: 'react', emoji: msg.emoji });
        break;
      }
    }
  });

  ws.on('close', () => {
    room.lastActive = Date.now();
    if (ws.replaced) return;
    if (role === 'host' && room.host === ws) {
      room.host = null;
      if (room.live) return endShow(room); // host dropped mid-show: save what we have
    } else if (role === 'guest' && room.guest === ws) {
      room.guest = null;
      send(room.host, { type: 'guest-left' });
    } else {
      room.listeners.delete(ws);
    }
    if (!room.ended) pushStats(room);
  });
});

// Periodic heartbeat to drop stale/dead connections
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      try { ws.terminate(); } catch (_) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 20000);

// Graceful shutdown handling for container/cloud platforms
function handleShutdown(signal) {
  console.log(`\nReceived ${signal}. Gracefully stopping Wavelength...`);
  clearInterval(pingInterval);
  for (const r of rooms.values()) {
    try { endShow(r); } catch (_) {}
  }
  server.close(() => {
    console.log('HTTP and WebSocket server stopped.');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 4000);
}
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

const os = require('os');
function getNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, HOST, () => {
  const netIp = getNetworkIp();
  console.log(`\n  ======================================================`);
  console.log(`  📻 Wavelength Live Podcast Studio`);
  console.log(`  > Local:   http://localhost:${PORT}`);
  console.log(`  > Network: http://${netIp}:${PORT}`);
  console.log(`  > Health:  http://localhost:${PORT}/health`);
  console.log(`  ======================================================\n`);
});
