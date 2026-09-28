# Polyphemus

A browser-based step sequencer.

- **`v2/`** — the current version: a polyrhythmic sequencer with a drum kit plus up to seven synth tracks, and a mixer.
- **`v1/`** — the original 2016 build, archived untouched (also tagged `v1.0`).

## v2

Every drum voice and every melodic track is a lane with its own **length** (1–64 steps) and **step rate** (1/32 to 1/2, including triplets, quintuplets and dotted values). Lanes of different lengths drift against each other and realign only after their common cycle.

- Drums: eight synthesized voices (kick, conga low/high, snap, rim, shaker, closed/open hat), each its own lane with Euclidean fill, rotation and an echo send.
- Bass, lead, pad: piano-roll grids locked to a key and scale; chord stamps (triad, 7th, 9th, sus4, fifths); mono mode for bass lines.
- Add up to seven synth tracks (bass, lead, pad, keys types), each renamable, with its own sound, lanes, MIDI channel and clip export.
- Mixer view: per-track fader, pan, mute/solo, level meter, 3-band EQ, a one-knob DJ filter (low-pass left, high-pass right), echo and space sends; echo and space return strips; master strip.
- Velocity and chance lanes per lane; global humanize; swing per track (the header Swing sets them all at once), optionally included in MIDI export.
- Dub echo (tempo-synced, filtered feedback delay) and a reverb "space" send per track.
- Four pattern slots (A–D) that switch on the next bar while playing; shareable session codes.
- Songs: the working session autosaves to the browser; a song library (localStorage) keeps named songs you can open, duplicate and delete. Songs and whole-library backups download and open as `.json` files.
- Arrangement: chain pattern slots with bar counts (e.g. A×8, B×8, C×4) and switch between Loop pattern and Play song; export the whole arrangement as one MIDI file per track.
- **Live connection over Web MIDI** (Chrome/Edge on a computer): follows Live's MIDI clock (tempo, Start/Stop/Continue with song position), sends notes into Live in real time on per-track channels (drums 10, bass 1, lead 2, pad 3 by default), or sends clock so Polyphemus leads. Setup steps for the macOS IAC Driver are in the app. Safari and every iOS browser lack Web MIDI, and the claude.ai artifact blocks it.
- **MIDI export for Ableton Live**: one Standard MIDI File per track (or per drum voice), 480 PPQ, tempo embedded. "Full cycle" clips run until every lane in the track realigns on a bar line, so they loop cleanly (capped at 64 bars). Drum notes follow General MIDI or a Drum Rack C1–G1 layout.

Sound comes from [Tone.js](https://tonejs.github.io/) 15.1.22, loaded from a CDN at runtime; there is no build step. Open `v2/index.html` through any static server, or enable GitHub Pages for this repository (Settings → Pages → deploy from `master`, root).

## v1

Five rows (lead, bass, closed hat, snare, kick) × 16 steps, triggering WAV samples, with local pattern storage and SoundCloud recording. It relies on `webkitAudioContext`, an external `BufferLoader` script over HTTP and SoundCloud's retired upload API, so it is kept for reference rather than use.

[v1 demo video](https://vimeo.com/167842839)
