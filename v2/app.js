/*
 * Polyphemus v2 — a polyrhythmic step sequencer.
 *
 * Four tracks: drums (eight voices), bass, lead, pad. Every drum voice and every melodic
 * track is a "lane" with its own length (1–64 steps) and its own step rate (1/32 up to 1/2,
 * including triplets, quintuplets and dotted values). Lanes of different lengths and rates
 * drift against each other and realign only after their common cycle, which is the point.
 *
 * Timing: Tone's Transport calls `tick` on a fine tick grid; each lane fires when the tick
 * lands on one of its steps. Every note is scheduled at the exact audio-clock time.
 *
 * Export: each track (or each drum voice) renders to a Standard MIDI File for Ableton Live.
 */
(() => {
  'use strict';

  // ================================================================ constants
  const TONE_VERSION = '15.1.22';
  const TONE_SRCS = [
    `https://cdnjs.cloudflare.com/ajax/libs/tone/${TONE_VERSION}/Tone.js`,
    `https://cdn.jsdelivr.net/npm/tone@${TONE_VERSION}/build/Tone.js`,
    `https://unpkg.com/tone@${TONE_VERSION}/build/Tone.js`,
  ];
  const STORAGE_KEY = 'polyphemus.v2';
  const STATE_VERSION = 3;
  const CODE_PREFIX = 'PLY3:';
  const MAX_STEPS = 64;
  const PPQ = 480;                       // ticks per quarter note, for the scheduler and MIDI files
  const BAR = PPQ * 4;
  const SLOT_NAMES = ['A', 'B', 'C', 'D'];
  const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

  // Step rates, in quarter-note beats per step.
  const RATES = [
    { id: '1/32',  label: '1/32',        beats: 1 / 8 },
    { id: '1/16T', label: '1/16 triplet', beats: 1 / 6 },
    { id: '1/16Q', label: '1/16 quintuplet', beats: 1 / 5 },
    { id: '1/16',  label: '1/16',        beats: 1 / 4 },
    { id: '1/8T',  label: '1/8 triplet', beats: 1 / 3 },
    { id: '1/16.', label: '1/16 dotted', beats: 3 / 8 },
    { id: '1/8',   label: '1/8',         beats: 1 / 2 },
    { id: '1/4T',  label: '1/4 triplet', beats: 2 / 3 },
    { id: '1/8.',  label: '1/8 dotted',  beats: 3 / 4 },
    { id: '1/4',   label: '1/4',         beats: 1 },
    { id: '1/2',   label: '1/2',         beats: 2 },
  ];
  const RATE_BY_ID = Object.fromEntries(RATES.map((r) => [r.id, r]));
  const rateTicks = (id) => Math.round(PPQ * (RATE_BY_ID[id] || RATE_BY_ID['1/16']).beats);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const lcm = (a, b) => (a / gcd(a, b)) * b;
  const TICK_STEP = RATES.map((r) => rateTicks(r.id)).reduce(gcd); // scheduler resolution (ticks)

  const ECHO_TIMES = [
    { id: '1/16.', label: '1/16 dotted', beats: 3 / 8 },
    { id: '1/8',   label: '1/8',         beats: 1 / 2 },
    { id: '1/8.',  label: '1/8 dotted',  beats: 3 / 4 },
    { id: '1/4',   label: '1/4',         beats: 1 },
    { id: '1/4.',  label: '1/4 dotted',  beats: 3 / 2 },
  ];

  const SCALES = {
    dorian:        { label: 'Dorian',           steps: [0, 2, 3, 5, 7, 9, 10] },
    minor:         { label: 'Minor',            steps: [0, 2, 3, 5, 7, 8, 10] },
    phrygian:      { label: 'Phrygian',         steps: [0, 1, 3, 5, 7, 8, 10] },
    major:         { label: 'Major',            steps: [0, 2, 4, 5, 7, 9, 11] },
    lydian:        { label: 'Lydian',           steps: [0, 2, 4, 6, 7, 9, 11] },
    mixolydian:    { label: 'Mixolydian',       steps: [0, 2, 4, 5, 7, 9, 10] },
    harmonicMinor: { label: 'Harmonic minor',   steps: [0, 2, 3, 5, 7, 8, 11] },
    pentMinor:     { label: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
    pentMajor:     { label: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
    chromatic:     { label: 'Chromatic',        steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  };

  const CHORDS = [
    { id: 'off',   label: 'Single notes', degrees: [0] },
    { id: 'triad', label: 'Triad',        degrees: [0, 2, 4] },
    { id: 'sev',   label: '7th',          degrees: [0, 2, 4, 6] },
    { id: 'nine',  label: '9th',          degrees: [0, 2, 4, 6, 8] },
    { id: 'sus',   label: 'Sus4',         degrees: [0, 3, 4] },
    { id: 'fifth', label: 'Fifths',       degrees: [0, 4, 7] },
  ];

  // Top-to-bottom display order. `gm` is the General MIDI drum note; `pad` is the
  // Drum Rack pad note counting up from C1 (36) in bottom-to-top order.
  const DRUM_VOICES = [
    { id: 'ohh',     label: 'Open hat',   gm: 46, pad: 43 },
    { id: 'chh',     label: 'Closed hat', gm: 42, pad: 42 },
    { id: 'shaker',  label: 'Shaker',     gm: 70, pad: 41 },
    { id: 'rim',     label: 'Rim',        gm: 37, pad: 40 },
    { id: 'snap',    label: 'Snap',       gm: 39, pad: 39 },
    { id: 'congaHi', label: 'Conga high', gm: 62, pad: 38 },
    { id: 'congaLo', label: 'Conga low',  gm: 64, pad: 37 },
    { id: 'kick',    label: 'Kick',       gm: 36, pad: 36 },
  ];
  const VOICE_BY_ID = Object.fromEntries(DRUM_VOICES.map((v) => [v.id, v]));

  const TRACKS = [
    { id: 'drums', label: 'Drums', kind: 'drums' },
    { id: 'bass',  label: 'Bass',  kind: 'melodic', octave: 1, mono: true,  gate: 0.92,
      presets: [['dub', 'Dub'], ['sub', 'Sub'], ['wood', 'Wood']] },
    { id: 'lead',  label: 'Lead',  kind: 'melodic', octave: 4, mono: false, gate: 0.9,
      presets: [['kalimba', 'Kalimba'], ['marimba', 'Marimba'], ['glass', 'Glass']] },
    { id: 'pad',   label: 'Pad',   kind: 'melodic', octave: 3, mono: false, gate: 1.0,
      presets: [['stab', 'Dub stab'], ['drift', 'Drift'], ['tape', 'Tape']] },
  ];
  const TRACK_BY_ID = Object.fromEntries(TRACKS.map((t) => [t.id, t]));
  const MELODIC = TRACKS.filter((t) => t.kind === 'melodic');

  // Synth recipes. `gain` balances loudness between presets (dB).
  const PRESETS = {
    bass: {
      dub: { gain: -9, make: (T) => new T.PolySynth(T.MonoSynth, {
        oscillator: { type: 'sawtooth' },
        filter: { Q: 1.4, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.012, decay: 0.3, sustain: 0.75, release: 0.18 },
        filterEnvelope: { attack: 0.01, decay: 0.35, sustain: 0.25, release: 0.2, baseFrequency: 85, octaves: 2.2 },
      }) },
      sub: { gain: -4, make: (T) => new T.PolySynth(T.Synth, {
        oscillator: { type: 'sine' },
        envelope: { attack: 0.012, decay: 0.2, sustain: 0.9, release: 0.25 },
      }) },
      wood: { gain: -5, make: (T) => new T.PolySynth(T.FMSynth, {
        harmonicity: 1, modulationIndex: 3.2,
        oscillator: { type: 'sine' }, modulation: { type: 'sine' },
        envelope: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.25 },
        modulationEnvelope: { attack: 0.002, decay: 0.12, sustain: 0, release: 0.1 },
      }) },
    },
    lead: {
      kalimba: { gain: -11, make: (T) => new T.PolySynth(T.FMSynth, {
        harmonicity: 7.01, modulationIndex: 1.4,
        oscillator: { type: 'sine' }, modulation: { type: 'sine' },
        envelope: { attack: 0.001, decay: 1.4, sustain: 0, release: 1.4 },
        modulationEnvelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.05 },
      }) },
      marimba: { gain: -10, make: (T) => new T.PolySynth(T.FMSynth, {
        harmonicity: 4, modulationIndex: 2.4,
        oscillator: { type: 'sine' }, modulation: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.6, sustain: 0, release: 0.5 },
        modulationEnvelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
      }) },
      glass: { gain: -15, make: (T) => new T.PolySynth(T.AMSynth, {
        harmonicity: 3,
        oscillator: { type: 'sine' }, modulation: { type: 'sine' },
        envelope: { attack: 0.02, decay: 1.8, sustain: 0.1, release: 2 },
      }) },
    },
    pad: {
      stab: { gain: -15, make: (T) => new T.PolySynth(T.Synth, {
        oscillator: { type: 'fatsawtooth', count: 3, spread: 14 },
        envelope: { attack: 0.004, decay: 0.24, sustain: 0.06, release: 0.35 },
      }) },
      drift: { gain: -22, make: (T) => new T.PolySynth(T.Synth, {
        oscillator: { type: 'fatsawtooth', count: 3, spread: 30 },
        envelope: { attack: 1.5, decay: 1, sustain: 0.8, release: 3 },
      }) },
      tape: { gain: -16, make: (T) => new T.PolySynth(T.Synth, {
        oscillator: { type: 'fattriangle', count: 4, spread: 45 },
        envelope: { attack: 0.8, decay: 0.8, sustain: 0.8, release: 2.5 },
      }) },
    },
  };

  // ================================================================ pattern helpers
  const blank = (fill = 0) => new Array(MAX_STEPS).fill(fill);
  const clampNum = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
  const clampInt = (v, lo, hi, d) => Math.round(clampNum(v, lo, hi, d));

  // Bjorklund-style Euclidean rhythm: k hits spread as evenly as possible over n steps.
  function euclid(k, n, rot = 0) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(((i * k) % n) < k);
    // rotate so that step 0 is a hit, then apply the requested rotation
    const first = out.indexOf(true);
    const base = first > 0 ? [...out.slice(first), ...out.slice(0, first)] : out;
    const r = ((rot % n) + n) % n;
    return r ? [...base.slice(n - r), ...base.slice(0, n - r)] : base;
  }

  function emptyLane(length = 16, rate = '1/16') {
    return { length, rate, vel: blank(0), prob: blank(100) };
  }

  function emptyPattern() {
    return {
      tracks: {
        drums: { lanes: Object.fromEntries(DRUM_VOICES.map((v) => [v.id, emptyLane()])) },
        bass: { length: 16, rate: '1/16', notes: [] },
        lead: { length: 16, rate: '1/16', notes: [] },
        pad:  { length: 16, rate: '1/16', notes: [] },
      },
    };
  }

  // hits: array of steps, or of [step, vel, prob]
  function lane(length, rate, hits) {
    const l = emptyLane(length, rate);
    for (const h of hits) {
      const [s, v = 100, p = 100] = Array.isArray(h) ? h : [h];
      if (s < length) { l.vel[s] = v; l.prob[s] = p; }
    }
    return l;
  }
  const euclidHits = (k, n, rot, vels, prob = 100) => {
    const steps = euclid(k, n, rot).map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
    return steps.map((s, i) => [s, vels[i % vels.length], prob]);
  };
  const note = (s, r, l = 1, v = 100, p = 100) => ({ s, r, l, v, p });
  const chordAt = (s, root, chordId, l, v, p = 100) =>
    CHORDS.find((c) => c.id === chordId).degrees.map((d) => note(s, root + d, l, v, p));

  // --- Pattern A: dub techno. Four-on-the-floor anchor, everything else on odd cycles.
  function patternDub() {
    const p = emptyPattern();
    p.tracks.drums.lanes = {
      kick:    lane(16, '1/16', [[0, 112], [4, 102], [8, 108], [12, 100]]),
      congaLo: lane(10, '1/16', euclidHits(3, 10, 1, [74, 58, 66], 90)),
      congaHi: lane(7,  '1/16', euclidHits(2, 7, 3, [60, 46], 80)),
      snap:    lane(32, '1/16', [[12, 72, 100], [28, 60, 70]]),
      rim:     lane(11, '1/16', euclidHits(3, 11, 2, [96, 68, 84], 85)),
      shaker:  lane(16, '1/16', Array.from({ length: 16 }, (_, s) => [s, [30, 58, 42, 76][s % 4], 85])),
      chh:     lane(16, '1/16', [[2, 76], [6, 70], [10, 78], [14, 88]]),
      ohh:     lane(5,  '1/8',  [[2, 58, 65]]),
    };
    p.tracks.bass = { length: 24, rate: '1/16', notes: [
      note(0, 0, 4, 110), note(6, 0, 1, 80, 80), note(9, 7, 1, 70, 70),
      note(12, 0, 3, 100), note(18, 4, 2, 90), note(22, 6, 1, 76, 75),
    ] };
    p.tracks.pad = { length: 20, rate: '1/16', notes: [
      ...chordAt(2, 0, 'nine', 1, 100), ...chordAt(9, 0, 'nine', 1, 72, 70), ...chordAt(15, 0, 'nine', 1, 86, 85),
    ] };
    p.tracks.lead = { length: 13, rate: '1/8', notes: [
      note(0, 4, 1, 70), note(3, 7, 1, 60, 70), note(5, 6, 1, 55, 80),
      note(8, 4, 1, 64, 60), note(10, 9, 1, 50, 50), note(11, 2, 1, 50),
    ] };
    return p;
  }

  // --- Pattern B: organic house. Busier hand percussion, moving bass, two 7th chords.
  function patternOrganic() {
    const p = emptyPattern();
    p.tracks.drums.lanes = {
      kick:    lane(16, '1/16', [[0, 110], [4, 100], [8, 106], [12, 100], [14, 60, 40]]),
      congaLo: lane(12, '1/16', euclidHits(5, 12, 0, [82, 60, 70, 55, 66], 95)),
      congaHi: lane(16, '1/16', euclidHits(5, 16, 3, [70, 52, 64, 48, 58], 90)),
      snap:    lane(16, '1/16', [[4, 82], [12, 80]]),
      rim:     lane(12, '1/16T', euclidHits(5, 12, 1, [84, 62, 74, 58, 70], 85)),
      shaker:  lane(16, '1/16', Array.from({ length: 16 }, (_, s) => [s, [40, 80, 55, 92][s % 4], 95])),
      chh:     lane(16, '1/16', [[2, 70], [6, 66], [10, 72], [14, 78]]),
      ohh:     lane(16, '1/16', []),
    };
    p.tracks.bass = { length: 16, rate: '1/16', notes: [
      note(0, 0, 2, 105), note(3, 0, 1, 70), note(6, 2, 1, 85),
      note(8, 3, 2, 95), note(11, 4, 1, 80, 80), note(14, 6, 1, 75),
    ] };
    p.tracks.pad = { length: 32, rate: '1/16', notes: [
      ...chordAt(0, 0, 'sev', 12, 76), ...chordAt(16, 3, 'sev', 12, 70),
    ] };
    p.tracks.lead = { length: 16, rate: '1/8', notes: [
      note(1, 7, 1, 72), note(4, 9, 1, 64), note(6, 11, 1, 60, 60), note(9, 8, 1, 66), note(13, 7, 1, 58, 70),
    ] };
    return p;
  }

  // --- Pattern C: drift. No backbeat; every lane on its own odd cycle and rate.
  function patternDrift() {
    const p = emptyPattern();
    p.tracks.drums.lanes = {
      kick:    lane(11, '1/8',   [[0, 92], [6, 70, 60]]),
      congaLo: lane(7,  '1/8',   euclidHits(3, 7, 0, [72, 56, 64], 85)),
      congaHi: lane(9,  '1/16T', euclidHits(4, 9, 2, [62, 44, 54, 40], 75)),
      snap:    lane(17, '1/16',  [[8, 56, 80]]),
      rim:     lane(5,  '1/16Q', euclidHits(2, 5, 0, [80, 58], 80)),
      shaker:  lane(13, '1/16',  euclidHits(7, 13, 0, [34, 50, 28, 46, 38, 56, 30], 80)),
      chh:     lane(16, '1/16',  []),
      ohh:     lane(3,  '1/4',   [[0, 46, 60]]),
    };
    p.tracks.bass = { length: 14, rate: '1/8', notes: [note(0, 0, 6, 95), note(8, 4, 4, 80, 80)] };
    p.tracks.pad = { length: 9, rate: '1/4', notes: [...chordAt(0, 0, 'nine', 5, 70), ...chordAt(5, 3, 'sev', 4, 64)] };
    p.tracks.lead = { length: 11, rate: '1/16T', notes: [note(0, 7, 1, 62, 70), note(4, 11, 1, 50, 50), note(7, 9, 1, 56, 60)] };
    return p;
  }

  function defaultMixer() {
    return {
      drums: { vol: 0, mute: false, solo: false, space: 0.12,
        echo: { ohh: 0.2, chh: 0.05, shaker: 0, rim: 0.5, snap: 0.35, congaHi: 0.15, congaLo: 0.05, kick: 0 } },
      bass: { vol: 0, mute: false, solo: false, space: 0, echo: 0, preset: 'dub', octave: 1, mono: true },
      lead: { vol: -2, mute: false, solo: false, space: 0.3, echo: 0.35, preset: 'kalimba', octave: 4, mono: false },
      pad:  { vol: -1, mute: false, solo: false, space: 0.35, echo: 0.6, preset: 'stab', octave: 3, mono: false },
    };
  }

  function defaultState() {
    return {
      version: STATE_VERSION,
      bpm: 120, swing: 0.06, volume: -4, humanize: 0.3,
      echoTime: '1/8.', echoFeedback: 0.55,
      root: 2, scale: 'dorian',
      current: 0, track: 'drums', voice: 'rim', chord: 'off', laneMode: 'vel',
      exportLength: 'cycle', drumMap: 'gm', splitDrums: false, bakeChance: false,
      mixer: defaultMixer(),
      patterns: [patternDub(), patternOrganic(), patternDrift(), emptyPattern()],
    };
  }

  // ---------------------------------------------------------------- validation
  const validVel = (v) => clampInt(v, 0, 127, 0);
  const validProb = (v) => clampInt(v, 0, 100, 100);
  const validRate = (r) => (RATE_BY_ID[r] ? r : '1/16');

  function normalizeLane(src) {
    const l = emptyLane();
    if (!src) return l;
    l.length = clampInt(src.length, 1, MAX_STEPS, 16);
    l.rate = validRate(src.rate);
    if (Array.isArray(src.vel)) l.vel = Array.from({ length: MAX_STEPS }, (_, i) => validVel(src.vel[i]));
    if (Array.isArray(src.prob)) l.prob = Array.from({ length: MAX_STEPS }, (_, i) => validProb(src.prob[i] ?? 100));
    return l;
  }

  function normalizePattern(p, fallback) {
    if (!p || typeof p !== 'object' || !p.tracks) return fallback;
    const out = emptyPattern();
    const lanes = p.tracks.drums && p.tracks.drums.lanes;
    if (lanes) for (const v of DRUM_VOICES) out.tracks.drums.lanes[v.id] = normalizeLane(lanes[v.id]);
    for (const t of MELODIC) {
      const src = p.tracks[t.id];
      if (!src) continue;
      const dst = out.tracks[t.id];
      dst.length = clampInt(src.length, 1, MAX_STEPS, 16);
      dst.rate = validRate(src.rate);
      if (Array.isArray(src.notes)) {
        dst.notes = src.notes
          .filter((x) => x && Number.isFinite(x.s) && Number.isFinite(x.r) && Number.isFinite(x.l))
          .map((x) => ({ s: clampInt(x.s, 0, MAX_STEPS - 1, 0), r: clampInt(x.r, 0, 36, 0), l: clampInt(x.l, 1, MAX_STEPS, 1),
            v: clampInt(x.v ?? 100, 1, 127, 100), p: validProb(x.p ?? 100) }));
      }
    }
    return out;
  }

  function normalizeGlobals(src, into) {
    into.bpm = clampInt(src.bpm, 40, 220, into.bpm);
    into.swing = clampNum(src.swing, 0, 0.6, into.swing);
    into.volume = clampInt(src.volume, -40, 6, into.volume);
    into.humanize = clampNum(src.humanize, 0, 1, into.humanize);
    if (ECHO_TIMES.some((e) => e.id === src.echoTime)) into.echoTime = src.echoTime;
    into.echoFeedback = clampNum(src.echoFeedback, 0, 0.85, into.echoFeedback);
    into.root = clampInt(src.root, 0, 11, into.root);
    if (SCALES[src.scale]) into.scale = src.scale;
    const m = src.mixer;
    if (!m) return;
    for (const t of TRACKS) {
      const s = m[t.id];
      if (!s) continue;
      const d = into.mixer[t.id];
      d.vol = clampInt(s.vol, -30, 6, d.vol);
      d.mute = !!s.mute;
      d.solo = !!s.solo;
      d.space = clampNum(s.space, 0, 1, d.space);
      if (t.kind === 'drums') {
        if (s.echo && typeof s.echo === 'object') for (const v of DRUM_VOICES) d.echo[v.id] = clampNum(s.echo[v.id], 0, 1, d.echo[v.id]);
      } else {
        d.echo = clampNum(s.echo, 0, 1, d.echo);
        if (PRESETS[t.id][s.preset]) d.preset = s.preset;
        d.octave = clampInt(s.octave, 0, 6, d.octave);
        if (typeof s.mono === 'boolean') d.mono = s.mono;
      }
    }
  }

  function loadState() {
    const s = defaultState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return s;
      const saved = JSON.parse(raw);
      if (!saved || saved.version !== STATE_VERSION) return s;
      normalizeGlobals(saved, s);
      s.current = clampInt(saved.current, 0, 3, 0);
      if (TRACK_BY_ID[saved.track]) s.track = saved.track;
      if (VOICE_BY_ID[saved.voice]) s.voice = saved.voice;
      if (CHORDS.some((c) => c.id === saved.chord)) s.chord = saved.chord;
      if (saved.laneMode === 'prob') s.laneMode = 'prob';
      if (['cycle', '1', '2', '4', '8', '16', '32'].includes(saved.exportLength)) s.exportLength = saved.exportLength;
      if (saved.drumMap === 'pads') s.drumMap = 'pads';
      s.splitDrums = !!saved.splitDrums;
      s.bakeChance = !!saved.bakeChance;
      if (Array.isArray(saved.patterns)) s.patterns = s.patterns.map((d, i) => normalizePattern(saved.patterns[i], d));
    } catch (e) { /* storage blocked or unreadable: start from the demos */ }
    return s;
  }

  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    }, 250);
  }

  const state = loadState();
  const pat = () => state.patterns[state.current];
  const scaleSteps = () => SCALES[state.scale].steps;
  const rowCount = () => scaleSteps().length * 2 + 1;

  function midiFor(trackId, row) {
    const steps = scaleSteps();
    const oct = Math.floor(row / steps.length);
    return 12 * (state.mixer[trackId].octave + 1) + state.root + 12 * oct + steps[row % steps.length];
  }
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const noteName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

  // All lanes of a pattern as {key, trackId, voice?, length, rate}
  function lanesOf(p) {
    const out = DRUM_VOICES.map((v) => ({ key: 'drums:' + v.id, trackId: 'drums', voice: v.id, lane: p.tracks.drums.lanes[v.id] }));
    for (const t of MELODIC) out.push({ key: t.id, trackId: t.id, lane: p.tracks[t.id] });
    return out;
  }

  function patternHasContent(p) {
    return DRUM_VOICES.some((v) => p.tracks.drums.lanes[v.id].vel.some(Boolean)) || MELODIC.some((t) => p.tracks[t.id].notes.length);
  }

  // ================================================================ audio engine
  let T = null;
  let engine = null;
  let playing = false;
  let masterTick = 0;
  let patStart = 0;
  let repeatId = null;
  let queuedSlot = null;
  let lastOhhTick = -1;
  const nowStep = {};      // laneKey -> step currently sounding

  const transport = () => (T.getTransport ? T.getTransport() : T.Transport);
  const drawer = () => (T.getDraw ? T.getDraw() : T.Draw);
  const beatsToSec = (beats) => (60 / state.bpm) * beats;

  function safe(fn) {
    try { fn(); } catch (e) { console.warn('[polyphemus]', e); }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('failed: ' + src));
      document.head.appendChild(s);
    });
  }

  async function loadTone() {
    if (window.Tone) return window.Tone;
    for (const src of TONE_SRCS) {
      try {
        await loadScript(src);
        if (window.Tone) return window.Tone;
      } catch (e) { /* next CDN */ }
    }
    throw new Error('Tone.js could not be loaded from any CDN.');
  }

  function buildEngine() {
    const tr = transport();
    tr.PPQ = PPQ;

    const master = new T.Volume(state.volume);
    const limiter = new T.Limiter(-1).toDestination();
    const glue = new T.Compressor({ threshold: -18, ratio: 2.5, attack: 0.02, release: 0.25 });
    master.chain(glue, limiter);

    // Dub echo: filtered, tempo-synced feedback delay. Space: long reverb.
    const echoIn = new T.Gain(1);
    const echoHp = new T.Filter(280, 'highpass');
    const echo = new T.FeedbackDelay({ delayTime: 0.375, maxDelay: 4, feedback: state.echoFeedback, wet: 1 });
    const echoLp = new T.Filter({ frequency: 2600, type: 'lowpass', Q: 0.8 });
    const echoOut = new T.Gain(0.9);
    echoIn.chain(echoHp, echo, echoLp, echoOut, master);
    const spaceIn = new T.Gain(1);
    const space = new T.Reverb({ decay: 7, preDelay: 0.03, wet: 1 });
    spaceIn.chain(space, master);
    echoOut.connect(spaceIn); // echoes bloom into the room a little

    const channels = {};
    const spaceSends = {};
    for (const t of TRACKS) {
      channels[t.id] = new T.Channel({ volume: 0 }).connect(master);
      spaceSends[t.id] = new T.Gain(0);
      channels[t.id].connect(spaceSends[t.id]);
      spaceSends[t.id].connect(spaceIn);
    }

    // ---- drums: each voice -> its own out gain -> drums channel, plus an echo send
    const dc = channels.drums;
    const drumEchoBus = new T.Gain(1).connect(echoIn);
    const voiceOut = {};
    const voiceEcho = {};
    for (const v of DRUM_VOICES) {
      voiceOut[v.id] = new T.Gain(1).connect(dc);
      voiceEcho[v.id] = new T.Gain(0).connect(drumEchoBus);
      voiceOut[v.id].connect(voiceEcho[v.id]);
    }
    const d = {};
    d.kick = new T.MembraneSynth({ pitchDecay: 0.06, octaves: 4, oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 0.7, sustain: 0, release: 0.2 } }).connect(voiceOut.kick);
    d.kick.volume.value = -2;

    const rimHp = new T.Filter(420, 'highpass').connect(voiceOut.rim);
    d.rim = new T.MembraneSynth({ pitchDecay: 0.006, octaves: 1.5,
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.03 } }).connect(rimHp);
    d.rim.volume.value = -6;

    const snapBp = new T.Filter({ frequency: 1700, type: 'bandpass', Q: 1.1 }).connect(voiceOut.snap);
    d.snap = new T.NoiseSynth({ noise: { type: 'pink' },
      envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.06 } }).connect(snapBp);
    d.snap.volume.value = -1;

    const shakerBp = new T.Filter({ frequency: 6500, type: 'bandpass', Q: 0.9 }).connect(voiceOut.shaker);
    d.shaker = new T.NoiseSynth({ noise: { type: 'white' },
      envelope: { attack: 0.008, decay: 0.06, sustain: 0, release: 0.03 } }).connect(shakerBp);
    d.shaker.volume.value = -9;

    const hatHp = new T.Filter(7500, 'highpass');
    const hatSplit = { chh: new T.Gain(1).connect(voiceOut.chh), ohh: new T.Gain(1).connect(voiceOut.ohh) };
    const metal = (decay) => ({ envelope: { attack: 0.001, decay, release: 0.03 },
      harmonicity: 5.1, modulationIndex: 28, resonance: 5200, octaves: 1.4 });
    d.chh = new T.MetalSynth(metal(0.045)).connect(new T.Filter(7500, 'highpass').connect(hatSplit.chh));
    d.chh.volume.value = -22;
    d.ohh = new T.MetalSynth(metal(0.45)).connect(hatHp.connect(hatSplit.ohh));
    d.ohh.volume.value = -25;

    const conga = () => new T.MembraneSynth({ pitchDecay: 0.018, octaves: 1.3,
      envelope: { attack: 0.001, decay: 0.28, sustain: 0, release: 0.08 } });
    d.congaHi = conga().connect(voiceOut.congaHi);
    d.congaHi.volume.value = -7;
    d.congaLo = conga().connect(voiceOut.congaLo);
    d.congaLo.volume.value = -6;

    // ---- melodic chains
    const bassLp = new T.Filter({ frequency: 900, type: 'lowpass', rolloff: -24 }).connect(channels.bass);
    const padMotion = new T.AutoFilter({ frequency: 0.06, baseFrequency: 260, octaves: 3.6, depth: 0.85,
      filter: { type: 'lowpass', rolloff: -24, Q: 2.2 }, wet: 1 }).connect(channels.pad).start();

    const echoSends = {};
    for (const t of MELODIC) {
      echoSends[t.id] = new T.Gain(0).connect(echoIn);
      channels[t.id].connect(echoSends[t.id]);
    }

    engine = {
      master, echo, channels, spaceSends, echoSends, voiceEcho, drumEchoBus, drums: d,
      inputs: { bass: bassLp, lead: channels.lead, pad: padMotion },
      synths: {},
    };
    for (const t of MELODIC) setPreset(t.id);
    applyGlobals();
    applyMixer();
  }

  function setPreset(trackId) {
    if (!engine) return;
    const old = engine.synths[trackId];
    if (old) safe(() => { old.releaseAll(); old.dispose(); });
    const recipes = PRESETS[trackId];
    const recipe = recipes[state.mixer[trackId].preset] || Object.values(recipes)[0];
    const synth = recipe.make(T);
    synth.maxPolyphony = trackId === 'pad' ? 32 : 12;
    synth.volume.value = recipe.gain;
    synth.connect(engine.inputs[trackId]);
    engine.synths[trackId] = synth;
  }

  function applyGlobals() {
    if (!engine) return;
    const tr = transport();
    tr.bpm.value = state.bpm;
    tr.swing = state.swing;
    tr.swingSubdivision = '16n';
    engine.master.volume.value = state.volume;
    const et = ECHO_TIMES.find((e) => e.id === state.echoTime) || ECHO_TIMES[2];
    engine.echo.delayTime.rampTo(beatsToSec(et.beats), 0.05);
    engine.echo.feedback.value = state.echoFeedback;
  }

  function applyMixer() {
    if (!engine) return;
    const anySolo = TRACKS.some((t) => state.mixer[t.id].solo);
    for (const t of TRACKS) {
      const m = state.mixer[t.id];
      const muted = anySolo ? !m.solo : m.mute;
      engine.channels[t.id].volume.value = m.vol;
      engine.channels[t.id].mute = muted;
      engine.spaceSends[t.id].gain.value = m.space;
      if (t.kind === 'melodic') engine.echoSends[t.id].gain.value = m.echo;
    }
    const dm = state.mixer.drums;
    engine.drumEchoBus.gain.value = (anySolo ? !dm.solo : dm.mute) ? 0 : 1;
    for (const v of DRUM_VOICES) engine.voiceEcho[v.id].gain.value = dm.echo[v.id];
  }

  async function ensureAudio() {
    if (!T) return false;
    if (T.getContext().state !== 'running') await T.start();
    if (!engine) buildEngine();
    return true;
  }

  function fireDrum(id, time, vel) {
    const d = engine.drums;
    switch (id) {
      case 'kick': d.kick.triggerAttackRelease(44, '8n', time, vel); break;
      case 'rim': d.rim.triggerAttackRelease(820, 0.03, time, vel); break;
      case 'snap':
        for (let k = 0; k < 3; k++) d.snap.triggerAttackRelease(0.025, time + k * 0.012, vel * (k === 2 ? 1 : 0.6));
        break;
      case 'shaker': d.shaker.triggerAttackRelease(0.04, time, vel); break;
      case 'chh': d.chh.triggerAttackRelease(330, 0.04, time, vel); break;
      case 'ohh': d.ohh.triggerAttackRelease(330, 0.35, time, vel); break;
      case 'congaHi': d.congaHi.triggerAttackRelease(262, 0.2, time, vel); break;
      case 'congaLo': d.congaLo.triggerAttackRelease(174, 0.25, time, vel); break;
      default: break;
    }
  }

  function humanized(time, vel) {
    const h = state.humanize;
    if (!h) return [time, vel];
    return [time + Math.random() * h * 0.018, Math.max(0.05, vel * (1 - Math.random() * h * 0.3))];
  }

  // Called every TICK_STEP ticks with the exact audio time of that tick.
  function tick(time) {
    const tk = masterTick;
    masterTick += TICK_STEP;
    if (queuedSlot !== null && tk % BAR === 0) {
      state.current = queuedSlot;
      queuedSlot = null;
      patStart = tk;
      drawer().schedule(() => { save(); renderAll(); }, time);
    }
    const rel = tk - patStart;
    const p = pat();
    const rc = rowCount();
    const steps = {};

    for (const L of lanesOf(p)) {
      const tps = rateTicks(L.lane.rate);
      if (rel % tps !== 0) continue;
      const s = (rel / tps) % L.lane.length;
      steps[L.key] = s;
      if (L.voice) {
        const v = L.lane.vel[s];
        if (v && Math.random() * 100 < L.lane.prob[s]) {
          const [t, vel] = humanized(time, v / 127);
          safe(() => fireDrum(L.voice, t, vel));
          if (L.voice === 'ohh') lastOhhTick = tk;
          else if (L.voice === 'chh' && lastOhhTick !== tk) safe(() => engine.drums.ohh.triggerRelease(t)); // choke
        }
      } else {
        const t = TRACK_BY_ID[L.trackId];
        const synth = engine.synths[t.id];
        const stepSec = beatsToSec(tps / PPQ);
        for (const n of L.lane.notes) {
          if (n.s !== s || n.r >= rc) continue;
          if (Math.random() * 100 >= n.p) continue;
          const [nt, vel] = humanized(time, n.v / 127);
          const dur = Math.max(0.03, n.l * stepSec * t.gate - 0.004);
          safe(() => synth.triggerAttackRelease(mtof(midiFor(t.id, n.r)), dur, nt, vel));
        }
      }
    }
    if (Object.keys(steps).length) drawer().schedule(() => showPlayheads(steps), time);
  }

  async function togglePlay() {
    if (!T) return;
    await ensureAudio();
    const tr = transport();
    if (playing) {
      tr.stop();
      playing = false;
      queuedSlot = null;
      clearPlayheads();
      renderSlots();
    } else {
      masterTick = 0;
      patStart = 0;
      if (repeatId === null) repeatId = tr.scheduleRepeat(tick, `${TICK_STEP}i`, 0);
      tr.position = 0;
      tr.start('+0.05');
      playing = true;
    }
    updatePlayButton();
  }

  function preview(trackId, rowOrVoice, vel = 0.75) {
    if (!engine) return;
    const time = T.now() + 0.01;
    if (trackId === 'drums') safe(() => fireDrum(rowOrVoice, time, vel));
    else safe(() => engine.synths[trackId].triggerAttackRelease(mtof(midiFor(trackId, rowOrVoice)), 0.25, time, vel));
  }

  // ================================================================ DOM helpers
  const $ = (sel) => document.querySelector(sel);
  function el(tag, attrs = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.setAttribute('style', v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
    return node;
  }
  const options = (list, selected) => list.map(([value, label]) => el('option', { value, text: label, selected: String(value) === String(selected) }));
  const rateOptions = (sel) => options(RATES.map((r) => [r.id, r.label]), sel);
  const lengthOptions = (sel) => options(Array.from({ length: MAX_STEPS }, (_, i) => [i + 1, String(i + 1)]), sel);
  const pct = (x) => Math.round(x * 100) + '%';

  let statusTimer = 0;
  function flash(msg, isError = false) {
    const s = $('#status');
    s.textContent = msg;
    s.classList.toggle('error', isError);
    s.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => s.classList.remove('show'), isError ? 6000 : 2400);
  }

  function slider({ id, label, min, max, step, value, format, onInput }) {
    const out = el('output', { for: id, text: format(value) });
    return el('div', { class: 'mini' },
      el('label', { for: id, text: label }),
      el('input', { id, type: 'range', min, max, step, value,
        oninput: (e) => { const v = +e.target.value; out.textContent = format(v); onInput(v); } }),
      out);
  }

  // ================================================================ header
  function initHeader() {
    $('#root').append(...options(NOTE_NAMES.map((n, i) => [i, n]), state.root));
    $('#scale').append(...options(Object.entries(SCALES).map(([id, s]) => [id, s.label]), state.scale));
    $('#echoTime').append(...options(ECHO_TIMES.map((e) => [e.id, e.label]), state.echoTime));

    $('#bpm').addEventListener('change', (e) => {
      state.bpm = clampInt(e.target.value, 40, 220, state.bpm);
      e.target.value = state.bpm;
      applyGlobals(); save();
    });
    $('#swing').addEventListener('input', (e) => { state.swing = +e.target.value / 100; $('#swingOut').textContent = pct(state.swing); applyGlobals(); save(); });
    $('#humanize').addEventListener('input', (e) => { state.humanize = +e.target.value / 100; $('#humanizeOut').textContent = pct(state.humanize); save(); });
    $('#volume').addEventListener('input', (e) => { state.volume = +e.target.value; applyGlobals(); save(); });
    $('#echoTime').addEventListener('change', (e) => { state.echoTime = e.target.value; applyGlobals(); save(); });
    $('#echoFb').addEventListener('input', (e) => { state.echoFeedback = +e.target.value / 100; $('#echoFbOut').textContent = pct(state.echoFeedback); applyGlobals(); save(); });
    $('#root').addEventListener('change', (e) => { state.root = +e.target.value; save(); renderEditor(); });
    $('#scale').addEventListener('change', (e) => { state.scale = e.target.value; save(); renderEditor(); renderLanes(); });
    $('#play').addEventListener('click', togglePlay);

    $('#copyTo').addEventListener('change', (e) => {
      const to = +e.target.value;
      e.target.value = '';
      if (!Number.isInteger(to) || to === state.current) return;
      state.patterns[to] = JSON.parse(JSON.stringify(pat()));
      save(); renderSlots();
      flash(`Copied pattern ${SLOT_NAMES[state.current]} to ${SLOT_NAMES[to]}`);
    });
    $('#copyCode').addEventListener('click', copyCode);
    $('#loadCode').addEventListener('click', loadCode);
  }

  function syncHeader() {
    $('#bpm').value = state.bpm;
    $('#swing').value = Math.round(state.swing * 100);
    $('#swingOut').textContent = pct(state.swing);
    $('#humanize').value = Math.round(state.humanize * 100);
    $('#humanizeOut').textContent = pct(state.humanize);
    $('#volume').value = state.volume;
    $('#echoTime').value = state.echoTime;
    $('#echoFb').value = Math.round(state.echoFeedback * 100);
    $('#echoFbOut').textContent = pct(state.echoFeedback);
    $('#root').value = state.root;
    $('#scale').value = state.scale;
  }

  function updatePlayButton() {
    const b = $('#play');
    b.disabled = !T;
    b.setAttribute('aria-pressed', String(playing));
    $('#playLabel').textContent = !T ? 'Loading sounds…' : playing ? 'Stop' : 'Play';
  }

  function renderSlots() {
    $('#slots').replaceChildren(...SLOT_NAMES.map((name, i) => el('button', {
      type: 'button',
      class: 'slot' + (patternHasContent(state.patterns[i]) ? ' has-notes' : '') + (queuedSlot === i ? ' queued' : ''),
      'aria-pressed': String(i === state.current),
      title: (playing ? `Switch to pattern ${name} at the next bar` : `Edit pattern ${name}`),
      text: name,
      onclick: () => selectSlot(i),
    })));
    $('#copyTo').replaceChildren(el('option', { value: '', text: `Copy ${SLOT_NAMES[state.current]} to…` }),
      ...SLOT_NAMES.map((n, i) => (i === state.current ? null : el('option', { value: i, text: `Pattern ${n}` }))).filter(Boolean));
  }

  function selectSlot(i) {
    if (playing) {
      queuedSlot = i === state.current ? null : i;
      renderSlots();
      return;
    }
    state.current = i;
    save();
    renderAll();
  }

  // ================================================================ track strips
  function cycleTicksOfTrack(p, trackId) {
    if (trackId === 'drums') {
      const cycles = DRUM_VOICES.map((v) => p.tracks.drums.lanes[v.id]).filter((l) => l.vel.some((x, i) => x && i < l.length))
        .map((l) => l.length * rateTicks(l.rate));
      return cycles.length ? cycles.reduce(lcm, 1) : 0;
    }
    const tr = p.tracks[trackId];
    return tr.length * rateTicks(tr.rate);
  }
  function describeTicks(tk) {
    if (!tk) return 'empty';
    const bars = tk / BAR;
    if (bars > 64) return `${Math.round(bars)} bars`;
    if (Number.isInteger(bars)) return bars === 1 ? '1 bar' : `${bars} bars`;
    return `${bars.toFixed(2).replace(/0$/, '')} bars`;
  }

  function trackSubtitle(t) {
    const p = pat();
    if (t.kind === 'drums') return `realigns every ${describeTicks(cycleTicksOfTrack(p, "drums"))}`;
    const m = state.mixer[t.id];
    const preset = t.presets.find((x) => x[0] === m.preset);
    const tr = p.tracks[t.id];
    return `${preset ? preset[1] : ''} · ${tr.length} × ${tr.rate}`;
  }

  function renderTracks() {
    $('#tracks').replaceChildren(...TRACKS.map((t, i) => {
      const m = state.mixer[t.id];
      const sel = state.track === t.id;
      const controls = [
        slider({ id: `vol-${t.id}`, label: 'Level', min: -30, max: 6, step: 1, value: m.vol,
          format: (v) => `${v > 0 ? '+' : ''}${v} dB`, onInput: (v) => { m.vol = v; applyMixer(); save(); } }),
      ];
      if (t.kind === 'melodic') {
        controls.push(slider({ id: `echo-${t.id}`, label: 'Echo', min: 0, max: 100, step: 1, value: Math.round(m.echo * 100),
          format: (v) => `${v}%`, onInput: (v) => { m.echo = v / 100; applyMixer(); save(); } }));
      }
      controls.push(slider({ id: `space-${t.id}`, label: 'Space', min: 0, max: 100, step: 1, value: Math.round(m.space * 100),
        format: (v) => `${v}%`, onInput: (v) => { m.space = v / 100; applyMixer(); save(); } }));

      return el('div', { class: 'track', 'data-id': t.id, 'data-selected': String(sel), style: `--tc: var(--c-${t.id})` },
        el('button', { type: 'button', class: 'track-name', 'aria-pressed': String(sel), onclick: () => selectTrack(t.id) },
          el('strong', { text: t.label }), el('span', { class: 'key', text: String(i + 1) }), el('span', { class: 'sub', text: trackSubtitle(t) })),
        el('div', { class: 'track-btns' },
          el('button', { type: 'button', class: 'mute', 'aria-pressed': String(m.mute), title: `Mute ${t.label}`, text: 'M',
            onclick: () => { m.mute = !m.mute; applyMixer(); save(); renderTracks(); } }),
          el('button', { type: 'button', class: 'solo', 'aria-pressed': String(m.solo), title: `Solo ${t.label}`, text: 'S',
            onclick: () => { m.solo = !m.solo; applyMixer(); save(); renderTracks(); } })),
        el('div', { class: 'lane', 'data-lane': t.id, 'aria-hidden': 'true', onclick: () => selectTrack(t.id) }),
        el('div', { class: 'track-ctrls' }, ...controls));
    }));
    renderLanes();
  }

  // Overview strip: for drums one thin row per voice, for melodic one row of note starts.
  function renderLanes() {
    const p = pat();
    const rc = rowCount();
    for (const t of TRACKS) {
      const host = document.querySelector(`[data-lane="${t.id}"]`);
      if (!host) continue;
      const rows = t.kind === 'drums'
        ? DRUM_VOICES.map((v) => ({ key: 'drums:' + v.id, lane: p.tracks.drums.lanes[v.id], on: (s) => p.tracks.drums.lanes[v.id].vel[s] > 0 }))
        : [{ key: t.id, lane: p.tracks[t.id], on: (s) => p.tracks[t.id].notes.some((n) => n.s === s && n.r < rc) }];
      const maxLen = Math.max(...rows.map((r) => r.lane.length));
      host.style.setProperty('--n', maxLen);
      host.replaceChildren(...rows.map((r) => el('div', { class: 'lane-row', 'data-key': r.key },
        ...Array.from({ length: maxLen }, (_, s) => el('i', { class: s >= r.lane.length ? 'out' : r.on(s) ? 'on' : '' })))));
      if (playing) for (const r of rows) markMini(r.key, nowStep[r.key]);
    }
  }

  function selectTrack(id) {
    state.track = id;
    save();
    renderTracks();
    renderEditor();
  }

  // ================================================================ editor
  const currentLane = () => (state.track === 'drums' ? pat().tracks.drums.lanes[state.voice] : pat().tracks[state.track]);

  function renderEditor() {
    const t = TRACK_BY_ID[state.track];
    const p = pat();
    const m = state.mixer[t.id];
    $('#editor').style.setProperty('--tc', `var(--c-${t.id})`);
    const L = currentLane();

    const title = el('h2', { class: 'editor-title' }, t.label,
      el('small', { text: `Pattern ${SLOT_NAMES[state.current]}${t.kind === 'melodic' ? ` · ${NOTE_NAMES[state.root]} ${SCALES[state.scale].label.toLowerCase()}` : ''}` }));

    const laneLabel = t.kind === 'drums' ? VOICE_BY_ID[state.voice].label : t.label;
    const laneCtl = [
      el('div', { class: 'field' }, el('label', { for: 'len', text: 'Steps' }),
        el('select', { id: 'len', onchange: (e) => { L.length = +e.target.value; commit(); } }, ...lengthOptions(L.length))),
      el('div', { class: 'field' }, el('label', { for: 'rate', text: 'Rate' }),
        el('select', { id: 'rate', onchange: (e) => { L.rate = e.target.value; commit(); } }, ...rateOptions(L.rate))),
      el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Shift' }),
        el('span', { class: 'stepper' },
          el('button', { type: 'button', 'aria-label': `Shift ${laneLabel} one step earlier`, text: '◀', onclick: () => rotate(-1) }),
          el('button', { type: 'button', 'aria-label': `Shift ${laneLabel} one step later`, text: '▶', onclick: () => rotate(1) }))),
    ];

    let rows1;
    let rows2;
    if (t.kind === 'drums') {
      const hitsSel = el('select', { id: 'euclidK', 'aria-label': 'Number of hits' },
        ...options(Array.from({ length: L.length + 1 }, (_, i) => [i, `${i} hits`]), Math.min(L.length, Math.max(1, Math.round(L.length * 0.3)))));
      rows1 = [title,
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', text: 'Clear all drums', onclick: () => clearTrack(t) })];
      rows2 = [
        el('span', { class: 'lane-name' }, el('span', { class: 'dot' }), laneLabel),
        ...laneCtl,
        el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Euclid' }), hitsSel,
          el('button', { type: 'button', text: 'Fill', title: `Spread the hits evenly across ${L.length} steps`,
            onclick: () => fillEuclid(+hitsSel.value) })),
        slider({ id: 'voiceEcho', label: 'Echo', min: 0, max: 100, step: 1, value: Math.round(m.echo[state.voice] * 100),
          format: (v) => `${v}%`, onInput: (v) => { m.echo[state.voice] = v / 100; applyMixer(); save(); } }),
        el('button', { type: 'button', text: `Clear ${laneLabel.toLowerCase()}`, onclick: () => clearLane() }),
      ];
    } else {
      rows1 = [title,
        el('div', { class: 'field' }, el('label', { for: 'preset', text: 'Sound' }),
          el('select', { id: 'preset', onchange: (e) => { m.preset = e.target.value; setPreset(t.id); save(); renderTracks(); } },
            ...options(t.presets, m.preset))),
        el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Octave' }),
          el('span', { class: 'stepper' },
            el('button', { type: 'button', 'aria-label': 'Octave down', text: '−', disabled: m.octave <= 0,
              onclick: () => { m.octave -= 1; save(); renderEditor(); } }),
            el('output', { text: noteName(midiFor(t.id, 0)), title: 'Lowest note in the grid' }),
            el('button', { type: 'button', 'aria-label': 'Octave up', text: '+', disabled: m.octave >= 6,
              onclick: () => { m.octave += 1; save(); renderEditor(); } }))),
        el('button', { type: 'button', class: 'toggle', 'aria-pressed': String(m.mono), title: 'One note per step; a new note cuts off the one before',
          text: 'Mono', onclick: () => { m.mono = !m.mono; save(); renderEditor(); } }),
        el('div', { class: 'field' }, el('label', { for: 'chord', text: 'Stamp' }),
          el('select', { id: 'chord', disabled: m.mono, title: m.mono ? 'Turn off Mono to stamp chords' : 'Each click places this chord, built from the scale',
            onchange: (e) => { state.chord = e.target.value; save(); } }, ...options(CHORDS.map((c) => [c.id, c.label]), m.mono ? 'off' : state.chord))),
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', text: `Clear ${t.label.toLowerCase()}`, onclick: () => clearTrack(t) })];
      rows2 = laneCtl;
    }
    $('#editorBar').replaceChildren(el('div', { class: 'bar-row' }, ...rows1), el('div', { class: 'bar-row lane-row-ctl' }, ...rows2));

    $('#hint').textContent = t.kind === 'drums'
      ? 'Click a voice name to edit its length, rate and echo. Click cells to add or remove hits and drag to paint; shift-click sets full velocity. Drag in the lane below to shape velocity or chance.'
      : 'Click an empty cell to add a note and drag right to hold it. Click a note to remove it. Drag in the lane below to shape velocity or chance for each step.';

    renderGrid();
  }

  function renderGrid() {
    const t = TRACK_BY_ID[state.track];
    const p = pat();
    const grid = $('#grid');
    grid.dataset.kind = t.kind;
    const frag = document.createDocumentFragment();
    const alt = (s) => (Math.floor(s / 4) % 2 === 1 ? ' alt' : '');
    let cols;

    if (t.kind === 'drums') {
      const lanes = p.tracks.drums.lanes;
      cols = Math.max(...DRUM_VOICES.map((v) => lanes[v.id].length));
      frag.append(el('div', { class: 'corner' }));
      for (let s = 0; s < cols; s++) frag.append(el('div', { class: 'stepnum' + (s % 4 === 0 ? ' beat' : ''), 'data-col': s, text: String(s + 1) }));
      for (const v of DRUM_VOICES) {
        const L = lanes[v.id];
        frag.append(el('button', { type: 'button', class: 'rowlabel voice' + (state.voice === v.id ? ' sel' : ''), 'data-voice': v.id,
          title: `Edit ${v.label} lane`, onclick: () => { state.voice = v.id; save(); renderEditor(); } },
          el('span', { class: 'vname', text: v.label }), el('span', { class: 'vmeta', text: `${L.length}·${L.rate}` })));
        for (let s = 0; s < cols; s++) {
          if (s >= L.length) { frag.append(el('div', { class: 'cell out', 'aria-hidden': 'true' })); continue; }
          const vel = L.vel[s];
          const prob = L.prob[s];
          frag.append(el('div', {
            class: 'cell' + alt(s) + (vel ? ' on' : '') + (vel && prob < 100 ? ' maybe' : '') + (state.voice === v.id ? ' selrow' : ''),
            'data-row': v.id, 'data-step': s, style: vel ? `--v:${(vel / 127).toFixed(3)}` : null,
            'aria-label': `${v.label} step ${s + 1}${vel ? `, velocity ${vel}` : ''}`,
          }));
        }
      }
    } else {
      const tr = p.tracks[t.id];
      cols = tr.length;
      frag.append(el('div', { class: 'corner' }));
      for (let s = 0; s < cols; s++) frag.append(el('div', { class: 'stepnum' + (s % 4 === 0 ? ' beat' : ''), 'data-col': s, text: String(s + 1) }));
      const rc = rowCount();
      const per = scaleSteps().length;
      const occ = Array.from({ length: rc }, () => new Array(cols).fill(null));
      for (const n of tr.notes) {
        if (n.r >= rc || n.s >= cols) continue;
        const end = Math.min(cols, n.s + n.l);
        for (let s = n.s; s < end; s++) occ[n.r][s] = { n, head: s === n.s, more: s < end - 1 };
      }
      for (let r = rc - 1; r >= 0; r--) {
        const isRoot = r % per === 0;
        const name = noteName(midiFor(t.id, r));
        frag.append(el('div', { class: 'rowlabel' + (isRoot ? ' root' : ''), text: name }));
        for (let s = 0; s < cols; s++) {
          const o = occ[r][s];
          frag.append(el('div', {
            class: 'cell' + alt(s) + (isRoot ? ' rootrow' : '') + (o ? ' on' : '') + (o && !o.head ? ' cont' : '') + (o && o.more ? ' more' : '') + (o && o.n.p < 100 ? ' maybe' : ''),
            'data-row': r, 'data-step': s, style: o ? `--v:${(o.n.v / 127).toFixed(3)}` : null,
            'aria-label': `${name} step ${s + 1}${o ? `, velocity ${o.n.v}` : ''}`,
          }));
        }
      }
    }
    grid.style.setProperty('--steps', cols);
    grid.replaceChildren(frag);
    renderVLane(cols);
    if (playing) for (const k of Object.keys(nowStep)) markGrid(k, nowStep[k]);
  }

  // Velocity / chance lane for the selected drum voice or melodic track.
  function laneValues() {
    const t = TRACK_BY_ID[state.track];
    const L = currentLane();
    const key = state.laneMode === 'vel' ? 'vel' : 'prob';
    const vals = [];
    for (let s = 0; s < L.length; s++) {
      if (t.kind === 'drums') vals.push(L.vel[s] ? (key === 'vel' ? L.vel[s] / 127 : L.prob[s] / 100) : null);
      else {
        const ns = L.notes.filter((n) => n.s === s && n.r < rowCount());
        vals.push(ns.length ? Math.max(...ns.map((n) => (key === 'vel' ? n.v / 127 : n.p / 100))) : null);
      }
    }
    return vals;
  }

  function renderVLane(cols) {
    const vl = $('#vlane');
    vl.style.setProperty('--steps', cols);
    const vals = laneValues();
    const isVel = state.laneMode === 'vel';
    const who = state.track === 'drums' ? VOICE_BY_ID[state.voice].label : TRACK_BY_ID[state.track].label;
    const head = el('div', { class: 'vhead' },
      el('div', { class: 'vtabs', role: 'group', 'aria-label': `${who} lane` },
        el('button', { type: 'button', 'aria-pressed': String(isVel), text: 'Velocity', onclick: () => { state.laneMode = 'vel'; save(); renderVLane(cols); } }),
        el('button', { type: 'button', 'aria-pressed': String(!isVel), text: 'Chance', onclick: () => { state.laneMode = 'prob'; save(); renderVLane(cols); } })),
      el('span', { class: 'vwho', text: who }));
    const cells = [];
    for (let s = 0; s < cols; s++) {
      const v = s < vals.length ? vals[s] : undefined;
      if (v === undefined) { cells.push(el('div', { class: 'vcell out' })); continue; }
      cells.push(el('div', { class: 'vcell' + (v === null ? ' empty' : ''), 'data-step': s,
        title: v === null ? '' : `${isVel ? 'Velocity' : 'Chance'} ${isVel ? Math.round(v * 127) : Math.round(v * 100) + '%'}` },
        v === null ? null : el('i', { style: `height:${Math.max(4, v * 100)}%` })));
    }
    vl.replaceChildren(head, ...cells);
    if (playing) markVLane(nowStep[state.track === 'drums' ? 'drums:' + state.voice : state.track]);
  }

  function renderAll() {
    syncHeader();
    renderSlots();
    renderTracks();
    renderEditor();
    renderExport();
  }

  function commit() {
    renderEditorLite();
    renderLanes();
    renderSlots();
    for (const t of TRACKS) {
      const sub = document.querySelector(`.track[data-id="${t.id}"] .sub`);
      if (sub) sub.textContent = trackSubtitle(t);
    }
    renderExport();
    save();
  }
  // Re-render the grid, and the lane controls if the lane shape changed.
  function renderEditorLite() {
    const L = currentLane();
    const len = $('#len');
    if (len && (+len.value !== L.length || $('#rate').value !== L.rate)) renderEditor();
    else renderGrid();
  }

  function clearTrack(t) {
    const p = pat();
    if (t.kind === 'drums') for (const v of DRUM_VOICES) { const L = p.tracks.drums.lanes[v.id]; L.vel = blank(0); L.prob = blank(100); }
    else p.tracks[t.id].notes = [];
    commit();
    flash(`Cleared ${t.label.toLowerCase()} in pattern ${SLOT_NAMES[state.current]}`);
  }
  function clearLane() {
    const L = currentLane();
    L.vel = blank(0); L.prob = blank(100);
    commit();
  }

  function rotate(d) {
    const L = currentLane();
    const n = L.length;
    if (state.track === 'drums') {
      const rot = (arr) => { const head = arr.slice(0, n); const r = ((d % n) + n) % n; const out = [...head.slice(n - r), ...head.slice(0, n - r)]; return [...out, ...arr.slice(n)]; };
      L.vel = rot(L.vel);
      L.prob = rot(L.prob);
    } else {
      for (const x of L.notes) if (x.s < n) x.s = (((x.s + d) % n) + n) % n;
    }
    commit();
  }

  function fillEuclid(k) {
    const L = currentLane();
    const pattern = euclid(k, L.length, 0);
    for (let s = 0; s < L.length; s++) {
      if (pattern[s]) { L.vel[s] = L.vel[s] || 96; } else { L.vel[s] = 0; L.prob[s] = 100; }
    }
    commit();
  }

  // ================================================================ playheads
  let gridCols = {}; // laneKey -> step marked
  function markGrid(key, s) {
    const grid = $('#grid');
    const t = TRACK_BY_ID[state.track];
    const isThisTrack = t.kind === 'drums' ? key.startsWith('drums:') : key === t.id;
    if (!isThisTrack) return;
    const prev = gridCols[key];
    const sel = (step) => (t.kind === 'drums'
      ? `.cell[data-row="${key.slice(6)}"][data-step="${step}"]`
      : `.cell[data-step="${step}"]`);
    if (prev !== undefined) grid.querySelectorAll(sel(prev)).forEach((c) => c.classList.remove('now'));
    gridCols[key] = s;
    if (s !== undefined) grid.querySelectorAll(sel(s)).forEach((c) => c.classList.add('now'));
    const selKey = t.kind === 'drums' ? 'drums:' + state.voice : t.id;
    if (key === selKey) {
      grid.querySelectorAll('.stepnum.now').forEach((c) => c.classList.remove('now'));
      if (s !== undefined) { const h = grid.querySelector(`.stepnum[data-col="${s}"]`); if (h) h.classList.add('now'); }
      markVLane(s);
    }
  }
  function markVLane(s) {
    const vl = $('#vlane');
    vl.querySelectorAll('.vcell.now').forEach((c) => c.classList.remove('now'));
    if (s !== undefined) { const c = vl.querySelector(`.vcell[data-step="${s}"]`); if (c) c.classList.add('now'); }
  }
  function markMini(key, s) {
    const row = document.querySelector(`.lane-row[data-key="${key}"]`);
    if (!row) return;
    const prev = row.querySelector('i.now');
    if (prev) prev.classList.remove('now');
    if (s !== undefined && row.children[s]) row.children[s].classList.add('now');
  }
  function showPlayheads(steps) {
    if (!playing) return;
    for (const [key, s] of Object.entries(steps)) {
      nowStep[key] = s;
      markMini(key, s);
      markGrid(key, s);
    }
  }
  function clearPlayheads() {
    for (const k of Object.keys(nowStep)) delete nowStep[k];
    gridCols = {};
    document.querySelectorAll('.now').forEach((c) => c.classList.remove('now'));
  }

  // ================================================================ editing
  const findNoteAt = (tr, r, s) => tr.notes.find((n) => n.r === r && s >= n.s && s < n.s + n.l);

  function addNotes(t, tr, row, s) {
    const m = state.mixer[t.id];
    const rc = rowCount();
    if (m.mono) {
      tr.notes = tr.notes.filter((n) => n.s !== s);
      for (const n of tr.notes) if (n.s < s && n.s + n.l > s) n.l = s - n.s;
    }
    const degrees = m.mono ? [0] : (CHORDS.find((c) => c.id === state.chord) || CHORDS[0]).degrees;
    const added = [];
    for (const r of degrees.map((d) => row + d).filter((r) => r < rc)) {
      tr.notes = tr.notes.filter((n) => !(n.r === r && s >= n.s && s < n.s + n.l));
      const n = note(s, r, 1, 100, 100);
      tr.notes.push(n);
      added.push(n);
    }
    return added;
  }

  function maxLength(t, tr, n0) {
    let cap = tr.length - n0.s;
    if (state.mixer[t.id].mono) for (const n of tr.notes) if (n !== n0 && n.s > n0.s) cap = Math.min(cap, n.s - n0.s);
    return Math.max(1, cap);
  }

  function initGrid() {
    const grid = $('#grid');
    let drag = null;
    const cellAt = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      const c = hit && hit.closest ? hit.closest('.cell[data-step]') : null;
      return c && grid.contains(c) ? c : null;
    };

    grid.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('.cell[data-step]');
      if (!cell || e.button > 0) return;
      e.preventDefault();
      ensureAudio().catch(() => {});
      const t = TRACK_BY_ID[state.track];
      const s = +cell.dataset.step;
      try { grid.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

      if (t.kind === 'drums') {
        const v = cell.dataset.row;
        const L = pat().tracks.drums.lanes[v];
        const cur = L.vel[s];
        const val = e.shiftKey ? 127 : (cur ? 0 : 100);
        L.vel[s] = val;
        if (!val) L.prob[s] = 100;
        if (state.voice !== v) { state.voice = v; renderEditor(); }
        drag = { kind: 'paint', val, last: `${v}:${s}` };
        if (val) preview('drums', v, val / 127);
        commit();
      } else {
        const tr = pat().tracks[t.id];
        const r = +cell.dataset.row;
        const existing = findNoteAt(tr, r, s);
        if (existing) {
          tr.notes = tr.notes.filter((n) => n !== existing);
          drag = null;
          commit();
          return;
        }
        const notes = addNotes(t, tr, r, s);
        drag = { kind: 'length', t, tr, notes };
        notes.forEach((n) => preview(t.id, n.r, 0.7));
        commit();
      }
    });

    grid.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const cell = cellAt(e.clientX, e.clientY);
      if (!cell) return;
      const s = +cell.dataset.step;
      if (drag.kind === 'paint') {
        const key = `${cell.dataset.row}:${s}`;
        if (key === drag.last) return;
        drag.last = key;
        const L = pat().tracks.drums.lanes[cell.dataset.row];
        if (L.vel[s] === drag.val) return;
        L.vel[s] = drag.val;
        if (!drag.val) L.prob[s] = 100;
        commit();
      } else {
        const lead = drag.notes[0];
        const l = Math.min(Math.max(1, s - lead.s + 1), maxLength(drag.t, drag.tr, lead));
        if (l === lead.l) return;
        drag.notes.forEach((n) => { n.l = l; });
        commit();
      }
    });
    const end = () => { drag = null; };
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', end);
    grid.addEventListener('lostpointercapture', end);
    grid.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function initVLane() {
    const vl = $('#vlane');
    let active = false;
    const apply = (e) => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const c = hit && hit.closest ? hit.closest('.vcell[data-step]') : null;
      if (!c || !vl.contains(c) || c.classList.contains('empty')) return;
      const rect = c.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height));
      const s = +c.dataset.step;
      const L = currentLane();
      const isVel = state.laneMode === 'vel';
      if (state.track === 'drums') {
        if (isVel) L.vel[s] = Math.max(1, Math.round(frac * 127));
        else L.prob[s] = Math.round(frac * 100);
      } else {
        for (const n of L.notes) if (n.s === s) { if (isVel) n.v = Math.max(1, Math.round(frac * 127)); else n.p = Math.round(frac * 100); }
      }
      const bar = c.querySelector('i');
      if (bar) bar.style.height = Math.max(4, frac * 100) + '%';
      c.title = `${isVel ? 'Velocity' : 'Chance'} ${isVel ? Math.round(frac * 127) : Math.round(frac * 100) + '%'}`;
    };
    vl.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.vcell[data-step]')) return;
      e.preventDefault();
      active = true;
      try { vl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      apply(e);
    });
    vl.addEventListener('pointermove', (e) => { if (active) apply(e); });
    const end = () => { if (!active) return; active = false; renderGrid(); save(); };
    vl.addEventListener('pointerup', end);
    vl.addEventListener('pointercancel', end);
    vl.addEventListener('lostpointercapture', end);
  }

  // ================================================================ MIDI export
  const DRUM_GATE = 0.5;

  function laneEvents(p, trackId, voiceId) {
    // -> { cycle, events: [{tick, dur, note, vel, prob}] } for one loop of the lane
    if (trackId === 'drums') {
      const L = p.tracks.drums.lanes[voiceId];
      const tps = rateTicks(L.rate);
      const v = VOICE_BY_ID[voiceId];
      const noteNum = state.drumMap === 'pads' ? v.pad : v.gm;
      const events = [];
      for (let s = 0; s < L.length; s++) if (L.vel[s]) events.push({ tick: s * tps, dur: Math.max(10, Math.round(tps * DRUM_GATE)), note: noteNum, vel: L.vel[s], prob: L.prob[s] });
      return { cycle: L.length * tps, events };
    }
    const tr = p.tracks[trackId];
    const t = TRACK_BY_ID[trackId];
    const tps = rateTicks(tr.rate);
    const rc = rowCount();
    const events = tr.notes.filter((n) => n.s < tr.length && n.r < rc).map((n) => ({
      tick: n.s * tps, dur: Math.max(10, Math.round(n.l * tps * t.gate)), note: midiFor(trackId, n.r), vel: n.v, prob: n.p,
    }));
    return { cycle: tr.length * tps, events };
  }

  function renderClip(lanes, fixedTicks) {
    // lanes: [{cycle, events}] -> { length, notes } rendered over the clip length
    const active = lanes.filter((l) => l.events.length);
    let length = fixedTicks;
    let capped = false;
    if (!length) {
      length = active.length ? active.map((l) => l.cycle).reduce(lcm, BAR) : BAR; // whole bars, so the clip loops cleanly
      if (length > 64 * BAR) { length = 64 * BAR; capped = true; }
    }
    const notes = [];
    for (const l of active) {
      for (let start = 0; start < length; start += l.cycle) {
        for (const ev of l.events) {
          let tick = start + ev.tick;
          if (tick >= length) continue;
          let vel = ev.vel;
          if (state.bakeChance) {
            if (Math.random() * 100 >= ev.prob) continue;
            const h = state.humanize;
            tick = Math.min(length - 1, tick + Math.round(Math.random() * h * 24));
            vel = Math.max(1, Math.round(vel * (1 - Math.random() * h * 0.3)));
          }
          notes.push({ tick, dur: Math.min(ev.dur, length - tick), note: ev.note, vel });
        }
      }
    }
    return { length, notes, capped };
  }

  function vlq(n) {
    const bytes = [n & 0x7f];
    while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
    return bytes;
  }
  function writeMidi({ name, channel, length, notes }) {
    const ev = [];
    for (const n of notes) {
      ev.push({ tick: n.tick, order: 1, bytes: [0x90 | channel, n.note, n.vel] });
      ev.push({ tick: n.tick + n.dur, order: 0, bytes: [0x80 | channel, n.note, 0] });
    }
    ev.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const trk = [];
    const nameBytes = Array.from(new TextEncoder().encode(name));
    trk.push(0, 0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes);
    const uspq = Math.round(60000000 / state.bpm);
    trk.push(0, 0xff, 0x51, 0x03, (uspq >> 16) & 0xff, (uspq >> 8) & 0xff, uspq & 0xff);
    trk.push(0, 0xff, 0x58, 0x04, 4, 2, 24, 8);
    let last = 0;
    for (const e of ev) { trk.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
    trk.push(...vlq(Math.max(0, length - last)), 0xff, 0x2f, 0x00);
    const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
    const tl = trk.length;
    return new Uint8Array([...head, 0x4d, 0x54, 0x72, 0x6b, (tl >>> 24) & 0xff, (tl >> 16) & 0xff, (tl >> 8) & 0xff, tl & 0xff, ...trk]);
  }

  function lengthLabel(ticks) {
    if (ticks % BAR === 0) return `${ticks / BAR}bar`;
    if (ticks % (PPQ / 4) === 0) return `${ticks / (PPQ / 4)}x16th`;
    return `${ticks}ticks`;
  }
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Build the list of clips for the export: [{filename, bytes, info}]
  function buildClips(which) {
    const p = pat();
    const fixed = state.exportLength === 'cycle' ? 0 : +state.exportLength * BAR;
    const slot = SLOT_NAMES[state.current];
    const clips = [];
    const tracks = which === 'all' ? TRACKS : [TRACK_BY_ID[which]];
    for (const t of tracks) {
      if (t.kind === 'drums') {
        const voices = DRUM_VOICES.filter((v) => p.tracks.drums.lanes[v.id].vel.some((x, i) => x && i < p.tracks.drums.lanes[v.id].length));
        if (!voices.length) continue;
        if (state.splitDrums) {
          for (const v of voices) {
            const L = p.tracks.drums.lanes[v.id];
            const clip = renderClip([laneEvents(p, 'drums', v.id)], fixed);
            const name = `Polyphemus ${slot} ${v.label}`;
            clips.push({ filename: `polyphemus-${slot}-${slug(v.label)}-${L.length}steps-${slug(L.rate)}-${lengthLabel(clip.length)}.mid`,
              bytes: writeMidi({ name, channel: 9, ...clip }), capped: clip.capped, label: v.label });
          }
        } else {
          const clip = renderClip(voices.map((v) => laneEvents(p, 'drums', v.id)), fixed);
          clips.push({ filename: `polyphemus-${slot}-drums-${lengthLabel(clip.length)}.mid`,
            bytes: writeMidi({ name: `Polyphemus ${slot} Drums`, channel: 9, ...clip }), capped: clip.capped, label: 'Drums' });
        }
      } else {
        if (!p.tracks[t.id].notes.length) continue;
        const clip = renderClip([laneEvents(p, t.id)], fixed);
        clips.push({ filename: `polyphemus-${slot}-${t.id}-${lengthLabel(clip.length)}.mid`,
          bytes: writeMidi({ name: `Polyphemus ${slot} ${t.label}`, channel: 0, ...clip }), capped: clip.capped, label: t.label });
      }
    }
    return clips;
  }

  // Minimal ZIP writer (stored, no compression).
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function makeZip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
    const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
    for (const f of files) {
      const name = new TextEncoder().encode(f.filename);
      const crc = crc32(f.bytes);
      const size = f.bytes.length;
      const local = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(dosTime), ...u16(dosDate),
        ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...name]);
      parts.push(local, f.bytes);
      central.push(new Uint8Array([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(dosTime), ...u16(dosDate),
        ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name]));
      offset += local.length + size;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  // Inside a claude.ai artifact, files go through the viewer's `downloads` capability
  // (which accepts .zip but not .mid); anywhere else a plain download link works.
  let downloadsNs;
  const downloadsReady = (async () => {
    try { downloadsNs = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { downloadsNs = null; }
    return downloadsNs;
  })();
  const inArtifact = () => !!(window.claude && window.claude.use);

  async function offerFile(filename, blob) {
    if (inArtifact()) {
      const dl = await downloadsReady;
      if (!dl) { flash('Downloads are not available in this view.', true); return; }
      try {
        await dl.save({ filename, data: blob });
        flash(`Saved ${filename}`);
      } catch (e) {
        if (e && e.code === 'declined') flash('Download cancelled');
        else if (e && e.code === 'rate_limited') flash('A download prompt is already open', true);
        else flash('The download could not be offered here.', true);
      }
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    flash(`Downloaded ${filename}`);
  }

  async function exportClips(which) {
    const clips = buildClips(which);
    if (!clips.length) { flash('Nothing to export: that part of the pattern is empty.', true); return; }
    const slot = SLOT_NAMES[state.current];
    if (clips.some((c) => c.capped)) flash('Some cycles run longer than 64 bars; those clips stop at 64 bars.');
    if (clips.length === 1 && !inArtifact()) {
      await offerFile(clips[0].filename, new Blob([clips[0].bytes], { type: 'audio/midi' }));
      return;
    }
    const tag = which === 'all' ? 'all' : which;
    await offerFile(`polyphemus-${slot}-${tag}-midi.zip`, makeZip(clips));
  }

  function renderExport() {
    const host = $('#exportBody');
    if (!host) return;
    const p = pat();
    const fixed = state.exportLength === 'cycle' ? 0 : +state.exportLength * BAR;
    const rows = TRACKS.map((t) => {
      const cyc = cycleTicksOfTrack(p, t.id);
      const full = cyc ? lcm(cyc, BAR) : 0;
      const clipLen = fixed || (full > 64 * BAR ? 64 * BAR : full);
      const empty = !cyc || (t.kind === 'melodic' && !p.tracks[t.id].notes.length);
      return el('div', { class: 'xrow', style: `--tc: var(--c-${t.id})` },
        el('span', { class: 'xname', text: t.label }),
        el('span', { class: 'xinfo', text: empty ? 'empty' : `cycle ${describeTicks(cyc)} → clip ${describeTicks(clipLen)}` }),
        el('button', { type: 'button', disabled: empty, text: inArtifact() ? 'Download .zip' : 'Download .mid',
          onclick: () => exportClips(t.id) }));
    });
    host.replaceChildren(...rows);
  }

  function initExport() {
    $('#exportLength').append(...options([['cycle', 'Full cycle (loops seamlessly)'], ...['1', '2', '4', '8', '16', '32'].map((b) => [b, `${b} bar${b === '1' ? '' : 's'}`])], state.exportLength));
    $('#drumMap').append(...options([['gm', 'General MIDI'], ['pads', 'Drum Rack pads C1–G1']], state.drumMap));
    $('#splitDrums').checked = state.splitDrums;
    $('#bakeChance').checked = state.bakeChance;
    $('#exportLength').addEventListener('change', (e) => { state.exportLength = e.target.value; save(); renderExport(); });
    $('#drumMap').addEventListener('change', (e) => { state.drumMap = e.target.value; save(); });
    $('#splitDrums').addEventListener('change', (e) => { state.splitDrums = e.target.checked; save(); });
    $('#bakeChance').addEventListener('change', (e) => { state.bakeChance = e.target.checked; save(); });
    $('#exportAll').addEventListener('click', () => exportClips('all'));
  }

  // ================================================================ share codes
  function encode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return CODE_PREFIX + btoa(bin);
  }
  function decode(code) {
    const bin = atob(code.trim().replace(/^PLY3:/, ''));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  }
  async function copyCode() {
    const { bpm, swing, volume, humanize, echoTime, echoFeedback, root, scale, mixer } = state;
    const code = encode({ v: STATE_VERSION, bpm, swing, volume, humanize, echoTime, echoFeedback, root, scale, mixer, pattern: pat() });
    const box = $('#code');
    box.value = code;
    try { await navigator.clipboard.writeText(code); flash('Pattern code copied'); } catch (e) { box.focus(); box.select(); flash('Code selected; copy it with ⌘C or Ctrl+C'); }
  }
  function loadCode() {
    const raw = $('#code').value;
    if (!raw.trim()) { flash('Paste a pattern code into the box first', true); return; }
    let data;
    try { data = decode(raw); } catch (e) { flash('That code could not be read. Check that it was copied in full.', true); return; }
    if (!data || data.v !== STATE_VERSION || !data.pattern) { flash('That is not a Polyphemus pattern code from this version.', true); return; }
    normalizeGlobals(data, state);
    state.patterns[state.current] = normalizePattern(data.pattern, emptyPattern());
    if (engine) { for (const t of MELODIC) setPreset(t.id); applyGlobals(); applyMixer(); }
    save();
    renderAll();
    flash(`Loaded into pattern ${SLOT_NAMES[state.current]}`);
  }

  // ================================================================ keyboard
  function initKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'select', 'textarea'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (/^Digit[1-4]$/.test(e.code)) selectTrack(TRACKS[+e.code.slice(5) - 1].id);
    });
  }

  // ================================================================ boot
  initHeader();
  initGrid();
  initVLane();
  initExport();
  initKeys();
  renderAll();
  updatePlayButton();
  downloadsReady.then(() => renderExport());

  loadTone()
    .then((Tone) => { T = Tone; updatePlayButton(); })
    .catch((err) => {
      console.error(err);
      $('#playLabel').textContent = 'Sound unavailable';
      flash('The sound engine (Tone.js) could not load. Check your connection and reload.', true);
    });

  window.polyphemus = { state, get engine() { return engine; }, get Tone() { return T; }, buildClips, makeZip, euclid };
})();
