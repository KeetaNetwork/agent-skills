#!/usr/bin/env python3
"""Validate the Keeta Agent Skills catalog without third-party dependencies."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILLS_ROOT = ROOT / "plugins" / "keeta" / "skills"
MANIFEST = ROOT / "plugins" / "keeta" / "plugin.json"

EXPECTED_SKILLS = {
    "bridge-usdc",
    "complete-kyb",
    "complete-kyc",
    "convert-via-anchors",
    "create-fund-wallet",
    "discover-resolve-anchors",
    "multi-asset-balances",
    "pay-out",
    "send-receive-tokens",
    "spend-policy",
}
REQUIRED_SECTIONS = {
    "when to use",
    "sdk steps",
    "confirmations",
    "failures",
    "related skills",
}
NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


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
        if ":" not in line:
            fail(f"{path}: unsupported frontmatter line {line!r}", errors)
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip("\"'")
    return data


def main() -> int:
    errors: list[str] = []
    skill_files = sorted(SKILLS_ROOT.glob("*/SKILL.md"))
    discovered = {path.parent.name for path in skill_files}

    if discovered != EXPECTED_SKILLS:
        fail(
            "skill folders differ from CI list: "
            f"missing={sorted(EXPECTED_SKILLS - discovered)}, "
            f"extra={sorted(discovered - EXPECTED_SKILLS)}",
            errors,
        )

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    manifest_skills = {
        Path(entry).name for entry in manifest.get("skills", []) if isinstance(entry, str)
    }
    if manifest_skills != EXPECTED_SKILLS:
        fail("plugin.json skills do not match the CI list", errors)

    for path in skill_files:
        text = path.read_text(encoding="utf-8")
        metadata = parse_frontmatter(text, path.relative_to(ROOT), errors)
        name = metadata.get("name", "")
        description = metadata.get("description", "")

        if name != path.parent.name:
            fail(f"{path.relative_to(ROOT)}: name must match parent directory", errors)
        if not NAME_PATTERN.fullmatch(name) or len(name) > 64:
            fail(f"{path.relative_to(ROOT)}: invalid skill name {name!r}", errors)
        if not description or len(description) > 1024:
            fail(f"{path.relative_to(ROOT)}: description must be 1-1024 characters", errors)

        headings = {
            match.group(1).strip().lower()
            for match in re.finditer(r"^##\s+(.+?)\s*$", text, re.MULTILINE)
        }
        missing_sections = REQUIRED_SECTIONS - headings
        if missing_sections:
            fail(
                f"{path.relative_to(ROOT)}: missing sections "
                f"{sorted(missing_sections)}",
                errors,
            )

    for catalog_path in (ROOT / "README.md", ROOT / "site" / "index.html"):
        if not catalog_path.exists():
            fail(f"{catalog_path.relative_to(ROOT)}: missing catalog file", errors)
            continue
        catalog = catalog_path.read_text(encoding="utf-8")
        for skill in EXPECTED_SKILLS:
            if skill not in catalog:
                fail(f"{catalog_path.relative_to(ROOT)}: missing {skill}", errors)

    if errors:
        print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
        return 1

    print(f"Validated {len(skill_files)} Keeta skills.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
