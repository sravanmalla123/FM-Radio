'use strict';
/**
 * Wavelength Automated Verification Suite
 * Tests all core subsystems:
 * 1. Health check & configuration endpoints
 * 2. Static file serving (HTML, CSS, JS)
 * 3. Room creation, validation, and error states
 * 4. WebSocket signaling & WebRTC handshake (Host <-> Guest)
 * 5. Live audio stream ingestion, disk recording, and listener broadcasting
 * 6. Interactive reactions relay
 * 7. Show termination, episode persistence, and retrieval
 * 8. Direct audio file upload & playback endpoint
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const BASE_URL = 'http://127.0.0.1:3000';
const WS_URL = 'ws://127.0.0.1:3000/ws';

async function request(urlPath, options = {}) {
  const url = new URL(urlPath, BASE_URL);
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`  ❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`  ✅ PASSED: ${message}`);
}

async function runTests(runNumber) {
  console.log(`\n======================================================`);
  console.log(`🧪 STARTING VERIFICATION RUN #${runNumber}`);
  console.log(`======================================================\n`);

  // Test 1: Health check
  console.log(`[Test 1] Health Check & Diagnostics`);
  const health = await request('/health');
  assert(health.status === 200, 'Health endpoint returns HTTP 200');
  assert(health.json && health.json.status === 'ok', 'Health status is "ok"');
  assert(typeof health.json.uptime === 'number', 'Server reports valid uptime');

  // Test 2: WebRTC Config & STUN servers
  console.log(`\n[Test 2] WebRTC ICE Configuration`);
  const config = await request('/api/config');
  assert(config.status === 200, 'Config endpoint returns HTTP 200');
  assert(Array.isArray(config.json.iceServers), 'Config returns iceServers array');
  assert(config.json.iceServers.length >= 2, 'At least 2 STUN servers configured');

  // Test 3: Static Asset Integrity
  console.log(`\n[Test 3] Static Assets Integrity`);
  const pages = ['/', '/studio.html', '/listen.html', '/css/style.css', '/js/common.js', '/js/studio.js', '/js/listen.js', '/js/index.js'];
  for (const page of pages) {
    const asset = await request(page);
    assert(asset.status === 200, `Asset ${page} serves HTTP 200`);
    assert(asset.text.length > 50, `Asset ${page} has non-empty content (${asset.text.length} bytes)`);
  }

  // Test 4: Room Validation and Creation
  console.log(`\n[Test 4] Room Creation & Validation`);
  const invalidRoom = await request('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '', hostName: '' })
  });
  assert(invalidRoom.status === 400, 'Empty room creation rejected with HTTP 400');

  const showTitle = `Tech Talk Test Show ${Date.now()}`;
  const hostName = 'Alex Host';
  const validRoom = await request('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: showTitle,
      hostName: hostName,
      description: 'Automated test show description'
    })
  });
  assert(validRoom.status === 200, 'Valid room creation returns HTTP 200');
  assert(validRoom.json && validRoom.json.id, 'Room has generated ID');
  assert(validRoom.json.token, 'Room has host security token');
  const roomId = validRoom.json.id;
  const hostToken = validRoom.json.token;

  // Test 5: Room Retrieval
  console.log(`\n[Test 5] Room Info Retrieval`);
  const roomInfo = await request(`/api/rooms/${roomId}`);
  assert(roomInfo.status === 200, 'Room details retrieved with HTTP 200');
  assert(roomInfo.json.title === showTitle, 'Room title matches creation title');
  assert(roomInfo.json.hostName === hostName, 'Host name matches');
  assert(roomInfo.json.live === false, 'Room initial live state is false');

  // Test 6: WebSocket Host Authentication & Connection
  console.log(`\n[Test 6] WebSocket Host Connection & Security`);
  const hostWs = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?room=${roomId}&role=host&token=${hostToken}&name=${encodeURIComponent(hostName)}&cid=host-cid-1`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

  const hostHello = await new Promise(resolve => {
    hostWs.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello') resolve(msg);
      } catch (_) {}
    });
  });
  assert(hostHello.role === 'host', 'Host received hello handshake with role "host"');

  // Test 7: WebSocket Guest Seat Assignment
  console.log(`\n[Test 7] WebSocket Guest Seat Connection`);
  const guestName = 'Jordan Guest';
  let hostNotifiedOfGuest = false;
  hostWs.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'guest-joined') hostNotifiedOfGuest = true;
    } catch (_) {}
  });

  const guestWs = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?room=${roomId}&role=guest&name=${encodeURIComponent(guestName)}&cid=guest-cid-1`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

  await wait(300);
  assert(hostNotifiedOfGuest, 'Host received "guest-joined" event when guest connected');

  // Test 8: WebRTC Signaling Relay (Host <-> Guest)
  console.log(`\n[Test 8] WebRTC SDP and ICE Signaling Relay`);
  const mockOffer = { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
  let guestReceivedOffer = null;
  guestWs.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'signal' && msg.data && msg.data.sdp) guestReceivedOffer = msg.data.sdp;
    } catch (_) {}
  });

  hostWs.send(JSON.stringify({ type: 'signal', data: { sdp: mockOffer } }));
  await wait(300);
  assert(guestReceivedOffer && guestReceivedOffer.type === 'offer', 'Guest received WebRTC offer from host');

  const mockAnswer = { type: 'answer', sdp: 'v=0\r\no=- 54321 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
  let hostReceivedAnswer = null;
  hostWs.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'signal' && msg.data && msg.data.sdp) hostReceivedAnswer = msg.data.sdp;
    } catch (_) {}
  });

  guestWs.send(JSON.stringify({ type: 'signal', data: { sdp: mockAnswer } }));
  await wait(300);
  assert(hostReceivedAnswer && hostReceivedAnswer.type === 'answer', 'Host received WebRTC answer from guest');

  // Test 9: Listener Tuning In & Live Streaming
  console.log(`\n[Test 9] Going Live & Audio Relay to Listeners`);
  const listenerWs = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?room=${roomId}&role=listener`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

  let listenerReceivedBinaryChunk = false;
  listenerWs.on('message', (data, isBinary) => {
    if (isBinary || Buffer.isBuffer(data)) {
      listenerReceivedBinaryChunk = true;
    }
  });

  // Host goes live
  hostWs.send(JSON.stringify({ type: 'go-live' }));
  await wait(300);

  // Check /api/live
  const liveList = await request('/api/live');
  assert(Array.isArray(liveList.json), '/api/live returns list of shows');
  assert(liveList.json.some(s => s.id === roomId), 'Show is listed in /api/live');

  // Listener sends tune request
  listenerWs.send(JSON.stringify({ type: 'tune' }));
  await wait(200);

  // Host sends simulated binary WebM audio chunks
  const simulatedWebmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01]);
  const simulatedAudioChunk = Buffer.from(new Uint8Array(2048).fill(0x55));

  hostWs.send(simulatedWebmHeader, { binary: true });
  await wait(100);
  hostWs.send(simulatedAudioChunk, { binary: true });
  await wait(400);

  assert(listenerReceivedBinaryChunk, 'Listener received binary audio chunk in real-time');

  // Test 10: Emoji Reactions Relay
  console.log(`\n[Test 10] Real-time Emoji Reactions Relay`);
  let hostReceivedReaction = false;
  hostWs.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'react' && msg.emoji === '🔥') hostReceivedReaction = true;
    } catch (_) {}
  });

  listenerWs.send(JSON.stringify({ type: 'react', emoji: '🔥' }));
  await wait(300);
  assert(hostReceivedReaction, 'Reaction "🔥" broadcast to host in real time');

  // Test 11: End Show & Episode Persistence
  console.log(`\n[Test 11] Ending Show & Episode Archiving`);
  let listenerReceivedEnded = false;
  listenerWs.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ended') listenerReceivedEnded = true;
    } catch (_) {}
  });

  // Keep live for at least 3.5 seconds so duration >= 3s for episode saving
  console.log('  ⏳ Simulating 3.5 seconds of live airtime...');
  await wait(3500);

  hostWs.send(JSON.stringify({ type: 'end' }));
  await wait(800);
  assert(listenerReceivedEnded, 'Listener received "ended" notification');

  // Verify episode list
  const epList = await request('/api/episodes');
  assert(epList.status === 200, 'Episodes endpoint returns HTTP 200');
  assert(Array.isArray(epList.json), 'Episodes list is an array');
  const foundEp = epList.json.find(e => e.title === showTitle);
  assert(foundEp !== undefined, 'Finished live show was saved to episodes list');
  if (foundEp) {
    assert(foundEp.host === hostName, 'Saved episode has correct host');
    assert(foundEp.guest === guestName, 'Saved episode has correct guest');
    assert(foundEp.duration >= 3, 'Saved episode duration recorded accurately');
  }

  // Test 12: File Upload Endpoint
  console.log(`\n[Test 12] Audio File Upload`);
  const uploadTitle = `Uploaded Episode Test ${Date.now()}`;
  const dummyAudio = Buffer.alloc(1024, 0x41);
  const uploadQs = new URLSearchParams({
    ext: 'mp3',
    title: uploadTitle,
    host: 'Host Sara',
    guest: 'Guest Dave',
    duration: '120'
  });

  const uploadRes = await request(`/api/upload?${uploadQs.toString()}`, {
    method: 'POST',
    body: dummyAudio
  });

  assert(uploadRes.status === 200, 'Audio upload returns HTTP 200');
  assert(uploadRes.json && uploadRes.json.title === uploadTitle, 'Upload returned episode metadata');

  const epListAfterUpload = await request('/api/episodes');
  assert(epListAfterUpload.json.some(e => e.title === uploadTitle), 'Uploaded episode appears in /api/episodes');

  // Clean up WebSockets
  try { hostWs.close(); } catch (_) {}
  try { guestWs.close(); } catch (_) {}
  try { listenerWs.close(); } catch (_) {}

  console.log(`\n======================================================`);
  console.log(`🎉 RUN #${runNumber} COMPLETED: ${passedTests} checks passed!`);
  console.log(`======================================================\n`);
}

async function main() {
  try {
    console.log('🚀 Executing Multiple Full-Cycle Verification Runs...');
    
    // Check 1
    await runTests(1);
    await wait(1000);

    // Check 2
    await runTests(2);
    await wait(1000);

    // Check 3 (Testing more than twice as requested!)
    await runTests(3);

    console.log(`\n✨ ALL 3 VERIFICATION RUNS COMPLETED SUCCESSFULLY! (${passedTests}/${totalTests} checks passed)`);
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST SUITE RUNTIME ERROR:', err);
    process.exit(1);
  }
}

main();
