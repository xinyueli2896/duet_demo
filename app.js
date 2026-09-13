/* Experiment comparison viewer.
   Tabs = experiments; a prompt selector (001..); rows = input + each model,
   every roll multitrack (melody vs chord, piano for all), with left/right to switch
   variations, a draggable playhead + time readout. */

const ROLE_COLORS = { melody: "#E07A2E", chord: "#3F7FD6", other: "#8A8A8A", condition: "#9A968E" };
function maxSimul(notes) {
  const ev = []; notes.forEach(n => { ev.push([n.time, 1]); ev.push([n.time + n.duration, -1]); });
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let c = 0, m = 0; for (const e of ev) { c += e[1]; if (c > m) m = c; } return m;
}
function roleOf(tr) {
  const n = (tr.name || "").toLowerCase();
  if (n.includes("mel")) return "melody";
  if (n.includes("chord") || n.includes("acc") || n.includes("harm")) return "chord";
  if (tr.program === 0) return "melody";
  if (tr.program === 48) return "chord";
  return maxSimul(tr.notes) >= 3 ? "chord" : "melody";
}
const hexRgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
const shade = (rgb, f) => rgb.map(c => Math.round(c * f));
const BG = [252, 250, 245], INK = [120, 110, 92];
const fmt = (s) => { s = Math.max(0, s | 0); return (s / 60 | 0) + ":" + String(s % 60).padStart(2, "0"); };

const SAMPLE_BASE = "https://tonejs.github.io/audio/salamander/";
let audio = null, current = null;
let SCALE = { dur: 0, redraws: [] };   // shared time scale so all rows use the same pixels-per-bar
async function initAudio() {
  if (audio) return audio;
  await Tone.start(); try { await Tone.getContext().resume(); } catch (e) {}
  const synth = new Tone.PolySynth(Tone.Synth, { volume: -6, oscillator: { type: "triangle" },
    envelope: { attack: 0.005, decay: 0.32, sustain: 0.14, release: 0.9 } }).toDestination();
  audio = { inst: synth };
  (async () => {
    try {
      const s = new Tone.Sampler({ urls: { A1:"A1.mp3",A2:"A2.mp3",A3:"A3.mp3",A4:"A4.mp3",A5:"A5.mp3",A6:"A6.mp3",
        C2:"C2.mp3",C3:"C3.mp3",C4:"C4.mp3",C5:"C5.mp3",C6:"C6.mp3","D#2":"Ds2.mp3","D#3":"Ds3.mp3","D#4":"Ds4.mp3","D#5":"Ds5.mp3",
        "F#2":"Fs2.mp3","F#3":"Fs3.mp3","F#4":"Fs4.mp3","F#5":"Fs5.mp3" }, baseUrl: SAMPLE_BASE, release: 1, volume: -3 }).toDestination();
      await Promise.race([Tone.loaded(), new Promise((_, r) => setTimeout(() => r(0), 8000))]);
      if (s.loaded) { synth.disconnect(); audio.inst = s; } else s.dispose();
    } catch (e) {}
  })();
  return audio;
}
function stopAudio() {
  if (!current) return;
  try { Tone.Transport.stop(); Tone.Transport.cancel(); current.part.dispose(); } catch (e) {}
  if (audio && audio.inst.releaseAll) try { audio.inst.releaseAll(); } catch (e) {}
  cancelAnimationFrame(current.raf);
  const row = current.row; current = null;
  if (row) { row.setPlaying(false); row.drawPlayhead(null); }
}

function makeRow(parent, title, files, opts) {
  opts = opts || {};
  const row = document.createElement("div"); row.className = "row"; parent.appendChild(row);
  const head = document.createElement("div"); head.className = "rowhead";
  const h = document.createElement("div"); h.className = "rowtitle"; head.appendChild(h);
  const legend = document.createElement("div"); legend.className = "legend"; head.appendChild(legend);
  const vwrap = document.createElement("div"); vwrap.className = "varsel";
  const prev = btn("&#10094;", "vnav"), vlabel = document.createElement("span"), next = btn("&#10095;", "vnav");
  vlabel.className = "vlabel";
  vwrap.appendChild(prev); vwrap.appendChild(vlabel); vwrap.appendChild(next); head.appendChild(vwrap);
  row.appendChild(head);

  const cv = document.createElement("canvas"); cv.className = "roll"; row.appendChild(cv);
  const bar = document.createElement("div"); bar.className = "transport";
  const play = btn("&#9654;", "play"), time = document.createElement("span"); time.className = "time"; time.textContent = "0:00 / 0:00";
  const seek = document.createElement("input"); seek.type = "range"; seek.min = 0; seek.max = 1000; seek.value = 0; seek.className = "seek";
  bar.appendChild(play); bar.appendChild(time); bar.appendChild(seek); row.appendChild(bar);

  let piece = null, W = 0, H = 0, dpr = 1, off = document.createElement("canvas"), octx = off.getContext("2d");
  const padL = 4, padR = 4, padT = 8, padB = 8;
  let pLo = 48, pHi = 84, dur = 1, playheadT = null, vi = 0, fileBpm = 120;
  const promptBars = opts.promptBars || 0;
  const givenRole = opts.given || null;   // condition modality -> drawn grey
  const effRole = (tr) => (givenRole && tr.role === givenRole) ? "condition" : tr.role;
  const rate = () => (groupBpm || fileBpm) / fileBpm;   // >1 = faster playback (group-controlled)
  const sdur = () => SCALE.dur || dur;                    // shared duration for horizontal scale
  const X = (t) => padL + (t / sdur()) * (W - padL - padR);
  const Y = (m) => padT + ((pHi - m) / Math.max(1, pHi - pLo)) * (H - padT - padB);
  const timeAtX = (cx) => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(dur, ((cx - r.left) - padL) / (r.width - padL - padR) * sdur())); };

  function layout() {
    dpr = window.devicePixelRatio || 1; W = cv.clientWidth; H = cv.clientHeight;
    cv.width = off.width = Math.round(W * dpr); cv.height = off.height = Math.round(H * dpr);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0); drawStatic(); drawPlayhead(playheadT);
  }
  function rr(g, x, y, w, hh, r) { r = Math.min(r, hh / 2, w / 2); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function chip(g, x, text, fg) {
    g.font = "600 10px ui-sans-serif,system-ui,sans-serif";
    const tw = g.measureText(text).width, pad = 5, hh = 15, y = padT + 1;
    g.fillStyle = "rgba(255,255,255,0.82)"; rr(g, x, y, tw + pad * 2, hh, 7); g.fill();
    g.strokeStyle = "rgba(120,110,92,0.35)"; g.lineWidth = 1; rr(g, x, y, tw + pad * 2, hh, 7); g.stroke();
    g.fillStyle = fg; g.textBaseline = "middle"; g.fillText(text, x + pad, y + hh / 2 + 0.5);
  }
  function drawStatic() {
    const g = octx; g.clearRect(0, 0, W, H); g.fillStyle = `rgb(${BG[0]},${BG[1]},${BG[2]})`; g.fillRect(0, 0, W, H);
    if (!piece) return;
    const beat = 60 / piece.bpm;
    // prompt region tint (behind grid/notes)
    let bx = null;
    if (promptBars > 0) {
      bx = X(Math.min(dur, promptBars * piece.beatsPerBar * beat));
      g.fillStyle = rgba(INK, 0.07); g.fillRect(padL, padT, bx - padL, H - padT - padB);
    }
    for (let i = 0, t = 0; t <= dur + 1e-6; i++, t = i * beat) {
      g.strokeStyle = rgba(INK, i % piece.beatsPerBar === 0 ? 0.16 : 0.06); g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(t), padT); g.lineTo(X(t), H - padB); g.stroke();
    }
    const nh = Math.max(2.4, (H - padT - padB) / Math.max(1, pHi - pLo) * 0.9);
    const baseOrder = { chord: 0, other: 1, melody: 2 };
    const orderOf = (tr) => (givenRole && tr.role === givenRole) ? -1 : (baseOrder[tr.role] ?? 1); // condition at bottom
    const ordered = piece.tracks.slice().sort((a, b) => orderOf(a) - orderOf(b));
    for (const tr of ordered) {
      const col = hexRgb(ROLE_COLORS[effRole(tr)]), deep = shade(col, 0.7);
      for (const n of tr.notes) {
        const x = X(n.time), w = Math.max(2.5, X(n.time + n.duration) - x), y = Y(n.midi) - nh / 2;
        const vf = Math.min(1, (n.velocity || 90) / 112);
        rr(g, x + 0.4, y + 0.4, w - 0.8, nh - 0.8, Math.min(nh * 0.35, 3));
        g.fillStyle = rgba(col, 0.34 + 0.12 * vf); g.fill();
        g.strokeStyle = rgba(deep, 0.95); g.lineWidth = 1.1; g.stroke();
      }
    }
    // prompt/generation divider + chips (on top)
    if (bx != null) {
      g.strokeStyle = "rgba(40,42,50,0.55)"; g.setLineDash([5, 4]); g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(bx, padT); g.lineTo(bx, H - padB); g.stroke(); g.setLineDash([]);
      chip(g, padL + 3, "PROMPT", "rgba(90,86,79,1)");
      chip(g, bx + 4, "GENERATION", "rgba(40,42,50,1)");
    }
  }
  function drawPlayhead(t) {
    playheadT = t; const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H); ctx.drawImage(off, 0, 0, W, H);
    if (t != null) { const x = X(t); ctx.strokeStyle = "rgba(40,42,50,0.8)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke(); }
    if (piece) { seek.value = Math.round(1000 * (t || 0) / dur); time.textContent = fmt(t || 0) + " / " + fmt(dur); }
  }
  const rowObj = { row, drawPlayhead, setPlaying: (on) => { play.innerHTML = on ? "&#10073;&#10073;" : "&#9654;"; play.classList.toggle("on", on); cv.classList.toggle("playing", on); } };
  function stopAudioIfMine() { if (current && current.row === rowObj) stopAudio(); }

  function loadVariation() {
    stopAudioIfMine();
    const url = files[vi];
    vlabel.textContent = files.length > 1 ? `v${vi + 1}/${files.length}` : "";
    prev.style.visibility = next.style.visibility = files.length > 1 ? "visible" : "hidden";
    fetch(url).then(r => r.arrayBuffer()).then(buf => {
      const m = parseMidi(buf);
      const bpm = m.tempos[0] ? m.tempos[0].bpm : 120;
      const ts = m.timeSignatures[0] || { numerator: 4, denominator: 4 };
      const beatsPerBar = Math.max(1, Math.round(ts.numerator * 4 / ts.denominator));
      let tracks = m.tracks.map(t => ({ ...t, role: roleOf(t) }));

      // optional bar cap (e.g. Input limited to 26 bars)
      let endT = m.duration;
      if (opts.capBars) {
        const capT = opts.capBars * beatsPerBar * (60 / bpm);
        endT = Math.min(endT, capT);
        tracks = tracks.map(t => ({ ...t, notes: t.notes.filter(n => n.time < endT - 1e-6)
          .map(n => n.time + n.duration > endT ? { ...n, duration: endT - n.time } : n) }));
      }
      dur = endT + 0.4; pLo = 127; pHi = 0;
      tracks.forEach(t => t.notes.forEach(n => { pLo = Math.min(pLo, n.midi); pHi = Math.max(pHi, n.midi); }));
      if (pLo > pHi) { pLo = 48; pHi = 84; }
      pLo -= 2; pHi += 2; if (pHi - pLo < 12) { pHi += 6; pLo -= 6; }
      const bars = Math.max(1, Math.round(endT / (beatsPerBar * 60 / bpm)));
      fileBpm = bpm; suggestGroupBpm(bpm);
      piece = { bpm, beatsPerBar, tracks };
      h.innerHTML = `<b>${title}</b> <span class="dim">&middot; ${saneBpm(bpm)} BPM &middot; ${bars} bars</span>`;
      const roles = [...new Set(tracks.map(t => effRole(t)))];
      const label = { melody: "Melody", chord: "Chord", other: "Other", condition: (givenRole ? givenRole[0].toUpperCase() + givenRole.slice(1) : "Condition") + " (given)" };
      legend.innerHTML = roles.map(r => `<span class="lg"><i style="background:${ROLE_COLORS[r]}"></i>${label[r] || r}</span>`).join("");
      layout();
      SCALE.dur = Math.max(SCALE.dur, dur);              // grow shared scale, redraw every row to match
      SCALE.redraws.forEach(fn => fn());
    }).catch(() => { h.innerHTML = `<b>${title}</b> <span class="err">&mdash; load error</span>`; });
  }

  prev.addEventListener("click", () => { vi = (vi - 1 + files.length) % files.length; loadVariation(); });
  next.addEventListener("click", () => { vi = (vi + 1) % files.length; loadVariation(); });
  play.addEventListener("click", () => { if (current && current.row === rowObj) stopAudio(); else playFrom(0); });
  seek.addEventListener("input", () => { const t = dur * seek.value / 1000; if (current && current.row === rowObj) playFrom(t); else drawPlayhead(t); });
  let drag = false;
  cv.addEventListener("pointerdown", (e) => { e.preventDefault(); drag = true; try { cv.setPointerCapture(e.pointerId); } catch (_) {} stopAudioIfMine(); drawPlayhead(timeAtX(e.clientX)); });
  cv.addEventListener("pointermove", (e) => { if (drag) drawPlayhead(timeAtX(e.clientX)); });
  cv.addEventListener("pointerup", (e) => { if (!drag) return; drag = false; playFrom(timeAtX(e.clientX)); });

  async function playFrom(t0) {
    stopAudio();
    const a = await initAudio();
    const r = rate(), playDur = dur / r;
    Tone.Transport.stop(); Tone.Transport.cancel(); Tone.Transport.position = 0;
    const notes = []; piece.tracks.forEach(tr => tr.notes.forEach(n => notes.push(n)));
    const part = new Tone.Part((time, n) => a.inst.triggerAttackRelease(Tone.Frequency(n.midi, "midi").toNote(), Math.max(0.05, n.duration / r), time, Math.min(1, (n.velocity || 90) / 127)), notes.map(n => [n.time / r, n]));
    part.start(0);
    Tone.Transport.scheduleOnce(() => stopAudio(), playDur);
    Tone.Transport.start(undefined, Math.max(0, Math.min((t0 || 0) / r, playDur - 0.03)));
    current = { row: rowObj, part, raf: 0 }; rowObj.setPlaying(true);
    const step = () => { if (!current || current.row !== rowObj) return; const tv = Tone.Transport.seconds * r; drawPlayhead(tv); if (tv < dur) current.raf = requestAnimationFrame(step); else stopAudio(); };
    current.raf = requestAnimationFrame(step);
  }
  rowObj.onBpm = () => { if (current && current.row === rowObj) playFrom(playheadT || 0); };  // re-time if this row is playing
  ROWS.push(rowObj);
  window.addEventListener("resize", () => { clearTimeout(rowObj._rt); rowObj._rt = setTimeout(layout, 120); });
  SCALE.redraws.push(() => { if (piece) { drawStatic(); drawPlayhead(playheadT); } });   // re-scale when a longer row loads
  loadVariation();
  return rowObj;
}
function btn(html, cls) { const b = document.createElement("button"); b.className = cls; b.type = "button"; b.innerHTML = html; return b; }

let MANIFEST = null, expIdx = 0, promptIdx = 0;
let groupBpm = 120, groupBpmTouched = false, groupBpmSet = false, bpmInput = null;
const ROWS = [];
const saneBpm = (b) => (b >= 40 && b <= 240) ? Math.round(b) : 120;   // ignore corrupt tempo metas
function setGroupBpm(v) { groupBpm = v; ROWS.forEach(r => r.onBpm && r.onBpm()); }
function suggestGroupBpm(b) {        // adopt the first sane file tempo as the group default until the user overrides
  if (groupBpmTouched || groupBpmSet) return;
  groupBpm = saneBpm(b); groupBpmSet = true;
  if (bpmInput) bpmInput.value = groupBpm;
  ROWS.forEach(r => r.onBpm && r.onBpm());
}
function renderRows() {
  stopAudio(); ROWS.length = 0; SCALE.dur = 0; SCALE.redraws = []; groupBpmSet = false;
  const exp = MANIFEST.experiments[expIdx], pid = exp.prompts[promptIdx];
  const rows = document.getElementById("rows"); rows.innerHTML = "";
  const pb = exp.promptBars || 0, gv = exp.given || null, cap = exp.capBars || 0;
  if (exp.input && exp.input[pid]) makeRow(rows, "Input (reference)", [exp.input[pid]], { capBars: cap || 26, promptBars: pb, given: gv });
  let lastGroup;
  for (const mdl of exp.models) {
    const files = mdl.variations[pid];
    if (!files || !files.length) continue;
    if (mdl.group && mdl.group !== lastGroup) {          // section heading when the group changes
      const hd = document.createElement("div"); hd.className = "grouphead"; hd.textContent = mdl.group;
      rows.appendChild(hd); lastGroup = mdl.group;
    }
    makeRow(rows, mdl.name, files, { promptBars: pb, given: gv, capBars: cap });
  }
}
function renderPrompts() {
  const exp = MANIFEST.experiments[expIdx];
  const box = document.getElementById("prompts"); box.innerHTML = "";
  const many = exp.prompts.length > 12;
  box.appendChild(Object.assign(document.createElement("span"), { className: "plabel", textContent: many ? "POP909 song" : "Prompt" }));
  if (many) {
    // dropdown + prev/next for large song sets
    const prev = btn("&#10094;", "pnav"), next = btn("&#10095;", "pnav");
    const sel = document.createElement("select"); sel.className = "songsel";
    exp.prompts.forEach((pid, i) => {
      const o = document.createElement("option"); o.value = i; o.textContent = `POP909 #${pid}`;
      if (i === promptIdx) o.selected = true; sel.appendChild(o);
    });
    const count = Object.assign(document.createElement("span"), { className: "pcount", textContent: `${exp.prompts.length} songs · POP909 index` });
    const go = (i) => { promptIdx = (i + exp.prompts.length) % exp.prompts.length; renderPrompts(); renderRows(); };
    sel.addEventListener("change", () => go(+sel.value));
    prev.addEventListener("click", () => go(promptIdx - 1));
    next.addEventListener("click", () => go(promptIdx + 1));
    box.appendChild(prev); box.appendChild(sel); box.appendChild(next); box.appendChild(count);
  } else {
    exp.prompts.forEach((pid, i) => {
      const b = btn(pid, "pbtn" + (i === promptIdx ? " on" : ""));
      b.addEventListener("click", () => { promptIdx = i; renderPrompts(); renderRows(); });
      box.appendChild(b);
    });
  }
  // one BPM handle for the whole experiment
  const g = document.createElement("span"); g.className = "groupbpm";
  const inp = document.createElement("input"); inp.type = "number"; inp.min = 20; inp.max = 400; inp.step = 1; inp.className = "bpmin"; inp.value = groupBpm;
  g.appendChild(document.createTextNode("Tempo (all): ")); g.appendChild(inp); g.appendChild(document.createTextNode(" BPM"));
  inp.addEventListener("change", () => { let v = parseFloat(inp.value); if (!(v >= 20 && v <= 400)) { v = groupBpm; inp.value = v; } groupBpmTouched = true; setGroupBpm(v); });
  box.appendChild(g); bpmInput = inp;
  const note = MANIFEST.experiments[expIdx].note;
  let nd = document.getElementById("expnote");
  if (!nd) { nd = document.createElement("div"); nd.id = "expnote"; nd.className = "expnote"; box.parentNode.insertBefore(nd, box.nextSibling); }
  nd.textContent = note || "";
  nd.style.display = note ? "block" : "none";
}
function renderTabs() {
  const box = document.getElementById("tabs"); box.innerHTML = "";
  MANIFEST.experiments.forEach((e, i) => {
    const b = btn(e.name, "tab" + (i === expIdx ? " on" : ""));
    b.addEventListener("click", () => { expIdx = i; promptIdx = 0; groupBpmTouched = false; renderTabs(); renderPrompts(); renderRows(); });
    box.appendChild(b);
  });
}
document.addEventListener("DOMContentLoaded", () => {
  fetch("manifest.json").then(r => r.json()).then(m => {
    MANIFEST = m;
    if (!m.experiments || !m.experiments.length) { document.getElementById("rows").innerHTML = "<p class='err'>manifest.json has no experiments — run build_manifest.py</p>"; return; }
    renderTabs(); renderPrompts(); renderRows();
  }).catch(() => { document.getElementById("rows").innerHTML = "<p class='err'>could not load manifest.json — run <code>python3 build_manifest.py</code>, then serve over http.</p>"; });
});
