# PitchShifter

Shifts the pitch of any video or audio on a page in real time, without changing the playback speed. For Firefox and Zen Browser. Inspired by [transpose.video](https://transpose.video/).

## Controls

Click the toolbar icon to open the popup.

| Control | Range | Step |
| --- | --- | --- |
| Pitch | -12 to +12 | 1 semitone |
| Microtones | -1.00 to +1.00 | 0.01 |
| Speed | 25% to 200% | 5% |

Pitch shift is `(pitch + microtones) / 12` octaves and does not change tempo. Speed changes tempo while keeping the pitch (browser time-stretch). Each control has a slider, -/+ buttons, and its own reset button. A status line shows whether media was detected on the page.

## Install

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on".
3. Select `manifest.json` in this folder.

Temporary add-ons are removed on browser restart. To keep it installed, package and sign with [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) via [addons.mozilla.org](https://addons.mozilla.org/).

## How it works

- `content.js` injects `injected.js` into the page's main world and relays messages between the popup and the page.
- `injected.js` captures each media element with the Web Audio API and routes it through a phase-vocoder pitch shifter (STFT, smbPitchShift by Stephan M. Bernsee) running in an AudioWorklet. It transposes without changing tempo. At pitch 0 it uses a clean dry path, so the audio is untouched until you move a slider. If a page's CSP blocks the worklet, it falls back to a delay-line shifter (Jungle, by Chris Wilson).
- Speed is applied as the element's `playbackRate` with `preservesPitch` on, so tempo changes but pitch stays put.
- The popup reads and writes state through the content script.

## Limitations

- Cross-origin media without CORS headers can't be read by the Web Audio API, so pitch can't be shifted on it (speed still works).
- The pitch shifter adds latency (~20 ms) and very large shifts add mild artifacts, as expected for real-time processing.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V2, popup and content script on all frames. |
| `popup/` | Popup UI (`popup.html`, `popup.css`, `popup.js`). |
| `content.js` | Bridge between popup and page. |
| `injected.js` | Web Audio pitch-shift engine. |
| `icons/icon.svg` | Toolbar icon. |
