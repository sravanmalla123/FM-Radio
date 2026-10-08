/* Listener: receives live audio chunks over WebSocket and plays them through MediaSource. */
(async function () {
  const $ = id => document.getElementById(id);
  const roomId = new URLSearchParams(location.search).get('room');
  const candidateMimes = [
    'audio/webm; codecs="opus"',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg; codecs="opus"',
    'audio/mp4; codecs="mp4a.40.2"'
  ];
  const MIME = candidateMimes.find(m => window.MediaSource && MediaSource.isTypeSupported(m)) || 'audio/webm; codecs="opus"';
  const audio = $('audio');
  let ws, ms, sb, queue = [], tuned = false, live = false, over = false;
  let ctx, analyser, data, timerBase = 0;

  let info;
  try {
    const r = await fetch('/api/rooms/' + roomId);
    if (!r.ok) throw 0;
    info = await r.json();
  } catch (_) {
    $('title').textContent = 'This show isn’t live';
    $('badgeText').textContent = 'Not found';
    $('deck').hidden = true; $('ended').hidden = false;
    $('endedTitle').textContent = 'We can’t find that live show';
    $('endedText').textContent = 'It may have finished already. If it was a live show, its recording is in the episode list.';
    return;
  }
  $('cover').innerHTML = coverSVG(roomId);
  $('title').textContent = info.title;
  $('desc').textContent = info.description || '';
  document.title = info.title + ' (live) | Wavelength';

  /* ---------- socket ---------- */
  function connect() {
    try {
      ws = new WebSocket(wsUrl(`/ws?room=${roomId}&role=listener`));
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        if (tuned && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'tune' })); } catch (_) {}
        }
      };
      ws.onmessage = e => {
        if (typeof e.data !== 'string') {
          queue.push(e.data);
          pump();
          return;
        }
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'stats') stats(m);
          else if (m.type === 'react') floatReaction(m.emoji, $('stage'));
          else if (m.type === 'ended') finish(m.episode);
          else if (m.type === 'error') finish(null);
        } catch (_) {}
      };
      ws.onclose = () => { if (!over) setTimeout(connect, 2000); };
    } catch (_) {
      if (!over) setTimeout(connect, 2500);
    }
  }
  connect();

  function stats(s) {
    live = s.live;
    $('count').textContent = s.listeners;
    $('badge').classList.toggle('live', s.live);
    $('badgeText').textContent = s.live ? 'Live now' : 'Starting soon';
    $('people').textContent = s.guestName ? `${s.hostName} talks with ${s.guestName}` : `Hosted by ${s.hostName}`;
    if (s.live) timerBase = Date.now() - s.elapsed; else timerBase = 0;
    if (!s.live && !tuned) $('tune').textContent = 'Tune in';
  }
  setInterval(() => { $('time').textContent = timerBase ? fmt((Date.now() - timerBase) / 1000) : '0:00'; }, 500);

  function finish(episode) {
    over = true; live = false;
    $('badge').classList.remove('live'); $('badgeText').textContent = 'Ended';
    $('ended').hidden = false;
    $('endedText').textContent = episode ? 'The recording is saved. Play it any time from the episode list.' : 'Thanks for listening.';
    try { audio.pause(); } catch (_) {}
    $('tune').disabled = true;
  }

  /* ---------- playback ---------- */
  function pump() {
    if (!sb || sb.updating || !queue.length || ms.readyState !== 'open') return;
    const chunk = queue[0];
    try {
      sb.appendBuffer(chunk);
      queue.shift();
    } catch (err) {
      if (err.name === 'QuotaExceededError') {
        trim(true);
      } else {
        console.warn('appendBuffer failed:', err.message);
        queue.shift();
      }
    }
  }
  function trim(force) {
    if (!sb || sb.updating || !audio.buffered.length) return;
    const keepFrom = audio.currentTime - (force ? 5 : 20);
    if (keepFrom > audio.buffered.start(0)) {
      try { sb.remove(audio.buffered.start(0), keepFrom); } catch (_) {}
    }
  }
  setInterval(() => {
    if (!sb || !audio.buffered.length) return;
    trim();
    const end = audio.buffered.end(audio.buffered.length - 1);
    if (!audio.paused && end - audio.currentTime > 4) audio.currentTime = end - 1; // stay close to live
  }, 1500);

  $('tune').onclick = async () => {
    if (!(window.MediaSource && MediaSource.isTypeSupported(MIME))) {
      toast('This browser can’t play live streams. Try Chrome, Edge or Firefox, or listen to the episode afterwards.', 6000);
      return;
    }
    $('tune').disabled = true;
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = ctx.createMediaElementSource(audio);
        analyser = ctx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.8;
        src.connect(analyser); analyser.connect(ctx.destination);
        data = new Uint8Array(analyser.frequencyBinCount);
      } catch (e) {
        console.warn('AudioContext creation error:', e);
      }
    }
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (_) {}
    }
    ms = new MediaSource();
    audio.src = URL.createObjectURL(ms);
    ms.addEventListener('sourceopen', () => {
      try {
        sb = ms.addSourceBuffer(MIME);
        sb.mode = 'sequence';
        sb.addEventListener('updateend', pump);
        tuned = true;
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'tune' })); } catch (_) {}
        }
        pump();
      } catch (err) {
        console.warn('MediaSource addSourceBuffer error:', err);
      }
    }, { once: true });
    audio.volume = $('vol').value / 100;
    audio.play().catch(err => {
      console.warn('Audio play notice:', err.message);
      $('tune').disabled = false;
      $('tune').textContent = 'Click to hear audio';
    });
    $('tune').textContent = live ? 'You’re listening' : 'Waiting for the host…';
    audio.onplaying = () => { $('tune').textContent = 'You’re listening'; $('tune').disabled = true; };
  };
  $('vol').oninput = e => { audio.volume = e.target.value / 100; };

  document.querySelectorAll('#reactions button').forEach(b => b.onclick = () => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'react', emoji: b.dataset.e }));
  });

  /* ---------- visualiser ---------- */
  const cv = $('viz'), g = cv.getContext('2d');
  let t = 0;
  (function draw() {
    const w = cv.width, h = cv.height, bars = 48, bw = w / bars;
    g.clearRect(0, 0, w, h);
    t += .04;
    if (analyser) analyser.getByteFrequencyData(data);
    for (let i = 0; i < bars; i++) {
      let v = analyser && !audio.paused ? data[Math.floor(i * .9) + 1] / 255 : 0;
      v = Math.max(v, .04 + .03 * Math.sin(t + i * .5)); // gentle idle wobble
      const bh = v * h * .9;
      g.fillStyle = i % 5 === 0 ? '#ff4f93' : i % 3 === 0 ? '#7d87ff' : '#ffc83d';
      g.beginPath(); g.roundRect(i * bw + 3, (h - bh) / 2, bw - 6, bh, 6); g.fill();
    }
    requestAnimationFrame(draw);
  })();
})();
