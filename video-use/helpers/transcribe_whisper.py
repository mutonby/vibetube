"""Transcribe a video with LOCAL Whisper (free) into the schema video-use expects.

Drop-in alternative to `transcribe.py` (ElevenLabs Scribe) when you want a free,
offline, word-level transcript. Uses **faster-whisper** (CTranslate2) — fast on
CPU with int8 and, unlike openai-whisper, has no numba/NumPy version headaches.

Writes <edit_dir>/transcripts/<stem>.json with a `words` list of
{type, text, start, end} entries:
  - type "word"     → a spoken word with start/end timestamps
  - type "spacing"  → a synthesized gap between two words (start=prev.end,
                      end=next.start) so pack_transcripts.py can detect silences
No diarization (single-speaker webcam recordings don't need it). Cached.

Setup (one-time): a dedicated venv next to the skill so we never touch the
user's base/conda env:
    python3 -m venv <skill>/.venv-whisper
    <skill>/.venv-whisper/bin/pip install -U faster-whisper
This script auto-re-execs into that venv if faster-whisper isn't importable in
the interpreter that launched it.

Usage:
    python helpers/transcribe_whisper.py <video>
    python helpers/transcribe_whisper.py <video> --edit-dir DIR --model small --language es
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def ensure_interpreter() -> None:
    """Make sure we run under an interpreter that has faster-whisper. If not,
    re-exec into the skill's dedicated venv.

    A venv's `bin/python` symlinks to the base interpreter, so comparing
    resolved paths would wrongly say "same interpreter". We use an env marker to
    re-exec exactly once and avoid a loop instead.
    """
    try:
        import faster_whisper  # noqa: F401
        return
    except ImportError:
        pass
    repo = Path(__file__).resolve().parent.parent
    if os.environ.get("RS_WHISPER_REEXEC"):
        sys.exit(f"faster-whisper no importa ni en {repo}/.venv-whisper")
    venv_py = repo / ".venv-whisper" / "bin" / "python"
    if venv_py.exists():
        env = dict(os.environ, RS_WHISPER_REEXEC="1")
        os.execve(str(venv_py), [str(venv_py), str(Path(__file__).resolve()), *sys.argv[1:]], env)
    sys.exit(
        "faster-whisper no disponible. Crea el venv una vez:\n"
        f"  python3 -m venv {repo}/.venv-whisper\n"
        f"  {repo}/.venv-whisper/bin/pip install -U faster-whisper"
    )


def transcribe_words(audio: Path, model_size: str, language: str | None):
    """Return (flat_words, detected_language). faster-whisper decodes the media
    directly (PyAV), so we can pass the .webm with no ffmpeg pre-pass."""
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        str(audio), word_timestamps=True, language=language, vad_filter=True
    )
    flat: list[dict] = []
    for seg in segments:
        for w in (seg.words or []):
            txt = (w.word or "").strip()
            if not txt or w.start is None or w.end is None:
                continue
            flat.append({"text": txt, "start": float(w.start), "end": float(w.end)})
    return flat, info.language


def to_scribe_schema(flat: list[dict], language: str | None, full_text: str) -> dict:
    words: list[dict] = []
    prev_end: float | None = None
    for w in flat:
        if prev_end is not None and w["start"] > prev_end + 1e-3:
            words.append({"type": "spacing", "text": " ", "start": prev_end, "end": w["start"]})
        words.append({"type": "word", "text": w["text"], "start": w["start"], "end": w["end"]})
        prev_end = w["end"]
    return {"language_code": language, "text": full_text, "words": words}


def transcribe_one(
    video: Path,
    edit_dir: Path,
    model: str = "medium",
    language: str | None = None,
    verbose: bool = True,
) -> Path:
    transcripts_dir = edit_dir / "transcripts"
    transcripts_dir.mkdir(parents=True, exist_ok=True)
    out_path = transcripts_dir / f"{video.stem}.json"

    if out_path.exists():
        if verbose:
            print(f"cached: {out_path.name}")
        return out_path

    audio_source = video
    enhanced_candidates = [
        video.parent / f"{video.stem}_enhanced.wav",
        video.parent / "webcam_enhanced.wav",
    ]
    for c in enhanced_candidates:
        if c.exists() and c.stat().st_size > 1000:
            audio_source = c
            break

    if verbose:
        src_label = f"{video.name} (usando {audio_source.name})" if audio_source != video else video.name
        print(f"  whisper ({model}) transcribiendo {src_label}…", flush=True)
    flat, detected = transcribe_words(audio_source, model, language)
    full_text = " ".join(w["text"] for w in flat)
    payload = to_scribe_schema(flat, detected, full_text)

    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    if verbose:
        n_words = sum(1 for w in payload["words"] if w["type"] == "word")
        print(f"  guardado: {out_path.name} ({n_words} palabras, idioma {detected})")
    return out_path


def main() -> None:
    ensure_interpreter()
    ap = argparse.ArgumentParser(description="Transcribe a video with local faster-whisper (free)")
    ap.add_argument("video", type=Path, help="Path to video file")
    ap.add_argument("--edit-dir", type=Path, default=None, help="Edit dir (default: <video_parent>/edit)")
    ap.add_argument("--model", type=str, default="medium",
                    help="Whisper model: tiny|base|small|medium|large-v3 (default medium)")
    ap.add_argument("--language", type=str, default=None, help="ISO code (e.g. 'es'). Omit to auto-detect.")
    args = ap.parse_args()

    video = args.video.resolve()
    if not video.exists():
        sys.exit(f"video not found: {video}")

    edit_dir = (args.edit_dir or (video.parent / "edit")).resolve()
    transcribe_one(video=video, edit_dir=edit_dir, model=args.model, language=args.language)


if __name__ == "__main__":
    main()
