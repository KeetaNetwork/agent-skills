#!/usr/bin/env python3
"""Assemble keeta.ai for Cloudflare Pages (see wrangler.toml): the Keeta Compute site and docs.

Usage: python3 .github/scripts/build-site.py [OUT_DIR]   (default: _site)

Output layout:
    index.html, 404.html, styles.css, app.js     copied from site/
    assets/                                       wordmark, app icon, preview image, Geist fonts (SIL OFL)
    _headers, _redirects                          Pages response headers (CORS for agents) and the
                                                  redirects of the old skill URLs to keeta.md; not served
    compute/                                      Keeta Compute docs from site/compute/: every page as
                                                  <page>.html and a <page>.md twin; the models table is
                                                  filled from compute/packages/protocol/catalog.json
    llms.txt                                      plain index for LLMs and web agents

The Keeta agent skills live at https://keeta.md (KeetaNetwork/keeta.md); llms.txt points there.
"""

from __future__ import annotations

import html
import json
import shutil
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SITE_SOURCE = ROOT / "site"
SITE_URL = "https://keeta.ai"
SKILLS_URL = "https://keeta.md"
GITHUB_URL = "https://github.com/KeetaNetwork/agent-skills"
COMPUTE_PATH = "compute"
COMPUTE_CATALOG = ROOT / "compute" / "packages" / "protocol" / "catalog.json"
COMPUTE_PAGES = ("index", "app", "models", "router", "helper", "protocol")
MODELS_MARKER = "<!-- keeta-compute:models-table -->"
CREDIT_DECIMALS = 6
GIB = 1024**3


def gib(size: object) -> str:
    value = Decimal(int(size)) / GIB  # type: ignore[arg-type]
    return f"{value:.0f} GB" if value >= 10 else f"{value:.1f} GB".replace(".0 GB", " GB")


def credits(base_units: object) -> str:
    text = str(base_units)
    if not text.isdigit():
        raise SystemExit(f"{COMPUTE_CATALOG}: price {text!r} is not integer base units")
    value = Decimal(text).scaleb(-CREDIT_DECIMALS)
    return format(value.normalize(), "f") if value else "0"


def models_tables(catalog: list[dict[str, object]]) -> tuple[str, str]:
    """The catalog as a Markdown table and an HTML table (prices shown in credits per million tokens)."""
    head = ["id", "Name", "Parameters", "Quantization", "Memory", "Disk", "License",
            "Input credits / 1M", "Output credits / 1M", "Notes"]
    md = ["| " + " | ".join(head) + " |", "|" + " --- |" * len(head)]
    rows_html = []
    for model in catalog:
        try:
            license_ = model["license"]
            price = model["suggestedPrice"]
            cells = [
                str(model["id"]), str(model["name"]), str(model["parameters"]), str(model["quantization"]),
                gib(model["memoryBytes"]), gib(model["diskBytes"]),
                credits(price["inputPerMillion"]), credits(price["outputPerMillion"]),  # type: ignore[index]
                "cluster only" if model.get("requiresCluster") else "",
            ]
            license_name, license_url = str(license_["name"]), str(license_["url"])  # type: ignore[index]
        except (KeyError, TypeError, ValueError) as error:
            raise SystemExit(f"{COMPUTE_CATALOG}: malformed entry {model!r}: {error}")
        md_cells = [f"`{cells[0]}`", *cells[1:6], f"[{license_name}]({license_url})", *cells[6:]]
        md.append("| " + " | ".join(c.replace("|", "\\|") for c in md_cells) + " |")
        esc = [html.escape(c) for c in cells]
        link = f'<a href="{html.escape(license_url)}">{html.escape(license_name)}</a>'
        tds = [f"<td><code>{esc[0]}</code></td>", *(f"<td>{c}</td>" for c in esc[1:6]), f"<td>{link}</td>",
               *(f"<td>{c}</td>" for c in esc[6:])]
        rows_html.append("<tr>" + "".join(tds) + "</tr>")
    table_html = "\n".join([
        "<table>",
        "<thead><tr>" + "".join(f"<th>{html.escape(h)}</th>" for h in head) + "</tr></thead>",
        "<tbody>",
        *rows_html,
        "</tbody>",
        "</table>",
    ])
    return "\n".join(md), table_html


def build_compute(out: Path) -> list[tuple[str, str]]:
    """Check the Keeta Compute pages, fill in the models table, and return (title, url) for llms.txt."""
    folder = out / COMPUTE_PATH
    html_pages = {p.stem for p in folder.glob("*.html")}
    md_pages = {p.stem for p in folder.glob("*.md")}
    if html_pages != md_pages:
        raise SystemExit(f"site/{COMPUTE_PATH}: every page needs an .html and an .md twin; unpaired: "
                         f"{sorted(html_pages ^ md_pages)}")
    missing = [name for name in COMPUTE_PAGES if name not in html_pages]
    if missing:
        raise SystemExit(f"site/{COMPUTE_PATH}: missing pages {missing}")

    try:
        catalog = json.loads(COMPUTE_CATALOG.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit(f"{COMPUTE_CATALOG}: cannot read the model catalog: {error}")
    if not isinstance(catalog, list) or not catalog:
        raise SystemExit(f"{COMPUTE_CATALOG}: expected a non-empty JSON array")
    table_md, table_html = models_tables(catalog)
    for suffix, table in ((".md", table_md), (".html", table_html)):
        page = folder / f"models{suffix}"
        text = page.read_text(encoding="utf-8")
        if text.count(MODELS_MARKER) != 1:
            raise SystemExit(f"site/{COMPUTE_PATH}/{page.name}: needs exactly one {MODELS_MARKER}")
        page.write_text(text.replace(MODELS_MARKER, table), encoding="utf-8")

    entries = []
    for name in [*COMPUTE_PAGES, *sorted(md_pages - set(COMPUTE_PAGES))]:
        first = (folder / f"{name}.md").read_text(encoding="utf-8").splitlines()[0]
        if not first.startswith("# "):
            raise SystemExit(f"site/{COMPUTE_PATH}/{name}.md: must start with a '# ' title")
        entries.append((first[2:].strip(), f"{SITE_URL}/{COMPUTE_PATH}/{name}.md"))
    return entries


def build(out: Path) -> None:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SITE_SOURCE, out)
    compute_pages = build_compute(out)

    lines = [
        "# Keeta Compute",
        "",
        "> AI inference from spare compute (Macs and Linux GPU machines), paid with Keeta stablecoins",
        "> (KUSD first) through Keeta Compute Credits, or per request with x402. Test-network preview.",
        "",
        f"Call the OpenAI-compatible API at https://api.keeta.ai/v1 and pay per request with x402: {SITE_URL}/{COMPUTE_PATH}/router.md",
        "",
        "## Keeta Compute",
        "",
    ]
    for title, url in compute_pages:
        lines.append(f"- [{title}]({url})")
    lines += [
        "",
        "## Keeta agent skills",
        "",
        f"Agent skills for moving money with Keeta (wallets, payments, bank payouts, bridges, FX, identity and x402) live at {SKILLS_URL}.",
        "",
        f"- [Every Keeta skill]({SKILLS_URL}/llms.txt)",
        f"- [The main skill]({SKILLS_URL}/SKILL.md)",
        f"- Install every skill: `npx skills add {SKILLS_URL}`",
        "",
        "## Optional",
        "",
        f"- [Source on GitHub]({GITHUB_URL})",
        "- [Keeta Network docs](https://docs.keeta.com/)",
        "",
    ]
    (out / "llms.txt").write_text("\n".join(lines), encoding="utf-8")

    shown = out.relative_to(ROOT) if ROOT in out.parents else out
    print(f"Built {shown}: {len(compute_pages)} Keeta Compute pages with Python {sys.version.split()[0]}")


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "_site"
    build(target.resolve())
