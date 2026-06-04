// injected.js — runs in the PAGE world.
// Routes every <video>/<audio> element through a pitch shifter and applies the
// pitch chosen in the popup. Total shift (in octaves) = (pitch + micro) / 12.
(function () {
  if (window.__pitchShifterInjected) return;
  window.__pitchShifterInjected = true;

  // =====================================================================
  // Jungle pitch shifter
  // Real-time pitch shift using two crossfaded, delay-modulated lines.
  // Shifts pitch up to ~±1 octave without changing tempo.
  // Algorithm by Chris Wilson (Web Audio API demos), adapted here.
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

  // mult in [-1, 1] => roughly [-1 octave, +1 octave]
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
  const wired = new Map(); // mediaEl -> { source, jungle, dry, wet }
  let curPitch = 0;
  let curMicro = 0;
  let lastHasMedia = null;

  const mult = () => (curPitch + curMicro) / 12;
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

  // Route one media element: source -> [dry, jungle->wet] -> destination.
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
    const jungle = new Jungle(ctx);
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    source.connect(dry);
    source.connect(jungle.input);
    jungle.output.connect(wet);
    dry.connect(ctx.destination);
    wet.connect(ctx.destination);
    const node = { source, jungle, dry, wet };
    wired.set(el, node);
    return node;
  }

  function applyNode(node) {
    node.jungle.setPitchOffset(mult());
    const a = isActive();
    node.dry.gain.value = a ? 0 : 1;
    node.wet.gain.value = a ? 1 : 0;
  }

  function apply() {
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
