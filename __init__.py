"""Loopback-only launcher for the workflow library; no execution nodes are registered."""
import asyncio
import json
import logging
import os
import re
from pathlib import Path
import subprocess
import threading
from urllib.request import urlopen

from aiohttp import web
from server import PromptServer

VERSION = "1.5.2"
WEB_DIRECTORY = "./comfy_web"
LIBRARY_URL = "http://127.0.0.1:8190"
START_SCRIPT = Path(__file__).resolve().parent / "start.ps1"
POWERSHELL = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
LAUNCH_LOCK = threading.Lock()
LOGGER = logging.getLogger("workflow-library-bootstrap")
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def valid_request(request):
    if request.remote not in ("127.0.0.1", "::1"):
        return False
    if request.headers.get("Host") not in ("127.0.0.1:8000", "localhost:8000", "[::1]:8000"):
        return False
    origin = request.headers.get("Origin")
    if origin and origin not in ("http://127.0.0.1:8000", "http://localhost:8000", "http://[::1]:8000"):
        return False
    if request.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
        return False
    return request.content_length is None or request.content_length <= 4096


def already_running():
    try:
        with urlopen(LIBRARY_URL + "/api/status", timeout=4) as response:
            data = json.loads(response.read(8192))
            version = str(data.get("version") or "")
            return response.status == 200 and data.get("service") == "comfy-workflow-library" and re.fullmatch(r"1\.\d+\.\d+", version) is not None
    except (OSError, ValueError):
        return False


def launch_library():
    with LAUNCH_LOCK:
        if already_running():
            return {"url": LIBRARY_URL, "version": VERSION, "started": False, "reused": True}
        if not START_SCRIPT.is_file() or not POWERSHELL.is_file():
            raise RuntimeError("工作流库启动文件不存在。")
        command = [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(START_SCRIPT), "-NoBrowser"]
        try:
            result = subprocess.run(command, cwd=str(START_SCRIPT.parent), timeout=15, capture_output=True,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired as error:
            LOGGER.error("Workflow library launcher timed out after 15 seconds")
            raise RuntimeError("工作流库启动超时，请查看工作流库 data 中的启动日志。") from error
        if result.returncode != 0 or not already_running():
            LOGGER.error("Workflow library launcher failed (exit %s); check workflow-library/data server logs", result.returncode)
            raise RuntimeError("工作流库未能启动，请查看工作流库 data 中的启动日志。")
        return {"url": LIBRARY_URL, "version": VERSION, "started": True, "reused": False}


@PromptServer.instance.routes.post("/workflow-library/start")
async def start_workflow_library(request):
    if not valid_request(request):
        return web.json_response({"error": "仅允许本机 ComfyUI 页面打开工作流库。"}, status=403)
    try:
        result = await asyncio.to_thread(launch_library)
        return web.json_response(result)
    except RuntimeError as error:
        return web.json_response({"error": str(error)}, status=503)
    except Exception:
        LOGGER.exception("Workflow library bootstrap failed")
        return web.json_response({"error": "工作流库启动失败，请查看 ComfyUI 日志。"}, status=503)
