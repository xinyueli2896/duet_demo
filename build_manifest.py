#!/usr/bin/env python3
"""Walk midis/ and emit manifest.json for the comparison page.

Co-style folders (E1: mel+chord continuation) are MERGED BY PROMPT LENGTH, so
every A.2 variant plus B.1 and S.1 that share an N-bar prompt land in one N-bar
experiment. Condition-style folders (E2: mel_only / chord_only) become their own
tabs. Each experiment carries promptBars for the prompt/generation shading.

Layouts understood:
  co-style  <run>/<MODEL>/<PP>/co/sample_*_temp*.mid   (A.2, A2v11, A2v12: 3 vars)
            <run>/B.1/<PP>/co.mid                        (B.1: 1 output)
            <run>/prompts/merged_tagged/<PP>.mid         (reference input)
            <..._S1_...>/<PP>.mid_temp*_continuation_*.mid + <PP>.mid_prompt.mid
  E2-style  <run>/A.2/<PP>/{mel_only,chord_only}/sample_*_temp*.mid
            <..._smel_...> / <..._schord_...> : S baselines + <PP>.mid_prompt.mid

Run from the webpage root:  python3 build_manifest.py
"""
import json, os, re, glob, struct

ROOT = "midis"
# Show only the melody->chord direction (hides chord2mel / chord-only tabs).
# Set to False to show every direction (e.g. both E3 variants).
MEL2CHORD_ONLY = False
# E3 gives a short seed of the generated modality as a prompt; shade that many bars.
E3_PROMPT_BARS = 4
# Truncate E3 rows (incl. the longer baseline) to this many bars so all rows match.
E3_CAP_BARS = 16
# E4 (MoE) uses the same 6-bar seed prompt as E1.
E4_PROMPT_BARS = 6
# E3 runs whose C.1 should be renamed (variant models added after C.1).
# Optional: model folder names to hide entirely. Duplicate versions are otherwise
# de-duplicated automatically. Add a name here to drop a model from every experiment.
IGNORE_MODELS = {"A2v11"}

def rel(p): return p.replace(os.sep, "/")
def natural(s): return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", str(s))]
def subdirs(d): return [os.path.join(d, x) for x in os.listdir(d) if os.path.isdir(os.path.join(d, x))]

# --- model folder -> (id, display name, sort order) ---
def model_meta(folder):
    """Return (id, display_name, sort_order, group)."""
    table = {
        "A1":        ("Duet (w/o query)",                 0,  "Our Models"),
        "A3":        ("Duet (refine)",                    1,  "Our Models"),
        "A3ctcaT":   ("Duet (alt.)",                      2,  "Our Models"),
        "S-scratch": ("Single-stream (from scratch)",       2,  "Internal Baselines"),
        "S1":        ("Single-stream (finetuned)",          3,  "Internal Baselines"),
        "P-mc":      ("Cascade (mel\u2192cho)",             4,  "Internal Baselines"),
        "P-cm":      ("Cascade (cho\u2192mel)",             5,  "Internal Baselines"),
        "WSf":       ("Whole-song Generation",              6,  "External Baseline"),
        "AMT":       ("Anticipatory Music Transformer",     7,  "External Baseline"),
    }
    if folder in table:
        nm, order, grp = table[folder]; return (folder, nm, order, grp)
    f = folder.lower()
    if folder == "B.1": return ("B.1", "Anticipatory", 3, None)
    if f == "a2shared": return ("A2shared", "share_gate", 0, None)
    if f == "a2mg": return ("A2mg", "modality_specific_gate", 1, None)
    if f == "d0": return ("D0", "per-modality gate", 0, None)
    if f == "d1": return ("D1", "dense", 1, None)
    if f == "d2": return ("D2", "hard route", 2, None)
    if f == "d3": return ("D3", "shared gate", 3, None)
    m = re.match(r"a2v(\d)(\d+)$", folder, re.I)
    if m: return (folder, f"A.2 v{m.group(1)}.{m.group(2)}", 1.1 + int(m.group(1) + m.group(2)) * 0.001, None)
    if folder == "A.1": return ("A.1", "A.1", 0, None)
    if folder == "A.2": return ("A.2", "A.2", 1, None)
    return (folder, folder, 2.5, None)

def exp_tag(name, run):
    """Which experiment a co-style folder belongs to (keeps MoE separate from E1)."""
    s = (name + " " + os.path.basename(run)).lower()
    return "E4" if "moe" in s else "E1"

# --- tiny dependency-free MIDI bar-length reader (assumes 4/4) ---
def first_named_track(path):
    """Return the name of the first track that carries notes (pure-python)."""
    try: d = open(path, "rb").read()
    except Exception: return None
    if d[:4] != b"MThd": return None
    ntr = struct.unpack(">H", d[10:12])[0]
    p = 14
    for _ in range(ntr):
        if d[p:p+4] != b"MTrk": break
        length = struct.unpack(">I", d[p+4:p+8])[0]; p += 8; end = p + length
        name = None; has_note = False; running = 0
        while p < end:
            v = 0
            while True:
                b = d[p]; p += 1; v = (v << 7) | (b & 0x7f)
                if not (b & 0x80): break
            st = d[p]
            if st & 0x80: p += 1; running = st
            else: st = running
            if st == 0xFF:
                meta = d[p]; p += 1; ln = 0
                while True:
                    b = d[p]; p += 1; ln = (ln << 7) | (b & 0x7f)
                    if not (b & 0x80): break
                if meta == 0x03 and name is None:
                    name = d[p:p+ln].decode("latin-1", "ignore")
                p += ln
            elif st in (0xF0, 0xF7):
                ln = 0
                while True:
                    b = d[p]; p += 1; ln = (ln << 7) | (b & 0x7f)
                    if not (b & 0x80): break
                p += ln
            else:
                typ = st & 0xF0
                if typ == 0x90 and d[p+1] > 0: has_note = True
                p += 1 if typ in (0xC0, 0xD0) else 2
        p = end
        if has_note and name: return name
    return None

def midi_bars(path):
    try: d = open(path, "rb").read()
    except Exception: return None
    if d[:4] != b"MThd": return None
    ppq = struct.unpack(">H", d[12:14])[0]
    if ppq & 0x8000 or not ppq: return None
    p = 14; maxtick = 0
    while p < len(d) - 8:
        if d[p:p+4] != b"MTrk": break
        length = struct.unpack(">I", d[p+4:p+8])[0]; p += 8; end = p + length
        tick = 0; running = 0
        while p < end:
            v = 0
            while True:
                b = d[p]; p += 1; v = (v << 7) | (b & 0x7f)
                if not (b & 0x80): break
            tick += v; st = d[p]
            if st & 0x80: p += 1; running = st
            else: st = running
            if st == 0xFF:
                p += 1; ln = 0
                while True:
                    b = d[p]; p += 1; ln = (ln << 7) | (b & 0x7f)
                    if not (b & 0x80): break
                p += ln
            elif st in (0xF0, 0xF7):
                ln = 0
                while True:
                    b = d[p]; p += 1; ln = (ln << 7) | (b & 0x7f)
                    if not (b & 0x80): break
                p += ln
            else:
                p += 1 if (st & 0xF0) in (0xC0, 0xD0) else 2
            if tick > maxtick: maxtick = tick
        p = end
    return maxtick / ppq / 4.0

def prompt_bars(name, prompt_files):
    m = re.search(r"(\d+)bprompt", name, re.I) or re.search(r"[_-]p(\d+)\b", name, re.I)
    if m: return int(m.group(1))
    vals = [round(v) for v in (midi_bars(f) for f in prompt_files) if v and v >= 1]
    return max(set(vals), key=vals.count) if vals else None

def find_run(exp_dir):
    for d in subdirs(exp_dir):
        if os.path.isdir(os.path.join(d, "prompts")) or any(os.path.isdir(os.path.join(d, x)) for x in ("A.2", "B.1")):
            return d
        for x in os.listdir(d):
            if re.match(r"A2v", x, re.I): return d
    return exp_dir

def model_variations(model_dir):
    """Extract {PP: [files]} from a model folder in any of the known layouts."""
    var = {}
    # cascade final: <model>/4_final/<PP>/co/*.mid
    fin = os.path.join(model_dir, "4_final")
    if os.path.isdir(fin):
        for pp in sorted(os.listdir(fin), key=natural):
            co = os.path.join(fin, pp, "co")
            if os.path.isdir(co):
                fs = sorted(glob.glob(os.path.join(co, "*.mid")), key=lambda x: natural(os.path.basename(x)))
                if fs: var[pp] = [rel(f) for f in fs]
        if var: return var
    # continuation (S-style): <model>/<PP>.mid_temp*_continuation_*.mid
    conts = glob.glob(os.path.join(model_dir, "*_continuation_*.mid"))
    if conts:
        for f in conts:
            mm = re.match(r"([^.]+)", os.path.basename(f))
            if mm: var.setdefault(mm.group(1), []).append(rel(f))
        for k in var: var[k] = sorted(var[k], key=lambda x: natural(os.path.basename(x)))
        return var
    # co-style: <model>/<PP>/co/*.mid  (or <PP>/co.mid)
    for pp in sorted(os.listdir(model_dir), key=natural):
        ppd = os.path.join(model_dir, pp)
        if not os.path.isdir(ppd): continue
        co = os.path.join(ppd, "co")
        if os.path.isdir(co):
            fs = sorted(glob.glob(os.path.join(co, "*.mid")), key=lambda x: natural(os.path.basename(x)))
            if fs: var[pp] = [rel(f) for f in fs]
        elif os.path.isfile(os.path.join(ppd, "co.mid")):
            var[pp] = [rel(os.path.join(ppd, "co.mid"))]
    return var

def model_excluded(folder):
    if folder.endswith("_piano") or folder in IGNORE_MODELS: return True
    if re.match(r"A3", folder) and folder not in ("A3", "A3ctcaT"): return True   # keep A3 & A3ctcaT; drop other A3* variants
    return False

def co_models(run):
    """All model folders in run -> list of (folder, variations{PP:[files]})."""
    out = []
    for folder in sorted(os.listdir(run), key=natural):
        full = os.path.join(run, folder)
        if not os.path.isdir(full) or folder == "prompts" or model_excluded(folder): continue
        var = model_variations(full)
        if var: out.append((folder, var))
    return out

def merged_prompts(run):
    d = os.path.join(run, "prompts", "merged_tagged"); out = {}
    if os.path.isdir(d):
        for f in glob.glob(os.path.join(d, "*.mid")):
            out[os.path.splitext(os.path.basename(f))[0]] = rel(f)
    return out

def s_continuations(sdir):
    var = {}
    if sdir and os.path.isdir(sdir):
        for f in glob.glob(os.path.join(sdir, "*_continuation_*.mid")):
            mm = re.match(r"(\d+)", os.path.basename(f))
            if mm: var.setdefault(mm.group(1), []).append(rel(f))
        for k in var: var[k] = sorted(var[k], key=lambda x: natural(os.path.basename(x)))
    return var

def s_prompts(sdir):
    out = {}
    if sdir and os.path.isdir(sdir):
        for f in glob.glob(os.path.join(sdir, "*_prompt.mid")):
            mm = re.match(r"(\d+)", os.path.basename(f))
            if mm: out[mm.group(1)] = rel(f)
    return out

def a2_conditions(run, cond):
    base = os.path.join(run, "A.2"); var = {}
    if os.path.isdir(base):
        for pp in sorted(os.listdir(base), key=natural):
            d = os.path.join(base, pp, cond)
            if os.path.isdir(d):
                fs = sorted(glob.glob(os.path.join(d, "*.mid")), key=lambda x: natural(os.path.basename(x)))
                if fs: var[pp] = [rel(f) for f in fs]
    return var

def baseline_name(folder):
    b = folder.replace(" baseline", "").replace("baseline", "").strip()
    return f"Baseline ({b})" if b else "Baseline"

def _direction(name):
    """Return 'mel→chord', 'chord→mel', or None for a Cascade direction folder."""
    n = name.lower(); mi = n.find("mel"); ci = n.find("chord")
    if mi == -1 or ci == -1: return None
    return "mel→chord" if mi < ci else "chord→mel"

def discover_baselines(exp_dir):
    """Return [(display_name, variations)] for '* baseline' folders.
    Plain S-style baselines (co-generation) -> one row. Directional (Cascade)
    baselines -> one row per direction, since E1 is co-generation."""
    out = []
    for sub in sorted(subdirs(exp_dir), key=lambda d: natural(os.path.basename(d))):
        bn = os.path.basename(sub)
        if "baseline" not in bn.lower(): continue
        sv = s_continuations(sub)                      # standard: continuation files directly
        if sv: out.append((baseline_name(bn), sv)); continue
        # directional (Cascade): emit BOTH directions as separate rows
        base = bn.replace("baseline", "").strip()
        for d in sorted(subdirs(sub), key=lambda x: natural(os.path.basename(x))):
            direction = _direction(os.path.basename(d))
            if not direction: continue
            final = os.path.join(d, "4_final"); var = {}
            if os.path.isdir(final):
                for pp in sorted(os.listdir(final), key=natural):
                    co = os.path.join(final, pp, "co")
                    if os.path.isdir(co):
                        fs = sorted(glob.glob(os.path.join(co, "*.mid")), key=lambda x: natural(os.path.basename(x)))
                        if fs: var[pp] = [rel(f) for f in fs]
            if var: out.append((f"Baseline ({base} · {direction})", var))
    return out

def build_e3(e3_dirs):
    """Two variant experiments (mel2chord, chord2mel) from E3 folders + baseline (y)."""
    # descend into container folders (midis/E3/, E3_C1a+b/, ...) holding run/model dirs + _y
    def has_C(d):
        try: return any(re.match(r"C\.", x) and not x.endswith("_piano") and os.path.isdir(os.path.join(d, x)) for x in os.listdir(d))
        except Exception: return False
    expanded = []
    for d in e3_dirs:
        if has_C(d): expanded.append(d); continue
        subs = subdirs(d)
        picked = [s for s in subs if re.search(r"melchord", os.path.basename(s), re.I) or os.path.basename(s).lower().endswith("_y") or has_C(s)]
        expanded.extend(picked if picked else [d])
    e3_dirs = expanded
    y_dir = next((d for d in e3_dirs if os.path.basename(d).lower().endswith("_y")), None)
    runs = [d for d in e3_dirs if d is not y_dir and has_C(d)]
    def variant_of(cond_name, sample):
        c = cond_name.lower()
        if "mel2chord" in c: return "mel2chord"
        if "chord2mel" in c: return "chord2mel"
        nm = (first_named_track(sample) or "").lower()      # fall back to first (given) track
        mi, ci = nm.find("mel"), nm.find("chord")
        if mi != -1 and ci != -1: return "mel2chord" if mi < ci else "chord2mel"
        return None

    variants = {}   # variant -> {model_name -> {song -> [files]}}
    for run in runs:
        cm = re.match(r"c1([ab])$", os.path.basename(run).lower())   # c1a/c1b folder -> C.1a/C.1b
        for mf in sorted(os.listdir(run)):
            if not (os.path.isdir(os.path.join(run, mf)) and re.match(r"C\.", mf) and not mf.endswith("_piano")): continue
            model_name = ("C.1" + cm.group(1)) if cm else mf
            for song in os.listdir(os.path.join(run, mf)):
                sd = os.path.join(run, mf, song)
                if not os.path.isdir(sd): continue
                for entry in sorted(os.listdir(sd), key=natural):    # condition = subfolder or *_temp*.mid file
                    full = os.path.join(sd, entry)
                    if os.path.isdir(full):
                        files = sorted(glob.glob(os.path.join(full, "*.mid")), key=lambda x: natural(os.path.basename(x)))
                    elif entry.endswith(".mid"):
                        files = [full]
                    else:
                        continue
                    if not files: continue
                    v = variant_of(entry, files[0])
                    if not v: continue
                    variants.setdefault(v, {}).setdefault(model_name, {})[song] = [rel(f) for f in files]

    def y_var(variant):
        out = {}
        if y_dir:
            for song in os.listdir(y_dir):
                sd = os.path.join(y_dir, song, variant)
                if os.path.isdir(sd):
                    fs = sorted(glob.glob(os.path.join(sd, "*.mid")), key=lambda x: natural(os.path.basename(x)))
                    if fs: out[song] = [rel(f) for f in fs]
        return out

    given = {"mel2chord": ("melody", "chord"), "chord2mel": ("chord", "melody")}
    exps = []
    for var in ["mel2chord", "chord2mel"]:
        if var not in variants: continue
        models = []
        for m in sorted(variants[var], key=natural):
            models.append({"id": m, "name": m, "variations": variants[var][m]})
        yv = y_var(var)
        if yv: models.append({"id": "y", "name": "Baseline (y)", "variations": yv})   # e3_y is the baseline
        songs = sorted(set().union(*[set(mm["variations"]) for mm in models]) if models else set(), key=natural)
        g, gen = given[var]
        exps.append({"id": f"E3_{var}", "name": f"E3 · {var}", "prompts": songs, "promptBars": E3_PROMPT_BARS,
                     "input": {}, "models": models, "given": g, "capBars": E3_CAP_BARS,
                     "note": f"{g} given (grey) → {gen} generated · {E3_PROMPT_BARS}-bar seed shaded · C.1, C.2 vs Baseline (all capped to {E3_CAP_BARS} bars)"})
    return exps

def main():
    if not os.path.isdir(ROOT): raise SystemExit(f"no '{ROOT}/' here; run from the webpage root")
    co_groups = {}; cond_exps = []; e3_dirs = []
    tops = [os.path.join(ROOT, n) for n in sorted(os.listdir(ROOT), key=natural)
            if os.path.isdir(os.path.join(ROOT, n)) and not n.startswith("__")]
    # S1 folders that live as their own top-level dir (siblings of a run), matched by timestamp
    s1_siblings = [d for d in tops if "_s1_" in os.path.basename(d).lower()
                   and glob.glob(os.path.join(d, "*_continuation_*.mid"))]
    def digits(s): 
        m = re.findall(r"\d{4,}", s); return set(m)
    def sibling_s1_for(exp_dir, run):
        want = digits(os.path.basename(exp_dir)) | digits(os.path.basename(run))
        for s in s1_siblings:
            if digits(os.path.basename(s)) & want: return s
        return None

    for exp_dir in tops:
        name = os.path.basename(exp_dir)
        if name.lower().startswith("e3"): e3_dirs.append(exp_dir); continue
        if exp_dir in s1_siblings: continue                 # handled via matching, not as its own experiment
        subs = subdirs(exp_dir); run = find_run(exp_dir)
        is_co = os.path.isdir(os.path.join(run, "prompts", "merged_tagged"))
        if is_co:
            tag = exp_tag(name, run)
            bl_prompts = []
            for sub in subdirs(exp_dir):
                if "baseline" in os.path.basename(sub).lower():
                    bl_prompts += list(s_prompts(sub).values())
            for sub in subdirs(run):                 # S-style model folders (S1, S-scratch) carry *_prompt.mid
                bl_prompts += list(s_prompts(sub).values())
            N = E4_PROMPT_BARS if tag == "E4" else prompt_bars(name, bl_prompts)
            g = co_groups.setdefault((tag, N), {"models": {}, "input": {}, "baselines": []})
            for folder, var in co_models(run):
                mid, nm, order, grp = model_meta(folder)
                g["models"][mid] = (order, nm, var, grp)
            g["input"].update(merged_prompts(run))
            for bn, bv in discover_baselines(exp_dir):
                g["baselines"].append((bn, bv))
        else:
            a2 = os.path.join(run, "A.2"); conds = set()
            if os.path.isdir(a2):
                for pp in os.listdir(a2):
                    for c in (os.listdir(os.path.join(a2, pp)) if os.path.isdir(os.path.join(a2, pp)) else []):
                        if os.path.isdir(os.path.join(a2, pp, c)): conds.add(c)
            pm = re.match(r"(E\d+)", name, re.I); prefix = pm.group(1).upper() if pm else name
            for cond in sorted(conds):
                tag = "mel" if "mel" in cond else ("chord" if "chord" in cond else cond)
                sdir = next((d for d in subs if re.search(rf"_s{tag}_", os.path.basename(d))), None)
                models = []
                av = a2_conditions(run, cond)
                if av: models.append({"id": "A.2", "name": "A.2", "variations": av})
                sv = s_continuations(sdir)
                if sv: models.append({"id": "S.1", "name": "Baseline (S1)", "variations": sv})
                inp = s_prompts(sdir)
                pids = sorted(set(inp) | set().union(*[set(m["variations"]) for m in models]) if models else set(inp), key=natural)
                pbN = prompt_bars(name, list(inp.values()))
                cond_exps.append({"id": f"{name}__{tag}", "name": f"{prefix} · {tag}-only",
                                  "prompts": pids, "promptBars": pbN,
                                  "input": inp, "models": models,
                                  "note": f"prompt length: {pbN} bars" if pbN else None})

    experiments = []
    for (tag, N) in sorted(co_groups, key=lambda k: (k[0], k[1] or 0)):
        g = co_groups[(tag, N)]
        cap = (N or 5) + 22 if tag != "E4" else 0     # trim ground-truth/whole-song rows to ~prompt+generation
        models = []
        # Ground Truth first (full reference truncated to prompt+generation length)
        if tag != "E4" and g["input"]:
            models.append({"id": "GT", "name": "Ground Truth", "group": "Reference", "variations": {k: [v] for k, v in g["input"].items()}})
        for mid, (order, nm, var, grp) in sorted(g["models"].items(), key=lambda kv: kv[1][0]):
            models.append({"id": mid, "name": nm, "group": grp, "variations": var})
        for i, (bn, bv) in enumerate(g.get("baselines", [])):
            models.append({"id": f"bl{i}", "name": bn, "group": "Internal Baselines", "variations": bv})
        pids = sorted(set(g["input"]) | set().union(*[set(m["variations"]) for m in models]) if models else set(g["input"]), key=natural)
        exp = {"id": f"{tag}_{N}b", "prompts": pids, "promptBars": N, "input": {}, "models": models, "capBars": cap}
        if tag == "E4":
            exp["name"] = "E4 · MoE"; exp["note"] = f"MoE gating comparison · {N}-bar prompt · " + ", ".join(m["name"] for m in models)
        else:
            exp["name"] = f"E1 · {N}-bar prompt"
        experiments.append(exp)
    experiments += cond_exps
    if e3_dirs: experiments += build_e3(e3_dirs)

    if MEL2CHORD_ONLY:   # keep only the melody->chord direction
        experiments = [e for e in experiments if not re.search(r"chord2mel|chord-only", e["name"], re.I)]

    json.dump({"experiments": experiments}, open("manifest.json", "w"), indent=1)
    print(f"wrote manifest.json — {len(experiments)} experiment(s):")
    for e in experiments:
        extra = f" [{e['note']}]" if e.get("note") else ""
        print(f"  {e['name']}{extra}: {len(e['prompts'])} groups, models=" + ", ".join(m["name"] for m in e["models"]))

if __name__ == "__main__":
    main()
