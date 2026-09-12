"""Render a video from an EDL.

Implements the HEURISTICS render pipeline in the correct order:

  1. Per-segment extract with color grade + 30ms audio fades baked in
  2. Lossless -c copy concat into base.mp4
  3. If overlays or subtitles: single filter graph that overlays animations
     (with PTS shift so frame 0 lands at the overlay window start)
     and applies `subtitles` filter LAST → final.mp4

Optionally builds a master SRT from the per-source transcripts + EDL
output-timeline offsets, applies the proven force_style (2-word
UPPERCASE chunks, Helvetica 18 Bold, MarginV=35).

Usage:
    python helpers/render.py <edl.json> -o final.mp4
    python helpers/render.py <edl.json> -o preview.mp4 --preview
    python helpers/render.py <edl.json> -o final.mp4 --build-subtitles
    python helpers/render.py <edl.json> -o final.mp4 --no-subtitles
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

try:
    from grade import get_preset, auto_grade_for_clip  # same directory
except Exception:
    def get_preset(name: str) -> str:
        return ""

    def auto_grade_for_clip(video, start=0.0, duration=None, verbose=False):  # type: ignore
        return "eq=contrast=1.03:saturation=0.98", {}


# -------- Subtitle style (bold-overlay, proven at 1920×1080 and 1080×1920) --
#
# MarginV is NOT taste — it is a platform safe-zone rule.
# TikTok / IG Reels / Shorts UI (caption, username, music, right-rail actions)
# covers roughly the bottom ~25–30% of a 1080×1920 frame. Captions placed near
# the bottom edge get clipped or obscured by the UI. libass auto-scales the
# render canvas relative to PlayResY=288, so MarginV=90 lands the caption
# baseline roughly 30% up from the bottom on any aspect — clear of the UI on
# every major vertical-video platform. Do not drop this below ~75 without a
# specific reason.
def sub_force_style(margin_v: int = 90) -> str:
    return (
        "FontName=Helvetica,FontSize=18,Bold=1,"
        "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000,"
        "BorderStyle=1,Outline=2,Shadow=0,"
        f"Alignment=2,MarginV={margin_v}"
    )


# Vertical (Shorts/Reels/TikTok) keeps a high margin to clear the platform UI.
# Horizontal (YouTube talking-head) sits LOWER so captions don't cover the mouth.
def sub_margin_for_canvas(canvas: tuple[int, int]) -> int:
    w, h = canvas
    return 90 if h > w else 40


SUB_FORCE_STYLE = sub_force_style(90)  # back-compat default

# -------- Helpers ------------------------------------------------------------


def run(cmd: list[str], quiet: bool = False) -> None:
    if not quiet:
        print(f"  $ {' '.join(str(c) for c in cmd[:6])}{' …' if len(cmd) > 6 else ''}")
    subprocess.run(cmd, check=True)


def resolve_grade_filter(grade_field: str | None) -> str:
    """The EDL's 'grade' field can be a preset name, a raw ffmpeg filter, or 'auto'.

    Returns the filter string to embed into the per-segment -vf chain.
    For 'auto', returns the sentinel "__AUTO__" which is resolved per-segment.
    """
    if not grade_field:
        return ""
    if grade_field == "auto":
        return "__AUTO__"
    # Preset names are short identifiers, filter strings contain '=' or ','.
    if re.fullmatch(r"[a-zA-Z0-9_\-]+", grade_field):
        try:
            return get_preset(grade_field)
        except KeyError:
            print(f"warning: unknown preset '{grade_field}', using as raw filter")
            return grade_field
    return grade_field


def resolve_path(maybe_path: str, base: Path) -> Path:
    """Resolve a path that may be absolute or relative to `base`."""
    p = Path(maybe_path)
    if p.is_absolute():
        return p
    return (base / p).resolve()


# -------- HDR → SDR tone mapping (HLG / PQ sources) --------------------------
#
# iPhone defaults to HLG HDR in Rec.2020 (and many mirrorless cameras ship PQ).
# If the source is HDR and we only downconvert bit depth (yuv420p10le → yuv420p)
# without tone-mapping, the output is 8-bit but still carries HLG/PQ transfer
# metadata. Players that honor the metadata (screen recorders, most social
# upload re-encodes) interpret 8-bit values in an HDR container and the result
# looks oversaturated / blown out. QuickTime on macOS can hide this locally —
# screen recording and uploaded renders cannot.
#
# Fix: detect HDR via color_transfer and prepend a zscale+tonemap chain to the
# vf graph so the output is clean Rec.709 SDR.

HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}  # PQ (HDR10) and HLG

TONEMAP_CHAIN = (
    "zscale=t=linear:npl=100,"
    "format=gbrpf32le,"
    "zscale=p=bt709,"
    "tonemap=tonemap=hable:desat=0,"
    "zscale=t=bt709:m=bt709:r=tv,"
    "format=yuv420p"
)


def is_hdr_source(video: Path) -> bool:
    """Return True if the source uses a PQ or HLG transfer function."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=color_transfer",
             "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip() in HDR_TRANSFERS
    except subprocess.CalledProcessError:
        return False


def is_portrait_source(video: Path) -> bool:
    """Return True if the video's height > width (portrait / vertical)."""
    dims = ffprobe_dims(video)
    if dims is None:
        return False
    w, h = dims
    return h > w


def ffprobe_dims(video: Path) -> tuple[int, int] | None:
    """Return (width, height) of the first video stream, or None on failure.

    Used to compute a fixed pip-inset display height so the punch-in zoom can
    crop back to a stable box (see `_zoom_chain_pip`)."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height",
             "-of", "csv=p=0", str(video)],
            capture_output=True, text=True, check=True,
        )
        w, h = map(int, out.stdout.strip().split(",")[:2])
        return w, h
    except Exception:
        return None


# -------- Per-segment extraction (Rule 2 + Rule 3) --------------------------


def extract_segment(
    source: Path,
    seg_start: float,
    duration: float,
    grade_filter: str,
    out_path: Path,
    preview: bool = False,
    draft: bool = False,
) -> None:
    """Extract a cut range as its own MP4 with grade + 30ms audio fades baked in.

    `-ss` before `-i` for fast accurate seeking. Scale to 1080p from 4K.
    Portrait sources (height > width) are scaled by height to preserve orientation.

    Quality ladder:
      - final (default): 1080p libx264 fast CRF 20
      - preview:         1080p libx264 medium CRF 22 (evaluable for QC)
      - draft:           720p libx264 ultrafast CRF 28 (cut-point check only)
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)

    portrait = is_portrait_source(source)
    if draft:
        scale = "scale=-2:1280" if portrait else "scale=1280:-2"
    else:
        scale = "scale=-2:1920" if portrait else "scale=1920:-2"

    vf_parts: list[str] = []
    if is_hdr_source(source):
        vf_parts.append(TONEMAP_CHAIN)
    vf_parts.append(scale)
    if grade_filter:
        vf_parts.append(grade_filter)
    vf = ",".join(vf_parts)

    # 30ms audio fades at both edges (Rule 3) — prevent pops.
    # `aresample=async=1` keeps audio locked to the video timeline so VFR
    # webm sources (e.g. MediaRecorder, pause/resume) don't drift out of lip-sync.
    fade_out_start = max(0.0, duration - 0.03)
    af = f"aresample=async=1:first_pts=0,afade=t=in:st=0:d=0.03,afade=t=out:st={fade_out_start:.3f}:d=0.03"

    if draft:
        preset, crf = "ultrafast", "28"
    elif preview:
        preset, crf = "medium", "22"
    else:
        preset, crf = "fast", "20"

    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{seg_start:.3f}",
        "-i", str(source),
        "-t", f"{duration:.3f}",
        "-vf", vf,
        "-af", af,
        "-c:v", "libx264", "-preset", preset, "-crf", crf,
        "-pix_fmt", "yuv420p", "-r", "24", "-fps_mode", "cfr",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


# -------- Multicam compositing (screen + cam on ONE synced timeline) --------
#
# record-studio (the companion recorder) captures two synchronized sources — a
# screen track and a webcam track that carries the mic. Both cover the SAME
# timeline. A multicam EDL therefore DROPS the per-range "source" field and
# gives every range a "layout" instead:
#
#   fullcam     → webcam fills the frame (talking head)
#   fullscreen  → screen fills the frame; audio stays on the webcam mic
#   pip         → screen base + webcam inset in a corner
#
# Audio is ALWAYS taken from `audio_source` (default "cam") across the whole
# timeline, so a shot change never breaks the voice — only the picture cuts.
#
# Sync: `sync.offset_ms` = cam_start - screen_start. A cam-relative time τ maps
# to screen-relative time τ + offset_ms/1000.

DEFAULT_CANVAS = (1920, 1080)
FPS = 24  # every segment is rendered at this rate → xfade/overlap math is frame-safe


# -------- Punch-in zoom (slow continuous scale, no cuts) --------------------
#
# Ported from avatar-muton `zoom_chain`. A gentle, continuous zoom keeps a shot
# alive without a hard "multicam" cut. The crop is biased UP (0.35 of the
# overflow) so a talking head's face is never chopped off the top.


def _zoom_chain(w: int, h: int, z0: float, z1: float, d: float) -> str:
    """Progressive zoom z0→z1 over d seconds on a frame already sized w×h.

    `scale ... eval=frame` re-evaluates the width every frame (t is the frame
    time); `h=-2` keeps aspect, then a centered crop (biased up) restores w×h."""
    return (f"scale=w='ceil({w}*({z0:.4f}+{(z1 - z0):.4f}*t/{max(d, 0.04):.3f})/2)*2':h=-2:eval=frame,"
            f"crop={w}:{h}:(iw-ow)/2:(ih-oh)*0.35,setsar=1")


def _zoom_chain_pip(pw: int, ph: int, z0: float, z1: float, d: float) -> str:
    """Punch-in for a pip inset whose display box is a FIXED pw×ph.

    Scaling both dimensions by z(t) keeps aspect and guarantees the frame is
    always ≥ pw×ph, so the centered crop back to pw×ph never underflows."""
    z = f"({z0:.4f}+{(z1 - z0):.4f}*t/{max(d, 0.04):.3f})"
    return (f"scale=w='ceil({pw}*{z}/2)*2':h='ceil({ph}*{z}/2)*2':eval=frame,"
            f"crop={pw}:{ph}:(iw-ow)/2:(ih-oh)/2,setsar=1")


def _zoom_range(r: dict, portrait: bool, no_punch: bool, pip: bool = False) -> tuple[float, float] | None:
    """Resolve the [z0, z1] punch-in range for a range, or None to disable.

    Defaults: fullcam/fullscreen → (1.0, 1.05) landscape / (1.0, 1.04) portrait;
    the pip CAMERA inset uses a gentler (1.0, 1.04). A range may override via
    `r["zoom"]` (or `r["pip"]["zoom"]` for the inset)."""
    if no_punch:
        return None
    if pip:
        default = (1.0, 1.04)
        z = (r.get("pip") or {}).get("zoom")
    else:
        default = (1.0, 1.04) if portrait else (1.0, 1.05)
        z = r.get("zoom")
    if isinstance(z, (list, tuple)) and len(z) == 2:
        return (float(z[0]), float(z[1]))
    return default


def _scale_pad(w: int, h: int) -> str:
    """Fit a source into a w×h canvas, letterbox/pillarbox the rest in black."""
    return (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
    )


def _scale_cover(w: int, h: int) -> str:
    """Fill a w×h canvas from a source, cropping the overflow (no bars)."""
    return f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"


# -------- Portrait (9:16) composition ---------------------------------------
#
# A landscape source (16:9 screen capture, 16:9 graphic) cannot fill a 9:16
# canvas. Three knobs control how it is placed, all overridable per range:
#
#   PORTRAIT_BG          the blurred plate behind the source. It LIFTS BLACKS
#                        (colorlevels romin) so a dark UI capture never
#                        degenerates into a pure-black void, and caps highlights
#                        so it stays a background.
#   PORTRAIT_MAX_CROP    "auto" fit trims this fraction off the source WIDTH
#                        (centered) before scaling, so a 16:9 screen becomes 4:3
#                        and its band grows from 32% to 42% of the canvas height.
#                        The trimmed 25% is normally sidebar/whitespace.
#   PORTRAIT_ANCHOR      0 = band flush to the top of its box, 1 = flush to the
#                        bottom, 0.5 = centered. Biased UP because burned 9:16
#                        captions and the cam PiP always live low.

PORTRAIT_BG = ("gblur=sigma=42,eq=saturation=0.85,"
               "colorlevels=romin=0.10:gomin=0.10:bomin=0.10"
               ":romax=0.62:gomax=0.62:bomax=0.62")
PORTRAIT_MAX_CROP = 0.25   # 16:9 → 4:3
PORTRAIT_ANCHOR = 0.38
PORTRAIT_PAD = 0.045       # fraction of H kept clear above the band
PORTRAIT_GAP = 0.030       # fraction of H between the band and the cam PiP
PORTRAIT_SPLIT = 0.5       # stacked pip: cam's share of the canvas height


def _roi_crop(roi) -> str:
    """`[x, y, w, h]` in NORMALIZED (0-1) source coordinates → a crop filter.

    Lets an EDL point the vertical reframe at the part of the screen that
    actually carries the content, instead of shrinking the whole desktop."""
    if not roi:
        return ""
    try:
        x, y, w, h = (float(v) for v in roi)
    except (TypeError, ValueError):
        return ""
    w = max(0.05, min(1.0, w))
    h = max(0.05, min(1.0, h))
    x = max(0.0, min(1.0 - w, x))
    y = max(0.0, min(1.0 - h, y))
    if w >= 0.999 and h >= 0.999:
        return ""
    return f"crop=iw*{w:.5f}:ih*{h:.5f}:iw*{x:.5f}:ih*{y:.5f},"


def _portrait_fill(in_ref: str, w: int, h: int, pre: str = "") -> str:
    """Scale-to-fit + center a source over a blurred cover of itself.

    Used for GRAPHIC cutaways, which are authored at the canvas size already —
    no cropping, no anchoring. Screen sources go through `_portrait_screen`."""
    return (
        f"[{in_ref}]{pre}split[pbg][pfg];"
        f"[pbg]{_scale_cover(w, h)},{PORTRAIT_BG}[pbg2];"
        f"[pfg]scale={w}:{h}:force_original_aspect_ratio=decrease,setsar=1[pfg2];"
        f"[pbg2][pfg2]overlay=(W-w)/2:(H-h)/2,setsar=1[pcv]"
    )


def _portrait_screen(in_ref: str, w: int, h: int, pre: str = "", *,
                     roi=None, fit: str = "auto", box_top: int = 0,
                     box_h: int | None = None,
                     anchor: float = PORTRAIT_ANCHOR) -> str:
    """Compose a landscape SCREEN source onto a w×h portrait canvas.

    The source is placed inside the box `[box_top, box_top + box_h]` — the space
    left free by the cam PiP and the captions — over a full-canvas blurred plate.

    `fit`:
      "auto"  (default) trim PORTRAIT_MAX_CROP off the width, then scale to fit
              the box. Biggest legible band without guessing what matters.
      "fit"   scale to fit with no trimming (the pre-2026 behaviour).
      "cover" fill the box completely, cropping whatever overflows.

    The vertical position uses an overlay expression on `h`, so the band height
    never has to be probed. Output is on [pcv]."""
    box_h = h if box_h is None else max(2, box_h)
    crop = _roi_crop(roi)
    if fit == "cover":
        fg = f"[pfg]{crop}{_scale_cover(w, box_h)}[pfg2];"
        y = f"{box_top}"
    else:
        trim = 0.0 if fit == "fit" else max(0.0, min(0.6, PORTRAIT_MAX_CROP))
        # An explicit ROI already says what to keep — don't trim it further.
        if crop:
            trim = 0.0
        tc = f"crop=iw*{1 - trim:.4f}:ih:iw*{trim / 2:.4f}:0," if trim > 0 else ""
        fg = (f"[pfg]{crop}{tc}scale={w}:{box_h}"
              f":force_original_aspect_ratio=decrease,setsar=1[pfg2];")
        a = max(0.0, min(1.0, anchor))
        y = f"{box_top}+({box_h}-h)*{a:.3f}"
    return (
        f"[{in_ref}]{pre}split[pbg][pfg];"
        f"[pbg]{_scale_cover(w, h)},{PORTRAIT_BG}[pbg2];"
        f"{fg}"
        f"[pbg2][pfg2]overlay=(W-w)/2:{y},setsar=1[pcv]"
    )


def _screen_opts(r: dict, defaults: dict | None,
                 default_fit: str = "auto") -> tuple[object, str, float]:
    """Resolve (roi, fit, anchor) for a range, range value winning over the
    EDL-level default, which in turn wins over `default_fit`."""
    d = defaults or {}
    roi = r.get("screen_roi", d.get("screen_roi"))
    fit = str(r.get("screen_fit", d.get("screen_fit", default_fit)) or default_fit).lower()
    if fit not in ("auto", "fit", "cover"):
        fit = "auto"
    try:
        anchor = float(r.get("screen_anchor", d.get("screen_anchor", PORTRAIT_ANCHOR)))
    except (TypeError, ValueError):
        anchor = PORTRAIT_ANCHOR
    return roi, fit, anchor


def _pip_xy(corner: str, margin: int) -> tuple[str, str]:
    m = margin
    table = {
        "br": (f"W-w-{m}", f"H-h-{m}"),
        "bottom-right": (f"W-w-{m}", f"H-h-{m}"),
        "bl": (f"{m}", f"H-h-{m}"),
        "bottom-left": (f"{m}", f"H-h-{m}"),
        "tr": (f"W-w-{m}", f"{m}"),
        "top-right": (f"W-w-{m}", f"{m}"),
        "tl": (f"{m}", f"{m}"),
        "top-left": (f"{m}", f"{m}"),
        "bc": ("(W-w)/2", f"H-h-{m}"),
        "bottom-center": ("(W-w)/2", f"H-h-{m}"),
        "tc": ("(W-w)/2", f"{m}"),
        "top-center": ("(W-w)/2", f"{m}"),
        "cl": (f"{m}", "(H-h)/2"),
        "left-center": (f"{m}", "(H-h)/2"),
        "cr": (f"W-w-{m}", "(H-h)/2"),
        "right-center": (f"W-w-{m}", "(H-h)/2"),
        "c": ("(W-w)/2", "(H-h)/2"),
        "center": ("(W-w)/2", "(H-h)/2"),
    }
    return table.get((corner or "br").lower(), table["br"])


def _enc_params(preview: bool, draft: bool) -> tuple[str, str]:
    if draft:
        return "ultrafast", "28"
    if preview:
        return "medium", "22"
    return "fast", "20"


def extract_segment_multicam(
    r: dict,
    screen: Path,
    cam: Path,
    offset_s: float,
    canvas: tuple[int, int],
    grade_filter: str,
    out_path: Path,
    preview: bool = False,
    draft: bool = False,
    screen_crop_top: float = 0.0,
    graphic_path: Path | None = None,
    no_punch: bool = False,
    screen_defaults: dict | None = None,
) -> None:
    """Render one multicam range to a self-contained MP4 at the canvas size.

    Same encode ladder + 30ms audio fades (Rule 3) + faststart as
    `extract_segment`, so the output concats losslessly (Rule 2) with every
    other segment.

    The `graphic` layout is a full-frame designed card (a hard cutaway): the
    PICTURE is a pre-rendered opaque graphic file (`graphic_path`), while the
    AUDIO stays on the continuous webcam mic for the same [start,end] window —
    so the VOICE NEVER GOES SILENT, only the picture cuts to the graphic and
    back. A graphic segment is therefore never a silent clip.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    W, H = canvas
    portrait = H > W  # 9:16 vertical → blurred-fill instead of black bars
    layout = r.get("layout", "pip")
    start = float(r["start"])
    duration = float(r["end"]) - start
    cam_ss = max(0.0, start)
    screen_ss = max(0.0, start + offset_s)

    preset, crf = _enc_params(preview, draft)
    fade_out = max(0.0, duration - 0.03)
    # aresample=async keeps the mic locked to the picture so VFR webm (MediaRecorder,
    # pause/resume) doesn't drift out of lip-sync.
    af = f"aresample=async=1:first_pts=0,afade=t=in:st=0:d=0.03,afade=t=out:st={fade_out:.3f}:d=0.03"
    grade = f",{grade_filter}" if grade_filter else ""

    # Crop the macOS menu bar (top strip) off the SCREEN source before scaling.
    t = max(0.0, min(0.2, float(screen_crop_top or 0.0)))
    screen_pre = f"crop=iw:ih*{1 - t:.4f}:0:ih*{t:.4f}," if t > 0 else ""

    if layout == "graphic":
        # Full-frame opaque card as the picture; the VOICE stays on the cam mic
        # for this window (never silent). Portrait → blurred-fill, else letterbox.
        if graphic_path is None:
            raise ValueError("graphic layout requires a 'graphic_file'")
        if portrait:
            fc = (
                f"{_portrait_fill('0:v', W, H)};"
                f"[pcv]fps=24,setsar=1[vout];[1:a]{af}[aout]"
            )
        else:
            fc = (
                f"[0:v]{_scale_pad(W, H)},fps=24,setsar=1[vout];[1:a]{af}[aout]"
            )
        io = [
            "-ss", "0", "-i", str(graphic_path), "-t", f"{duration:.3f}",
            "-ss", f"{cam_ss:.3f}", "-i", str(cam), "-t", f"{duration:.3f}",
        ]
    elif layout == "fullcam":
        tonemap = (TONEMAP_CHAIN + ",") if is_hdr_source(cam) else ""
        # Punch-in zooms the full-frame cam (already W×H after cover).
        zr = _zoom_range(r, portrait, no_punch)
        zoom = f",{_zoom_chain(W, H, zr[0], zr[1], duration)}" if zr else ""
        fc = f"[0:v]{tonemap}{_scale_cover(W, H)}{zoom},fps=24{grade}[vout];[0:a]{af}[aout]"
        io = ["-ss", f"{cam_ss:.3f}", "-i", str(cam), "-t", f"{duration:.3f}"]
    elif layout == "fullscreen":
        tonemap = (TONEMAP_CHAIN + ",") if is_hdr_source(screen) else ""
        # Punch-in zooms the composed screen frame (W×H by this point).
        zr = _zoom_range(r, portrait, no_punch)
        if portrait:
            zoom = f"{_zoom_chain(W, H, zr[0], zr[1], duration)}," if zr else ""
            # No cam inset here, so "cover" fills the whole canvas — no plate,
            # no bars. Override per range with screen_fit/screen_roi when the
            # crop would cut content off the sides.
            roi, fit, anchor = _screen_opts(r, screen_defaults, default_fit="cover")
            pad = 0 if fit == "cover" else int(round(H * PORTRAIT_PAD))
            fc = (
                f"{_portrait_screen('0:v', W, H, pre=f'{tonemap}{screen_pre}', roi=roi, fit=fit, box_top=pad, box_h=H - 2 * pad, anchor=anchor)};"
                f"[pcv]{zoom}fps=24{grade}[vout];[1:a]{af}[aout]"
            )
        else:
            zoom = f",{_zoom_chain(W, H, zr[0], zr[1], duration)}" if zr else ""
            fc = f"[0:v]{tonemap}{screen_pre}{_scale_pad(W, H)}{zoom},fps=24{grade}[vout];[1:a]{af}[aout]"
        io = [
            "-ss", f"{screen_ss:.3f}", "-i", str(screen),
            "-ss", f"{cam_ss:.3f}", "-i", str(cam),
            "-t", f"{duration:.3f}",
        ]
    else:  # pip
        pip = r.get("pip") or {}
        tonemap_s = (TONEMAP_CHAIN + ",") if is_hdr_source(screen) else ""
        pip_zr = _zoom_range(r, portrait, no_punch, pip=True)
        stacked = portrait and str(pip.get("style", "stack")).lower() == "stack"

        if stacked:
            # VERTICAL SPLIT: screen fills the TOP band, cam fills the BOTTOM
            # band, both cover-cropped — the frame is 100% picture, no blurred
            # plate and no gap between them. `pip.split` is the cam's share of
            # the canvas height (default 0.5 → the cam reaches the middle).
            try:
                split = float(pip.get("split", PORTRAIT_SPLIT))
            except (TypeError, ValueError):
                split = PORTRAIT_SPLIT
            split = max(0.25, min(0.6, split))
            cam_h = max(2, (int(round(H * split)) // 2) * 2)
            scr_h = H - cam_h
            roi, fit, anchor = _screen_opts(r, screen_defaults, default_fit="cover")
            top = _portrait_screen("0:v", W, scr_h, pre=f"{tonemap_s}{screen_pre}",
                                   roi=roi, fit=fit, box_top=0, box_h=scr_h,
                                   anchor=anchor)
            cam_chain = f"[1:v]{_scale_cover(W, cam_h)}"
            if pip_zr:
                cam_chain += f",{_zoom_chain_pip(W, cam_h, pip_zr[0], pip_zr[1], duration)}"
            fc = (
                f"{top};[pcv]fps=24[top];"
                f"{cam_chain}[bot];"
                f"[top][bot]vstack=inputs=2,setsar=1{grade}[vout];"
                f"[1:a]{af}[aout]"
            )
        else:
            scale = float(pip.get("scale", 0.26))
            margin = int(pip.get("margin", 40))
            if portrait:
                scale = max(scale, 0.58)
                margin = max(margin, 90)
            pw = max(2, (int(round(W * scale)) // 2) * 2)
            cam_dims = ffprobe_dims(cam)
            cam_ar = (cam_dims[1] / cam_dims[0]) if cam_dims and cam_dims[0] else 9 / 16
            cam_h = max(2, (int(round(pw * cam_ar)) // 2) * 2)
            if portrait:
                x, y = "(W-w)/2", f"H-h-{margin}"  # bottom-center
            else:
                x, y = _pip_xy(pip.get("corner", "br"), margin)
            if portrait:
                roi, fit, anchor = _screen_opts(r, screen_defaults)
                pad = int(round(H * PORTRAIT_PAD))
                gap = int(round(H * PORTRAIT_GAP))
                box_h = max(240, H - cam_h - margin - gap - pad)
                bg = (
                    f"{_portrait_screen('0:v', W, H, pre=f'{tonemap_s}{screen_pre}', roi=roi, fit=fit, box_top=pad, box_h=box_h, anchor=anchor)};"
                    f"[pcv]fps=24[bg];"
                )
            else:
                bg = f"[0:v]{tonemap_s}{screen_pre}{_scale_pad(W, H)},fps=24[bg];"
            # Punch-in the cam inset. The pip box must stay a fixed size, so we
            # need its display height ph. If cam dims can't be probed we degrade
            # gracefully to an un-zoomed inset (never break).
            ph = cam_h if cam_dims else None
            if pip_zr and ph:
                pip_chain = f"[1:v]{_zoom_chain_pip(pw, ph, pip_zr[0], pip_zr[1], duration)}[pip];"
            else:
                pip_chain = f"[1:v]scale={pw}:-2,setsar=1[pip];"
            fc = (
                f"{bg}"
                f"{pip_chain}"
                f"[bg][pip]overlay={x}:{y}{grade}[vout];"
                f"[1:a]{af}[aout]"
            )
        io = [
            "-ss", f"{screen_ss:.3f}", "-i", str(screen),
            "-ss", f"{cam_ss:.3f}", "-i", str(cam),
            "-t", f"{duration:.3f}",
        ]

    cmd = [
        "ffmpeg", "-y", *io,
        "-filter_complex", fc,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", preset, "-crf", crf,
        "-pix_fmt", "yuv420p", "-r", "24", "-fps_mode", "cfr",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _multicam_sources(sources: dict, edit_dir: Path) -> tuple[Path, Path]:
    """Resolve the screen + cam paths (accepts 'cam' or 'webcam' keys)."""
    screen = resolve_path(sources["screen"], edit_dir)
    cam_key = "cam" if "cam" in sources else "webcam"
    cam = resolve_path(sources[cam_key], edit_dir)
    return screen, cam


def extract_all_segments(
    edl: dict,
    edit_dir: Path,
    preview: bool,
    draft: bool = False,
    no_punch: bool = False,
) -> tuple[list[Path], list[float]]:
    """Extract every EDL range into edit_dir/clips_graded/seg_NN.mp4.
    Returns (ordered segment paths, per-segment durations in seconds).

    The durations feed the xfade timeline: overlaps are subtracted from them to
    know where each segment actually starts in the crossfaded output.

    Two modes, auto-detected:
      - single-source: each range names a "source" (best-take selection).
      - multicam: ranges carry a "layout" over one synced screen+cam timeline.

    If the EDL `grade` is "auto", analyze each segment range with
    `auto_grade_for_clip` and apply a per-segment subtle correction.
    Otherwise, apply the same preset/raw filter to every segment.
    """
    resolved = resolve_grade_filter(edl.get("grade"))
    is_auto = resolved == "__AUTO__"
    clips_dir = edit_dir / (
        "clips_draft" if draft else ("clips_preview" if preview else "clips_graded")
    )
    clips_dir.mkdir(parents=True, exist_ok=True)

    ranges = edl["ranges"]
    sources = edl["sources"]
    multicam = bool(edl.get("multicam")) or any("layout" in r for r in ranges)

    seg_paths: list[Path] = []
    durations: list[float] = []
    print(f"extracting {len(ranges)} segment(s) → {clips_dir.name}/"
          f"{'  [multicam]' if multicam else ''}")
    if is_auto:
        print("  (auto-grade per segment: analyzing each range)")

    if multicam:
        screen_path, cam_path = _multicam_sources(sources, edit_dir)
        offset_s = float(edl.get("sync", {}).get("offset_ms", 0)) / 1000.0
        out = edl.get("output", {})
        canvas = (int(out.get("width", DEFAULT_CANVAS[0])),
                  int(out.get("height", DEFAULT_CANVAS[1])))
        screen_crop_top = float((edl.get("screen_crop") or {}).get("top", 0) or 0)
        # EDL-level vertical-reframe defaults; any range may override them.
        screen_defaults = {k: edl[k] for k in
                           ("screen_roi", "screen_fit", "screen_anchor") if k in edl}
        for i, r in enumerate(ranges):
            layout = r.get("layout", "pip")
            start, end = float(r["start"]), float(r["end"])
            duration = end - start
            out_path = clips_dir / f"seg_{i:02d}_{layout}.mp4"

            # Graphic cutaways are pre-designed cards — never auto-grade them
            # (it would shift their intended colors); resolve their picture file.
            graphic_path: Path | None = None
            if layout == "graphic":
                graphic_path = resolve_path(r["graphic_file"], edit_dir)
                seg_filter = ""
            elif is_auto:
                primary = cam_path if layout == "fullcam" else screen_path
                p_start = start if layout == "fullcam" else max(0.0, start + offset_s)
                seg_filter, _stats = auto_grade_for_clip(
                    primary, start=p_start, duration=duration, verbose=False
                )
            else:
                seg_filter = resolved

            note = r.get("beat") or r.get("note") or ""
            print(f"  [{i:02d}] {layout:<10} {start:7.2f}-{end:7.2f}  ({duration:5.2f}s)  {note}")
            if is_auto and layout != "graphic":
                print(f"        grade: {seg_filter or '(none)'}")
            extract_segment_multicam(
                r, screen_path, cam_path, offset_s, canvas, seg_filter,
                out_path, preview=preview, draft=draft, screen_crop_top=screen_crop_top,
                graphic_path=graphic_path, no_punch=no_punch,
                screen_defaults=screen_defaults,
            )
            seg_paths.append(out_path)
            durations.append(duration)
        return seg_paths, durations

    for i, r in enumerate(ranges):
        src_name = r["source"]
        src_path = resolve_path(sources[src_name], edit_dir)
        start = float(r["start"])
        end = float(r["end"])
        duration = end - start
        out_path = clips_dir / f"seg_{i:02d}_{src_name}.mp4"

        if is_auto:
            seg_filter, _stats = auto_grade_for_clip(src_path, start=start, duration=duration, verbose=False)
        else:
            seg_filter = resolved

        note = r.get("beat") or r.get("note") or ""
        print(f"  [{i:02d}] {src_name}  {start:7.2f}-{end:7.2f}  ({duration:5.2f}s)  {note}")
        if is_auto:
            print(f"        grade: {seg_filter or '(none)'}")
        extract_segment(src_path, start, duration, seg_filter, out_path, preview=preview, draft=draft)
        seg_paths.append(out_path)
        durations.append(duration)

    return seg_paths, durations


def zero_video_start(path: Path) -> bool:
    """Drag the first video frame back to PTS 0, in place. Returns True if it moved.

    A `-c copy` concat of AAC-encoded segments carries the codec's priming delay
    (1024 samples @48kHz ≈ 21ms) onto the VIDEO track: the first frame lands at
    pts>0 while the audio starts at 0, so nothing covers [0, pts) and every
    player paints the opening frame BLACK. No muxer flag fixes it
    (`-avoid_negative_ts`, `-fflags +genpts`, `-muxpreload/-muxdelay 0`,
    `-ignore_editlist`, `-itsoffset`, an MPEG-TS round trip — all no-ops here);
    the `setts` bitstream filter does.

    NOTE: shift `pts` and `dts` SEPARATELY. `setts=ts=…` sets both to the same
    value, which destroys B-frame reorder and yields duplicate timestamps."""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=start_pts", "-of", "default=nk=1:nw=1",
                        str(path)], capture_output=True, text=True).stdout.strip()
    try:
        off = int(r)
    except ValueError:
        return False
    if off <= 0:
        return False
    tmp = path.with_suffix(".zerots.mp4")
    try:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-c", "copy",
                        "-bsf:v", f"setts=pts=PTS-{off}:dts=DTS-{off}",
                        "-movflags", "+faststart", str(tmp)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError:
        tmp.unlink(missing_ok=True)
        return False   # never fail a finished render over the opening frame
    tmp.replace(path)
    return True


# -------- Lossless concat ----------------------------------------------------


def concat_segments(segment_paths: list[Path], out_path: Path, edit_dir: Path) -> None:
    """Lossless concat via the concat demuxer. No re-encode."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    concat_list = edit_dir / "_concat.txt"
    concat_list.write_text("".join(f"file '{p.resolve()}'\n" for p in segment_paths))

    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", str(concat_list),
        "-c", "copy",
        "-movflags", "+faststart",
        str(out_path),
    ]
    print(f"concat → {out_path.name}")
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    concat_list.unlink(missing_ok=True)


# -------- Crossfade concat + timeline remap ---------------------------------
#
# A hard concat plays segments back-to-back: segment k starts at
# sum(durations[:k]) — the "nominal" timeline. Crossfading OVERLAPS each pair by
# `overlaps[i]` seconds, so every segment after the first slides EARLIER by the
# sum of all preceding overlaps. That means the subtitle cues, overlay windows
# and SFX hits — which were all authored against the nominal timeline — would
# now land LATE relative to the picture. `build_timeline_remap` returns the
# per-segment actual starts plus a `remap(t)` that converts any nominal output
# time to its crossfaded position, so captions/overlays/SFX stay locked.


def _xfade_map(t: str) -> str:
    return {"fade": "fade", "slide": "slideleft", "dissolve": "dissolve",
            "wipe": "wiperight", "cut": "fade"}.get(t, "fade")


def compute_overlaps(durations: list[float], ranges: list[dict]) -> list[float]:
    """Per-boundary crossfade duration (seconds), one per segment gap (N-1).

    Reads `transition` / `transition_after_sec` off the LEFT range of each pair.
    A "cut" (or non-positive overlap) collapses to a 2-frame crossfade — a near
    hard cut that still gives xfade a valid window (a 1-frame window can fall
    entirely past the last frame in long chains and truncate the output)."""
    overlaps: list[float] = []
    for i in range(len(durations) - 1):
        o = float(ranges[i].get("transition_after_sec", 0.4))
        t = ranges[i].get("transition", "fade")
        if t == "cut" or o <= 0:
            o = 2 / FPS
        o = min(o, durations[i] - 0.05, durations[i + 1] - 0.05)
        overlaps.append(max(o, 2 / FPS))
    return overlaps


def build_timeline_remap(durations: list[float], overlaps: list[float]):
    """Return (actual_starts, remap) for a crossfaded concat.

    nominal_starts[k] = sum(durations[:k])       (hard-concat position)
    actual_starts[k]  = nominal_starts[k] - sum(overlaps[:k])   (xfade position)
    remap(t): map a nominal output time to its crossfaded output time by
    subtracting the cumulative overlap of the segment that time falls in."""
    n = len(durations)
    nominal_starts = [sum(durations[:k]) for k in range(n)]
    shift = [sum(overlaps[:k]) for k in range(n)]  # cumulative overlap before seg k
    actual_starts = [nominal_starts[k] - shift[k] for k in range(n)]

    def remap(t: float) -> float:
        for j in range(n):
            if nominal_starts[j] <= t < nominal_starts[j] + durations[j]:
                return t - shift[j]
        # Clamp out-of-range times to the first/last segment's shift.
        if t < nominal_starts[0]:
            return t - shift[0]
        return t - shift[n - 1]

    return actual_starts, remap


def concat_with_xfade(
    seg_paths: list[Path],
    durations: list[float],
    overlaps: list[float],
    transitions: list[str],
    out_path: Path,
) -> None:
    """Chain all segments with xfade (video) + acrossfade (audio) in one pass.

    Unlike the lossless demuxer concat this MUST re-encode (xfade blends pixels).
    Offsets accumulate: each xfade starts `overlaps[i]` before the running end,
    mirroring avatar-muton's `chain_transitions`."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = len(seg_paths)
    inputs: list[str] = []
    for p in seg_paths:
        inputs += ["-i", str(p)]

    fc: list[str] = []
    vlab, alab = "0:v", "0:a"
    running = durations[0]
    for i in range(n - 1):
        o = overlaps[i]
        offset = running - o
        nv, na = f"vx{i}", f"ax{i}"
        fc.append(
            f"[{vlab}][{i+1}:v]xfade=transition={_xfade_map(transitions[i])}:"
            f"duration={o:.3f}:offset={offset:.3f}[{nv}]"
        )
        fc.append(f"[{alab}][{i+1}:a]acrossfade=d={o:.3f}:c1=tri:c2=tri[{na}]")
        vlab, alab = nv, na
        running = offset + durations[i + 1]

    cmd = [
        "ffmpeg", "-y", *inputs,
        "-filter_complex", ";".join(fc),
        "-map", f"[{vlab}]", "-map", f"[{alab}]",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart",
        str(out_path),
    ]
    print(f"xfade concat → {out_path.name} ({n} segments, {n - 1} transition(s))")
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


# -------- Master SRT (Rule 5) ------------------------------------------------


PUNCT_BREAK = set(".,!?;:")


def _srt_timestamp(seconds: float) -> str:
    total_ms = int(round(seconds * 1000))
    h, rem = divmod(total_ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _words_in_range(transcript: dict, t_start: float, t_end: float) -> list[dict]:
    out: list[dict] = []
    for w in transcript.get("words", []):
        if w.get("type") != "word":
            continue
        ws = w.get("start")
        we = w.get("end")
        if ws is None or we is None:
            continue
        if we <= t_start or ws >= t_end:
            continue
        out.append(w)
    return out


def build_master_srt(
    edl: dict,
    edit_dir: Path,
    out_path: Path,
    seg_starts: list[float] | None = None,
) -> None:
    """Build an output-timeline SRT from per-source transcripts.

    - 2-word chunks (break on any punctuation in between)
    - UPPERCASE text
    - Output times computed as word.start - segment_start + segment_offset

    `seg_starts`: when crossfading, the caller passes each range's ACTUAL start
    in the crossfaded output (from `build_timeline_remap`). We then offset each
    range's cues by `seg_starts[i]` instead of the internal cumulative
    `seg_offset` (which assumes a gap-free hard concat) so captions don't drift.
    """
    transcripts_dir = edit_dir / "transcripts"
    sources = edl["sources"]

    entries: list[tuple[float, float, str]] = []
    seg_offset = 0.0

    # Multicam ranges have no "source"; captions come from the audio source
    # (the webcam mic), whose transcript shares the range's timeline.
    audio_src_name = edl.get("audio_source", "cam")
    for i, r in enumerate(edl["ranges"]):
        src_name = r.get("source") or audio_src_name
        seg_start = float(r["start"])
        seg_end = float(r["end"])
        seg_duration = seg_end - seg_start

        tr_path = transcripts_dir / f"{src_name}.json"
        if not tr_path.exists():
            print(f"  no transcript for {src_name}, skipping captions for this segment")
            seg_offset += seg_duration
            continue

        transcript = json.loads(tr_path.read_text())
        words_in_seg = _words_in_range(transcript, seg_start, seg_end)

        # Group into 2-word chunks, break on punctuation
        chunks: list[list[dict]] = []
        current: list[dict] = []
        for w in words_in_seg:
            text = (w.get("text") or "").strip()
            if not text:
                continue
            current.append(w)
            # Break if the current text ends in punctuation or we hit 2 words
            ends_in_punct = bool(text) and text[-1] in PUNCT_BREAK
            if len(current) >= 2 or ends_in_punct:
                chunks.append(current)
                current = []
        if current:
            chunks.append(current)

        # Offset this range's cues by its output start: the crossfaded actual
        # start when provided, else the hard-concat cumulative offset.
        base_offset = seg_starts[i] if seg_starts is not None else seg_offset
        for chunk in chunks:
            local_start = max(seg_start, chunk[0].get("start", seg_start))
            local_end = min(seg_end, chunk[-1].get("end", seg_end))
            out_start = max(0.0, local_start - seg_start) + base_offset
            out_end = max(0.0, local_end - seg_start) + base_offset
            if out_end <= out_start:
                out_end = out_start + 0.4
            text = " ".join((w.get("text") or "").strip() for w in chunk)
            text = re.sub(r"\s+", " ", text).strip()
            # Strip trailing punctuation for cleaner uppercase look
            text = text.rstrip(",;:")
            text = text.upper()
            entries.append((out_start, out_end, text))

        seg_offset += seg_duration

    # Sort and write as SRT
    entries.sort(key=lambda e: e[0])
    lines: list[str] = []
    for i, (a, b, t) in enumerate(entries, start=1):
        lines.append(str(i))
        lines.append(f"{_srt_timestamp(a)} --> {_srt_timestamp(b)}")
        lines.append(t)
        lines.append("")
    out_path.write_text("\n".join(lines))
    print(f"master SRT → {out_path.name} ({len(entries)} cues)")


# -------- Loudness normalization (social-ready audio) -----------------------


# Social-media standard: -14 LUFS integrated, -1 dBTP peak, LRA 11 LU.
# Matches YouTube / Instagram / TikTok / X / LinkedIn normalization targets.
LOUDNORM_I = -14.0
LOUDNORM_TP = -1.0
LOUDNORM_LRA = 11.0


def measure_loudness(video_path: Path) -> dict[str, str] | None:
    """Run ffmpeg loudnorm first pass and parse the JSON measurement.

    Returns a dict with measured_i, measured_tp, measured_lra, measured_thresh,
    target_offset, or None if measurement failed.
    """
    filter_str = (
        f"loudnorm=I={LOUDNORM_I}:TP={LOUDNORM_TP}:LRA={LOUDNORM_LRA}:print_format=json"
    )
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-nostats",
        "-i", str(video_path),
        "-af", filter_str,
        "-vn", "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    # loudnorm prints the JSON to stderr at the end of the run
    stderr = proc.stderr

    # Find the JSON block — loudnorm output contains a `{ ... }` block
    start = stderr.rfind("{")
    end = stderr.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        data = json.loads(stderr[start : end + 1])
    except json.JSONDecodeError:
        return None
    needed = {"input_i", "input_tp", "input_lra", "input_thresh", "target_offset"}
    if not needed.issubset(data.keys()):
        return None
    return data


def apply_loudnorm_two_pass(
    input_path: Path,
    output_path: Path,
    preview: bool = False,
) -> bool:
    """Run two-pass loudnorm on input_path, write normalized copy to output_path.

    Returns True on success, False if measurement failed (caller should fall
    back to copying the input unchanged).

    In preview mode, skips the measurement pass and uses a one-pass approximation
    for speed. Final mode always does the proper two-pass.
    """
    # aresample=async first: if the input audio still carries concat PTS jitter
    # (e.g. no-SFX renders where the composite stream-copied the base), the
    # loudnorm re-encode would turn it into schedule holes and A/V drift.
    if preview:
        # One-pass approximation — faster, slightly less accurate.
        filter_str = (
            "aresample=async=1000:first_pts=0,"
            f"loudnorm=I={LOUDNORM_I}:TP={LOUDNORM_TP}:LRA={LOUDNORM_LRA}"
        )
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-nostats",
            "-i", str(input_path),
            "-c:v", "copy",
            "-af", filter_str,
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-movflags", "+faststart",
            str(output_path),
        ]
        print(f"  loudnorm (1-pass preview) → {output_path.name}")
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        return True

    # Full two-pass
    print(f"  loudnorm pass 1: measuring {input_path.name}")
    measurement = measure_loudness(input_path)
    if measurement is None:
        print("  loudnorm measurement failed — falling back to 1-pass")
        return apply_loudnorm_two_pass(input_path, output_path, preview=True)

    print(f"    measured: I={measurement['input_i']} LUFS  "
          f"TP={measurement['input_tp']}  LRA={measurement['input_lra']}")

    filter_str = (
        "aresample=async=1000:first_pts=0,"
        f"loudnorm=I={LOUDNORM_I}:TP={LOUDNORM_TP}:LRA={LOUDNORM_LRA}"
        f":measured_I={measurement['input_i']}"
        f":measured_TP={measurement['input_tp']}"
        f":measured_LRA={measurement['input_lra']}"
        f":measured_thresh={measurement['input_thresh']}"
        f":offset={measurement['target_offset']}"
        f":linear=true"
    )
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-nostats",
        "-i", str(input_path),
        "-c:v", "copy",
        "-af", filter_str,
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart",
        str(output_path),
    ]
    print(f"  loudnorm pass 2: normalizing → {output_path.name}")
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return True


# -------- Final compositing (Rule 1 + Rule 4) -------------------------------


_FILTER_CACHE: dict[str, bool] = {}


def ffmpeg_has_filter(name: str) -> bool:
    """True if the local ffmpeg build exposes filter `name` (cached).

    Some builds (e.g. Homebrew ffmpeg without libass) ship no `subtitles`
    filter, so burning captions would crash. Callers degrade gracefully.
    """
    if name not in _FILTER_CACHE:
        try:
            out = subprocess.run(
                ["ffmpeg", "-hide_banner", "-filters"],
                capture_output=True, text=True,
            ).stdout
            names = {p[1] for line in out.splitlines()
                     if len(p := line.split()) > 1}
            _FILTER_CACHE[name] = name in names
        except Exception:
            _FILTER_CACHE[name] = False
    return _FILTER_CACHE[name]


def build_final_composite(
    base_path: Path,
    overlays: list[dict],
    subtitles_path: Path | None,
    out_path: Path,
    edit_dir: Path,
    sfx: list[dict] | None = None,
    sub_margin: int = 90,
    time_map=None,
    music: dict | None = None,
) -> None:
    """Final pass: base → overlays (PTS-shifted) → subtitles LAST → out, and
    mix timed sound effects into the audio.

    `sfx` entries: {"file": "sfx/whoosh.wav", "at": <output_seconds>, "gain_db": -6}
    Each is delayed to land exactly at `at` on the output timeline and amix'd
    over the base audio (with a limiter to avoid clipping).

    `time_map`: optional callable mapping a nominal output time to the crossfaded
    output time (from `build_timeline_remap`). Applied to every overlay's
    `start_in_output` and every sfx `at` so, when segments are crossfaded (and
    thus slid earlier), graphics and SFX still land on the right frame. Defaults
    to identity (hard-concat timeline).

    `music`: optional {"file": ..., "volume_db": -22} background bed. Mixed under
    the voice with sidechain ducking (the voice keys a compressor on the music,
    so the bed drops whenever someone speaks). Looped to cover the whole video.

    If there are no overlays, no subtitles, no sfx and no music, copy base→out.
    """
    sfx = sfx or []
    tmap = time_map if time_map is not None else (lambda x: x)
    has_overlays = bool(overlays)
    has_subs = subtitles_path is not None and subtitles_path.exists()
    has_sfx = bool(sfx)
    has_music = bool(music and music.get("file"))

    # Graceful fallback: if captions were requested but this ffmpeg has no
    # `subtitles` filter (built without libass), don't crash the whole render —
    # skip the burn-in and drop the .srt next to the output so it isn't lost.
    if has_subs and not ffmpeg_has_filter("subtitles"):
        print("  warning: ffmpeg has no 'subtitles' filter (no libass) — skipping "
              "subtitle burn-in; wrote .srt next to the output instead.")
        try:
            out_path.with_suffix(".srt").write_bytes(subtitles_path.read_bytes())
        except Exception:
            pass
        has_subs = False

    if not has_overlays and not has_subs and not has_sfx and not has_music:
        run(["ffmpeg", "-y", "-i", str(base_path), "-c", "copy", str(out_path)], quiet=True)
        return

    inputs: list[str] = ["-i", str(base_path)]
    for ov in overlays:
        inputs += ["-i", str(resolve_path(ov["file"], edit_dir))]
    for s in sfx:
        inputs += ["-i", str(resolve_path(s["file"], edit_dir))]
    music_idx = None
    if has_music:
        # Loop the bed so it always outlasts the voice; amix duration=first
        # clamps the final length back to the voice track.
        music_idx = 1 + len(overlays) + len(sfx)
        inputs += ["-stream_loop", "-1", "-i", str(resolve_path(music["file"], edit_dir))]

    filter_parts: list[str] = []

    # ---- video: overlays (PTS-shifted) then subtitles LAST -----------------
    for idx, ov in enumerate(overlays, start=1):
        t = tmap(float(ov["start_in_output"]))
        filter_parts.append(f"[{idx}:v]setpts=PTS-STARTPTS+{t}/TB[a{idx}]")
    current = "[0:v]"
    for idx, ov in enumerate(overlays, start=1):
        t = tmap(float(ov["start_in_output"]))
        end = t + float(ov["duration"])
        next_label = f"[v{idx}]"
        filter_parts.append(
            f"{current}[a{idx}]overlay=enable='between(t,{t:.3f},{end:.3f})'{next_label}"
        )
        current = next_label

    if has_subs:
        subs_abs = str(subtitles_path.resolve()).replace(":", r"\:").replace("'", r"\'")
        filter_parts.append(
            f"{current}subtitles='{subs_abs}':force_style='{sub_force_style(sub_margin)}'[outv]"
        )
        video_map, video_codec = "[outv]", ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"]
    elif has_overlays:
        filter_parts.append(f"{current}null[outv]")
        video_map, video_codec = "[outv]", ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"]
    else:
        video_map, video_codec = "0:v", ["-c:v", "copy"]

    # ---- audio: mix voice (+ ducked music) + timed SFX ---------------------
    if has_sfx or has_music:
        # aresample=async first: a lossless-concat base carries small AAC-priming
        # PTS overlaps at every segment boundary; fed raw into amix they become
        # large forward holes in the encoded schedule (audio ends up seconds
        # shorter than video and playback drifts progressively out of sync). The
        # xfade re-encode path yields a clean base, but keeping this is harmless.
        mix_labels: list[str] = []
        if has_music:
            # Split the voice: one copy into the mix, one to KEY the sidechain.
            filter_parts.append("[0:a]aresample=async=1000:first_pts=0,asplit=2[va][vk]")
            vol_db = float(music.get("volume_db", -22))
            filter_parts.append(f"[{music_idx}:a]volume={vol_db}dB[m]")
            filter_parts.append(
                "[m][vk]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[duck]"
            )
            mix_labels += ["[va]", "[duck]"]
        else:
            filter_parts.append("[0:a]aresample=async=1000:first_pts=0[abase]")
            mix_labels.append("[abase]")

        for j, s in enumerate(sfx):
            inp = 1 + len(overlays) + j
            at_ms = max(0, int(round(tmap(float(s.get("at", 0))) * 1000)))
            gain = float(s.get("gain_db", 0))
            filter_parts.append(f"[{inp}:a]adelay={at_ms}:all=1,volume={gain}dB[sfx{j}]")
            mix_labels.append(f"[sfx{j}]")

        # duration=first: lock output length to the voice (first input). amix's
        # default `longest` mis-extends the timeline (SFX adelay-padded to late
        # offsets, or the looped music) well past the voice; the voice is the
        # canonical length, so clamp to it. SFX/music sit UNDER the voice.
        filter_parts.append(
            f"{''.join(mix_labels)}amix=inputs={len(mix_labels)}:normalize=0:"
            f"duration=first:dropout_transition=0,alimiter=limit=0.95[outa]"
        )
        audio_map, audio_codec = "[outa]", ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    else:
        audio_map, audio_codec = "0:a", ["-c:a", "copy"]

    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", ";".join(filter_parts),
        "-map", video_map,
        "-map", audio_map,
        *video_codec,
        *audio_codec,
        "-movflags", "+faststart",
        str(out_path),
    ]
    print(f"compositing → {out_path.name}")
    print(f"  overlays: {len(overlays)}, subtitles: {'yes' if has_subs else 'no'}, "
          f"sfx: {len(sfx)}, music: {'yes' if has_music else 'no'}")
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


# -------- Main ---------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description="Render a video from an EDL")
    ap.add_argument("edl", type=Path, help="Path to edl.json")
    ap.add_argument("-o", "--output", type=Path, required=True, help="Output video path")
    ap.add_argument(
        "--preview",
        action="store_true",
        help="Preview mode: 1080p, medium, CRF 22 — evaluable for QC, faster than final.",
    )
    ap.add_argument(
        "--draft",
        action="store_true",
        help="Draft mode: 720p, ultrafast, CRF 28 — cut-point verification only.",
    )
    ap.add_argument(
        "--build-subtitles",
        action="store_true",
        help="Build master.srt from transcripts + EDL offsets before compositing",
    )
    ap.add_argument(
        "--no-subtitles",
        action="store_true",
        help="Skip subtitles even if the EDL references one",
    )
    ap.add_argument(
        "--subs-mode",
        choices=["burn", "sidecar", "off"],
        default=None,
        help="burn = burn captions INTO the video; sidecar = write master.srt next to the "
             "output, NOT burned (e.g. YouTube); off = none. Overrides --build/--no-subtitles.",
    )
    ap.add_argument(
        "--no-loudnorm",
        action="store_true",
        help="Skip audio loudness normalization. Default is on (-14 LUFS, -1 dBTP, LRA 11).",
    )
    ap.add_argument(
        "--no-punch",
        action="store_true",
        help="Disable the slow punch-in zoom on multicam segments (default on).",
    )
    ap.add_argument(
        "--no-xfade",
        action="store_true",
        help="Hard-cut concat instead of crossfading multicam segments (default xfade).",
    )
    args = ap.parse_args()

    edl_path = args.edl.resolve()
    if not edl_path.exists():
        sys.exit(f"edl not found: {edl_path}")

    edl = json.loads(edl_path.read_text())
    edit_dir = edl_path.parent
    out_path = args.output.resolve()

    # 1. Extract per-segment (auto-grade per range if EDL grade is "auto")
    segment_paths, durations = extract_all_segments(
        edl, edit_dir, preview=args.preview, draft=args.draft, no_punch=args.no_punch
    )

    # 2. Concat → base. Multicam segments share canvas+fps, so we can crossfade
    #    them; that overlap shifts the whole timeline, so we also build a remap
    #    to keep subtitles/overlays/SFX aligned (see build_timeline_remap).
    if args.draft:
        base_name = "base_draft.mp4"
    elif args.preview:
        base_name = "base_preview.mp4"
    else:
        base_name = "base.mp4"
    base_path = edit_dir / base_name

    ranges = edl["ranges"]
    multicam = bool(edl.get("multicam")) or any("layout" in r for r in ranges)
    use_xfade = (not args.no_xfade) and multicam and len(segment_paths) > 1

    seg_starts: list[float] | None = None
    time_map = None
    if use_xfade:
        overlaps = compute_overlaps(durations, ranges)
        transitions = [ranges[i].get("transition", "fade") for i in range(len(ranges) - 1)]
        seg_starts, time_map = build_timeline_remap(durations, overlaps)
        concat_with_xfade(segment_paths, durations, overlaps, transitions, base_path)
    else:
        concat_segments(segment_paths, base_path, edit_dir)

    # 3. Subtitles: burn | sidecar | off.
    #   burn    → build/resolve the SRT and burn it into the picture.
    #   sidecar → build the SRT and drop it NEXT TO the output, never burned
    #             (e.g. YouTube long-form: the user wants a .srt file, not baked-in text).
    #   off     → nothing.
    # `--subs-mode` overrides the legacy --build-subtitles / --no-subtitles flags.
    subs_mode = args.subs_mode or (
        "off" if args.no_subtitles else ("burn" if args.build_subtitles else "off")
    )
    subs_path: Path | None = None  # set ONLY for burn mode
    if subs_mode != "off":
        if edl.get("subtitles") and not args.build_subtitles:
            srt = resolve_path(edl["subtitles"], edit_dir)
            if not srt.exists():
                print(f"warning: subtitles path in EDL does not exist: {srt}")
                srt = None
        else:
            srt = edit_dir / "master.srt"
            build_master_srt(edl, edit_dir, srt, seg_starts=seg_starts)
        if srt and srt.exists():
            if subs_mode == "burn":
                subs_path = srt
            else:  # sidecar: never burn — leave the .srt beside the output
                try:
                    out_path.with_suffix(".srt").write_bytes(srt.read_bytes())
                    print(f"  subtitles: .srt sidecar next to {out_path.name} (not burned)")
                except Exception:
                    pass

    # 4. Composite (overlays + subtitles LAST + SFX mix) → intermediate path
    overlays = edl.get("overlays") or []
    sfx = edl.get("sfx") or []
    music = edl.get("music") or None
    _out = edl.get("output", {})
    _canvas = (int(_out.get("width", DEFAULT_CANVAS[0])), int(_out.get("height", DEFAULT_CANVAS[1])))
    sub_margin = int(edl.get("subtitle_margin") or sub_margin_for_canvas(_canvas))
    if args.no_loudnorm:
        # Composite directly to final output
        build_final_composite(base_path, overlays, subs_path, out_path, edit_dir,
                              sfx=sfx, sub_margin=sub_margin, time_map=time_map, music=music)
    else:
        # Composite to a temp file, then run loudnorm → final output
        tmp_composite = out_path.with_suffix(".prenorm.mp4")
        build_final_composite(base_path, overlays, subs_path, tmp_composite, edit_dir,
                              sfx=sfx, sub_margin=sub_margin, time_map=time_map, music=music)
        print("loudness normalization → social-ready (-14 LUFS / -1 dBTP / LRA 11)")
        apply_loudnorm_two_pass(tmp_composite, out_path, preview=args.draft)
        tmp_composite.unlink(missing_ok=True)

    # 6. The opening frame must land on PTS 0 or players show black before it.
    if zero_video_start(out_path):
        print("  first frame pulled back to PTS 0 (AAC priming offset removed)")

    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"\ndone: {out_path} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
