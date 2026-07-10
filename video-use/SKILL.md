---
name: video-use
description: Edit any video by conversation. Transcribe, cut, color grade, generate overlay animations, burn subtitles — for talking heads, montages, tutorials, travel, interviews. No presets, no menus. Ask questions, confirm the plan, execute, iterate, persist. Production-correctness rules are hard; everything else is artistic freedom.
---

# Video Use

## Principle

1. **LLM reasons from raw transcript + on-demand visuals.** The only derived artifact that earns its keep is a packed phrase-level transcript (`takes_packed.md`). Everything else — filler tagging, retake detection, shot classification, emphasis scoring — you derive at decision time.
2. **Audio is primary, visuals follow.** Cut candidates come from speech boundaries and silence gaps. Drill into visuals only at decision points.
3. **Ask → confirm → execute → iterate → persist.** Never touch the cut until the user has confirmed the strategy in plain English.
4. **Generalize.** Do not assume what kind of video this is. Look at the material, ask the user, then edit.
5. **Artistic freedom is the default.** Every specific value, preset, font, color, duration, pitch structure, and technique in this document is a *worked example* from one proven video — not a mandate. Read them to understand what's possible and why each worked. Then make your own taste calls based on what the material actually is and what the user actually wants. **The only things you MUST do are in the Hard Rules section below.** Everything else is yours.
6. **Invent freely.** If the material calls for a technique not described here — split-screen, picture-in-picture, lower-third identity cards, reaction cuts, speed ramps, freeze frames, crossfades, match cuts, L-cuts, J-cuts, speed ramps over breath, whatever — build it. The helpers are ffmpeg and PIL. They can do anything the format supports. Do not wait for permission.
7. **Verify your own output before showing it to the user.** If you wouldn't ship it, don't present it.

## Hard Rules (production correctness — non-negotiable)

These are the things where deviation produces silent failures or broken output. They are not taste, they are correctness. Memorize them.

1. **Subtitles are applied LAST in the filter chain**, after every overlay. Otherwise overlays hide captions. Silent failure.
2. **Per-segment extract → lossless `-c copy` concat**, not single-pass filtergraph. Otherwise you double-encode every segment when overlays are added.
3. **30ms audio fades at every segment boundary** (`afade=t=in:st=0:d=0.03,afade=t=out:st={dur-0.03}:d=0.03`). Otherwise audible pops at every cut.
4. **Overlays use `setpts=PTS-STARTPTS+T/TB`** to shift the overlay's frame 0 to its window start. Otherwise you see the middle of the animation during the overlay window.
5. **Master SRT uses output-timeline offsets**: `output_time = word.start - segment_start + segment_offset`. Otherwise captions misalign after segment concat.
6. **Never cut inside a word.** Snap every cut edge to a word boundary from the Scribe transcript.
7. **Pad every cut edge.** Working window: 30–200ms. Scribe timestamps drift 50–100ms — padding absorbs the drift. Tighter for fast-paced, looser for cinematic.
8. **Word-level verbatim ASR only.** Never SRT/phrase mode (loses sub-second gap data). Never normalized fillers (loses editorial signal).
9. **Cache transcripts per source.** Never re-transcribe unless the source file itself changed.
10. **Parallel sub-agents for multiple animations.** Never sequential. Spawn N at once via the `Agent` tool; total wall time ≈ slowest one.
11. **Strategy confirmation before execution.** Never touch the cut until the user has approved the plain-English plan.
12. **All session outputs in `<videos_dir>/edit/`.** Never write inside the `video-use/` project directory.

Everything else in this document is a worked example. Deviate whenever the material calls for it.

## Directory layout

The skill lives in `video-use/`. User footage lives wherever they put it. All session outputs go into `<videos_dir>/edit/`.

```
<videos_dir>/
├── <source files, untouched>
└── edit/
    ├── project.md               ← memory; appended every session
    ├── takes_packed.md          ← phrase-level transcripts, the LLM's primary reading view
    ├── edl.json                 ← cut decisions
    ├── transcripts/<name>.json  ← cached raw Scribe JSON
    ├── animations/slot_<id>/    ← per-animation source + render + reasoning
    ├── clips_graded/            ← per-segment extracts with grade + fades
    ├── master.srt               ← output-timeline subtitles
    ├── downloads/               ← yt-dlp outputs
    ├── verify/                  ← debug frames / timeline PNGs
    ├── preview.mp4
    └── final.mp4
```

## Setup

First-time install lives in `install.md` (clone, deps, ffmpeg, skill registration, API key). Don't re-run it every session; on cold start just verify:

- **Transcription engine.** Default to **local Whisper** (free, offline): `helpers/transcribe_whisper.py`, which uses **faster-whisper** in a dedicated venv so it never touches the user's base/conda env. One-time setup (the script auto-re-execs into this venv): `python3 -m venv <skill>/.venv-whisper && <skill>/.venv-whisper/bin/pip install -U faster-whisper`. It decodes media directly (PyAV) — no ffmpeg pre-pass. Only use ElevenLabs Scribe (`helpers/transcribe.py`) when the user explicitly asks or needs diarization — it requires `ELEVENLABS_API_KEY` in the environment or `.env` (never write it to the user's `<videos_dir>`). Both write the same `transcripts/<stem>.json` schema, so the rest of the pipeline is identical.
- `ffmpeg` + `ffprobe` on PATH.
- Python deps installed (`uv sync` or `pip install -e .` inside the repo).
- Node.js + npm available if the session needs HyperFrames or Remotion slots. HyperFrames currently requires Node.js 22+.
- `yt-dlp`, HyperFrames, Remotion, Manim installed only on first use.
- First-use animation setup happens inside the slot directory, never at the video-use repo root. HyperFrames can be invoked with `npx --yes hyperframes ...`; Remotion can be scaffolded with `npx create-video@latest` or installed as a project-local dependency before using its `remotion render` command.
- This skill vendors `skills/manim-video/`. Read its SKILL.md when building a Manim slot.

Helpers (`helpers/transcribe.py`, `helpers/render.py`, etc.) live alongside this SKILL.md. Resolve their paths relative to the directory containing this file — the skill is typically symlinked at `~/.claude/skills/video-use/` or `~/.codex/skills/video-use/`.

## Helpers

- **`transcribe_whisper.py <video>`** — **default, free.** Local Whisper → word-level JSON in the same schema as Scribe (with synthesized `spacing` gaps). Defaults to the `medium` model (small is noticeably worse, especially for non-English); `--model` and `--language es` optional. Cached. No diarization.
- **`transcribe.py <video>`** — ElevenLabs Scribe (paid, needs API key). Use only when asked or when diarization is needed. `--num-speakers N` optional. Cached.
- **`transcribe_batch.py <videos_dir>`** — 4-worker parallel Scribe transcription. Use for multi-take.
- **`pack_transcripts.py --edit-dir <dir>`** — `transcripts/*.json` → `takes_packed.md` (phrase-level, break on silence ≥ 0.5s).
- **`timeline_view.py <video> <start> <end>`** — filmstrip + waveform PNG. On-demand visual drill-down. **Not a scan tool** — use it at decision points, not constantly.
- **`render.py <edl.json> -o <out>`** — per-segment extract → concat → overlays (PTS-shifted) → subtitles LAST. `--preview` for 720p fast. `--build-subtitles` to generate master.srt inline.
- **`grade.py <in> -o <out>`** — ffmpeg filter chain grade. Presets + `--filter '<raw>'` for custom.

For animations, create `<edit>/animations/slot_<id>/` with `Bash` and spawn a sub-agent via the `Agent` tool.

## The process

1. **Inventory.** `ffprobe` every source. `transcribe_batch.py` on the directory. `pack_transcripts.py` to produce `takes_packed.md`. Sample one or two `timeline_view`s for a visual first impression.
2. **Pre-scan for problems.** One pass over `takes_packed.md` to note verbal slips, obvious mis-speaks, or phrasings to avoid. Plain list, feed into the editor brief.
3. **Converse.** Describe what you see in plain English. Ask questions *shaped by the material*. Collect: content type, target length/aspect, aesthetic/brand direction, pacing feel, must-preserve moments, must-cut moments, animation and grade preferences, subtitle needs. Do not use a fixed checklist — the right questions are different every time.
4. **Propose strategy.** 4–8 sentences: shape, take choices, cut direction, animation plan, grade direction, subtitle style, length estimate. **Wait for confirmation.**
5. **Execute.** Produce `edl.json` via the editor sub-agent brief. Drill into `timeline_view` at ambiguous moments. Build animations in parallel sub-agents. Apply grade per-segment. Compose via `render.py`.
6. **Preview.** `render.py --preview`.
7. **Self-eval (before showing the user).** Run `timeline_view` on the **rendered output** (not the sources) at every cut boundary (±1.5s window). Check each image for:
   - Visual discontinuity / flash / jump at the cut
   - Waveform spike at the boundary (audio pop that slipped past the 30ms fade)
   - Subtitle hidden behind an overlay (Rule 1 violation)
   - Overlay misaligned or showing wrong frames (Rule 4 violation)

   Also sample: first 2s, last 2s, and 2–3 mid-points — check grade consistency, subtitle readability, overall coherence. Run `ffprobe` on the output to verify duration matches the EDL expectation.

   If anything fails: fix → re-render → re-eval. **Cap at 3 self-eval passes** — if issues remain after 3, flag them to the user rather than looping forever. Only present the preview once the self-eval passes.
8. **Iterate + persist.** Natural-language feedback, re-plan, re-render. Never re-transcribe. Final render on confirmation. Append to `project.md`.

## Cut craft (techniques)

- **Audio-first.** Candidate cuts from word boundaries and silence gaps.
- **Preserve peaks.** Laughs, punchlines, emphasis beats. Extend past punchlines to include reactions — the laugh IS the beat.
- **Speaker handoffs** benefit from air between utterances. Common values: 400–600ms. Less for fast-paced, more for cinematic. Taste call.
- **Audio events as signals.** `(laughs)`, `(sighs)`, `(applause)` mark beats. Extend past them.
- **Silence gaps are cut candidates.** Silences ≥400ms are usually the cleanest. 150–400ms phrase boundaries are usable with a visual check. <150ms is unsafe (mid-phrase).
- **Example cut padding** (the launch video shipped with this): 50ms before the first kept word, 80ms after the last. Tighter for montage energy, looser for documentary. Stay in the 30–200ms working window (Hard Rule 7).
- **Never reason audio and video independently.** Every cut must work on both tracks.

## The packed transcript (primary reading view)

`pack_transcripts.py` reads all `transcripts/*.json` and produces one markdown file where each take is a list of phrase-level lines, each prefixed with its `[start-end]` time range. Phrases break on any silence ≥ 0.5s OR speaker change. This is the artifact the editor sub-agent reads to pick cuts — it gives word-boundary precision from text alone at 1/10 the tokens of raw JSON.

Example line:
```
## C0103  (duration: 43.0s, 8 phrases)
  [002.52-005.36] S0 Ninety percent of what a web agent does is completely wasted.
  [006.08-006.74] S0 We fixed this.
```

## Editor sub-agent brief (for multi-take selection)

When the task is "pick the best take of each beat across many clips," spawn a dedicated sub-agent with a brief shaped like this. The structure is load-bearing; the pitch-shape example is not.

```
You are editing a <type> video. Pick the best take of each beat and 
assemble them chronologically by beat, not by source clip order.

INPUTS:
  - takes_packed.md (time-annotated phrase-level transcripts of all takes)
  - Product/narrative context: <2 sentences from the user>
  - Speaker(s): <name, role, delivery style note>
  - Expected structure: <pick an archetype or invent one>
  - Verbal slips to avoid: <list from the pre-scan pass>
  - Target runtime: <seconds>

Common structural archetypes (pick, adapt, or invent):
  - Tech launch / demo:   HOOK → PROBLEM → SOLUTION → BENEFIT → EXAMPLE → CTA
  - Tutorial:             INTRO → SETUP → STEPS → GOTCHAS → RECAP
  - Interview:            (QUESTION → ANSWER → FOLLOWUP) repeat
  - Travel / event:       ARRIVAL → HIGHLIGHTS → QUIET MOMENTS → DEPARTURE
  - Documentary:          THESIS → EVIDENCE → COUNTERPOINT → CONCLUSION
  - Music / performance:  INTRO → VERSE → CHORUS → BRIDGE → OUTRO
  - Or invent your own.

RULES:
  - Start/end times must fall on word boundaries from the transcript.
  - Pad cut boundaries (working window 30–200ms).
  - Prefer silences ≥ 400ms as cut targets.
  - Unavoidable slips are kept if no better take exists. Note them in "reason".
  - If over budget, revise: drop a beat or trim tails. Report total and self-correct.

OUTPUT (JSON array, no prose):
  [{"source": "C0103", "start": 2.42, "end": 6.85, "beat": "HOOK",
    "quote": "...", "reason": "..."}, ...]

Return the final EDL and a one-line total runtime check.
```

## Color grade (when requested)

Your job is to **reason about the image**, not apply a preset. Look at a frame (via `timeline_view`), decide what's wrong, adjust one thing, look again.

Mental model is ASC CDL. Per channel: `out = (in * slope + offset) ** power`, then global saturation. `slope` → highlights, `offset` → shadows, `power` → midtones.

**Example filter chains** (`grade.py` has `--list-presets`; use them as starting points or mix your own):

- **`warm_cinematic`** — retro/technical, subtle teal/orange split, desaturated. Shipped in a real launch video. Safe for talking heads.
- **`neutral_punch`** — minimal corrective: contrast bump + gentle S-curve. No hue shifts.
- **`none`** — straight copy. Default when the user hasn't asked.

For anything else — portraiture, nature, product, music video, documentary — invent your own chain. `grade.py --filter '<raw ffmpeg>'` accepts any filter string.

Hard rules: apply **per-segment during extraction** (not post-concat, which re-encodes twice). Never go aggressive without testing skin tones.

## Subtitles (when requested)

**Delivery mode — `render.py --subs-mode {burn|sidecar|off}`:**
- `burn` — captions baked into the picture via the ffmpeg `subtitles` filter (needs libass).
- `sidecar` — build `master.srt` and drop it NEXT TO the output (`<output>.srt`), NOT burned.
- `off` — nothing. (Legacy `--build-subtitles` = burn, `--no-subtitles` = off; `--subs-mode` overrides.)
If `burn` is asked but this ffmpeg lacks the `subtitles` filter (no libass), render.py degrades to a
sidecar `.srt` rather than crashing.

**record-studio per-format policy (the user's preference):**
- **16:9 `final.mp4` (YouTube): NEVER burn.** Render with `--subs-mode sidecar` → `final.srt` beside the
  mp4. The user does NOT want baked-in captions on long-form.
- **9:16 `final_9x16.mp4` (Shorts/Reels/TikTok): BURN Hormozi captions.** This box has no libass, so burn
  them as a **transparent HyperFrames caption overlay** (not the ffmpeg `subtitles` filter): start from a
  `caption-*` registry example, sync each word to the Whisper WORD timestamps (scale to the real clip
  duration), place them HIGH (~55–60% down) so they sit ABOVE the bottom-center PiP camera, render to a
  transparent WebM/MOV, add it to the EDL `overlays` for the vertical canvas, and render that canvas with
  `--subs-mode off`. (Same technique avatar-muton uses on this machine.)

Subtitles have three dimensions worth reasoning about: **chunking** (1/2/3/sentence per line), **case** (UPPER/Title/Natural), and **placement** (margin from bottom). The right combo depends on content.

**Worked styles** — pick, adapt, or invent:

**`bold-overlay`** — short-form tech launch, fast-paced social. 2-word chunks, UPPERCASE, break on punctuation, Helvetica 18 Bold, white-on-outline, `MarginV=35`. `render.py` ships with this as `SUB_FORCE_STYLE`.

```
FontName=Helvetica,FontSize=18,Bold=1,
PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000,
BorderStyle=1,Outline=2,Shadow=0,
Alignment=2,MarginV=35
```

**`natural-sentence`** (if you invent this mode) — narrative, documentary, education. 4–7 word chunks, sentence case, break on natural pauses, `MarginV=60–80`, larger font for readability, slightly wider max-width. No shipped force_style — design one if you need it.

Invent a third style if neither fits. Hard rules: subtitles LAST (Rule 1), output-timeline offsets (Rule 5).

## Animations (when requested)

Animations match the content and the brand. **Get the palette, font, and visual language from the conversation** — never assume a default. If the user hasn't told you, propose a palette in the strategy phase and wait for confirmation before building anything.

**Tool options:**

Pick the engine per animation slot. Do not default to Remotion just because the animation is web-adjacent.

- **HyperFrames** — Browser-native HTML/CSS/GSAP video compositions: product UI motion, website-to-video or mockup-to-video captures, kinetic typography, landing-page/storyboard promos, data-driven UI states, transparent WebM overlays, and clips that need deterministic frame capture plus HyperFrames lint/validate/render checks. Best when the animation should be authored and verified like a web composition instead of a React component tree.
- **Remotion** — React/CSS compositions with component state, reusable React primitives, or an existing Remotion brand system. Best when the user specifically asks for React/Remotion or when React composition is the simpler authoring model.
- **Manim** — formal diagrams, state machines, equation derivations, graph morphs. Read `skills/manim-video/SKILL.md` and its references for depth.
- **PIL + PNG sequence + ffmpeg** — simple overlay cards: counters, typewriter text, single bar reveals, progressive draws. Fast to iterate, any aesthetic you want. The launch video used this.

For HyperFrames slots, scaffold the slot inside `edit/animations/slot_<id>/` with `npx --yes hyperframes init . --example blank --non-interactive --skip-skills`, build the HTML composition there, run the HyperFrames checks that fit the slot (`lint`, `validate`, and a draft render when practical), then produce the final overlay video with `npx --yes hyperframes render . -o render.mp4` or `--format webm -o render.webm` when alpha is required. Point the EDL overlay `file` at the actual rendered path.

For Remotion slots, keep the Remotion project isolated inside the same slot directory, scaffold with `npx create-video@latest` or install Remotion locally there, render the composition to `render.mp4` with the project-local `remotion render` command, and verify duration and dimensions with `ffprobe`.

None is mandatory. Invent hybrids if useful (e.g., PIL background with a HyperFrames or Remotion layer on top).

**Duration rules of thumb, context-dependent:**

- **Sync-to-narration explanations.** A viewer needs to parse the content at 1×. Rough floor 3s, typical 5–7s for simple cards, 8–14s for complex diagrams. The launch video shipped at 5–7s per simple card.
- **Beat-synced accents** (music video, fast montage). 0.5–2s is fine — they're visual accents, not information. The "readable at 1×" rule becomes *"recognizable at 1×"*, not *"fully parseable."*
- **Hold the final frame ≥ 1s** before the cut (universal).
- **Over voiceover:** total duration ≥ `narration_length + 1s` (universal).
- **Never parallel-reveal independent elements** — the eye can't track two new things at once. One thing, pause, next thing.

**Animation payoff timing (rule for sync-to-narration):** get the payoff word's timestamp. Start the overlay `reveal_duration` seconds earlier so the landing frame coincides with the spoken payoff word. Without this sync the animation feels disconnected.

**Easing** (universal — never `linear`, it looks robotic):

```python
def ease_out_cubic(t):    return 1 - (1 - t) ** 3
def ease_in_out_cubic(t):
    if t < 0.5: return 4 * t ** 3
    return 1 - (-2 * t + 2) ** 3 / 2
```

`ease_out_cubic` for single reveals (slow landing). `ease_in_out_cubic` for continuous draws.

**Typing text anchor trick:** center on the FULL string's width, not the partial-string width — otherwise text slides left during reveal.

**Example palette** (the launch video — one aesthetic among infinite):
- Background `(10, 10, 10)` near-black
- Accent `#FF5A00` / `(255, 90, 0)` orange
- Labels `(110, 110, 110)` dim gray
- Font: Menlo Bold at `/System/Library/Fonts/Menlo.ttc` (index 1)
- ≤ 2 accent colors, ~40% empty space, minimal chrome
- Result: terminal / retro tech feel

This is one style. If the brand is warm and serif, use that. If it's colorful and playful, use that. If the user handed you a style guide, follow it. If they didn't, propose one and confirm.

**Parallel sub-agent brief** — each animation is one sub-agent spawned via the `Agent` tool. Each prompt is self-contained (sub-agents have no parent context). Include:

1. One-sentence goal: *"Build ONE animation: [spec]. Nothing else."*
2. Absolute output path (`<edit>/animations/slot_<id>/render.mp4`)
3. Exact technical spec: resolution, fps, codec, pix_fmt, CRF, duration
4. Style palette as concrete values (RGB tuples, hex, or reference to a design system)
5. Font path with index
6. Frame-by-frame timeline (what happens when, with easing)
7. Anti-list ("no chrome, no extras, no titles unless specified")
8. Code pattern reference (copy helpers inline, don't import across slots)
9. Deliverable checklist (script, render, verify duration via ffprobe, report)
10. **"Do not ask questions. If anything is ambiguous, pick the most obvious interpretation and proceed."**

One sub-agent = one file (unique filenames, parallel agents don't overwrite each other).

## Output spec

Match the source unless the user asked for something specific. Common targets: `1920×1080@24` cinematic, `1920×1080@30` screen content, `1080×1920@30` vertical social, `3840×2160@24` 4K cinema, `1080×1080@30` square. `render.py` defaults the scale to 1080p from any source; pass `--filter` or edit the extract command for other targets. Worth asking the user which delivery format matters.

## EDL format

```json
{
  "version": 1,
  "sources": {"C0103": "/abs/path/C0103.MP4", "C0108": "/abs/path/C0108.MP4"},
  "ranges": [
    {"source": "C0103", "start": 2.42, "end": 6.85,
     "beat": "HOOK", "quote": "...", "reason": "Cleanest delivery, stops before slip at 38.46."},
    {"source": "C0108", "start": 14.30, "end": 28.90,
     "beat": "SOLUTION", "quote": "...", "reason": "Only take without the false start."}
  ],
  "grade": "warm_cinematic",
  "overlays": [
    {"file": "edit/animations/slot_1/render.mp4", "start_in_output": 0.0, "duration": 5.0}
  ],
  "subtitles": "edit/master.srt",
  "total_duration_s": 87.4
}
```

`grade` is a preset name or raw ffmpeg filter. `overlays` are rendered animation clips. `subtitles` is optional and applied LAST.

## Multicam (screen + webcam, one synced timeline)

When the source is a **record-studio** project (a `screen.webm` + `webcam.webm`
pair that cover the *same* timeline, plus `sync.json`), use **multicam mode**.
Here you are not picking the best take of a beat — you are choosing, second by
second from the transcript, **which shot to show**:

- `fullcam` — webcam fills the frame (talking to camera, hooks, reactions).
- `fullscreen` — screen fills the frame (demoing, code, the thing itself).
- `pip` — screen base + webcam inset in a corner (narrating over a demo).

**The audio is continuous** — always the webcam mic (`audio_source`) across the
whole timeline. Only the picture cuts. So a multicam range carries a `layout`
instead of a `source`, and `start`/`end` are positions on the shared recording
timeline (the cam clock). Pick shot changes editorially: cut to `fullcam` when
they address the viewer, `fullscreen` when the screen is the point, `pip` when
they talk *over* the screen. Same cut craft as always (word boundaries, padding,
silences). Subtitles, overlays (HyperFrames intros / lower-thirds) and grade
work exactly as in single-source mode.

Multicam EDL:

```json
{
  "version": 1,
  "multicam": true,
  "sources": { "screen": "screen.webm", "cam": "webcam.webm" },
  "audio_source": "cam",
  "sync": { "offset_ms": 38 },
  "output": { "width": 1920, "height": 1080 },
  "ranges": [
    {"start": 0.0,  "end": 6.2,  "layout": "fullcam",  "beat": "HOOK"},
    {"start": 6.2,  "end": 40.0, "layout": "pip",
     "pip": {"corner": "br", "scale": 0.26, "margin": 40}, "beat": "DEMO"},
    {"start": 40.0, "end": 52.0, "layout": "fullscreen", "beat": "DETAIL"}
  ],
  "grade": "auto",
  "overlays": [],
  "subtitles": "edit/master.srt"
}
```

`sync.offset_ms` = `cam_start - screen_start` (from `sync.json`); `render.py`
aligns the screen track by that amount. `pip.corner` ∈
`br|bl|tr|tl|bc|tc|cl|cr|c` (corners + bottom/top-center, left/right-center, center),
`pip.scale` is the inset width as a fraction of the canvas, `pip.margin` is the
edge padding in px. Set a top-level `screen_crop` like `{"top": 0.04}` to crop a strip off the TOP of the
screen track before scaling (fraction of height, 0–0.2) — use it to remove the macOS
menu bar (clock/apps); it applies to `fullscreen` and `pip` layouts, not `fullcam`.
`output` defaults to 1920×1080 — set it to `1080×1920` for
vertical/shorts. For a project with multiple recorded clips, lay the clips end
to end on the timeline (one EDL per clip rendered then concatenated, or shift
each clip's ranges by the running offset). `render.py` auto-detects multicam
from `multicam: true` or any range having a `layout`. Everything else
(per-segment extract → concat → overlays → subtitles LAST → loudnorm)
is unchanged.

**Montage continuity — SMOOTH, not choppy (record-studio; the user dislikes hard framing cuts).**
Copy avatar-muton's feel: keep the camera in a `pip` over the screen while demoing (both visible), and
reserve full shots for real beats. Three engine features (all in `render.py`) make it flow:
- **Punch-in zoom is ON by default** on `fullcam`, `fullscreen` AND the `pip` camera inset — no shot is
  ever static. Override per range with `"zoom": [1.0, 1.06]` (fullcam/fullscreen) or
  `"pip": {"zoom": [1.0, 1.05]}` for the inset. Disable globally with `--no-punch`.
- **Crossfades between segments** (not jump cuts). Per range: `"transition"` ∈
  `fade|slide|dissolve|wipe|cut` (default `fade`) and `"transition_after_sec"` (default `0.4`), read off
  the LEFT range of each boundary. Use `"cut"` (≈2 frames) ONLY at a genuine block change. Subtitles,
  overlays and SFX stay locked to the picture — `render.py` remaps their times for the overlap. Disable
  with `--no-xfade` (falls back to lossless hard concat).
- **Vary the camera** across the video and per video: change `pip.corner` and `pip.scale` (small ~0.24 →
  a big ~0.5 "side" look) so it's never the same corner; don't repeat the previous video's pattern.

**Deliver BOTH aspects by default (record-studio).** A record-studio video should ship in
1920×1080 (`final.mp4`, YouTube) AND 1080×1920 (`final_9x16.mp4`, Shorts/Reels/TikTok) — same edit,
two canvases, like avatar-muton's `both` mode. You don't re-decide shots: render each EDL once per
canvas (set `output` to each size). When the canvas is **portrait (H > W)**, `render.py` auto-reframes
so it looks intentional, not letterboxed: `fullcam` fills the frame (cover/center-crop), `fullscreen`
and `pip` put the contained screen over a **strongly blurred, dimmed cover of itself** (reels-style
depth of field) instead of black bars, the cam PiP is enlarged (≥0.34), and captions ride high above
the platform UI. Render any HyperFrames graphic at BOTH output sizes so each cut-in segment matches
its canvas. (`render_patched.py` in a project's `edit/` also accepts `--canvas 1080x1920` to render the
same EDL vertical without editing it.)

**Graphics in a multicam edit — use the `graphic` layout (NEVER a silent clip):** add a range with
`{"layout": "graphic", "graphic_file": "animations/slot_N/render.mp4"}`. render.py shows the card
full-frame (crossfaded in/out) BUT keeps the **continuous webcam voice** under it for that `[start,end]`
window — so the voice never goes silent, only the picture switches to the graphic and back. Do NOT render a
graphic as a standalone clip and concat it (that segment would be silent) and do NOT float it as an
`overlays`-on-top composite (looks off over a shared-screen demo). Reserve `overlays` for things meant
to truly sit on top (lower-thirds, captions). In portrait the card is blurred-filled to the canvas.

**Graphics cadence & content (record-studio talking-head):**
- **Browse the predefined HyperFrames examples and use the GOOD-LOOKING ones** — don't default to
  `blank`. List them with `hyperframes init --example <name>` (registry includes `warm-grain`,
  `swiss-grid`, `kinetic-type`, `product-promo`, `logo-outro`, `caption-*`, `lt-*` lower-thirds,
  `transitions-*`, `vfx-*`, `code-snippet-*`, `app-showcase`, …). Pick the example that fits the beat,
  then fill its text from the transcript.
- **First graphic within the first ~5s** of the video (hook title card).
- **A graphic COVERS ITS WHOLE NARRATION** (the fix for "graphics that flash by"): its `[start,end]`
  spans the ENTIRE sentence/idea it illustrates (start ~0.4s before the payoff word, end after the
  sentence finishes) — never a 1–2s flash. Change graphic when the CONTENT changes (a new point), not on
  a fixed every-few-seconds timer.
- **Sync the animation to the voice**: pull the clip's Whisper word timestamps and animate each element
  in (bullet, number, chip, badge) exactly when its word is spoken; scale transcript times to the real
  clip duration; a count-up/reveal LANDS on the spoken payoff word (start it `reveal_duration` earlier).
- **Each graphic still reads**: ≥ ~3–4s and ≥ (its narration + 1s); hold the final frame ≥1s. The voice
  plays under it, and `render.py` now crossfades it in/out (softer than the old hard cut-in).

**Subtitle position:** `render.py` lowers the caption margin automatically on horizontal (16:9) output
so captions don't cover the speaker's mouth, while keeping the high safe-zone margin on vertical
(Shorts/Reels). Override per-render with the EDL's `subtitle_margin` if needed.

## Sound effects (SFX) — when requested

Timed SFX make an edit feel pro: a whoosh on a shot change/crossfade, a pop/ding when a graphic element
or a key word lands, a riser into a reveal, "cash/coins" when money is said, a chime on a notification.

**Place SFX ON THE WORD.** Pick moments from the transcript's Whisper WORD timestamps (not vibes):
fire each SFX exactly when its trigger word is spoken, plus one on each shot-change/crossfade. A few
well-placed beats a constant stream; SFX sit UNDER the voice (`gain_db` ~ -10..-16).

**Fetch FRESH sounds per video** (`edit/sfx/`) — don't recycle the same handful every time:
- **HeyGen sounds library (preferred — real, professionally-made sounds).** For each moment write a
  SPECIFIC query and take the best-scoring match.
  `GET ${HEYGEN_API_BASE:-https://api.heygen.com}/v3/audio/sounds?type=sound_effects&query=<e.g. "punchy whoosh transition">`
  with header `x-api-key: $HEYGEN_API_KEY`. In record-studio these vars are in the ENVIRONMENT (injected
  by the app); elsewhere read them from `.env`. Download the pre-signed WAV (short-lived) into
  `edit/sfx/`. Do NOT generate sounds when HeyGen is available.
- **ElevenLabs text-to-SFX** (fallback only) — `POST https://api.elevenlabs.io/v1/sound-generation`,
  header `xi-api-key: $ELEVENLABS_API_KEY`, JSON `{"text": "<describe>", "duration_seconds": 0.5-3}`.

Then add an `sfx` array to the EDL — `render.py` mixes each one in at its exact time:

```json
"sfx": [
  {"file": "sfx/whoosh.wav", "at": 5.63, "gain_db": -12},
  {"file": "sfx/pop.wav",    "at": 6.10, "gain_db": -14}
]
```

`at` is the OUTPUT-timeline time in seconds (same clock as overlays' `start_in_output`). `gain_db`
trims level (negative = quieter). render.py delays each SFX to land on the frame, amix'es it over the
voice with a limiter, then loudnorm runs. In the self-eval pass, check each SFX hits ON its word.

**Background music — decide PER VIDEO.** For energetic pieces (promo/story/hook), search
`type=music` (same endpoint), download to `edit/music/`, and set the EDL top-level
`"music": {"file": "music/<name>.wav", "volume_db": -22}` — `render.py` loops it and **ducks it under
your voice** (sidechaincompress) automatically. For tutorials/demos where music fights the explanation,
use SFX ONLY (omit `music`).

## Memory — `project.md`

Append one section per session at `<edit>/project.md`:

```markdown
## Session N — YYYY-MM-DD

**Strategy:** one paragraph describing the approach
**Decisions:** take choices, cuts, grades, animations + why
**Reasoning log:** one-line rationale for non-obvious decisions
**Outstanding:** deferred items
```

On startup, read `project.md` if it exists and summarize the last session in one sentence before asking whether to continue.

## Anti-patterns

Things that consistently fail regardless of style:

- **Hierarchical pre-computed codec formats** with USABILITY / tone tags / shot layers. Over-engineering. Derive from the transcript at decision time.
- **Hand-tuned moment-scoring functions.** The LLM picks better than any heuristic you'll write.
- **Whisper SRT / phrase-level output.** Loses sub-second gap data. Always word-level verbatim.
- **Re-transcribing on every run.** Whisper isn't free in wall-time — cache per source and never re-transcribe unless the source changed. (Whisper is the default engine; it normalizes some fillers and has no diarization — accept that for free/offline, or switch to Scribe when those matter.)
- **Burning subtitles into base before compositing overlays.** Overlays hide them. (Hard Rule 1.)
- **Single-pass filtergraph when you have overlays.** Double re-encodes. Use per-segment extract → concat.
- **Linear animation easing.** Looks robotic. Always cubic.
- **Hard audio cuts at segment boundaries.** Audible pops. (Hard Rule 3.)
- **Typing text centered on the partial string.** Text slides left as it grows.
- **Sequential sub-agents for multiple animations.** Always parallel.
- **Editing before confirming the strategy.** Never.
- **Re-transcribing cached sources.** Immutable outputs of immutable inputs.
- **Assuming what kind of video it is.** Look first, ask second, edit last.
