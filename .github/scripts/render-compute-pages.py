#!/usr/bin/env python3
"""Render site/compute/*.md into the matching .html pages (small Markdown subset).

Usage: python3 .github/scripts/render-compute-pages.py site/compute
Edit the .md files, then run this; CI checks the .html is up to date.
"""
import html
import re
import sys
from pathlib import Path

DIR = Path(sys.argv[1])
PAGES = {
    "index": ("Keeta Compute", "Keeta Compute: Macs sell spare AI inference capacity and are paid per request in USDC on Keeta Network."),
    "app": ("macOS app", "Install the Keeta Compute macOS app, provide inference capacity, get paid in USDC, and buy inference for local agents."),
    "models": ("Models", "The Keeta Compute model catalog: memory, disk, license and suggested price per million tokens in USDC."),
    "router": ("Public API router", "The Keeta Compute public API router: OpenAI-compatible endpoints paid per request with x402 on Keeta."),
    "helper": ("Linux helper", "Add a Linux machine to a Keeta Compute fleet as provider-only capacity paid to the paired Mac."),
    "protocol": ("Protocol", "Keeta Compute protocol: identities, signed requests, job lifecycle, tickets, receipts and pricing math."),
}
CURRENT = ' aria-current="page"'
NAV = [("index", "Compute"), ("app", "macOS app"), ("models", "Models"), ("router", "API router"), ("helper", "Linux helper"), ("protocol", "Protocol")]


def href(url: str) -> str:
    m = re.fullmatch(r"https://keeta\.ai/compute/([a-z-]+)\.md", url)
    if m:
        return "/compute/" if m.group(1) == "index" else f"/compute/{m.group(1)}"
    if url.startswith("https://keeta.ai/"):
        return url[len("https://keeta.ai"):]
    return url


def inline(text: str) -> str:
    parts = re.split(r"(`[^`]+`)", text)
    out = []
    for part in parts:
        if part.startswith("`") and part.endswith("`") and len(part) > 1:
            out.append(f"<code>{html.escape(part[1:-1], quote=False)}</code>")
            continue
        s = html.escape(part, quote=False)
        s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", lambda m: f'<a href="{html.escape(href(m.group(2)))}">{m.group(1)}</a>', s)
        s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
        out.append(s)
    return "".join(out)


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", re.sub(r"`", "", text.lower())).strip("-")


def render(lines: list[str]) -> str:
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith("```"):
            lang = line[3:].strip()
            j = i + 1
            body = []
            while not lines[j].startswith("```"):
                body.append(lines[j])
                j += 1
            cls = f' class="language-{lang}"' if lang else ""
            out.append(f"<pre><code{cls}>{html.escape(chr(10).join(body), quote=False)}</code></pre>")
            i = j + 1
            continue
        m = re.match(r"(#{1,3}) (.+)", line)
        if m:
            level = len(m.group(1))
            out.append(f'<h{level} id="{slug(m.group(2))}">{inline(m.group(2))}</h{level}>')
            i += 1
            continue
        if line.startswith("<!--"):
            out.append(line)
            i += 1
            continue
        if line.startswith("|"):
            rows = []
            while i < n and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            head, body = rows[0], rows[2:]
            t = ["<table>", "<thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr></thead>", "<tbody>"]
            for r in body:
                t.append("<tr>" + "".join(f'<td class="wrap">{inline(c)}</td>' if k == len(r) - 1 else f"<td>{inline(c)}</td>" for k, c in enumerate(r)) + "</tr>")
            t += ["</tbody>", "</table>"]
            out.append("\n".join(t))
            continue
        lm = re.match(r"(- |\d+\. )", line)
        if lm:
            ordered = lm.group(1) != "- "
            items: list[list[str]] = []
            while i < n:
                cur = lines[i]
                im = re.match(r"(- |\d+\. )", cur)
                if im and (im.group(1) != "- ") == ordered:
                    items.append([cur[len(im.group(1)):]])
                    i += 1
                elif cur.startswith("   ") or cur.startswith("  "):
                    items[-1].append(cur[3:] if cur.startswith("   ") else cur[2:])
                    i += 1
                elif not cur.strip() and i + 1 < n and (lines[i + 1].startswith("  ") or (re.match(r"(- |\d+\. )", lines[i + 1]) and (re.match(r"(- |\d+\. )", lines[i + 1]).group(1) != "- ") == ordered and any(not l.strip() for l in items[-1]))):
                    items[-1].append("")
                    i += 1
                else:
                    break
            tag = "ol" if ordered else "ul"
            parts = [f"<{tag}>"]
            for item in items:
                if all(l.strip() for l in item) and not any(l.startswith("```") for l in item):
                    parts.append(f"<li>{inline(' '.join(item))}</li>")
                else:
                    parts.append(f"<li>{render(item)}</li>")
            parts.append(f"</{tag}>")
            out.append("\n".join(parts))
            continue
        para = []
        while i < n and lines[i].strip() and not re.match(r"(```|#{1,3} |- |\d+\. |\||<!--)", lines[i]):
            para.append(lines[i])
            i += 1
        out.append(f"<p>{inline(' '.join(para))}</p>")
    return "\n".join(out)


for name, (title, description) in PAGES.items():
    md = (DIR / f"{name}.md").read_text(encoding="utf-8")
    body = render(md.splitlines())
    path = "/compute/" if name == "index" else f"/compute/{name}"
    full_title = "Keeta Compute" if name == "index" else f"{title} | Keeta Compute"
    nav = " ".join(
        f'<a href="{"/compute/" if key == "index" else "/compute/" + key}"{CURRENT if key == name else ""}>{label}</a>'
        for key, label in NAV
    )
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{full_title}</title>
<meta name="description" content="{html.escape(description)}">
<link rel="canonical" href="https://keeta.ai{path}">
<link rel="alternate" type="text/markdown" href="/compute/{name}.md" title="This page as Markdown">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/compute/compute.css">
</head>
<body>
<header>
<nav aria-label="Keeta Compute">{nav} <a href="/">Agent skills</a></nav>
</header>
<main>
{body}
</main>
<footer>
<p>Plain text: <a href="/compute/{name}.md">{name}.md</a>. Keeta Compute is in a test-network preview. <a href="/llms.txt">llms.txt</a> <a href="https://github.com/KeetaNetwork/agent-skills">GitHub</a></p>
</footer>
</body>
</html>
"""
    (DIR / f"{name}.html").write_text(page, encoding="utf-8")
    print("wrote", name)
