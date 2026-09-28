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
  const STATE_VERSION = 4;
  const CODE_PREFIX = 'PLY4:';
  const MAX_STEPS = 64;
  const PPQ = 480;                       // ticks per quarter note, for the scheduler and MIDI files
  const BAR = PPQ * 4;
  const SLOT_NAMES = ['A', 'B', 'C', 'D'];
  const MAX_SECTIONS = 64;
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

  // Synth track types. A session has one drum kit plus up to MAX_SYNTHS synth tracks.
  const MAX_SYNTHS = 7;
  const SYNTH_TYPES = {
    bass: { label: 'Bass', octave: 1, mono: true,  gate: 0.92,
      presets: [['dub', 'Dub'], ['sub', 'Sub'], ['wood', 'Wood']] },
    lead: { label: 'Lead', octave: 4, mono: false, gate: 0.9,
      presets: [['kalimba', 'Kalimba'], ['marimba', 'Marimba'], ['glass', 'Glass']] },
    pad:  { label: 'Pad',  octave: 3, mono: false, gate: 1.0,
      presets: [['stab', 'Dub stab'], ['drift', 'Drift'], ['tape', 'Tape']] },
    keys: { label: 'Keys', octave: 3, mono: false, gate: 0.85,
      presets: [['organ', 'Dub organ'], ['ep', 'Electric piano'], ['pluck', 'Pluck']] },
  };
  const TRACK_COLORS = ['#e5733f', '#d6ae4a', '#5db3c8', '#a98bdb', '#8fb86a', '#d9798f', '#6f93d8', '#c9a27a'];
  const DEFAULT_TRACKS = [
    { id: 'drums', kind: 'drums', name: 'Drums', color: 0 },
    { id: 'bass', kind: 'synth', type: 'bass', name: 'Bass', color: 1 },
    { id: 'lead', kind: 'synth', type: 'lead', name: 'Lead', color: 2 },
    { id: 'pad',  kind: 'synth', type: 'pad',  name: 'Pad',  color: 3 },
  ];

  // Track records are stored plainly in state.tracks; this adds the derived fields the
  // rest of the code reads (label, kind 'melodic', presets, gate).
  function describeTrack(tr) {
    if (tr.kind === 'drums') return { ...tr, label: tr.name, kind: 'drums' };
    const ty = SYNTH_TYPES[tr.type];
    return { ...tr, label: tr.name, kind: 'melodic', typeLabel: ty.label, presets: ty.presets, gate: ty.gate, octave: ty.octave, mono: ty.mono };
  }
  const TRACKS = () => stateRef.tracks.map(describeTrack);
  const MELODIC = () => TRACKS().filter((t) => t.kind === 'melodic');
  const TRACK_BY_ID = (id) => { const tr = stateRef.tracks.find((x) => x.id === id); return tr ? describeTrack(tr) : null; };
  const trackColor = (t) => TRACK_COLORS[(t && t.color) || 0];
  let stateRef = null;

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
    keys: {
      organ: { gain: -14, make: (T) => new T.PolySynth(T.Synth, {
        oscillator: { type: 'custom', partials: [1, 0.7, 0.35, 0.18, 0.08] },
        envelope: { attack: 0.004, decay: 0.12, sustain: 0.35, release: 0.08 },
      }) },
      ep: { gain: -11, make: (T) => new T.PolySynth(T.FMSynth, {
        harmonicity: 1, modulationIndex: 4.5,
        oscillator: { type: 'sine' }, modulation: { type: 'sine' },
        envelope: { attack: 0.003, decay: 1.6, sustain: 0.15, release: 0.9 },
        modulationEnvelope: { attack: 0.002, decay: 0.7, sustain: 0.05, release: 0.5 },
      }) },
      pluck: { gain: -12, make: (T) => new T.PolySynth(T.Synth, {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.3 },
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

  const emptySynthPart = () => ({ length: 16, rate: '1/16', notes: [] });
  const emptyDrumPart = () => ({ lanes: Object.fromEntries(DRUM_VOICES.map((v) => [v.id, emptyLane()])) });

  function emptyPattern(trackList = stateRef ? stateRef.tracks : DEFAULT_TRACKS) {
    return { tracks: Object.fromEntries(trackList.map((t) => [t.id, t.kind === 'drums' ? emptyDrumPart() : emptySynthPart()])) };
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
    const p = emptyPattern(DEFAULT_TRACKS);
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
    const p = emptyPattern(DEFAULT_TRACKS);
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
    const p = emptyPattern(DEFAULT_TRACKS);
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

  // Mixer channel defaults. filter: −1 (low-pass closed) … 0 (open) … +1 (high-pass up).
  function mixerDefaults(tr) {
    const base = { vol: 0, pan: 0, mute: false, solo: false, space: 0.2, echo: 0.2, filter: 0, eqLow: 0, eqMid: 0, eqHigh: 0,
      swing: stateRef ? stateRef.swing : 54, swingGrid: '16' };
    if (tr.kind === 'drums') {
      return { ...base, space: 0.12,
        echo: { ohh: 0.2, chh: 0.05, shaker: 0, rim: 0.5, snap: 0.35, congaHi: 0.15, congaLo: 0.05, kick: 0 } };
    }
    const ty = SYNTH_TYPES[tr.type];
    return { ...base, preset: ty.presets[0][0], octave: ty.octave, mono: ty.mono };
  }

  function defaultMixer() {
    const m = Object.fromEntries(DEFAULT_TRACKS.map((t) => [t.id, mixerDefaults(t)]));
    Object.assign(m.bass, { space: 0, echo: 0, pan: 0 });
    Object.assign(m.lead, { vol: -2, space: 0.3, echo: 0.35, pan: 0.2 });
    Object.assign(m.pad, { vol: -1, space: 0.35, echo: 0.6, pan: -0.15 });
    return m;
  }

  function defaultMidi() {
    return { enabled: false, inName: '', outName: '', follow: true, sendNotes: true, sendClock: false, localAudio: false,
      offset: 0, channels: { drums: 10, bass: 1, lead: 2, pad: 3 } };
  }

  function defaultState() {
    return {
      version: STATE_VERSION,
      bpm: 120, swing: 54, volume: -4, humanize: 0.3,
      echoTime: '1/8.', echoFeedback: 0.55, echoReturn: 0.9, spaceReturn: 1, spaceSize: 7,
      root: 2, scale: 'dorian',
      view: 'seq', current: 0, track: 'drums', voice: 'rim', chord: 'off', laneMode: 'vel',
      songId: null, songName: 'Untitled song', playMode: 'pattern', songLoop: true,
      arrangement: [{ slot: 0, bars: 8 }, { slot: 1, bars: 8 }, { slot: 2, bars: 4 }, { slot: 0, bars: 8 }],
      exportLength: 'cycle', drumMap: 'gm', splitDrums: false, bakeChance: false, exportSwing: true,
      tracks: DEFAULT_TRACKS.map((t) => ({ ...t })),
      midi: defaultMidi(),
      mixer: defaultMixer(),
      patterns: [patternDub(), patternOrganic(), patternDrift(), emptyPattern(DEFAULT_TRACKS)],
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

  // Validate a stored track list: drums first, then up to MAX_SYNTHS synth tracks.
  function normalizeTracks(list) {
    const out = [{ ...DEFAULT_TRACKS[0] }];
    if (!Array.isArray(list)) return DEFAULT_TRACKS.map((t) => ({ ...t }));
    const drums = list.find((t) => t && t.kind === 'drums');
    if (drums && typeof drums.name === 'string' && drums.name.trim()) out[0].name = drums.name.trim().slice(0, 24);
    const seen = new Set(['drums']);
    for (const t of list) {
      if (!t || t.kind !== 'synth' || !SYNTH_TYPES[t.type] || typeof t.id !== 'string' || seen.has(t.id) || !/^[a-z0-9]{1,12}$/.test(t.id)) continue;
      if (out.length > MAX_SYNTHS) break;
      seen.add(t.id);
      out.push({ id: t.id, kind: 'synth', type: t.type,
        name: (typeof t.name === 'string' && t.name.trim() ? t.name.trim() : SYNTH_TYPES[t.type].label).slice(0, 24),
        color: clampInt(t.color, 0, TRACK_COLORS.length - 1, out.length % TRACK_COLORS.length) });
    }
    return out;
  }

  function normalizePattern(p, fallback, trackList) {
    if (!p || typeof p !== 'object' || !p.tracks) return fallback;
    const out = emptyPattern(trackList);
    const lanes = p.tracks.drums && p.tracks.drums.lanes;
    if (lanes) for (const v of DRUM_VOICES) out.tracks.drums.lanes[v.id] = normalizeLane(lanes[v.id]);
    for (const t of trackList) {
      if (t.kind === 'drums') continue;
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

  // Swing is stored as an MPC-style percentage: where the second 16th of each pair lands,
  // 50 = straight, 66 = triplet feel, 75 = the MPC's maximum. Sessions saved before this
  // (0–0.6 amounts on a sine curve) are converted to the percentage with the same offbeat delay.
  function readSwing(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    if (n < 1) return Math.round(Math.min(75, 50 + (n * 100) / 3));
    return Math.round(Math.min(75, Math.max(50, n)));
  }

  // Copy validated globals and mixer settings from `src` into `into` (whose tracks are already set).
  function normalizeGlobals(src, into) {
    into.bpm = clampNum(src.bpm, 40, 220, into.bpm);
    into.swing = readSwing(src.swing, into.swing);
    into.volume = clampInt(src.volume, -40, 6, into.volume);
    into.humanize = clampNum(src.humanize, 0, 1, into.humanize);
    if (ECHO_TIMES.some((e) => e.id === src.echoTime)) into.echoTime = src.echoTime;
    into.echoFeedback = clampNum(src.echoFeedback, 0, 0.85, into.echoFeedback);
    into.echoReturn = clampNum(src.echoReturn, 0, 1.2, into.echoReturn);
    into.spaceReturn = clampNum(src.spaceReturn, 0, 1.2, into.spaceReturn);
    into.spaceSize = clampNum(src.spaceSize, 1, 14, into.spaceSize);
    into.root = clampInt(src.root, 0, 11, into.root);
    if (SCALES[src.scale]) into.scale = src.scale;
    const m = src.mixer || {};
    const fresh = {};
    for (const t of into.tracks) {
      const d = (into.mixer && into.mixer[t.id]) ? { ...into.mixer[t.id] } : mixerDefaults(t);
      if (t.kind === 'drums') d.echo = { ...d.echo };
      const s = m[t.id];
      if (s) {
        d.vol = clampNum(s.vol, -60, 6, d.vol);
        d.pan = clampNum(s.pan, -1, 1, d.pan);
        d.mute = !!s.mute;
        d.solo = !!s.solo;
        d.space = clampNum(s.space, 0, 1, d.space);
        d.swing = readSwing(s.swing, into.swing);
        if (s.swingGrid === '8' || s.swingGrid === '16') d.swingGrid = s.swingGrid;
        d.filter = clampNum(s.filter, -1, 1, d.filter);
        for (const k of ['eqLow', 'eqMid', 'eqHigh']) d[k] = clampNum(s[k], -24, 12, d[k]);
        if (t.kind === 'drums') {
          if (s.echo && typeof s.echo === 'object') for (const v of DRUM_VOICES) d.echo[v.id] = clampNum(s.echo[v.id], 0, 1, d.echo[v.id]);
        } else {
          d.echo = clampNum(s.echo, 0, 1, d.echo);
          if (PRESETS[t.type][s.preset]) d.preset = s.preset;
          d.octave = clampInt(s.octave, 0, 6, d.octave);
          if (typeof s.mono === 'boolean') d.mono = s.mono;
        }
      }
      fresh[t.id] = d;
    }
    into.mixer = fresh;
  }

  function normalizeMidi(m, into, trackList) {
    const d = into;
    if (m && typeof m === 'object') {
      d.enabled = !!m.enabled;
      if (typeof m.inName === 'string') d.inName = m.inName;
      if (typeof m.outName === 'string') d.outName = m.outName;
      for (const k of ['follow', 'sendNotes', 'sendClock', 'localAudio']) if (typeof m[k] === 'boolean') d[k] = m[k];
      d.offset = clampInt(m.offset, -60, 120, 0);
    }
    const src = (m && m.channels) || {};
    const ch = {};
    for (const t of trackList) ch[t.id] = clampInt(src[t.id], 1, 16, d.channels[t.id] || nextFreeChannel(ch));
    d.channels = ch;
  }
  function nextFreeChannel(used) {
    const taken = new Set(Object.values(used));
    for (let c = 1; c <= 16; c++) if (c !== 10 && !taken.has(c)) return c;
    return 1;
  }

  // Apply a saved session (localStorage or a share code) on top of defaults.
  function sessionFrom(saved) {
    const s = defaultState();
    if (!saved || (saved.version !== STATE_VERSION && saved.version !== 3)) return null;
    s.tracks = normalizeTracks(saved.version === 3 ? DEFAULT_TRACKS : saved.tracks);
    normalizeGlobals(saved, s);
    s.current = clampInt(saved.current, 0, 3, 0);
    if (s.tracks.some((t) => t.id === saved.track)) s.track = saved.track;
    if (VOICE_BY_ID[saved.voice]) s.voice = saved.voice;
    if (CHORDS.some((c) => c.id === saved.chord)) s.chord = saved.chord;
    if (saved.laneMode === 'prob') s.laneMode = 'prob';
    if (saved.view === 'mix') s.view = 'mix';
    if (['cycle', '1', '2', '4', '8', '16', '32'].includes(saved.exportLength)) s.exportLength = saved.exportLength;
    if (saved.drumMap === 'pads') s.drumMap = 'pads';
    s.splitDrums = !!saved.splitDrums;
    s.bakeChance = !!saved.bakeChance;
    if (typeof saved.exportSwing === 'boolean') s.exportSwing = saved.exportSwing;
    normalizeMidi(saved.midi, s.midi, s.tracks);
    if (typeof saved.songName === 'string' && saved.songName.trim()) s.songName = saved.songName.trim().slice(0, 60);
    s.songId = typeof saved.songId === 'string' && /^[a-z0-9]{4,24}$/.test(saved.songId) ? saved.songId : null;
    if (saved.playMode === 'song') s.playMode = 'song';
    if (typeof saved.songLoop === 'boolean') s.songLoop = saved.songLoop;
    if (Array.isArray(saved.arrangement)) {
      s.arrangement = saved.arrangement.slice(0, MAX_SECTIONS)
        .filter((x) => x && Number.isFinite(+x.slot) && Number.isFinite(+x.bars))
        .map((x) => ({ slot: clampInt(x.slot, 0, 3, 0), bars: clampInt(x.bars, 1, 128, 4) }));
    }
    const fallback = (i) => (s.tracks.length === DEFAULT_TRACKS.length ? s.patterns[i] : emptyPattern(s.tracks));
    s.patterns = [0, 1, 2, 3].map((i) => normalizePattern(Array.isArray(saved.patterns) ? saved.patterns[i] : null, fallback(i), s.tracks));
    return s;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { const s = sessionFrom(JSON.parse(raw)); if (s) return s; }
    } catch (e) { /* storage blocked or unreadable: start from the demos */ }
    return defaultState();
  }

  let saveTimer = 0;
  const flushSave = () => {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  };
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { flushSave(); updateSongBar(); }, 250);
  }
  window.addEventListener('pagehide', () => { if (saveTimer) flushSave(); });

  const state = loadState();
  stateRef = state;
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

  // All lanes of a pattern as {key, trackId, voice?, lane}
  function lanesOf(p) {
    const out = DRUM_VOICES.map((v) => ({ key: 'drums:' + v.id, trackId: 'drums', voice: v.id, lane: p.tracks.drums.lanes[v.id] }));
    for (const t of state.tracks) if (t.kind === 'synth') out.push({ key: t.id, trackId: t.id, lane: p.tracks[t.id] });
    return out;
  }

  function patternHasContent(p) {
    return DRUM_VOICES.some((v) => p.tracks.drums.lanes[v.id].vel.some(Boolean)) || state.tracks.some((t) => t.kind === 'synth' && p.tracks[t.id] && p.tracks[t.id].notes.length);
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

  // Mixer strip for one track: input → EQ → DJ filter (low-pass + high-pass) → channel
  // (volume, pan, mute) → master, with a meter and post-fader echo/space sends.
  function buildStrip(id, withEchoSend) {
    const input = new T.Gain(1);
    const eq = new T.EQ3({ low: 0, mid: 0, high: 0, lowFrequency: 250, highFrequency: 3000 });
    const lp = new T.Filter({ frequency: 20000, type: 'lowpass', rolloff: -24, Q: 1.2 });
    const hp = new T.Filter({ frequency: 10, type: 'highpass', rolloff: -24, Q: 1.2 });
    const channel = new T.Channel({ volume: 0, pan: 0 });
    input.chain(eq, lp, hp, channel, engine.master);
    const meter = new T.Meter({ smoothing: 0.7 });
    channel.connect(meter);
    const spaceSend = new T.Gain(0).connect(engine.spaceIn);
    channel.connect(spaceSend);
    let echoSend = null;
    if (withEchoSend) { echoSend = new T.Gain(0).connect(engine.echoIn); channel.connect(echoSend); }
    const strip = { input, eq, lp, hp, channel, meter, spaceSend, echoSend, extras: [] };
    engine.strips[id] = strip;
    return strip;
  }

  function disposeStrip(id) {
    const st = engine && engine.strips[id];
    if (!st) return;
    const syn = engine.synths[id];
    if (syn) safe(() => { syn.releaseAll(); syn.dispose(); });
    delete engine.synths[id];
    for (const n of [...st.extras, st.input, st.eq, st.lp, st.hp, st.channel, st.meter, st.spaceSend, st.echoSend]) if (n) safe(() => n.dispose());
    delete engine.strips[id];
  }

  // Per-type processing between the synth and the strip.
  function buildSynthTrack(tr) {
    const strip = buildStrip(tr.id, true);
    let head = strip.input;
    if (tr.type === 'bass') {
      const lp = new T.Filter({ frequency: 900, type: 'lowpass', rolloff: -24 }).connect(strip.input);
      strip.extras.push(lp); head = lp;
    } else if (tr.type === 'pad') {
      const motion = new T.AutoFilter({ frequency: 0.06, baseFrequency: 260, octaves: 3.6, depth: 0.85,
        filter: { type: 'lowpass', rolloff: -24, Q: 2.2 }, wet: 1 }).connect(strip.input).start();
      strip.extras.push(motion); head = motion;
    } else if (tr.type === 'keys') {
      const trem = new T.Tremolo({ frequency: 4.5, depth: 0.25, spread: 60, wet: 0.6 }).connect(strip.input).start();
      strip.extras.push(trem); head = trem;
    }
    strip.head = head;
    setPreset(tr.id);
  }

  function buildEngine() {
    const tr = transport();
    tr.PPQ = PPQ;

    const master = new T.Volume(state.volume);
    const limiter = new T.Limiter(-1).toDestination();
    const glue = new T.Compressor({ threshold: -18, ratio: 2.5, attack: 0.02, release: 0.25 });
    const masterMeter = new T.Meter({ smoothing: 0.7 });
    master.chain(glue, limiter);
    limiter.connect(masterMeter);

    // Dub echo: filtered, tempo-synced feedback delay. Space: long reverb. Each has a return level.
    const echoIn = new T.Gain(1);
    const echoHp = new T.Filter(280, 'highpass');
    const echo = new T.FeedbackDelay({ delayTime: 0.375, maxDelay: 4, feedback: state.echoFeedback, wet: 1 });
    const echoLp = new T.Filter({ frequency: 2600, type: 'lowpass', Q: 0.8 });
    const echoOut = new T.Gain(state.echoReturn);
    const echoMeter = new T.Meter({ smoothing: 0.7 });
    echoIn.chain(echoHp, echo, echoLp, echoOut, master);
    echoOut.connect(echoMeter);
    const spaceIn = new T.Gain(1);
    const space = new T.Reverb({ decay: state.spaceSize, preDelay: 0.03, wet: 1 });
    const spaceOut = new T.Gain(state.spaceReturn);
    const spaceMeter = new T.Meter({ smoothing: 0.7 });
    spaceIn.chain(space, spaceOut, master);
    spaceOut.connect(spaceMeter);
    const echoToSpace = new T.Gain(0.25).connect(spaceIn); // echoes bloom into the room a little
    echoOut.connect(echoToSpace);

    engine = {
      master, masterMeter, echo, echoIn, echoOut, echoMeter, space, spaceIn, spaceOut, spaceMeter,
      strips: {}, synths: {}, drums: {}, voiceEcho: {}, drumEchoBus: null,
    };

    // ---- drums: each voice -> its own out gain -> drums strip, plus a per-voice echo send
    const ds = buildStrip('drums', false);
    const drumEchoBus = new T.Gain(1).connect(echoIn);
    engine.drumEchoBus = drumEchoBus;
    const voiceOut = {};
    for (const v of DRUM_VOICES) {
      voiceOut[v.id] = new T.Gain(1).connect(ds.input);
      engine.voiceEcho[v.id] = new T.Gain(0).connect(drumEchoBus);
      voiceOut[v.id].connect(engine.voiceEcho[v.id]);
    }
    const d = engine.drums;
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

    const metal = (decay) => ({ envelope: { attack: 0.001, decay, release: 0.03 },
      harmonicity: 5.1, modulationIndex: 28, resonance: 5200, octaves: 1.4 });
    d.chh = new T.MetalSynth(metal(0.045)).connect(new T.Filter(7500, 'highpass').connect(voiceOut.chh));
    d.chh.volume.value = -22;
    d.ohh = new T.MetalSynth(metal(0.45)).connect(new T.Filter(7500, 'highpass').connect(voiceOut.ohh));
    d.ohh.volume.value = -25;

    const conga = () => new T.MembraneSynth({ pitchDecay: 0.018, octaves: 1.3,
      envelope: { attack: 0.001, decay: 0.28, sustain: 0, release: 0.08 } });
    d.congaHi = conga().connect(voiceOut.congaHi);
    d.congaHi.volume.value = -7;
    d.congaLo = conga().connect(voiceOut.congaLo);
    d.congaLo.volume.value = -6;

    for (const t of state.tracks) if (t.kind === 'synth') buildSynthTrack(t);
    applyGlobals();
    applyMixer();
  }

  function setPreset(trackId) {
    if (!engine || !engine.strips[trackId]) return;
    const tr = state.tracks.find((t) => t.id === trackId);
    const old = engine.synths[trackId];
    if (old) safe(() => { old.releaseAll(); old.dispose(); });
    const recipes = PRESETS[tr.type];
    const recipe = recipes[state.mixer[trackId].preset] || Object.values(recipes)[0];
    const synth = recipe.make(T);
    synth.maxPolyphony = tr.type === 'pad' ? 32 : 12;
    synth.volume.value = recipe.gain;
    synth.connect(engine.strips[trackId].head);
    engine.synths[trackId] = synth;
  }

  function applyGlobals() {
    if (!engine) return;
    const tr = transport();
    tr.bpm.value = state.bpm;
    tr.swing = 0; // swing is applied per track in tick()
    engine.master.volume.value = state.volume;
    const et = ECHO_TIMES.find((e) => e.id === state.echoTime) || ECHO_TIMES[2];
    engine.echo.delayTime.rampTo(beatsToSec(et.beats), 0.05);
    engine.echo.feedback.value = state.echoFeedback;
    engine.echoOut.gain.rampTo(state.echoReturn, 0.05);
    engine.spaceOut.gain.rampTo(state.spaceReturn, 0.05);
  }

  // Bipolar DJ filter: −1 closes the low-pass to 200 Hz, +1 raises the high-pass to 6 kHz.
  function filterFreqs(f) {
    if (f < -0.01) return { lp: 20000 * Math.pow(0.01, -f), hp: 10 };
    if (f > 0.01) return { lp: 20000, hp: 20 * Math.pow(300, f) };
    return { lp: 20000, hp: 10 };
  }

  function applyStrip(t, anySolo) {
    const st = engine && engine.strips[t.id];
    if (!st) return;
    const m = state.mixer[t.id];
    st.channel.volume.rampTo(m.vol <= -60 ? -Infinity : m.vol, 0.03);
    st.channel.pan.rampTo(m.pan, 0.03);
    st.channel.mute = anySolo ? !m.solo : m.mute;
    st.eq.low.value = m.eqLow;
    st.eq.mid.value = m.eqMid;
    st.eq.high.value = m.eqHigh;
    const f = filterFreqs(m.filter);
    st.lp.frequency.rampTo(f.lp, 0.04);
    st.hp.frequency.rampTo(f.hp, 0.04);
    st.spaceSend.gain.rampTo(m.space, 0.03);
    if (st.echoSend) st.echoSend.gain.rampTo(m.echo, 0.03);
  }

  function applyMixer() {
    if (!engine) return;
    const anySolo = state.tracks.some((t) => state.mixer[t.id].solo);
    for (const t of state.tracks) applyStrip(t, anySolo);
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

  // ---- song mode: the arrangement is a list of {slot, bars}; each section restarts its lanes.
  let songPos = { index: -1, pass: 0 };
  const songActive = () => state.playMode === 'song' && state.arrangement.length > 0;
  const songBars = () => state.arrangement.reduce((a, x) => a + x.bars, 0);
  // Which section a tick falls in, and the tick that section started on (null once a non-looping song ends).
  function sectionAt(tk) {
    const total = songBars() * BAR;
    if (!total) return null;
    const pass = Math.floor(tk / total);
    if (pass > 0 && !state.songLoop) return null;
    let off = tk - pass * total;
    let start = pass * total;
    for (let i = 0; i < state.arrangement.length; i++) {
      const len = state.arrangement[i].bars * BAR;
      if (off < len) return { index: i, slot: state.arrangement[i].slot, start, pass };
      off -= len;
      start += len;
    }
    return null;
  }

  // Called every TICK_STEP ticks with the exact audio time of that tick. Internally the
  // Tone Transport drives it (and applies swing); when following MIDI clock, onClockPulse does.
  function tick(time) {
    const tk = masterTick;
    masterTick += TICK_STEP;
    if (songActive()) {
      const sec = sectionAt(tk);
      if (!sec) { drawer().schedule(() => { if (playing && !following) stopPlayback(); }, time); return; }
      patStart = sec.start;
      if (sec.index !== songPos.index || sec.pass !== songPos.pass) {
        songPos = { index: sec.index, pass: sec.pass };
        const slotChanged = state.current !== sec.slot;
        state.current = sec.slot;
        drawer().schedule(() => { if (slotChanged) renderAll(); else renderSlots(); markArrangement(sec.index); }, time);
      }
    } else if (queuedSlot !== null && tk % BAR === 0) {
      state.current = queuedSlot;
      queuedSlot = null;
      patStart = tk;
      drawer().schedule(() => { save(); renderAll(); }, time);
    }
    if (midi.sendClock && !following && tk % CLOCK_TICKS === 0) {
      if (tk === 0) midiSend([0xfa], time);
      midiSend([0xf8], time);
    }
    const rel = tk - patStart;
    const p = pat();
    const rc = rowCount();
    const steps = {};
    const local = !!engine && (midi.localAudio || !midiOut);

    for (const L of lanesOf(p)) {
      const tps = rateTicks(L.lane.rate);
      if (rel % tps !== 0) continue;
      const s = (rel / tps) % L.lane.length;
      steps[L.key] = s;
      const lt = time + swingOffset(tk, state.mixer[L.trackId]);
      if (L.voice) {
        const v = L.lane.vel[s];
        if (v && Math.random() * 100 < L.lane.prob[s]) {
          const [t, vel] = humanized(lt, v / 127);
          if (local) {
            safe(() => fireDrum(L.voice, t, vel));
            if (L.voice === 'ohh') lastOhhTick = tk;
            else if (L.voice === 'chh' && lastOhhTick !== tk) safe(() => engine.drums.ohh.triggerRelease(t)); // choke
          }
          midiNote('drums', drumNote(L.voice), vel, t, 0.06);
        }
      } else {
        const t = TRACK_BY_ID(L.trackId);
        const synth = engine && engine.synths[t.id];
        const stepSec = beatsToSec(tps / PPQ);
        for (const n of L.lane.notes) {
          if (n.s !== s || n.r >= rc) continue;
          if (Math.random() * 100 >= n.p) continue;
          const [nt, vel] = humanized(lt, n.v / 127);
          const dur = Math.max(0.03, n.l * stepSec * t.gate - 0.004);
          const m = midiFor(t.id, n.r);
          if (local) safe(() => synth.triggerAttackRelease(mtof(m), dur, nt, vel));
          midiNote(t.id, m, vel, nt, dur);
        }
      }
    }
    if (Object.keys(steps).length) drawer().schedule(() => showPlayheads(steps), time);
  }

  // Swing as Roger Linn built it into the LM-1, Linn 9000 and MPC60: within each pair of 16ths
  // (or 8ths, with the 1/8 grid) only the second note moves, landing at `pct` of the pair.
  // 50% is straight, 66% a triplet shuffle, 75% the maximum. Notes off that grid (triplets,
  // odd 32nds) are left alone, as the MPC's quantize would leave them.
  function swingTicks(tk, pct, grid = '16') {
    const pair = grid === '8' ? PPQ : PPQ / 2;
    if (!pct || pct <= 50 || tk % pair !== pair / 2) return 0;
    return ((pct - 50) / 100) * pair;
  }
  const swingOffset = (tk, m) => beatsToSec(swingTicks(tk, m.swing, m.swingGrid) / PPQ);

  function startInternal() {
    const tr = transport();
    masterTick = 0;
    patStart = 0;
    songPos = { index: -1, pass: 0 };
    if (repeatId === null) repeatId = tr.scheduleRepeat(tick, `${TICK_STEP}i`, 0);
    tr.position = 0;
    tr.start('+0.05');
    playing = true;
  }

  function stopPlayback() {
    if (!following) transport().stop();
    if (midi.sendClock && !following) midiSend([0xfc], null);
    midiPanic();
    playing = false;
    queuedSlot = null;
    songPos = { index: -1, pass: 0 };
    clearPlayheads();
    renderSlots();
    markArrangement(-1);
    updatePlayButton();
  }

  async function togglePlay() {
    if (!T) return;
    if (following) { flash('Tempo and start/stop follow the MIDI clock. Start and stop from Live.'); return; }
    await ensureAudio();
    if (playing) stopPlayback();
    else { startInternal(); updatePlayButton(); }
  }

  function preview(trackId, rowOrVoice, vel = 0.75) {
    const note = trackId === 'drums' ? drumNote(rowOrVoice) : midiFor(trackId, rowOrVoice);
    if (midiOut) midiNote(trackId, note, vel, null, 0.25);
    if (!engine || (midiOut && !midi.localAudio)) return;
    const time = T.now() + 0.01;
    if (trackId === 'drums') safe(() => fireDrum(rowOrVoice, time, vel));
    else safe(() => engine.synths[trackId].triggerAttackRelease(mtof(note), 0.25, time, vel));
  }

  // ================================================================ Web MIDI: clock in, notes and clock out
  const CLOCK_TICKS = PPQ / 24;            // MIDI clock runs at 24 pulses per quarter note
  // Seconds between a clock pulse arriving and the notes for it: enough headroom to schedule
  // audio when the built-in sounds play, just a little when only MIDI goes out.
  const midiLatency = () => (state.midi.localAudio ? 0.08 : 0.02);
  const midi = state.midi;
  let midiAccess = null;
  let midiIn = null;
  let midiOut = null;
  let following = false;                   // playing from an external clock
  let clockTimes = [];                     // recent pulse timestamps (ms)
  let pulseSec = 60 / state.bpm / 24;
  let pendingSpp = 0;
  let lastTempoUi = 0;

  const drumNote = (voiceId) => (state.drumMap === 'pads' ? VOICE_BY_ID[voiceId].pad : VOICE_BY_ID[voiceId].gm);
  const channelOf = (trackId) => Math.max(0, Math.min(15, (midi.channels[trackId] || 1) - 1));

  // Convert between the audio clock (seconds) and performance.now() (ms), which is what
  // MIDI timestamps use.
  function clockMap() {
    const raw = T && T.getContext().rawContext;
    if (raw && raw.getOutputTimestamp) {
      const ts = raw.getOutputTimestamp();
      if (ts && ts.performanceTime) return { ctx: ts.contextTime, perf: ts.performanceTime };
    }
    return { ctx: T ? T.now() : 0, perf: performance.now() };
  }
  const audioToPerf = (sec) => { const m = clockMap(); return m.perf + (sec - m.ctx) * 1000; };
  const perfToAudio = (ms) => { const m = clockMap(); return m.ctx + (ms - m.perf) / 1000; };

  function midiSend(bytes, audioTime) {
    if (!midiOut) return;
    const when = audioTime === null ? performance.now() : audioToPerf(audioTime) + midi.offset;
    try { midiOut.send(bytes, Math.max(performance.now(), when)); } catch (e) { console.warn('[polyphemus] midi', e); }
  }
  function midiNote(trackId, note, vel01, audioTime, durSec) {
    if (!midiOut || !midi.sendNotes) return;
    const ch = channelOf(trackId);
    const v = Math.max(1, Math.min(127, Math.round(vel01 * 127)));
    const on = audioTime === null ? performance.now() : Math.max(performance.now(), audioToPerf(audioTime) + midi.offset);
    try {
      midiOut.send([0x90 | ch, note, v], on);
      midiOut.send([0x80 | ch, note, 0], on + durSec * 1000);
    } catch (e) { console.warn('[polyphemus] midi', e); }
  }
  function midiPanic() {
    if (!midiOut) return;
    for (const t of TRACKS()) { const ch = channelOf(t.id); try { midiOut.send([0xb0 | ch, 123, 0]); } catch (e) { /* ignore */ } }
  }

  function onMidiMessage(ev) {
    const [st, d1, d2] = ev.data;
    if (!midi.follow) return;
    switch (st) {
      case 0xf8: onClockPulse(ev.timeStamp || performance.now()); break;
      case 0xfa: externalStart(0); break;                       // Start: from the top
      case 0xfb: externalStart(pendingSpp * (PPQ / 4)); break;  // Continue: from the song position
      case 0xfc: if (following) { following = false; stopPlayback(); renderMidi(); } break;
      case 0xf2: pendingSpp = (d1 | (d2 << 7)); break;         // Song Position Pointer, in 16ths
      default: break;
    }
  }

  function externalStart(fromTick) {
    if (!T) return;
    ensureAudio().catch(() => {});
    if (playing && !following) transport().stop();
    following = true;
    songPos = { index: -1, pass: 0 };
    masterTick = Math.round(fromTick / TICK_STEP) * TICK_STEP;
    patStart = 0;
    playing = true;
    updatePlayButton();
    renderMidi();
  }

  function onClockPulse(ms) {
    clockTimes.push(ms);
    if (clockTimes.length > 48) clockTimes.shift();
    if (clockTimes.length >= 8) {
      const span = (clockTimes[clockTimes.length - 1] - clockTimes[0]) / (clockTimes.length - 1);
      if (span > 5 && span < 80) {
        pulseSec = span / 1000;
        const bpm = Math.round((60 / (pulseSec * 24)) * 10) / 10;
        if (Math.abs(bpm - state.bpm) >= 0.1) {
          state.bpm = bpm;
          if (engine) applyGlobals();
          const now = performance.now();
          if (now - lastTempoUi > 250) { lastTempoUi = now; $('#bpm').value = bpm; renderMidiStatus(); }
        }
      }
    }
    if (!following || !playing) return;
    // Each pulse covers CLOCK_TICKS of our ticks; spread them across the pulse interval.
    const base = perfToAudio(ms) + midiLatency();
    const calls = CLOCK_TICKS / TICK_STEP;
    for (let k = 0; k < calls; k++) tick(base + (k * pulseSec) / calls);
  }

  async function enableMidi() {
    ensureAudio().catch(() => {}); // this click is the user gesture that lets audio (and the playhead clock) run
    if (!navigator.requestMIDIAccess) {
      flash(inArtifact() ? 'MIDI is not available on the claude.ai page. Open Polyphemus from GitHub Pages or a local server in Chrome or Edge.' : 'This browser has no Web MIDI. Use Chrome or Edge on a computer.', true);
      return;
    }
    try {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      flash(inArtifact() ? 'MIDI is blocked on the claude.ai page. Open Polyphemus from GitHub Pages or a local server.' : 'MIDI access was refused. Allow MIDI for this site in the browser settings.', true);
      return;
    }
    midiAccess.onstatechange = () => { bindPorts(); renderMidi(); };
    midi.enabled = true;
    save();
    bindPorts();
    renderMidi();
    flash('MIDI connected');
  }

  function bindPorts() {
    if (!midiAccess) return;
    const ins = [...midiAccess.inputs.values()];
    const outs = [...midiAccess.outputs.values()];
    const nextIn = ins.find((p) => p.name === midi.inName) || null;
    if (midiIn && midiIn !== nextIn) midiIn.onmidimessage = null;
    midiIn = nextIn;
    if (midiIn) midiIn.onmidimessage = onMidiMessage;
    midiOut = outs.find((p) => p.name === midi.outName) || null;
  }

  function renderMidiStatus() {
    const s = $('#midiStatus');
    if (!s) return;
    if (!midiAccess) { s.textContent = 'Not connected'; return; }
    const parts = [];
    if (midi.follow && midiIn) parts.push(following ? `Following clock at ${state.bpm} BPM` : (clockTimes.length ? `Clock at ${state.bpm} BPM; waiting for Start` : 'Waiting for clock'));
    if (midiOut) parts.push(midi.sendNotes ? `Sending notes to ${midiOut.name}` : `Connected to ${midiOut.name}`);
    s.textContent = parts.join(' · ') || 'Connected; choose ports';
  }

  function renderMidi() {
    const host = $('#midiBody');
    if (!host) return;
    const supported = !!navigator.requestMIDIAccess && !inArtifact();
    if (!midiAccess) {
      host.replaceChildren(
        el('button', { type: 'button', id: 'midiEnable', text: 'Connect MIDI', onclick: enableMidi }),
        el('p', { class: 'note', text: supported
          ? 'Your browser will ask for permission to use MIDI devices.'
          : inArtifact() ? 'MIDI works when Polyphemus is opened from GitHub Pages or a local server in Chrome or Edge; the claude.ai page blocks it.'
            : 'This browser has no Web MIDI (Safari, and every browser on iPhone and iPad). Use Chrome or Edge on a computer.' }));
      renderMidiStatus();
      return;
    }
    const ins = [...midiAccess.inputs.values()];
    const outs = [...midiAccess.outputs.values()];
    const portSel = (id, list, current, onchange) => el('select', { id, onchange },
      el('option', { value: '', text: 'None' }), ...list.map((p) => el('option', { value: p.name, text: p.name, selected: p.name === current })));
    const chSel = (t) => el('select', { id: `ch-${t.id}`, 'aria-label': `${t.label} MIDI channel`,
      onchange: (e) => { midi.channels[t.id] = +e.target.value; save(); } },
      ...Array.from({ length: 16 }, (_, i) => el('option', { value: i + 1, text: String(i + 1), selected: midi.channels[t.id] === i + 1 })));

    host.replaceChildren(
      el('div', { class: 'midi-grid' },
        el('div', { class: 'midi-col' },
          el('h3', { text: 'Clock in' }),
          el('div', { class: 'field' }, el('label', { for: 'midiIn', text: 'From' }),
            portSel('midiIn', ins, midi.inName, (e) => { midi.inName = e.target.value; clockTimes = []; bindPorts(); save(); renderMidi(); })),
          el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'midiFollow', checked: midi.follow,
            onchange: (e) => { midi.follow = e.target.checked; if (!midi.follow && following) { following = false; stopPlayback(); } save(); renderMidi(); } }),
          ' Follow tempo and start/stop'),
          el('div', { class: 'field' }, el('label', { for: 'midiOffset', text: 'Offset' }),
            el('input', { id: 'midiOffset', type: 'range', min: -60, max: 120, step: 1, value: midi.offset,
              oninput: (e) => { midi.offset = +e.target.value; $('#midiOffsetOut').textContent = `${midi.offset} ms`; save(); } }),
            el('output', { id: 'midiOffsetOut', for: 'midiOffset', text: `${midi.offset} ms` }))),
        el('div', { class: 'midi-col' },
          el('h3', { text: 'Out' }),
          el('div', { class: 'field' }, el('label', { for: 'midiOut', text: 'To' }),
            portSel('midiOut', outs, midi.outName, (e) => { midiPanic(); midi.outName = e.target.value; bindPorts(); save(); renderMidi(); })),
          el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'midiNotes', checked: midi.sendNotes,
            onchange: (e) => { midi.sendNotes = e.target.checked; if (!midi.sendNotes) midiPanic(); save(); renderMidiStatus(); } }), ' Send notes'),
          el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'midiClockOut', checked: midi.sendClock, disabled: midi.follow,
            onchange: (e) => { midi.sendClock = e.target.checked; save(); } }), ' Send clock (Polyphemus leads)'),
          el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'midiLocal', checked: midi.localAudio,
            onchange: (e) => { midi.localAudio = e.target.checked; save(); } }), ' Also play built-in sounds'),
          el('div', { class: 'midi-ch' }, el('span', { class: 'field-label', text: 'Channels' }),
            ...TRACKS().map((t) => el('span', { class: 'field', style: `--tc: ${trackColor(t)}` }, el('label', { for: `ch-${t.id}`, text: t.label }), chSel(t)))))));
    renderMidiStatus();
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
    // The header slider sets every track's swing at once; each track can then be adjusted on its own.
    $('#swing').addEventListener('input', (e) => {
      state.swing = +e.target.value;
      for (const t of state.tracks) state.mixer[t.id].swing = state.swing;
      $('#swingOut').textContent = `${state.swing}%`;
      save();
    });
    $('#swing').addEventListener('change', () => { renderMixer(); renderEditor(); });
    $('#humanize').addEventListener('input', (e) => { state.humanize = +e.target.value / 100; $('#humanizeOut').textContent = pct(state.humanize); save(); });
    $('#volume').addEventListener('input', (e) => { state.volume = +e.target.value; applyGlobals(); save(); });
    $('#volume').addEventListener('change', () => renderMixer());
    $('#viewSeq').addEventListener('click', () => setView('seq'));
    $('#viewMix').addEventListener('click', () => setView('mix'));
    $('#echoTime').addEventListener('change', (e) => { state.echoTime = e.target.value; applyGlobals(); save(); renderMixer(); });
    $('#echoFb').addEventListener('change', () => renderMixer());
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

  // Header "Swing" shows the shared value, or "mixed" once tracks differ.
  function syncSwingAll() {
    const vals = state.tracks.map((t) => state.mixer[t.id].swing);
    const same = vals.every((v) => Math.abs(v - vals[0]) < 0.005);
    const avg = vals.reduce((a, v) => a + v, 0) / (vals.length || 1);
    $('#swing').value = Math.round(same ? vals[0] : avg);
    $('#swingOut').textContent = same ? `${vals[0]}%` : 'mixed';
    $('#swing').title = same ? 'Swing for every track' : 'Tracks have different swing; moving this sets them all to the same amount';
  }

  function syncHeader() {
    $('#bpm').value = state.bpm;
    syncSwingAll();
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
    $('#playLabel').textContent = !T ? 'Loading sounds…' : following ? 'Following Live' : playing ? 'Stop' : 'Play';
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
    if (playing && songActive()) { flash('The arrangement is choosing patterns. Switch to Loop pattern to pick one by hand.'); return; }
    if (playing) {
      queuedSlot = i === state.current ? null : i;
      renderSlots();
      return;
    }
    state.current = i;
    save();
    renderAll();
  }

  // ================================================================ mixer view
  // Rotary control: drag up/down (shift for fine), arrow keys, double-click to reset.
  function knob({ id, label, min, max, step = 0.01, value, def = 0, bipolar = false, format, onInput, title }) {
    const R = 15;
    const C = 18;
    const a0 = -135;
    const a1 = 135;
    const polar = (deg) => { const r = (deg - 90) * Math.PI / 180; return [C + R * Math.cos(r), C + R * Math.sin(r)]; };
    const arc = (from, to) => {
      if (Math.abs(to - from) < 0.5) return '';
      const [x0, y0] = polar(Math.min(from, to));
      const [x1, y1] = polar(Math.max(from, to));
      const large = Math.abs(to - from) > 180 ? 1 : 0;
      return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    };
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS(svgNS, 'path');
    track.setAttribute('d', arc(a0, a1));
    track.setAttribute('class', 'k-track');
    const fill = document.createElementNS(svgNS, 'path');
    fill.setAttribute('class', 'k-fill');
    const dot = document.createElementNS(svgNS, 'line');
    dot.setAttribute('class', 'k-dot');
    svg.append(track, fill, dot);
    const out = el('span', { class: 'k-val' });
    const node = el('div', { class: 'knob', id, role: 'slider', tabindex: 0, title: title || label,
      'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max }, svg, el('span', { class: 'k-label', text: label }), out);
    let v = value;
    const draw = () => {
      const frac = (v - min) / (max - min);
      const ang = a0 + frac * (a1 - a0);
      const zero = bipolar ? a0 + ((0 - min) / (max - min)) * (a1 - a0) : a0;
      fill.setAttribute('d', arc(zero, ang));
      const [x, y] = polar(ang);
      const [ix, iy] = [C + (x - C) * 0.45, C + (y - C) * 0.45];
      dot.setAttribute('x1', ix.toFixed(2)); dot.setAttribute('y1', iy.toFixed(2));
      dot.setAttribute('x2', x.toFixed(2)); dot.setAttribute('y2', y.toFixed(2));
      const txt = format(v);
      out.textContent = txt;
      node.setAttribute('aria-valuenow', String(+v.toFixed(3)));
      node.setAttribute('aria-valuetext', `${label} ${txt}`);
    };
    const set = (nv) => {
      const q = Math.round(Math.min(max, Math.max(min, nv)) / step) * step;
      if (q === v) return;
      v = +q.toFixed(4);
      draw();
      onInput(v);
    };
    let drag = null;
    node.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      node.focus();
      drag = { y: e.clientY, v };
      try { node.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    node.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const range = (max - min) * (e.shiftKey ? 0.2 : 1);
      set(drag.v + ((drag.y - e.clientY) / 160) * range);
    });
    const end = () => { if (drag) { drag = null; save(); } };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
    node.addEventListener('dblclick', () => { set(def); save(); });
    node.addEventListener('keydown', (e) => {
      const big = (max - min) / 10;
      const map = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: big, PageDown: -big };
      if (e.key in map) { e.preventDefault(); set(v + map[e.key] * (e.shiftKey ? 1 : Math.max(1, Math.round(((max - min) / 100) / step)))); save(); }
      else if (e.key === 'Home') { e.preventDefault(); set(min); save(); }
      else if (e.key === 'End') { e.preventDefault(); set(max); save(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); set(def); save(); }
    });
    draw();
    return node;
  }

  const fmtDb = (v) => (v <= -60 ? '−∞' : `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)}`);
  const fmtPct = (v) => `${Math.round(v * 100)}`;
  const fmtPan = (v) => (Math.abs(v) < 0.01 ? 'C' : `${Math.round(Math.abs(v) * 50)}${v < 0 ? 'L' : 'R'}`);
  const fmtFilter = (v) => {
    if (Math.abs(v) < 0.01) return 'open';
    const f = filterFreqs(v);
    const hz = v < 0 ? f.lp : f.hp;
    return `${v < 0 ? 'LP' : 'HP'} ${hz >= 1000 ? (hz / 1000).toFixed(1) + 'k' : Math.round(hz)}`;
  };

  function fader({ id, label, value, onInput }) {
    const out = el('output', { for: id, class: 'f-val', text: fmtDb(value) });
    const input = el('input', { id, type: 'range', class: 'fader', min: -60, max: 6, step: 0.5, value, 'aria-label': label,
      oninput: (e) => { const v = +e.target.value; out.textContent = fmtDb(v); onInput(v); },
      onchange: () => save(),
      ondblclick: (e) => { e.target.value = 0; out.textContent = fmtDb(0); onInput(0); save(); } });
    return { input, out };
  }

  function stripShell({ key, name, sub, color, cls = '', body, faderEl, meterKey, buttons }) {
    return el('section', { class: `strip ${cls}`, 'data-strip': key, style: color ? `--tc: ${color}` : null, 'aria-label': `${name} channel` },
      el('header', { class: 'strip-head' }, el('span', { class: 'strip-name', text: name }), sub ? el('span', { class: 'strip-sub', text: sub }) : null),
      el('div', { class: 'strip-body' }, ...body),
      el('div', { class: 'strip-level' },
        el('div', { class: 'meter', 'data-meter': meterKey, 'aria-hidden': 'true' }, el('i'), el('b')),
        faderEl.input),
      faderEl.out,
      buttons ? el('div', { class: 'strip-btns' }, ...buttons) : null);
  }

  function renderMixer() {
    const host = $('#mixer');
    if (!host || state.view !== 'mix') return;
    const anySolo = state.tracks.some((t) => state.mixer[t.id].solo);
    const change = (t, k) => (v) => { state.mixer[t.id][k] = v; if (engine) applyStrip(t, state.tracks.some((x) => state.mixer[x.id].solo)); save(); };
    const strips = TRACKS().map((t) => {
      const m = state.mixer[t.id];
      const knobs = [
        el('div', { class: 'k-group', role: 'group', 'aria-label': 'EQ' },
          knob({ id: `eqh-${t.id}`, label: 'High', min: -24, max: 12, step: 0.5, value: m.eqHigh, bipolar: true, format: fmtDb, onInput: change(t, 'eqHigh') }),
          knob({ id: `eqm-${t.id}`, label: 'Mid', min: -24, max: 12, step: 0.5, value: m.eqMid, bipolar: true, format: fmtDb, onInput: change(t, 'eqMid') }),
          knob({ id: `eql-${t.id}`, label: 'Low', min: -24, max: 12, step: 0.5, value: m.eqLow, bipolar: true, format: fmtDb, onInput: change(t, 'eqLow') })),
        knob({ id: `flt-${t.id}`, label: 'Filter', min: -1, max: 1, step: 0.01, value: m.filter, bipolar: true, format: fmtFilter,
          title: 'Turn left to close a low-pass, right to raise a high-pass', onInput: change(t, 'filter') }),
        el('div', { class: 'k-group', role: 'group', 'aria-label': 'Sends' },
          t.kind === 'melodic'
            ? knob({ id: `echo-${t.id}`, label: 'Echo', min: 0, max: 1, step: 0.01, value: m.echo, format: fmtPct, onInput: change(t, 'echo') })
            : el('div', { class: 'knob-note', text: 'Echo is set per voice in the sequencer' }),
          knob({ id: `space-${t.id}`, label: 'Space', min: 0, max: 1, step: 0.01, value: m.space, format: fmtPct, onInput: change(t, 'space') })),
        el('div', { class: 'k-group', role: 'group', 'aria-label': 'Groove and position' },
          knob({ id: `swing-${t.id}`, label: 'Swing', min: 50, max: 75, step: 1, value: m.swing, def: 50,
            format: (v) => `${v}%${m.swingGrid === '8' ? ' ⅛' : ''}`,
            title: `MPC-style swing on ${m.swingGrid === '8' ? '8th' : '16th'} notes: 50% straight, 66% triplet shuffle, 75% maximum`,
            onInput: (v) => { m.swing = v; syncSwingAll(); save(); } }),
          knob({ id: `pan-${t.id}`, label: 'Pan', min: -1, max: 1, step: 0.02, value: m.pan, bipolar: true, format: fmtPan, onInput: change(t, 'pan') })),
      ];
      const muted = anySolo ? !m.solo : m.mute;
      return stripShell({
        key: t.id, name: t.label, sub: t.kind === 'melodic' ? (t.presets.find((x) => x[0] === m.preset) || [0, t.typeLabel])[1] : '8 voices',
        color: trackColor(t), cls: muted ? 'muted' : '', body: knobs, meterKey: t.id,
        faderEl: fader({ id: `fader-${t.id}`, label: `${t.label} level`, value: m.vol, onInput: change(t, 'vol') }),
        buttons: [
          el('button', { type: 'button', class: 'mute', 'aria-pressed': String(m.mute), text: 'M', title: `Mute ${t.label}`,
            onclick: () => { m.mute = !m.mute; applyMixer(); save(); renderMixer(); renderTracks(); } }),
          el('button', { type: 'button', class: 'solo', 'aria-pressed': String(m.solo), text: 'S', title: `Solo ${t.label}`,
            onclick: () => { m.solo = !m.solo; applyMixer(); save(); renderMixer(); renderTracks(); } }),
        ],
      });
    });

    const echoTime = el('select', { id: 'mixEchoTime', 'aria-label': 'Echo time',
      onchange: (e) => { state.echoTime = e.target.value; applyGlobals(); syncHeader(); save(); } },
      ...options(ECHO_TIMES.map((x) => [x.id, x.label]), state.echoTime));
    const echoStrip = stripShell({
      key: 'echo', name: 'Echo', sub: 'return', cls: 'ret', meterKey: 'echo',
      body: [el('label', { class: 'k-label sel-label', for: 'mixEchoTime', text: 'Time' }), echoTime,
        knob({ id: 'mixEchoFb', label: 'Feedback', min: 0, max: 0.85, step: 0.01, value: state.echoFeedback, def: 0.55, format: fmtPct,
          onInput: (v) => { state.echoFeedback = v; applyGlobals(); syncHeader(); } })],
      faderEl: fader({ id: 'fader-echo', label: 'Echo return level', value: gainToDb(state.echoReturn),
        onInput: (v) => { state.echoReturn = dbToGain(v); applyGlobals(); } }),
    });
    const spaceStrip = stripShell({
      key: 'space', name: 'Space', sub: 'return', cls: 'ret', meterKey: 'space',
      body: [knob({ id: 'mixSpaceSize', label: 'Size', min: 1, max: 14, step: 0.5, value: state.spaceSize, def: 7, format: (v) => `${v}s`,
        onInput: (v) => { state.spaceSize = v; if (engine) { clearTimeout(spaceTimer); spaceTimer = setTimeout(() => safe(() => { engine.space.decay = state.spaceSize; }), 250); } } })],
      faderEl: fader({ id: 'fader-space', label: 'Space return level', value: gainToDb(state.spaceReturn),
        onInput: (v) => { state.spaceReturn = dbToGain(v); applyGlobals(); } }),
    });
    const masterStrip = stripShell({
      key: 'master', name: 'Master', cls: 'master', meterKey: 'master', body: [],
      faderEl: fader({ id: 'fader-master', label: 'Master level', value: state.volume,
        onInput: (v) => { state.volume = v; applyGlobals(); syncHeader(); } }),
    });

    host.replaceChildren(
      el('div', { class: 'mixer-scroll' }, el('div', { class: 'mixer-row' }, ...strips, el('div', { class: 'mixer-gap' }), echoStrip, spaceStrip, masterStrip)),
      el('p', { class: 'hint', text: 'Drag a knob up or down (hold Shift for fine moves); double-click a knob or fader to reset it. The filter closes a low-pass to the left and raises a high-pass to the right.' }));
    startMeters();
  }
  let spaceTimer = 0;
  const gainToDb = (g) => (g <= 0.001 ? -60 : Math.max(-60, 20 * Math.log10(g)));
  const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

  let meterRaf = 0;
  function startMeters() {
    if (meterRaf) return;
    const tickMeters = () => {
      meterRaf = 0;
      if (state.view !== 'mix') return;
      if (engine) {
        const read = (node) => { const v = node.getValue(); return Array.isArray(v) ? Math.max(...v) : v; };
        const pairs = state.tracks.map((t) => [t.id, engine.strips[t.id] && engine.strips[t.id].meter]);
        pairs.push(['echo', engine.echoMeter], ['space', engine.spaceMeter], ['master', engine.masterMeter]);
        for (const [key, node] of pairs) {
          if (!node) continue;
          const db = read(node);
          const box = document.querySelector(`[data-meter="${key}"]`);
          if (!box) continue;
          const frac = Number.isFinite(db) ? Math.min(1, Math.max(0, (db + 60) / 66)) : 0;
          box.firstChild.style.height = `${(frac * 100).toFixed(1)}%`;
          box.classList.toggle('hot', db > -3);
        }
      }
      meterRaf = requestAnimationFrame(tickMeters);
    };
    meterRaf = requestAnimationFrame(tickMeters);
  }

  function setView(v) {
    state.view = v === 'mix' ? 'mix' : 'seq';
    const mix = state.view === 'mix';
    $('#deck').hidden = mix;
    $('#mixer').hidden = !mix;
    $('#viewSeq').setAttribute('aria-pressed', String(!mix));
    $('#viewMix').setAttribute('aria-pressed', String(mix));
    save();
    if (mix) renderMixer();
    else renderEditor();
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

  let removeArmed = null;   // track id whose remove button is waiting for a second click
  let removeTimer = 0;
  let adding = false;       // add-synth type picker open

  function renderTracks() {
    const list = TRACKS();
    const synthCount = list.length - 1;
    const strips = list.map((t, i) => {
      const m = state.mixer[t.id];
      const sel = state.track === t.id;
      const armed = removeArmed === t.id;
      return el('div', { class: 'track', 'data-id': t.id, 'data-selected': String(sel), style: `--tc: ${trackColor(t)}` },
        el('button', { type: 'button', class: 'track-name', 'aria-pressed': String(sel), onclick: () => selectTrack(t.id) },
          el('strong', { text: t.label }), el('span', { class: 'key', text: String(i + 1) }), el('span', { class: 'sub', text: trackSubtitle(t) })),
        el('div', { class: 'track-btns' },
          el('button', { type: 'button', class: 'mute', 'aria-pressed': String(m.mute), title: `Mute ${t.label}`, text: 'M',
            onclick: () => { m.mute = !m.mute; applyMixer(); save(); renderTracks(); renderMixer(); } }),
          el('button', { type: 'button', class: 'solo', 'aria-pressed': String(m.solo), title: `Solo ${t.label}`, text: 'S',
            onclick: () => { m.solo = !m.solo; applyMixer(); save(); renderTracks(); renderMixer(); } }),
          t.kind === 'melodic' ? el('button', { type: 'button', class: 'remove' + (armed ? ' armed' : ''),
            title: armed ? `Click again to remove ${t.label} from every pattern` : `Remove ${t.label}`,
            'aria-label': armed ? `Confirm removing ${t.label}` : `Remove ${t.label}`,
            text: armed ? 'Remove?' : '×', onclick: () => armRemove(t.id) }) : null),
        el('div', { class: 'lane', 'data-lane': t.id, 'aria-hidden': 'true', onclick: () => selectTrack(t.id) }));
    });

    const full = synthCount >= MAX_SYNTHS;
    const adder = adding && !full
      ? el('div', { class: 'add-track open' },
        el('span', { class: 'field-label', text: 'New synth' }),
        el('div', { class: 'add-types' }, ...Object.entries(SYNTH_TYPES).map(([id, ty]) =>
          el('button', { type: 'button', text: ty.label, onclick: () => addTrack(id) }))),
        el('button', { type: 'button', class: 'add-cancel', text: 'Cancel', onclick: () => { adding = false; renderTracks(); } }))
      : el('button', { type: 'button', class: 'add-track', disabled: full,
        text: full ? `${MAX_SYNTHS} synths is the limit` : `+ Add synth (${synthCount} of ${MAX_SYNTHS})`,
        onclick: () => { adding = true; renderTracks(); } });

    $('#tracks').replaceChildren(...strips, adder);
    renderLanes();
  }

  function uniqueName(base) {
    const names = new Set(state.tracks.map((t) => t.name));
    if (!names.has(base)) return base;
    for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  function addTrack(type) {
    if (state.tracks.length - 1 >= MAX_SYNTHS) return;
    let n = 1;
    while (state.tracks.some((t) => t.id === `s${n}`)) n++;
    const usedColors = new Set(state.tracks.map((t) => t.color));
    const color = TRACK_COLORS.findIndex((_, i) => !usedColors.has(i));
    const tr = { id: `s${n}`, kind: 'synth', type, name: uniqueName(SYNTH_TYPES[type].label), color: color < 0 ? n % TRACK_COLORS.length : color };
    state.tracks.push(tr);
    state.mixer[tr.id] = mixerDefaults(tr);
    state.midi.channels[tr.id] = nextFreeChannel(state.midi.channels);
    for (const p of state.patterns) p.tracks[tr.id] = emptySynthPart();
    if (engine) { buildSynthTrack(tr); applyMixer(); }
    adding = false;
    state.track = tr.id;
    save();
    renderAll();
    renderMidi();
    flash(`Added ${tr.name} on MIDI channel ${state.midi.channels[tr.id]}`);
  }

  function armRemove(id) {
    if (removeArmed !== id) {
      removeArmed = id;
      clearTimeout(removeTimer);
      removeTimer = setTimeout(() => { removeArmed = null; renderTracks(); }, 3500);
      renderTracks();
      return;
    }
    clearTimeout(removeTimer);
    removeArmed = null;
    const tr = state.tracks.find((t) => t.id === id);
    if (!tr || tr.kind === 'drums') return;
    if (midiOut) { try { midiOut.send([0xb0 | channelOf(id), 123, 0]); } catch (e) { /* ignore */ } }
    disposeStrip(id);
    state.tracks = state.tracks.filter((t) => t.id !== id);
    delete state.mixer[id];
    delete state.midi.channels[id];
    for (const p of state.patterns) delete p.tracks[id];
    delete nowStep[id];
    if (state.track === id) state.track = 'drums';
    applyMixer();
    save();
    renderAll();
    renderMidi();
    flash(`Removed ${tr.name}`);
  }

  // Overview strip: for drums one thin row per voice, for melodic one row of note starts.
  function renderLanes() {
    const p = pat();
    const rc = rowCount();
    for (const t of TRACKS()) {
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

  // Swing percentage (MPC-style) plus the grid it applies to.
  function swingControl(m) {
    return el('div', { class: 'swing-ctl' },
      slider({ id: 'trackSwing', label: 'Swing', min: 50, max: 75, step: 1, value: m.swing,
        format: (v) => `${v}%`, onInput: (v) => { m.swing = v; syncSwingAll(); save(); } }),
      el('select', { id: 'swingGrid', 'aria-label': 'Swing grid', title: 'Swing the second 16th of each pair, or the second 8th',
        onchange: (e) => { m.swingGrid = e.target.value; save(); } },
        ...options([['16', 'on 1/16'], ['8', 'on 1/8']], m.swingGrid || '16')));
  }

  function renderEditor() {
    const t = TRACK_BY_ID(state.track);
    const p = pat();
    const m = state.mixer[t.id];
    $('#editor').style.setProperty('--tc', trackColor(t));
    const L = currentLane();

    const nameInput = el('input', { class: 'name-input', id: 'trackName', value: t.label, maxlength: 24, 'aria-label': 'Track name',
      size: Math.max(4, t.label.length),
      oninput: (e) => { e.target.size = Math.max(4, e.target.value.length); },
      onchange: (e) => { const v = e.target.value.trim().slice(0, 24); const rec = state.tracks.find((x) => x.id === t.id); if (v && rec) { rec.name = v; save(); renderTracks(); renderMixer(); renderExport(); renderMidi(); } else e.target.value = t.label; },
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
    const title = el('h2', { class: 'editor-title' }, nameInput,
      el('small', { text: `${t.kind === 'melodic' ? t.typeLabel + ' · ' : ''}Pattern ${SLOT_NAMES[state.current]}${t.kind === 'melodic' ? ` · ${NOTE_NAMES[state.root]} ${SCALES[state.scale].label.toLowerCase()}` : ''}` }));

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
        swingControl(m),
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
        swingControl(m),
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
    const t = TRACK_BY_ID(state.track);
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
    const t = TRACK_BY_ID(state.track);
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
    const who = state.track === 'drums' ? VOICE_BY_ID[state.voice].label : TRACK_BY_ID(state.track).label;
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
    $('#deck').hidden = state.view === 'mix';
    $('#mixer').hidden = state.view !== 'mix';
    $('#viewSeq').setAttribute('aria-pressed', String(state.view !== 'mix'));
    $('#viewMix').setAttribute('aria-pressed', String(state.view === 'mix'));
    renderMixer();
    renderArrangement();
    if (songsOpen) renderSongs(); else updateSongBar();
    renderExport();
  }

  function commit() {
    renderEditorLite();
    renderLanes();
    renderSlots();
    for (const t of TRACKS()) {
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
    const t = TRACK_BY_ID(state.track);
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
      const t = TRACK_BY_ID(state.track);
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
      return { cycle: L.length * tps, events, mix: state.mixer.drums };
    }
    const tr = p.tracks[trackId];
    const t = TRACK_BY_ID(trackId);
    const tps = rateTicks(tr.rate);
    const rc = rowCount();
    const events = tr.notes.filter((n) => n.s < tr.length && n.r < rc).map((n) => ({
      tick: n.s * tps, dur: Math.max(10, Math.round(n.l * tps * t.gate)), note: midiFor(trackId, n.r), vel: n.v, prob: n.p,
    }));
    return { cycle: tr.length * tps, events, mix: state.mixer[trackId] };
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
          if (state.exportSwing && l.mix) tick = Math.min(length - 1, tick + Math.round(swingTicks(tick, l.mix.swing, l.mix.swingGrid)));
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
    const tracks = which === 'all' ? TRACKS() : [TRACK_BY_ID(which)];
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
              bytes: writeMidi({ name, channel: channelOf('drums'), ...clip }), capped: clip.capped, label: v.label });
          }
        } else {
          const clip = renderClip(voices.map((v) => laneEvents(p, 'drums', v.id)), fixed);
          clips.push({ filename: `polyphemus-${slot}-drums-${lengthLabel(clip.length)}.mid`,
            bytes: writeMidi({ name: `Polyphemus ${slot} ${t.label}`, channel: channelOf('drums'), ...clip }), capped: clip.capped, label: 'Drums' });
        }
      } else {
        if (!p.tracks[t.id].notes.length) continue;
        const clip = renderClip([laneEvents(p, t.id)], fixed);
        clips.push({ filename: `polyphemus-${slot}-${slug(t.label) || t.id}-${lengthLabel(clip.length)}.mid`,
          bytes: writeMidi({ name: `Polyphemus ${slot} ${t.label}`, channel: channelOf(t.id), ...clip }), capped: clip.capped, label: t.label });
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
    const rows = TRACKS().map((t) => {
      const cyc = cycleTicksOfTrack(p, t.id);
      const full = cyc ? lcm(cyc, BAR) : 0;
      const clipLen = fixed || (full > 64 * BAR ? 64 * BAR : full);
      const empty = !cyc || (t.kind === 'melodic' && !p.tracks[t.id].notes.length);
      return el('div', { class: 'xrow', style: `--tc: ${trackColor(t)}` },
        el('span', { class: 'xname', text: t.label }),
        el('span', { class: 'xinfo', text: empty ? 'empty' : `cycle ${describeTicks(cyc)} → clip ${describeTicks(clipLen)}` }),
        el('button', { type: 'button', disabled: empty, text: inArtifact() ? 'Download .zip' : 'Download .mid',
          onclick: () => exportClips(t.id) }));
    });
    const bars = songBars();
    rows.push(el('div', { class: 'xrow song', style: '--tc: var(--lamp)' },
      el('span', { class: 'xname', text: 'Whole arrangement' }),
      el('span', { class: 'xinfo', text: bars ? `${bars} bars, one file per track` : 'no sections' }),
      el('button', { type: 'button', disabled: !bars, text: 'Download .zip', onclick: exportSong })));
    host.replaceChildren(...rows);
  }

  function initExport() {
    $('#exportLength').append(...options([['cycle', 'Full cycle (loops seamlessly)'], ...['1', '2', '4', '8', '16', '32'].map((b) => [b, `${b} bar${b === '1' ? '' : 's'}`])], state.exportLength));
    $('#drumMap').append(...options([['gm', 'General MIDI'], ['pads', 'Drum Rack pads C1–G1']], state.drumMap));
    $('#splitDrums').checked = state.splitDrums;
    $('#bakeChance').checked = state.bakeChance;
    $('#exportSwing').checked = state.exportSwing;
    $('#exportSwing').addEventListener('change', (e) => { state.exportSwing = e.target.checked; save(); });
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
    const bin = atob(code.trim().replace(/^PLY[34]:/, ''));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  }
  // A code carries the whole session: tracks, mixer, all four patterns, arrangement and settings.
  // MIDI port settings and the current view belong to this browser, not to the song.
  function snapshot() {
    const { midi: _m, view: _v, ...session } = state;
    return JSON.parse(JSON.stringify(session));
  }

  // Replace the live session with `next` (already validated by sessionFrom).
  function applySession(next) {
    if (playing) stopPlayback();
    if (engine) for (const t of state.tracks) if (t.kind === 'synth') disposeStrip(t.id);
    const keepMidi = midi;
    const keepView = state.view;
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, next);
    Object.assign(keepMidi, state.midi);
    state.midi = keepMidi;
    state.view = keepView;
    normalizeMidi(keepMidi, keepMidi, state.tracks);
    if (engine) { for (const t of state.tracks) if (t.kind === 'synth') buildSynthTrack(t); applyGlobals(); applyMixer(); }
    save();
    renderAll();
    renderMidi();
  }
  const sessionFromData = (data) => (data ? sessionFrom({ ...data, midi: state.midi, view: state.view }) : null);

  async function copyCode() {
    const code = encode(snapshot());
    const box = $('#code');
    box.value = code;
    try { await navigator.clipboard.writeText(code); flash('Session code copied'); } catch (e) { box.focus(); box.select(); flash('Code selected; copy it with ⌘C or Ctrl+C'); }
  }
  function loadCode() {
    const raw = $('#code').value;
    if (!raw.trim()) { flash('Paste a session code into the box first', true); return; }
    let data;
    try { data = decode(raw); } catch (e) { flash('That code could not be read. Check that it was copied in full.', true); return; }
    const next = sessionFromData(data);
    if (!next) { flash('That is not a Polyphemus session code from this version.', true); return; }
    next.songId = null; // a pasted code is a new song until it is saved
    applySession(next);
    savedJson = null;
    updateSongBar();
    flash('Session loaded');
  }

  // ================================================================ song library (localStorage)
  const LIB_KEY = 'polyphemus.v2.songs';
  const FILE_APP = 'polyphemus';
  let libCache = null;
  let savedJson = null;        // the song as last saved or opened, for the "unsaved changes" marker
  let songsOpen = false;
  let armed = null;            // { action, id } waiting for a confirming second click
  let armTimer = 0;

  function readLib() {
    if (libCache) return libCache;
    let lib = { songs: {} };
    try {
      const raw = localStorage.getItem(LIB_KEY);
      if (raw) { const parsed = JSON.parse(raw); if (parsed && parsed.songs && typeof parsed.songs === 'object') lib = parsed; }
    } catch (e) { /* unreadable: start empty */ }
    libCache = lib;
    return lib;
  }
  function writeLib(lib) {
    try {
      localStorage.setItem(LIB_KEY, JSON.stringify(lib));
      libCache = lib;
      return true;
    } catch (e) {
      libCache = null;
      const full = e && (e.name === 'QuotaExceededError' || e.code === 22);
      flash(full ? 'Browser storage is full. Delete or download some songs, then save again.' : 'This browser is not letting Polyphemus store songs (private window or blocked site data).', true);
      return false;
    }
  }
  const newSongId = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 16);
  // What counts as a change to the song: everything except its name/id and where you're looking.
  const songJson = (snap) => {
    const { songId: _i, songName: _n, current: _c, track: _t, voice: _v, laneMode: _l, playMode: _p, ...rest } = snap;
    return JSON.stringify(rest);
  };
  const isDirty = () => (savedJson === null ? true : songJson(snapshot()) !== savedJson);
  function markClean() { savedJson = songJson(snapshot()); updateSongBar(); }

  function uniqueSongName(base) {
    const names = new Set(Object.values(readLib().songs).map((x) => x.name));
    if (!names.has(base)) return base;
    for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  function saveSong(asNew) {
    const lib = readLib();
    let name = (state.songName || '').trim() || 'Untitled song';
    const existing = state.songId && lib.songs[state.songId];
    const id = asNew || !existing ? newSongId() : state.songId;
    if (asNew && existing && existing.name === name) name = uniqueSongName(`${name} copy`);
    state.songId = id;
    state.songName = name;
    const entry = { id, name, updated: Date.now(), session: snapshot() };
    if (!writeLib({ songs: { ...lib.songs, [id]: entry } })) return;
    flushSave();
    markClean();
    renderSongs();
    flash(`Saved “${name}”`);
  }

  function openSong(id) {
    const entry = readLib().songs[id];
    if (!entry) return;
    const next = sessionFromData(entry.session);
    if (!next) { flash('That song could not be read.', true); return; }
    next.songId = id;
    next.songName = entry.name;
    applySession(next);
    markClean();
    renderSongs();
    flash(`Opened “${entry.name}”`);
  }

  function newSong() {
    const next = defaultState();
    next.patterns = [0, 1, 2, 3].map(() => emptyPattern(DEFAULT_TRACKS));
    next.arrangement = [{ slot: 0, bars: 8 }];
    next.songName = uniqueSongName('Untitled song');
    next.songId = null;
    next.bpm = state.bpm;
    next.root = state.root;
    next.scale = state.scale;
    applySession(next);
    savedJson = null;
    updateSongBar();
    renderSongs();
    flash('New song started');
  }

  function duplicateSong(id) {
    const lib = readLib();
    const src = lib.songs[id];
    if (!src) return;
    const nid = newSongId();
    const name = uniqueSongName(`${src.name} copy`);
    const copy = { id: nid, name, updated: Date.now(), session: { ...JSON.parse(JSON.stringify(src.session)), songId: nid, songName: name } };
    if (writeLib({ songs: { ...lib.songs, [nid]: copy } })) { renderSongs(); flash(`Duplicated as “${name}”`); }
  }

  function deleteSong(id) {
    const lib = readLib();
    const src = lib.songs[id];
    if (!src) return;
    const songs = { ...lib.songs };
    delete songs[id];
    if (!writeLib({ songs })) return;
    if (state.songId === id) { state.songId = null; savedJson = null; save(); }
    renderSongs();
    flash(`Deleted “${src.name}”`);
  }

  // Two-click confirmation for actions that lose work (the artifact viewer has no confirm()).
  function confirmThen(action, id, fn) {
    if (armed && armed.action === action && armed.id === id) {
      clearTimeout(armTimer);
      armed = null;
      fn();
      return;
    }
    armed = { action, id };
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { armed = null; renderSongs(); }, 4000);
    renderSongs();
  }
  const isArmed = (action, id) => !!(armed && armed.action === action && armed.id === id);

  // ---- files: one song, or a backup of the whole library, as JSON
  const download = (filename, text) => offerFile(filename, new Blob([text], { type: 'application/json' }));
  function downloadSong() {
    const file = { app: FILE_APP, format: 1, kind: 'song', name: state.songName, saved: new Date().toISOString(), session: snapshot() };
    download(`${slug(state.songName) || 'song'}.polyphemus.json`, JSON.stringify(file, null, 1));
  }
  function downloadLibrary() {
    const songs = Object.values(readLib().songs);
    if (!songs.length) { flash('The library is empty. Save a song first.', true); return; }
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    download(`polyphemus-library-${stamp}.json`, JSON.stringify({ app: FILE_APP, format: 1, kind: 'library', saved: d.toISOString(), songs }));
  }

  async function openFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { flash('That file is not a Polyphemus song (it is not valid JSON).', true); return; }
    if (!data || data.app !== FILE_APP) { flash('That file is not a Polyphemus song or library backup.', true); return; }
    if (data.kind === 'library' && Array.isArray(data.songs)) {
      const songs = { ...readLib().songs };
      let added = 0;
      for (const src of data.songs) {
        if (!src || !src.session || !sessionFromData(src.session)) continue;
        const clash = src.id && songs[src.id];
        if (clash && JSON.stringify(clash.session) === JSON.stringify(src.session)) continue;
        const id = clash || !src.id || !/^[a-z0-9]{4,24}$/.test(src.id) ? newSongId() : src.id;
        const name = clash ? uniqueSongName(`${src.name || 'Song'} (restored)`) : String(src.name || 'Untitled song').slice(0, 60);
        songs[id] = { id, name, updated: Number(src.updated) || Date.now(), session: { ...src.session, songId: id, songName: name } };
        added++;
      }
      if (writeLib({ songs })) { renderSongs(); flash(added ? `Restored ${added} song${added === 1 ? '' : 's'} into the library` : 'Every song in that backup is already in the library'); }
      return;
    }
    if (data.kind === 'song' && data.session) {
      const next = sessionFromData(data.session);
      if (!next) { flash('That song file could not be read.', true); return; }
      next.songId = null;
      next.songName = String(data.name || next.songName).slice(0, 60);
      applySession(next);
      savedJson = null;
      updateSongBar();
      renderSongs();
      flash(`Opened “${next.songName}” from file. Save it to add it to the library.`);
      return;
    }
    flash('That file is not a Polyphemus song or library backup.', true);
  }

  // ---- song bar (header) and songs panel
  function updateSongBar() {
    const name = $('#songName');
    if (name && document.activeElement !== name) name.value = state.songName;
    const dot = $('#songDirty');
    if (dot) {
      const dirty = isDirty();
      dot.hidden = !dirty;
      dot.textContent = state.songId ? 'unsaved changes' : 'not in library';
    }
    const b = $('#songsToggle');
    if (b) b.setAttribute('aria-expanded', String(songsOpen));
  }

  const fmtDate = (ms) => {
    const d = new Date(ms);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  };

  function renderSongs() {
    updateSongBar();
    const host = $('#songs');
    if (!host) return;
    host.hidden = !songsOpen;
    if (!songsOpen) return;
    const dirty = isDirty();
    const songs = Object.values(readLib().songs).sort((a, b) => b.updated - a.updated);
    const fileInput = el('input', { type: 'file', accept: '.json,application/json', id: 'songFile', hidden: true,
      onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) openFile(f); e.target.value = ''; } });
    const actions = el('div', { class: 'songs-actions' },
      el('button', { type: 'button', class: 'primary', text: state.songId ? 'Save' : 'Save to library', title: 'Save this song (⌘S or Ctrl+S)', onclick: () => saveSong(false) }),
      state.songId ? el('button', { type: 'button', text: 'Save as new song', onclick: () => saveSong(true) }) : null,
      el('button', { type: 'button', class: isArmed('new', '') ? 'danger' : '', text: isArmed('new', '') ? 'Discard changes and start new?' : 'New song',
        onclick: () => (dirty ? confirmThen('new', '', newSong) : newSong()) }),
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', text: 'Download song file', onclick: downloadSong }),
      el('button', { type: 'button', text: 'Open song file…', onclick: () => fileInput.click() }),
      el('button', { type: 'button', text: 'Back up library', disabled: !songs.length, onclick: downloadLibrary }),
      fileInput);

    const rows = songs.length ? songs.map((x) => {
      const cur = x.id === state.songId;
      const arr = Array.isArray(x.session.arrangement) ? x.session.arrangement : [];
      const bars = arr.reduce((a, y) => a + (+y.bars || 0), 0);
      const tracks = Array.isArray(x.session.tracks) ? x.session.tracks.length : 4;
      const openArmed = isArmed('open', x.id);
      return el('li', { class: 'song-row' + (cur ? ' current' : '') },
        el('div', { class: 'song-meta' },
          el('span', { class: 'song-title', text: x.name }),
          el('span', { class: 'song-info', text: `${fmtDate(x.updated)} · ${Math.round(x.session.bpm || 120)} BPM · ${tracks} tracks${bars ? ` · ${bars} bars arranged` : ''}` })),
        el('div', { class: 'song-btns' },
          (cur && !dirty) ? el('span', { class: 'song-open', text: 'Open now' })
            : el('button', { type: 'button', class: openArmed ? 'danger' : '',
              text: openArmed ? (cur ? 'Discard changes?' : 'Discard current changes?') : (cur ? 'Revert to saved' : 'Open'),
              onclick: () => (dirty ? confirmThen('open', x.id, () => openSong(x.id)) : openSong(x.id)) }),
          el('button', { type: 'button', text: 'Duplicate', onclick: () => duplicateSong(x.id) }),
          el('button', { type: 'button', class: isArmed('del', x.id) ? 'danger' : '',
            'aria-label': isArmed('del', x.id) ? `Confirm deleting ${x.name}` : `Delete ${x.name}`,
            text: isArmed('del', x.id) ? 'Delete for good?' : 'Delete', onclick: () => confirmThen('del', x.id, () => deleteSong(x.id)) })));
    }) : [el('li', { class: 'song-empty', text: 'No saved songs yet. Name this one above and choose Save to library.' })];

    let used = 0;
    try { used = (localStorage.getItem(LIB_KEY) || '').length + (localStorage.getItem(STORAGE_KEY) || '').length; } catch (e) { /* ignore */ }
    host.replaceChildren(
      actions,
      el('ul', { class: 'song-list', 'aria-label': 'Saved songs' }, ...rows),
      el('p', { class: 'note', text: `Songs are kept in this browser's storage (about ${Math.max(1, Math.round(used / 1024))} KB used of roughly 5 MB). Clearing site data deletes them, so download a backup now and then.` }));
  }

  // ---- arrangement strip
  const SLOT_COLORS = ['#e5733f', '#d6ae4a', '#5db3c8', '#a98bdb'];
  function renderArrangement() {
    const host = $('#arrange');
    if (!host) return;
    const songMode = state.playMode === 'song';
    const total = songBars();
    const modeBtns = el('div', { class: 'views mode', role: 'group', 'aria-label': 'Playback' },
      el('button', { type: 'button', 'aria-pressed': String(!songMode), text: 'Loop pattern', onclick: () => setPlayMode('pattern') }),
      el('button', { type: 'button', 'aria-pressed': String(songMode), text: 'Play song', onclick: () => setPlayMode('song') }));
    const blocks = state.arrangement.map((sec, i) => el('li', { class: 'sec', 'data-sec': i, style: `--sc: ${SLOT_COLORS[sec.slot]}` },
      el('select', { class: 'sec-slot', 'aria-label': `Section ${i + 1} pattern`, onchange: (e) => { sec.slot = +e.target.value; arrangementChanged(); } },
        ...SLOT_NAMES.map((n, k) => el('option', { value: k, text: n, selected: k === sec.slot }))),
      el('label', { class: 'sec-bars' },
        el('input', { type: 'number', min: 1, max: 128, value: sec.bars, inputmode: 'numeric', 'aria-label': `Section ${i + 1} length in bars`,
          onchange: (e) => { sec.bars = clampInt(e.target.value, 1, 128, sec.bars); arrangementChanged(); } }),
        el('span', { text: 'bars' })),
      el('span', { class: 'sec-tools' },
        el('button', { type: 'button', text: '◀', 'aria-label': `Move section ${i + 1} earlier`, disabled: i === 0,
          onclick: () => { const a = state.arrangement; [a[i - 1], a[i]] = [a[i], a[i - 1]]; arrangementChanged(); } }),
        el('button', { type: 'button', text: '×', 'aria-label': `Remove section ${i + 1}`,
          onclick: () => { state.arrangement.splice(i, 1); arrangementChanged(); } }))));
    const add = el('li', { class: 'sec-add' },
      el('button', { type: 'button', disabled: state.arrangement.length >= MAX_SECTIONS, text: '+ Section',
        onclick: () => {
          const last = state.arrangement[state.arrangement.length - 1];
          state.arrangement.push({ slot: last ? (last.slot + 1) % 4 : state.current, bars: last ? last.bars : 8 });
          arrangementChanged();
        } }));
    const secs = (total * 4 * 60) / state.bpm;
    host.replaceChildren(
      modeBtns,
      el('ol', { class: 'sections', 'aria-label': 'Arrangement' }, ...blocks, add),
      el('div', { class: 'arr-info' },
        el('span', { text: total ? `${total} bars · ${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}` : 'no sections' }),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'songLoop', checked: state.songLoop,
          onchange: (e) => { state.songLoop = e.target.checked; save(); } }), ' Loop song')));
    if (playing && songActive()) markArrangement(songPos.index);
  }

  function arrangementChanged() {
    save();
    renderArrangement();
    renderExport();
  }

  function setPlayMode(mode) {
    state.playMode = mode === 'song' ? 'song' : 'pattern';
    queuedSlot = null;
    if (playing) {
      if (state.playMode === 'pattern') patStart = Math.ceil(masterTick / BAR) * BAR;
      songPos = { index: -1, pass: 0 };
    }
    save();
    renderArrangement();
    renderSlots();
    if (state.playMode === 'song' && !state.arrangement.length) flash('Add a section to the arrangement to play a song.');
  }

  function markArrangement(index) {
    document.querySelectorAll('#arrange .sec.now').forEach((x) => x.classList.remove('now'));
    if (index >= 0) { const e = document.querySelector(`#arrange .sec[data-sec="${index}"]`); if (e) e.classList.add('now'); }
  }

  function initSongs() {
    $('#songsToggle').addEventListener('click', () => { songsOpen = !songsOpen; renderSongs(); });
    const name = $('#songName');
    name.addEventListener('change', () => {
      const v = name.value.trim().slice(0, 60);
      if (v) { state.songName = v; save(); updateSongBar(); if (songsOpen) renderSongs(); } else name.value = state.songName;
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveSong(false); }
    });
    // If the autosaved session belongs to a library song, compare against the saved copy.
    const entry = state.songId && readLib().songs[state.songId];
    if (entry) {
      const n = sessionFromData(entry.session);
      if (n) { const { midi: _m, view: _v, ...r } = n; savedJson = songJson(JSON.parse(JSON.stringify(r))); }
    } else state.songId = null;
    updateSongBar();
  }

  // ---- whole-song MIDI: each section rendered from its pattern, laid end to end
  function buildSongClips() {
    const total = songBars() * BAR;
    if (!total) return [];
    const base = slug(state.songName) || 'song';
    const clips = [];
    for (const t of TRACKS()) {
      const notes = [];
      let start = 0;
      for (const sec of state.arrangement) {
        const p = state.patterns[sec.slot];
        const lanes = t.kind === 'drums'
          ? DRUM_VOICES.filter((v) => { const L = p.tracks.drums.lanes[v.id]; return L.vel.some((x, i) => x && i < L.length); }).map((v) => laneEvents(p, 'drums', v.id))
          : (p.tracks[t.id] ? [laneEvents(p, t.id)] : []);
        const clip = renderClip(lanes, sec.bars * BAR);
        for (const n of clip.notes) notes.push({ ...n, tick: n.tick + start });
        start += sec.bars * BAR;
      }
      if (!notes.length) continue;
      clips.push({ filename: `${base}-${slug(t.label) || t.id}-${total / BAR}bar.mid`,
        bytes: writeMidi({ name: `${state.songName} ${t.label}`, channel: channelOf(t.id), length: total, notes }), label: t.label });
    }
    return clips;
  }
  async function exportSong() {
    const clips = buildSongClips();
    if (!clips.length) { flash('Nothing to export: the arrangement is empty or its patterns have no notes.', true); return; }
    await offerFile(`${slug(state.songName) || 'song'}-arrangement-midi.zip`, makeZip(clips));
  }

  // ================================================================ keyboard
  function initKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'select', 'textarea'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (/^Digit[1-8]$/.test(e.code)) { const t = state.tracks[+e.code.slice(5) - 1]; if (t) selectTrack(t.id); }
      else if (e.key === 'm' || e.key === 'M') setView(state.view === 'mix' ? 'seq' : 'mix');
    });
  }

  // ================================================================ boot
  initHeader();
  initGrid();
  initVLane();
  initExport();
  initKeys();
  initSongs();
  renderAll();
  renderMidi();
  // Reconnect MIDI silently if it was on last time (Chrome remembers the permission).
  if (state.midi.enabled && navigator.requestMIDIAccess && !inArtifact()) {
    navigator.requestMIDIAccess({ sysex: false }).then((acc) => {
      midiAccess = acc;
      acc.onstatechange = () => { bindPorts(); renderMidi(); };
      bindPorts();
      renderMidi();
    }).catch(() => {});
  }
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
