// popup.js — UI logic. Reads/sets pitch, microtones and speed in the active tab.
const api = typeof browser !== "undefined" ? browser : chrome;

const pitchSlider = document.getElementById("pitchSlider");
const microSlider = document.getElementById("microSlider");
const speedSlider = document.getElementById("speedSlider");
const pitchValue = document.getElementById("pitchValue");
const microValue = document.getElementById("microValue");
const speedValue = document.getElementById("speedValue");
const statusEl = document.getElementById("status");

let tabId = null;
let pitch = 0; // integer semitones, -12..12
let micro = 0; // fine, -1.00..1.00
let speed = 1; // playback rate, 0.25..2.00

const clampPitch = (v) => Math.max(-12, Math.min(12, Math.round(v)));
const clampMicro = (v) => Math.max(-1, Math.min(1, Math.round(v * 100) / 100));
const clampSpeed = (v) => Math.max(0.25, Math.min(2, Math.round(v * 100) / 100));

// Pull the slider colors from the active theme's CSS tokens so the fill
// matches light/dark automatically.
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const TRACK = cssVar("--track") || "#e4e6e8";
const FILL = cssVar("--accent") || "#c2820f";

// Fill the slider from its neutral point (center) to the thumb, so the bar
// shows how far each control is pushed from its default.
function fillSlider(el, value, min, max, center) {
  const pct = (v) => ((v - min) / (max - min)) * 100;
  let a = pct(center), b = pct(value);
  if (a > b) [a, b] = [b, a];
  el.style.background =
    `linear-gradient(to right, ${TRACK} 0 ${a}%, ${FILL} ${a}% ${b}%, ${TRACK} ${b}% 100%)`;
}

function render() {
  pitchSlider.value = String(pitch);
  microSlider.value = String(micro);
  speedSlider.value = String(speed);
  pitchValue.textContent = (pitch > 0 ? "+" : "") + pitch;
  microValue.textContent = (micro > 0 ? "+" : "") + micro.toFixed(2);
  speedValue.textContent = Math.round(speed * 100) + "%";
  fillSlider(pitchSlider, pitch, -12, 12, 0);
  fillSlider(microSlider, micro, -1, 1, 0);
  fillSlider(speedSlider, speed, 0.25, 2, 1);
}

function push() {
  if (tabId == null) return;
  api.tabs.sendMessage(tabId, { type: "setPitch", pitch, micro, speed }).catch(() => {});
  api.storage.local.set({ settings: { pitch, micro, speed } }).catch(() => {});
}

function setPitch(v) {
  pitch = clampPitch(v);
  render();
  push();
}

function setMicro(v) {
  micro = clampMicro(v);
  render();
  push();
}

function setSpeed(v) {
  speed = clampSpeed(v);
  render();
  push();
}

pitchSlider.addEventListener("input", (e) => setPitch(parseFloat(e.target.value)));
microSlider.addEventListener("input", (e) => setMicro(parseFloat(e.target.value)));
speedSlider.addEventListener("input", (e) => setSpeed(parseFloat(e.target.value)));

document.getElementById("pitchMinus").addEventListener("click", () => setPitch(pitch - 1));
document.getElementById("pitchPlus").addEventListener("click", () => setPitch(pitch + 1));
document.getElementById("microMinus").addEventListener("click", () => setMicro(micro - 0.01));
document.getElementById("microPlus").addEventListener("click", () => setMicro(micro + 0.01));
document.getElementById("speedMinus").addEventListener("click", () => setSpeed(speed - 0.01));
document.getElementById("speedPlus").addEventListener("click", () => setSpeed(speed + 0.01));

document.getElementById("pitchReset").addEventListener("click", () => setPitch(0));
document.getElementById("microReset").addEventListener("click", () => setMicro(0));
document.getElementById("speedReset").addEventListener("click", () => setSpeed(1));

function setStatus(hasMedia) {
  if (hasMedia) {
    statusEl.textContent = "● Media detected";
    statusEl.classList.add("ok");
    statusEl.classList.remove("warn");
  } else {
    statusEl.textContent = "○ No media detected on this page";
    statusEl.classList.add("warn");
    statusEl.classList.remove("ok");
  }
}

// Live updates pushed from any frame (covers media inside iframes/embeds).
api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "stateUpdate" && msg.hasMedia) setStatus(true);
});

async function init() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0]) {
    setStatus(false);
    return;
  }
  tabId = tabs[0].id;
  try {
    const state = await api.tabs.sendMessage(tabId, { type: "getState" });
    if (state) {
      pitch = clampPitch(state.pitch || 0);
      micro = clampMicro(state.micro || 0);
      speed = clampSpeed(state.speed || 1);
      render();
      setStatus(!!state.hasMedia);
    } else {
      render();
      setStatus(false);
    }
  } catch (e) {
    // No content script here (e.g. about:, addons page, PDF viewer).
    render();
    statusEl.textContent = "○ Not available on this page";
    statusEl.classList.add("warn");
  }
}

render();
init();
