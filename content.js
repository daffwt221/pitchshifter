// content.js — bridge between the popup and the page-world pitch shifter.
//
// Why a page-world script? Web Audio's createMediaElementSource() must operate
// on the page's own media elements. Doing that from the isolated content-script
// world is unreliable in Firefox (Xray wrappers), so we inject injected.js into
// the page's main world and talk to it via window.postMessage.

const api = typeof browser !== "undefined" ? browser : chrome;

// Last known state reported by the page world, so the popup can read it instantly.
let cachedState = { hasMedia: false, pitch: 0, micro: 0 };

// --- Inject the page-world script ---------------------------------------------
function inject() {
  try {
    const s = document.createElement("script");
    s.src = api.runtime.getURL("injected.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    /* some documents (e.g. XML) may reject injection — ignore */
  }
}
inject();

// --- Page world -> content ----------------------------------------------------
window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.source !== "pitchshifter-page") return;

  if (d.type === "state") {
    cachedState = { hasMedia: d.hasMedia, pitch: d.pitch, micro: d.micro };
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
    window.postMessage({ source: "pitchshifter-cs", type: "getState" }, "*");
    sendResponse(cachedState);
    return true;
  }

  if (msg.type === "setPitch") {
    cachedState.pitch = msg.pitch;
    cachedState.micro = msg.micro;
    window.postMessage(
      { source: "pitchshifter-cs", type: "setPitch", pitch: msg.pitch, micro: msg.micro },
      "*"
    );
    sendResponse({ ok: true });
    return true;
  }
});
