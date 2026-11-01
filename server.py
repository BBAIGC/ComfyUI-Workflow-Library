"""Local workflow catalogue. Existing ComfyUI workflow files are always read-only.

Run with the ComfyUI environment's Python (Pillow is used for bounded covers).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import io
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import textwrap
import threading
import time
import uuid
from datetime import datetime, timezone
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import urlopen
from media_covers import CoverError, resolve_media, prepare_image, prepare_video, VIDEO_EXTENSIONS
from text_covers import suggestion as text_cover_suggestion, short_name as text_cover_short_name

VERSION = "1.5.0"
SERVICE = "comfy-workflow-library"
ROOT = Path(__file__).resolve().parent
DEFAULT_BASE = ROOT.parent.parent if ROOT.parent.name == "custom_nodes" else ROOT.parent
DEFAULT_WORKFLOWS = Path(os.environ.get("COMFYUI_WORKFLOWS_DIR", str(DEFAULT_BASE / "user/default/workflows")))
DESKTOP_EXE = Path(os.environ.get("COMFY_DESKTOP_EXE", str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Comfy Desktop/Comfy Desktop.exe")))
MAX_BODY = 24 * 1024 * 1024
MAX_WORKFLOW = 16 * 1024 * 1024
DEFAULT_CATEGORIES = [{"id": "img", "name": "图片"}, {"id": "video", "name": "视频"}, {"id": "upscale", "name": "放大"}]


def iso_time(timestamp=None):
    return datetime.fromtimestamp(time.time() if timestamp is None else timestamp, timezone.utc).isoformat()


class APIError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def validate_workflow(workflow):
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
        raise APIError(400, "请选择 ComfyUI 画布工作流 JSON，文件应包含 nodes 数组。")
    nodes = workflow["nodes"]
    if len(nodes) > 20000 or any(not isinstance(n, dict) or "id" not in n for n in nodes):
        raise APIError(400, "工作流节点格式无效或节点数量过多。")
    identifiers = [str(n["id"]) for n in nodes]
    if len(set(identifiers)) != len(identifiers):
        raise APIError(400, "工作流存在重复节点 ID。")
    if "links" in workflow and not isinstance(workflow["links"], (list, dict)):
        raise APIError(400, "工作流连线格式无效。")
    return workflow


def classification(name):
    name = name.lower()
    if any(s in name for s in ("vosr", "seedvr", "upscale", "超分", "放大", "dlss")):
        return "upscale"
    if any(s in name for s in ("视频", "多分镜", "h3", "ltx", "wan2", "video", "minimax")):
        return "video"
    return "img"


def version_family(relative_path):
    """Use the original filename and directory; display aliases never merge files."""
    path = Path(relative_path)
    stem = path.stem
    versions = re.findall(r"(?i)(?:^|[_\s-])v(\d+)\.(\d+)\.(\d+)(?=$|[_\s-])", stem)
    version = max((tuple(map(int, match)) for match in versions), default=(0, 0, 0))
    is_codex = bool(re.search(r"(?i)(?:^|[_\s-])codex(?=$|[_\s-])", stem))
    family = re.sub(r"(?i)(?:^|[_\s-])v\d+\.\d+\.\d+(?=$|[_\s-])", "", stem)
    family = re.sub(r"(?i)(?:^|[_\s-])codex(?=$|[_\s-])", "", family)
    family = re.sub(r"_+", "_", family).strip(" _-")
    return (path.parent.as_posix().casefold(), family.casefold()), (is_codex, version, stem.casefold())


def latest_entries(entries):
    groups = {}
    for entry in entries:
        family, rank = version_family(entry["path"])
        if family not in groups or rank > groups[family][0]:
            groups[family] = rank, entry
    return [entry for _, entry in groups.values()]


def family_id(relative_path):
    family, _ = version_family(relative_path)
    return hashlib.sha256(json.dumps(family, ensure_ascii=False).encode("utf-8")).hexdigest()[:24]


def desktop_running():
    """Match the installed executable, not an unrelated process with a similar name."""
    if os.name != "nt":
        return False
    import ctypes
    from ctypes import wintypes
    class ProcessEntry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        return False
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        valid = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while valid:
            if entry.szExeFile.lower() == DESKTOP_EXE.name.lower():
                handle = kernel.OpenProcess(0x1000, False, entry.th32ProcessID)
                if handle:
                    try:
                        length = wintypes.DWORD(32768)
                        path = ctypes.create_unicode_buffer(length.value)
                        if kernel.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(length)) and os.path.normcase(path.value) == os.path.normcase(str(DESKTOP_EXE)):
                            return True
                    finally:
                        kernel.CloseHandle(handle)
            valid = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    return False


def finite(value, fallback=0):
    try:
        value = float(value)
        return value if math.isfinite(value) and abs(value) <= 1_000_000 else fallback
    except (TypeError, ValueError, OverflowError):
        return fallback


def vector_pair(value, fallback):
    if isinstance(value, dict):
        value = [value.get("0", fallback[0]), value.get("1", fallback[1])]
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return fallback
    return finite(value[0], fallback[0]), finite(value[1], fallback[1])


def public_widget_lines(node, columns, maximum):
    """Keep ordinary prompt text readable; credentials are never diagram labels."""
    if re.search(r"(?i)(credential|api.?key|password|secret|token.?input)", str(node.get("type", ""))):
        return []
    values = node.get("widgets_values")
    if not isinstance(values, list):
        return []
    names = [str(slot.get("widget", {}).get("name") or slot.get("name") or "") for slot in node.get("inputs", []) if isinstance(slot, dict) and isinstance(slot.get("widget"), dict)]
    lines = []
    for index, value in enumerate(values[:40]):
        name = names[index] if index < len(names) else ""
        if re.search(r"(?i)(api.?key|password|secret|access.?token|refresh.?token|authorization|密钥|密码|令牌)", name):
            continue
        if not isinstance(value, (str, bool, int, float)):
            continue
        value = str(value)
        if value.lstrip().startswith(("{", "[")):
            continue
        if re.search(r"(?i)(?:bearer\s+\S+|sk-[a-z0-9_-]{12,}|(?:api[_ -]?key|password|secret|access[_ -]?token)\s*[=:])", value):
            continue
        value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", value)[:6000]
        if name:
            value = name + "：" + value
        for paragraph in value.splitlines() or [value]:
            lines.extend(textwrap.wrap(paragraph, width=max(12, columns), replace_whitespace=False) or [""])
            if len(lines) >= maximum:
                return lines[:maximum]
    return lines[:maximum]


def graph_svg(workflow):
    """Draw actual outer-graph positions without rendering prompts or widget values."""
    nodes = workflow.get("nodes", [])
    layout = {}
    for node in nodes:
        x, y = vector_pair(node.get("pos"), (0, 0))
        w, h = vector_pair(node.get("size"), (240, 120))
        layout[str(node["id"])] = (x, y, min(1600, max(160, w)), min(3000, max(70, h)))
    if layout:
        min_x = min(n[0] for n in layout.values()) - 80
        min_y = min(n[1] for n in layout.values()) - 80
        max_x = max(n[0] + n[2] for n in layout.values()) + 80
        max_y = max(n[1] + n[3] for n in layout.values()) + 80
    else:
        min_x, min_y, max_x, max_y = 0, 0, 800, 450
    width, height = max_x - min_x, max_y - min_y
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="{min_x} {min_y} {width} {height}" preserveAspectRatio="xMidYMid meet">',
           '<defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#282828" stroke-width="1"/></pattern></defs>',
           f'<rect x="{min_x}" y="{min_y}" width="{width}" height="{height}" fill="#171819"/>',
           f'<rect x="{min_x}" y="{min_y}" width="{width}" height="{height}" fill="url(#g)"/>']
    for group in workflow.get("groups", [])[:500]:
        if not isinstance(group, dict):
            continue
        box = group.get("bounding")
        if not isinstance(box, (list, tuple)) or len(box) < 4:
            continue
        x, y, w, h = [finite(n) for n in box[:4]]
        if w <= 0 or h <= 0:
            continue
        svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="5" fill="#233039" fill-opacity=".35" stroke="#425764" stroke-width="2"/>')
        svg.append(f'<text x="{x+14}" y="{y+25}" fill="#95aab7" font-size="19" font-family="Segoe UI,Microsoft YaHei,sans-serif">{escape(str(group.get("title", ""))[:100])}</text>')
    links = workflow.get("links", [])
    if isinstance(links, dict):
        links = list(links.values())
    for link in links[:50000]:
        if isinstance(link, dict):
            source, target = str(link.get("origin_id")), str(link.get("target_id"))
            source_slot, target_slot = finite(link.get("origin_slot")), finite(link.get("target_slot"))
        elif isinstance(link, list) and len(link) >= 5:
            source, target = str(link[1]), str(link[3])
            source_slot, target_slot = finite(link[2]), finite(link[4])
        else:
            continue
        if source not in layout or target not in layout:
            continue
        sx, sy, sw, sh = layout[source]
        tx, ty, tw, th = layout[target]
        sx += sw
        sy += min(sh-12, 48 + source_slot * 20)
        ty += min(th-12, 48 + target_slot * 20)
        bend = max(45, min(450, abs(tx-sx) * .45))
        svg.append(f'<path d="M {sx} {sy} C {sx+bend} {sy},{tx-bend} {ty},{tx} {ty}" fill="none" stroke="#56798b" stroke-width="2.5" opacity=".65"/>')
    for node in nodes:
        x, y, w, h = layout[str(node["id"])]
        title = escape(str(node.get("title") or node.get("type") or "节点")[:max(12, int(w/12))])
        svg += [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="7" fill="#2c2d2f" stroke="#4b4c50" stroke-width="2"/>',
                f'<path d="M {x+7} {y} H {x+w-7} Q {x+w} {y} {x+w} {y+7} V {y+30} H {x} V {y+7} Q {x} {y} {x+7} {y}" fill="#3a4147"/>',
                f'<text x="{x+12}" y="{y+21}" fill="#eee" font-size="15" font-family="Segoe UI,Microsoft YaHei,sans-serif">{title}</text>']
        for key, side in (("inputs", 0), ("outputs", 1)):
            for i, slot in enumerate(node.get(key, [])[:min(12, int((h-45)/20))]):
                if not isinstance(slot, dict):
                    continue
                label = escape(str(slot.get("label") or slot.get("name") or "")[:22])
                cy = y+48+i*20
                cx = x+w if side else x
                svg.append(f'<circle cx="{cx}" cy="{cy}" r="4" fill="#80a3b1"/>')
                svg.append(f'<text x="{cx-11 if side else cx+11}" y="{cy+4}" text-anchor="{"end" if side else "start"}" fill="#b5b8bc" font-size="11" font-family="Segoe UI,Microsoft YaHei,sans-serif">{label}</text>')
        slots_height = min(12, max(len(node.get("inputs", [])), len(node.get("outputs", [])))) * 20
        text_top = y + 58 + slots_height
        room = max(0, min(70, int((y+h-14-text_top)/17)))
        for index, line in enumerate(public_widget_lines(node, int((w-26)/9), room) if room else []):
            svg.append(f'<text x="{x+13}" y="{text_top+index*17}" fill="#c7c9cc" font-size="13" font-family="Segoe UI,Microsoft YaHei,sans-serif">{escape(line)}</text>')
    if not nodes:
        svg.append('<text x="400" y="225" text-anchor="middle" fill="#a0a0a0" font-size="22" font-family="Microsoft YaHei,sans-serif">空白工作流</text>')
    svg.append("</svg>")
    return "".join(svg).encode("utf-8")


class Library:
    def __init__(self, workflows, data_dir, no_launch=False):
        self.workflows = Path(workflows).resolve()
        self.data_dir = Path(data_dir).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "covers").mkdir(exist_ok=True)
        self.state_path = self.data_dir / "library.json"
        self.lock = threading.RLock()
        self.token = secrets.token_urlsafe(32)
        self.no_launch = no_launch
        self.state = {"version": 2, "categories": DEFAULT_CATEGORIES.copy(), "entries": {}, "members": {}}
        if self.state_path.exists():
            try:
                parsed = json.loads(self.state_path.read_text(encoding="utf-8"))
                if isinstance(parsed.get("entries"), dict) and isinstance(parsed.get("categories"), list):
                    self.state = parsed
            except (ValueError, OSError):
                raise RuntimeError("工作流库元数据损坏；已保留原文件，请先检查 data/library.json。")
        self.jobs = {}
        self.clients = {}
        self._online_checked = 0
        self._online_success = 0
        self._online = False
        self._probe_lock = threading.Lock()
        self._cover_lock = threading.Lock()
        self._workflow_cache = {}
        self._facts_cache = {}
        self._suggestion_cache = {}
        self._launch_time = 0
        self.hidden_version_count = 0
        self.migrate_memberships()

    def migrate_memberships(self):
        """Keep all cover fields and membership removals while adding categories."""
        if self.state.get("version", 1) >= 2:
            return
        if self.state_path.exists():
            backup = self.data_dir / ("library-before-category-memberships-" + str(time.time_ns()) + ".json")
            shutil.copy2(self.state_path, backup)
        members = self.state.get("members")
        if isinstance(members, dict):
            converted = {}
            for family, value in members.items():
                categories = value if isinstance(value, list) else []
                if not categories:
                    categories = list(dict.fromkeys(e.get("category", "img") for e in self.state["entries"].values() if family_id(e["path"]) == family))
                converted[family] = categories or ["img"]
            self.state["members"] = converted
        self.state["version"] = 2
        if self.state_path.exists():
            self.save()

    def category_ids(self, relative):
        value = self.state.get("members", {}).get(family_id(relative))
        if value is None:
            return []
        if isinstance(value, list):
            return list(dict.fromkeys(value))
        return list(dict.fromkeys(e.get("category", "img") for e in self.state["entries"].values() if family_id(e["path"]) == family_id(relative))) or ["img"]

    def set_categories(self, relative, categories):
        categories = list(dict.fromkeys(categories))
        family = family_id(relative)
        if categories:
            self.state.setdefault("members", {})[family] = categories
        else:
            self.state.setdefault("members", {}).pop(family, None)
        for metadata in self.state["entries"].values():
            if family_id(metadata["path"]) == family:
                metadata["categoryIds"] = categories
                if categories:
                    metadata["category"] = categories[0]

    def save(self):
        temporary = self.state_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, self.state_path)

    def resolve_path(self, value):
        value = str(value or "").replace("\\", "/")
        if value.startswith("workflows/"):
            value = value[len("workflows/"):]
        if not value or "\x00" in value:
            raise APIError(400, "工作流路径无效。")
        supplied = Path(value)
        if supplied.is_absolute():
            path = supplied.resolve()
        elif ":" in value:
            raise APIError(400, "工作流路径无效。")
        else:
            path = (self.workflows / value).resolve()
        if not path.is_relative_to(self.workflows):
            raise APIError(400, "工作流必须位于当前 ComfyUI 工作流目录内。")
        if path.is_dir() or path.suffix.lower() != ".json":
            raise APIError(400, "请拖入具体工作流文件，不支持拖入文件夹。")
        if not path.exists():
            # Only verified real paths may correct an encoded/repeated prefix.
            # An exact filename containing '%' or workflows/ subfolder wins first.
            representations = [value]
            decoded = unquote(value)
            if decoded != value:
                representations.append(decoded)
            verified = set()
            for representation in representations:
                candidates = [representation]
                while representation.startswith("workflows/"):
                    representation = representation[len("workflows/"):]
                    candidates.append(representation)
                for candidate in candidates:
                    supplied_candidate = Path(candidate)
                    candidate_path = (supplied_candidate if supplied_candidate.is_absolute() else self.workflows / candidate).resolve()
                    if candidate_path.is_relative_to(self.workflows) and candidate_path.is_file() and candidate_path.suffix.lower() == ".json":
                        verified.add(candidate_path)
            if len(verified) > 1:
                raise APIError(409, "工作流路径存在多种匹配，请拖入原列表中的具体文件。")
            if verified:
                path = next(iter(verified))
        if not path.exists() and "/" not in value:
            candidates = [candidate.resolve() for candidate in self.workflows.rglob("*.json") if candidate.name.casefold() == value.casefold() and candidate.resolve().is_relative_to(self.workflows)]
            if len(candidates) > 1:
                raise APIError(409, "存在同名工作流，请从列表拖入包含目录的完整路径。")
            if candidates:
                path = candidates[0]
        return path

    def relative(self, path):
        return Path(path).resolve().relative_to(self.workflows).as_posix()

    def load(self, path):
        with self.lock:
            stat = path.stat()
            if stat.st_size > MAX_WORKFLOW:
                raise APIError(413, "工作流文件过大。")
            key = (str(path), stat.st_mtime_ns, stat.st_size)
            if key not in self._workflow_cache:
                self._workflow_cache = {k: v for k, v in self._workflow_cache.items() if k[0] != str(path)}
                while self._workflow_cache and (len(self._workflow_cache) >= 96 or sum(k[2] for k in self._workflow_cache) + stat.st_size > 24 * 1024 * 1024):
                    self._workflow_cache.pop(next(iter(self._workflow_cache)))
                self._workflow_cache[key] = validate_workflow(json.loads(path.read_text(encoding="utf-8-sig")))
            return self._workflow_cache[key]

    def ensure(self, path):
        relative = self.relative(path)
        identifier = hashlib.sha256(relative.encode("utf-8")).hexdigest()[:20]
        if identifier not in self.state["entries"]:
            self.state["entries"][identifier] = {"path": relative, "category": classification(relative), "lastUsed": None}
        return identifier

    def include(self, path):
        identifier = self.ensure(path)
        relative = self.relative(path)
        existing = self.category_ids(relative)
        self.set_categories(relative, existing or [self.state["entries"][identifier]["category"]])
        return identifier

    def collect(self, path, category=None):
        relative = self.relative(path)
        duplicate = family_id(relative) in self.state.get("members", {})
        if not duplicate and category is not None and category not in {c["id"] for c in self.state["categories"]}:
            raise APIError(400, "分类不存在。")
        identifier = self.include(path)
        if not duplicate and category is not None:
            # A version family is one card, so its latest member receives the
            # chosen category even if an older source path was dragged.
            self.set_categories(relative, [category])
        self.save()
        visible = next((item for item in self.scan() if family_id(item["path"]) == family_id(relative)), self.entry(identifier))
        return {"workflow": visible, "duplicate": duplicate}

    def file_facts(self, path):
        """Retain small validation facts, not every workflow graph in a large library."""
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        if key not in self._facts_cache:
            self._facts_cache = {k: v for k, v in self._facts_cache.items() if k[0] != str(path)}
            if len(self._facts_cache) >= 4000:
                self._facts_cache.pop(next(iter(self._facts_cache)))
            try:
                self._facts_cache[key] = len(self.load(path)["nodes"])
            except (ValueError, APIError):
                self._facts_cache[key] = None
        count = self._facts_cache[key]
        if count is None:
            raise APIError(400, "工作流 JSON 损坏或格式无效。")
        return stat, count

    def scan(self):
        with self.lock:
            changed = False
            prepared = {}
            initial_seed = not isinstance(self.state.get("members"), dict)
            if initial_seed:
                # Migrate existing catalog metadata once, then keep a curated membership.
                self.state["members"] = {family_id(e["path"]): [e.get("category", "img")] for e in self.state["entries"].values()}
                changed = True
            if self.workflows.exists():
                for path in self.workflows.rglob("*.json"):
                    if not path.resolve().is_relative_to(self.workflows):
                        continue
                    relative = path.relative_to(self.workflows).as_posix()
                    member_id = family_id(relative)
                    if False:  # Public installs start empty; only explicit user imports become members.
                        self.state["members"].setdefault(member_id, [classification(relative)])
                    if member_id not in self.state["members"]:
                        continue
                    try:
                        facts = self.file_facts(path)
                        before = len(self.state["entries"])
                        identifier = hashlib.sha256(relative.encode("utf-8")).hexdigest()[:20]
                        if identifier not in self.state["entries"]:
                            self.ensure(path)
                            for existing_id, metadata in self.state["entries"].items():
                                if existing_id != identifier and family_id(metadata["path"]) == member_id:
                                    self.state["entries"][identifier]["category"] = metadata["category"]
                                    break
                        prepared[identifier] = (path, facts)
                        changed |= len(self.state["entries"]) != before
                    except (OSError, ValueError, APIError):
                        continue
            if changed:
                self.save()
            result = []
            for identifier in self.state["entries"]:
                if family_id(self.state["entries"][identifier]["path"]) not in self.state["members"]:
                    continue
                try:
                    result.append(self.entry(identifier, prepared.get(identifier)))
                except (APIError, ValueError, OSError):
                    continue
            visible = latest_entries(result)
            self.hidden_version_count = len(result) - len(visible)
            return visible

    def entry(self, identifier, prepared=None):
        with self.lock:
            metadata = self.state["entries"].get(identifier)
            if metadata is None:
                raise APIError(404, "未找到工作流。")
            path = prepared[0] if prepared else self.resolve_path(metadata["path"])
            stat, node_count = prepared[1] if prepared else self.file_facts(path)
            media = self.manual_media(identifier)
            categories = self.category_ids(metadata["path"])
            cover_kind = "manual" if media or self.cover_path(identifier, "manual").exists() else "snapshot" if self.cover_path(identifier, "snapshot").exists() else "graph"
            revision = str(stat.st_mtime_ns)
            cover_file = self.media_file(identifier, media.get("poster")) if media else self.cover_path(identifier, cover_kind)
            cover_revision = cover_file.stat().st_mtime_ns if cover_kind != "graph" else revision
            cover_url = f"/api/workflows/{identifier}/cover?v={cover_revision}"
            video_url = f"/api/workflows/{identifier}/cover-video.mp4?v={cover_revision}" if media.get("video") else None
            return {"id": identifier, "name": metadata.get("name") or path.stem,
                    "path": metadata["path"], "category": categories[0] if categories else metadata["category"], "categoryIds": categories,
                    "textCover": metadata.get("textCover"), "textSuggestion": self.text_suggestion(identifier, path, stat),
                    "modified": iso_time(stat.st_mtime), "lastUsed": metadata.get("lastUsed"),
                    "nodeCount": node_count, "coverKind": cover_kind,
                    "coverType": media.get("kind") or ("graph" if cover_kind == "graph" else "image"),
                    "coverVideoUrl": video_url, "posterUrl": cover_url, "coverUrl": cover_url,
                    "previewUrl": f"/api/workflows/{identifier}/preview.svg?v={revision}"}

    def text_suggestion(self, identifier, path=None, stat=None):
        metadata = self.state["entries"].get(identifier)
        if metadata is None:
            raise APIError(404, "未找到工作流。")
        path = path or self.resolve_path(metadata["path"])
        stat = stat or path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        if key not in self._suggestion_cache:
            if len(self._suggestion_cache) >= 4000:
                self._suggestion_cache.pop(next(iter(self._suggestion_cache)))
            fallback = {"title": text_cover_short_name(metadata["path"]), "subtitle": ""}
            try:
                suggested = text_cover_suggestion(metadata["path"], self.load(path))
                if not isinstance(suggested, dict):
                    suggested = fallback
                title = suggested.get("title")
                subtitle = suggested.get("subtitle", "")
                self._suggestion_cache[key] = {
                    "title": title.strip() if isinstance(title, str) and title.strip() else fallback["title"],
                    "subtitle": subtitle.strip() if isinstance(subtitle, str) else "",
                }
            except (ValueError, TypeError, AttributeError, KeyError):
                self._suggestion_cache[key] = fallback
        return self._suggestion_cache[key]

    def set_text_cover(self, identifier, payload, automatic=False):
        with self.lock:
            self.entry(identifier)
            title, subtitle = payload.get("title"), payload.get("subtitle", "")
            if not isinstance(title, str) or not title.strip() or len(title.strip()) > 100:
                raise APIError(400, "封面标题应为1～100个字符。")
            if not isinstance(subtitle, str) or len(subtitle.strip()) > 240:
                raise APIError(400, "封面副标题不能超过240个字符。")
            self.state["entries"][identifier]["textCover"] = {"title": title.strip(), "subtitle": subtitle.strip()}
            self.save()
            return {"workflow": self.entry(identifier)}

    def batch_items(self, payload, operation):
        ids = payload.get("ids")
        if not isinstance(ids, list) or not ids or len(ids) > 1000 or any(not isinstance(i, str) for i in ids):
            raise APIError(400, "请选择1～1000个工作流。")
        identifiers = list(dict.fromkeys(ids))
        category = payload.get("category", "all")
        valid_categories = {item["id"] for item in self.state["categories"]}
        if operation in ("copy", "remove") and category != "all" and category not in valid_categories:
            raise APIError(400, "分类不存在。")
        if operation == "copy" and category == "all":
            raise APIError(400, "请选择要粘贴到的具体分类。")
        results, errors, workflows = [], [], []
        for identifier in identifiers:
            try:
                with self.lock:
                    entry = self.entry(identifier)
                    if operation == "text":
                        existing = self.state["entries"][identifier].get("textCover")
                        if not existing or payload.get("regenerate"):
                            suggested = self.text_suggestion(identifier)
                            self.set_text_cover(identifier, suggested, automatic=True)
                    elif operation == "copy":
                        self.set_categories(entry["path"], self.category_ids(entry["path"]) + [category])
                        self.save()
                    elif operation == "remove":
                        categories = [] if category == "all" else [c for c in self.category_ids(entry["path"]) if c != category]
                        self.set_categories(entry["path"], categories)
                        self.save()
                    else:
                        raise APIError(400, "不支持此批量操作。")
                    workflows.append(self.entry(identifier))
                    results.append({"id": identifier, "success": True})
            except (APIError, OSError, ValueError) as error:
                errors.append({"id": identifier, "error": str(error)})
        return {"workflows": workflows, "results": results, "errors": errors}

    def media_file(self, identifier, name):
        if not isinstance(name, str) or not re.fullmatch(re.escape(identifier) + r"-media-[a-f0-9]{16}\.(webp|mp4)", name):
            raise APIError(400, "媒体封面文件标识无效。")
        return self.data_dir / "covers" / name

    def manual_media(self, identifier):
        media = self.state["entries"].get(identifier, {}).get("mediaCover")
        if not isinstance(media, dict):
            return {}
        try:
            return media if self.media_file(identifier, media.get("poster")).is_file() else {}
        except APIError:
            return {}

    def commit_media(self, identifier, media):
        with self.lock:
            metadata = self.state["entries"].get(identifier)
            if metadata is None:
                raise APIError(404, "未找到工作流。")
            previous = metadata.get("mediaCover")
            metadata["mediaCover"] = media
            try:
                self.save()
            except Exception:
                if previous is None:
                    metadata.pop("mediaCover", None)
                else:
                    metadata["mediaCover"] = previous
                raise

    def save_media(self, identifier, descriptor=None, uploaded=None):
        self.entry(identifier)
        if not self._cover_lock.acquire(blocking=False):
            raise APIError(429, "正在处理其他封面，请稍后再试。")
        try:
            try:
                source, kind = (uploaded, "video") if uploaded is not None else resolve_media(descriptor)
                processor = prepare_video if kind == "video" else prepare_image
                media = processor(source, self.data_dir / "covers", identifier)
            except CoverError as error:
                raise APIError(400, str(error)) from error
            self.commit_media(identifier, media)
        finally:
            self._cover_lock.release()

    def cover_path(self, identifier, kind):
        if not re.fullmatch(r"[a-f0-9]{20}", identifier) or kind not in ("manual", "snapshot", "graph"):
            raise APIError(400, "封面标识无效。")
        return self.data_dir / "covers" / f"{identifier}-{kind}.webp"

    def save_image(self, identifier, value, kind):
        from PIL import Image, ImageOps, UnidentifiedImageError
        if not isinstance(value, str) or not re.match(r"^data:image/(png|jpeg|webp);base64,", value):
            raise APIError(400, "封面仅支持 PNG、JPEG 或 WebP 图片。")
        try:
            raw = base64.b64decode(value.split(",", 1)[1], validate=True)
            if len(raw) > 12 * 1024 * 1024:
                raise APIError(413, "封面图片不能超过 12MB。")
            if kind == "manual":
                try:
                    media = prepare_image(io.BytesIO(raw), self.data_dir / "covers", identifier)
                except CoverError as error:
                    raise APIError(400, str(error)) from error
                self.commit_media(identifier, media)
                return
            with Image.open(io.BytesIO(raw)) as original:
                if original.format not in ("PNG", "JPEG", "WEBP") or original.width * original.height > 40_000_000:
                    raise APIError(400, "图片格式无效或尺寸过大。")
                image = ImageOps.exif_transpose(original)
                image.thumbnail((1920, 1200))
                image = image.convert("RGB")
                target = self.cover_path(identifier, kind)
                temporary = target.with_suffix(".tmp")
                image.save(temporary, "WEBP", quality=84, method=3)
                os.replace(temporary, target)
        except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError) as error:
            raise APIError(400, "无法读取封面图片。") from error

    def comfy_status(self):
        now = time.monotonic()
        # Probe outside the catalog lock: a delayed backend must not block bridge polls.
        # Concurrent callers use cached status rather than making another network call.
        if now - self._online_checked > 3 and self._probe_lock.acquire(blocking=False):
            self._online_checked = now
            try:
                try:
                    with urlopen("http://127.0.0.1:8000/prompt", timeout=2) as response:
                        success = response.status == 200
                except (OSError, ValueError):
                    success = False
                checked_at = time.monotonic()
                if success:
                    self._online_success = checked_at
                self._online = success or (self._online_success > 0 and checked_at - self._online_success < 15)
            finally:
                self._probe_lock.release()
        with self.lock:
            now = time.monotonic()
            live = [c for c in self.clients.values() if now - c["seen"] < 12]
            return {"online": self._online, "bridge": bool(live), "url": "http://127.0.0.1:8000"}

    def import_workflow(self, payload):
        with self.lock:
            path_value = payload.get("path")
            if path_value:
                path = self.resolve_path(path_value)
                if path.is_file():
                    self.load(path)
                    return self.collect(path, payload.get("category"))
                raise APIError(404, "未找到拖入项对应的原工作流文件，请重新拖入左侧列表中的具体文件。")
            workflow = validate_workflow(payload.get("workflow"))
            encoded = json.dumps(workflow, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
            if len(encoded) > MAX_WORKFLOW:
                raise APIError(413, "工作流文件过大。")
            digest = hashlib.sha256(encoded).digest()
            # Compare canonical JSON so whitespace and key order do not create copies.
            if self.workflows.exists():
                for path in self.workflows.rglob("*.json"):
                    if not path.resolve().is_relative_to(self.workflows):
                        continue
                    try:
                        existing = json.dumps(self.load(path), ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
                        if hmac.compare_digest(hashlib.sha256(existing).digest(), digest):
                            return self.collect(path, payload.get("category"))
                    except (ValueError, OSError, APIError):
                        continue
            category = payload.get("category")
            if category is not None and category not in {c["id"] for c in self.state["categories"]}:
                raise APIError(400, "分类不存在。")
            name = str(payload.get("name") or "导入工作流")
            name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")[:140]
            if name.lower().endswith(".json"):
                name = name[:-5]
            if not name or re.fullmatch(r"(?i)(con|prn|aux|nul|com\d|lpt\d)", name):
                name = "导入工作流"
            folder = self.workflows / "工作流库导入"
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / f"{name}.json"
            number = 2
            while path.exists():
                path = folder / f"{name} ({number}).json"
                number += 1
            # Exclusive creation: a concurrent desktop save must never be overwritten.
            with path.open("x", encoding="utf-8") as stream:
                json.dump(workflow, stream, ensure_ascii=False, indent=2)
            identifier = self.include(path)
            if category is not None:
                self.set_categories(self.relative(path), [category])
            self.save()
            return {"workflow": self.entry(identifier), "duplicate": False}

    def request_open(self, identifier):
        entry = self.entry(identifier)
        with self.lock:
            self.expire_jobs()
            # A repeated click shares the same in-flight request.
            for job in self.jobs.values():
                if job["workflowId"] == identifier and job["status"] in ("pending", "opening"):
                    return {"jobId": job["id"], "url": "http://127.0.0.1:8000", "status": job["status"]}
            if sum(j["status"] in ("pending", "opening") for j in self.jobs.values()) >= 16:
                raise APIError(429, "待打开工作流较多，请稍后重试。")
        self.start_comfy()
        with self.lock:
            for job in self.jobs.values():
                if job["workflowId"] == identifier and job["status"] in ("pending", "opening"):
                    return {"jobId": job["id"], "url": "http://127.0.0.1:8000", "status": job["status"]}
            job_id = secrets.token_hex(12)
            self.jobs[job_id] = {"id": job_id, "workflowId": identifier, "path": entry["path"], "name": entry["name"],
                                 "status": "pending", "created": time.monotonic(), "createdAt": iso_time()}
            return {"jobId": job_id, "url": "http://127.0.0.1:8000", "status": "pending"}

    def start_comfy(self):
        comfy = self.comfy_status()
        running = desktop_running() if not comfy["online"] and not self.no_launch else False
        with self.lock:
            started = False
            if not comfy["online"] and not self.no_launch and not running and time.monotonic() - self._launch_time > 20:
                if not DESKTOP_EXE.is_file():
                    raise APIError(503, "未找到 ComfyUI 桌面程序。")
                subprocess.Popen([str(DESKTOP_EXE)], close_fds=True)
                self._launch_time = time.monotonic()
                started = True
            return {"url": comfy["url"], "online": comfy["online"], "started": started, "desktopRunning": running or started}

    def expire_jobs(self):
        now = time.monotonic()
        for job in self.jobs.values():
            if job["status"] in ("pending", "opening") and now - job["created"] > 90:
                job.update(status="failed", error="等待 ComfyUI 连接超时。请打开 ComfyUI，首次安装后刷新其页面，再重试。")
        if len(self.jobs) > 200:
            for identifier in list(self.jobs):
                if len(self.jobs) <= 150:
                    break
                if self.jobs[identifier]["status"] not in ("pending", "opening"):
                    del self.jobs[identifier]
        for identifier in list(self.clients):
            if now - self.clients[identifier]["seen"] > 120:
                del self.clients[identifier]

    def bridge_poll(self, payload):
        client_id = str(payload.get("clientId") or "")[:128]
        if not client_id:
            raise APIError(400, "缺少 ComfyUI 连接标识。")
        with self.lock:
            self.expire_jobs()
            self.clients[client_id] = {"seen": time.monotonic(), "visible": bool(payload.get("visible")),
                                       "activePath": payload.get("activePath"), "openPaths": payload.get("openPaths", [])[:200]}
            for job in self.jobs.values():
                if job["status"] != "pending":
                    continue
                live_clients = [(key, value) for key, value in self.clients.items() if time.monotonic() - value["seen"] < 12]
                def normalize(value):
                    return str(value or "").replace("\\", "/").removeprefix("workflows/")
                def priority(item):
                    key, value = item
                    already_open = job["path"] in {normalize(p) for p in value["openPaths"]}
                    return already_open, value["visible"], value["seen"]
                preferred = max(live_clients, key=priority)[0] if live_clients else client_id
                if preferred != client_id:
                    continue
                try:
                    entry = self.entry(job["workflowId"])
                    workflow = self.load(self.resolve_path(entry["path"]))
                except (APIError, OSError, ValueError):
                    job.update(status="failed", error="工作流原文件已移动、损坏或不存在。")
                    continue
                job.update(status="opening", clientId=client_id)
                return {"version": VERSION, "command": {"jobId": job["id"], "id": job["workflowId"],
                        "path": job["path"], "name": job["name"], "workflow": workflow}}
            return {"command": None, "version": VERSION}

    def bridge_result(self, payload):
        with self.lock:
            job = self.jobs.get(str(payload.get("jobId")))
            if not job:
                raise APIError(404, "打开请求已失效。")
            if job["status"] not in ("pending", "opening"):
                return {"ok": True}
            if payload.get("success"):
                job["status"] = "success"
                self.state["entries"][job["workflowId"]]["lastUsed"] = iso_time()
                self.save()
            else:
                job.update(status="failed", error=str(payload.get("error") or "ComfyUI 未能打开该工作流。")[:500])
            return {"ok": True}

    def snapshot(self, payload):
        with self.lock:
            path = self.resolve_path(payload.get("path"))
            if not path.is_file():
                raise APIError(404, "请先在 ComfyUI 中保存工作流，再记录预览。")
            self.load(path)
            identifier = self.ensure(path)
            if payload.get("image"):
                self.save_image(identifier, payload["image"], "snapshot")
            self.state["entries"][identifier]["lastUsed"] = iso_time()
            self.save()
            return {"workflow": self.entry(identifier)}


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, library):
        self.library = library
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = "WorkflowLibrary/" + VERSION
    protocol_version = "HTTP/1.1"

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            pass

    @property
    def library(self):
        return self.server.library

    def log_message(self, fmt, *args):
        # Deliberately omit query strings/tokens from logs.
        print(f"[{iso_time()}] {self.command} {urlsplit(self.path).path} {args[1] if len(args)>1 else ''}", flush=True)

    def origin_allowed(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        allowed = {f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in (self.server.server_port, 8000)}
        return origin in allowed

    def check_request(self, mutation=False):
        host = self.headers.get("Host", "")
        expected = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if host not in expected or self.client_address[0] != "127.0.0.1" or not self.origin_allowed():
            raise APIError(403, "仅允许本机工作流库和 ComfyUI 访问。")
        if mutation and not hmac.compare_digest(self.headers.get("X-Library-Token", ""), self.library.token):
            raise APIError(403, "连接凭证已更新，请刷新页面后重试。")

    def send_bytes(self, body, content_type, status=200, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        origin = self.headers.get("Origin")
        if origin and self.origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionResetError, BrokenPipeError):
            pass

    def json(self, value, status=200):
        self.send_bytes(json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise APIError(400, "请求长度无效。")
        if length < 0 or length > MAX_BODY:
            self.close_connection = True
            raise APIError(413, "请求内容过大。")
        if self.headers.get_content_type() != "application/json":
            raise APIError(415, "此操作需要 JSON 格式。")
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            raise APIError(400, "JSON 格式无效。")
        if not isinstance(payload, dict):
            raise APIError(400, "请求应为 JSON 对象。")
        return payload

    def do_OPTIONS(self):
        try:
            self.check_request()
            self.send_bytes(b"", "text/plain", 204, {"Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,X-Library-Token", "Access-Control-Max-Age": "600"})
        except APIError as error:
            self.close_connection = True
            self.json({"error": str(error)}, error.status)

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def do_PATCH(self):
        self.dispatch()

    def do_DELETE(self):
        self.dispatch()

    def send_video(self, path):
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match or (not match[1] and not match[2]):
                return self.send_bytes(b"", "video/mp4", 416, {"Content-Range": f"bytes */{size}"})
            if match[1]:
                start = int(match[1])
                end = min(end, int(match[2])) if match[2] else end
            else:
                start = max(0, size - int(match[2]))
            if start > end or start >= size:
                return self.send_bytes(b"", "video/mp4", 416, {"Content-Range": f"bytes */{size}"})
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        origin = self.headers.get("Origin")
        if origin and self.origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        try:
            with path.open("rb") as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    block = stream.read(min(65536, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)
        except (ConnectionResetError, BrokenPipeError):
            pass

    def read_video_upload(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise APIError(400, "视频文件长度无效。")
        if length <= 0 or length > 64 * 1024 * 1024:
            self.close_connection = True
            raise APIError(413, "拖入的视频文件需小于64MB；较大文件请从资源管理器直接拖入引用。")
        if not self.headers.get_content_type().startswith("video/"):
            raise APIError(415, "此入口只接受视频文件。")
        name = unquote(self.headers.get("X-Filename", "video.mp4"))
        extension = Path(name).suffix.lower()
        if extension not in VIDEO_EXTENSIONS:
            raise APIError(400, "此视频格式不受支持。")
        target = self.library.data_dir / "covers" / (".upload-" + uuid.uuid4().hex + extension)
        try:
            with target.open("xb") as stream:
                remaining = length
                while remaining:
                    block = self.rfile.read(min(1024 * 1024, remaining))
                    if not block:
                        raise APIError(400, "视频文件上传未完成。")
                    stream.write(block)
                    remaining -= len(block)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return target

    def dispatch(self):
        try:
            self.check_request(self.command != "GET")
            path = unquote(urlsplit(self.path).path)
            if path.startswith("/api/"):
                self.route_api(path)
            elif self.command == "GET":
                self.static(path)
            else:
                raise APIError(404, "未找到该操作。")
        except APIError as error:
            self.close_connection = True
            self.json({"error": str(error)}, error.status)
        except FileNotFoundError:
            self.json({"error": "文件不存在。"}, 404)
        except (ValueError, TypeError, KeyError) as error:
            self.json({"error": "请求数据格式无效。"}, 400)
        except Exception as error:
            print(f"API error: {type(error).__name__}: {error}", flush=True)
            self.json({"error": "操作未完成，请检查本地服务日志。"}, 500)

    def route_api(self, path):
        method = self.command
        library = self.library
        if path == "/api/bootstrap" and method == "GET":
            workflows = library.scan()
            return self.json({"service": SERVICE, "version": VERSION, "token": library.token, "categories": library.state["categories"],
                              "workflows": workflows, "hiddenVersionCount": library.hidden_version_count, "comfy": library.comfy_status()})
        if path == "/api/status" and method == "GET":
            return self.json({"service": SERVICE, "version": VERSION, "comfy": library.comfy_status()})
        if path == "/api/start" and method == "POST":
            self.read_json()
            return self.json(library.start_comfy())
        if path == "/api/categories" and method == "POST":
            name = str(self.read_json().get("name") or "").strip()
            if not name or len(name) > 40:
                raise APIError(400, "分类名称应为 1～40 个字符。")
            with library.lock:
                if any(c["name"] == name for c in library.state["categories"]):
                    raise APIError(409, "此分类已存在。")
                category = {"id": "cat-" + secrets.token_hex(6), "name": name}
                library.state["categories"].append(category)
                library.save()
            return self.json({"category": category}, 201)
        if path == "/api/import" and method == "POST":
            return self.json(library.import_workflow(self.read_json()))
        if path == "/api/text-covers" and method == "POST":
            return self.json(library.batch_items(self.read_json(), "text"))
        if path == "/api/collections/paste" and method == "POST":
            return self.json(library.batch_items(self.read_json(), "copy"))
        if path == "/api/workflows/batch" and method == "POST":
            payload = self.read_json()
            operation = payload.get("operation")
            if operation not in ("copy", "remove"):
                raise APIError(400, "不支持此批量操作。")
            return self.json(library.batch_items(payload, operation))
        if path == "/api/open" and method == "POST":
            return self.json(library.request_open(str(self.read_json().get("id"))))
        if path == "/api/bridge/poll" and method == "POST":
            return self.json(library.bridge_poll(self.read_json()))
        if path == "/api/bridge/result" and method == "POST":
            return self.json(library.bridge_result(self.read_json()))
        if path == "/api/snapshot" and method == "POST":
            return self.json(library.snapshot(self.read_json()))
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{24})", path)
        if match and method == "GET":
            with library.lock:
                library.expire_jobs()
                job = library.jobs.get(match[1])
                if not job:
                    raise APIError(404, "未找到打开请求。")
                return self.json({k: v for k, v in job.items() if k not in ("created", "clientId")})
        match = re.fullmatch(r"/api/workflows/([a-f0-9]{20})(?:/(json|preview\.svg|cover|cover-video\.mp4|cover-file|text-cover|text-cover/suggestion))?", path)
        if match:
            identifier, action = match.groups()
            entry = library.entry(identifier)
            if not action and method == "DELETE":
                category = parse_qs(urlsplit(self.path).query).get("category", ["all"])[0]
                result = library.batch_items({"ids": [identifier], "category": category}, "remove")
                if result["errors"]:
                    raise APIError(400, result["errors"][0]["error"])
                return self.json({"ok": True, "removed": identifier, **result})
            if not action and method == "PATCH":
                payload = self.read_json()
                with library.lock:
                    metadata = library.state["entries"][identifier]
                    changes = {}
                    if "name" in payload:
                        name = str(payload["name"] or "").strip()
                        if not name or len(name) > 180:
                            raise APIError(400, "名称应为 1～180 个字符。")
                        changes["name"] = name
                    if "category" in payload:
                        if payload["category"] not in {c["id"] for c in library.state["categories"]}:
                            raise APIError(400, "分类不存在。")
                        changes["category"] = payload["category"]
                        library.set_categories(entry["path"], [payload["category"]])
                    metadata.update(changes)
                    library.save()
                return self.json({"workflow": library.entry(identifier)})
            if action == "json" and method == "GET":
                return self.json(library.load(library.resolve_path(entry["path"])))
            if action == "text-cover/suggestion" and method == "GET":
                return self.json({"suggestion": library.text_suggestion(identifier)})
            if action == "text-cover" and method in ("POST", "PATCH"):
                return self.json(library.set_text_cover(identifier, self.read_json()))
            if action == "preview.svg" and method == "GET":
                return self.send_bytes(graph_svg(library.load(library.resolve_path(entry["path"]))), "image/svg+xml; charset=utf-8", headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"})
            if action == "cover-video.mp4" and method == "GET":
                media = library.manual_media(identifier)
                target = library.media_file(identifier, media.get("video"))
                if not target.is_file():
                    raise APIError(404, "视频封面不存在。")
                return self.send_video(target)
            if action == "cover-file" and method == "POST":
                upload = self.read_video_upload()
                try:
                    library.save_media(identifier, uploaded=upload)
                finally:
                    upload.unlink(missing_ok=True)
                return self.json({"workflow": library.entry(identifier)})
            if action == "cover":
                if method == "POST":
                    payload = self.read_json()
                    if payload.get("media"):
                        library.save_media(identifier, descriptor=payload["media"])
                    else:
                        library.save_image(identifier, payload.get("image"), "manual")
                    return self.json({"workflow": library.entry(identifier)})
                if method == "DELETE":
                    with library.lock:
                        library.state["entries"][identifier].pop("mediaCover", None)
                        target = library.cover_path(identifier, "manual")
                        if target.exists():
                            target.unlink()
                        library.save()
                    return self.json({"workflow": library.entry(identifier)})
                if method == "GET":
                    media = library.manual_media(identifier)
                    if media:
                        return self.send_bytes(library.media_file(identifier, media["poster"]).read_bytes(), "image/webp")
                    for kind in ("manual", "snapshot"):
                        target = library.cover_path(identifier, kind)
                        if target.exists():
                            return self.send_bytes(target.read_bytes(), "image/webp")
                    return self.send_bytes(graph_svg(library.load(library.resolve_path(entry["path"]))), "image/svg+xml; charset=utf-8", headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"})
        raise APIError(404, "未找到该操作。")

    def static(self, path):
        target = (ROOT / "web" / (path.lstrip("/") or "index.html")).resolve()
        if not target.is_relative_to((ROOT / "web").resolve()) or not target.is_file():
            raise APIError(404, "页面不存在。")
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if content_type.startswith("text/") or target.suffix == ".js":
            content_type += "; charset=utf-8"
        self.send_bytes(target.read_bytes(), content_type, headers={"Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://127.0.0.1:8000 http://localhost:8000; frame-ancestors http://127.0.0.1:8000 http://localhost:8000; object-src 'none'"})


def main():
    parser = argparse.ArgumentParser(description="ComfyUI 本地工作流库 V" + VERSION)
    parser.add_argument("--port", type=int, default=8190)
    parser.add_argument("--workflows", type=Path, default=DEFAULT_WORKFLOWS)
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("WORKFLOW_LIBRARY_DATA_DIR", str(DEFAULT_BASE / "user/workflow-library"))))
    parser.add_argument("--no-launch", action="store_true", help="测试时不自动启动 ComfyUI")
    args = parser.parse_args()
    library = Library(args.workflows, args.data_dir, args.no_launch)
    server = Server(("127.0.0.1", args.port), library)
    print(f"ComfyUI 工作流库 V{VERSION} http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever(poll_interval=.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
