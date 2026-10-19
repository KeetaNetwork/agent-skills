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
    "index": ("Keeta Compute", "Keeta Compute: spare compute sells AI inference and is paid per request in USDC on Keeta Network."),
    "app": ("macOS app", "Install the Keeta Compute macOS app, provide inference capacity, get paid in USDC, and buy inference for local agents."),
    "models": ("Models", "The Keeta Compute model catalog: memory, disk, license and suggested price per million tokens in USDC."),
    "router": ("Public API router", "The Keeta Compute public API router: OpenAI-compatible endpoints paid per request with x402 on Keeta."),
    "helper": ("Linux", "Run Keeta Compute on Linux: a full node with its own wallet, or a helper in a fleet."),
    "protocol": ("Protocol", "Keeta Compute protocol: identities, signed requests, job lifecycle, tickets, receipts and pricing math."),
}
CURRENT = ' aria-current="page"'
NAV = [("index", "Compute"), ("app", "macOS app"), ("models", "Models"), ("router", "API router"), ("helper", "Linux"), ("protocol", "Protocol")]


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


# The site header and footer, shared with site/index.html and site/404.html; keep them in step.
HEADER = """    <header class="nav">
      <a class="brand" href="/" aria-label="Keeta AI home">
        <img class="wordmark" src="/assets/keeta-wordmark.svg" alt="Keeta" width="84" height="20" />
        <span class="brand-divider" aria-hidden="true"></span>
        <span class="brand-product">Compute</span>
      </a>
      <nav id="site-menu" aria-label="Primary navigation">
        <a href="/#how">How it works</a>
        <a href="/compute/">Compute docs</a>
        <a href="/compute/router">API</a>
        <a href="/#skills">Agent skills</a>
        <a href="https://github.com/KeetaNetwork/keeta-inference">GitHub</a>
      </nav>
      <a class="nav-cta" href="/#start">Get started</a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-menu" aria-label="Open menu">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path class="menu-open-icon" d="M4 7h16M4 12h16M4 17h16" />
          <path class="menu-close-icon" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>"""

FOOTER = """    <footer class="site-footer">
      <div class="footer-top">
        <div class="footer-intro">
          <a class="brand footer-brand" href="/" aria-label="Keeta AI home">
            <img class="wordmark" src="/assets/keeta-wordmark.svg" alt="Keeta" width="84" height="20" />
            <span class="brand-divider" aria-hidden="true"></span>
            <span class="brand-product">Compute</span>
          </a>
          <p>AI inference paid per request on Keeta Network. Agent skills for moving money live at keeta.md.</p>
        </div>
        <nav class="footer-links" aria-label="Footer">
          <div>
            <h2>Keeta</h2>
            <a href="https://keeta.com/">keeta.com</a>
            <a href="https://docs.keeta.com/">Docs</a>
            <a href="https://explorer.keeta.com/">Explorer</a>
          </div>
          <div>
            <h2>Compute</h2>
            <a href="/compute/">Docs</a>
            <a href="/compute/app">macOS app</a>
            <a href="/compute/router">API router</a>
            <a href="/compute/models">Models</a>
          </div>
          <div>
            <h2>For agents</h2>
            <a href="/llms.txt">llms.txt</a>
            <a href="/compute/index.md">Compute as Markdown</a>
            <a href="https://keeta.md/">Keeta skills (keeta.md)</a>
            <a href="https://keeta.md/SKILL.md">SKILL.md</a>
          </div>
          <div>
            <h2>Open source</h2>
            <a href="https://github.com/KeetaNetwork/keeta-inference">GitHub</a>
            <a href="https://github.com/KeetaNetwork/keeta.md">Skills on GitHub</a>
            <a href="https://agentskills.io/">Agent Skills spec</a>
            <a href="https://github.com/KeetaNetwork/keeta-inference/blob/main/LICENSE">Apache-2.0 license</a>
          </div>
        </nav>
      </div>
      <p class="footer-bottom">Open source under Apache-2.0.</p>
    </footer>"""


for name, (title, description) in PAGES.items():
    md = (DIR / f"{name}.md").read_text(encoding="utf-8")
    body = render(md.splitlines())
    path = "/compute/" if name == "index" else f"/compute/{name}"
    full_title = "Keeta Compute" if name == "index" else f"{title} | Keeta Compute"
    nav = "\n".join(
        f'          <a href="{"/compute/" if key == "index" else "/compute/" + key}"{CURRENT if key == name else ""}>{label}</a>'
        for key, label in NAV
    )
    page = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#ffffff" />
    <meta name="color-scheme" content="light" />
    <title>{full_title}</title>
    <meta name="description" content="{html.escape(description)}" />
    <link rel="canonical" href="https://keeta.ai{path}" />
    <link rel="alternate" type="text/markdown" href="/compute/{name}.md" title="This page as Markdown" />
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />
    <link rel="preload" href="/assets/fonts/Geist-Regular.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="/assets/fonts/Geist-Medium.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="stylesheet" href="/styles.css" />
    <link rel="stylesheet" href="/compute/compute.css" />
    <script src="/app.js" defer></script>
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>

{HEADER}

    <main id="main" class="docs">
      <aside class="docs-nav">
        <p class="section-kicker">Keeta Compute</p>
        <nav aria-label="Keeta Compute pages">
{nav}
        </nav>
      </aside>
      <article class="docs-body">
        <p class="eyebrow"><span aria-hidden="true"></span>Test-network preview</p>
{body}
        <p class="docs-source">This page as Markdown: <a href="/compute/{name}.md">{name}.md</a>. Every Compute page for agents: <a href="/llms.txt">llms.txt</a>.</p>
      </article>
    </main>

{FOOTER}
  </body>
</html>
"""
    (DIR / f"{name}.html").write_text(page, encoding="utf-8")
    print("wrote", name)
