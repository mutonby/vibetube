'use strict'

// Constructores de prompts para los agentes headless (montaje, iteración,
// perfil de estilo y guiones). Funciones puras: entran opciones, sale texto.

const DEFAULT_OPTS = { aspect: 'both', subtitles: true, model: 'medium', pip: 'br', tone: '', cropMenubar: false, sfx: true, voiceEnhance: true }


// Normalize the aspect knob: anything that isn't an explicit single format means both.
function normAspect(opts) {
  const a = opts && opts.aspect
  return a === '16:9' || a === '9:16' ? a : 'both'
}
// Human list of the requested output file(s), for the prompt goal lines.
function aspectGoal(opts) {
  const a = normAspect(opts)
  if (a === '16:9') return '`edit/final.mp4` (16:9, 1920x1080)'
  if (a === '9:16') return '`edit/final_9x16.mp4` (9:16, 1080x1920)'
  return 'BOTH `edit/final.mp4` (16:9, 1920x1080) AND `edit/final_9x16.mp4` (9:16, 1080x1920)'
}

function optsLines(opts) {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) }
  const aspect = normAspect(o)
  const aspectBlock = {
    'both': [
      '- Deliver BOTH resolutions (like avatar-muton does): `edit/final.mp4` in 1920x1080 (horizontal,',
      '  YouTube) AND `edit/final_9x16.mp4` in 1080x1920 (vertical, Shorts/Reels/TikTok). Same edit,',
      '  two canvases. render.py auto-reframes multicam for vertical: `fullcam` fills the frame, screen',
      '  segments (`fullscreen`/`pip`) get a blurred-fill background instead of black bars with a larger',
      '  cam PiP, and captions ride high above the Shorts/Reels UI — you just set the EDL "output" to',
      '  each size and render twice. Render any HyperFrames graphic at BOTH output sizes so the cut-in',
      '  segment matches each canvas.',
    ].join('\n'),
    '16:9': [
      '- Deliver ONLY `edit/final.mp4` in 1920x1080 (16:9 horizontal, YouTube). The user did NOT ask',
      '  for a vertical version this time — do NOT render `final_9x16.mp4`. Render HyperFrames graphics',
      '  at 1920x1080 only.',
    ].join('\n'),
    '9:16': [
      '- Deliver ONLY `edit/final_9x16.mp4` in 1080x1920 (9:16 vertical, Shorts/Reels/TikTok). The user',
      '  did NOT ask for a horizontal version this time — do NOT render `final.mp4`. render.py',
      '  auto-reframes multicam for vertical: `fullcam` fills the frame, screen segments',
      '  (`fullscreen`/`pip`) get a blurred-fill background, and captions ride high above the',
      '  Shorts/Reels UI. Render HyperFrames graphics at 1080x1920 only.',
    ].join('\n'),
  }[aspect]
  const subs169 = [
    '  * 16:9 `final.mp4` (YouTube): DO NOT burn subtitles into the picture. Render it with',
    '    `helpers/render.py … --subs-mode sidecar` so a `final.srt` is written NEXT TO the mp4 (a file,',
    '    not baked-in text). That is all YouTube needs.',
  ]
  const subs916 = [
    '  * 9:16 `final_9x16.mp4` (Shorts/Reels/TikTok): BURN Hormozi-style captions (big UPPERCASE words,',
    '    the ACTIVE word highlighted in an accent color, animated pop). Place them HIGH (~55-60% down the',
    '    frame) so they sit ABOVE the bottom-center PiP camera, never over the mouth. Build them as a',
    '    TRANSPARENT HyperFrames overlay synced to the Whisper WORD timestamps (start from a `caption-*`',
    '    registry example; scale word times to the real clip duration), render it to a transparent',
    '    WebM/MOV, add it to the EDL `overlays` for the VERTICAL render only, and render that canvas with',
    '    `--subs-mode off` (the captions come from the overlay, so ffmpeg must not also burn an SRT).',
    '    (This machine\'s ffmpeg has no libass, so the `subtitles` filter is unavailable — the HyperFrames',
    '    overlay is how you burn captions here; do NOT rely on `--subs-mode burn`.)',
  ]
  return [
    aspectBlock,
    o.subtitles ? [
      '- SUBTITLES — DIFFERENT PER FORMAT (user preference, important):',
      ...(aspect !== '9:16' ? subs169 : []),
      ...(aspect !== '16:9' ? subs916 : []),
    ].join('\n') : '- SUBTITLES: OFF — render with `--subs-mode off` and add no caption overlay.',
    `- Transcription: run \`helpers/transcribe_whisper.py --model ${o.model}\` on each clip's webcam.webm. Do NOT use ElevenLabs.`,
    `- Default PiP corner: ${o.pip}.`,
    o.cropMenubar ? [
      '- Remove the macOS menu bar from the screen track: set the EDL top-level `screen_crop` to',
      '  {"top": 0.04} as a STARTING point. Then VERIFY and ADJUST: after rendering, extract a frame from a',
      '  `fullscreen` or `pip` moment (`ffmpeg -ss <t> -i edit/final.mp4 -frames:v 1 /tmp/chk.png`) and LOOK',
      '  at the image (read the PNG). The macOS menu bar (the top strip with the clock and app menus) must be',
      '  FULLY gone, WITHOUT cropping real content. If a sliver of the bar still shows, increase',
      '  `screen_crop.top` (try 0.05, 0.06, up to ~0.08 on notch MacBooks) and re-render; if it ate into the',
      '  actual content, decrease it. Iterate until the bar is gone and the content is intact.',
    ].join('\n') : null,
    o.sfx ? [
      '- SOUND from the HeyGen library — FRESH per video, timed to the WORDS (like avatar-muton):',
      '  * The key is already in your ENVIRONMENT: `HEYGEN_API_KEY` (+ optional `HEYGEN_API_BASE`, default',
      '    https://api.heygen.com). Do NOT look for it in a .env; read it from the env. Query the library with',
      '    a SPECIFIC natural-language description and take the top-scoring match:',
      '      `GET $HEYGEN_API_BASE/v3/audio/sounds?type=sound_effects&query=<e.g. "punchy whoosh transition">`',
      '      header `x-api-key: $HEYGEN_API_KEY`. Download the pre-signed WAV into edit/sfx/.',
      '  * PICK NEW, DIFFERENT sounds for THIS video (do not recycle the same handful every time) — search',
      '    fresh queries that fit THIS content. Do NOT generate; these are professionally made.',
      '  * PLACE THEM ON THE WORD: use the Whisper word timestamps to fire each SFX exactly when the trigger',
      '    word is spoken (whoosh ON each shot change/transition, a pop/ding when a graphic element or key word',
      '    lands, a riser INTO a reveal, "cash/coins" when money is said, a chime on a notification). Add an',
      '    `sfx` array to the EDL: each {file, at (output-timeline seconds), gain_db (negative, sits UNDER the',
      '    voice, ~-10..-16)}. A FEW well-placed beats loud and constant.',
      '  * BACKGROUND MUSIC — decide PER VIDEO: if the piece wants energy (promo/story/hook), search',
      '    `type=music` for a fitting track, download to edit/music/, and set the EDL top-level',
      '    `music: {"file": "music/<name>.wav", "volume_db": -22}` (render.py ducks it under your voice',
      '    automatically). For tutorials/demos where music would fight the explanation, use SFX ONLY (no music).',
      '  * In the self-eval, confirm each SFX hits ON its word and adjust `at` if early/late.',
      '  (Only if HeyGen is unreachable, fall back to ElevenLabs `POST /v1/sound-generation` for SFX.)',
    ].join('\n') : null,
    o.voiceEnhance !== false ? [
      '- AUDIO ENHANCEMENT — NVIDIA STUDIO VOICE NIM (48k-hq):',
      '  * The voice track of each clip is enhanced using NVIDIA Studio Voice NIM (`48k-hq`).',
      '  * In your montage workflow, check `clips/clip_NN/webcam_enhanced.wav` or run',
      '    `python helpers/enhance_voice.py --all` before mixing SFX and music to ensure every clip has',
      '    clean studio-quality audio with background noise and room reverb removed.',
      '  * Always keep voice enhancement on the raw voice track BEFORE sound effects and music: never run',
      '    enhancement on an already-mixed track with SFX, as the model will suppress sound effects as noise.',
    ].join('\n') : null,
    o.tone && o.tone.trim() ? `- Editing direction from the user: ${o.tone.trim()}` : null,
  ].filter(Boolean)
}

function composePrompt(opts, ctx = {}) {
  return [
    ctx.skillContext || '',
    'You are running NON-INTERACTIVELY (headless). Use the **video-use** skill to edit the',
    'multicam screen-recording project in the current directory into one finished video.',
    '',
    'This is a record-studio project. Clips live in `clips/clip_NN/` and each clip has two',
    'SYNCHRONIZED tracks on one timeline: `screen.webm` (no audio) and `webcam.webm` (carries',
    'the mic — the only audio). `sync.json` has `offset_ms`. Use the skill\'s MULTICAM mode.',
    '',
    'MONTAGE STYLE — smooth & alive, NOT choppy (copy avatar-muton, which the user loves):',
    '  - The user DISLIKES hard "multicam" framing cuts. Favor CONTINUITY: keep the camera in a PiP over',
    '    the screen while demoing (both visible), and reserve full shots for real beats. Use `fullcam` only',
    '    when talking straight to the viewer (hook/CTA), `fullscreen` for a pure screen moment.',
    '  - NEVER let a shot sit static: a slow PUNCH-IN ZOOM is ON by default (render.py) on fullcam,',
    '    fullscreen AND the PiP camera — the camera is always gently moving. You may set a range\'s',
    '    `"zoom":[1.0,1.06]` (or `"pip":{"zoom":[1.0,1.05]}`) to punch harder on an emphasis beat.',
    '  - TRANSITIONS ARE CROSSFADES, not jump cuts: every range may carry `"transition":"fade"` (also',
    '    "dissolve"/"slide") and `"transition_after_sec":0.4`. Use a hard `"transition":"cut"` ONLY at a',
    '    genuine block change. Put a whoosh SFX on the bigger transitions (see SFX).',
    '  - VARY THE CAMERA across the video, and use a DIFFERENT pattern each video: change the PiP',
    '    `"pip":{"corner": …}` among `br/bl/tr/tl/bc/tc/cl/cr` and its `"scale"` (small ~0.24 up to a big',
    '    ~0.5 "side" look) so it is not always the same corner. Do not repeat the previous video\'s plan.',
    '',
    'OPTIONS:',
    ...optsLines(opts),
    '',
    `Do the FULL pipeline and WRITE ${aspectGoal(opts)}:`,
    '  1. transcribe each clip (Whisper) → pack → read the transcript',
    '  2. decide shots editorially and build a multicam EDL per clip',
    '  3. render each clip with `helpers/render.py` and concatenate them in clip order — once per',
    '     REQUESTED canvas (see OPTIONS: output 1920x1080 → final.mp4, output 1080x1920 → final_9x16.mp4)',
    '  4. ADD GRAPHICS with HyperFrames, generously, using the `graphic` LAYOUT (see rules below).',
    '',
    'GRAPHICS — dynamic like a pro edit, but SYNCED TO THE SCRIPT (this is what was wrong before):',
    '  - Use the PREDEFINED HyperFrames examples and pick the GOOD-LOOKING ones — do NOT default to',
    '    `blank`. List them with `hyperframes init --example <name>` (registry has warm-grain, swiss-grid,',
    '    kinetic-type, product-promo, logo-outro, caption-*, lt-* lower-thirds, transitions-*, vfx-*,',
    '    code-snippet-*, app-showcase, …). Choose the example that fits each beat, then fill its text from',
    '    the transcript.',
    '  - PUT THE FIRST GRAPHIC within the first ~5 SECONDS of the video (a hook/title card).',
    '  - A GRAPHIC COVERS ITS WHOLE NARRATION — this is the key fix. Its EDL range [start,end] must span the',
    '    ENTIRE sentence/idea it illustrates (start ~0.4s before the payoff word, end after the sentence',
    '    finishes), NEVER a 1-2s flash. Change graphic when the CONTENT changes (a new point), not on a fixed',
    '    every-few-seconds timer.',
    '  - SYNC THE ANIMATION TO THE VOICE: get the clip\'s Whisper word timestamps; each element inside the',
    '    graphic (bullet, number, chip, badge) should ANIMATE IN exactly when its word is spoken. Scale TTS/',
    '    transcript times to the real clip duration. A count-up/reveal should LAND on the spoken payoff word',
    '    (start it `reveal_duration` earlier). A graphic that ignores the word timing feels disconnected.',
    '  - Insert each graphic as an EDL range with {"layout":"graphic","graphic_file":"animations/slot_N/render.mp4"}.',
    '    render.py shows it FULL-FRAME BUT keeps YOUR VOICE (the webcam mic) playing under it, and now',
    '    CROSSFADES in/out (softer than the old hard cut-in). NEVER a silent/standalone clip — the voice must',
    '    always be heard. Do NOT overlay graphics on top of the live demo.',
    '  - Minimum readable: at least ~3-4s AND at least (its narration +1s); hold the final frame ~1s.',
    '  - Render every HyperFrames graphic at every REQUESTED output size (see OPTIONS) so the segment matches each canvas.',
    '',
    'Subtitles follow the per-format policy in OPTIONS.',
    '',
    ...scriptContextLines(ctx),
    'Because this is headless, DO NOT ask for confirmation and DO NOT stop to discuss strategy —',
    `pick sensible defaults and proceed. Keep going until ${aspectGoal(opts)} exists.`,
  ].join('\n')
}

// The montage brief written as the project's CLAUDE.md, so the INTERACTIVE
// terminal session auto-loads it and "knows everything" about how to edit this
// record-studio project. Reuses optsLines() (the same knobs as headless compose).
// The video-use SKILL.md (globally linked) carries the full craft; this file is
// the project-specific orchestration on top of it.
function montageBrief(opts) {
  return [
    '# Montar el vídeo de este proyecto (record-studio)',
    '',
    'Eres el **editor de vídeo** de este proyecto. Usa la skill **video-use** para montar los clips',
    'grabados en el vídeo final. Sigue el CRAFT completo de `video-use/SKILL.md` (continuidad multicam,',
    'zoom, crossfades, cámara variada, gráficos sincronizados a las palabras, SFX/música de HeyGen,',
    'subtítulos por formato) — aquí va SOLO lo específico de este proyecto.',
    '',
    'ESTRUCTURA: los clips están en `clips/clip_NN/` y cada uno tiene dos pistas SINCRONIZADAS en una',
    'misma línea de tiempo: `screen.webm` (sin audio) y `webcam.webm` (lleva el micro — el único audio).',
    '`sync.json` tiene `offset_ms`. Usa el modo MULTICAM de la skill (layouts `fullcam`/`fullscreen`/',
    '`pip`/`graphic` en la EDL, renderizando con `helpers/render.py`).',
    '',
    `OBJETIVO: generar ${aspectGoal(opts)} — mismo montaje, un render por lienzo pedido (cambia el \`output\` de la EDL).`,
    '',
    'OPCIONES DE ESTE PROYECTO:',
    ...optsLines(opts),
    '',
    'ESTILO (resumen — el detalle está en video-use/SKILL.md):',
    '- Montaje SUAVE, no choppy: cámara en PiP sobre la pantalla, **zoom lento siempre**, **crossfades**',
    '  entre planos (corte duro solo en cambios de bloque). Varía la posición/tamaño del PiP.',
    '- Gráficos HyperFrames que **cubren toda su narración** y con elementos animados **a la palabra**',
    '  (word-timestamps de Whisper). Primer gráfico en los ~5s.',
    '- SFX/música **nuevos por vídeo** de la librería de HeyGen, colocados en la palabra exacta.',
    '- Subtítulos: 16:9 → `.srt` al lado (NO quemados); 9:16 → quemados estilo Hormozi (overlay de',
    '  HyperFrames sincronizado a palabras, arriba, sobre la cámara).',
    '- Voz con calidad de estudio: mejora con NVIDIA Studio Voice NIM (`48k-hq`) en los clips antes de mezclar SFX.',
    '',
    'Las API keys (`HEYGEN_API_KEY`, `NVIDIA_API_KEY`) están en tu ENTORNO — úsalas para sonidos y mejora de voz.',
    'Todo en ESPAÑOL con el usuario.',
  ].join('\n')
}
function iteratePrompt(feedback, opts, ctx = {}) {
  return [
    ctx.skillContext || '',
    'You are running NON-INTERACTIVELY (headless). This record-studio project already has an',
    'edit at `edit/final.mp4` (and likely cached transcripts in `edit/transcripts/` and EDLs in',
    '`edit/`). Use the **video-use** skill in ITERATE mode: apply the user\'s feedback and',
    're-render, REUSING cached transcripts (never re-transcribe unless a source changed).',
    '',
    'USER FEEDBACK (apply this): ' + JSON.stringify(feedback || ''),
    '',
    'OPTIONS still apply:',
    ...optsLines(opts),
    '',
    'Keep the SMOOTH montage style: PiP base with a slow punch-in zoom, CROSSFADES between shots (not',
    'hard cuts — the user dislikes framing cuts), varied PiP position/size, graphics that span their whole',
    'narration with elements synced to the spoken words, and fresh HeyGen SFX/music timed to the words.',
    ...scriptContextLines(ctx),
    `Re-render ${aspectGoal(opts)}.`,
    'Do NOT ask for confirmation. Keep going until the updated final(s) exist.',
  ].join('\n')
}

// Si el proyecto se grabó con un guion (project/script.md), el editor lo usa para
// subtítulos (nombres propios), elegir gráficos por sección y detectar tomas repetidas.
function scriptContextLines(ctx) {
  if (!ctx || !ctx.hasScript) return []
  return [
    'SCRIPT AWARENESS: this project was recorded from a written script at `script.md` (same dir).',
    '  - READ IT FIRST. Use it to fix Whisper misspellings of proper nouns/product names in the',
    '    subtitles, to pick a graphic per section (labels in UPPERCASE like GANCHO / DESARROLLO / CIERRE),',
    '    and to place the first graphic on the hook.',
    '  - Lines like `[PANTALLA: …]` mean "show the screen recording here", `[GRÁFICO: …]` mean "cut to',
    '    a HyperFrames graphic about …", `[CÁMARA]` means full camera. Honor them as editorial intent.',
    '  - If the transcript repeats a sentence (a re-take), keep the LAST clean take and cut the others.',
    '',
  ]
}

// ---- Prompts de guiones (aprender la voz del usuario y escribir en ella) ----

function analyzePrompt(channel, { incremental = false } = {}) {
  return [
    'You are running NON-INTERACTIVELY (headless). GOAL: learn the user\'s personal video style',
    'from their YouTube channel so we can later write new scripts in THEIR voice.',
    '',
    `Channel: ${channel}`,
    '',
    incremental
      ? 'INCREMENTAL UPDATE: `corpus/` and `style_profile.md` ALREADY EXIST. Only fetch videos whose id is NOT already in corpus/ (check the filenames), then UPDATE style_profile.md keeping everything that is still true and adding what is new (new catchphrases, new topics, changes in hooks/CTAs). Do not rebuild from scratch.'
      : 'Fresh analysis: build corpus/ and style_profile.md from scratch.',
    '',
    'IMPORTANT: use only LONG-FORM videos, NOT Shorts (Shorts are the vertical clips ≤ 60s and live',
    'in the channel\'s /shorts tab). Use the channel\'s VIDEOS tab and skip anything under ~90s.',
    '',
    'Steps:',
    '1. With yt-dlp, list the channel\'s most recent ~15 LONG videos and fetch each TRANSCRIPT (auto-subs',
    '   are fine). Target the videos tab — if the URL is a channel/handle, append "/videos"',
    '   (e.g. https://youtube.com/@handle/videos); never use /shorts. Get the URLs, e.g.:',
    '   `yt-dlp --flat-playlist --playlist-end 30 --print "%(id)s %(duration)s %(url)s" "<channel>/videos"`',
    '   Then for each, skip it if its duration is under ~90s, and fetch the transcript for the rest until you have ~15:',
    '   `yt-dlp --skip-download --write-auto-subs --write-subs --sub-langs "es,en" --convert-subs srt -o "corpus/%(id)s.%(ext)s" "<videoUrl>"`',
    '   Then strip timestamps to plain text under corpus/ (keep the .srt too: we use its timing).',
    '2. Read the transcripts and WRITE `style_profile.md` capturing the user\'s VOICE: tone, recurring',
    '   phrases / catchphrases, vocabulary, sentence rhythm, how they HOOK at the start, how they',
    '   structure a video, how they address the audience, their typical CTAs, pacing/length. Include',
    '   CONCRETE example phrases they actually say (real quotes). Add a section "## Hooks por tipo de vídeo"',
    '   (tutorial / opinión / build in public / lanzamiento / lista) with 2 real examples each when available.',
    '3. WRITE `pace.json` with {"wpm": <words per minute measured from the .srt timings, median over the',
    '   videos>, "videos": <n>, "median_minutes": <median video length in minutes>}. This is used to size',
    '   future scripts to the user\'s real speaking pace.',
    '',
    'Write in the same language as their content (likely Spanish). Skip videos without subtitles.',
    'Do NOT ask questions. Keep going until `style_profile.md` and `pace.json` exist.',
  ].join('\n')
}

// Duración pedida → minutos (null = auto).
function durationMinutes(d) {
  if (!d) return null
  const m = /(\d+(?:[.,]\d+)?)\s*(s|seg|min|m)?/i.exec(String(d))
  if (!m) return null
  const n = parseFloat(m[1].replace(',', '.'))
  return /^s/i.test(m[2] || '') ? n / 60 : n
}

// Brief estructurado → líneas de restricciones del prompt.
function scriptOptsLines(opts, pace) {
  const o = opts || {}
  const wpm = (pace && pace.wpm) || 150
  const mins = durationMinutes(o.duration)
  const words = mins ? Math.round(mins * wpm) : null
  const lines = []
  if (words) {
    lines.push(`- LENGTH: target ~${words} words (±10%). That is ${o.duration} at the user's real pace of ~${wpm} words/min. COUNT the words before finishing and trim/extend to hit the target.`)
  } else {
    lines.push(`- LENGTH: as the style profile dictates for this kind of video (the user's median is ${pace && pace.median_minutes ? `~${pace.median_minutes} min` : 'long-form'}); speaking pace ~${wpm} words/min.`)
  }
  if (o.format) lines.push(`- Format/platform: ${o.format}.`)
  if (o.goal) lines.push(`- Video type / goal: ${o.goal}. Use the matching hook pattern from "Hooks por tipo de vídeo" in style_profile.md.`)
  if (o.cta) lines.push(`- CTA (must appear, in the user's usual way of asking): ${o.cta}`)
  if (o.demo === 'yes') lines.push('- There WILL be an on-screen demo: mark the moments to show the screen with `[PANTALLA: what is shown]` on its own line, and full-camera moments with `[CÁMARA]`. Suggest graphics with `[GRÁFICO: idea]`.')
  else if (o.demo === 'no') lines.push('- Talking-head only (no screen demo). Still suggest graphics with `[GRÁFICO: idea]` on its own line where a visual would help.')
  else lines.push('- Where a visual helps, add `[GRÁFICO: idea]` or `[PANTALLA: what to show]` on its own line (editorial markers, not spoken).')
  if (o.avoid) lines.push(`- Do NOT mention / avoid: ${o.avoid}`)
  lines.push('- Language: match the user\'s channel (Spanish if their videos are in Spanish).')
  return lines
}

// Pares (borrador del agente → versión final que el usuario grabó/guardó): la
// señal más barata para aprender cómo corrige el usuario.
function feedbackLines(pairs) {
  if (!pairs || !pairs.length) return []
  return [
    'HOW THE USER EDITS MY DRAFTS (learn from this — highest-signal voice reference):',
    'The folder `feedback/` has pairs `<id>.draft.md` (what I wrote) → `<id>.final.md` (what the user',
    `actually recorded). Read the ${Math.min(pairs.length, 3)} most recent pair(s) (${pairs.slice(0, 3).join(', ')}) and`,
    'diff them mentally: what they cut, what they rephrase, which words they never say, how long they',
    'really want it. Apply those corrections PROACTIVELY to this new script.',
    '',
  ]
}

function generatePrompt(topic, opts, draftPath, ctx = {}) {
  const o = opts || {}
  return [
    'You are running NON-INTERACTIVELY (headless). Write a NEW video script in the USER\'S OWN VOICE.',
    '',
    'CRITICAL — two SEPARATE inputs, never confuse them:',
    '  • `style_profile.md` + `corpus/` define HOW the user talks (tone, phrases, rhythm, hooks,',
    '    structure). Use them ONLY for voice/style. Do NOT borrow the topic or content of past videos.',
    '  • The TOPIC below defines WHAT this video is about. The substance comes from it.',
    '',
    'TOPIC (what the video is about):',
    `"""${topic}"""`,
    o.keyPoints ? `\nKEY POINTS the user wants covered (in this order unless a better order is obvious):\n"""${o.keyPoints}"""` : null,
    '',
    'RESEARCH FIRST (mandatory) — gather real, current facts before writing:',
    '  • If the topic contains any URL, OPEN and READ it (your web tool; for a GitHub repo read its README;',
    '    if fetching fails try `curl -sL <url>` or `gh repo view <owner/repo> --json name,description,...`).',
    '  • ALSO use web search to fill gaps and get UP-TO-DATE information: anything you are unsure',
    '    about, recent developments, context, real names/numbers/dates. Trust current web results over your',
    '    own memory (which may be outdated).',
    '  Base the script on what you ACTUALLY find: the real product name, what it really does, its real',
    '  features and how it works. NEVER invent facts and NEVER reuse an unrelated past video as if it were',
    '  this topic. If you truly cannot verify something, leave a short TODO note in the script instead of',
    '  making it up.',
    `  • WRITE the sources you used to \`${draftPath.replace(/\.md$/, '.sources.md')}\`: one line per source`,
    '    (URL or search query) followed by the concrete facts/numbers taken from it. The user checks',
    '    every figure there before recording it.',
    '',
    'Then read `style_profile.md` (skim 1-2 `corpus/` files only to copy phrasing/rhythm) and write the',
    'script ABOUT the real topic above.',
    '',
    ...feedbackLines(ctx.feedbackPairs),
    'Constraints:',
    ...scriptOptsLines(o, ctx.pace),
    '',
    'Sound like THEM (their hooks, phrases, rhythm, CTA) but about the REAL subject. Structure it for',
    'video (hook → desarrollo → cierre/CTA), ready to read aloud as a teleprompter.',
    '',
    'HOOKS: the first 10 seconds decide everything. Start the file with a section `GANCHOS` containing',
    'THREE alternative hooks (each 2-4 sentences, different angles: curiosity / pain / bold claim), each',
    'preceded by a line `OPCIÓN 1`, `OPCIÓN 2`, `OPCIÓN 3`. Then the full script starting at `GANCHO`',
    'using your favourite of the three. The user will pick one in the UI.',
    '',
    'OUTPUT FORMAT: PLAIN TEXT ONLY. No Markdown whatsoever — no asterisks (**), no #, no backticks, no',
    'bullet symbols, no bold/italics. If you label sections, put a simple UPPERCASE word on its own line',
    '(e.g. GANCHO, DESARROLLO, CIERRE) with a blank line around it. Editorial markers like',
    '`[PANTALLA: …]` / `[GRÁFICO: …]` / `[CÁMARA]` go on their own line. Just the spoken words, clean.',
    '',
    `Write ONLY the finished script to this EXACT file: ${draftPath}`,
    'Do NOT ask questions and do not write anything else.',
  ].filter((l) => l !== null).join('\n')
}

function rewritePrompt(scriptPath, feedback, opts, ctx = {}) {
  return [
    'You are running NON-INTERACTIVELY (headless). There is an existing script at:',
    `${scriptPath}`,
    '',
    'Rewrite it applying this feedback, while KEEPING the user\'s voice (see `style_profile.md`):',
    `"""${feedback}"""`,
    '',
    'Keep all facts accurate: if the script is about a product/URL, do not invent features — re-check the',
    'source (your web tool / curl / gh) and use web search for anything new or uncertain if the feedback touches',
    `the substance. Update \`${scriptPath.replace(/\.md$/, '.sources.md')}\` if you used new sources. Use the corpus only for VOICE.`,
    '',
    ...feedbackLines(ctx.feedbackPairs),
    'Constraints still apply:',
    ...scriptOptsLines(opts, ctx.pace),
    '',
    'Keep it PLAIN TEXT (no Markdown, no asterisks, no #, no backticks). Section labels, if any, are a',
    'simple UPPERCASE word on its own line. Keep the `GANCHOS` block with 3 options if it exists (rewrite',
    'them too if the feedback affects the hook). Keep editorial markers `[PANTALLA: …]` / `[GRÁFICO: …]`.',
    '',
    `Overwrite the SAME file (${scriptPath}) with the improved script. Do NOT ask questions.`,
  ].join('\n')
}

// Solo ganchos: 5 alternativas para el guion actual, sin tocar el resto.
function hooksPrompt(scriptPath, outPath, ctx = {}) {
  return [
    'You are running NON-INTERACTIVELY (headless). Read the script at:',
    `${scriptPath}`,
    'and `style_profile.md` (section about hooks). Write FIVE alternative HOOKS (first 10-15 seconds,',
    '2-4 sentences each) for THIS script, in the user\'s voice, each with a different angle: curiosity,',
    'pain/problem, bold claim or number, story/confession, contrast ("everyone does X, I do Y").',
    ...feedbackLines(ctx.feedbackPairs),
    'PLAIN TEXT: each hook preceded by a line `OPCIÓN n`, blank line between. No Markdown.',
    `Write ONLY that to: ${outPath}. Do NOT ask questions.`,
  ].join('\n')
}

module.exports = {
  DEFAULT_OPTS, normAspect, aspectGoal, optsLines, composePrompt, montageBrief, iteratePrompt,
  scriptContextLines, analyzePrompt, durationMinutes, scriptOptsLines, feedbackLines,
  generatePrompt, rewritePrompt, hooksPrompt,
}
