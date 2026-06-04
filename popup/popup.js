// popup.js — UI logic. Reads/sets pitch state in the active tab's content script.
const api = typeof browser !== "undefined" ? browser : chrome;

const pitchSlider = document.getElementById("pitchSlider");
const microSlider = document.getElementById("microSlider");
const pitchValue = document.getElementById("pitchValue");
const microValue = document.getElementById("microValue");
const statusEl = document.getElementById("status");

let tabId = null;
let pitch = 0; // integer semitones, -12..12
let micro = 0; // fine, -1.00..1.00

const clampPitch = (v) => Math.max(-12, Math.min(12, Math.round(v)));
const clampMicro = (v) => Math.max(-1, Math.min(1, Math.round(v * 100) / 100));

function render() {
  pitchSlider.value = String(pitch);
  microSlider.value = String(micro);
  pitchValue.textContent = (pitch > 0 ? "+" : "") + pitch;
  microValue.textContent = (micro > 0 ? "+" : "") + micro.toFixed(2);
}

function push() {
  if (tabId == null) return;
  api.tabs.sendMessage(tabId, { type: "setPitch", pitch, micro }).catch(() => {});
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

pitchSlider.addEventListener("input", (e) => setPitch(parseFloat(e.target.value)));
microSlider.addEventListener("input", (e) => setMicro(parseFloat(e.target.value)));
document.getElementById("pitchMinus").addEventListener("click", () => setPitch(pitch - 1));
document.getElementById("pitchPlus").addEventListener("click", () => setPitch(pitch + 1));
document.getElementById("microMinus").addEventListener("click", () => setMicro(micro - 0.01));
document.getElementById("microPlus").addEventListener("click", () => setMicro(micro + 0.01));
document.getElementById("reset").addEventListener("click", () => {
  pitch = 0;
  micro = 0;
  render();
  push();
});

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
