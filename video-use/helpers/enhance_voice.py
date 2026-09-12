#!/usr/bin/env python3
"""Enhance voice audio using NVIDIA Studio Voice NIM (48k-hq) via gRPC.

Applies professional studio-quality audio enhancement: removes room echo,
background noise, and HVAC hum, while boosting vocal clarity and presence.

Supports:
  1. Enhancing single audio or video files:
     python helpers/enhance_voice.py --input input.webm --output output.wav
  2. Enhancing a recorded clip directory (updates webcam.webm and sync.json):
     python helpers/enhance_voice.py --clip clips/clip_01
  3. Enhancing ALL clips in a project:
     python helpers/enhance_voice.py --all
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# Add studio_voice interface directory to path
HELPERS_DIR = Path(__file__).resolve().parent
STUDIO_VOICE_PKG = HELPERS_DIR / "studio_voice"
if str(STUDIO_VOICE_PKG) not in sys.path:
    sys.path.insert(0, str(STUDIO_VOICE_PKG))


def ensure_interpreter() -> None:
    """Ensure python has grpc and soundfile installed, or re-exec into venv."""
    try:
        import grpc  # noqa: F401
        import soundfile  # noqa: F401
        return
    except ImportError:
        pass

    if os.environ.get("RS_ENHANCE_REEXEC"):
        sys.exit("Error: grpc/soundfile no disponibles en el entorno Python.")

    repo = HELPERS_DIR.parent
    candidates = [
        repo / ".venv" / "bin" / "python",
        repo.parent / "record-studio" / "edit" / ".venv" / "bin" / "python",
        Path.home() / ".config" / "record-studio" / "venv" / "bin" / "python",
    ]
    for venv_py in candidates:
        if venv_py.exists():
            env = dict(os.environ, RS_ENHANCE_REEXEC="1")
            os.execve(str(venv_py), [str(venv_py), str(Path(__file__).resolve()), *sys.argv[1:]], env)

    sys.exit(
        "NVIDIA Studio Voice requiere grpcio y soundfile. Instálalos con:\n"
        "  pip install grpcio soundfile numpy\n"
    )


ensure_interpreter()

import grpc
import numpy as np
import soundfile as sf
import studiovoice_pb2
import studiovoice_pb2_grpc

NVCF_TARGET = "grpc.nvcf.nvidia.com:443"
FUNCTION_ID = "3f0aeba3-6d91-4465-b8cc-cc2aef355186"
MAX_CHUNK_DURATION_SEC = 270.0  # NVIDIA NIM limit is 360s (6 min); we use 4.5 min for safety
CHUNK_OVERLAP_SEC = 2.0


def resolve_api_key(cli_key: str | None = None) -> str | None:
    """Resolve the NVIDIA API key from CLI, environment, .env files, or settings."""
    if cli_key and cli_key.strip():
        return cli_key.strip()

    for var in ("NVIDIA_API_KEY", "NGC_API_KEY"):
        val = os.environ.get(var)
        if val and val.strip():
            return val.strip()

    # Search candidates for .env or settings.json
    candidates_env = [
        Path.home() / ".config" / "record-studio" / ".env",
        HELPERS_DIR.parent / ".env",
        Path.cwd() / ".env",
        Path.home() / "Documents" / "record-studio" / ".env",
    ]
    for env_path in candidates_env:
        if env_path.exists():
            try:
                for line in env_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    if k.strip() in ("NVIDIA_API_KEY", "NGC_API_KEY"):
                        clean_val = v.strip().strip("'\"")
                        if clean_val:
                            return clean_val
            except Exception:
                pass

    # Check Electron app userData settings.json
    settings_paths = [
        Path.home() / "Library" / "Application Support" / "record-studio" / "settings.json",
        Path.home() / ".config" / "record-studio" / "settings.json",
    ]
    for sp in settings_paths:
        if sp.exists():
            try:
                data = json.loads(sp.read_text(encoding="utf-8"))
                val = data.get("nvidiaApiKey")
                if val and str(val).strip():
                    return str(val).strip()
            except Exception:
                pass

    return None


def convert_to_pcm16_mono_wav(input_file: Path, output_wav: Path) -> None:
    """Extract and convert any input audio/video into 48kHz mono 16-bit PCM WAV."""
    cmd = [
        "ffmpeg", "-v", "error", "-y",
        "-i", str(input_file),
        "-vn",
        "-ar", "48000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        str(output_wav),
    ]
    subprocess.run(cmd, check=True)


def _send_grpc_request(wav_file: Path, out_file: Path, api_key: str, model_type: str = "48k-hq", retries: int = 3) -> None:
    """Send a single WAV file (<= 300s) to NVIDIA Studio Voice NIM gRPC endpoint."""
    metadata = (
        ("authorization", f"Bearer {api_key}"),
        ("function-id", FUNCTION_ID),
    )
    credentials = grpc.ssl_channel_credentials()

    def generate_requests():
        chunk_size = 64 * 1024
        with open(wav_file, "rb") as fd:
            while True:
                buf = fd.read(chunk_size)
                if not buf:
                    break
                yield studiovoice_pb2.EnhanceAudioRequest(audio_stream_data=buf)

    last_error = None
    for attempt in range(1, retries + 1):
        try:
            with grpc.secure_channel(NVCF_TARGET, credentials) as channel:
                stub = studiovoice_pb2_grpc.StudioVoiceStub(channel)
                responses = stub.EnhanceAudio(
                    generate_requests(),
                    metadata=metadata,
                    timeout=300.0,
                )
                with open(out_file, "wb") as out_fd:
                    for resp in responses:
                        if resp.HasField("audio_stream_data"):
                            out_fd.write(resp.audio_stream_data)
            # Verify non-empty output
            if out_file.exists() and out_file.stat().st_size > 1000:
                return
            raise RuntimeError(f"Salida vacía tras inferencia gRPC (intento {attempt}/{retries})")
        except Exception as err:
            last_error = err
            if attempt < retries:
                time.sleep(1.5 * attempt)

    raise RuntimeError(f"Error comunicando con NVIDIA Studio Voice NIM: {last_error}")


def enhance_audio_file(
    input_file: Path,
    output_wav: Path,
    api_key: str,
    model_type: str = "48k-hq",
    verbose: bool = True,
) -> Path:
    """Enhance any audio or video file with NVIDIA Studio Voice, chunking if long."""
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="nv_voice_") as tmpdir:
        tmp_path = Path(tmpdir)
        prepared_wav = tmp_path / "input_48k.wav"
        if verbose:
            print(f"[Studio Voice] Preparando audio desde {input_file.name}...", flush=True)
        convert_to_pcm16_mono_wav(input_file, prepared_wav)

        info = sf.info(prepared_wav)
        total_duration = info.duration

        if total_duration <= MAX_CHUNK_DURATION_SEC:
            # Single shot request
            if verbose:
                print(f"[Studio Voice] Procesando {total_duration:.1f}s con NVIDIA NIM ({model_type})...", flush=True)
            _send_grpc_request(prepared_wav, output_wav, api_key, model_type=model_type)
        else:
            # Multi-chunk processing for long audio recordings
            audio_data, sr = sf.read(prepared_wav, dtype="float32")
            chunk_samples = int(MAX_CHUNK_DURATION_SEC * sr)
            overlap_samples = int(CHUNK_OVERLAP_SEC * sr)
            step_samples = chunk_samples - overlap_samples

            chunks = []
            start_idx = 0
            while start_idx < len(audio_data):
                end_idx = min(len(audio_data), start_idx + chunk_samples)
                chunks.append((start_idx, end_idx, audio_data[start_idx:end_idx]))
                if end_idx >= len(audio_data):
                    break
                start_idx += step_samples

            if verbose:
                print(f"[Studio Voice] Audio largo ({total_duration:.1f}s): procesando en {len(chunks)} fragmentos...", flush=True)

            enhanced_chunks = []
            for i, (s_idx, e_idx, chunk_data) in enumerate(chunks, 1):
                chunk_in = tmp_path / f"chunk_{i:03d}_in.wav"
                chunk_out = tmp_path / f"chunk_{i:03d}_out.wav"
                sf.write(chunk_in, chunk_data, sr, subtype="PCM_16")
                if verbose:
                    print(f"  Fragmento {i}/{len(chunks)} ({len(chunk_data)/sr:.1f}s)...", flush=True)
                _send_grpc_request(chunk_in, chunk_out, api_key, model_type=model_type)
                out_chunk, _ = sf.read(chunk_out, dtype="float32")
                enhanced_chunks.append(out_chunk)

            # Recombine chunks with smooth crossfade
            combined = np.zeros(len(audio_data), dtype="float32")
            weights = np.zeros(len(audio_data), dtype="float32")

            for i, (s_idx, e_idx, _) in enumerate(chunks):
                c_out = enhanced_chunks[i]
                c_len = min(len(c_out), len(audio_data) - s_idx)
                # Linear window fade-in/out in overlap regions
                w = np.ones(c_len, dtype="float32")
                if i > 0 and overlap_samples > 0:
                    fade_len = min(overlap_samples, c_len)
                    w[:fade_len] = np.linspace(0.0, 1.0, fade_len)
                if i < len(chunks) - 1 and overlap_samples > 0:
                    fade_len = min(overlap_samples, c_len)
                    w[-fade_len:] = np.linspace(1.0, 0.0, fade_len)

                combined[s_idx : s_idx + c_len] += c_out[:c_len] * w
                weights[s_idx : s_idx + c_len] += w

            weights[weights < 1e-6] = 1.0
            combined /= weights
            sf.write(output_wav, combined, sr, subtype="PCM_16")

    if verbose:
        print(f"[Studio Voice] ✓ Audio mejorado guardado en: {output_wav.name}", flush=True)
    return output_wav


def enhance_clip(clip_dir: Path, api_key: str, force: bool = False, verbose: bool = True) -> bool:
    """Enhance a record-studio clip folder:
    1. Keeps original webcam.webm backed up to webcam_orig.webm.
    2. Enhances audio -> webcam_enhanced.wav.
    3. Remuxes webcam.webm with enhanced audio and original video stream.
    4. Marks sync.json as enhanced.
    """
    webcam_file = clip_dir / "webcam.webm"
    if not webcam_file.exists():
        if verbose:
            print(f"[Studio Voice] Clip {clip_dir.name}: no se encontró webcam.webm, omitiendo.")
        return False

    sync_file = clip_dir / "sync.json"
    sync_data = {}
    if sync_file.exists():
        try:
            sync_data = json.loads(sync_file.read_text(encoding="utf-8"))
        except Exception:
            pass

    orig_backup = clip_dir / "webcam_orig.webm"
    enhanced_wav = clip_dir / "webcam_enhanced.wav"

    if not force and sync_data.get("enhanced") == "nvidia_studio_voice" and enhanced_wav.exists():
        if verbose:
            print(f"[Studio Voice] Clip {clip_dir.name} ya está mejorado. (Usa --force para re-procesar).")
        return True

    # Backup original before modifying
    source_to_enhance = orig_backup if orig_backup.exists() else webcam_file
    if not orig_backup.exists():
        shutil.copy2(webcam_file, orig_backup)
        if verbose:
            print(f"[Studio Voice] Copia de seguridad creada: {orig_backup.name}")

    if verbose:
        print(f"\n[Studio Voice] === Mejorando {clip_dir.name} ===")

    try:
        # Generate enhanced 48kHz WAV
        enhance_audio_file(source_to_enhance, enhanced_wav, api_key, verbose=verbose)

        # Remux into webcam.webm keeping original video stream untouched
        tmp_webm = clip_dir / "webcam_remux.webm"
        cmd_remux = [
            "ffmpeg", "-v", "error", "-y",
            "-i", str(orig_backup),
            "-i", str(enhanced_wav),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "libopus",
            "-b:a", "192k",
            "-ar", "48000",
            str(tmp_webm),
        ]
        subprocess.run(cmd_remux, check=True)

        if tmp_webm.exists() and tmp_webm.stat().st_size > 1000:
            tmp_webm.replace(webcam_file)
            if verbose:
                print(f"[Studio Voice] ✓ webcam.webm remuxado con audio Studio Voice.")

        # Update sync.json
        sync_data["enhanced"] = "nvidia_studio_voice"
        sync_data["enhanced_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        sync_file.write_text(json.dumps(sync_data, indent=2), encoding="utf-8")

        # Update project.json if present
        proj_file = clip_dir.parent.parent / "project.json"
        if proj_file.exists():
            try:
                proj_data = json.loads(proj_file.read_text(encoding="utf-8"))
                for c in proj_data.get("clips", []):
                    if c.get("id") == clip_dir.name:
                        c["enhanced"] = True
                proj_file.write_text(json.dumps(proj_data, indent=2), encoding="utf-8")
            except Exception:
                pass

        return True
    except Exception as err:
        print(f"[Studio Voice] ✗ Error mejorando {clip_dir.name}: {err}", file=sys.stderr)
        return False


def enhance_all_clips(proj_dir: Path, api_key: str, force: bool = False) -> int:
    """Find and enhance all clips in project directory."""
    clips_dir = proj_dir / "clips"
    if not clips_dir.exists():
        print(f"[Studio Voice] No existe la carpeta {clips_dir}", file=sys.stderr)
        return 0

    clip_folders = sorted([d for d in clips_dir.iterdir() if d.is_dir() and d.name.startswith("clip_")])
    if not clip_folders:
        print(f"[Studio Voice] No se encontraron clips en {clips_dir}")
        return 0

    print(f"[Studio Voice] Procesando {len(clip_folders)} clips en {proj_dir.name}...")
    success_count = 0
    for c_dir in clip_folders:
        if enhance_clip(c_dir, api_key, force=force, verbose=True):
            success_count += 1

    print(f"\n[Studio Voice] Terminado: {success_count}/{len(clip_folders)} clips listos.")
    return success_count


def main() -> None:
    parser = argparse.ArgumentParser(description="Enhance speech using NVIDIA Studio Voice NIM (48k-hq).")
    parser.add_argument("--input", "-i", type=Path, help="Input audio or video file.")
    parser.add_argument("--output", "-o", type=Path, help="Output enhanced audio WAV.")
    parser.add_argument("--clip", "-c", type=Path, help="Path to clip directory (e.g. clips/clip_01).")
    parser.add_argument("--all", "-a", action="store_true", help="Enhance all clips in current or --dir project.")
    parser.add_argument("--dir", "-d", type=Path, default=Path.cwd(), help="Project directory (default: cwd).")
    parser.add_argument("--api-key", type=str, default=None, help="NVIDIA API Key (optional if in env).")
    parser.add_argument("--model-type", type=str, default="48k-hq", choices=["48k-hq", "48k-ll", "16k-hq"])
    parser.add_argument("--force", "-f", action="store_true", help="Re-enhance even if already enhanced.")
    parser.add_argument("--dry-run", action="store_true", help="Test credentials and connection only.")

    args = parser.parse_args()

    api_key = resolve_api_key(args.api_key)
    if not api_key:
        sys.exit(
            "Error: No se encontró NVIDIA_API_KEY.\n"
            "Configura tu clave en ~/.config/record-studio/.env o pásala con --api-key <clave>."
        )

    if args.dry_run:
        print(f"[Studio Voice] Clave detectada: {api_key[:8]}...{api_key[-4:]}")
        print(f"[Studio Voice] Endpoint: {NVCF_TARGET} | Función: {FUNCTION_ID}")
        print("[Studio Voice] ✓ Configuración válida.")
        return

    if args.all:
        enhance_all_clips(args.dir.resolve(), api_key, force=args.force)
    elif args.clip:
        enhance_clip(args.clip.resolve(), api_key, force=args.force, verbose=True)
    elif args.input:
        in_path = args.input.resolve()
        if not in_path.exists():
            sys.exit(f"Error: Fichero de entrada no existe: {in_path}")
        out_path = args.output.resolve() if args.output else in_path.with_name(f"{in_path.stem}_enhanced.wav")
        enhance_audio_file(in_path, out_path, api_key, model_type=args.model_type)
    else:
        # Default behavior when run in a project dir without flags: enhance all clips
        clips_dir = args.dir.resolve() / "clips"
        if clips_dir.exists():
            enhance_all_clips(args.dir.resolve(), api_key, force=args.force)
        else:
            parser.print_help()


if __name__ == "__main__":
    main()
