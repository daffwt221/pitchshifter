// content.js — bridge between the popup and the page-world pitch shifter.
//
// injected.js runs directly in the page's MAIN world via Manifest V3 so Web Audio
// can operate on the page's own media elements. This isolated content script
// relays messages between the popup and injected.js via window.postMessage.

const api = typeof browser !== "undefined" ? browser : chrome;

// Last known state reported by the page world, so the popup can read it instantly.
let cachedState = { hasMedia: false, pitch: 0, micro: 0, speed: 1 };

// Persisted settings (global). Reapplied to each page once the injector is up,
// so a reload doesn't lose your pitch/speed.
let stored = null;
let storedLoaded = false;
let appliedStored = false;

api.storage.local
  .get("settings")
  .then((r) => {
    stored = r && r.settings ? r.settings : null;
    storedLoaded = true;
    // Nudge the page world to broadcast state so we can apply the stored values.
    window.postMessage({ source: "pitchshifter-cs", type: "getState" }, "*");
  })
  .catch(() => {});

function maybeApplyStored() {
  if (appliedStored || !storedLoaded) return;
  appliedStored = true;
  if (!stored) return;
  const pitch = Number(stored.pitch) || 0;
  const micro = Number(stored.micro) || 0;
  const speed = Number(stored.speed) || 1;
  if (pitch === 0 && micro === 0 && speed === 1) return; // nothing to apply
  cachedState.pitch = pitch;
  cachedState.micro = micro;
  cachedState.speed = speed;
  window.postMessage({ source: "pitchshifter-cs", type: "setPitch", pitch, micro, speed }, "*");
}

// --- Page world -> content ----------------------------------------------------
window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.source !== "pitchshifter-page") return;

  if (d.type === "state") {
    cachedState = { hasMedia: d.hasMedia, pitch: d.pitch, micro: d.micro, speed: d.speed };
    // Push live to the popup if it happens to be open (frames with media can
    // report here even when the top frame has none, e.g. embedded players).
    api.runtime.sendMessage({ type: "stateUpdate", ...cachedState }).catch(() => {});
    maybeApplyStored();
  }
});

// --- Popup -> content ---------------------------------------------------------
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "getState") {
    // Ask the page world to re-broadcast (covers media added after load and
    // lets iframe frames report via stateUpdate), then answer with the cache.
    window.postMessage({ source: "pitchshifter-cs", type: "getState" }, "*");
    sendResponse(cachedState);
    return true;
  }

  if (msg.type === "setPitch") {
    cachedState.pitch = msg.pitch;
    cachedState.micro = msg.micro;
    cachedState.speed = msg.speed;
    window.postMessage(
      { source: "pitchshifter-cs", type: "setPitch", pitch: msg.pitch, micro: msg.micro, speed: msg.speed },
      "*"
    );
    sendResponse({ ok: true });
    return true;
  }
});
