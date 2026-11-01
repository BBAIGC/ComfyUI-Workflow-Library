"""Bounded local-media cover preparation; no original asset is modified."""
from __future__ import annotations
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import parse_qs, urlsplit
import uuid

HERE = Path(__file__).resolve().parent
BASE = Path(os.environ.get("COMFYUI_BASE_DIR", str(HERE.parent.parent if HERE.parent.name == "custom_nodes" else HERE.parent)))
ROOTS = {kind: (BASE / kind).resolve() for kind in ("input", "output", "temp")}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".gif"}


class CoverError(Exception):
    pass


def resolve_media(media):
    if not isinstance(media, dict):
        raise CoverError("媒体引用格式无效。")
    values = dict(media)
    if not values.get("filename"):
        url = values.get("url") or values.get("preview_url") or values.get("originalUrl")
        if not isinstance(url, str):
            raise CoverError("媒体缺少原文件引用。")
        parsed = urlsplit(url)
        if parsed.scheme and (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost") or parsed.port != 8000):
            raise CoverError("封面只接受当前 ComfyUI 的本地媒体。")
        if parsed.netloc and not parsed.scheme:
            raise CoverError("媒体地址无效。")
        if parsed.path != "/view":
            raise CoverError("媒体引用必须来自 ComfyUI 原文件预览。")
        query = parse_qs(parsed.query)
        for name in ("filename", "subfolder", "type"):
            values[name] = query.get(name, [""])[0]
    kind = str(values.get("type") or "output")
    if kind == "custom":
        root_id = str(values.get("root_id") or "")
        store = BASE / "output" / "_mjr_index" / "custom_roots.json"
        try:
            if not root_id or store.stat().st_size > 1024 * 1024:
                raise ValueError
            data = json.loads(store.read_text(encoding="utf-8"))
            matching = [row for row in data.get("roots", []) if isinstance(row, dict) and row.get("id") == root_id]
            root = Path(matching[0]["path"]).resolve() if len(matching) == 1 else None
        except (ValueError, OSError, KeyError, TypeError):
            root = None
        if root is None or not root.is_dir():
            raise CoverError("未找到资源管理器已登记的媒体根目录，请使用输入或输出目录中的媒体。")
    else:
        root = ROOTS.get(kind)
    if root is None:
        raise CoverError("不支持此媒体目录，仅可使用当前 ComfyUI 的输入、输出或临时文件。")
    filename = str(values.get("filename") or "").replace("\\", "/")
    subfolder = str(values.get("subfolder") or "").replace("\\", "/")
    if not filename or any("\x00" in item or ":" in item or Path(item).is_absolute() for item in (filename, subfolder)):
        raise CoverError("媒体文件路径无效。")
    path = (root / subfolder / filename).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise CoverError("原媒体文件不存在，或引用超出了允许的媒体目录。")
    media_kind = "video" if values.get("kind") == "video" or path.suffix.lower() in VIDEO_EXTENSIONS - {".gif"} else "image"
    supported = VIDEO_EXTENSIONS if media_kind == "video" else IMAGE_EXTENSIONS
    if path.suffix.lower() not in supported:
        raise CoverError("此文件不是支持的图片或视频。")
    return path, media_kind


def prepare_image(source, directory, identifier):
    from PIL import Image, ImageOps, UnidentifiedImageError
    target = directory / f"{identifier}-media-{uuid.uuid4().hex[:16]}.webp"
    try:
        with Image.open(source) as original:
            if original.width * original.height > 40_000_000:
                raise CoverError("封面图片超过4000万像素。")
            image = ImageOps.exif_transpose(original)
            image.thumbnail((1920, 1200))
            image.convert("RGB").save(target, "WEBP", quality=84, method=3)
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError) as error:
        target.unlink(missing_ok=True)
        raise CoverError("无法读取这张封面图片。") from error
    return {"kind": "image", "poster": target.name}


def executable(name):
    found = shutil.which(name)
    if found:
        return found
    if name == 'ffmpeg':
        try:
            import imageio_ffmpeg
            return imageio_ffmpeg.get_ffmpeg_exe()
        except (ImportError, RuntimeError):
            return None
    return None


def run(command, timeout):
    result = subprocess.run(command, capture_output=True, timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise CoverError("视频封面转换未完成，请换用兼容的视频文件。")
    return result.stdout


def prepare_video(source, directory, identifier):
    ffmpeg, ffprobe = executable("ffmpeg"), executable("ffprobe")
    if not ffmpeg:
        raise CoverError("未找到本机 ffmpeg，暂时不能生成视频封面。")
    duration = 0.0
    if ffprobe:
        try:
            data = json.loads(run([ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration", "-of", "json", str(source)], 8))
            duration = float(data.get("format", {}).get("duration") or 0)
            if not math.isfinite(duration):
                duration = 0.0
        except (CoverError, ValueError, TypeError, OSError, subprocess.TimeoutExpired):
            duration = 0.0
    start = max(0, min(max(0, duration - 3.5), duration * .2))
    stem = f"{identifier}-media-{uuid.uuid4().hex[:16]}"
    video, poster = directory / (stem + ".mp4"), directory / (stem + ".webp")
    scale = "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
    common = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    source_options = ["-protocol_whitelist", "file,pipe", "-hwaccel", "none", "-threads", "1", "-ss", str(round(start, 3)), "-i", str(source)]
    animated = False
    try:
        run(common + source_options + ["-map", "0:v:0", "-t", "3.5", "-an", "-sn", "-dn", "-vf", scale + ",fps=12",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-maxrate", "600k", "-bufsize", "1200k",
            "-pix_fmt", "yuv420p", "-threads", "2", "-map_metadata", "-1", "-movflags", "+faststart", str(video)], 60)
        animated = video.is_file() and video.stat().st_size > 0
    except (CoverError, OSError, subprocess.TimeoutExpired):
        video.unlink(missing_ok=True)
    try:
        poster_input = ["-protocol_whitelist", "file,pipe", "-threads", "1", "-i", str(video)] if animated else source_options
        run(common + poster_input + ["-map", "0:v:0", "-frames:v", "1", "-an", "-vf", scale, "-c:v", "libwebp", "-quality", "82", "-threads", "1", str(poster)], 15)
        if not poster.is_file() or not poster.stat().st_size:
            raise CoverError("视频中没有可用画面。")
    except (CoverError, OSError, subprocess.TimeoutExpired) as error:
        video.unlink(missing_ok=True)
        poster.unlink(missing_ok=True)
        raise CoverError("无法读取视频画面，已保留原封面。") from error
    result = {"kind": "video", "poster": poster.name}
    if animated:
        result["video"] = video.name
    return result
