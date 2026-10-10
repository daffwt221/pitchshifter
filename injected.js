// injected.js — runs in the PAGE world.
// Routes media in this tab through SoundTouchJS and applies the values chosen
// in the popup. Speed is set on the media element; the selected worklet
// compensates for that rate while also applying the requested pitch.
//
// WSOLA handles the normal range because it preserves transients well. At very
// slow speeds a phase vocoder takes over because it avoids WSOLA's repeated /
// gapped texture. Both engines run off the page thread in AudioWorklets.
(function () {
  if (window.__pitchShifterInjected) return;
  window.__pitchShifterInjected = true;

  const ENGINE_WSOLA = "wsola";
  const ENGINE_PHASE = "phase";
  const WORKLET_NAMES = {
    [ENGINE_WSOLA]: "soundtouch-processor",
    [ENGINE_PHASE]: "phase-vocoder-processor",
  };
  const PHASE_ENTER_SPEED = 0.45;
  const PHASE_EXIT_SPEED = 0.55;
  const PHASE_FFT_SIZE = 2048;
  const PHASE_OVERLAP_FACTOR = 8;
  const WSOLA_QUALITY_ENTER_SPEED = 0.7;
  const WSOLA_QUALITY_EXIT_SPEED = 0.76;
  const WSOLA_PROFILE_LOW_LATENCY = "low-latency";
  const WSOLA_PROFILE_SLOW_QUALITY = "slow-quality";
  // Short windows keep normal playback and pitch-only changes responsive.
  // During a substantial slowdown, SoundTouch's tempo-aware windows reduce
  // the repeated-segment hum while a longer overlap hides the joins.
  const WSOLA_SETTINGS = {
    [WSOLA_PROFILE_LOW_LATENCY]: {
      sequenceMs: 50,
      seekWindowMs: 15,
      overlapMs: 8,
      quickSeek: true,
    },
    [WSOLA_PROFILE_SLOW_QUALITY]: {
      sequenceMs: 0,
      seekWindowMs: 0,
      overlapMs: 12,
      quickSeek: true,
    },
  };
  const ENGINE_WARMUP_SECONDS = 0.06;
  const ENGINE_CROSSFADE_SECONDS = 0.05;
  const PITCH_RAMP_SECONDS = 0.04;
  const REVERB_RAMP_SECONDS = 0.035;
  const REVERB_CONFIG_CROSSFADE_SECONDS = 0.12;
  const DEFAULT_REVERB_SIZE = 1;
  const DEFAULT_REVERB_DECAY = 2.8;
  const DEFAULT_REVERB_TONE = 0.55;
  const DEFAULT_REVERB_PREDELAY = 0.016;
  const REVERB_IR_CACHE_LIMIT = 3;
  const DEBUG_EVENT_LIMIT = 160;

  function setParamImmediately(param, value, now) {
    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
  }

  function rampPositiveParam(param, value, now) {
    if (typeof param.cancelAndHoldAtTime === "function") {
      param.cancelAndHoldAtTime(now);
    } else {
      param.cancelScheduledValues(now);
      param.setValueAtTime(Math.max(param.value, 0.0001), now);
    }
    param.exponentialRampToValueAtTime(value, now + PITCH_RAMP_SECONDS);
  }

  function rampLinearParam(param, value, now, duration) {
    if (typeof param.cancelAndHoldAtTime === "function") {
      param.cancelAndHoldAtTime(now);
    } else {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
    }
    param.linearRampToValueAtTime(value, now + duration);
  }

  function wsolaProfileFor(playbackRate) {
    if (
      selectedWsolaProfile === WSOLA_PROFILE_LOW_LATENCY &&
      playbackRate < WSOLA_QUALITY_ENTER_SPEED
    ) {
      selectedWsolaProfile = WSOLA_PROFILE_SLOW_QUALITY;
    } else if (
      selectedWsolaProfile === WSOLA_PROFILE_SLOW_QUALITY &&
      playbackRate > WSOLA_QUALITY_EXIT_SPEED
    ) {
      selectedWsolaProfile = WSOLA_PROFILE_LOW_LATENCY;
    }
    return selectedWsolaProfile;
  }

  function createShifter(audioContext, engine, playbackRate) {
    const processorOptions = {
      sampleBufferType: "circular",
      interpolationStrategy: "lanczos",
    };
    if (engine === ENGINE_PHASE) {
      processorOptions.fftSize = PHASE_FFT_SIZE;
      processorOptions.overlapFactor = PHASE_OVERLAP_FACTOR;
    }

    const node = new AudioWorkletNode(audioContext, WORKLET_NAMES[engine], {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions,
    });
    const pitchParam = node.parameters.get("pitch");
    const semitoneParam = node.parameters.get("pitchSemitones");
    const playbackRateParam = node.parameters.get("playbackRate");
    const wsolaProfile =
      engine === ENGINE_WSOLA ? wsolaProfileFor(playbackRate) : null;
    let currentPitch = null;
    let currentPlaybackRate = null;
    let metrics = null;
    let lastUnderrunCount = 0;
    let pendingUnderruns = 0;
    let lastUnderrunReportAt = 0;

    setParamImmediately(semitoneParam, 0, audioContext.currentTime);
    if (engine === ENGINE_WSOLA) {
      node.port.postMessage({
        type: "set-stretch-parameters",
        params: WSOLA_SETTINGS[wsolaProfile],
      });
    }
    node.port.onmessage = ({ data }) => {
      if (!data || data.type !== "metrics") return;
      metrics = data;
      if (data.underrunCount > lastUnderrunCount) {
        pendingUnderruns += data.underrunCount - lastUnderrunCount;
        const now = performance.now();
        if (!lastUnderrunReportAt || now - lastUnderrunReportAt >= 2000) {
          recordDebug("worklet-underrun", {
            engine,
            wsolaProfile,
            added: pendingUnderruns,
            total: data.underrunCount,
            framesBuffered: data.framesBuffered,
          });
          pendingUnderruns = 0;
          lastUnderrunReportAt = now;
        }
      }
      lastUnderrunCount = data.underrunCount;
    };

    return {
      engine,
      wsolaProfile,
      node,
      setControls(nextPitch, nextPlaybackRate, smoothPitch = true) {
        const now = audioContext.currentTime;

        // The rate mirror must change immediately with HTMLMediaElement's
        // playbackRate; otherwise Speed temporarily leaks into audible pitch.
        if (nextPlaybackRate !== currentPlaybackRate) {
          setParamImmediately(playbackRateParam, nextPlaybackRate, now);
          currentPlaybackRate = nextPlaybackRate;
        }

        if (nextPitch !== currentPitch) {
          if (smoothPitch && currentPitch !== null) {
            rampPositiveParam(pitchParam, nextPitch, now);
          } else {
            setParamImmediately(pitchParam, nextPitch, now);
          }
          currentPitch = nextPitch;
        }
      },
      getMetrics() {
        return metrics;
      },
    };
  }

  // =====================================================================
  // Wiring / state
  // =====================================================================
  let ctx = null;
  const wired = new Map(); // mediaEl -> { source, branches, primary, routed }
  let curPitch = 0;
  let curMicro = 0;
  let curSpeed = 1;
  let curReverb = 0;
  let curReverbMode = "simple";
  let curReverbSize = DEFAULT_REVERB_SIZE;
  let curReverbDecay = DEFAULT_REVERB_DECAY;
  let curReverbTone = DEFAULT_REVERB_TONE;
  let curReverbPreDelay = DEFAULT_REVERB_PREDELAY;
  let enabled = false;
  let lastHasMedia = null;
  let selectedEngine = ENGINE_WSOLA;
  let selectedWsolaProfile = WSOLA_PROFILE_LOW_LATENCY;
  let workletUrls = null;
  let workletsReady = null;
  let applyGeneration = 0;
  let reportedWorkletError = false;
  let nativeFallbackActive = false;
  let mediaApplyQueued = false;
  const reverbImpulseCache = new Map();
  const debugEvents = [];
  const mediaDebugIds = new WeakMap();
  let nextMediaDebugId = 1;

  // Native values are captured only for media controlled in this tab. Turning
  // the extension off restores them and stops future playbackRate writes.
  const nativeMediaState = new Map();

  // Media elements that aren't necessarily attached to the DOM.
  // Some players (e.g. Spotify Web) play through detached HTMLMediaElements.
  const detachedMedia = new Set();
  const observedDetachedMedia = new WeakSet();

  function mediaDebugId(el) {
    if (!mediaDebugIds.has(el)) mediaDebugIds.set(el, nextMediaDebugId++);
    return mediaDebugIds.get(el);
  }

  function describeMedia(el) {
    const source = el.currentSrc || el.src || "";
    return {
      id: mediaDebugId(el),
      tag: el.tagName?.toLowerCase() || "media",
      connected: el.isConnected,
      paused: el.paused,
      ended: el.ended,
      readyState: el.readyState,
      playbackRate: el.playbackRate,
      defaultPlaybackRate: el.defaultPlaybackRate,
      preservesPitch: el.preservesPitch,
      mozPreservesPitch: el.mozPreservesPitch,
      webkitPreservesPitch: el.webkitPreservesPitch,
      sourceScheme: source.includes(":") ? source.split(":", 1)[0] : "none",
      wired: wired.has(el),
    };
  }

  function recordDebug(type, details = {}) {
    debugEvents.push({
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now()),
      type,
      visibility: document.visibilityState,
      contextState: ctx?.state || "none",
      ...details,
    });
    if (debugEvents.length > DEBUG_EVENT_LIMIT) {
      debugEvents.splice(0, debugEvents.length - DEBUG_EVENT_LIMIT);
    }
  }

  function debugSnapshot() {
    return {
      page: location.hostname,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      enabled,
      controls: {
        pitch: curPitch,
        micro: curMicro,
        speed: curSpeed,
        reverb: curReverb,
      },
      engine: selectedEngine,
      nativeFallbackActive,
      context: ctx
        ? {
            state: ctx.state,
            sampleRate: ctx.sampleRate,
            baseLatency: ctx.baseLatency,
            outputLatency: ctx.outputLatency,
            currentTime: ctx.currentTime,
          }
        : null,
      media: getMedia().map(describeMedia),
      processors: Array.from(wired.entries()).map(([el, node]) => ({
        mediaId: mediaDebugId(el),
        routed: node.routed,
        sourceToEffects: node.sourceToEffects,
        branches: Array.from(node.branches).map((branch) => ({
          engine: branch.shifter.engine,
          wsolaProfile: branch.shifter.wsolaProfile,
          metrics: branch.shifter.getMetrics(),
        })),
      })),
    };
  }

  Object.defineProperty(window, "__pitchShifterDebug", {
    configurable: true,
    value: {
      snapshot: debugSnapshot,
      events: () => debugEvents.slice(),
      report: () => ({ snapshot: debugSnapshot(), events: debugEvents.slice() }),
      clear: () => { debugEvents.length = 0; },
    },
  });

  // Catch media playback even when the element is not in document.body.
  const nativePlay = HTMLMediaElement.prototype.play;

  HTMLMediaElement.prototype.play = function (...args) {
    detachedMedia.add(this);
    observeDetachedMedia(this);

    const result = nativePlay.apply(this, args);

    // Run after the page's synchronous play() setup without depending on a
    // timer. Firefox can heavily delay timers while its window is minimized.
    queueMediaApply();

    return result;
  };

  const mult = () => (curPitch + curMicro) / 12;
  const desiredPitchRatio = () => Math.pow(2, mult());

  function clampedNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function readReverbControls(data) {
    curReverb = clampedNumber(data.reverb, 0, 1, 0);
    curReverbMode = data.reverbMode === "advanced" ? "advanced" : "simple";
    curReverbSize = clampedNumber(
      data.reverbSize,
      0.5,
      1.5,
      DEFAULT_REVERB_SIZE,
    );
    curReverbDecay = clampedNumber(
      data.reverbDecay,
      0.8,
      5,
      DEFAULT_REVERB_DECAY,
    );
    curReverbTone = clampedNumber(
      data.reverbTone,
      0,
      1,
      DEFAULT_REVERB_TONE,
    );
    curReverbPreDelay = clampedNumber(
      data.reverbPreDelay,
      0,
      0.1,
      DEFAULT_REVERB_PREDELAY,
    );
  }

  // Hysteresis prevents the engine from toggling repeatedly while the slider
  // hovers around 50%. Once phase mode starts below 45%, WSOLA only returns
  // above 55%.
  function chooseEngine() {
    if (selectedEngine === ENGINE_WSOLA && curSpeed < PHASE_ENTER_SPEED) {
      selectedEngine = ENGINE_PHASE;
    } else if (selectedEngine === ENGINE_PHASE && curSpeed > PHASE_EXIT_SPEED) {
      selectedEngine = ENGINE_WSOLA;
    }
    return selectedEngine;
  }

  // Pitch and Speed are independent controls. The official processor receives
  // them separately and performs desiredPitch / playbackRate internally.
  const needsShifter = () =>
    enabled && (Math.abs(mult()) > 1e-6 || Math.abs(curSpeed - 1) > 1e-6);
  const needsProcessing = () => needsShifter() || (enabled && curReverb > 1e-6);

  function ensureCtx(requireWorklets = true) {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ latencyHint: "interactive" });
      recordDebug("context-created", {
        sampleRate: ctx.sampleRate,
        baseLatency: ctx.baseLatency,
        outputLatency: ctx.outputLatency,
      });
      ctx.addEventListener("statechange", () => {
        recordDebug("context-state", { state: ctx.state });
        if (enabled && ctx.state === "suspended") {
          ctx.resume().catch((error) => {
            recordDebug("context-resume-failed", {
              name: error?.name,
              message: error?.message,
            });
          });
        }
      });
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    if (!requireWorklets) return Promise.resolve(ctx);
    if (!workletUrls?.wsola || !workletUrls?.phase) {
      return Promise.reject(new Error("PitchShifter worklet URLs are not ready"));
    }
    if (!workletsReady) {
      workletsReady = Promise.all([
        ctx.audioWorklet.addModule(workletUrls.wsola),
        ctx.audioWorklet.addModule(workletUrls.phase),
      ]).catch((error) => {
        workletsReady = null;
        throw error;
      });
    }
    return workletsReady.then(() => ctx);
  }

  function getMedia() {
    const media = new Set(
      document.querySelectorAll("video, audio")
    );

    // Include media elements playing outside the DOM.
    for (const el of detachedMedia) {
      media.add(el);
    }

    return Array.from(media);
  }

  function queueMediaApply() {
    if (mediaApplyQueued) return;
    mediaApplyQueued = true;
    queueMicrotask(() => {
      mediaApplyQueued = false;
      if (!enabled) return;
      try {
        apply();
        postState();
      } catch (e) {}
    });
  }

  function isMediaElement(value) {
    return value instanceof HTMLMediaElement;
  }

  // Spotify and other players may restore playbackRate/defaultPlaybackRate
  // while changing tracks or moving into background playback. The worklet
  // must see the same rate as the media element or its pitch compensation is
  // mathematically wrong, so reassert the selected speed on the ratechange
  // event instead of polling with a background-throttled timer.
  function handleMediaLifecycle(event) {
    const el = event.target;
    if (!isMediaElement(el) || !enabled) return;

    if (needsShifter()) {
      const expectedPreservesPitch = nativeFallbackActive;
      if (
        Math.abs(el.playbackRate - curSpeed) > 1e-6 ||
        Math.abs(el.defaultPlaybackRate - curSpeed) > 1e-6 ||
        el.preservesPitch !== expectedPreservesPitch
      ) {
        recordDebug("media-setting-changed", {
          event: event.type,
          expectedSpeed: curSpeed,
          expectedPreservesPitch,
          media: describeMedia(el),
        });
      }
      applyControlledSpeed(el, nativeFallbackActive);
    }
    if (event.type !== "timeupdate" && needsProcessing() && !wired.has(el)) {
      queueMediaApply();
    }
  }

  function observeDetachedMedia(el) {
    if (observedDetachedMedia.has(el)) return;
    observedDetachedMedia.add(el);
    ["ratechange", "play", "playing", "loadedmetadata", "timeupdate"].forEach((type) => {
      el.addEventListener(type, handleMediaLifecycle);
    });
  }

  // Capture-phase listeners also cover autoplay and media started through
  // native controls, whose play() call may not pass through page JavaScript.
  ["ratechange", "play", "playing", "loadedmetadata", "timeupdate"].forEach((type) => {
    document.addEventListener(type, handleMediaLifecycle, true);
  });

  function handlePageActivity(event) {
    recordDebug(`page-${event.type}`, {
      focused: document.hasFocus(),
      media: getMedia().map(describeMedia),
    });
    queueMicrotask(() => {
      if (!enabled) return;
      if (needsShifter()) {
        getMedia().forEach((el) => applyControlledSpeed(el, nativeFallbackActive));
      }
      queueMediaApply();
    });
  }

  document.addEventListener("visibilitychange", handlePageActivity);
  window.addEventListener("blur", handlePageActivity);
  window.addEventListener("focus", handlePageActivity);

  function captureNativeState(el) {
    if (!nativeMediaState.has(el)) {
      nativeMediaState.set(el, {
        playbackRate: el.playbackRate,
        defaultPlaybackRate: el.defaultPlaybackRate,
        preservesPitch: el.preservesPitch,
        mozPreservesPitch: el.mozPreservesPitch,
        webkitPreservesPitch: el.webkitPreservesPitch,
      });
    }
  }

  function applyControlledSpeed(el, preservePitch) {
    try {
      captureNativeState(el);
      if (el.preservesPitch !== preservePitch) {
        el.preservesPitch = preservePitch;
      }
      if ("mozPreservesPitch" in el && el.mozPreservesPitch !== preservePitch) {
        el.mozPreservesPitch = preservePitch;
      }
      if (
        "webkitPreservesPitch" in el &&
        el.webkitPreservesPitch !== preservePitch
      ) {
        el.webkitPreservesPitch = preservePitch;
      }
      if (Math.abs(el.defaultPlaybackRate - curSpeed) > 1e-6) {
        el.defaultPlaybackRate = curSpeed;
      }
      if (Math.abs(el.playbackRate - curSpeed) > 1e-6) {
        el.playbackRate = curSpeed;
      }
    } catch (e) {}
  }

  // The browser changes playback speed; our SoundTouch node, not Firefox's
  // built-in algorithm, preserves the chosen audible pitch.
  function applySpeed() {
    if (!enabled) return;
    nativeFallbackActive = false;
    // Reverb by itself must not touch the page's playback or pitch-preservation
    // settings. If Pitch/Speed just returned to neutral, restore them now.
    if (!needsShifter()) {
      restoreSpeed();
      return;
    }
    getMedia().forEach((el) => applyControlledSpeed(el, false));
  }

  // If a browser cannot load the packaged worklet, keep Speed usable with its
  // native pitch preservation instead of leaving media at the wrong pitch.
  function applyNativeSpeedFallback() {
    nativeFallbackActive = true;
    getMedia().forEach((el) => applyControlledSpeed(el, true));
  }

  function restoreSpeed() {
    nativeMediaState.forEach((state, el) => {
      try {
        el.defaultPlaybackRate = state.defaultPlaybackRate;
        el.playbackRate = state.playbackRate;
        if (state.preservesPitch !== undefined) el.preservesPitch = state.preservesPitch;
        if (state.mozPreservesPitch !== undefined) el.mozPreservesPitch = state.mozPreservesPitch;
        if (state.webkitPreservesPitch !== undefined) {
          el.webkitPreservesPitch = state.webkitPreservesPitch;
        }
      } catch (e) {}
    });
    nativeMediaState.clear();
    nativeFallbackActive = false;
  }

  function getReverbSettings() {
    const advanced = curReverbMode === "advanced";
    const size = advanced ? curReverbSize : DEFAULT_REVERB_SIZE;
    const decay = advanced ? curReverbDecay : DEFAULT_REVERB_DECAY;
    const tone = advanced ? curReverbTone : DEFAULT_REVERB_TONE;
    const preDelay = advanced ? curReverbPreDelay : DEFAULT_REVERB_PREDELAY;
    return {
      size,
      decay,
      tone,
      preDelay,
      impulseKey: `${size.toFixed(2)}:${decay.toFixed(1)}`,
    };
  }

  const reverbToneFrequency = (tone) => 2500 * Math.pow(7.2, tone);

  // A few recently used room shapes are cached and shared by all media in the
  // AudioContext. Tone and pre-delay live in realtime nodes and need no rebuild.
  function getReverbImpulse(settings) {
    const cached = reverbImpulseCache.get(settings.impulseKey);
    if (cached) return cached;
    const sampleRate = ctx.sampleRate;
    const length = Math.ceil(sampleRate * settings.decay);
    const lateStart = Math.floor(sampleRate * 0.042 * settings.size);
    const buffer = ctx.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    // Discrete asymmetric reflections provide room shape and stereo location
    // before the dense late field arrives.
    const earlyReflections = [
      [0, 0.56, 0.44],
      [0.008, 0.31, 0.48],
      [0.015, 0.40, -0.29],
      [0.026, -0.25, 0.36],
      [0.039, 0.23, 0.29],
      [0.055, -0.18, -0.24],
      [0.074, 0.15, -0.19],
      [0.098, 0.11, 0.15],
      [0.127, -0.09, 0.12],
    ];
    earlyReflections.forEach(([time, leftGain, rightGain]) => {
      const index = Math.floor(sampleRate * time * settings.size);
      if (index < length) {
        left[index] += leftGain;
        right[index] += rightGain;
      }
    });

    // Prime, mutually incommensurate delays prevent a single metallic echo.
    // Householder feedback mixes every line into all the others on each pass.
    const baseDelayLengths = [
      1423, 1559, 1663, 1789, 1907, 2039,
      2179, 2293, 2411, 2543, 2671, 2797,
    ];
    const delayLengths = baseDelayLengths.map((frames) =>
      Math.max(3, Math.round((frames * sampleRate * settings.size) / 48000) | 1)
    );
    const delayLines = delayLengths.map((frames) => new Float32Array(frames));
    const delayIndices = new Int32Array(delayLengths.length);
    const dampingState = new Float64Array(delayLengths.length);
    const delayed = new Float64Array(delayLengths.length);
    const inputSigns = [1, -1, 1, 1, -1, 1, -1, -1, 1, -1, -1, 1];
    const leftSigns = [1, 1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1];
    const rightSigns = [1, -1, 1, 1, -1, 1, -1, -1, 1, -1, 1, -1];
    const feedback = delayLengths.map((frames, index) =>
      Math.pow(
        10,
        (-3 * (frames / sampleRate)) /
          (settings.decay * (0.875 + (index % 4) * 0.036)),
      )
    );
    const outputNormalization = 1 / Math.sqrt(delayLengths.length);

    // The diffuse layer fills the tiny gaps between FDN echoes. Its low, mid
    // and high bands decay at different rates, as they do in a furnished room.
    let seed = 0x51f15e;
    let commonLow = 0;
    let commonMid = 0;
    let sideLow = 0;
    let sideMid = 0;
    let lowEnvelope = 1;
    let midEnvelope = 1;
    let highEnvelope = 1;
    const lowDecay = Math.pow(10, -3 / (settings.decay * sampleRate));
    const midDecay = Math.pow(10, -3 / (settings.decay * 0.77 * sampleRate));
    const highDecay = Math.pow(10, -3 / (settings.decay * 0.34 * sampleRate));

    for (let frame = 0; frame < length; frame++) {
      let sum = 0;
      let outputLeft = 0;
      let outputRight = 0;
      for (let line = 0; line < delayLines.length; line++) {
        const raw = delayLines[line][delayIndices[line]];
        const filtered = raw * 0.68 + dampingState[line] * 0.32;
        dampingState[line] = filtered;
        delayed[line] = filtered;
        sum += filtered;
        outputLeft += filtered * leftSigns[line];
        outputRight += filtered * rightSigns[line];
      }

      const injection = frame === 0 ? 1 : 0;
      for (let line = 0; line < delayLines.length; line++) {
        const mixed = delayed[line] - (2 * sum) / delayLines.length;
        delayLines[line][delayIndices[line]] =
          injection * inputSigns[line] + mixed * feedback[line];
        delayIndices[line] = (delayIndices[line] + 1) % delayLengths[line];
      }

      const time = frame / sampleRate;
      const flutter =
        1 +
        0.025 * Math.sin(2 * Math.PI * 0.37 * time) +
        0.018 * Math.sin(2 * Math.PI * 0.61 * time + 0.8);
      const endFade = Math.min(1, (length - frame) / (sampleRate * 0.18));
      const commonOutput = sum * 0.14;
      left[frame] +=
        (outputLeft * 0.86 + commonOutput) *
        outputNormalization * 1.45 * flutter * endFade;
      right[frame] +=
        (outputRight * 0.86 + commonOutput) *
        outputNormalization * 1.45 * flutter * endFade;

      if (frame >= lateStart) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const commonNoise = (seed / 0x100000000) * 2 - 1;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const sideNoise = (seed / 0x100000000) * 2 - 1;
        commonLow += 0.025 * (commonNoise - commonLow);
        commonMid += 0.2 * (commonNoise - commonMid);
        sideLow += 0.025 * (sideNoise - sideLow);
        sideMid += 0.2 * (sideNoise - sideMid);

        const common =
          commonLow * 0.62 * lowEnvelope +
          (commonMid - commonLow) * 0.78 * midEnvelope +
          (commonNoise - commonMid) * 0.2 * highEnvelope;
        const side =
          sideLow * 0.62 * lowEnvelope +
          (sideMid - sideLow) * 0.78 * midEnvelope +
          (sideNoise - sideMid) * 0.2 * highEnvelope;
        const lateTime = (frame - lateStart) / sampleRate;
        const density = 1 - Math.exp(-lateTime * 52);
        const diffuseScale = density * flutter * endFade * 0.075;
        left[frame] += (common * 0.78 + side * 0.48) * diffuseScale;
        right[frame] += (common * 0.78 - side * 0.48) * diffuseScale;
        lowEnvelope *= lowDecay;
        midEnvelope *= midDecay;
        highEnvelope *= highDecay;
      }
    }

    reverbImpulseCache.set(settings.impulseKey, buffer);
    while (reverbImpulseCache.size > REVERB_IR_CACHE_LIMIT) {
      reverbImpulseCache.delete(reverbImpulseCache.keys().next().value);
    }
    return buffer;
  }

  function createEffects() {
    const input = ctx.createGain();
    const dry = ctx.createGain();
    setParamImmediately(dry.gain, 1, ctx.currentTime);
    input.connect(dry);
    dry.connect(ctx.destination);
    return {
      input,
      dry,
      wetBranches: new Set(),
      primaryWet: null,
      mix: null,
      generation: 0,
    };
  }

  function setWetBranchRealtime(branch, settings, smooth = true) {
    const now = ctx.currentTime;
    const toneFrequency = Math.min(
      ctx.sampleRate * 0.45,
      reverbToneFrequency(settings.tone),
    );
    if (smooth) {
      rampLinearParam(branch.preDelay.delayTime, settings.preDelay, now, REVERB_RAMP_SECONDS);
      rampLinearParam(branch.tone.frequency, toneFrequency, now, REVERB_RAMP_SECONDS);
    } else {
      setParamImmediately(branch.preDelay.delayTime, settings.preDelay, now);
      setParamImmediately(branch.tone.frequency, toneFrequency, now);
    }
  }

  function createWetBranch(effects, settings, initialGain) {
    const preDelay = ctx.createDelay(0.12);
    const convolver = ctx.createConvolver();
    const tone = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    convolver.buffer = getReverbImpulse(settings);
    convolver.normalize = true;
    tone.type = "lowpass";
    setParamImmediately(tone.Q, 0.7, ctx.currentTime);
    setParamImmediately(gain.gain, initialGain, ctx.currentTime);
    const branch = {
      preDelay,
      convolver,
      tone,
      gain,
      impulseKey: settings.impulseKey,
    };
    setWetBranchRealtime(branch, settings, false);
    effects.input.connect(preDelay);
    preDelay.connect(convolver);
    convolver.connect(tone);
    tone.connect(gain);
    gain.connect(ctx.destination);
    effects.wetBranches.add(branch);
    return branch;
  }

  function disconnectWetBranch(effects, branch) {
    if (!branch || !effects.wetBranches.has(branch)) return;
    try { effects.input.disconnect(branch.preDelay); } catch (e) {}
    try { branch.preDelay.disconnect(); } catch (e) {}
    try { branch.convolver.disconnect(); } catch (e) {}
    try { branch.tone.disconnect(); } catch (e) {}
    try { branch.gain.disconnect(); } catch (e) {}
    effects.wetBranches.delete(branch);
    if (effects.primaryWet === branch) effects.primaryWet = null;
  }

  function disconnectWet(effects) {
    Array.from(effects.wetBranches).forEach((branch) =>
      disconnectWetBranch(effects, branch)
    );
  }

  function ensureWetConfiguration(effects, settings, wetLevel, smooth) {
    if (effects.primaryWet?.impulseKey === settings.impulseKey) {
      effects.wetBranches.forEach((branch) =>
        setWetBranchRealtime(branch, settings, smooth)
      );
      return false;
    }

    const oldBranches = Array.from(effects.wetBranches);
    const replacement = createWetBranch(effects, settings, oldBranches.length ? 0 : wetLevel);
    effects.primaryWet = replacement;
    if (!oldBranches.length || !smooth) {
      oldBranches.forEach((branch) => disconnectWetBranch(effects, branch));
      setParamImmediately(replacement.gain.gain, wetLevel, ctx.currentTime);
      return true;
    }

    const now = ctx.currentTime;
    oldBranches.forEach((branch) => {
      setWetBranchRealtime(branch, settings);
      rampLinearParam(
        branch.gain.gain,
        0,
        now,
        REVERB_CONFIG_CROSSFADE_SECONDS,
      );
    });
    rampLinearParam(
      replacement.gain.gain,
      wetLevel,
      now,
      REVERB_CONFIG_CROSSFADE_SECONDS,
    );
    setTimeout(() => {
      oldBranches.forEach((branch) => disconnectWetBranch(effects, branch));
    }, (REVERB_CONFIG_CROSSFADE_SECONDS + 0.03) * 1000);
    return true;
  }

  function setReverbMix(effects, mix, smooth = true, settings = getReverbSettings()) {
    const normalizedMix = Math.max(0, Math.min(1, mix));
    const generation = ++effects.generation;
    const dryLevel = Math.cos(normalizedMix * Math.PI * 0.5);
    const wetLevel = Math.sin(normalizedMix * Math.PI * 0.5);
    const configurationChanged =
      normalizedMix > 0
        ? ensureWetConfiguration(effects, settings, wetLevel, smooth)
        : false;
    if (
      effects.mix === normalizedMix &&
      !configurationChanged &&
      (normalizedMix === 0 || effects.primaryWet)
    ) {
      return;
    }

    const now = ctx.currentTime;
    if (smooth && effects.mix !== null) {
      rampLinearParam(effects.dry.gain, dryLevel, now, REVERB_RAMP_SECONDS);
      if (!configurationChanged && effects.primaryWet) {
        rampLinearParam(
          effects.primaryWet.gain.gain,
          wetLevel,
          now,
          REVERB_RAMP_SECONDS,
        );
      }
    } else {
      setParamImmediately(effects.dry.gain, dryLevel, now);
      if (!configurationChanged && effects.primaryWet) {
        setParamImmediately(effects.primaryWet.gain.gain, wetLevel, now);
      }
    }
    effects.mix = normalizedMix;

    if (normalizedMix === 0) {
      if (!smooth) {
        disconnectWet(effects);
      } else {
        effects.wetBranches.forEach((branch) =>
          rampLinearParam(branch.gain.gain, 0, now, REVERB_RAMP_SECONDS)
        );
        setTimeout(() => {
          if (effects.generation === generation && effects.mix === 0) {
            disconnectWet(effects);
          }
        }, (REVERB_RAMP_SECONDS + 0.02) * 1000);
      }
    }
  }

  // Capture one element. A normal activation uses one wet branch; a temporary
  // second branch is only present while changing engines.
  function wire(el) {
    if (wired.has(el)) return wired.get(el);
    let source;
    try {
      source = ctx.createMediaElementSource(el);
    } catch (e) {
      // Already captured, or cross-origin without CORS.
      recordDebug("wire-failed", {
        media: describeMedia(el),
        name: e?.name,
        message: e?.message,
      });
      return null;
    }
    const node = {
      source,
      effects: createEffects(),
      branches: new Set(),
      primary: null,
      routed: false,
      sourceToEffects: false,
    };
    wired.set(el, node);
    try {
      route(node);
    } catch (error) {
      // createMediaElementSource permanently captures the element, so always
      // leave it connected even if a worklet node fails to construct.
      try { source.connect(ctx.destination); } catch (e) {}
      throw error;
    }
    recordDebug("wire-success", { media: describeMedia(el) });
    return node;
  }

  function disconnectBranch(node, branch) {
    if (!branch || !node.branches.has(branch)) return;
    try { node.source.disconnect(branch.shifter.node); } catch (e) {}
    try { branch.shifter.node.disconnect(); } catch (e) {}
    try { branch.gain.disconnect(); } catch (e) {}
    node.branches.delete(branch);
    if (node.primary === branch) node.primary = null;
  }

  function disconnectBranches(node) {
    Array.from(node.branches).forEach((branch) => disconnectBranch(node, branch));
  }

  function createBranch(node, engine, initialGain) {
    const shifter = createShifter(ctx, engine, curSpeed);
    const gain = ctx.createGain();
    setParamImmediately(gain.gain, initialGain, ctx.currentTime);
    shifter.setControls(desiredPitchRatio(), curSpeed, false);
    node.source.connect(shifter.node);
    shifter.node.connect(gain);
    gain.connect(node.effects.input);
    const branch = { shifter, gain };
    node.branches.add(branch);
    return branch;
  }

  function updateBranchControls(node, smoothPitch = true) {
    node.branches.forEach((branch) => {
      branch.shifter.setControls(desiredPitchRatio(), curSpeed, smoothPitch);
    });
  }

  // Prime the replacement engine silently, then fade between the two. This
  // avoids a mute/click at the WSOLA/phase-vocoder boundary. Old branches are
  // discarded after every fade so buffered audio can never return later.
  function switchEngine(node, engine) {
    const desiredWsolaProfile =
      engine === ENGINE_WSOLA ? wsolaProfileFor(curSpeed) : null;
    if (
      node.primary?.shifter.engine === engine &&
      node.primary?.shifter.wsolaProfile === desiredWsolaProfile
    ) {
      return;
    }
    const oldBranches = Array.from(node.branches);
    const replacement = createBranch(node, engine, 0);
    node.primary = replacement;
    updateBranchControls(node);

    const now = ctx.currentTime;
    const fadeStart = now + ENGINE_WARMUP_SECONDS;
    const fadeEnd = fadeStart + ENGINE_CROSSFADE_SECONDS;

    oldBranches.forEach((branch) => {
      const gainParam = branch.gain.gain;
      if (typeof gainParam.cancelAndHoldAtTime === "function") {
        gainParam.cancelAndHoldAtTime(now);
      } else {
        gainParam.cancelScheduledValues(now);
        gainParam.setValueAtTime(gainParam.value, now);
      }
      gainParam.setValueAtTime(gainParam.value, fadeStart);
      gainParam.linearRampToValueAtTime(0, fadeEnd);
    });

    const replacementGain = replacement.gain.gain;
    replacementGain.cancelScheduledValues(now);
    replacementGain.setValueAtTime(0, fadeStart);
    replacementGain.linearRampToValueAtTime(1, fadeEnd);

    setTimeout(() => {
      oldBranches.forEach((branch) => disconnectBranch(node, branch));
    }, (ENGINE_WARMUP_SECONDS + ENGINE_CROSSFADE_SECONDS + 0.02) * 1000);
  }

  // Keep DSP out of the path when Pitch, Speed and Reverb are neutral. Entering from a
  // neutral state starts a fresh processor; engine-to-engine changes crossfade.
  function route(node, active = needsProcessing(), engine = selectedEngine) {
    if (!active) {
      if (!node.routed) return;
      try { node.source.disconnect(); } catch (e) {}
      disconnectBranches(node);
      node.sourceToEffects = false;
      setReverbMix(node.effects, 0, false);
      node.source.connect(ctx.destination);
      node.routed = false;
      return;
    }

    if (!node.routed) {
      try { node.source.disconnect(); } catch (e) {}
      disconnectBranches(node);
      if (needsShifter()) {
        node.primary = createBranch(node, engine, 1);
        node.sourceToEffects = false;
      } else {
        node.source.connect(node.effects.input);
        node.sourceToEffects = true;
      }
      node.routed = true;
    } else if (needsShifter()) {
      if (node.sourceToEffects) {
        try { node.source.disconnect(node.effects.input); } catch (e) {}
        node.sourceToEffects = false;
        node.primary = createBranch(node, engine, 1);
      } else {
        switchEngine(node, engine);
      }
    } else {
      disconnectBranches(node);
      if (!node.sourceToEffects) {
        node.source.connect(node.effects.input);
        node.sourceToEffects = true;
      }
    }
  }

  function applyNode(node) {
    route(node, needsProcessing(), selectedEngine);
    if (node.routed) {
      updateBranchControls(node);
      setReverbMix(node.effects, curReverb);
    }
  }

  function apply() {
    const generation = ++applyGeneration;
    if (!enabled) return;
    chooseEngine();

    if (!needsProcessing()) {
      wired.forEach(applyNode);
      applySpeed();
      return;
    }

    ensureCtx(needsShifter())
      .then(() => {
        if (generation !== applyGeneration || !enabled) return;
        reportedWorkletError = false;
        // Build the impulse before createMediaElementSource captures playback,
        // so the one-time setup cost cannot create an audible gap.
        if (curReverb > 0) getReverbImpulse(getReverbSettings());
        getMedia().forEach(wire);
        wired.forEach(applyNode);
        applySpeed();
      })
      .catch((error) => {
        if (generation !== applyGeneration || !enabled) return;
        applyNativeSpeedFallback();
        wired.forEach((node) => route(node, false));
        if (!reportedWorkletError) {
          reportedWorkletError = true;
          console.warn("PitchShifter could not start its AudioWorklet", error);
        }
      });
  }

  function postState() {
    window.postMessage(
      {
        source: "pitchshifter-page",
        type: "state",
        hasMedia: getMedia().length > 0,
        enabled,
        pitch: curPitch,
        micro: curMicro,
        speed: curSpeed,
        reverb: curReverb,
        reverbMode: curReverbMode,
        reverbSize: curReverbSize,
        reverbDecay: curReverbDecay,
        reverbTone: curReverbTone,
        reverbPreDelay: curReverbPreDelay,
      },
      "*"
    );
  }

  // Messages from the content script.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== "pitchshifter-cs") return;
    if (
      d.type === "initWorklets" &&
      typeof d.urls?.wsola === "string" &&
      typeof d.urls?.phase === "string"
    ) {
      if (
        workletUrls?.wsola !== d.urls.wsola ||
        workletUrls?.phase !== d.urls.phase
      ) {
        workletUrls = { wsola: d.urls.wsola, phase: d.urls.phase };
        workletsReady = null;
      }
      if (enabled) apply();
    } else if (d.type === "setPitch") {
      enabled = d.enabled !== false;
      curPitch = Number(d.pitch) || 0;
      curMicro = Number(d.micro) || 0;
      curSpeed = Number(d.speed) || 1;
      readReverbControls(d);
      recordDebug("controls-updated", {
        enabled,
        pitch: curPitch,
        micro: curMicro,
        speed: curSpeed,
        reverb: curReverb,
      });
      apply();
      postState();
    } else if (d.type === "setEnabled") {
      curPitch = Number(d.pitch) || 0;
      curMicro = Number(d.micro) || 0;
      curSpeed = Number(d.speed) || 1;
      readReverbControls(d);
      enabled = !!d.enabled;
      recordDebug("enabled-updated", { enabled });
      if (enabled) {
        apply();
      } else {
        applyGeneration++;
        wired.forEach((node) => route(node, false));
        restoreSpeed();
      }
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
      if (enabled) apply();
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
