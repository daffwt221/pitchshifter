// injected.js — runs in the PAGE world.
// Routes every <video>/<audio> element through a phase-vocoder pitch shifter
// and applies the pitch chosen in the popup. Pitch shift (octaves) =
// (pitch + micro) / 12. Speed (playbackRate) is applied directly on the
// element with pitch preserved.
//
// The shifter runs inside a ScriptProcessorNode rather than an AudioWorklet.
// AudioWorklet modules must be loaded from a URL, which page CSPs (YouTube,
// etc.) routinely block; ScriptProcessorNode runs inline so it is immune to
// that and works everywhere. It is deprecated but fully supported in Firefox.
(function () {
  if (window.__pitchShifterInjected) return;
  window.__pitchShifterInjected = true;

  // =====================================================================
  // Phase vocoder
  // STFT analysis -> per-bin true-frequency estimation -> bin remapping by
  // pitch factor (keeping the strongest bin per target, which avoids the
  // smearing a naive sum produces) -> phase-accumulated synthesis -> IFFT
  // -> windowed overlap-add. Hann window on both analysis and synthesis.
  // =====================================================================
  const N = 1024;        // FFT size
  const HOP = N >> 2;    // 256, 75% overlap (4 frames per window)
  const BUFSZ = 8192;    // ring buffer, power of two, > 4*N
  const MASK = BUFSZ - 1;
  const TP = 2 * Math.PI;
  const HEADROOM = 0.9;  // small margin so peaks don't reach the limiter

  // In-place iterative radix-2 Cooley-Tukey FFT (separate real/imag arrays).
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let uRe = 1, uIm = 0;
        const half = len >> 1;
        for (let k = 0; k < half; k++) {
          const p = i + k, q = p + half;
          const tRe = re[q] * uRe - im[q] * uIm;
          const tIm = re[q] * uIm + im[q] * uRe;
          re[q] = re[p] - tRe; im[q] = im[p] - tIm;
          re[p] += tRe; im[p] += tIm;
          const nr = uRe * wRe - uIm * wIm;
          uIm = uRe * wIm + uIm * wRe;
          uRe = nr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  function makePV() {
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos(TP * i / (N - 1)));
    return {
      win,
      re: new Float32Array(N), im: new Float32Array(N),
      oRe: new Float32Array(N), oIm: new Float32Array(N),
      oMag: new Float32Array((N >> 1) + 1),
      oFreq: new Float32Array((N >> 1) + 1),
      inBuf: new Float32Array(BUFSZ),
      outBuf: new Float32Array(BUFSZ),
      winSum: new Float32Array(BUFSZ),
      phaseIn: new Float32Array((N >> 1) + 1),
      phaseAcc: new Float32Array((N >> 1) + 1),
      inW: 0, inR: 0, outW: 0, outR: 0,
      hopCount: 0,
      ready: false,
    };
  }

  function pvFrame(pv, pf) {
    const { win, re, im, oRe, oIm, oMag, oFreq, inBuf, outBuf, winSum, phaseIn, phaseAcc } = pv;
    const halfN = N >> 1;

    for (let k = 0; k < N; k++) { re[k] = inBuf[(pv.inR + k) & MASK] * win[k]; im[k] = 0; }
    fft(re, im, false);

    oMag.fill(0); oFreq.fill(0);
    for (let k = 0; k <= halfN; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const phase = Math.atan2(im[k], re[k]);
      const expect = TP * k * HOP / N;
      let dp = phase - phaseIn[k] - expect;
      dp -= Math.round(dp / TP) * TP;
      phaseIn[k] = phase;
      if (mag < 1e-12) continue;
      const nk = Math.round(k * pf);
      if (nk >= 0 && nk <= halfN && mag > oMag[nk]) {
        oMag[nk] = mag;
        oFreq[nk] = (expect + dp) * pf;
      }
    }

    for (let k = 0; k <= halfN; k++) {
      phaseAcc[k] += oMag[k] > 0 ? oFreq[k] : TP * k * HOP / N;
      oRe[k] = oMag[k] * Math.cos(phaseAcc[k]);
      oIm[k] = oMag[k] * Math.sin(phaseAcc[k]);
    }
    for (let k = 1; k < halfN; k++) { oRe[N - k] = oRe[k]; oIm[N - k] = -oIm[k]; }
    oIm[halfN] = 0;

    fft(oRe, oIm, true);

    // Synthesis window + overlap-add, tracking the running window-product sum
    // so the read step can divide by it (COLA normalization). This gives a
    // consistent output level for any pitch factor — no clipping, no volume
    // jumps — instead of relying on a hand-tuned gain constant.
    for (let k = 0; k < N; k++) {
      const idx = (pv.outW + k) & MASK;
      outBuf[idx] += oRe[k] * win[k];
      winSum[idx] += win[k] * win[k];
    }

    pv.inR += HOP;
    pv.outW += HOP;
  }

  function processChannel(pv, inp, out, pf) {
    const n = inp.length;

    // Bypass — clean passthrough when the pitch factor is ~1.0.
    if (Math.abs(pf - 1) < 0.005) {
      out.set(inp);
      if (pv.ready) { pv.ready = false; pv.phaseIn.fill(0); pv.phaseAcc.fill(0); }
      return;
    }

    for (let i = 0; i < n; i++) pv.inBuf[(pv.inW + i) & MASK] = inp[i];
    pv.inW += n;

    if (!pv.ready) {
      if (pv.inW < 2 * N) { out.fill(0); return; }
      pv.inR = 0; pv.outW = 0; pv.hopCount = 0;
      pv.phaseIn.fill(0); pv.phaseAcc.fill(0); pv.outBuf.fill(0); pv.winSum.fill(0);
      for (let g = 0; g < N / HOP; g++) pvFrame(pv, pf);
      pv.outR = N - HOP;
      pv.ready = true;
    }

    pv.hopCount += n;
    while (pv.hopCount >= HOP) { pv.hopCount -= HOP; pvFrame(pv, pf); }

    for (let i = 0; i < n; i++) {
      const pos = (pv.outR + i) & MASK;
      const ws = pv.winSum[pos];
      const v = ws > 1e-6 ? (pv.outBuf[pos] / ws) * HEADROOM : 0;
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
      pv.outBuf[pos] = 0;
      pv.winSum[pos] = 0;
    }
    pv.outR += n;
  }

  // Shifter built on a ScriptProcessorNode (CSP-immune, stereo).
  function createShifter(ctx) {
    const pvL = makePV(), pvR = makePV();
    let pitchFactor = 1.0;
    const node = ctx.createScriptProcessor(512, 2, 2);
    node.onaudioprocess = (ev) => {
      const inB = ev.inputBuffer, outB = ev.outputBuffer;
      const outL = outB.getChannelData(0);
      processChannel(pvL, inB.getChannelData(0), outL, pitchFactor);
      if (inB.numberOfChannels > 1) {
        processChannel(pvR, inB.getChannelData(1), outB.getChannelData(1), pitchFactor);
      } else {
        outB.getChannelData(1).set(outL);
      }
    };
    return { node, setPitch(pf) { pitchFactor = pf; } };
  }

  // =====================================================================
  // Wiring / state
  // =====================================================================
  let ctx = null;
  const wired = new Map(); // mediaEl -> { source, shifter }
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

  function getMedia() {
    return Array.from(document.querySelectorAll("video, audio"));
  }

  // Speed = native playback rate with pitch preserved (browser time-stretch).
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

  // Route one element: source -> shifter -> destination. The shifter passes
  // audio through untouched while pitch is at 0.
  function wire(el) {
    if (wired.has(el)) return wired.get(el);
    let source;
    try {
      source = ctx.createMediaElementSource(el);
    } catch (e) {
      // Already captured, or cross-origin without CORS.
      return null;
    }
    const shifter = createShifter(ctx);
    source.connect(shifter.node);
    shifter.node.connect(ctx.destination);
    const node = { source, shifter };
    wired.set(el, node);
    return node;
  }

  function applyNode(node) {
    node.shifter.setPitch(ratio());
  }

  function apply() {
    applySpeed();
    if (isActive()) {
      ensureCtx();
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
        getMedia().forEach(wire);
        wired.forEach(applyNode);
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
