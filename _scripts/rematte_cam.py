#!/usr/bin/env python3
"""Re-recorta el fondo de la pista de cámara de un proyecto, offline y con un
modelo pesado, en vez del recorte en tiempo real que hace el grabador.

POR QUÉ EXISTE
--------------
`src/campipe.js` recorta y compone el fondo MIENTRAS grabas, y eso queda cocido
en `clips/clip_NN/webcam.webm`. El modelo de tiempo real (MediaPipe
selfie_multiclass) mete en la máscara de persona cosas como el cabezal de la
silla, y la librería colapsa sus 6 clases a "persona", así que no hay ajuste que
lo evite. Aquí rehacemos el recorte con RobustVideoMatting, que es recurrente
(coherencia temporal de serie) y corre a ~35 fps en un M1 Pro.

DOS MODOS
---------
`--background auto` (por defecto)
    Para material YA COMPUESTO (lo que grabaste hasta hoy). El fondo detrás de
    ti ya ES la imagen elegida, así que la reconstruimos del propio vídeo: una
    mediana temporal de los píxeles que la máscara marca como fondo. Sale la
    placa exacta, con su desenfoque, sin tener que adivinar qué imagen ni qué
    nivel de bokeh usaste. Al recomponer, lo único que cambia son los píxeles
    del artefacto (la silla) y el borde.

`--background <ruta> [--bokeh N]`
    Para material EN CRUDO (lo que grabarás cuando el grabador guarde la cámara
    sin procesar). Compone sobre la imagen indicada.

SINCRONÍA
---------
El `webcam.webm` de MediaRecorder es fuertemente VFR (deltas medidos de 0 a
156 ms, >50% de los fotogramas fuera de ±5% de la mediana). Decodificamos con
`fps=N` para pasarlo a CFR de forma consciente —exactamente lo que `render.py`
ya hace después al llevarlo a 24 fps— y el AUDIO se copia sin tocar, que es la
única fuente de sonido del proyecto. La duración se verifica al terminar.
"""
import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
DEFAULT_FPS = 30
PLATE_SAMPLES = 60      # fotogramas repartidos para reconstruir la placa de fondo
BG_THRESHOLD = 0.10     # alpha por debajo de esto = fondo seguro


def run_json(args):
    return json.loads(subprocess.run(args, capture_output=True, text=True, check=True).stdout)


def probe(path: Path):
    """(ancho, alto, duración). Los webm de MediaRecorder suelen venir SIN
    duración en la cabecera, así que caemos al PTS del último paquete."""
    d = run_json(["ffprobe", "-v", "error", "-select_streams", "v:0",
                  "-show_entries", "stream=width,height", "-show_entries", "format=duration",
                  "-of", "json", str(path)])
    st = d["streams"][0]
    try:
        dur = float(d["format"]["duration"])
    except (KeyError, TypeError, ValueError):
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "packet=pts_time", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True).stdout.split()
        ts = [float(x.rstrip(",")) for x in out if x.rstrip(",").replace(".", "", 1).isdigit()]
        dur = max(ts) if ts else 0.0
    return int(st["width"]), int(st["height"]), dur


def has_audio(path: Path) -> bool:
    d = run_json(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
                  "stream=codec_type", "-of", "json", str(path)])
    return bool(d.get("streams"))


def load_model(device: str):
    import torch
    model = torch.hub.load("PeterL1n/RobustVideoMatting", "mobilenetv3", trust_repo=True)
    return model.eval().to(device)


def decode_frames(path: Path, w: int, h: int, fps: int):
    """Genera fotogramas RGB uint8 (H,W,3) a CFR `fps`."""
    p = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"fps={fps}",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=w * h * 3 * 4)
    n = w * h * 3
    try:
        while True:
            buf = p.stdout.read(n)
            if len(buf) < n:
                return
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        try:
            p.stdout.close()
            p.wait(timeout=10)
        except Exception:
            p.kill()


def alpha_of(model, frame, rec, device, downsample):
    import torch
    x = (torch.from_numpy(np.ascontiguousarray(frame)).permute(2, 0, 1)
         .float().div(255).unsqueeze(0).to(device))
    with torch.no_grad():
        _fgr, pha, *rec = model(x, *rec, downsample_ratio=downsample)
    return pha[0, 0].cpu().numpy(), rec


def build_plate(model, path: Path, w: int, h: int, fps: int, device: str, downsample: float):
    """Reconstruye la placa de fondo como mediana temporal de los píxeles que la
    máscara da por fondo. Devuelve un RGB float32 (H,W,3)."""
    total = max(1, int(probe(path)[2] * fps))
    step = max(1, total // PLATE_SAMPLES)
    acc, cover = [], np.zeros((h, w), np.int32)
    rec = [None] * 4
    for i, frame in enumerate(decode_frames(path, w, h, fps)):
        a, rec = alpha_of(model, frame, rec, device, downsample)
        if i % step:
            continue
        m = a < BG_THRESHOLD
        f = frame.astype(np.float32).copy()
        f[~m] = np.nan
        acc.append(f)
        cover += m
        if len(acc) >= PLATE_SAMPLES:
            break
    if not acc:
        raise RuntimeError("no se pudo muestrear el fondo")
    stack = np.stack(acc)
    with np.errstate(all="ignore"):
        plate = np.nanmedian(stack, axis=0)
    missing = np.isnan(plate).any(axis=2)
    return plate, missing, int(cover.min())


def fit_reference(plate: np.ndarray, missing: np.ndarray, refs: list[Path], w: int, h: int):
    """Ajusta la imagen de fondo ORIGINAL contra la placa medida.

    La placa medida es fiel donde hubo muestras, pero tiene huecos justo detrás
    del cuerpo (el torso casi nunca se mueve). Rellenar esos huecos por
    inpainting inventa manchas. En cambio, si damos con la imagen de fondo que
    se usó al grabar, podemos reconstruir la placa ENTERA: probamos cada
    candidata a varios niveles de desenfoque y nos quedamos con la que mejor
    encaja en los píxeles que sí conocemos. El error del ajuste se imprime, así
    que la decisión es comprobable y no un acto de fe."""
    import cv2
    valid = ~missing
    if valid.sum() < 0.2 * w * h:
        return []
    target = plate[valid]
    per_ref = []          # (mejor error de esta imagen, placa ajustada, imagen, bokeh)
    for ref in refs:
        img = cv2.imread(str(ref), cv2.IMREAD_COLOR)
        if img is None:
            continue
        img = cv2.cvtColor(cv2.resize(img, (w, h), interpolation=cv2.INTER_LANCZOS4),
                           cv2.COLOR_BGR2RGB).astype(np.float32)
        best = (1e9, None, None)
        for px in range(0, 25, 2):
            cand = cv2.GaussianBlur(img, (px * 2 + 1, px * 2 + 1), px) if px else img
            # Ganancia/offset por canal: absorbe exposición y balance de blancos.
            out = np.empty_like(cand)
            for ch in range(3):
                a, b = np.polyfit(cand[..., ch][valid], plate[..., ch][valid], 1)
                out[..., ch] = cand[..., ch] * a + b
            err = float(np.abs(out[valid] - target).mean())
            if err < best[0]:
                best = (err, out, px)
        if best[1] is not None:
            per_ref.append((best[0], best[1], ref, best[2]))
    per_ref.sort(key=lambda x: x[0])
    return per_ref


def bokeh_image(path: Path, w: int, h: int, px: int) -> np.ndarray:
    import cv2
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"no se pudo leer la imagen de fondo: {path}")
    img = cv2.cvtColor(cv2.resize(img, (w, h), interpolation=cv2.INTER_LANCZOS4), cv2.COLOR_BGR2RGB)
    if px > 0:
        k = px * 2 + 1
        img = cv2.GaussianBlur(img, (k, k), px)
    return img.astype(np.float32)


def rematte_clip(model, src: Path, dst: Path, plate, w: int, h: int,
                 fps: int, device: str, downsample: float, crf: int, blur_px: int = 0):
    """`plate` es un RGB float32 fijo, o None si `blur_px`>0: en ese caso el
    fondo es el DESENFOQUE del propio fotograma (modo blur del grabador), que se
    calcula al vuelo porque cambia con la escena."""
    enc = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
         "-i", str(src),
         "-map", "0:v:0", "-map", "1:a:0?",
         "-c:v", "libx264", "-preset", "fast", "-crf", str(crf), "-pix_fmt", "yuv420p",
         "-c:a", "copy", "-movflags", "+faststart", str(dst)],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    rec = [None] * 4
    n = 0
    t0 = time.time()
    try:
        import cv2
        for frame in decode_frames(src, w, h, fps):
            a, rec = alpha_of(model, frame, rec, device, downsample)
            a3 = a[:, :, None]
            bg = (cv2.GaussianBlur(frame, (blur_px * 2 + 1, blur_px * 2 + 1), blur_px)
                  .astype(np.float32) if blur_px else plate)
            out = frame.astype(np.float32) * a3 + bg * (1.0 - a3)
            enc.stdin.write(np.clip(out, 0, 255).astype(np.uint8).tobytes())
            n += 1
            if n % 300 == 0:
                print(f"      {n} fotogramas  ({n / (time.time() - t0):.1f} fps)", flush=True)
        enc.stdin.close()
    except BrokenPipeError:
        pass
    err = enc.stderr.read().decode(errors="replace")
    if enc.wait() != 0:
        raise RuntimeError(f"ffmpeg falló:\n{err[-800:]}")
    return n, time.time() - t0


def main():
    ap = argparse.ArgumentParser(description="Re-recorta el fondo de la cámara de un proyecto.")
    ap.add_argument("project", type=Path, help="carpeta del proyecto (la que tiene project.json)")
    ap.add_argument("--background", default="auto",
                    help="'auto' (reconstruye la placa del propio vídeo) o ruta a una imagen")
    ap.add_argument("--bokeh", type=int, default=0, help="desenfoque en px de la imagen de fondo")
    ap.add_argument("--clips", default="", help="lista tipo 01,02 (por defecto, todos)")
    ap.add_argument("--fps", type=int, default=DEFAULT_FPS)
    ap.add_argument("--downsample", type=float, default=0.375, help="ratio interno de RVM")
    ap.add_argument("--crf", type=int, default=17)
    ap.add_argument("--background-ref", default="",
                    help="con --background auto: fuerza esta imagen como referencia del ajuste")
    ap.add_argument("--fit-tolerance", type=float, default=12.0,
                    help="error medio máximo (0-255) para dar por bueno el ajuste del fondo")
    ap.add_argument("--fit-margin", type=float, default=1.5,
                    help="cuánto debe mejorar la mejor imagen sobre la segunda (1 = sin margen)")
    ap.add_argument("--apply", action="store_true",
                    help="apunta project.json a los ficheros nuevos (si no, solo los escribe)")
    args = ap.parse_args()

    proj = args.project.resolve()
    pj = proj / "project.json"
    if not pj.exists():
        raise SystemExit(f"no encuentro {pj}")
    data = json.loads(pj.read_text())
    clips = data["clips"]
    if args.clips:
        want = {c.strip() for c in args.clips.split(",")}
        clips = [c for c in clips if c["id"].split("_")[-1] in want or c["id"] in want]
    if not clips:
        raise SystemExit("ningún clip seleccionado")

    import torch
    device = "mps" if torch.backends.mps.is_available() else (
        "cuda" if torch.cuda.is_available() else "cpu")
    print(f"dispositivo: {device}")
    model = load_model(device)

    results = []
    for c in clips:
        src = proj / c["webcam"]
        if not src.exists():
            print(f"  {c['id']}: no existe {src}, lo salto")
            continue
        w, h, dur = probe(src)
        dst = src.with_name("webcam.matted.mp4")
        print(f"\n{c['id']}  {w}x{h}  {dur:.1f}s")

        cam_meta = c.get("cam") or {}
        blur_px = 0
        if args.background == "auto" and cam_meta.get("raw"):
            # Clip grabado EN CRUDO: el grabador anotó qué fondo había elegido,
            # así que no hay nada que reconstruir ni adivinar.
            lvl = int(cam_meta.get("blur_level") or 0)
            if cam_meta.get("background"):
                ref = Path(cam_meta["background"])
                if not ref.is_absolute():
                    ref = REPO / ref
                plate = bokeh_image(ref, w, h, round(lvl / 100 * 16))
                print(f"   crudo -> fondo declarado: {ref.name} (bokeh {round(lvl/100*16)}px)")
            elif cam_meta.get("blur"):
                plate, blur_px = None, max(1, round(6 + lvl / 100 * 54))
                print(f"   crudo -> modo blur declarado, sigma {blur_px}px por fotograma")
            else:
                plate, blur_px = None, 0
                print("   crudo sin fondo declarado: se deja tal cual")
        elif args.background == "auto":
            t = time.time()
            plate, missing, cover = build_plate(model, src, w, h, args.fps, device, args.downsample)
            print(f"   placa medida en {time.time()-t:.0f}s "
                  f"(sin muestra de fondo: {missing.mean()*100:.1f}%, cobertura mínima {cover})")
            refs = ([Path(args.background_ref)] if args.background_ref
                    else sorted((REPO / "src" / "backgrounds").glob("*.jpg")))
            ranked = fit_reference(plate, missing, refs, w, h)
            # Aceptamos la imagen si (a) encaja en términos absolutos y (b) se
            # despega claramente de la segunda. El margen es lo que de verdad
            # dice "es ESTA y no otra"; un umbral absoluto a secas depende de
            # cuánto desenfoque lleve el fondo y da falsos negativos.
            ok = False
            if ranked:
                err, fitted, ref, px = ranked[0]
                margin = (ranked[1][0] / err) if len(ranked) > 1 else float("inf")
                ok = err <= args.fit_tolerance and margin >= args.fit_margin
                print(f"   fondo: {ref.name} bokeh {px}px · error {err:.2f}/255 · "
                      f"margen sobre la 2ª {margin:.2f}x -> "
                      f"{'ACEPTADO' if ok else 'RECHAZADO'}")
            if ok:
                plate = fitted
            else:
                import cv2
                print("   ! sin fondo identificable: relleno los huecos por inpainting "
                      "(puede inventar detrás del cuerpo)")
                base = np.nan_to_num(plate, nan=0).astype(np.uint8)
                plate = cv2.inpaint(base, missing.astype(np.uint8), 5,
                                    cv2.INPAINT_TELEA).astype(np.float32)
        else:
            plate = bokeh_image(Path(args.background), w, h, args.bokeh)
            print(f"   fondo: {args.background} (bokeh {args.bokeh}px)")

        if plate is None and not blur_px:
            print("   nada que componer, lo salto")
            continue
        n, secs = rematte_clip(model, src, dst, plate, w, h, args.fps, device,
                               args.downsample, args.crf, blur_px)
        nw, nh, ndur = probe(dst)
        ok_audio = has_audio(dst) == has_audio(src)
        drift = abs(ndur - dur)
        print(f"   {n} fotogramas en {secs:.0f}s ({n/secs:.1f} fps) -> {dst.name}")
        print(f"   duración {dur:.2f}s -> {ndur:.2f}s (desvío {drift*1000:.0f} ms) · "
              f"audio {'OK' if ok_audio else 'FALTA'} · {dst.stat().st_size/1e6:.0f} MB")
        if drift > 0.15 or not ok_audio or (nw, nh) != (w, h):
            print("   !! revisión necesaria: no cuadra duración/audio/dimensiones")
        results.append((c, dst, drift, ok_audio))

    if args.apply:
        bad = [r for r in results if r[2] > 0.15 or not r[3]]
        if bad:
            raise SystemExit(f"\nNO aplico: {len(bad)} clip(s) no pasan la verificación.")
        for c, dst, _d, _a in results:
            c.setdefault("webcam_original", c["webcam"])
            c["webcam"] = str(dst.relative_to(proj))
        data["cam_rematte"] = {
            "at": time.strftime("%Y%m%d_%H%M%S"),
            "model": "RobustVideoMatting/mobilenetv3",
            "background": args.background,
            "bokeh": args.bokeh,
            "fps": args.fps,
        }
        shutil.copy(pj, pj.with_suffix(".json.bak"))
        pj.write_text(json.dumps(data, indent=1, ensure_ascii=False))
        print(f"\nproject.json actualizado ({len(results)} clips). Copia previa en "
              f"{pj.with_suffix('.json.bak').name}")
    else:
        print("\n(no se ha tocado project.json — vuelve a lanzarlo con --apply cuando "
              "hayas revisado los .matted.mp4)")


if __name__ == "__main__":
    sys.exit(main())
