// injected.js — runs in the PAGE world.
// Routes every <video>/<audio> element through a SoundTouch pitch shifter and
// applies the pitch chosen in the popup. Pitch shift (octaves) =
// (pitch + micro) / 12. Speed (playbackRate) is applied on the element with
// pitch preserved.
//
// SoundTouch is a time-domain engine (WSOLA time-stretch + resampling), so it
// has none of the "phasiness" / metallic artifacts of FFT phase vocoders. It
// runs inside a ScriptProcessorNode: AudioWorklet modules must load from a URL
// which page CSPs (YouTube, etc.) block, while ScriptProcessorNode runs inline
// and works everywhere. Deprecated but fully supported in Firefox.
(function () {
  if (window.__pitchShifterInjected) return;
  window.__pitchShifterInjected = true;

  // ---- Vendored SoundTouch JS (LGPL-2.1) DSP classes ----
  /*
   * SoundTouch JS v0.3.0 audio processing library
   * Copyright (c) Olli Parviainen
   * Copyright (c) Ryan Berdeen
   * Copyright (c) Jakub Fiala
   * Copyright (c) Steve 'Cutter' Blades
   *
   * This library is free software; you can redistribute it and/or
   * modify it under the terms of the GNU Lesser General Public
   * License as published by the Free Software Foundation; either
   * version 2.1 of the License, or (at your option) any later version.
   *
   * This library is distributed in the hope that it will be useful,
   * but WITHOUT ANY WARRANTY; without even the implied warranty of
   * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   * Lesser General Public License for more details.
   *
   * You should have received a copy of the GNU Lesser General Public
   * License along with this library; if not, write to the Free Software
   * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
   */
  class FifoSampleBuffer {
    constructor() {
      this._vector = new Float32Array();
      this._position = 0;
      this._frameCount = 0;
    }
    get vector() {
      return this._vector;
    }
    get position() {
      return this._position;
    }
    get startIndex() {
      return this._position * 2;
    }
    get frameCount() {
      return this._frameCount;
    }
    get endIndex() {
      return (this._position + this._frameCount) * 2;
    }
    clear() {
      this._vector.fill(0);
      this._position = 0;
      this._frameCount = 0;
    }
    put(numFrames) {
      this._frameCount += numFrames;
    }
    putSamples(samples, position, numFrames = 0) {
      position = position || 0;
      const sourceOffset = position * 2;
      if (!(numFrames >= 0)) {
        numFrames = (samples.length - sourceOffset) / 2;
      }
      const numSamples = numFrames * 2;
      this.ensureCapacity(numFrames + this._frameCount);
      const destOffset = this.endIndex;
      this.vector.set(samples.subarray(sourceOffset, sourceOffset + numSamples), destOffset);
      this._frameCount += numFrames;
    }
    putBuffer(buffer, position, numFrames = 0) {
      position = position || 0;
      if (!(numFrames >= 0)) {
        numFrames = buffer.frameCount - position;
      }
      this.putSamples(buffer.vector, buffer.position + position, numFrames);
    }
    receive(numFrames) {
      if (!(numFrames >= 0) || numFrames > this._frameCount) {
        numFrames = this.frameCount;
      }
      this._frameCount -= numFrames;
      this._position += numFrames;
    }
    receiveSamples(output, numFrames = 0) {
      const numSamples = numFrames * 2;
      const sourceOffset = this.startIndex;
      output.set(this._vector.subarray(sourceOffset, sourceOffset + numSamples));
      this.receive(numFrames);
    }
    extract(output, position = 0, numFrames = 0) {
      const sourceOffset = this.startIndex + position * 2;
      const numSamples = numFrames * 2;
      output.set(this._vector.subarray(sourceOffset, sourceOffset + numSamples));
    }
    ensureCapacity(numFrames = 0) {
      const minLength = parseInt(numFrames * 2);
      if (this._vector.length < minLength) {
        const newVector = new Float32Array(minLength);
        newVector.set(this._vector.subarray(this.startIndex, this.endIndex));
        this._vector = newVector;
        this._position = 0;
      } else {
        this.rewind();
      }
    }
    ensureAdditionalCapacity(numFrames = 0) {
      this.ensureCapacity(this._frameCount + numFrames);
    }
    rewind() {
      if (this._position > 0) {
        this._vector.set(this._vector.subarray(this.startIndex, this.endIndex));
        this._position = 0;
      }
    }
  }
  class AbstractFifoSamplePipe {
    constructor(createBuffers) {
      if (createBuffers) {
        this._inputBuffer = new FifoSampleBuffer();
        this._outputBuffer = new FifoSampleBuffer();
      } else {
        this._inputBuffer = this._outputBuffer = null;
      }
    }
    get inputBuffer() {
      return this._inputBuffer;
    }
    set inputBuffer(inputBuffer) {
      this._inputBuffer = inputBuffer;
    }
    get outputBuffer() {
      return this._outputBuffer;
    }
    set outputBuffer(outputBuffer) {
      this._outputBuffer = outputBuffer;
    }
    clear() {
      this._inputBuffer.clear();
      this._outputBuffer.clear();
    }
  }
  class RateTransposer extends AbstractFifoSamplePipe {
    constructor(createBuffers) {
      super(createBuffers);
      this.reset();
      this._rate = 1;
    }
    set rate(rate) {
      this._rate = rate;
    }
    reset() {
      this.slopeCount = 0;
      this.prevSampleL = 0;
      this.prevSampleR = 0;
    }
    clear() {
      super.clear();
      this.reset();
    }
    clone() {
      const result = new RateTransposer();
      result.rate = this._rate;
      return result;
    }
    process() {
      const numFrames = this._inputBuffer.frameCount;
      this._outputBuffer.ensureAdditionalCapacity(numFrames / this._rate + 1);
      const numFramesOutput = this.transpose(numFrames);
      this._inputBuffer.receive();
      this._outputBuffer.put(numFramesOutput);
    }
    transpose(numFrames = 0) {
      if (numFrames === 0) {
        return 0;
      }
      const src = this._inputBuffer.vector;
      const srcOffset = this._inputBuffer.startIndex;
      const dest = this._outputBuffer.vector;
      const destOffset = this._outputBuffer.endIndex;
      let used = 0;
      let i = 0;
      while (this.slopeCount < 1.0) {
        dest[destOffset + 2 * i] = (1.0 - this.slopeCount) * this.prevSampleL + this.slopeCount * src[srcOffset];
        dest[destOffset + 2 * i + 1] = (1.0 - this.slopeCount) * this.prevSampleR + this.slopeCount * src[srcOffset + 1];
        i = i + 1;
        this.slopeCount += this._rate;
      }
      this.slopeCount -= 1.0;
      if (numFrames !== 1) {
        out: while (true) {
          while (this.slopeCount > 1.0) {
            this.slopeCount -= 1.0;
            used = used + 1;
            if (used >= numFrames - 1) {
              break out;
            }
          }
          const srcIndex = srcOffset + 2 * used;
          dest[destOffset + 2 * i] = (1.0 - this.slopeCount) * src[srcIndex] + this.slopeCount * src[srcIndex + 2];
          dest[destOffset + 2 * i + 1] = (1.0 - this.slopeCount) * src[srcIndex + 1] + this.slopeCount * src[srcIndex + 3];
          i = i + 1;
          this.slopeCount += this._rate;
        }
      }
      this.prevSampleL = src[srcOffset + 2 * numFrames - 2];
      this.prevSampleR = src[srcOffset + 2 * numFrames - 1];
      return i;
    }
  }
  const USE_AUTO_SEQUENCE_LEN = 0;
  const DEFAULT_SEQUENCE_MS = USE_AUTO_SEQUENCE_LEN;
  const USE_AUTO_SEEKWINDOW_LEN = 0;
  const DEFAULT_SEEKWINDOW_MS = USE_AUTO_SEEKWINDOW_LEN;
  const DEFAULT_OVERLAP_MS = 8;
  const _SCAN_OFFSETS = [[124, 186, 248, 310, 372, 434, 496, 558, 620, 682, 744, 806, 868, 930, 992, 1054, 1116, 1178, 1240, 1302, 1364, 1426, 1488, 0], [-100, -75, -50, -25, 25, 50, 75, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [-20, -15, -10, -5, 5, 10, 15, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [-4, -3, -2, -1, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]];
  const AUTOSEQ_TEMPO_LOW = 0.25;
  const AUTOSEQ_TEMPO_TOP = 4.0;
  const AUTOSEQ_AT_MIN = 125.0;
  const AUTOSEQ_AT_MAX = 50.0;
  const AUTOSEQ_K = (AUTOSEQ_AT_MAX - AUTOSEQ_AT_MIN) / (AUTOSEQ_TEMPO_TOP - AUTOSEQ_TEMPO_LOW);
  const AUTOSEQ_C = AUTOSEQ_AT_MIN - AUTOSEQ_K * AUTOSEQ_TEMPO_LOW;
  const AUTOSEEK_AT_MIN = 25.0;
  const AUTOSEEK_AT_MAX = 15.0;
  const AUTOSEEK_K = (AUTOSEEK_AT_MAX - AUTOSEEK_AT_MIN) / (AUTOSEQ_TEMPO_TOP - AUTOSEQ_TEMPO_LOW);
  const AUTOSEEK_C = AUTOSEEK_AT_MIN - AUTOSEEK_K * AUTOSEQ_TEMPO_LOW;
  class Stretch extends AbstractFifoSamplePipe {
    constructor(createBuffers) {
      super(createBuffers);
      this._quickSeek = true;
      this.midBufferDirty = false;
      this.midBuffer = null;
      this.overlapLength = 0;
      this.autoSeqSetting = true;
      this.autoSeekSetting = true;
      this._tempo = 1;
      this.setParameters(44100, DEFAULT_SEQUENCE_MS, DEFAULT_SEEKWINDOW_MS, DEFAULT_OVERLAP_MS);
    }
    clear() {
      super.clear();
      this.clearMidBuffer();
    }
    clearMidBuffer() {
      this.midBufferDirty = false;
      this.midBuffer = null;
      if (this.refMidBuffer) {
        this.refMidBuffer.fill(0);
      }
      this.skipFract = 0;
    }
    setParameters(sampleRate, sequenceMs, seekWindowMs, overlapMs) {
      if (sampleRate > 0) {
        this.sampleRate = sampleRate;
      }
      if (overlapMs > 0) {
        this.overlapMs = overlapMs;
      }
      if (sequenceMs > 0) {
        this.sequenceMs = sequenceMs;
        this.autoSeqSetting = false;
      } else {
        this.autoSeqSetting = true;
      }
      if (seekWindowMs > 0) {
        this.seekWindowMs = seekWindowMs;
        this.autoSeekSetting = false;
      } else {
        this.autoSeekSetting = true;
      }
      this.calculateSequenceParameters();
      this.calculateOverlapLength(this.overlapMs);
      this.tempo = this._tempo;
    }
    set tempo(newTempo) {
      let intskip;
      this._tempo = newTempo;
      this.calculateSequenceParameters();
      this.nominalSkip = this._tempo * (this.seekWindowLength - this.overlapLength);
      this.skipFract = 0;
      intskip = Math.floor(this.nominalSkip + 0.5);
      this.sampleReq = Math.max(intskip + this.overlapLength, this.seekWindowLength) + this.seekLength;
    }
    get tempo() {
      return this._tempo;
    }
    get inputChunkSize() {
      return this.sampleReq;
    }
    get outputChunkSize() {
      return this.overlapLength + Math.max(0, this.seekWindowLength - 2 * this.overlapLength);
    }
    calculateOverlapLength(overlapInMsec = 0) {
      let newOvl;
      newOvl = this.sampleRate * overlapInMsec / 1000;
      newOvl = newOvl < 16 ? 16 : newOvl;
      newOvl -= newOvl % 8;
      this.overlapLength = newOvl;
      this.refMidBuffer = new Float32Array(this.overlapLength * 2);
      this.midBuffer = new Float32Array(this.overlapLength * 2);
    }
    checkLimits(x, mi, ma) {
      return x < mi ? mi : x > ma ? ma : x;
    }
    calculateSequenceParameters() {
      let seq;
      let seek;
      if (this.autoSeqSetting) {
        seq = AUTOSEQ_C + AUTOSEQ_K * this._tempo;
        seq = this.checkLimits(seq, AUTOSEQ_AT_MAX, AUTOSEQ_AT_MIN);
        this.sequenceMs = Math.floor(seq + 0.5);
      }
      if (this.autoSeekSetting) {
        seek = AUTOSEEK_C + AUTOSEEK_K * this._tempo;
        seek = this.checkLimits(seek, AUTOSEEK_AT_MAX, AUTOSEEK_AT_MIN);
        this.seekWindowMs = Math.floor(seek + 0.5);
      }
      this.seekWindowLength = Math.floor(this.sampleRate * this.sequenceMs / 1000);
      this.seekLength = Math.floor(this.sampleRate * this.seekWindowMs / 1000);
    }
    set quickSeek(enable) {
      this._quickSeek = enable;
    }
    clone() {
      const result = new Stretch();
      result.tempo = this._tempo;
      result.setParameters(this.sampleRate, this.sequenceMs, this.seekWindowMs, this.overlapMs);
      return result;
    }
    seekBestOverlapPosition() {
      return this._quickSeek ? this.seekBestOverlapPositionStereoQuick() : this.seekBestOverlapPositionStereo();
    }
    seekBestOverlapPositionStereo() {
      let bestOffset;
      let bestCorrelation;
      let correlation;
      let i = 0;
      this.preCalculateCorrelationReferenceStereo();
      bestOffset = 0;
      bestCorrelation = Number.MIN_VALUE;
      for (; i < this.seekLength; i = i + 1) {
        correlation = this.calculateCrossCorrelationStereo(2 * i, this.refMidBuffer);
        if (correlation > bestCorrelation) {
          bestCorrelation = correlation;
          bestOffset = i;
        }
      }
      return bestOffset;
    }
    seekBestOverlapPositionStereoQuick() {
      let bestOffset;
      let bestCorrelation;
      let correlation;
      let scanCount = 0;
      let correlationOffset;
      let tempOffset;
      this.preCalculateCorrelationReferenceStereo();
      bestCorrelation = Number.MIN_VALUE;
      bestOffset = 0;
      correlationOffset = 0;
      tempOffset = 0;
      for (; scanCount < 4; scanCount = scanCount + 1) {
        let j = 0;
        while (_SCAN_OFFSETS[scanCount][j]) {
          tempOffset = correlationOffset + _SCAN_OFFSETS[scanCount][j];
          if (tempOffset >= this.seekLength) {
            break;
          }
          correlation = this.calculateCrossCorrelationStereo(2 * tempOffset, this.refMidBuffer);
          if (correlation > bestCorrelation) {
            bestCorrelation = correlation;
            bestOffset = tempOffset;
          }
          j = j + 1;
        }
        correlationOffset = bestOffset;
      }
      return bestOffset;
    }
    preCalculateCorrelationReferenceStereo() {
      let i = 0;
      let context;
      let temp;
      for (; i < this.overlapLength; i = i + 1) {
        temp = i * (this.overlapLength - i);
        context = i * 2;
        this.refMidBuffer[context] = this.midBuffer[context] * temp;
        this.refMidBuffer[context + 1] = this.midBuffer[context + 1] * temp;
      }
    }
    calculateCrossCorrelationStereo(mixingPosition, compare) {
      const mixing = this._inputBuffer.vector;
      mixingPosition += this._inputBuffer.startIndex;
      let correlation = 0;
      let i = 2;
      const calcLength = 2 * this.overlapLength;
      let mixingOffset;
      for (; i < calcLength; i = i + 2) {
        mixingOffset = i + mixingPosition;
        correlation += mixing[mixingOffset] * compare[i] + mixing[mixingOffset + 1] * compare[i + 1];
      }
      return correlation;
    }
    overlap(overlapPosition) {
      this.overlapStereo(2 * overlapPosition);
    }
    overlapStereo(inputPosition) {
      const input = this._inputBuffer.vector;
      inputPosition += this._inputBuffer.startIndex;
      const output = this._outputBuffer.vector;
      const outputPosition = this._outputBuffer.endIndex;
      let i = 0;
      let context;
      let tempFrame;
      const frameScale = 1 / this.overlapLength;
      let fi;
      let inputOffset;
      let outputOffset;
      for (; i < this.overlapLength; i = i + 1) {
        tempFrame = (this.overlapLength - i) * frameScale;
        fi = i * frameScale;
        context = 2 * i;
        inputOffset = context + inputPosition;
        outputOffset = context + outputPosition;
        output[outputOffset + 0] = input[inputOffset + 0] * fi + this.midBuffer[context + 0] * tempFrame;
        output[outputOffset + 1] = input[inputOffset + 1] * fi + this.midBuffer[context + 1] * tempFrame;
      }
    }
    process() {
      let offset;
      let temp;
      let overlapSkip;
      if (this.midBuffer === null) {
        if (this._inputBuffer.frameCount < this.overlapLength) {
          return;
        }
        this.midBuffer = new Float32Array(this.overlapLength * 2);
        this._inputBuffer.receiveSamples(this.midBuffer, this.overlapLength);
      }
      while (this._inputBuffer.frameCount >= this.sampleReq) {
        offset = this.seekBestOverlapPosition();
        this._outputBuffer.ensureAdditionalCapacity(this.overlapLength);
        this.overlap(Math.floor(offset));
        this._outputBuffer.put(this.overlapLength);
        temp = this.seekWindowLength - 2 * this.overlapLength;
        if (temp > 0) {
          this._outputBuffer.putBuffer(this._inputBuffer, offset + this.overlapLength, temp);
        }
        const start = this._inputBuffer.startIndex + 2 * (offset + this.seekWindowLength - this.overlapLength);
        this.midBuffer.set(this._inputBuffer.vector.subarray(start, start + 2 * this.overlapLength));
        this.skipFract += this.nominalSkip;
        overlapSkip = Math.floor(this.skipFract);
        this.skipFract -= overlapSkip;
        this._inputBuffer.receive(overlapSkip);
      }
    }
  }
  const testFloatEqual = function (a, b) {
    return (a > b ? a - b : b - a) > 1e-10;
  };

  class SoundTouch {
    constructor() {
      this.transposer = new RateTransposer(false);
      this.stretch = new Stretch(false);
      this._inputBuffer = new FifoSampleBuffer();
      this._intermediateBuffer = new FifoSampleBuffer();
      this._outputBuffer = new FifoSampleBuffer();
      this._rate = 0;
      this._tempo = 0;
      this.virtualPitch = 1.0;
      this.virtualRate = 1.0;
      this.virtualTempo = 1.0;
      this.calculateEffectiveRateAndTempo();
    }
    clear() {
      this.transposer.clear();
      this.stretch.clear();
    }
    clone() {
      const result = new SoundTouch();
      result.rate = this.rate;
      result.tempo = this.tempo;
      return result;
    }
    get rate() {
      return this._rate;
    }
    set rate(rate) {
      this.virtualRate = rate;
      this.calculateEffectiveRateAndTempo();
    }
    set rateChange(rateChange) {
      this._rate = 1.0 + 0.01 * rateChange;
    }
    get tempo() {
      return this._tempo;
    }
    set tempo(tempo) {
      this.virtualTempo = tempo;
      this.calculateEffectiveRateAndTempo();
    }
    set tempoChange(tempoChange) {
      this.tempo = 1.0 + 0.01 * tempoChange;
    }
    set pitch(pitch) {
      this.virtualPitch = pitch;
      this.calculateEffectiveRateAndTempo();
    }
    set pitchOctaves(pitchOctaves) {
      this.pitch = Math.exp(0.69314718056 * pitchOctaves);
      this.calculateEffectiveRateAndTempo();
    }
    set pitchSemitones(pitchSemitones) {
      this.pitchOctaves = pitchSemitones / 12.0;
    }
    get inputBuffer() {
      return this._inputBuffer;
    }
    get outputBuffer() {
      return this._outputBuffer;
    }
    calculateEffectiveRateAndTempo() {
      const previousTempo = this._tempo;
      const previousRate = this._rate;
      this._tempo = this.virtualTempo / this.virtualPitch;
      this._rate = this.virtualRate * this.virtualPitch;
      if (testFloatEqual(this._tempo, previousTempo)) {
        this.stretch.tempo = this._tempo;
      }
      if (testFloatEqual(this._rate, previousRate)) {
        this.transposer.rate = this._rate;
      }
      if (this._rate > 1.0) {
        if (this._outputBuffer != this.transposer.outputBuffer) {
          this.stretch.inputBuffer = this._inputBuffer;
          this.stretch.outputBuffer = this._intermediateBuffer;
          this.transposer.inputBuffer = this._intermediateBuffer;
          this.transposer.outputBuffer = this._outputBuffer;
        }
      } else {
        if (this._outputBuffer != this.stretch.outputBuffer) {
          this.transposer.inputBuffer = this._inputBuffer;
          this.transposer.outputBuffer = this._intermediateBuffer;
          this.stretch.inputBuffer = this._intermediateBuffer;
          this.stretch.outputBuffer = this._outputBuffer;
        }
      }
    }
    process() {
      if (this._rate > 1.0) {
        this.stretch.process();
        this.transposer.process();
      } else {
        this.transposer.process();
        this.stretch.process();
      }
    }
  }

  // =====================================================================
  // Shifter: feed live audio through SoundTouch with an output FIFO so the
  // ScriptProcessor always has a full block to emit (no dropouts).
  // =====================================================================
  const BLOCK = 1024;     // ScriptProcessor block size (frames)
  const PRIME = 8192;     // output cushion before reading (covers SoundTouch's
                          // chunked output bursts so the FIFO never underruns)
  const MAXFIFO = 24576;  // cap so latency/memory stay bounded under drift

  function createShifter(ctx) {
    const st = new SoundTouch();
    st.stretch.setParameters(ctx.sampleRate);
    try { st.stretch.quickSeek = false; } catch (e) {} // full search = better quality
    st.tempo = 1; st.rate = 1; st.pitch = 1;

    let curPF = 1;
    let primed = false;
    let fifo = new Float32Array(1 << 16); // interleaved stereo output queue
    let fifoFrames = 0;
    let recv = new Float32Array(1 << 16);
    const interIn = new Float32Array(BLOCK * 2);

    function pushRecv(frames) {
      const need = (fifoFrames + frames) * 2;
      if (need > fifo.length) {
        const nb = new Float32Array(Math.max(need, fifo.length * 2));
        nb.set(fifo.subarray(0, fifoFrames * 2));
        fifo = nb;
      }
      fifo.set(recv.subarray(0, frames * 2), fifoFrames * 2);
      fifoFrames += frames;
      // Bound the queue: if SoundTouch ran ahead, drop the oldest frames.
      if (fifoFrames > MAXFIFO) {
        const drop = fifoFrames - MAXFIFO;
        fifo.copyWithin(0, drop * 2, fifoFrames * 2);
        fifoFrames = MAXFIFO;
      }
    }

    const node = ctx.createScriptProcessor(BLOCK, 2, 2);
    node.onaudioprocess = (ev) => {
      const inB = ev.inputBuffer, outB = ev.outputBuffer;
      const inL = inB.getChannelData(0);
      const inR = inB.numberOfChannels > 1 ? inB.getChannelData(1) : inL;
      const outL = outB.getChannelData(0), outR = outB.getChannelData(1);
      const n = outL.length;

      // Bypass at unity — clean passthrough.
      if (Math.abs(curPF - 1) < 0.005) {
        outL.set(inL); outR.set(inR);
        if (primed) { primed = false; fifoFrames = 0; try { st.clear(); } catch (e) {} }
        return;
      }

      for (let i = 0; i < n; i++) { interIn[2 * i] = inL[i]; interIn[2 * i + 1] = inR[i]; }
      st.inputBuffer.putSamples(interIn, 0, n);
      st.process();
      const got = st.outputBuffer.frameCount;
      if (got > 0) {
        if (recv.length < got * 2) recv = new Float32Array(got * 2);
        st.outputBuffer.receiveSamples(recv, got);
        pushRecv(got);
      }

      if (!primed) {
        if (fifoFrames < PRIME) { outL.fill(0); outR.fill(0); return; }
        primed = true;
      }

      const emit = Math.min(n, fifoFrames);
      for (let i = 0; i < emit; i++) { outL[i] = fifo[2 * i]; outR[i] = fifo[2 * i + 1]; }
      for (let i = emit; i < n; i++) { outL[i] = 0; outR[i] = 0; }
      if (fifoFrames > emit) fifo.copyWithin(0, emit * 2, fifoFrames * 2);
      fifoFrames -= emit;
    };

    return {
      node,
      setPitch(pf) { if (pf !== curPF) { curPF = pf; st.pitch = pf; } },
      reset() { try { st.clear(); } catch (e) {} fifoFrames = 0; primed = false; },
    };
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
    const node = { source, shifter, routed: null };
    route(node);
    wired.set(el, node);
    return node;
  }

  // When neutral (pitch 0), route the element straight to the output so the
  // shifter and its latency are completely out of the path — exactly as if the
  // effect were off. The shifter is only inserted while actually pitch-shifting.
  function route(node) {
    const active = isActive();
    if (node.routed === active) return;
    node.routed = active;
    try { node.source.disconnect(); } catch (e) {}
    try { node.shifter.node.disconnect(); } catch (e) {}
    if (active) {
      node.shifter.reset();
      node.source.connect(node.shifter.node);
      node.shifter.node.connect(ctx.destination);
    } else {
      node.source.connect(ctx.destination);
    }
  }

  function applyNode(node) {
    node.shifter.setPitch(ratio());
    route(node);
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
