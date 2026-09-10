# Melody + Chord — model comparison viewer (local)

Renders multitrack MIDIs in the browser: melody and chord tracks shown in two
colours (played through piano), with a draggable playhead, per-model variation
arrows, an experiment tab bar, and a prompt selector. No build step, no internet
required for the visuals (piano samples load from a CDN when online, else a synth).

## Run

The page reads the files via a generated `manifest.json`, and browsers block
`fetch()` over `file://`, so serve the folder over HTTP:

```bash
cd mt
python3 build_manifest.py      # scans midis/ -> manifest.json
python3 -m http.server 8000    # open http://localhost:8000
```

## Add your data

Put each experiment folder under `midis/`, e.g. `midis/E1_6bprompts/`,
`midis/E2_.../`, … Then re-run `python3 build_manifest.py` and reload.

`build_manifest.py` understands this layout per experiment:

```
<experiment>/
  <run>/A.2/<PP>/co/sample_{0,1,2}_temp*.mid     # model A.2 (3 variations)
  <run>/B.1/<PP>/co.mid                            # model B.1 (1 output)
  <run>/prompts/merged_tagged/<PP>.mid             # the input (melody+chord)
  <..._S1_...>/<PP>.mid_temp*_continuation_{0,1,2}.mid   # model S.1 (3 variations)
```

Each experiment becomes a **tab**; `<PP>` (001, 002, …) become the **prompt
selector**; each model is a **row** with ◀▶ arrows to step through its variations.
If E2–E5 use a different folder convention, tell me and I'll adjust the script.

## Track colours

Melody = orange, Chord = blue. A track is classed as melody/chord by its MIDI
track name (`MELODY`/`CHORD`); for unnamed tracks it falls back to program
(0 = melody, 48 = chord) then to polyphony. All tracks play through piano.
