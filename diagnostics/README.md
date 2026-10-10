# macOS audio investigation

The `macOS audio diagnostic` workflow compares unmodified historical add-ons
1.1.0, 1.1.1 and 1.1.3 on the standard `macos-26` ARM64 runner with Firefox
157.0.1. It runs on pushes to `diagnostic/macos-26-audio` and can also be
dispatched manually once registered by GitHub. Standard runners are free for
public repositories. It does not publish an extension release.

The Python script uses only the standard library and Firefox Marionette. It
creates an isolated profile and serves a generated 440 Hz tone on localhost.
It observes the extension's output using an AnalyserNode inserted immediately
before the destination. Production scripts and capture decisions are unchanged.
Settings are sent through the page message protocol; the actual packaged
content script supplies the worklet URLs. This exercises the audio path rather
than popup clicks.

Cases cover same-origin media, strict CSP, blob media, source selection after
activation, CORS-enabled media, and cross-origin media without CORS mode.
Pitch, microtones, speed compensation and the reverb tail are measured. The
unsafe cross-origin case is observational: 1.1.0 may capture silence and later
versions should skip capture while keeping native speed. Neither behavior is
counted as a successful effects test.

A native Web Audio oscillator is checked first. Failure of the runner's audio
clock/output fails the run as an infrastructure problem, not an add-on
regression. A passing run establishes behavior for these controlled sources;
it does not prove compatibility with a user's YouTube session, audio device,
other add-ons or exact macOS point release. The workflow also attempts the
reported YouTube video and records playback/capture/processor state. A cloud
network, consent, or player failure is explicitly inconclusive, not an effects
pass or a regression. The optional live observation does not gate the local
source measurements.

Each artifact contains the browser log, host information, complete debug
reports, measurements and a Markdown summary. The workflow fails if a supported
source does not produce the expected pitch/microtone shift or reverb tail.

Run locally with Python 3 and an existing Firefox binary:

```sh
python3 diagnostics/macos_audio.py --binary /path/to/firefox --addon /path/to/addon --output /tmp/pitchshifter-results --expected-version 1.1.3
```
