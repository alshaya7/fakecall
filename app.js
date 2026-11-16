// FakeCall — app logic. Vanilla ES module, no dependencies.
//
// Flow: home --tap "Call me"--> armed (black screen) --delay--> incoming --accept--> in call --end--> home
//
// Everything iOS needs a user gesture for (audio, wake lock, keep-awake video)
// is started synchronously inside the "Call me" tap handler: see arm().

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

// The caller name is fixed on purpose and is not editable in the UI.
const CALLER_NAME = "صالح الشايع";
const CALLER_INITIAL = "ص"; // first letter of the name, used for the avatar fallback

const RINGTONES = [
  { id: "chime", label: "Chime", url: "assets/ringtones/chime.wav" },
  { id: "bell", label: "Classic bell", url: "assets/ringtones/bell.wav" },
  { id: "pulse", label: "Pulse", url: "assets/ringtones/pulse.wav" },
];

const KEYS = {
  settings: "fakecall.settings",
  photo: "fakecall.photo",
  voice: "fakecall.voice",
  hintDismissed: "fakecall.installHintDismissed",
};

const DEFAULTS = { subtitle: "mobile", ringtone: "chime", style: "buttons", delay: 10 };

const RING_VOLUME = 1;
const VOICE_DELAY_S = 1; // voice clip starts this long after answering
const VOICE_VOLUME_EARPIECE = 0.35; // "speaker off": quieter, as if from the earpiece
const VOICE_VOLUME_SPEAKER = 1;
const MAX_RECORDING_S = 60;
const PHOTO_MAX_PX = 640;

const BACKGROUND_NOTICE =
  "The call was cancelled because FakeCall left the foreground. Keep the app open and in front while you wait.";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** localStorage wrapper: it can throw (private mode, quota), so every call is guarded. */
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  },
};

function formatClock(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToArrayBuffer(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const settings = { ...DEFAULTS, ...store.get(KEYS.settings, {}) };
let photo = store.get(KEYS.photo, null); // data URL or null
let voice = store.get(KEYS.voice, null); // { dataUrl, name } or null

/** "idle" | "armed" | "ringing" | "incall" */
let phase = "idle";
/** Bumped whenever a call starts or ends, so stale async work can tell it is out of date. */
let session = 0;

const call = {
  armedAt: 0, // performance.now() at the tap
  delayMs: 0,
  answeredAt: 0,
  voiceBuffer: null,
  countdownTimer: 0,
  clockTimer: 0,
  vibrateTimer: 0,
};

function saveSettings() {
  store.set(KEYS.settings, settings);
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

const screens = $$(".screen");

function showScreen(name) {
  for (const screen of screens) {
    const active = screen.dataset.screen === name;
    screen.classList.toggle("is-active", active);
    screen.inert = !active;
  }
}

/* ------------------------------------------------------------------ */
/* Caller visuals                                                      */
/* ------------------------------------------------------------------ */

/** Keep each caller name on one line, scaling the font down if it would overflow. */
function fitCallerNames() {
  for (const el of $$("[data-caller-name]")) {
    el.style.fontSize = "";
    const available = el.clientWidth;
    const needed = el.scrollWidth;
    if (available > 0 && needed > available) {
      const base = parseFloat(getComputedStyle(el).fontSize);
      el.style.fontSize = `${Math.max(base * 0.55, (base * available) / needed - 0.5)}px`;
    }
  }
}

function renderCaller() {
  for (const el of $$("[data-caller-name]")) el.textContent = CALLER_NAME;
  for (const el of $$("[data-caller-subtitle]")) el.textContent = settings.subtitle;

  for (const el of $$("[data-avatar]")) {
    el.replaceChildren();
    if (photo) {
      const img = new Image();
      img.alt = "";
      img.src = photo;
      el.append(img);
    } else {
      const initial = document.createElement("span");
      initial.lang = "ar";
      initial.textContent = CALLER_INITIAL;
      el.append(initial);
    }
  }

  for (const el of $$("[data-photo-bg]")) {
    el.style.backgroundImage = photo ? `url("${photo}")` : "";
    el.classList.toggle("has-photo", Boolean(photo));
  }

  $("#photo-remove").hidden = !photo;
  fitCallerNames();
}

/* ------------------------------------------------------------------ */
/* Notices                                                             */
/* ------------------------------------------------------------------ */

function showNotice(text) {
  $("#notice-text").textContent = text;
  $("#notice").hidden = false;
}

function hideNotice() {
  $("#notice").hidden = true;
}

/* ------------------------------------------------------------------ */
/* Audio engine (Web Audio)                                            */
/* ------------------------------------------------------------------ */
// iOS only lets audio start from a user gesture, and a delayed
// setTimeout(() => audio.play()) is often blocked. So the tap handler unlocks
// one AudioContext and the ringtone is *scheduled* on its clock with
// source.start(when). The same context plays the voice clip.

const audio = {
  ctx: null,
  ringGain: null, // HTMLMediaElement.volume is read-only on iOS, so loudness goes through GainNodes
  voiceGain: null,
  ringSource: null,
  voiceSource: null,
  keepAliveSource: null,
  ringtoneBytes: new Map(), // id -> Promise<ArrayBuffer>
  ringtoneBuffers: new Map(), // id -> AudioBuffer
  voiceBuffer: null, // decoded voice clip, cleared when the clip changes
};

/** "playback" makes sound ignore the ring/silent switch (iOS 16.4+). Feature-detected. */
function setAudioSessionType(type) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch {
    /* unsupported type: keep the default */
  }
}

/** Create (once) and resume the context. Must be called synchronously inside a user gesture. */
function unlockAudio() {
  setAudioSessionType("playback");
  if (!audio.ctx) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    audio.ctx = new Context();
    audio.ringGain = audio.ctx.createGain();
    audio.ringGain.gain.value = RING_VOLUME;
    audio.ringGain.connect(audio.ctx.destination);
    audio.voiceGain = audio.ctx.createGain();
    audio.voiceGain.gain.value = VOICE_VOLUME_EARPIECE;
    audio.voiceGain.connect(audio.ctx.destination);
    // iOS can move the context to "interrupted" or "suspended" (Siri, alarms, app switch).
    audio.ctx.addEventListener("statechange", resumeAudioIfNeeded);
  }
  audio.ctx.resume().catch(() => {});
  return audio.ctx;
}

function resumeAudioIfNeeded() {
  const { ctx } = audio;
  if (!ctx || phase === "idle" || document.visibilityState !== "visible") return;
  if (ctx.state !== "running") ctx.resume().catch(() => {});
}

/** A silent loop keeps the audio session active during the wait, so the scheduled ring is not dropped. */
function startKeepAlive() {
  const { ctx } = audio;
  if (!ctx || audio.keepAliveSource) return;
  const source = ctx.createBufferSource();
  source.buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); // one second of silence
  source.loop = true;
  source.connect(ctx.destination);
  source.start();
  audio.keepAliveSource = source;
}

function stopSource(key) {
  const source = audio[key];
  if (!source) return;
  audio[key] = null;
  try {
    source.stop();
  } catch {
    /* already stopped */
  }
  source.disconnect();
}

/** decodeAudioData with both the promise and the older callback signature. */
function decode(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const maybePromise = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (maybePromise?.catch) maybePromise.catch(reject);
  });
}

/** Fetch ringtone bytes ahead of time, so the tap handler only has to decode. */
function fetchRingtoneBytes(id) {
  if (!audio.ringtoneBytes.has(id)) {
    const { url } = RINGTONES.find((r) => r.id === id) ?? RINGTONES[0];
    const pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Ringtone failed to load (${response.status})`);
      return response.arrayBuffer();
    });
    pending.catch(() => audio.ringtoneBytes.delete(id)); // allow a retry later
    audio.ringtoneBytes.set(id, pending);
  }
  return audio.ringtoneBytes.get(id);
}

async function loadRingtoneBuffer(id) {
  if (!audio.ringtoneBuffers.has(id)) {
    const bytes = await fetchRingtoneBytes(id);
    // decodeAudioData detaches its input, so decode a copy.
    audio.ringtoneBuffers.set(id, await decode(audio.ctx, bytes.slice(0)));
  }
  return audio.ringtoneBuffers.get(id);
}

/** Decode the saved voice clip, or resolve to null if there is none or it cannot be decoded. */
async function loadVoiceBuffer() {
  if (!voice) return null;
  if (!audio.voiceBuffer) {
    try {
      audio.voiceBuffer = await decode(audio.ctx, dataUrlToArrayBuffer(voice.dataUrl));
    } catch {
      return null;
    }
  }
  return audio.voiceBuffer;
}

/** Schedule the looping ringtone on the audio clock, `delayMs` after the tap. */
function scheduleRing(buffer) {
  const { ctx } = audio;
  const remainingS = Math.max(0, (call.delayMs - (performance.now() - call.armedAt)) / 1000);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(audio.ringGain);
  source.start(ctx.currentTime + remainingS);
  audio.ringSource = source;
}

function playVoice(buffer) {
  const { ctx } = audio;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.voiceGain);
  source.start(ctx.currentTime + VOICE_DELAY_S);
  audio.voiceSource = source;
}

function stopAllAudio() {
  stopSource("ringSource");
  stopSource("voiceSource");
  stopSource("keepAliveSource");
  audio.ctx?.suspend().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Keeping the screen awake                                            */
/* ------------------------------------------------------------------ */
// Primary: Screen Wake Lock API. Fallback: a looping, silent, inline video,
// because the API is missing on older iOS and fails in Home Screen apps on
// some versions. The video is started inside the gesture and stopped again as
// soon as a real wake lock is granted.

const awake = { sentinel: null, wanted: false };
const keepAwakeVideo = $("#keepawake");

function startVideoFallback() {
  if (!keepAwakeVideo.src) return;
  keepAwakeVideo.play().catch(() => {});
}

function stopVideoFallback() {
  keepAwakeVideo.pause();
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || awake.sentinel) return;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    if (!awake.wanted) {
      sentinel.release().catch(() => {});
      return;
    }
    awake.sentinel = sentinel;
    sentinel.addEventListener("release", () => {
      if (awake.sentinel === sentinel) awake.sentinel = null;
    });
    stopVideoFallback();
  } catch {
    // Denied (low power mode, or the Home Screen bug): the video fallback keeps running.
  }
}

/** Call synchronously inside the tap handler. */
function keepScreenAwake() {
  awake.wanted = true;
  startVideoFallback();
  requestWakeLock();
}

function letScreenSleep() {
  awake.wanted = false;
  stopVideoFallback();
  awake.sentinel?.release().catch(() => {});
  awake.sentinel = null;
}

/** Load the fallback clip as a blob URL (works offline and avoids range requests through the service worker). */
async function prepareVideoFallback() {
  try {
    const response = await fetch("assets/keepawake.mp4");
    if (response.ok) keepAwakeVideo.src = URL.createObjectURL(await response.blob());
  } catch {
    /* fallback unavailable */
  }
}

/* ------------------------------------------------------------------ */
/* Vibration (not available on iOS: feature-detected and skipped)      */
/* ------------------------------------------------------------------ */

function startVibration() {
  if (typeof navigator.vibrate !== "function") return;
  const buzz = () => navigator.vibrate([700, 300, 700]);
  buzz();
  call.vibrateTimer = setInterval(buzz, 3000);
}

function stopVibration() {
  clearInterval(call.vibrateTimer);
  if (typeof navigator.vibrate === "function") navigator.vibrate(0);
}

/* ------------------------------------------------------------------ */
/* Call flow                                                           */
/* ------------------------------------------------------------------ */

/** "Call me" tap handler. Everything gesture-gated happens before the first await. */
async function arm() {
  if (phase !== "idle") return;
  const mySession = ++session;
  hideNotice();
  stopPreview();

  // --- synchronous, inside the user gesture ---
  const ctx = unlockAudio();
  startKeepAlive();
  keepScreenAwake();

  call.armedAt = performance.now();
  call.delayMs = settings.delay * 1000;
  call.voiceBuffer = null;

  if (call.delayMs === 0) {
    showIncoming();
  } else {
    phase = "armed";
    showScreen("armed");
    call.countdownTimer = setInterval(checkCountdown, 100);
  }

  // --- asynchronous: decode, then schedule on the audio clock ---
  if (!ctx) return;
  try {
    const [ringBuffer, voiceBuffer] = await Promise.all([loadRingtoneBuffer(settings.ringtone), loadVoiceBuffer()]);
    if (mySession !== session) return; // cancelled or finished while decoding
    call.voiceBuffer = voiceBuffer;
    if (phase === "armed" || phase === "ringing") scheduleRing(ringBuffer);
    else if (phase === "incall" && voiceBuffer) playVoice(voiceBuffer);
  } catch {
    // Ringtone unavailable: the call screen still appears, just silently.
  }
}

/** Driven by performance.now() deltas, so it stays right even if timers are throttled. */
function checkCountdown() {
  if (phase !== "armed") return;
  if (performance.now() - call.armedAt >= call.delayMs) showIncoming();
}

function showIncoming() {
  clearInterval(call.countdownTimer);
  phase = "ringing";
  $('[data-screen="incoming"]').dataset.style = settings.style;
  resetSlider();
  showScreen("incoming");
  resumeAudioIfNeeded();
  startVibration();
}

function answer() {
  if (phase !== "ringing") return;
  phase = "incall";
  stopSource("ringSource");
  stopVibration();

  for (const button of $$("[data-toggle]")) button.setAttribute("aria-pressed", "false");
  if (audio.voiceGain) audio.voiceGain.gain.value = VOICE_VOLUME_EARPIECE;

  call.answeredAt = performance.now();
  updateCallClock();
  call.clockTimer = setInterval(updateCallClock, 250);
  showScreen("incall");

  if (call.voiceBuffer) playVoice(call.voiceBuffer);
}

function updateCallClock() {
  $("#call-timer").textContent = formatClock((performance.now() - call.answeredAt) / 1000);
}

/** Decline, End, cancel and background-cancel all end here. Settings are untouched. */
function endCall() {
  session++;
  phase = "idle";
  clearInterval(call.countdownTimer);
  clearInterval(call.clockTimer);
  stopVibration();
  stopAllAudio();
  letScreenSleep();
  showScreen("home");
}

/* ------------------------------------------------------------------ */
/* Backgrounding                                                       */
/* ------------------------------------------------------------------ */

function onVisibilityChange() {
  if (document.visibilityState === "hidden") {
    // iOS freezes timers and audio in the background, so an armed call cannot fire.
    // Cancel it cleanly and explain when the user comes back.
    if (phase === "armed") {
      endCall();
      showNotice(BACKGROUND_NOTICE);
    }
    return;
  }
  // Visible again: wake locks are released automatically when hidden, so ask again.
  if (phase !== "idle") {
    requestWakeLock();
    resumeAudioIfNeeded();
  }
}

/* ------------------------------------------------------------------ */
/* Slide to answer                                                     */
/* ------------------------------------------------------------------ */

const slider = { track: $("#slide-track"), knob: $("#slide-knob"), label: $("#slide-label"), startX: 0, max: 0, x: 0, dragging: false };

function setKnob(x) {
  slider.x = x;
  slider.knob.style.transform = `translate3d(${x}px, 0, 0)`;
  slider.label.style.opacity = slider.max ? String(clamp(1 - x / (slider.max * 0.6), 0, 1)) : "";
}

function resetSlider() {
  slider.dragging = false;
  slider.max = 0;
  slider.knob.classList.remove("is-dragging");
  setKnob(0);
}

function initSlider() {
  const { knob, track } = slider;

  knob.addEventListener("pointerdown", (event) => {
    slider.dragging = true;
    slider.startX = event.clientX;
    slider.max = track.clientWidth - knob.offsetWidth - knob.offsetLeft * 2;
    knob.setPointerCapture(event.pointerId);
    knob.classList.add("is-dragging"); // no transition while following the finger
  });

  knob.addEventListener("pointermove", (event) => {
    if (slider.dragging) setKnob(clamp(event.clientX - slider.startX, 0, slider.max));
  });

  const release = () => {
    if (!slider.dragging) return;
    slider.dragging = false;
    knob.classList.remove("is-dragging");
    if (slider.max > 0 && slider.x >= slider.max * 0.85) {
      setKnob(slider.max);
      answer();
    } else {
      setKnob(0); // released early: the CSS transition springs it back
    }
  };
  knob.addEventListener("pointerup", release);
  knob.addEventListener("pointercancel", release);

  // Keyboard and assistive tech: activating the knob answers. (A drag ends in a
  // synthetic click too, which has event.detail > 0 and is ignored here.)
  knob.addEventListener("click", (event) => {
    if (event.detail === 0) answer();
  });
}

/* ------------------------------------------------------------------ */
/* Settings: previews                                                  */
/* ------------------------------------------------------------------ */

const previewPlayer = new Audio();
let previewButton = null;

function stopPreview() {
  previewPlayer.pause();
  if (previewButton) previewButton.textContent = previewButton.dataset.idleLabel;
  previewButton = null;
}

function togglePreview(button, src) {
  const wasPlaying = previewButton === button;
  stopPreview();
  if (wasPlaying) return;
  setAudioSessionType("playback");
  previewPlayer.src = src;
  previewPlayer.currentTime = 0;
  previewPlayer.play().catch(() => {});
  button.dataset.idleLabel = button.textContent;
  button.textContent = "Stop";
  previewButton = button;
}

previewPlayer.addEventListener("ended", stopPreview);

/* ------------------------------------------------------------------ */
/* Settings: photo                                                     */
/* ------------------------------------------------------------------ */

/** Downscale to a small JPEG so the data URL fits comfortably in localStorage. */
async function imageFileToDataUrl(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function onPhotoChosen(event) {
  const [file] = event.target.files;
  event.target.value = ""; // allow choosing the same file again
  if (!file) return;
  try {
    const dataUrl = await imageFileToDataUrl(file);
    if (!store.set(KEYS.photo, dataUrl)) throw new Error("storage full");
    photo = dataUrl;
    renderCaller();
  } catch {
    showNotice("That photo couldn't be saved. Try a different image.");
    closeSettings();
  }
}

function removePhoto() {
  photo = null;
  store.remove(KEYS.photo);
  renderCaller();
}

/* ------------------------------------------------------------------ */
/* Settings: voice clip (upload or record)                             */
/* ------------------------------------------------------------------ */

const recording = { recorder: null, stream: null, chunks: [], startedAt: 0, timer: 0 };

function renderVoice(message) {
  $("#voice-status").textContent = message ?? (voice ? `Plays about a second after you answer: ${voice.name}` : "No voice clip");
  $("#voice-play").hidden = !voice;
  $("#voice-remove").hidden = !voice;
}

function saveVoice(clip) {
  if (!store.set(KEYS.voice, clip)) {
    renderVoice("That clip is too large to save. Try a shorter one (about 2 MB at most).");
    return;
  }
  voice = clip;
  audio.voiceBuffer = null; // decode again next time
  renderVoice();
}

function removeVoice() {
  stopPreview();
  voice = null;
  audio.voiceBuffer = null;
  store.remove(KEYS.voice);
  renderVoice();
}

async function onVoiceChosen(event) {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  try {
    saveVoice({ dataUrl: await blobToDataUrl(file), name: file.name });
  } catch {
    renderVoice("That file couldn't be read.");
  }
}

function pickRecordingType() {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type));
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    renderVoice("Recording isn't supported in this browser. Upload an audio file instead.");
    return;
  }
  stopPreview();
  setAudioSessionType("play-and-record"); // "playback" would block the microphone on iOS
  try {
    recording.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setAudioSessionType("playback");
    renderVoice("Microphone access was blocked. Allow it in Settings, or upload a file.");
    return;
  }

  const mimeType = pickRecordingType();
  const recorder = new MediaRecorder(recording.stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
  recording.recorder = recorder;
  recording.chunks = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) recording.chunks.push(event.data);
  });
  recorder.addEventListener("stop", finishRecording);
  recorder.start();

  recording.startedAt = performance.now();
  const button = $("#voice-record");
  button.classList.add("is-recording");
  const tick = () => {
    const elapsed = (performance.now() - recording.startedAt) / 1000;
    button.textContent = `Stop ${formatClock(elapsed)}`;
    if (elapsed >= MAX_RECORDING_S) stopRecording();
  };
  tick();
  recording.timer = setInterval(tick, 250);
  renderVoice("Recording…");
}

function stopRecording() {
  if (recording.recorder?.state === "recording") recording.recorder.stop();
}

async function finishRecording() {
  clearInterval(recording.timer);
  const { recorder, chunks } = recording;
  recording.stream?.getTracks().forEach((track) => track.stop());
  recording.stream = null;
  recording.recorder = null;
  setAudioSessionType("playback");

  const button = $("#voice-record");
  button.classList.remove("is-recording");
  button.textContent = "Record";

  if (!chunks.length) {
    renderVoice("Nothing was recorded.");
    return;
  }
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/mp4" });
  saveVoice({ dataUrl: await blobToDataUrl(blob), name: "Recording" });
}

function toggleRecording() {
  if (recording.recorder) stopRecording();
  else startRecording();
}

/* ------------------------------------------------------------------ */
/* Settings sheet                                                      */
/* ------------------------------------------------------------------ */

const sheet = $("#settings");

function openSettings() {
  sheet.inert = false;
  sheet.classList.add("is-open");
  $("#sheet-backdrop").hidden = false;
  $("#app").inert = true;
  fitCallerNames();
  $("#close-settings").focus({ preventScroll: true });
}

function closeSettings() {
  stopPreview();
  stopRecording();
  sheet.inert = true;
  sheet.classList.remove("is-open");
  $("#sheet-backdrop").hidden = true;
  $("#app").inert = false;
  $("#open-settings").focus({ preventScroll: true });
}

function buildRingtoneOptions() {
  const container = $("#ringtone-options");
  for (const ringtone of RINGTONES) {
    const label = document.createElement("label");
    label.className = "option";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "ringtone";
    input.value = ringtone.id;

    const name = document.createElement("span");
    name.textContent = ringtone.label;

    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "button";
    preview.textContent = "Preview";
    preview.setAttribute("aria-label", `Preview ${ringtone.label} ringtone`);
    preview.addEventListener("click", (event) => {
      event.preventDefault(); // do not select the option
      togglePreview(preview, ringtone.url);
    });

    label.append(input, name, preview);
    container.append(label);
  }
}

/** Wire a radio group to one settings key. */
function bindRadios(name, key, parse = String, onChange = () => {}) {
  for (const input of $$(`input[name="${name}"]`)) {
    input.checked = parse(input.value) === settings[key];
    input.addEventListener("change", () => {
      settings[key] = parse(input.value);
      saveSettings();
      onChange();
    });
  }
}

function initSettings() {
  buildRingtoneOptions();
  bindRadios("delay", "delay", Number);
  bindRadios("ringtone", "ringtone", String, () => fetchRingtoneBytes(settings.ringtone).catch(() => {}));
  bindRadios("style", "style");

  const subtitle = $("#subtitle");
  subtitle.value = settings.subtitle;
  subtitle.addEventListener("input", () => {
    settings.subtitle = subtitle.value.trim();
    saveSettings();
    for (const el of $$("[data-caller-subtitle]")) el.textContent = settings.subtitle;
  });
  subtitle.addEventListener("keydown", (event) => {
    if (event.key === "Enter") subtitle.blur();
  });

  $("#open-settings").addEventListener("click", openSettings);
  $("#close-settings").addEventListener("click", closeSettings);
  $("#sheet-backdrop").addEventListener("click", closeSettings);

  $("#photo-input").addEventListener("change", onPhotoChosen);
  $("#photo-remove").addEventListener("click", removePhoto);

  $("#voice-input").addEventListener("change", onVoiceChosen);
  $("#voice-record").addEventListener("click", toggleRecording);
  $("#voice-play").addEventListener("click", (event) => togglePreview(event.currentTarget, voice.dataUrl));
  $("#voice-remove").addEventListener("click", removeVoice);
  renderVoice();
}

/* ------------------------------------------------------------------ */
/* Call screen controls                                                */
/* ------------------------------------------------------------------ */

function initCallControls() {
  $("#call-me").addEventListener("click", arm);
  $("#accept").addEventListener("click", answer);
  $("#decline").addEventListener("click", endCall);
  $("#end-call").addEventListener("click", endCall);
  initSlider();

  // Mute and Speaker toggle their look. Speaker also raises the voice clip from
  // "earpiece" level to full volume; Mute is visual only.
  for (const button of $$("[data-toggle]")) {
    button.addEventListener("click", () => {
      const pressed = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(pressed));
      if (button.dataset.toggle === "speaker" && audio.voiceGain) {
        audio.voiceGain.gain.value = pressed ? VOICE_VOLUME_SPEAKER : VOICE_VOLUME_EARPIECE;
      }
    });
  }

  // Armed screen: double-tap (or Escape) cancels without ringing.
  let lastTap = 0;
  $('[data-screen="armed"]').addEventListener("pointerup", () => {
    const now = performance.now();
    if (now - lastTap < 350) endCall();
    lastTap = now;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (phase === "armed") endCall();
    else if (sheet.classList.contains("is-open")) closeSettings();
  });
}

/* ------------------------------------------------------------------ */
/* Platform chrome                                                     */
/* ------------------------------------------------------------------ */

function isStandalone() {
  return navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
}

function initInstallHint() {
  const hint = $("#install-hint");
  hint.hidden = isStandalone() || store.get(KEYS.hintDismissed, false);
  $("#install-dismiss").addEventListener("click", () => {
    hint.hidden = true;
    store.set(KEYS.hintDismissed, true);
  });
}

function blockZoomGestures() {
  // Safari ignores user-scalable=no in a tab, so pinch-zoom is cancelled here as well.
  for (const type of ["gesturestart", "gesturechange"]) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }
  document.addEventListener("contextmenu", (event) => {
    if (!event.target.closest("input")) event.preventDefault();
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

function init() {
  initSettings();
  initCallControls();
  initInstallHint();
  blockZoomGestures();
  renderCaller();

  $("#notice-dismiss").addEventListener("click", hideNotice);
  $("#wake-notice").hidden = "wakeLock" in navigator;

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("resize", fitCallerNames);
  document.fonts?.ready.then(fitCallerNames);

  // Warm the caches so the tap handler has nothing to download.
  fetchRingtoneBytes(settings.ringtone).catch(() => {});
  prepareVideoFallback();
  registerServiceWorker();
}

init();
