'use strict';

// ---------- Referencias a la pantalla ----------
const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'),
  main: $('main'),
  swipeHint: $('swipe-hint'),
  time: $('time'),
  meter: $('meter-fill'),
  latency: $('latency'),
  latVal: $('lat-val'),
};

// ---------- Configuración ----------
const MAX_SECONDS = 120;     // duración máxima de un loop
const MIN_SECONDS = 0.25;    // evita loops "accidentales" demasiado cortos
const PREROLL_SECONDS = 1;   // audio que se guarda antes de pulsar Grabar
const FADE_MS = 3;           // micro-fundido en la unión del loop (evita "clics")
const LAT_KEY = 'looper.latencyMs';

// ---------- Estado ----------
// off → ready → recording → finishing → playing ⇄ paused → (borrar) → ready
let state = 'off';
let ctx = null;
let stream = null;
let recorder = null;
let sr = 48000;

let chunks = [];             // bloques de audio recibidos del worklet
let startFrame = 0;          // primera muestra del loop
let endFrame = 0;            // última muestra (exclusiva)
let loopBuffer = null;
let source = null;
let loopOrigin = 0;          // momento (reloj de audio) que equivale al inicio del loop
let wakeLock = null;

let latencyMs = 0;

// ---------- Utilidades ----------
const latencyFrames = () => Math.round((latencyMs / 1000) * sr);
const nowFrame = () => Math.round(ctx.currentTime * sr);

function setStatus(text) { ui.status.textContent = text; }

function setState(next) {
  state = next;
  ui.main.dataset.state = next;
  const labels = {
    off: 'Activar micrófono',
    ready: '● Grabar',
    recording: '■ Cerrar loop',
    finishing: '…',
    playing: '❚❚ Pausar',
    paused: '▶ Reproducir',
  };
  ui.main.textContent = labels[next];
  ui.main.disabled = next === 'finishing';
  ui.swipeHint.hidden = !(next === 'recording' || next === 'playing' || next === 'paused');

  const messages = {
    ready: 'Listo. Toca el botón justo cuando empieces a tocar.',
    recording: 'Grabando… toca otra vez en el tiempo exacto en que debe repetirse.',
    playing: 'Sonando en loop. Toca para pausar; desliza para borrar.',
    paused: 'En pausa. Toca para reproducir desde el inicio; desliza para borrar.',
  };
  if (messages[next]) setStatus(messages[next]);
}

function loadLatency(estimateMs) {
  const saved = localStorage.getItem(LAT_KEY);
  latencyMs = saved !== null ? Number(saved) : Math.round(estimateMs);
  latencyMs = Math.max(0, Math.min(250, latencyMs || 0));
  ui.latency.value = latencyMs;
  ui.latVal.textContent = latencyMs;
}

ui.latency.addEventListener('input', () => {
  latencyMs = Number(ui.latency.value);
  ui.latVal.textContent = latencyMs;
  localStorage.setItem(LAT_KEY, String(latencyMs));
});

async function keepScreenOn() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* no es crítico */ }
}

// ---------- Activar audio ----------
async function activate() {
  if (!navigator.mediaDevices || !window.AudioWorkletNode) {
    setStatus('Este navegador no permite grabar audio. Usa Safari actualizado y abre la app desde una dirección https://');
    return;
  }
  try {
    setStatus('Pidiendo permiso para el micrófono…');
    // En iPhone, esto le indica a Safari que vamos a grabar y reproducir a la vez.
    if (navigator.audioSession) {
      try { navigator.audioSession.type = 'play-and-record'; } catch { /* ignorar */ }
    }
    // El contexto de audio se crea dentro del toque del usuario (requisito de iOS).
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    ctx.resume();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,   // sin procesamiento de voz: queremos la guitarra tal cual
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    sr = ctx.sampleRate;

    await ctx.audioWorklet.addModule('recorder-worklet.js');
    const input = ctx.createMediaStreamSource(stream);
    recorder = new AudioWorkletNode(ctx, 'recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    // La entrada NO se manda a las bocinas (evita retroalimentación);
    // la conectamos con volumen 0 sólo para que el navegador la procese.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    input.connect(recorder).connect(mute).connect(ctx.destination);
    recorder.port.onmessage = onChunk;

    await ctx.resume();

    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      stopLoop();
      setState('off');
      setStatus('Se perdió la entrada de audio. ¿Se desconectó el iRig? Toca «Activar micrófono».');
    });

    const settings = track.getSettings ? track.getSettings() : {};
    const estimate =
      ((settings.latency || 0) + (ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
    loadLatency(estimate);

    keepScreenOn();
    setState('ready');
  } catch (err) {
    console.error(err);
    setState('off');
    setStatus(
      err && err.name === 'NotAllowedError'
        ? 'Permiso de micrófono denegado. Actívalo en Ajustes › Safari › Micrófono y vuelve a intentar.'
        : 'No se pudo activar el audio: ' + (err && err.message ? err.message : err)
    );
  }
}

// ---------- Recepción de audio ----------
function onChunk(e) {
  const { frame, data, peak } = e.data;
  ui.meter.style.width = Math.min(100, Math.round(Math.sqrt(peak) * 100)) + '%';

  if (state === 'recording' || state === 'finishing') {
    chunks.push({ frame, data });
    const last = frame + data.length;
    if (state === 'recording' && last - startFrame >= MAX_SECONDS * sr) {
      closeLoop();
      setStatus(`Se alcanzó el máximo de ${MAX_SECONDS} s; el loop se cerró automáticamente.`);
    }
    if (state === 'finishing' && last >= endFrame) buildLoop();
  } else if (state === 'ready') {
    // Guardamos un poco de audio previo por si la compensación de latencia lo necesita.
    chunks.push({ frame, data });
    const oldest = frame - PREROLL_SECONDS * sr;
    while (chunks.length && chunks[0].frame + chunks[0].data.length < oldest) chunks.shift();
  }
}

// ---------- Acciones ----------
function startRecording() {
  if (ctx.state !== 'running') ctx.resume();
  // El sonido que tocas ahora llega al programa un poco después (latencia),
  // así que el loop empieza en "ahora + latencia".
  startFrame = nowFrame() + latencyFrames() - Math.round(0.005 * sr);
  setState('recording');
}

function closeLoop() {
  const t = ctx.currentTime;
  const end = Math.round(t * sr) + latencyFrames();
  if ((end - startFrame) / sr < MIN_SECONDS) return; // toque demasiado rápido: ignorar
  endFrame = end;
  loopOrigin = t; // el loop "vuelve a empezar" justo en este momento
  setState('finishing');
  const last = chunks.length ? chunks[chunks.length - 1] : null;
  if (last && last.frame + last.data.length >= endFrame) buildLoop();
}

function buildLoop() {
  const len = endFrame - startFrame;
  const out = new Float32Array(len);
  for (const c of chunks) {
    const s = Math.max(c.frame, startFrame);
    const e = Math.min(c.frame + c.data.length, endFrame);
    if (e > s) out.set(c.data.subarray(s - c.frame, e - c.frame), s - startFrame);
  }
  chunks = [];

  const fade = Math.min(Math.round((FADE_MS / 1000) * sr), Math.floor(len / 4));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] *= g;
    out[len - 1 - i] *= g;
  }

  loopBuffer = ctx.createBuffer(1, len, sr);
  loopBuffer.copyToChannel(out, 0);
  playLoop(true);
  setState('playing');
}

function playLoop(alignToOrigin) {
  stopLoop();
  const dur = loopBuffer.duration;
  const when = ctx.currentTime + 0.005;
  let offset = 0;
  if (alignToOrigin) {
    // El audio terminó de llegar unos milisegundos después de "Cerrar loop";
    // arrancamos en la posición correcta para que siga en tiempo.
    offset = (((when - loopOrigin) % dur) + dur) % dur;
  }
  source = ctx.createBufferSource();
  source.buffer = loopBuffer;
  source.loop = true;
  source.connect(ctx.destination);
  source.start(when, offset);
  loopOrigin = when - offset;
}

function stopLoop() {
  if (source) {
    try { source.stop(); } catch { /* ya estaba detenido */ }
    source.disconnect();
    source = null;
  }
}

function togglePause() {
  if (state === 'playing') {
    stopLoop();
    setState('paused');
  } else if (state === 'paused') {
    if (ctx.state !== 'running') ctx.resume();
    playLoop(false);
    setState('playing');
  }
}

function clearLoop() {
  if (!(state === 'recording' || state === 'playing' || state === 'paused')) return;
  stopLoop();
  loopBuffer = null;
  chunks = [];
  setState('ready');
  setStatus('Loop borrado. Listo para grabar otro.');
}

// Un solo botón: grabar → cerrar loop → pausar ⇄ reproducir
function mainAction() {
  if (state === 'ready') startRecording();
  else if (state === 'recording') closeLoop();
  else if (state === 'playing' || state === 'paused') togglePause();
}

// ---------- Botón gigante + deslizar para borrar ----------
// La acción ocurre en cuanto el dedo toca la pantalla (más preciso para el tiempo).
// Si después el dedo se desliza más de SWIPE_PX hacia cualquier lado, se borra el loop.
// La activación inicial usa "click" porque iOS lo exige para el audio.
const SWIPE_PX = 70;
let drag = null; // { id, x, y }

ui.main.addEventListener('pointerdown', (e) => {
  if (state === 'off' || state === 'finishing') return;
  e.preventDefault();
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  try { ui.main.setPointerCapture(e.pointerId); } catch { /* ignorar */ }
  ui.main.classList.add('dragging');
  mainAction();
});

ui.main.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  const dist = Math.hypot(dx, dy);
  ui.main.style.transform = `translate(${dx}px, ${dy}px)`;
  ui.main.style.opacity = String(Math.max(0.3, 1 - dist / (SWIPE_PX * 3)));
  if (dist >= SWIPE_PX) {
    drag = null;
    ui.main.classList.remove('dragging');
    // Sale volando en la dirección del deslizamiento y regresa al centro.
    ui.main.style.transform = `translate(${dx * 4}px, ${dy * 4}px)`;
    ui.main.style.opacity = '0';
    clearLoop();
    setTimeout(resetButtonPosition, 200);
  }
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  ui.main.classList.remove('dragging');
  resetButtonPosition();
}
ui.main.addEventListener('pointerup', endDrag);
ui.main.addEventListener('pointercancel', endDrag);

function resetButtonPosition() {
  ui.main.style.transform = '';
  ui.main.style.opacity = '';
}

ui.main.addEventListener('click', () => { if (state === 'off') activate(); });

// Pedal Bluetooth o teclado
document.addEventListener('keydown', (e) => {
  if (e.repeat || e.target === ui.latency) return;
  const k = e.key;
  if (k === ' ' || k === 'Enter' || k === 'ArrowDown' || k === 'PageDown' || k === 'ArrowRight') {
    e.preventDefault();
    if (state === 'off') activate(); else mainAction();
  } else if (k === 'ArrowUp' || k === 'PageUp' || k === 'ArrowLeft' || k === 'Delete' || k === 'Backspace') {
    e.preventDefault(); clearLoop();
  }
});

// Al volver a la app (por ejemplo, tras una llamada), reactivamos el audio.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ctx) {
    if (ctx.state !== 'running') ctx.resume();
    keepScreenOn();
  }
});

// ---------- Reloj en pantalla ----------
function tick() {
  if (ctx) {
    if (state === 'recording' || state === 'finishing') {
      const secs = Math.max(0, (nowFrame() + latencyFrames() - startFrame) / sr);
      ui.time.textContent = secs.toFixed(1) + ' s';
    } else if ((state === 'playing' || state === 'paused') && loopBuffer) {
      const dur = loopBuffer.duration;
      const pos = state === 'playing' ? (((ctx.currentTime - loopOrigin) % dur) + dur) % dur : 0;
      ui.time.textContent = `${pos.toFixed(1)} / ${dur.toFixed(1)} s`;
    } else {
      ui.time.textContent = '0.0 s';
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
setState('off');
setStatus('Conecta tu iRig y toca «Activar micrófono».');
