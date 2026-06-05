# PitchShifter

Shifts the pitch of any video or audio on a page in real time, without changing the playback speed. For Firefox and Zen Browser. Inspired by [transpose.video](https://transpose.video/).

## Controls

Click the toolbar icon to open the popup.

| Control | Range | Step |
| --- | --- | --- |
| Pitch | -12 to +12 | 1 semitone |
| Microtones | -1.00 to +1.00 | 0.01 |
| Speed | 25% to 200% | 1% |

Pitch shift is `(pitch + microtones) / 12` octaves and does not change tempo. Speed changes tempo while keeping the pitch (browser time-stretch). Each control has a slider, -/+ buttons, and its own reset button. A status line shows whether media was detected on the page.

## Install

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on".
3. Select `manifest.json` in this folder.

Temporary add-ons are removed on browser restart. To keep it installed, package and sign with [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) via [addons.mozilla.org](https://addons.mozilla.org/).

## How it works

- `content.js` injects `injected.js` into the page's main world and relays messages between the popup and the page.
- `injected.js` captures each media element with the Web Audio API and routes it through SoundTouch, a time-domain pitch shifter (WSOLA time-stretch + resampling). Because it works in the time domain it avoids the "phasiness" / metallic artifacts of FFT phase vocoders. It transposes without changing tempo. At pitch 0 the shifter passes audio through untouched.
- The shifter runs in a `ScriptProcessorNode`, not an AudioWorklet. AudioWorklet modules load from a URL, which page CSPs (YouTube, etc.) routinely block; `ScriptProcessorNode` runs inline and is immune to that, so it works everywhere. It is deprecated but fully supported in Firefox.
- Speed is applied as the element's `playbackRate` with `preservesPitch` on, so tempo changes but pitch stays put.
- The popup reads and writes state through the content script.

## Limitations

- Cross-origin media without CORS headers can't be read by the Web Audio API, so pitch can't be shifted on it (speed still works).
- SoundTouch buffers a cushion of audio, so pitched output starts ~0.2 s after you first move the pitch slider. Very large shifts add mild artifacts, as expected for real-time processing.

## Credits

- Pitch engine: [SoundTouch JS](https://github.com/cutterbl/SoundTouchJS) by Olli Parviainen et al., GNU LGPL-2.1. The DSP classes are vendored into `injected.js` with the license header intact.
- UI typeface: [IBM Plex Sans](https://github.com/IBM/plex), SIL Open Font License 1.1 (see `popup/fonts/OFL.txt`). Bundled as a latin subset.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V2, popup and content script on all frames. |
| `popup/` | Popup UI (`popup.html`, `popup.css`, `popup.js`). |
| `content.js` | Bridge between popup and page. |
| `injected.js` | Web Audio pitch-shift engine. |
| `icons/icon.svg` | Toolbar icon. |
