"""Short display suggestions from graph structure; no generation or media changes."""
from __future__ import annotations
from pathlib import Path
import re


def graph_nodes(value):
    if isinstance(value, dict):
        for node in value.get("nodes", []) if isinstance(value.get("nodes"), list) else []:
            if isinstance(node, dict):
                yield node
        definitions = value.get("definitions", {})
        if isinstance(definitions, dict):
            for subgraph in definitions.get("subgraphs", []):
                yield from graph_nodes(subgraph)


def short_name(path):
    name = Path(path).stem
    name = re.sub(r"[（(](?:越狱版|越狱|最终版|最终|final)[)）]", "", name, flags=re.I)
    name = re.sub(r"(?i)(?:[_\s-]*codex)?[_\s-]*v\d+(?:\.\d+){1,3}", "", name)
    name = re.sub(r"(?i)[_\s-]*codex", "", name)
    name = re.sub(r"[（(](?:最终版|最终|final|副本|\d+)[)）]", "", name, flags=re.I)
    name = re.sub(r"(?i)(?:[_\s-]+(?:final|最终版|最终|new|副本|\d+))+$", "", name)
    name = re.sub(r"^\d+[_、.\s-]+", "", name)
    return re.sub(r"[_\s]+", " ", name).strip(" _-")[:48] or "工作流"


def suggestion(path, workflow):
    name = Path(path).stem
    lower = name.lower()
    nodes = list(graph_nodes(workflow))
    types = {str(node.get("type") or "") for node in nodes}
    title = short_name(path)
    # Match saved graph nodes, not optimizer, repair, or encoder model lists.
    if "H3StoryboardStudio" in types:
        return {"title": "小陈H3多分镜工作台", "subtitle": "MiniMax H3"}
    if "CodexQwenMode" in types:
        models = []
        if any(str(n.get("id")) == "20" and n.get("type") == "CodexDeferredGGUFLoader" for n in nodes):
            models.append("Qwen 2.1")
        if "SamplerCustomAdvanced" in types:
            models.append("Qwen Turbo")
        if any(n.get("type") == "CodexStudioMossPrompt" and ("MOSS" in str(n.get("title")) or "MOSS" in str(n.get("widgets_values", []))) for n in nodes):
            models.append("MOSS")
        if "CodexStudioBBAPI" in types:
            models.append("GPT Image")
        if any("z_image" in str(n.get("widgets_values", "")) and "Loader" in str(n.get("type")) for n in nodes):
            models.append("Z-Image")
        if "CodexStudioKreaGenerate" in types:
            models.append("Krea 2")
        return {"title": "小陈生图工作台", "subtitle": " · ".join(models)}
    if any(t in types for t in ("BBAPIPromptToImage", "BBAPIImageToImage", "BBAPIMultiReference")):
        return {"title": "BBAPI生图工作台", "subtitle": "GPT Image 2 / 2.5"}
    if "CodexReferenceDescribe" in types and "CodexImageGenerate" in types:
        return {"title": "反推生图", "subtitle": "Z-Image Turbo · Image2.1"}
    if "通用图像修复" in name:
        return {"title": "图像修复与放大", "subtitle": "Image2.1 · SeedVR2 / VOSR2 / DLSS5"}
    if "seedvr2" in lower and ("无损" in name or "高清放大" in name):
        return {"title": "SeedVR2无损放大", "subtitle": ""}
    if "moss" in lower:
        return {"title": "MOSS写实工作台" if "jib" in lower else "MOSS生图工作台" if "官方" in name or "sft" in lower else title,
                "subtitle": "Jib V2" if "jib" in lower else "官方 SFT" if "官方" in name or "sft" in lower else "MOSS-Image"}
    if "qwen" in lower and ("2.1" in lower or "2_1" in lower):
        mode = "多图编辑" if "多图" in name or "编辑" in name else "文生图"
        model = "Qwen 2.1 Turbo" if "turbo" in lower else "Qwen 2.1"
        return {"title": model + mode, "subtitle": ""}
    if "krea" in lower:
        return {"title": "Krea 2文生图与放大" if "放大" in name else "Krea 2生图工作台", "subtitle": "Krea 2 Turbo"}
    if "vosr" in lower:
        return {"title": "DLSS5与VOSR2放大" if "dlss" in lower else "VOSR2视频放大" if "视频" in name else "VOSR2细节放大" if "细节" in name else "VOSR2两倍放大" if "两倍" in name else "VOSR2放大", "subtitle": ""}
    models = []
    skipped = ("repair", "upscale", "promptoptimize", "describ", "references", "settings", "control", "speech")
    for node in nodes:
        typ = str(node.get("type") or "")
        if any(term in typ.lower() for term in skipped):
            continue
        values = str(node.get("widgets_values") or "").lower()
        for condition, label in (("qwen_image_2.1_turbo" in values, "Qwen Image 2.1 Turbo"),
                                 ("qwen-image-2.1" in values or "qwen_image_2_1" in values, "Qwen Image 2.1"),
                                 ("z_image_turbo" in values, "Z-Image Turbo"), ("krea2_turbo" in values, "Krea 2 Turbo"),
                                 ("vosr" in typ.lower(), "VOSR2"), ("seedvr" in typ.lower(), "SeedVR2")):
            if condition and label not in models:
                models.append(label)
    return {"title": title, "subtitle": " · ".join(models[:6])}
