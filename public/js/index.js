const $ = s => document.querySelector(s);
const audio = $('#audio');
let episodes = [], current = null;

/* ---------- live shows ---------- */
async function loadLive() {
  try {
    const list = await (await fetch('/api/live')).json();
    $('#boardLamp').classList.toggle('on', list.length > 0);
    $('#eq').classList.toggle('active', list.length > 0);
    const box = $('#liveList');
    if (!list.length) {
      box.innerHTML = '<div class="empty"><b>Nobody is on air.</b>Start the next show and it will appear here for everyone.</div>';
      return;
    }
    box.innerHTML = '';
    list.forEach(s => {
      const d = document.createElement('div'); d.className = 'live-item';
      const who = s.guestName ? `${s.hostName} with ${s.guestName}` : `Hosted by ${s.hostName}`;
      d.innerHTML = '<h3></h3><p></p><div class="row"><span></span><a class="btn pink small">Tune in</a></div>';
      d.querySelector('h3').textContent = s.title;
      d.querySelector('p').textContent = who;
      d.querySelector('span').textContent = `${s.listeners} listening`;
      d.querySelector('a').href = '/listen.html?room=' + s.id;
      box.appendChild(d);
    });
  } catch (_) {}
}
loadLive(); setInterval(loadLive, 5000);

/* ---------- episodes ---------- */
const playSvg = '<path d="M8 5v14l11-7z"/>', pauseSvg = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
function when(iso) { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
function minutes(sec) { return sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec} sec`; }

async function loadEpisodes() {
  try {
    const res = await fetch('/api/episodes');
    if (!res.ok) throw new Error('Failed to load episodes');
    episodes = await res.json();
  } catch (err) {
    console.warn('loadEpisodes error:', err);
    episodes = [];
  }
  const box = $('#epList'); box.innerHTML = '';
  if (!episodes || !episodes.length) {
    box.innerHTML = '<div class="empty-state"><b>No episodes yet.</b>Go live with a guest, or upload a recording, and it will show up here.</div>';
    return;
  }
  episodes.forEach(ep => {
    const row = document.createElement('article'); row.className = 'ep'; row.dataset.id = ep.id;
    row.innerHTML = `<div class="cover">${coverSVG(ep.id)}</div>
      <div><h3></h3><div class="by"></div><div class="when"></div></div>
      <div class="ep-actions">
        <a class="btn small" download>Download</a>
        <button class="btn pink round" aria-label="Play"><svg viewBox="0 0 24 24">${playSvg}</svg></button>
      </div>`;
    const h = row.querySelector('h3'); h.textContent = ep.title;
    if (ep.source === 'live') { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'Was live'; h.appendChild(t); }
    row.querySelector('.by').textContent = ep.guest ? `${ep.host} with ${ep.guest}` : `Hosted by ${ep.host}`;
    row.querySelector('.when').textContent = `${when(ep.date)}, ${minutes(ep.duration)}`;
    row.querySelector('a').href = '/recordings/' + ep.file;
    row.querySelector('a').download = ep.title.replace(/[^\w\- ]+/g, '') + '.' + ep.file.split('.').pop();
    row.querySelector('button').onclick = () => toggle(ep);
    box.appendChild(row);
  });
}
loadEpisodes();

/* ---------- player ---------- */
function paint() {
  const playing = !audio.paused;
  $('#pIcon').innerHTML = playing ? pauseSvg : playSvg;
  document.querySelectorAll('.ep').forEach(r => {
    const on = current && r.dataset.id === current.id;
    r.classList.toggle('playing', on);
    r.querySelector('button svg').innerHTML = on && playing ? pauseSvg : playSvg;
  });
}
function toggle(ep) {
  if (current && current.id === ep.id) { audio.paused ? audio.play() : audio.pause(); return; }
  current = ep;
  audio.src = '/recordings/' + ep.file;
  // MediaRecorder files carry no length: this nudge makes the browser work it out so seeking works
  audio.onloadedmetadata = () => {
    if (audio.duration === Infinity) {
      audio.currentTime = 1e101;
      audio.ontimeupdate = () => { audio.ontimeupdate = null; audio.currentTime = 0; audio.ontimeupdate = update; };
    }
  };
  $('#pTitle').innerHTML = '<span></span><small></small>';
  $('#pTitle span').textContent = ep.title;
  $('#pTitle small').textContent = ep.guest ? `${ep.host} with ${ep.guest}` : `Hosted by ${ep.host}`;
  $('#player').classList.add('show');
  audio.play().catch(() => toast('We could not play that file in this browser.'));
}
const total = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (current ? current.duration : 0));
function update() {
  const t = total();
  if (t) $('#seek').value = Math.min(1000, (audio.currentTime / t) * 1000);
  $('#pTime').textContent = `${fmt(audio.currentTime)} / ${fmt(t)}`;
}
audio.ontimeupdate = update;
audio.onplay = audio.onpause = paint;
audio.onended = () => { paint(); $('#seek').value = 0; };
$('#pBtn').onclick = () => { if (current) audio.paused ? audio.play() : audio.pause(); };
$('#seek').oninput = e => { const t = total(); if (t) audio.currentTime = (e.target.value / 1000) * t; };

/* ---------- dialogs ---------- */
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
['#openStart', '#openStart2'].forEach(s => $(s).onclick = () => $('#startDlg').showModal());
$('#openUpload').onclick = () => $('#uploadDlg').showModal();

$('#startForm').onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $('#startGo').disabled = true; $('#startErr').hidden = true;
  try {
    const r = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Something went wrong.');
    localStorage.setItem('wl-host-' + j.id, j.token);
    location.href = `/studio.html?room=${j.id}&role=host&token=${encodeURIComponent(j.token)}`;
  } catch (err) {
    $('#startErr').textContent = err.message; $('#startErr').hidden = false; $('#startGo').disabled = false;
  }
};

$('#uploadForm').onsubmit = async e => {
  e.preventDefault();
  const form = e.target, file = form.file.files[0];
  if (!file) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const err = $('#upErr'); err.hidden = true;
  $('#upGo').disabled = true; $('#upBar').hidden = false;
  const duration = await new Promise(res => {
    const a = new Audio(); a.preload = 'metadata'; a.src = URL.createObjectURL(file);
    a.onloadedmetadata = () => res(isFinite(a.duration) ? a.duration : 0); a.onerror = () => res(0);
  });
  const qs = new URLSearchParams({ ext, title: form.title.value, host: form.host.value, guest: form.guest.value, duration });
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload?' + qs);
  xhr.upload.onprogress = ev => { if (ev.lengthComputable) $('#upBar i').style.width = (ev.loaded / ev.total * 100) + '%'; };
  xhr.onload = () => {
    $('#upGo').disabled = false;
    if (xhr.status === 200) {
      $('#uploadDlg').close(); form.reset(); $('#upBar').hidden = true; $('#upBar i').style.width = 0;
      toast('Episode uploaded'); loadEpisodes();
    } else {
      let m = 'Upload failed.'; try { m = JSON.parse(xhr.responseText).error || m; } catch (_) {}
      err.textContent = m; err.hidden = false;
    }
  };
  xhr.onerror = () => { $('#upGo').disabled = false; err.textContent = 'Network error. Check your connection and try again.'; err.hidden = false; };
  xhr.send(file);
};
if (location.hash === '#episodes') setTimeout(() => $('#episodes').scrollIntoView(), 50);
