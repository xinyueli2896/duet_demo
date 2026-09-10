// Dependency-free Standard MIDI File parser, multitrack-aware.
// Returns { ppq, tempos, timeSignatures, duration,
//           tracks: [{ index, name, program, notes:[{midi,time,duration,velocity}] }],
//           notes: [ ...all notes, each tagged with .track ] }
(function (global) {
  function parseMidi(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    let p = 0;
    const u32 = () => { const v = dv.getUint32(p); p += 4; return v; };
    const u16 = () => { const v = dv.getUint16(p); p += 2; return v; };
    const u8  = () => dv.getUint8(p++);
    const str = (n) => { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(p++)); return s; };

    if (str(4) !== "MThd") throw new Error("Not a MIDI file");
    u32(); u16();
    const nTracks = u16();
    const division = u16();
    if (division & 0x8000) throw new Error("SMPTE division unsupported");
    const ppq = division;

    const tempos = [], timeSignatures = [];
    const rawTracks = [];   // per-track: {name, program, raw:[{ticks,durTicks,midi,velocity}]}
    const readVLQ = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

    for (let t = 0; t < nTracks; t++) {
      if (str(4) !== "MTrk") throw new Error("Bad track header");
      const len = u32(), end = p + len;
      let tick = 0, running = 0;
      const active = {};
      const T = { name: null, program: null, raw: [] };

      while (p < end) {
        tick += readVLQ();
        let status = dv.getUint8(p);
        if (status & 0x80) { p++; running = status; } else status = running;
        const type = status & 0xf0, chan = status & 0x0f;

        if (status === 0xff) {
          const meta = u8(), mlen = readVLQ();
          if (meta === 0x51) {
            const us = (dv.getUint8(p) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p + 2);
            tempos.push({ ticks: tick, usPerBeat: us, bpm: 6e7 / us });
          } else if (meta === 0x58) {
            timeSignatures.push({ ticks: tick, numerator: dv.getUint8(p), denominator: 1 << dv.getUint8(p + 1) });
          } else if (meta === 0x03 && T.name == null) {
            let s = ""; for (let i = 0; i < mlen; i++) s += String.fromCharCode(dv.getUint8(p + i)); T.name = s;
          }
          p += mlen;
        } else if (status === 0xf0 || status === 0xf7) {
          p += readVLQ();
        } else if (type === 0x90 || type === 0x80) {
          const pitch = u8(), vel = u8(), key = chan * 128 + pitch;
          if (type === 0x90 && vel > 0) active[key] = { ticks: tick, velocity: vel };
          else { const a = active[key]; if (a) { T.raw.push({ ticks: a.ticks, durTicks: tick - a.ticks, midi: pitch, velocity: a.velocity }); delete active[key]; } }
        } else if (type === 0xc0) { if (T.program == null) T.program = dv.getUint8(p); p += 1; }
        else if (type === 0xd0) { p += 1; }
        else { p += 2; }
      }
      p = end;
      rawTracks.push(T);
    }

    // Unify tempo: file tempo metadata is often corrupt, so treat EVERY file as 120 BPM.
    // Note positions are in ticks (tempo-independent), so this only sets a consistent clock.
    const FORCE_BPM = 120, usPerBeat = 6e7 / FORCE_BPM;
    const toSec = (tk) => (tk / ppq) * (usPerBeat / 1e6);
    const outTempos = [{ ticks: 0, usPerBeat, bpm: FORCE_BPM }];

    const tracks = [], all = [];
    rawTracks.forEach((T, ti) => {
      const notes = T.raw.map((n) => ({
        midi: n.midi, velocity: n.velocity, time: toSec(n.ticks),
        duration: Math.max(0.03, toSec(n.ticks + n.durTicks) - toSec(n.ticks)), track: ti,
      })).sort((a, b) => a.time - b.time || a.midi - b.midi);
      if (notes.length) { tracks.push({ index: ti, name: T.name, program: T.program, notes }); all.push(...notes); }
    });
    all.sort((a, b) => a.time - b.time || a.midi - b.midi);
    const duration = all.reduce((m, n) => Math.max(m, n.time + n.duration), 0);
    return { ppq, tempos: outTempos, timeSignatures, tracks, notes: all, duration };
  }
  global.parseMidi = parseMidi;
})(window);
