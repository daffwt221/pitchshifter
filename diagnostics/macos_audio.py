"""Measure historical PitchShifter builds in a real Firefox audio graph."""

import argparse
import http.server
import io
import json
import math
import os
from pathlib import Path
import platform
import socket
import struct
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.parse
import wave


class Marionette:
    def __init__(self, port, process):
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('Firefox exited before Marionette connected')
            try:
                self.sock = socket.create_connection(('127.0.0.1', port), 1)
                break
            except OSError:
                time.sleep(0.2)
        else:
            raise TimeoutError('Firefox Marionette did not start')
        self.sock.settimeout(35)
        self.index = 0
        self.receive()

    def read(self, size):
        result = b''
        while len(result) < size:
            chunk = self.sock.recv(size - len(result))
            if not chunk:
                raise ConnectionError('Firefox closed Marionette')
            result += chunk
        return result

    def receive(self):
        size = b''
        while not size.endswith(b':'):
            size += self.read(1)
        return json.loads(self.read(int(size[:-1])))

    def call(self, command, arguments=None):
        self.index += 1
        body = json.dumps([0, self.index, command, arguments or {}]).encode()
        self.sock.sendall(str(len(body)).encode() + b':' + body)
        response = self.receive()
        if response[2]:
            raise RuntimeError(json.dumps(response[2]))
        return response[3]

    def js(self, script, *args):
        result = self.call('WebDriver:ExecuteScript', {
            'script': script, 'args': list(args), 'sandbox': None,
            'newSandbox': False, 'line': 1, 'filename': 'audio-diagnostic',
        })
        return result.get('value', result) if isinstance(result, dict) else result


INSTRUMENT = r'''
window._contexts = []; window._errors = [];
const warn = console.warn;
console.warn = (...args) => {window._errors.push(args.map(String)); warn(...args)};
const BaseContext = window.AudioContext;
const connect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function(destination, ...args) {
  const meter = this.context._diagnosticMeter;
  if (destination === this.context.destination && meter && this !== meter)
    return connect.call(this, meter, ...args);
  return connect.call(this, destination, ...args);
};
window.AudioContext = class extends BaseContext {
  constructor(options) {
    super(options);
    this._diagnosticMeter = this.createAnalyser();
    this._diagnosticMeter.fftSize = 32768;
    this._diagnosticMeter.smoothingTimeConstant = 0;
    connect.call(this._diagnosticMeter, this.destination);
    window._contexts.push(this);
  }
};
window._measure = ctx => {
  const meter = ctx._diagnosticMeter;
  const bins = new Float32Array(meter.frequencyBinCount);
  const samples = new Float32Array(meter.fftSize);
  meter.getFloatFrequencyData(bins); meter.getFloatTimeDomainData(samples);
  let peak = 0, energy = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
  for (const sample of samples) energy += sample * sample;
  return {state: ctx.state, time: ctx.currentTime, sampleRate: ctx.sampleRate,
    frequency: peak * ctx.sampleRate / meter.fftSize,
    binWidth: ctx.sampleRate / meter.fftSize,
    rms: Math.sqrt(energy / samples.length)};
};
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--addon', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--expected-version', required=True)
    parser.add_argument('--youtube', action='store_true', help='Observe the reported public video; network/player failures are inconclusive')
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    addon = Path(args.addon).resolve()
    version = json.loads((addon / 'manifest.json').read_text())['version']
    if version != args.expected_version:
        raise RuntimeError(f'Expected {args.expected_version}, got {version}')
    result = {'version': version, 'platform': platform.platform(), 'cases': []}
    failures = []
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(48000)
        wav.writeframes(b''.join(struct.pack('<h', int(6500 * math.sin(
            2 * math.pi * 440 * n / 48000))) for n in range(48000 * 8)))
    tone = buffer.getvalue()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(url.query)
            if url.path == '/tone.wav':
                body, mime = tone, 'audio/wav'
            else:
                origin = f'http://localhost:{self.server.server_port}' if 'cross' in query else ''
                src = '' if 'late' in query or 'blob' in query else f'src="{origin}/tone.wav"'
                cors = 'crossorigin="anonymous"' if 'cors' in query else ''
                body = f'<!doctype html><title>Audio diagnostic</title><video id="v" controls loop {cors} {src}></video>'.encode()
                mime = 'text/html'
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            if 'strict' in query:
                self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; media-src 'self' blob: http://localhost:*; object-src 'none'")
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    client = process = None
    log = (output / 'firefox.log').open('w', encoding='utf-8')
    profile = tempfile.TemporaryDirectory(prefix='pitchshifter-diagnostic-')
    try:
        prefs = {'marionette.port': port, 'browser.shell.checkDefaultBrowser': False,
                 'browser.startup.page': 0, 'browser.aboutwelcome.enabled': False,
                 'startup.homepage_welcome_url': '', 'media.autoplay.default': 0,
                 'media.volume_scale': '0.0', 'app.update.auto': False,
                 'datareporting.policy.dataSubmissionEnabled': False,
                 'toolkit.telemetry.enabled': False}
        (Path(profile.name) / 'user.js').write_text('\n'.join(
            f'user_pref({json.dumps(k)}, {json.dumps(v)});' for k, v in prefs.items()))
        process = subprocess.Popen([str(Path(args.binary).resolve()), '--headless',
                                    '--marionette', '--no-remote', '--profile', profile.name],
                                   stdout=log, stderr=log)
        client = Marionette(port, process)
        result['session'] = client.call('WebDriver:NewSession', {'pageLoadStrategy': 'eager'})
        client.call('Addon:Install', {'path': str(addon), 'temporary': True})
        base = f'http://127.0.0.1:{server.server_port}/'

        def navigate(query=''):
            client.call('WebDriver:Navigate', {'url': base + query})
            deadline = time.monotonic() + 8
            while not client.js('return Boolean(window.__pitchShifterDebug)'):
                if time.monotonic() > deadline:
                    raise RuntimeError('Extension did not inject')
                time.sleep(0.1)
            client.js(INSTRUMENT)

        def settings(**overrides):
            controls = dict(source='pitchshifter-cs', type='setPitch', enabled=True,
                            pitch=0, micro=0, speed=1, reverb=0, reverbMode='simple',
                            reverbSize=1, reverbDecay=2.8, reverbTone=0.55,
                            reverbPreDelay=0.016)
            controls.update(overrides)
            client.js('window.postMessage(arguments[0], "*")', controls)

        def report():
            return client.js('''return {debug: window.__pitchShifterDebug.report(),
              errors: window._errors, audio: window._contexts.map(window._measure),
              media: {paused: v.paused, time: v.currentTime, speed: v.playbackRate,
                readyState: v.readyState, error: v.error && v.error.message}};''')

        def check_frequency(data, expected, label):
            meters = data['audio']
            ok = any(m['state'] == 'running' and m['rms'] > 0.001 and
                     abs(m['frequency'] - expected) <= max(4, m['binWidth'] * 2)
                     for m in meters)
            if not ok:
                failures.append(label)
            return ok

        navigate()
        client.js('window._probe = new AudioContext(); window._osc = _probe.createOscillator(); _osc.frequency.value=440; _osc.connect(_probe.destination); _osc.start(); _probe.resume();')
        time.sleep(1)
        result['preflight'] = client.js('return window._measure(window._probe)')
        if result['preflight']['rms'] < 0.001 or result['preflight']['time'] < 0.1:
            raise RuntimeError('INFRASTRUCTURE: native AudioContext did not render the probe')
        client.js('_osc.stop(); _probe.close()')

        cases = [('same-origin', ''), ('strict-csp', '?strict=1'),
                 ('blob', '?blob=1'), ('late-source', '?late=1'),
                 ('cross-origin-cors', '?cross=1&cors=1'),
                 ('cross-origin-native-fallback', '?cross=1')]
        for name, query in cases:
            navigate(query)
            if name == 'late-source':
                settings(pitch=12)
                time.sleep(0.3)
                client.js('v.src="/tone.wav"')
            if name == 'blob':
                client.js('fetch("/tone.wav").then(r=>r.blob()).then(b=>{v.src=URL.createObjectURL(b);v.play()}).catch(e=>_errors.push(String(e)))')
            else:
                client.js('v.play().catch(e=>_errors.push(String(e)))')
            time.sleep(0.5)
            entry = {'name': name, 'checks': {}}
            result['cases'].append(entry)
            settings(pitch=12, speed=0.8)
            time.sleep(1.5)
            entry['pitch'] = report()
            if name == 'cross-origin-native-fallback':
                entry['observational'] = True
                print(f'{version} {name}: observed capture/fallback', flush=True)
                continue
            entry['checks']['pitch'] = check_frequency(entry['pitch'], 880, name + ': pitch')
            settings(micro=0.5)
            time.sleep(1.5)
            entry['microtones'] = report()
            entry['checks']['microtones'] = check_frequency(entry['microtones'], 440 * 2 ** (0.5 / 12), name + ': microtones')
            settings(reverb=1)
            time.sleep(1.5)
            entry['reverb_playing'] = report()
            client.js('v.pause()')
            # Wait longer than the analyser's full 32768-sample window at 44.1kHz.
            time.sleep(0.85)
            entry['reverb_tail'] = report()
            tail = max((m['rms'] for m in entry['reverb_tail']['audio']), default=0)
            time.sleep(2.5)
            entry['reverb_decayed'] = report()
            decayed = max((m['rms'] for m in entry['reverb_decayed']['audio']), default=0)
            entry['checks']['reverb'] = tail > 0.0001 and decayed < tail * 0.5
            if not entry['checks']['reverb']:
                failures.append(name + ': reverb')
            print(f'{version} {name}: {entry["checks"]}', flush=True)
        if args.youtube:
            observation = {'status': 'inconclusive', 'url': 'https://www.youtube.com/watch?v=-XyLecY2JyE'}
            result['youtube'] = observation
            try:
                client.call('WebDriver:SetTimeouts', {'pageLoad': 30000, 'script': 30000})
                client.call('WebDriver:Navigate', {'url': observation['url']})
                for _ in range(25):
                    client.js('''const b = Array.from(document.querySelectorAll('button')).find(b =>
                      /^(Reject all|Rejeitar tudo|Rejeitar todos)$/i.test(b.textContent.trim()) ||
                      /^(Reject all|Rejeitar tudo|Rejeitar todos)$/i.test(b.getAttribute('aria-label') || ''));
                      if (b) b.click();''')
                    if client.js('return Boolean(document.querySelector("video")?.readyState >= 2 && window.__pitchShifterDebug)'):
                        break
                    time.sleep(1)
                client.js(INSTRUMENT)
                client.js('const v=document.querySelector("video"); if(v){v.muted=false;v.volume=1;v.play().catch(e=>_errors.push(String(e)))}')
                time.sleep(2)
                observation['before'] = client.js('const v=document.querySelector("video");return v && {paused:v.paused,time:v.currentTime,ready:v.readyState}')
                settings(pitch=7, micro=0.25, speed=0.8, reverb=0.6)
                time.sleep(3)
                observation['after'] = client.js('''const v=document.querySelector('video');return {
                  media: v && {paused:v.paused,time:v.currentTime,ready:v.readyState,muted:v.muted,error:v.error?.message},
                  debug:window.__pitchShifterDebug?.report(), errors:window._errors,
                  audio:window._contexts.map(window._measure), title:document.title};''')
                before, after = observation['before'], observation['after']['media']
                if before and after and not after['paused'] and after['time'] > before['time'] + 0.2:
                    observation['status'] = 'playing; inspect capture and processor output in artifact'
            except Exception:
                observation['error'] = traceback.format_exc()
            print('YouTube: ' + observation['status'], flush=True)
    except Exception:
        result['error'] = traceback.format_exc()
        failures.append('harness/infrastructure: ' + result['error'].splitlines()[-1])
        print(result['error'], flush=True)
    finally:
        if client:
            try:
                client.call('Marionette:Quit', {'flags': ['eForceQuit']})
            except Exception:
                pass
            client.sock.close()
        if process:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=10)
        server.shutdown()
        server.server_close()
        log.close()
        profile.cleanup()
        result['failures'] = failures
        (output / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        lines = [f'# PitchShifter {version}: macOS audio diagnostic', '',
                 '| Case | Pitch | Microtones | Reverb |', '|---|---|---|---|']
        for entry in result['cases']:
            checks = entry['checks']
            cells = [('PASS' if checks.get(k) else 'FAIL') if k in checks else 'observation'
                     for k in ('pitch', 'microtones', 'reverb')]
            lines.append('| ' + entry['name'] + ' | ' + ' | '.join(cells) + ' |')
        lines.extend(['', 'Failures: ' + (', '.join(failures) or 'none'), '',
                      'Controlled sources only; this does not establish behavior in a user YouTube session.'])
        if 'youtube' in result:
            lines.extend(['', 'YouTube observation: ' + result['youtube']['status']])
        summary = '\n'.join(lines) + '\n'
        (output / 'summary.md').write_text(summary, encoding='utf-8')
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary_file:
                summary_file.write(summary)
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())
