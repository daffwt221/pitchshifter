// popup.js — UI logic. Controls pitch, microtones, speed and reverb in this tab.
const api = typeof browser !== "undefined" ? browser : chrome;

// Donation link. Replace YOUR_USERNAME with your Ko-fi (or other) handle.
// Until you do, the Support button stays hidden.
const DONATE_URL = "https://ko-fi.com/daffwt221";

const pitchSlider = document.getElementById("pitchSlider");
const microSlider = document.getElementById("microSlider");
const speedSlider = document.getElementById("speedSlider");
const reverbSlider = document.getElementById("reverbSlider");
const reverbSizeSlider = document.getElementById("reverbSizeSlider");
const reverbDecaySlider = document.getElementById("reverbDecaySlider");
const reverbToneSlider = document.getElementById("reverbToneSlider");
const reverbPreDelaySlider = document.getElementById("reverbPreDelaySlider");
const pitchValue = document.getElementById("pitchValue");
const microValue = document.getElementById("microValue");
const speedValue = document.getElementById("speedValue");
const reverbValue = document.getElementById("reverbValue");
const reverbSizeValue = document.getElementById("reverbSizeValue");
const reverbDecayValue = document.getElementById("reverbDecayValue");
const reverbToneValue = document.getElementById("reverbToneValue");
const reverbPreDelayValue = document.getElementById("reverbPreDelayValue");
const statusEl = document.getElementById("status");
const enabledToggle = document.getElementById("enabledToggle");

let tabId = null;
let enabled = false;
let hasMedia = false;
let pitch = 0; // integer semitones, -12..12
let micro = 0; // fine, -1.00..1.00
let speed = 1; // playback rate, 0.25..2.00
let reverb = 0; // dry/wet mix, 0.00..1.00
let reverbMode = "simple";
let reverbSize = 1;
let reverbDecay = 2.8;
let reverbTone = 0.55;
let reverbPreDelay = 0.016;
let pushFrame = null;
let pushPending = false;

const clampPitch = (v) => Math.max(-12, Math.min(12, Math.round(v)));
const clampMicro = (v) => Math.max(-1, Math.min(1, Math.round(v * 100) / 100));
const clampSpeed = (v) =>
    Math.max(0.25, Math.min(2, Math.round(v * 100) / 100));
const clampReverb = (v) =>
    Math.max(0, Math.min(1, Math.round(v * 100) / 100));
const clampReverbSize = (v) =>
    Math.max(0.5, Math.min(1.5, Math.round(v * 100) / 100));
const clampReverbDecay = (v) =>
    Math.max(0.8, Math.min(5, Math.round(v * 10) / 10));
const clampReverbTone = clampReverb;
const clampReverbPreDelay = (v) =>
    Math.max(0, Math.min(0.1, Math.round(v * 1000) / 1000));

// Pull the slider colors from the active theme's CSS tokens (read fresh so a
// theme switch updates the fills too).
const cssVar = (n) =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// Fill the slider from its neutral point (center) to the thumb, so the bar
// shows how far each control is pushed from its default.
function fillSlider(el, value, min, max, center) {
    const track = cssVar("--track") || "#e4e6e8";
    const fill = cssVar("--accent") || "#c2820f";
    const pct = (v) => ((v - min) / (max - min)) * 100;
    let a = pct(center),
        b = pct(value);
    if (a > b) [a, b] = [b, a];
    el.style.background = `linear-gradient(to right, ${track} 0 ${a}%, ${fill} ${a}% ${b}%, ${track} ${b}% 100%)`;
}

function render() {
    pitchSlider.value = String(pitch);
    microSlider.value = String(micro);
    speedSlider.value = String(speed);
    reverbSlider.value = String(reverb);
    reverbSizeSlider.value = String(reverbSize);
    reverbDecaySlider.value = String(reverbDecay);
    reverbToneSlider.value = String(reverbTone);
    reverbPreDelaySlider.value = String(reverbPreDelay);
    pitchValue.value = (pitch > 0 ? "+" : "") + pitch;
    microValue.value = (micro > 0 ? "+" : "") + micro.toFixed(2);
    speedValue.value = Math.round(speed * 100) + "%";
    reverbValue.value = Math.round(reverb * 100) + "%";
    reverbSizeValue.value = Math.round(reverbSize * 100) + "%";
    reverbDecayValue.value = reverbDecay.toFixed(1) + " s";
    reverbToneValue.value = Math.round(reverbTone * 100) + "%";
    reverbPreDelayValue.value = Math.round(reverbPreDelay * 1000) + " ms";
    fillSlider(pitchSlider, pitch, -12, 12, 0);
    fillSlider(microSlider, micro, -1, 1, 0);
    fillSlider(speedSlider, speed, 0.25, 2, 1);
    fillSlider(reverbSlider, reverb, 0, 1, 0);
    fillSlider(reverbSizeSlider, reverbSize, 0.5, 1.5, 1);
    fillSlider(reverbDecaySlider, reverbDecay, 0.8, 5, 2.8);
    fillSlider(reverbToneSlider, reverbTone, 0, 1, 0.55);
    fillSlider(reverbPreDelaySlider, reverbPreDelay, 0, 0.1, 0.016);
    const advanced = reverbMode === "advanced";
    document.getElementById("advancedControls").hidden = !advanced;
    document.getElementById("simpleMode").classList.toggle("active", !advanced);
    document.getElementById("advancedMode").classList.toggle("active", advanced);
    document.getElementById("simpleMode").setAttribute("aria-pressed", String(!advanced));
    document.getElementById("advancedMode").setAttribute("aria-pressed", String(advanced));
    enabledToggle.textContent = enabled ? "On" : "Off";
    enabledToggle.classList.toggle("on", enabled);
    enabledToggle.setAttribute("aria-pressed", String(enabled));
    enabledToggle.title = enabled ? "Disable on this tab" : "Enable on this tab";
    enabledToggle.setAttribute("aria-label", enabledToggle.title);
}

function sendCurrentSettings() {
    if (!pushPending || tabId == null) return;
    pushPending = false;
    api.tabs
        .sendMessage(tabId, {
            type: "setPitch",
            enabled,
            pitch,
            micro,
            speed,
            reverb,
            reverbMode,
            reverbSize,
            reverbDecay,
            reverbTone,
            reverbPreDelay,
        })
        .catch(() => {});
    api.storage.local
        .set({
            settings: {
                pitch,
                micro,
                speed,
                reverb,
                reverbMode,
                reverbSize,
                reverbDecay,
                reverbTone,
                reverbPreDelay,
            },
        })
        .catch(() => {});
}

function flushPush() {
    if (pushFrame !== null) {
        cancelAnimationFrame(pushFrame);
        pushFrame = null;
    }
    sendCurrentSettings();
}

function push() {
    // Moving any control is an explicit request to use PitchShifter here.
    enabled = true;
    render();
    setStatus(hasMedia);
    if (tabId == null) return;

    // Coalesce dense slider input to one update per visual frame. The final
    // value is flushed immediately by the range control's change event.
    pushPending = true;
    if (pushFrame === null) {
        pushFrame = requestAnimationFrame(() => {
            pushFrame = null;
            sendCurrentSettings();
        });
    }
}

function setPitch(v) {
    pitch = clampPitch(v);
    push();
}

function setMicro(v) {
    micro = clampMicro(v);
    push();
}

function setSpeed(v) {
    speed = clampSpeed(v);
    push();
}

function setReverb(v) {
    reverb = clampReverb(v);
    push();
}

function setReverbMode(mode) {
    reverbMode = mode === "advanced" ? "advanced" : "simple";
    push();
}

function setReverbSize(v) {
    reverbSize = clampReverbSize(v);
    push();
}

function setReverbDecay(v) {
    reverbDecay = clampReverbDecay(v);
    push();
}

function setReverbTone(v) {
    reverbTone = clampReverbTone(v);
    push();
}

function setReverbPreDelay(v) {
    reverbPreDelay = clampReverbPreDelay(v);
    push();
}

pitchSlider.addEventListener("input", (e) =>
    setPitch(parseFloat(e.target.value)),
);
microSlider.addEventListener("input", (e) =>
    setMicro(parseFloat(e.target.value)),
);
speedSlider.addEventListener("input", (e) =>
    setSpeed(parseFloat(e.target.value)),
);
reverbSlider.addEventListener("input", (e) =>
    setReverb(parseFloat(e.target.value)),
);
reverbSizeSlider.addEventListener("input", (e) => {
    reverbSize = clampReverbSize(parseFloat(e.target.value));
    render();
});
reverbDecaySlider.addEventListener("input", (e) => {
    reverbDecay = clampReverbDecay(parseFloat(e.target.value));
    render();
});
reverbToneSlider.addEventListener("input", (e) =>
    setReverbTone(parseFloat(e.target.value)),
);
reverbPreDelaySlider.addEventListener("input", (e) =>
    setReverbPreDelay(parseFloat(e.target.value)),
);
[
    pitchSlider,
    microSlider,
    speedSlider,
    reverbSlider,
    reverbToneSlider,
    reverbPreDelaySlider,
].forEach((slider) =>
    slider.addEventListener("change", flushPush),
);
reverbSizeSlider.addEventListener("change", (e) => {
    setReverbSize(parseFloat(e.target.value));
    flushPush();
});
reverbDecaySlider.addEventListener("change", (e) => {
    setReverbDecay(parseFloat(e.target.value));
    flushPush();
});

document.getElementById("simpleMode").addEventListener("click", () =>
    setReverbMode("simple"),
);
document.getElementById("advancedMode").addEventListener("click", () =>
    setReverbMode("advanced"),
);

document
    .getElementById("pitchMinus")
    .addEventListener("click", () => setPitch(pitch - 1));
document
    .getElementById("pitchPlus")
    .addEventListener("click", () => setPitch(pitch + 1));
document
    .getElementById("microMinus")
    .addEventListener("click", () => setMicro(micro - 0.01));
document
    .getElementById("microPlus")
    .addEventListener("click", () => setMicro(micro + 0.01));
document
    .getElementById("speedMinus")
    .addEventListener("click", () => setSpeed(speed - 0.01));
document
    .getElementById("speedPlus")
    .addEventListener("click", () => setSpeed(speed + 0.01));
document
    .getElementById("reverbMinus")
    .addEventListener("click", () => setReverb(reverb - 0.01));
document
    .getElementById("reverbPlus")
    .addEventListener("click", () => setReverb(reverb + 0.01));
document
    .getElementById("reverbSizeMinus")
    .addEventListener("click", () => setReverbSize(reverbSize - 0.01));
document
    .getElementById("reverbSizePlus")
    .addEventListener("click", () => setReverbSize(reverbSize + 0.01));
document
    .getElementById("reverbDecayMinus")
    .addEventListener("click", () => setReverbDecay(reverbDecay - 0.1));
document
    .getElementById("reverbDecayPlus")
    .addEventListener("click", () => setReverbDecay(reverbDecay + 0.1));
document
    .getElementById("reverbToneMinus")
    .addEventListener("click", () => setReverbTone(reverbTone - 0.01));
document
    .getElementById("reverbTonePlus")
    .addEventListener("click", () => setReverbTone(reverbTone + 0.01));
document
    .getElementById("reverbPreDelayMinus")
    .addEventListener("click", () => setReverbPreDelay(reverbPreDelay - 0.001));
document
    .getElementById("reverbPreDelayPlus")
    .addEventListener("click", () => setReverbPreDelay(reverbPreDelay + 0.001));

document
    .getElementById("pitchReset")
    .addEventListener("click", () => setPitch(0));
document
    .getElementById("microReset")
    .addEventListener("click", () => setMicro(0));
document
    .getElementById("speedReset")
    .addEventListener("click", () => setSpeed(1));
document
    .getElementById("reverbReset")
    .addEventListener("click", () => setReverb(0));
document
    .getElementById("reverbSizeReset")
    .addEventListener("click", () => setReverbSize(1));
document
    .getElementById("reverbDecayReset")
    .addEventListener("click", () => setReverbDecay(2.8));
document
    .getElementById("reverbToneReset")
    .addEventListener("click", () => setReverbTone(0.55));
document
    .getElementById("reverbPreDelayReset")
    .addEventListener("click", () => setReverbPreDelay(0.016));

// Click a value to type it directly. On focus show the raw number; on Enter
// or blur parse it, clamp, and reformat. Escape restores.
function wireValueInput(el, kind) {
    el.addEventListener("focus", () => {
        const rawValues = {
            pitch,
            micro,
            speed: Math.round(speed * 100),
            reverb: Math.round(reverb * 100),
            reverbSize: Math.round(reverbSize * 100),
            reverbDecay,
            reverbTone: Math.round(reverbTone * 100),
            reverbPreDelay: Math.round(reverbPreDelay * 1000),
        };
        el.value = String(rawValues[kind]);
        el.select();
    });
    el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            el.blur();
        } else if (e.key === "Escape") {
            e.preventDefault();
            render();
            el.blur();
        }
    });
    el.addEventListener("blur", () => {
        const num = parseFloat(el.value.replace(/[^0-9.\-]/g, ""));
        if (kind === "pitch") setPitch(Number.isFinite(num) ? num : pitch);
        else if (kind === "micro") setMicro(Number.isFinite(num) ? num : micro);
        else if (kind === "speed") setSpeed(Number.isFinite(num) ? num / 100 : speed);
        else if (kind === "reverb") setReverb(Number.isFinite(num) ? num / 100 : reverb);
        else if (kind === "reverbSize") {
            setReverbSize(Number.isFinite(num) ? num / 100 : reverbSize);
        } else if (kind === "reverbDecay") {
            setReverbDecay(Number.isFinite(num) ? num : reverbDecay);
        } else if (kind === "reverbTone") {
            setReverbTone(Number.isFinite(num) ? num / 100 : reverbTone);
        } else {
            setReverbPreDelay(Number.isFinite(num) ? num / 1000 : reverbPreDelay);
        }
    });
}
wireValueInput(pitchValue, "pitch");
wireValueInput(microValue, "micro");
wireValueInput(speedValue, "speed");
wireValueInput(reverbValue, "reverb");
wireValueInput(reverbSizeValue, "reverbSize");
wireValueInput(reverbDecayValue, "reverbDecay");
wireValueInput(reverbToneValue, "reverbTone");
wireValueInput(reverbPreDelayValue, "reverbPreDelay");

function setStatus(hasMedia) {
    if (!enabled) {
        statusEl.textContent = "○ Off on this tab";
        statusEl.classList.add("warn");
        statusEl.classList.remove("ok");
    } else if (hasMedia) {
        statusEl.textContent = "● Media detected";
        statusEl.classList.add("ok");
        statusEl.classList.remove("warn");
    } else {
        statusEl.textContent = "○ No media detected on this page";
        statusEl.classList.add("warn");
        statusEl.classList.remove("ok");
    }
}

function toggleEnabled() {
    enabled = !enabled;
    render();
    setStatus(hasMedia);
    if (tabId == null) return;
    api.tabs
        .sendMessage(tabId, {
            type: "setEnabled",
            enabled,
            pitch,
            micro,
            speed,
            reverb,
            reverbMode,
            reverbSize,
            reverbDecay,
            reverbTone,
            reverbPreDelay,
        })
        .catch(() => {});
}

enabledToggle.addEventListener("click", toggleEnabled);

function showPanel(panel) {
    const showReverb = panel === "reverb";
    const mainTab = document.getElementById("mainTab");
    const reverbTab = document.getElementById("reverbTab");
    document.getElementById("mainPanel").hidden = showReverb;
    document.getElementById("reverbPanel").hidden = !showReverb;
    mainTab.classList.toggle("active", !showReverb);
    reverbTab.classList.toggle("active", showReverb);
    mainTab.setAttribute("aria-selected", String(!showReverb));
    reverbTab.setAttribute("aria-selected", String(showReverb));
}

document.getElementById("mainTab").addEventListener("click", () => showPanel("main"));
document.getElementById("reverbTab").addEventListener("click", () => showPanel("reverb"));

// Live updates pushed from any frame (covers media inside iframes/embeds).
api.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== "stateUpdate") return;
    if (!sender.tab || sender.tab.id !== tabId) return;
    hasMedia = hasMedia || !!msg.hasMedia;
    setStatus(hasMedia);
});

async function init() {
    try {
        const stored = await api.storage.local.get("settings");
        if (stored && stored.settings) {
            pitch = clampPitch(stored.settings.pitch || 0);
            micro = clampMicro(stored.settings.micro || 0);
            speed = clampSpeed(stored.settings.speed || 1);
            reverb = clampReverb(stored.settings.reverb || 0);
            reverbMode = stored.settings.reverbMode === "advanced" ? "advanced" : "simple";
            reverbSize = clampReverbSize(stored.settings.reverbSize ?? 1);
            reverbDecay = clampReverbDecay(stored.settings.reverbDecay ?? 2.8);
            reverbTone = clampReverbTone(stored.settings.reverbTone ?? 0.55);
            reverbPreDelay = clampReverbPreDelay(stored.settings.reverbPreDelay ?? 0.016);
        }
    } catch (e) {}

    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) {
        render();
        setStatus(false);
        return;
    }
    tabId = tabs[0].id;
    try {
        const state = await api.tabs.sendMessage(tabId, { type: "getState" });
        if (state) {
            enabled = !!state.enabled;
            hasMedia = !!state.hasMedia;
            const tabHasPreset =
                enabled ||
                Number(state.pitch) !== 0 ||
                Number(state.micro) !== 0 ||
                Math.abs(Number(state.speed || 1) - 1) > 1e-6 ||
                Number(state.reverb) !== 0 ||
                state.reverbMode === "advanced" ||
                Math.abs(Number(state.reverbSize ?? 1) - 1) > 1e-6 ||
                Math.abs(Number(state.reverbDecay ?? 2.8) - 2.8) > 1e-6 ||
                Math.abs(Number(state.reverbTone ?? 0.55) - 0.55) > 1e-6 ||
                Math.abs(Number(state.reverbPreDelay ?? 0.016) - 0.016) > 1e-6;
            if (tabHasPreset) {
                pitch = clampPitch(state.pitch || 0);
                micro = clampMicro(state.micro || 0);
                speed = clampSpeed(state.speed || 1);
                reverb = clampReverb(state.reverb || 0);
                reverbMode = state.reverbMode === "advanced" ? "advanced" : "simple";
                reverbSize = clampReverbSize(state.reverbSize ?? 1);
                reverbDecay = clampReverbDecay(state.reverbDecay ?? 2.8);
                reverbTone = clampReverbTone(state.reverbTone ?? 0.55);
                reverbPreDelay = clampReverbPreDelay(state.reverbPreDelay ?? 0.016);
            }
            render();
            setStatus(hasMedia);
        } else {
            render();
            setStatus(false);
        }
    } catch (e) {
        // No content script here (e.g. about:, addons page, PDF viewer).
        enabled = false;
        render();
        statusEl.textContent = "○ Not available on this page";
        statusEl.classList.add("warn");
    }
}

// Wire the Support link (hidden until a real donation URL is set).
const donateEl = document.getElementById("donate");
if (donateEl) {
    if (DONATE_URL.includes("YOUR_USERNAME")) donateEl.style.display = "none";
    else donateEl.href = DONATE_URL;
}

// --- Theme toggle -------------------------------------------------------------
// theme: "system" (follow browser) | "light" | "dark". Persisted.
const themeBtn = document.getElementById("themeToggle");
let theme = "system";

const systemDark = () =>
    !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
const effectiveDark = () =>
    theme === "dark" ? true : theme === "light" ? false : systemDark();

function applyTheme() {
    const root = document.documentElement;
    if (theme === "dark" || theme === "light") root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
    // CSS shows the sun (switch to light) when dark is active, else the moon.
    if (themeBtn) themeBtn.classList.toggle("dark", effectiveDark());
    render(); // re-fill sliders with the active theme's colors
}

if (themeBtn) {
    themeBtn.addEventListener("click", () => {
        theme = effectiveDark() ? "light" : "dark";
        applyTheme();
        api.storage.local.set({ theme }).catch(() => {});
    });
}

api.storage.local
    .get("theme")
    .then((r) => {
        theme = r && r.theme ? r.theme : "system";
        applyTheme();
    })
    .catch(() => applyTheme());

render();
init();
