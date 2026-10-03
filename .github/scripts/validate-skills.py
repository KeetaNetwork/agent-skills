#!/usr/bin/env python3
"""Validate the Keeta Agent Skills catalog without third-party dependencies."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILLS_ROOT = ROOT / "plugins" / "keeta" / "skills"
PLUGIN_MANIFEST = ROOT / "plugins" / "keeta" / ".claude-plugin" / "plugin.json"
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"

MAIN_SKILL = "keeta"
EXPECTED_SKILLS = {
    MAIN_SKILL,
    "bridge-crypto",
    "card-payments",
    "complete-kyb",
    "complete-kyc",
    "convert-via-anchors",
    "create-fund-wallet",
    "discover-resolve-anchors",
    "multi-asset-balances",
    "pay-out",
    "receive-bank-deposits",
    "send-receive-tokens",
    "spend-policy",
    "x402-payments",
}
REQUIRED_SECTIONS = {
    "when to use",
    "sdk steps",
    "confirmations",
    "failures",
    "related skills",
}
MAIN_SKILL_SECTION_PREFIXES = ("what you can do", "rules", "quickstart", "task map", "networks", "reference files")
ALLOWED_FRONTMATTER = {"name", "description", "license", "compatibility", "metadata", "allowed-tools"}
NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
LINK_PATTERN = re.compile(r"\]\(([^)\s]+)\)")
MAX_SKILL_LINES = 500
IGNORED_DIRS = {".git", "node_modules", "_site"}


def fail(message: str, errors: list[str]) -> None:
    errors.append(message)


def parse_frontmatter(text: str, path: Path, errors: list[str]) -> dict[str, str]:
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        fail(f"{path}: missing opening YAML delimiter", errors)
        return {}
    try:
        end = lines.index("---", 1)
    except ValueError:
        fail(f"{path}: missing closing YAML delimiter", errors)
        return {}

    data: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith((" ", "\t")):
            continue  # nested values (for example under metadata:)
        if ":" not in line:
            fail(f"{path}: unsupported frontmatter line {line!r}", errors)
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = scalar(value.strip(), path, key.strip(), errors)
    return data


def scalar(value: str, path: Path, key: str, errors: list[str]) -> str:
    """Read a one-line YAML scalar, and reject plain values that YAML would misparse."""
    if value.startswith('"'):
        try:
            return str(json.loads(value))
        except json.JSONDecodeError:
            fail(f"{path}: {key} is not a valid double-quoted string", errors)
            return value.strip('"')
    if value.startswith("'"):
        return value[1:-1].replace("''", "'")
    if ": " in value or " #" in value or (value and value[0] in "[]{}&*!|>%@`,"):
        fail(f"{path}: quote the {key} value; YAML cannot read ': ', ' #' or a leading indicator in a plain value", errors)
    return value


def headings(text: str) -> set[str]:
    return {
        match.group(1).strip().lower()
        for match in re.finditer(r"^##\s+(.+?)\s*$", text, re.MULTILINE)
    }


def check_links(path: Path, text: str, errors: list[str]) -> set[Path]:
    """Every relative link must resolve to a file inside the skills tree."""
    targets: set[Path] = set()
    for target in LINK_PATTERN.findall(text):
        if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith("#"):
            continue
        resolved = (path.parent / target.split("#", 1)[0]).resolve()
        if not resolved.is_file():
            fail(f"{path.relative_to(ROOT)}: broken link {target}", errors)
        elif SKILLS_ROOT.resolve() not in resolved.parents:
            fail(f"{path.relative_to(ROOT)}: link leaves the skills tree: {target}", errors)
        targets.add(resolved)
    return targets


def check_manifests(errors: list[str]) -> None:
    for manifest in (PLUGIN_MANIFEST, MARKETPLACE):
        if not manifest.is_file():
            fail(f"{manifest.relative_to(ROOT)}: missing", errors)
            return
    if (ROOT / "plugins" / "keeta" / "plugin.json").exists():
        fail("plugins/keeta/plugin.json: move it to plugins/keeta/.claude-plugin/plugin.json", errors)

    plugin = json.loads(PLUGIN_MANIFEST.read_text(encoding="utf-8"))
    marketplace = json.loads(MARKETPLACE.read_text(encoding="utf-8"))
    if plugin.get("name") != "keeta":
        fail("plugin.json: name must be 'keeta'", errors)
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(plugin.get("version", ""))):
        fail("plugin.json: version must be semver", errors)
    entries = [entry for entry in marketplace.get("plugins", []) if entry.get("name") == "keeta"]
    if len(entries) != 1:
        fail("marketplace.json: must list the keeta plugin exactly once", errors)
        return
    entry = entries[0]
    if entry.get("source") != "./plugins/keeta":
        fail("marketplace.json: keeta source must be ./plugins/keeta", errors)
    if entry.get("version") != plugin.get("version"):
        fail("marketplace.json and plugin.json versions differ", errors)
    if not marketplace.get("owner", {}).get("name"):
        fail("marketplace.json: owner.name is required", errors)


def check_stray_skill_files(errors: list[str]) -> None:
    """A SKILL.md outside plugins/keeta/skills/<name>/ hides the pack from `npx skills add`."""
    for path in ROOT.rglob("*"):
        if any(part in IGNORED_DIRS for part in path.relative_to(ROOT).parts):
            continue
        if path.is_file() and path.name.lower() == "skill.md":
            relative = path.relative_to(ROOT)
            if relative.parent.parent != SKILLS_ROOT.relative_to(ROOT) or path.name != "SKILL.md":
                fail(f"{relative}: SKILL.md files belong only in plugins/keeta/skills/<name>/", errors)


def main() -> int:
    errors: list[str] = []
    skill_files = sorted(SKILLS_ROOT.glob("*/SKILL.md"))
    discovered = {path.parent.name for path in skill_files}

    if discovered != EXPECTED_SKILLS:
        fail(
            "skill folders differ from the expected list: "
            f"missing={sorted(EXPECTED_SKILLS - discovered)}, "
            f"extra={sorted(discovered - EXPECTED_SKILLS)}",
            errors,
        )

    check_manifests(errors)
    check_stray_skill_files(errors)

    for path in skill_files:
        relative = path.relative_to(ROOT)
        text = path.read_text(encoding="utf-8")
        metadata = parse_frontmatter(text, relative, errors)
        name = metadata.get("name", "")
        description = metadata.get("description", "")

        if name != path.parent.name:
            fail(f"{relative}: name must match parent directory", errors)
        if not NAME_PATTERN.fullmatch(name) or len(name) > 64:
            fail(f"{relative}: invalid skill name {name!r}", errors)
        if not description or len(description) > 1024:
            fail(f"{relative}: description must be 1-1024 characters", errors)
        if len(metadata.get("compatibility", "")) > 500:
            fail(f"{relative}: compatibility must be at most 500 characters", errors)
        unknown = set(metadata) - ALLOWED_FRONTMATTER
        if unknown:
            fail(f"{relative}: unsupported frontmatter fields {sorted(unknown)}", errors)
        if len(text.splitlines()) > MAX_SKILL_LINES:
            fail(f"{relative}: keep SKILL.md under {MAX_SKILL_LINES} lines; move detail to references/", errors)

        found = headings(text)
        if name == MAIN_SKILL:
            for prefix in MAIN_SKILL_SECTION_PREFIXES:
                if not any(heading.startswith(prefix) for heading in found):
                    fail(f"{relative}: missing section starting with {prefix!r}", errors)
        else:
            missing_sections = REQUIRED_SECTIONS - found
            if missing_sections:
                fail(f"{relative}: missing sections {sorted(missing_sections)}", errors)

        linked = check_links(path, text, errors)
        for extra in sorted(path.parent.rglob("*.md")):
            if extra == path:
                continue
            check_links(extra, extra.read_text(encoding="utf-8"), errors)
            if extra.resolve() not in linked:
                fail(f"{extra.relative_to(ROOT)}: not linked from {relative}", errors)

    for catalog_path in (ROOT / "README.md", ROOT / "site" / "index.html"):
        if not catalog_path.exists():
            fail(f"{catalog_path.relative_to(ROOT)}: missing catalog file", errors)
            continue
        catalog = catalog_path.read_text(encoding="utf-8")
        for skill in sorted(EXPECTED_SKILLS):
            if f"skills/{skill}/SKILL.md" not in catalog:
                fail(f"{catalog_path.relative_to(ROOT)}: no link to skills/{skill}/SKILL.md", errors)

    if errors:
        print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
        return 1

    print(f"Validated {len(skill_files)} Keeta skills.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
