// injected.js — runs in the PAGE world.
// Routes every <video>/<audio> element through a pitch shifter and applies the
// pitch chosen in the popup. Total shift (in octaves) = (pitch + micro) / 12.
// Speed (playbackRate) is applied directly on the element with pitch preserved.
(function () {
  if (window.__pitchShifterInjected) return;
  window.__pitchShifterInjected = true;

  // =====================================================================
  // High-quality pitch shifter (AudioWorklet, phase vocoder)
  // STFT analysis/synthesis with phase propagation and spectral bin
  // remapping (smbPitchShift by Stephan M. Bernsee). Far smoother than a
  // delay-line shifter for sustained/musical material. Loaded from a Blob
  // URL; if a page's CSP blocks it we fall back to the Jungle shifter below.
  // =====================================================================
  const WORKLET_CODE = `
class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.fftFrameSize = 1024;
    this.osamp = 8; // overlap factor — higher = smoother, more CPU
    this.channels = [];
  }
  newChannel() {
    const F = this.fftFrameSize;
    return {
      gInFIFO: new Float32Array(F),
      gOutFIFO: new Float32Array(F),
      gFFTworksp: new Float32Array(2 * F),
      gLastPhase: new Float32Array(F / 2 + 1),
      gSumPhase: new Float32Array(F / 2 + 1),
      gOutputAccum: new Float32Array(2 * F),
      gAnaFreq: new Float32Array(F),
      gAnaMagn: new Float32Array(F),
      gSynFreq: new Float32Array(F),
      gSynMagn: new Float32Array(F),
      gRawR: new Float32Array(F / 2 + 1),
      gRawI: new Float32Array(F / 2 + 1),
      gRover: 0,
    };
  }
  smbFft(buf, n, sign) {
    let wr, wi, arg, temp, tr, ti, ur, ui, i, bitm, j, le, le2, k, p1r, p1i, p2r, p2i;
    for (i = 2; i < 2 * n - 2; i += 2) {
      for (bitm = 2, j = 0; bitm < 2 * n; bitm <<= 1) {
        if (i & bitm) j++;
        j <<= 1;
      }
      if (i < j) {
        temp = buf[i]; buf[i] = buf[j]; buf[j] = temp;
        temp = buf[i + 1]; buf[i + 1] = buf[j + 1]; buf[j + 1] = temp;
      }
    }
    const max = Math.round(Math.log(n) / Math.log(2));
    for (k = 0, le = 2; k < max; k++) {
      le <<= 1;
      le2 = le >> 1;
      ur = 1.0; ui = 0.0;
      arg = Math.PI / (le2 >> 1);
      wr = Math.cos(arg);
      wi = sign * Math.sin(arg);
      for (j = 0; j < le2; j += 2) {
        p1r = j; p1i = p1r + 1;
        p2r = p1r + le2; p2i = p2r + 1;
        for (i = j; i < 2 * n; i += le) {
          tr = buf[p2r] * ur - buf[p2i] * ui;
          ti = buf[p2r] * ui + buf[p2i] * ur;
          buf[p2r] = buf[p1r] - tr;
          buf[p2i] = buf[p1i] - ti;
          buf[p1r] += tr;
          buf[p1i] += ti;
          p1r += le; p1i += le; p2r += le; p2i += le;
        }
        tr = ur * wr - ui * wi;
        ui = ur * wi + ui * wr;
        ur = tr;
      }
    }
  }
  shift(ch, pitchShift, indata, outdata, numSamps) {
    const F = this.fftFrameSize;
    const osamp = this.osamp;
    const F2 = F / 2;
    const stepSize = F / osamp;
    const freqPerBin = sampleRate / F;
    const expct = 2 * Math.PI * stepSize / F;
    const inFifoLatency = F - stepSize;
    if (ch.gRover === 0) ch.gRover = inFifoLatency;
    const fifoIn = ch.gInFIFO, fifoOut = ch.gOutFIFO, work = ch.gFFTworksp;
    const lastPhase = ch.gLastPhase, sumPhase = ch.gSumPhase, accum = ch.gOutputAccum;
    const anaF = ch.gAnaFreq, anaM = ch.gAnaMagn, synF = ch.gSynFreq, synM = ch.gSynMagn;
    const rawR = ch.gRawR, rawI = ch.gRawI;
    let magn, phase, tmp, real, imag, qpd, index, k, i, window;
    for (i = 0; i < numSamps; i++) {
      fifoIn[ch.gRover] = indata[i];
      outdata[i] = fifoOut[ch.gRover - inFifoLatency];
      ch.gRover++;
      if (ch.gRover >= F) {
        ch.gRover = inFifoLatency;
        for (k = 0; k < F; k++) {
          window = -0.5 * Math.cos(2 * Math.PI * k / F) + 0.5;
          work[2 * k] = fifoIn[k] * window;
          work[2 * k + 1] = 0;
        }
        this.smbFft(work, F, -1);
        for (k = 0; k <= F2; k++) {
          real = work[2 * k];
          imag = work[2 * k + 1];
          magn = 2 * Math.sqrt(real * real + imag * imag);
          phase = Math.atan2(imag, real);
          tmp = phase - lastPhase[k];
          lastPhase[k] = phase;
          tmp -= k * expct;
          qpd = Math.trunc(tmp / Math.PI);
          if (qpd >= 0) qpd += qpd & 1;
          else qpd -= qpd & 1;
          tmp -= Math.PI * qpd;
          tmp = osamp * tmp / (2 * Math.PI);
          tmp = k * freqPerBin + tmp * freqPerBin;
          anaM[k] = magn;
          anaF[k] = tmp;
        }
        for (k = 0; k <= F2; k++) { synM[k] = 0; synF[k] = 0; }
        for (k = 0; k <= F2; k++) {
          index = Math.round(k * pitchShift);
          if (index <= F2) {
            synM[index] += anaM[k];
            synF[index] = anaF[k] * pitchShift;
          }
        }
        for (k = 0; k <= F2; k++) {
          magn = synM[k];
          tmp = synF[k];
          tmp -= k * freqPerBin;
          tmp /= freqPerBin;
          tmp = 2 * Math.PI * tmp / osamp;
          tmp += k * expct;
          sumPhase[k] += tmp;
          phase = sumPhase[k];
          rawR[k] = magn * Math.cos(phase);
          rawI[k] = magn * Math.sin(phase);
        }
        // Loose phase locking (Puckette): replace each bin's phase with that
        // of the sum of itself and its two neighbours, keeping the magnitude.
        // This restores vertical phase coherence and removes the reverberant
        // "phasiness" that a plain phase vocoder produces.
        for (k = 0; k <= F2; k++) {
          let sr = rawR[k], si = rawI[k];
          if (k > 0) { sr += rawR[k - 1]; si += rawI[k - 1]; }
          if (k < F2) { sr += rawR[k + 1]; si += rawI[k + 1]; }
          const n = Math.sqrt(sr * sr + si * si);
          if (n > 1e-12) {
            work[2 * k] = synM[k] * sr / n;
            work[2 * k + 1] = synM[k] * si / n;
          } else {
            work[2 * k] = rawR[k];
            work[2 * k + 1] = rawI[k];
          }
        }
        for (k = F + 2; k < 2 * F; k++) work[k] = 0;
        this.smbFft(work, F, 1);
        for (k = 0; k < F; k++) {
          window = -0.5 * Math.cos(2 * Math.PI * k / F) + 0.5;
          accum[k] += 2 * window * work[2 * k] / (F2 * osamp);
        }
        for (k = 0; k < stepSize; k++) fifoOut[k] = accum[k];
        for (k = 0; k < F; k++) accum[k] = accum[k + stepSize];
        for (k = 0; k < inFifoLatency; k++) fifoIn[k] = fifoIn[k + stepSize];
      }
    }
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const p = parameters.pitch;
    const pitchShift = p.length > 0 ? p[0] : 1;
    for (let c = 0; c < output.length; c++) {
      const inCh = input[c] || input[input.length - 1];
      const outCh = output[c];
      if (!inCh) { outCh.fill(0); continue; }
      if (!this.channels[c]) this.channels[c] = this.newChannel();
      this.shift(this.channels[c], pitchShift, inCh, outCh, outCh.length);
    }
    return true;
  }
}
registerProcessor('pitch-processor', PitchProcessor);
`;

  // =====================================================================
  // Jungle pitch shifter (fallback)
  // Real-time pitch shift using two crossfaded, delay-modulated lines.
  // Shifts pitch up to ~±1 octave without changing tempo.
  // Algorithm by Chris Wilson (Web Audio API demos), adapted here.
  // Used only when the AudioWorklet above can't load (e.g. strict CSP).
  // =====================================================================
  const delayTime = 0.1;
  const fadeTime = 0.05;
  const bufferTime = 0.1;

  function createFadeBuffer(context, activeTime, fadeTime) {
    const length1 = activeTime * context.sampleRate;
    const length2 = (activeTime - 2 * fadeTime) * context.sampleRate;
    const length = length1 + length2;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const p = buffer.getChannelData(0);
    const fadeLength = fadeTime * context.sampleRate;
    const fadeIndex1 = fadeLength;
    const fadeIndex2 = length1 - fadeLength;
    for (let i = 0; i < length1; ++i) {
      let value;
      if (i < fadeIndex1) value = Math.sqrt(i / fadeLength);
      else if (i >= fadeIndex2) value = Math.sqrt(1 - (i - fadeIndex2) / fadeLength);
      else value = 1;
      p[i] = value;
    }
    for (let i = length1; i < length; ++i) p[i] = 0;
    return buffer;
  }

  function createDelayTimeBuffer(context, activeTime, fadeTime, shiftUp) {
    const length1 = activeTime * context.sampleRate;
    const length2 = (activeTime - 2 * fadeTime) * context.sampleRate;
    const length = length1 + length2;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const p = buffer.getChannelData(0);
    for (let i = 0; i < length1; ++i) {
      if (shiftUp) p[i] = (length1 - i) / length;
      else p[i] = i / length1;
    }
    for (let i = length1; i < length; ++i) p[i] = 0;
    return buffer;
  }

  function Jungle(context) {
    this.context = context;
    const input = context.createGain();
    const output = context.createGain();
    this.input = input;
    this.output = output;

    const mod1 = context.createBufferSource();
    const mod2 = context.createBufferSource();
    const mod3 = context.createBufferSource();
    const mod4 = context.createBufferSource();
    const shiftDownBuffer = createDelayTimeBuffer(context, bufferTime, fadeTime, false);
    const shiftUpBuffer = createDelayTimeBuffer(context, bufferTime, fadeTime, true);
    mod1.buffer = shiftDownBuffer;
    mod2.buffer = shiftDownBuffer;
    mod3.buffer = shiftUpBuffer;
    mod4.buffer = shiftUpBuffer;
    mod1.loop = true;
    mod2.loop = true;
    mod3.loop = true;
    mod4.loop = true;

    const mod1Gain = context.createGain();
    const mod2Gain = context.createGain();
    const mod3Gain = context.createGain();
    const mod4Gain = context.createGain();
    mod3Gain.gain.value = 0;
    mod4Gain.gain.value = 0;

    mod1.connect(mod1Gain);
    mod2.connect(mod2Gain);
    mod3.connect(mod3Gain);
    mod4.connect(mod4Gain);

    const modGain1 = context.createGain();
    const modGain2 = context.createGain();
    const delay1 = context.createDelay();
    const delay2 = context.createDelay();
    mod1Gain.connect(modGain1);
    mod2Gain.connect(modGain2);
    mod3Gain.connect(modGain1);
    mod4Gain.connect(modGain2);
    modGain1.connect(delay1.delayTime);
    modGain2.connect(delay2.delayTime);

    const fade1 = context.createBufferSource();
    const fade2 = context.createBufferSource();
    const fadeBuffer = createFadeBuffer(context, bufferTime, fadeTime);
    fade1.buffer = fadeBuffer;
    fade2.buffer = fadeBuffer;
    fade1.loop = true;
    fade2.loop = true;

    const mix1 = context.createGain();
    const mix2 = context.createGain();
    mix1.gain.value = 0;
    mix2.gain.value = 0;

    fade1.connect(mix1.gain);
    fade2.connect(mix2.gain);

    input.connect(delay1);
    input.connect(delay2);
    delay1.connect(mix1);
    delay2.connect(mix2);
    mix1.connect(output);
    mix2.connect(output);

    const t = context.currentTime + 0.05;
    const t2 = t + bufferTime - fadeTime;
    mod1.start(t);
    mod2.start(t2);
    mod3.start(t);
    mod4.start(t2);
    fade1.start(t);
    fade2.start(t2);

    this.mod1Gain = mod1Gain;
    this.mod2Gain = mod2Gain;
    this.mod3Gain = mod3Gain;
    this.mod4Gain = mod4Gain;
    this.modGain1 = modGain1;
    this.modGain2 = modGain2;

    this.setDelay(delayTime);
  }

  Jungle.prototype.setDelay = function (t) {
    this.modGain1.gain.setTargetAtTime(0.5 * t, this.context.currentTime, 0.01);
    this.modGain2.gain.setTargetAtTime(0.5 * t, this.context.currentTime, 0.01);
  };

  Jungle.prototype.setPitchOffset = function (mult) {
    if (mult > 0) {
      this.mod1Gain.gain.value = 0;
      this.mod2Gain.gain.value = 0;
      this.mod3Gain.gain.value = 1;
      this.mod4Gain.gain.value = 1;
    } else {
      this.mod1Gain.gain.value = 1;
      this.mod2Gain.gain.value = 1;
      this.mod3Gain.gain.value = 0;
      this.mod4Gain.gain.value = 0;
    }
    this.setDelay(delayTime * Math.abs(mult));
  };

  // =====================================================================
  // Pitch shifter wiring / state
  // =====================================================================
  let ctx = null;
  let workletReady = null;
  let useWorklet = false;
  const wired = new Map(); // mediaEl -> { source, shifter, dry, wet }
  let curPitch = 0;
  let curMicro = 0;
  let curSpeed = 1;
  let lastHasMedia = null;

  const mult = () => (curPitch + curMicro) / 12;
  const ratio = () => Math.pow(2, mult());
  const isActive = () => Math.abs(mult()) > 1e-6;

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  // Load the phase-vocoder worklet once. On failure (no support / CSP) we keep
  // useWorklet = false and the shifter falls back to Jungle.
  function ensureWorklet() {
    if (workletReady) return workletReady;
    workletReady = (async () => {
      try {
        if (!ctx || !ctx.audioWorklet) throw new Error("no audioWorklet");
        const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        useWorklet = true;
      } catch (e) {
        useWorklet = false;
      }
    })();
    return workletReady;
  }

  function getMedia() {
    return Array.from(document.querySelectorAll("video, audio"));
  }

  // Speed = native playback rate with pitch preserved (browser time-stretch).
  // Independent of the pitch shifter, so it stays high quality on its own.
  function applySpeed() {
    getMedia().forEach((el) => {
      try {
        el.preservesPitch = true;
        el.mozPreservesPitch = true;
        el.webkitPreservesPitch = true;
        if (el.playbackRate !== curSpeed) el.playbackRate = curSpeed;
      } catch (e) {}
    });
  }

  // Build a shifter node: phase-vocoder worklet if available, else Jungle.
  function makeShifter() {
    if (useWorklet) {
      let node = null;
      try {
        node = new AudioWorkletNode(ctx, "pitch-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
        });
      } catch (e) {
        node = null;
      }
      if (node) {
        const param = node.parameters.get("pitch");
        return {
          input: node,
          output: node,
          setPitch: () => {
            try {
              param.setTargetAtTime(ratio(), ctx.currentTime, 0.01);
            } catch (e) {
              param.value = ratio();
            }
          },
        };
      }
    }
    const jungle = new Jungle(ctx);
    return {
      input: jungle.input,
      output: jungle.output,
      setPitch: () => jungle.setPitchOffset(mult()),
    };
  }

  // Route one media element: source -> [dry, shifter->wet] -> destination.
  // Dry path keeps the audio pristine when pitch is 0 (true bypass).
  function wire(el) {
    if (wired.has(el)) return wired.get(el);
    let source;
    try {
      source = ctx.createMediaElementSource(el);
    } catch (e) {
      // Already captured by something else, or cross-origin without CORS.
      return null;
    }
    const shifter = makeShifter();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    source.connect(dry);
    source.connect(shifter.input);
    shifter.output.connect(wet);
    dry.connect(ctx.destination);
    wet.connect(ctx.destination);
    const node = { source, shifter, dry, wet };
    wired.set(el, node);
    return node;
  }

  function applyNode(node) {
    node.shifter.setPitch();
    const a = isActive();
    const now = ctx.currentTime;
    node.dry.gain.setTargetAtTime(a ? 0 : 1, now, 0.01);
    node.wet.gain.setTargetAtTime(a ? 1 : 0, now, 0.01);
  }

  async function apply() {
    applySpeed();
    if (isActive()) {
      ensureCtx();
      await ensureWorklet();
      getMedia().forEach(wire);
    }
    wired.forEach(applyNode);
  }

  function postState() {
    window.postMessage(
      {
        source: "pitchshifter-page",
        type: "state",
        hasMedia: getMedia().length > 0,
        pitch: curPitch,
        micro: curMicro,
        speed: curSpeed,
      },
      "*"
    );
  }

  // Messages from the content script.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== "pitchshifter-cs") return;
    if (d.type === "setPitch") {
      curPitch = Number(d.pitch) || 0;
      curMicro = Number(d.micro) || 0;
      curSpeed = Number(d.speed) || 1;
      apply();
      postState();
    } else if (d.type === "getState") {
      postState();
    }
  });

  // Watch for media added after load (SPAs, lazy players). Debounced.
  let moTimer = null;
  const mo = new MutationObserver(() => {
    if (moTimer) return;
    moTimer = setTimeout(() => {
      moTimer = null;
      applySpeed();
      if (isActive()) {
        ensureCtx();
        ensureWorklet().then(() => {
          getMedia().forEach(wire);
          wired.forEach(applyNode);
        });
      }
      const has = getMedia().length > 0;
      if (has !== lastHasMedia) {
        lastHasMedia = has;
        postState();
      }
    }, 400);
  });
  try {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  postState();
})();
