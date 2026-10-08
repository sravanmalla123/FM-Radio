/* Studio: host + guest talk over WebRTC. The host's browser mixes both voices,
   records them, and streams the mix to the server for live listeners. */
(async function () {
  const $ = id => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const roomId = q.get('room');
  const role = q.get('role') === 'host' ? 'host' : 'guest';
  const queryToken = q.get('token');
  const token = role === 'host' ? (queryToken || localStorage.getItem('wl-host-' + roomId) || '') : '';
  if (token) {
    try { localStorage.setItem('wl-host-' + roomId, token); } catch (_) {}
  }
  let clientId = sessionStorage.getItem('wl-cid');
  if (!clientId) { clientId = Math.random().toString(36).slice(2); sessionStorage.setItem('wl-cid', clientId); }

  let info, myName = '', localStream, ctx, micSrc, micAn, comp, mixDest, remoteSrc, remoteAn;
  let ws, pc, pending = [], iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let recorder, chain = Promise.resolve(), isLive = false, finished = false, muted = false;
  let timerBase = 0, timerInt = null;
  const remoteAudio = $('remoteAudio');
  const me = role === 'host' ? 'host' : 'guest', other = role === 'host' ? 'guest' : 'host';

  const fatal = (title, text) => {
    $('lobby').hidden = true; $('wrap').hidden = false;
    $('wrapTitle').textContent = title; $('wrapText').textContent = text;
    $('wrapPrimary').hidden = true;
  };
  const banner = (text, isHtml = false) => {
    let b = $('banner');
    if (!text) return b && b.remove();
    if (!b) { b = document.createElement('div'); b.id = 'banner'; b.className = 'banner'; document.body.appendChild(b); }
    if (isHtml) b.innerHTML = text; else b.textContent = text;
  };

  /* ---------- load the show ---------- */
  try {
    const r = await fetch('/api/rooms/' + roomId);
    if (!r.ok) throw 0;
    info = await r.json();
  } catch (_) { return fatal('This show isn’t available', 'It may have ended. Ask the host for a fresh link.'); }
  if (role === 'host' && !token) return fatal('Open the studio on your own device', 'Host controls only work on the browser where the show was created.');
  try { const c = await (await fetch('/api/config')).json(); iceServers = c.iceServers; } catch (_) {}

  $('showTitle').textContent = info.title;
  document.title = info.title + ' | Wavelength';
  $('lobbyTitle').textContent = role === 'host' ? 'Ready to host?' : 'Join ' + info.hostName + ' on the show';
  $('lobbySub').textContent = role === 'host' ? info.title : 'You’ll be talking live as the guest of “' + info.title + '”.';
  if (role === 'host') { $('nameInput').value = info.hostName; $('nameInput').readOnly = true; }
  $('hostPanel').hidden = role !== 'host';
  $('guestPanel').hidden = role === 'host';
  $('shareBox').hidden = $('shareBox2').hidden = role !== 'host';
  $('guestLink').value = `${location.origin}/studio.html?room=${roomId}&role=guest`;
  $('listenLink').value = `${location.origin}/listen.html?room=${roomId}`;
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copyText($(b.dataset.copy).value));

  // Check if opened on raw network IP vs localhost
  const isLocalNetwork = location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
  if (isLocalNetwork) {
    const portPart = location.port ? `:${location.port}` : '';
    const localhostUrl = `http://localhost${portPart}/studio.html?room=${roomId}&role=${role}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const locBox = $('localhostOption');
    if (locBox) {
      locBox.hidden = false;
      const btn = $('openLocalhostBtn');
      if (btn) btn.href = localhostUrl;
    }
    banner(`On this computer? Switch to localhost to enable your mic instantly: <a href="${localhostUrl}" style="color:#12143a;text-decoration:underline;margin-left:6px;font-weight:800">👉 Switch to localhost</a>`, true);
  }

  function setupSilentStream() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    try { osc.start(); } catch (_) {}
    localStream = dest.stream;
    localStream.getAudioTracks().forEach(t => t.enabled = false);
    micSrc = ctx.createMediaStreamSource(localStream);
    micAn = ctx.createAnalyser();
    micAn.fftSize = 256;
    micAn.smoothingTimeConstant = 0.75;
    micSrc.connect(micAn);
    muted = true;
  }

  /* ---------- mic check ---------- */
  $('micBtn').onclick = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('micStatus').innerHTML = `Your browser blocks microphone access on HTTP IP addresses.<br><b>👉 Click the "Switch to localhost" button above</b>, or click "Enter without mic" below.`;
      $('enterBtn').disabled = false;
      return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      muted = false;
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        $('micStatus').textContent = 'Microphone permission was denied. Allow microphone in your browser settings or enter without mic.';
      } else {
        $('micStatus').textContent = 'Microphone unavailable: ' + (err.message || 'Check connection') + '. You can still enter without mic.';
      }
      $('enterBtn').disabled = false;
      return;
    }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') await ctx.resume();
      micSrc = ctx.createMediaStreamSource(localStream);
      micAn = ctx.createAnalyser();
      micAn.fftSize = 256;
      micAn.smoothingTimeConstant = 0.75;
      micSrc.connect(micAn);
      addMeter($('lobbyMeter'), micAn);
      startMeters();
      $('micStatus').textContent = 'Mic works! Speak to see the bars move, then click Enter studio.';
      $('micBtn').textContent = 'Mic ready';
      $('enterBtn').disabled = false;
    } catch (err) {
      $('micStatus').textContent = 'Audio setup notice: ' + err.message;
      $('enterBtn').disabled = false;
    }
  };

  async function enterStudio(skipMic = false) {
    myName = $('nameInput').value.trim();
    if (!myName) { $('nameInput').focus(); toast('Add your name first'); return; }
    if (!localStream) {
      setupSilentStream();
    }
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (_) {}
    }
    comp = ctx.createDynamicsCompressor();
    mixDest = ctx.createMediaStreamDestination();
    comp.connect(mixDest);
    if (role === 'host' && micSrc) micSrc.connect(comp);
    clearMeters();
    if (micAn) addMeter($(me + 'Meter'), micAn);
    $('lobby').hidden = true;
    $(me + 'Av').textContent = initials(myName);
    if (role === 'guest') {
      $('guestName').textContent = myName;
      $('seatGuest').classList.remove('empty');
    } else {
      $('hostName').textContent = myName;
    }
    if (muted || skipMic) {
      $('muteBtn').textContent = 'Connect / Unmute mic';
      $('muteBtn').classList.add('is-muted');
      $(me + 'Muted').hidden = false;
      setStatus(me, 'warn', 'Mic off');
    } else {
      setStatus(me, 'ok', 'Mic on');
    }
    connect();
  }

  $('enterBtn').onclick = () => enterStudio(false);
  if ($('enterNoMicBtn')) $('enterNoMicBtn').onclick = () => enterStudio(true);

  /* ---------- signaling ---------- */
  const send = o => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(o)); } catch (_) {}
    }
  };

  function connect() {
    const url = wsUrl(`/ws?room=${roomId}&role=${role}&token=${encodeURIComponent(token)}&name=${encodeURIComponent(myName)}&cid=${clientId}`);
    try {
      ws = new WebSocket(url);
    } catch (err) {
      banner('Failed to connect to signaling server. Retrying...');
      setTimeout(connect, 2000);
      return;
    }
    ws.onopen = () => banner(null);
    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        try { handle(JSON.parse(e.data)); } catch (_) {}
      }
    };
    ws.onclose = () => {
      if (finished) return;
      if (role === 'host' && isLive) {
        finished = true; stopRecorder();
        return showWrap('Connection lost', 'Your connection dropped, so the show ended. Everything recorded so far was saved to Episodes.', true);
      }
      banner('Connection lost. Reconnecting…');
      closePC();
      setTimeout(connect, 2000);
    };
  }

  function handle(m) {
    switch (m.type) {
      case 'stats': return renderStats(m);
      case 'guest-joined': if (role === 'host') startCall(); return;
      case 'guest-left': closePC(); setStatus('guest', 'warn', 'Left the studio'); return;
      case 'signal': return onSignal(m.data);
      case 'peer-state': $(other + 'Muted').hidden = !m.muted; return;
      case 'react': return floatReaction(m.emoji, $('stage'));
      case 'ended': finished = true; stopRecorder(true);
        return showWrap(role === 'host' ? 'That’s a wrap' : 'The show has ended',
          m.episode ? 'The recording is saved and ready to play in Episodes.' : 'The show ended before there was anything to save.', !!m.episode);
      case 'error':
        if (m.code !== 'no-room' && m.code !== 'guest-taken' && m.code !== 'bad-token') return;
        finished = true; return fatal('You can’t join this studio', m.message);
    }
  }

  function renderStats(s) {
    $('count').textContent = s.listeners;
    $('sign').classList.toggle('on', s.live);
    $('hostName').textContent = s.hostName;
    if (!s.hostPresent && role === 'guest') { $('hostAv').textContent = initials(s.hostName); setStatus('host', 'warn', 'Host hasn’t arrived yet'); }
    if (role === 'guest' && s.hostPresent && (!pc || pc.connectionState !== 'connected')) { $('hostAv').textContent = initials(s.hostName); setStatus('host', 'warn', 'Connecting…'); }
    if (role === 'host') $('hostAv').textContent = initials(myName);
    if (s.guestPresent) {
      $('seatGuest').classList.remove('empty');
      $('guestName').textContent = s.guestName; $('guestAv').textContent = initials(s.guestName);
    } else if (role === 'host') {
      $('seatGuest').classList.add('empty'); $('guestName').textContent = 'Waiting for your guest';
      $('guestAv').textContent = '+'; $('guestMuted').hidden = true;
      setStatus('guest', '', 'Send them the guest link');
    }
    isLive = s.live || (isLive && role === 'host' && !!recorder);
    $('liveBtn').textContent = s.live ? 'End show' : 'Go live';
    $('liveBtn').classList.toggle('pink', !s.live);
    $('liveBtn').classList.toggle('sun', s.live);
    if (role === 'guest') $('guestNote').textContent = s.live ? 'You’re on air. Listeners can hear you both right now.' : 'You’re in the guest seat. The host decides when the show goes live.';
    if (s.live) {
      timerBase = Date.now() - s.elapsed;
      if (!timerInt) timerInt = setInterval(() => $('timer').textContent = fmt((Date.now() - timerBase) / 1000), 500);
    } else if (timerInt) { clearInterval(timerInt); timerInt = null; }
  }

  function setStatus(who, kind, text) {
    const el = $(who + 'Status');
    el.className = 'status ' + kind;
    el.innerHTML = '<i></i>'; el.append(text);
  }

  /* ---------- WebRTC call between host and guest ---------- */
  function newPC() {
    const p = new RTCPeerConnection({ iceServers });
    p.onicecandidate = e => {
      if (e.candidate) send({ type: 'signal', data: { candidate: e.candidate } });
    };
    p.ontrack = e => attachRemote(e.streams[0] || new MediaStream([e.track]));
    p.onconnectionstatechange = () => {
      const st = p.connectionState;
      if (st === 'connected') setStatus(other, 'ok', 'Connected');
      else if (st === 'connecting') setStatus(other, 'warn', 'Connecting…');
      else if (st === 'failed') setStatus(other, 'warn', 'Connection trouble. Try rejoining.');
      else if (st === 'disconnected') setStatus(other, 'warn', 'Reconnecting…');
    };
    if (localStream) {
      localStream.getTracks().forEach(t => {
        try { p.addTrack(t, localStream); } catch (_) {}
      });
    }
    return p;
  }

  function closePC() {
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try { pc.close(); } catch (_) {}
      pc = null;
    }
    pending = [];
    try {
      if (remoteSrc) {
        remoteSrc.disconnect();
        remoteSrc = null;
      }
    } catch (_) {}
  }

  async function drainPendingCandidates() {
    while (pending.length) {
      const cand = pending.shift();
      try {
        await pc.addIceCandidate(cand);
      } catch (e) {
        console.warn('ICE candidate add error:', e.message);
      }
    }
  }

  async function startCall() {
    try {
      closePC();
      pc = newPC();
      setStatus('guest', 'warn', 'Connecting…');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'signal', data: { sdp: pc.localDescription } });
    } catch (err) {
      console.warn('Failed to start WebRTC call:', err);
    }
  }

  async function onSignal(d) {
    try {
      if (d.sdp) {
        if (d.sdp.type === 'offer') {
          closePC();
          pc = newPC();
          await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
          await drainPendingCandidates();
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          send({ type: 'signal', data: { sdp: pc.localDescription } });
        } else if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
          await drainPendingCandidates();
        }
      } else if (d.candidate) {
        if (pc && pc.remoteDescription && pc.remoteDescription.type) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(d.candidate));
          } catch (e) {
            console.warn('ICE candidate error', e);
          }
        } else {
          pending.push(d.candidate);
        }
      }
    } catch (err) { console.warn('signal error', err); }
  }

  function attachRemote(stream) {
    remoteAudio.srcObject = stream;
    remoteAudio.play().catch(() => {});
    try {
      if (remoteSrc) {
        remoteSrc.disconnect();
        remoteSrc = null;
      }
    } catch (_) {}
    try {
      remoteSrc = ctx.createMediaStreamSource(stream);
      remoteAn = ctx.createAnalyser();
      remoteAn.fftSize = 256;
      remoteAn.smoothingTimeConstant = 0.75;
      remoteSrc.connect(remoteAn);
      if (role === 'host') remoteSrc.connect(comp); // guest voice goes into the recording mix
      addMeter($(other + 'Meter'), remoteAn, '#ff9fc4');
    } catch (err) {
      console.warn('attachRemote error:', err);
    }
  }

  /* ---------- controls ---------- */
  $('muteBtn').onclick = () => {
    muted = !muted;
    if (localStream) {
      localStream.getAudioTracks().forEach(t => t.enabled = !muted);
    }
    $('muteBtn').textContent = muted ? 'Unmute my mic' : 'Mute my mic';
    $('muteBtn').classList.toggle('is-muted', muted);
    $(me + 'Muted').hidden = !muted;
    send({ type: 'peer-state', muted });
  };
  $('leaveBtn').onclick = () => { finished = true; if (ws) ws.close(); location.href = '/'; };

  $('liveBtn').onclick = () => { isLive && recorder ? $('endDlg').showModal() : startLive(); };
  $('keepOn').onclick = () => $('endDlg').close();
  $('confirmEnd').onclick = () => {
    $('endDlg').close();
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (_) { send({ type: 'end' }); }
    } else {
      send({ type: 'end' });
    }
  };

  function startLive() {
    const candidateMimes = [
      'audio/webm;codecs=opus',
      'audio/webm; codecs="opus"',
      'audio/webm',
      'audio/ogg;codecs=opus'
    ];
    const mime = candidateMimes.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime) {
      toast('This browser can’t record live audio. Use Chrome, Edge or Firefox on a computer.', 5000);
      return;
    }
    send({ type: 'go-live' });
    isLive = true;
    chain = Promise.resolve();
    try {
      recorder = new MediaRecorder(mixDest.stream, { mimeType: mime, audioBitsPerSecond: 96000 });
    } catch (e) {
      recorder = new MediaRecorder(mixDest.stream);
    }
    recorder.ondataavailable = e => {
      if (!e.data || !e.data.size) return;
      chain = chain.then(() => e.data.arrayBuffer()).then(b => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(b); } catch (_) {}
        }
      });
    };
    recorder.onstop = () => {
      chain.then(() => send({ type: 'end' }));
    };
    recorder.start(1000);
    toast('You’re live');
  }

  function stopRecorder(silent) {
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      try { recorder.stop(); } catch (_) {}
    }
    recorder = null;
  }
  window.addEventListener('beforeunload', e => {
    if (role === 'host' && isLive && !finished) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function showWrap(title, text, showEpisodes) {
    $('wrap').hidden = false;
    $('wrapTitle').textContent = title;
    $('wrapText').textContent = text;
    $('wrapPrimary').hidden = !showEpisodes;
    if (timerInt) clearInterval(timerInt);
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    closePC();
  }
})();
