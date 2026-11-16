'use strict';
// Doggo Cam: the camera device streams straight to each viewer over WebRTC (PeerJS).
// The public PeerJS server only introduces the devices; media is end-to-end encrypted.

const $ = s => document.querySelector(s);
const PREFIX = 'doggocam-v1-';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const ALPH = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 chars, no l/o/0/1
const rid = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => ALPH[b % 32]).join('');
const show = id => document.querySelectorAll('.screen').forEach(s => s.hidden = s.id !== id);
function pill(el, state, text) { el.classList.toggle('on', state === 'on'); el.classList.toggle('off', state === 'off'); el.querySelector('b').textContent = text; }
const params = () => new URLSearchParams(location.hash.slice(1));

window.addEventListener('hashchange', () => location.reload());
route();

function route() {
  const p = params();
  if (p.has('cam')) return camSetup(p.has('test'));
  if (p.get('c')) return viewJoin(p.get('c'));
  show('home');
  const saved = store.get('lastCam', null);
  if (saved) $('#homeSaved').innerHTML = `<a class="btn" href="#c=${encodeURIComponent(saved)}">🐶 Deschide ultima cameră</a>`;
}

/* ============================== CAMERA ============================== */
function camSetup(testMode) {
  show('camSetup');
  let camId = store.get('camId', null);
  if (!camId) { camId = rid(20); store.set('camId', camId); }
  const pinEl = $('#camPin'), facingEl = $('#camFacing'), qualEl = $('#camQuality');
  pinEl.value = store.get('camPin', '');
  facingEl.value = store.get('camFacing', 'environment');
  qualEl.value = store.get('camQuality', '720');

  const link = `${location.origin}${location.pathname}#c=${camId}`;
  $('#shareLink').value = link;
  try { const q = qrcode(0, 'M'); q.addData(link); q.make(); $('#qr').innerHTML = q.createImgTag(6, 0); } catch {}
  $('#copyLink').onclick = async () => {
    try { await navigator.clipboard.writeText(link); $('#copyLink').textContent = 'Copiat ✓'; }
    catch { $('#shareLink').select(); document.execCommand('copy'); }
  };
  $('#newLink').onclick = () => { if (confirm('Link nou? Cine are link-ul vechi nu mai poate intra.')) { store.set('camId', rid(20)); location.reload(); } };

  let started = false;
  $('#camStart').onclick = () => {
    if (started) return;
    const pin = pinEl.value.trim();
    if (!/^\d{4,8}$/.test(pin)) { $('#camSetupErr').textContent = 'PIN-ul trebuie să aibă 4–8 cifre.'; return; }
    store.set('camPin', pin); store.set('camFacing', facingEl.value); store.set('camQuality', qualEl.value);
    started = true;
    camLive({ camId, pin, facing: facingEl.value, quality: +qualEl.value, testMode })
      .catch(e => { started = false; show('camSetup'); $('#camSetupErr').textContent = 'Nu pot porni camera: ' + (e.message || e.name || e); });
  };
}

async function camLive(cfg) {
  let facing = cfg.facing;
  const stream = new MediaStream();
  const audio = cfg.testMode ? testAudio() : (await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
  })).getAudioTracks()[0];
  stream.addTrack(await getVideo()); // video first: viewers get it in the first track event
  stream.addTrack(audio);
  show('camLive');
  const preview = $('#camPreview');
  preview.srcObject = stream;
  preview.play().catch(() => {});

  async function getVideo() {
    if (cfg.testMode) return testVideo(facing);
    const h = cfg.quality, w = Math.round(h * 16 / 9);
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } },
    });
    return s.getVideoTracks()[0];
  }

  // keep the screen on (iPadOS 16.4+, in Safari)
  let lock = null;
  const wake = async () => { try { if (document.visibilityState === 'visible' && navigator.wakeLock) lock = await navigator.wakeLock.request('screen'); } catch {} };
  wake();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    wake();
    const v = stream.getVideoTracks()[0];
    if (v && v.readyState === 'ended') await swapVideo(); // iOS kills the camera when the tab is hidden
  });

  const viewers = new Map(); // peerId -> {conn, call, name, ok, el}
  let talker = null, fails = 0, lockUntil = 0, peer = null, stopped = false;
  const statusEl = $('#camStatus');

  function startPeer() {
    if (stopped) return;
    pill(statusEl, '', 'Conectare…');
    const p = peer = new Peer(PREFIX + cfg.camId, { debug: 1 });
    p.on('open', () => { if (p === peer) pill(statusEl, 'on', 'Online'); });
    p.on('connection', handleViewer);
    p.on('disconnected', () => {
      if (p !== peer || p.destroyed) return;
      pill(statusEl, 'off', 'Reconectare…');
      setTimeout(() => { if (!stopped && p === peer && !p.destroyed && p.disconnected) p.reconnect(); }, 2000);
    });
    p.on('error', e => {
      console.warn('peer error', e.type, e);
      if (p !== peer) return;
      if (['unavailable-id', 'network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
        pill(statusEl, 'off', e.type === 'unavailable-id' ? 'Aștept ID-ul…' : 'Fără internet, reîncerc…');
        try { peer.destroy(); } catch {}
        setTimeout(startPeer, 4000);
      }
    });
  }
  startPeer();
  window.__cam = () => ({ open: peer.open, destroyed: peer.destroyed, disconnected: peer.disconnected, viewers: viewers.size, t: performance.now() | 0 });

  function handleViewer(conn) {
    const v = { conn, call: null, name: '?', ok: false, el: null };
    viewers.set(conn.peer, v);
    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello' && !v.ok) {
        if (Date.now() < lockUntil) { conn.send({ type: 'bad', reason: 'lock' }); setTimeout(() => conn.close(), 300); return; }
        if (String(msg.pin) !== cfg.pin) {
          if (++fails >= 5) { lockUntil = Date.now() + 60000; fails = 0; }
          conn.send({ type: 'bad', reason: 'pin' }); setTimeout(() => conn.close(), 300); return;
        }
        fails = 0; v.ok = true; v.name = String(msg.name || 'Anonim').slice(0, 20);
        conn.send({ type: 'ok' });
        startCall(v);
        broadcast();
        return;
      }
      if (!v.ok) return;
      if (msg.type === 'talk') {
        if (msg.on && !talker) talker = v;
        else if (!msg.on && talker === v) talker = null;
        broadcast();
      } else if (msg.type === 'flip') flip();
    });
    conn.on('close', () => drop(v));
    conn.on('error', () => drop(v));
  }

  function startCall(v) {
    const call = peer.call(v.conn.peer, stream);
    v.call = call;
    call.on('stream', s => {
      if (!v.el) { v.el = document.createElement('audio'); v.el.autoplay = true; v.el.playsInline = true; document.body.appendChild(v.el); }
      v.el.srcObject = s;
      v.el.muted = talker !== v;
      v.el.play().catch(() => {});
    });
    call.on('close', () => drop(v));
    call.on('error', () => drop(v));
  }

  function drop(v) {
    if (!viewers.has(v.conn.peer)) return;
    viewers.delete(v.conn.peer);
    try { v.call && v.call.close(); } catch {}
    try { v.conn.close(); } catch {}
    if (v.el) { v.el.srcObject = null; v.el.remove(); }
    if (talker === v) talker = null;
    broadcast();
  }

  function broadcast() {
    const list = [...viewers.values()].filter(v => v.ok);
    for (const v of list) if (v.el) v.el.muted = talker !== v;
    const state = { type: 'state', viewers: list.map(v => v.name), talker: talker ? talker.name : null, talkerId: talker ? talker.conn.peer : null };
    for (const v of list) { try { v.conn.send(state); } catch {} }
    $('#camViewers').textContent = '👀 ' + (list.length ? list.map(v => v.name).join(', ') : '0');
    const tb = $('#camTalk');
    tb.hidden = !talker;
    if (talker) tb.textContent = '🎙 ' + talker.name + ' vorbește';
  }

  async function swapVideo() {
    const old = stream.getVideoTracks()[0];
    if (old) { old.stop(); stream.removeTrack(old); } // iOS: one camera at a time
    const t = await getVideo();
    stream.addTrack(t);
    for (const v of viewers.values()) {
      const pc = v.call && v.call.peerConnection;
      const sender = pc && pc.getSenders().find(s => s.track ? s.track.kind === 'video' : false) || (pc && pc.getSenders().find(s => !s.track));
      if (sender) sender.replaceTrack(t).catch(() => {});
    }
    preview.srcObject = stream;
  }
  let flipping = false;
  async function flip() {
    if (flipping) return; flipping = true;
    facing = facing === 'user' ? 'environment' : 'user';
    store.set('camFacing', facing);
    try { await swapVideo(); } catch (e) { console.warn(e); }
    flipping = false;
  }

  $('#camFlip').onclick = flip;
  $('#camShare').onclick = () => { $('#shareSlot').appendChild(document.querySelector('.share')); $('#shareModal').hidden = false; };
  $('#shareClose').onclick = () => { $('#shareModal').hidden = true; };
  $('#camBlack').onclick = () => { $('#blackout').hidden = false; };
  $('#blackout').ondblclick = () => { $('#blackout').hidden = true; };
  let lastTap = 0;
  $('#blackout').addEventListener('touchend', e => { const n = Date.now(); if (n - lastTap < 400) $('#blackout').hidden = true; lastTap = n; e.preventDefault(); });
  $('#camStop').onclick = () => {
    if (!confirm('Oprești camera?')) return;
    stopped = true;
    try { peer.destroy(); } catch {}
    stream.getTracks().forEach(t => t.stop());
    try { lock && lock.release(); } catch {}
    location.reload();
  };
}

// test mode (#cam&test): fake picture + tone instead of the real camera
function testVideo(facing) {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const g = c.getContext('2d'); let f = 0;
  setInterval(function draw() {
    f++; g.fillStyle = facing === 'user' ? '#234' : '#342'; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#ff9f2e'; g.beginPath(); g.arc(640 + Math.sin(f / 30) * 400, 360, 60, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText('TEST ' + facing + ' ' + new Date().toLocaleTimeString(), 40, 80);
    for (let i = 0; i < 16; i++) { g.strokeStyle = '#fff3'; g.strokeRect(i * 80, 0, 80, 720); }
  }, 33);
  return c.captureStream(30).getVideoTracks()[0];
}
function testAudio() {
  const ctx = new AudioContext(), o = ctx.createOscillator(), gn = ctx.createGain(), d = ctx.createMediaStreamDestination();
  o.frequency.value = 330; gn.gain.value = 0; o.connect(gn).connect(d); o.start(); // silent: a test tone hums in the user's speakers
  return d.stream.getAudioTracks()[0];
}

/* ============================== VIEWER ============================== */
function viewJoin(camId) {
  show('viewJoin');
  const known = store.get('pins', {});
  $('#viewName').value = store.get('name', '');
  $('#viewPin').value = known[camId] || '';
  try { $('#viewJoinErr').textContent = sessionStorage.getItem('joinErr') || ''; sessionStorage.removeItem('joinErr'); } catch {}
  $('#viewJoinBtn').onclick = () => {
    const name = $('#viewName').value.trim(), pin = $('#viewPin').value.trim();
    if (!name) { $('#viewJoinErr').textContent = 'Scrie-ți numele.'; return; }
    if (!/^\d{4,8}$/.test(pin)) { $('#viewJoinErr').textContent = 'PIN-ul are 4–8 cifre.'; return; }
    store.set('name', name);
    viewLive(camId, name, pin);
  };
}

function viewLive(camId, name, pin) {
  show('viewLive');
  store.set('lastCam', camId);
  // made inside the tap, so iOS lets us use audio
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume();
  const silent = ctx.createMediaStreamDestination().stream; // our outgoing audio when not talking

  const video = $('#remote'), statusEl = $('#viewStatus'), offline = $('#offline');
  let peer = null, conn = null, call = null, joined = false, retryT = 0, myId = null, talkState = { talkerId: null, talker: null };
  let userMuted = false;

  // status shows the picture size, so "no picture" is visible at a glance
  function liveText() {
    if (!joined) return;
    pill(statusEl, 'on', video.videoWidth ? `Live ${video.videoWidth}×${video.videoHeight}` : 'Live (fără imagine încă)');
  }
  video.addEventListener('resize', liveText);
  video.addEventListener('loadedmetadata', liveText);
  function setOffline(text) { offline.classList.remove('gone'); $('#offlineText').textContent = text; }
  function retry(text, ms = 4000) {
    joined = false;
    setOffline(text);
    pill(statusEl, 'off', 'Offline');
    clearTimeout(retryT);
    retryT = setTimeout(connect, ms);
  }

  function startPeer() {
    peer = new Peer({ debug: 1 });
    peer.on('open', id => { myId = id; connect(); });
    peer.on('disconnected', () => setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 2000));
    peer.on('error', e => {
      console.warn('peer error', e.type, e);
      if (e.type === 'peer-unavailable') retry('Camera e offline. Reîncerc…');
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) retry('Fără internet. Reîncerc…', 5000);
    });
    peer.on('call', c => {
      if (!conn || c.peer !== conn.peer) return c.close();
      try { call && call.close(); } catch {}
      call = c;
      c.answer(silent);
      // Safari won't show a video track added to a stream it is already playing,
      // so hand the element a fresh MediaStream every time the track set changes.
      let attachT = 0;
      const attach = s => {
        clearTimeout(attachT);
        attachT = setTimeout(() => {
          video.srcObject = new MediaStream(s.getTracks());
          video.muted = userMuted;
          video.play().then(() => { $('#tapSound').hidden = true; }).catch(() => {
            video.muted = true; video.play().catch(() => {});
            if (!userMuted) $('#tapSound').hidden = false;
          });
          offline.classList.add('gone');
          liveText();
        }, 150);
      };
      c.on('stream', s => { attach(s); s.onaddtrack = () => attach(s); });
      c.on('close', () => { if (call === c) retry('Legătura s-a pierdut. Reîncerc…', 1500); });
    });
  }

  function connect() {
    clearTimeout(retryT);
    if (!peer || peer.destroyed || peer.disconnected) return (retryT = setTimeout(connect, 2000));
    try { conn && conn.close(); } catch {}
    setOffline('Caut camera…');
    pill(statusEl, '', 'Conectare…');
    const c = peer.connect(PREFIX + camId, { reliable: true });
    conn = c;
    const t = setTimeout(() => { if (conn === c && !joined) { try { c.close(); } catch {} retry('Camera nu răspunde. Reîncerc…'); } }, 12000);
    c.on('open', () => c.send({ type: 'hello', name, pin }));
    c.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ok') {
        joined = true; clearTimeout(t);
        const pins = store.get('pins', {}); pins[camId] = pin; store.set('pins', pins);
        setOffline('Pornesc imaginea…');
      } else if (msg.type === 'bad') {
        clearTimeout(t); joined = false; clearTimeout(retryT);
        try { peer.destroy(); } catch {}
        const pins = store.get('pins', {}); delete pins[camId]; store.set('pins', pins);
        try { sessionStorage.setItem('joinErr', msg.reason === 'lock' ? 'Prea multe încercări. Așteaptă un minut.' : 'PIN greșit.'); } catch {}
        location.reload(); // clean start, no doubled listeners
      } else if (msg.type === 'state') {
        talkState = msg;
        $('#viewViewers').textContent = '👀 ' + msg.viewers.join(', ');
        const tb = $('#viewTalk');
        tb.hidden = !msg.talker || msg.talkerId === myId;
        if (msg.talker) tb.textContent = '🎙 ' + msg.talker + ' vorbește';
        $('#ptt').classList.toggle('busy', !!msg.talkerId && msg.talkerId !== myId);
      }
    });
    c.on('close', () => { if (conn === c && joined) retry('Camera s-a oprit. Reîncerc…', 2000); });
  }
  startPeer();

  $('#tapSound').onclick = () => { video.muted = false; video.play().catch(() => {}); $('#tapSound').hidden = true; };
  $('#viewMute').onclick = () => {
    userMuted = !userMuted;
    video.muted = userMuted;
    if (!userMuted) video.play().catch(() => {});
    $('#tapSound').hidden = true;
    $('#viewMute').textContent = userMuted ? '🔇' : '🔊';
  };
  $('#viewFlip').onclick = () => { try { conn && conn.send({ type: 'flip' }); } catch {} };

  /* ---- push to talk: mic only while held (iOS sends audio to the earpiece while the mic is open) ---- */
  const ptt = $('#ptt');
  let talking = false, mic = null;
  const audioSender = () => call && call.peerConnection && call.peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
  async function talkOn(e) {
    e.preventDefault();
    if (talking || !joined || !call) return;
    if (talkState.talkerId && talkState.talkerId !== myId) return;
    talking = true;
    try { ptt.setPointerCapture(e.pointerId); } catch {}
    ptt.classList.add('live'); ptt.textContent = '🎙 Vorbești…';
    try { conn.send({ type: 'talk', on: true }); } catch {}
    try {
      const m = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const tr = m.getAudioTracks()[0];
      if (!talking) { tr.stop(); return; }
      mic = tr;
      const s = audioSender();
      if (s) await s.replaceTrack(tr);
    } catch (err) {
      talkOff();
      ptt.textContent = '🎙 Microfon blocat';
      setTimeout(() => { ptt.textContent = '🎙 Ține apăsat ca să vorbești'; }, 2500);
    }
  }
  function talkOff() {
    if (!talking) return;
    talking = false;
    const s = audioSender();
    if (s) s.replaceTrack(silent.getAudioTracks()[0]).catch(() => {});
    if (mic) { mic.stop(); mic = null; }
    try { conn.send({ type: 'talk', on: false }); } catch {}
    ptt.classList.remove('live'); ptt.textContent = '🎙 Ține apăsat ca să vorbești';
  }
  ptt.addEventListener('pointerdown', talkOn);
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => ptt.addEventListener(ev, talkOff));
  ptt.addEventListener('contextmenu', e => e.preventDefault());

  setupZoom(video, $('#stage'));
}

/* ============================== ZOOM ============================== */
function setupZoom(video, stage) {
  let s = 1, x = 0, y = 0;
  const MAX = 8, label = $('#zoomLabel');
  const pts = new Map();
  let pinch = null, pan = null, lastTap = 0;

  function apply() {
    const W = stage.clientWidth, H = stage.clientHeight;
    s = Math.min(MAX, Math.max(1, s));
    const mx = (s - 1) * W / 2, my = (s - 1) * H / 2;
    x = Math.min(mx, Math.max(-mx, x)); y = Math.min(my, Math.max(-my, y));
    video.style.transform = `translate(${x}px,${y}px) scale(${s})`;
    label.hidden = s <= 1.01;
    label.textContent = s.toFixed(1) + '×';
  }
  // zoom to scale ns keeping the screen point (px,py) still
  function zoomAt(ns, px, py) {
    const r = stage.getBoundingClientRect();
    const cx = px - r.left - r.width / 2, cy = py - r.top - r.height / 2;
    ns = Math.min(MAX, Math.max(1, ns));
    x = cx - (cx - x) * ns / s; y = cy - (cy - y) * ns / s; s = ns;
    apply();
  }
  const center = () => { const r = stage.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };

  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
      pan = null;
    } else if (pts.size === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { zoomAt(s > 1.5 ? 1 : 3, e.clientX, e.clientY); lastTap = 0; }
      else lastTap = now;
      pan = { px: e.clientX, py: e.clientY, x, y };
    }
  });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      x += mx - pinch.mx; y += my - pinch.my; pinch.mx = mx; pinch.my = my; // two-finger drag
      zoomAt(pinch.s * d / pinch.d, mx, my);
    } else if (pan && s > 1) {
      x = pan.x + e.clientX - pan.px; y = pan.y + e.clientY - pan.py; apply();
    }
  });
  const up = e => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 1) { const [p] = [...pts.values()]; pan = { px: p[0], py: p[1], x, y }; }
    if (pts.size === 0) pan = null;
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', e => { e.preventDefault(); zoomAt(s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  // stop iOS page zoom gestures
  document.addEventListener('gesturestart', e => e.preventDefault());

  $('#zoomIn').onclick = () => zoomAt(s * 1.5, ...center());
  $('#zoomOut').onclick = () => zoomAt(s / 1.5, ...center());
  $('#zoomReset').onclick = () => { s = 1; x = y = 0; apply(); };
  window.addEventListener('resize', apply);
  apply();
}
