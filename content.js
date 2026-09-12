// content.js — bridge between the popup and the page-world pitch shifter.
//
// injected.js runs directly in the page's MAIN world via Manifest V3 so Web Audio
// can operate on the page's own media elements. This isolated content script
// relays messages between the popup and injected.js via window.postMessage.

const api = typeof browser !== "undefined" ? browser : chrome;
const workletUrls = {
  wsola: api.runtime.getURL("soundtouch-worklet.js"),
  phase: api.runtime.getURL("phase-vocoder-worklet.js"),
};

function sendWorkletUrls() {
  window.postMessage(
    { source: "pitchshifter-cs", type: "initWorklets", urls: workletUrls },
    "*"
  );
}

// Page-world code cannot call WebExtension APIs, so this isolated bridge gives
// it the packaged URL that AudioWorklet.addModule() needs.
sendWorkletUrls();

// Last known state reported by the page world, so the popup can read it
// instantly. Activation deliberately lives in this tab/document only: saved
// control values are presets and are never auto-applied to other tabs.
let cachedState = {
  hasMedia: false,
  enabled: false,
  pitch: 0,
  micro: 0,
  speed: 1,
  reverb: 0,
  reverbMode: "simple",
  reverbSize: 1,
  reverbDecay: 2.8,
  reverbTone: 0.55,
  reverbPreDelay: 0.016,
};

// --- Page world -> content ----------------------------------------------------
window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.source !== "pitchshifter-page") return;

  if (d.type === "state") {
    cachedState = {
      hasMedia: d.hasMedia,
      enabled: d.enabled,
      pitch: d.pitch,
      micro: d.micro,
      speed: d.speed,
      reverb: d.reverb,
      reverbMode: d.reverbMode,
      reverbSize: d.reverbSize,
      reverbDecay: d.reverbDecay,
      reverbTone: d.reverbTone,
      reverbPreDelay: d.reverbPreDelay,
    };
    // Push live to the popup if it happens to be open (frames with media can
    // report here even when the top frame has none, e.g. embedded players).
    api.runtime.sendMessage({ type: "stateUpdate", ...cachedState }).catch(() => {});
  }
});

// --- Popup -> content ---------------------------------------------------------
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "getState") {
    // Ask the page world to re-broadcast (covers media added after load and
    // lets iframe frames report via stateUpdate), then answer with the cache.
    sendWorkletUrls();
    window.postMessage({ source: "pitchshifter-cs", type: "getState" }, "*");
    sendResponse(cachedState);
    return true;
  }

  if (msg.type === "setPitch") {
    cachedState.enabled = msg.enabled !== false;
    cachedState.pitch = msg.pitch;
    cachedState.micro = msg.micro;
    cachedState.speed = msg.speed;
    cachedState.reverb = msg.reverb;
    cachedState.reverbMode = msg.reverbMode;
    cachedState.reverbSize = msg.reverbSize;
    cachedState.reverbDecay = msg.reverbDecay;
    cachedState.reverbTone = msg.reverbTone;
    cachedState.reverbPreDelay = msg.reverbPreDelay;
    sendWorkletUrls();
    window.postMessage(
      {
        source: "pitchshifter-cs",
        type: "setPitch",
        enabled: cachedState.enabled,
        pitch: msg.pitch,
        micro: msg.micro,
        speed: msg.speed,
        reverb: msg.reverb,
        reverbMode: msg.reverbMode,
        reverbSize: msg.reverbSize,
        reverbDecay: msg.reverbDecay,
        reverbTone: msg.reverbTone,
        reverbPreDelay: msg.reverbPreDelay,
      },
      "*"
    );
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "setEnabled") {
    cachedState.enabled = !!msg.enabled;
    cachedState.pitch = msg.pitch;
    cachedState.micro = msg.micro;
    cachedState.speed = msg.speed;
    cachedState.reverb = msg.reverb;
    cachedState.reverbMode = msg.reverbMode;
    cachedState.reverbSize = msg.reverbSize;
    cachedState.reverbDecay = msg.reverbDecay;
    cachedState.reverbTone = msg.reverbTone;
    cachedState.reverbPreDelay = msg.reverbPreDelay;
    sendWorkletUrls();
    window.postMessage(
      {
        source: "pitchshifter-cs",
        type: "setEnabled",
        enabled: cachedState.enabled,
        pitch: msg.pitch,
        micro: msg.micro,
        speed: msg.speed,
        reverb: msg.reverb,
        reverbMode: msg.reverbMode,
        reverbSize: msg.reverbSize,
        reverbDecay: msg.reverbDecay,
        reverbTone: msg.reverbTone,
        reverbPreDelay: msg.reverbPreDelay,
      },
      "*"
    );
    sendResponse({ ok: true });
    return true;
  }
});
