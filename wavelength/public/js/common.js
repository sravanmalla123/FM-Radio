/* Shared helpers */
const wsUrl = p => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${p}`;
const pad = n => String(n).padStart(2, '0');
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function toast(msg, ms = 3200) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast('Link copied to clipboard');
      return;
    }
    throw new Error('Clipboard API unavailable');
  } catch (_) {
    try {
      const input = document.createElement('input');
      input.value = text;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.focus();
      input.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(input);
      if (ok) {
        toast('Link copied to clipboard');
        return;
      }
    } catch (_) {}
    prompt('Copy this link:', text);
  }
}
function initials(name) {
  return (String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('') || '?').toUpperCase();
}
function floatReaction(emoji, host) {
  const s = document.createElement('span');
  s.className = 'float-react'; s.textContent = emoji;
  s.style.left = (Math.random() * 70) + 'px';
  host.appendChild(s); setTimeout(() => s.remove(), 2500);
}
/* Generated cover art, so every show gets its own look */
function coverSVG(seed) {
  let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const sets = [['#2b3cff', '#ff4f93', '#ffc83d'], ['#ff4f93', '#12143a', '#ffc83d'], ['#ffc83d', '#2b3cff', '#ff4f93'], ['#12143a', '#ffc83d', '#ff4f93'], ['#ff4f93', '#2b3cff', '#ffffff']];
  const [a, b, c] = sets[h % sets.length];
  const shapes = [
    `<circle cx="64" cy="36" r="30" fill="${b}"/><rect x="-6" y="70" width="140" height="30" rx="15" fill="${c}" transform="rotate(-12 64 80)"/>`,
    `<rect x="14" y="14" width="64" height="64" rx="32" fill="${b}"/><circle cx="92" cy="92" r="26" fill="${c}"/>`,
    `<path d="M-4 80Q32 30 64 70T132 50V132H-4Z" fill="${b}"/><circle cx="92" cy="30" r="16" fill="${c}"/>`
  ];
  return `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="128" height="128" fill="${a}"/>${shapes[(h >> 3) % 3]}</svg>`;
}
const LOGO = `<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="bg" cx="18" cy="18" r="17" fill="#2b3cff" stroke="#12143a" stroke-width="2"/><path class="fg" d="M6 18h4l3-8 5 16 4-12 2 4h6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
document.querySelectorAll('.logo').forEach(l => l.insertAdjacentHTML('afterbegin', LOGO));

/* Frequency-bar meters drawn from an AnalyserNode */
const meters = [];
function addMeter(canvas, analyser, color = '#ffc83d') {
  const i = meters.findIndex(m => m.c === canvas);
  if (i > -1) meters.splice(i, 1);
  meters.push({ c: canvas, a: analyser, d: new Uint8Array(analyser.frequencyBinCount), color });
}
function clearMeters() { meters.length = 0; }
let meterLoop = false;
function startMeters() {
  if (meterLoop) return; meterLoop = true;
  const tick = () => {
    for (const m of meters) {
      const cv = m.c, g = cv.getContext('2d'), w = cv.width, h = cv.height, bars = 28;
      m.a.getByteFrequencyData(m.d);
      g.clearRect(0, 0, w, h);
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const v = m.d[Math.floor(i * 1.6) + 1] / 255;
        const bh = Math.max(4, v * h * .95);
        g.fillStyle = v > .55 ? '#ff4f93' : m.color;
        g.beginPath(); g.roundRect(i * bw + 2, (h - bh) / 2, bw - 4, bh, 4); g.fill();
      }
    }
    requestAnimationFrame(tick);
  };
  tick();
}
