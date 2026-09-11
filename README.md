# PitchShifter

Shifts the pitch of any video or audio on a page in real time, without changing the playback speed. For Firefox.

<p>
  <img src="screenshots/popup-light.png" alt="PitchShifter popup, light theme" width="270" />
  <img src="screenshots/popup-dark.png" alt="PitchShifter popup, dark theme" width="270" />
</p>

🦊 https://addons.mozilla.org/en-US/firefox/addon/pitchshifter/ 🦊

## Features

- Real-time pitch shifting that keeps tempo, plus independent speed control that keeps pitch.
- Time-domain engine (SoundTouch / WSOLA) — none of the metallic "phasiness" of FFT pitch shifters.
- Works on supported HTML5 media, including pages with strict CSP (YouTube, etc.) and detached media elements used by players such as Spotify Web.
- Zero added latency when neutral: at pitch 0 the audio goes straight through, as if the effect were off.
- Settings are remembered across page reloads.
- Clean control-panel UI that follows your light/dark browser theme.

## Controls

Click the toolbar icon to open the popup.

| Control | Range | Step |
| --- | --- | --- |
| Pitch | -12 to +12 | 1 semitone |
| Microtones | -1.00 to +1.00 | 0.01 |
| Speed | 25% to 200% | 1% |

Pitch shift is `(pitch + microtones) / 12` octaves and does not change tempo. Speed changes tempo while keeping the pitch (browser time-stretch). Each control has a slider, -/+ buttons, and its own reset button. A status line shows whether media was detected on the page. Settings persist and are reapplied to each page you open.

## Install

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on".
3. Select `manifest.json` in this folder.

Temporary add-ons are removed on browser restart. To keep it installed, package and sign with [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) via [addons.mozilla.org](https://addons.mozilla.org/).

## How it works

- `injected.js` runs directly in the page's main world via Manifest V3; `content.js` relays messages between the popup and the page.
- `injected.js` captures each media element with the Web Audio API and routes it through SoundTouch, a time-domain pitch shifter (WSOLA time-stretch + resampling). Because it works in the time domain it avoids the metallic artifacts of FFT phase vocoders.
- The shifter runs in a `ScriptProcessorNode`, not an AudioWorklet. AudioWorklet modules load from a URL, which page CSPs (YouTube, etc.) can block; `ScriptProcessorNode` runs inline and avoids that dependency. It is deprecated but fully supported in Firefox.
- At pitch 0, the element is wired straight to the output and the shifter is taken out of the path entirely — no buffering, no latency. The shifter (and its small latency) is inserted only while you are actually pitch-shifting.
- Speed is applied as the element's `playbackRate` with `preservesPitch` on, so tempo changes but pitch stays put.
- The popup reads and writes state through the content script and saves it to `storage.local`; the content script reapplies the saved settings on each page load.

## Limitations

- Cross-origin media without CORS headers can't be read by the Web Audio API, so pitch can't be shifted on it (speed still works).
- While pitch is active, SoundTouch buffers a cushion of audio, so pitched output starts ~0.2 s after you first move the slider. Very large shifts add mild artifacts, as expected for real-time processing. (At pitch 0 there is no added latency.)

## Credits

- Pitch engine: [SoundTouch JS](https://github.com/cutterbl/SoundTouchJS) by Olli Parviainen et al., GNU LGPL-2.1. The DSP classes are vendored into `injected.js` with the license header intact.
- UI typeface: [IBM Plex Sans](https://github.com/IBM/plex), SIL Open Font License 1.1 (see `popup/fonts/OFL.txt`). Bundled as a latin subset.

## License

Copyright (c) 2026 daffwt221. All rights reserved (see [LICENSE](LICENSE)). Bundled components keep their own licenses: SoundTouch JS (LGPL-2.1) and IBM Plex Sans (SIL OFL-1.1) — see Credits.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3; `storage`; popup plus isolated/page-world content scripts on all frames. |
| `popup/` | Popup UI (`popup.html`, `popup.css`, `popup.js`) and bundled font in `popup/fonts/`. |
| `content.js` | Bridge between popup and page; loads/saves persisted settings. |
| `injected.js` | Page-world Web Audio engine (SoundTouch shifter + routing). |
| `icons/icon.svg` | Toolbar icon / logo. |
