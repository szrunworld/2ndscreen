#!/usr/bin/env python3
"""Click an element in a background window and show the agent cursor on it.

    scripts/agent-click.py --pid 1234 --window-id 5678 --text "推荐"

Finds the first actionable element whose accessibility text contains --text
(or takes --index from a cua-driver tree), glides the 2ndscreen agent cursor
to its center, then clicks it through cua-driver's background route. The
real pointer and the frontmost app are left alone.

Requires cua-driver on PATH and the 2ndscreen menu bar app running. The
cursor is only visible when the window is on the virtual display.
"""
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

VDISPLAY = Path(__file__).resolve().parent.parent / ".build" / "release" / "vdisplay"
INDEX = re.compile(r"\[(\d+)\]")


def cua(driver, tool, **args):
    out = subprocess.run([driver, tool, json.dumps(args)], capture_output=True, text=True, timeout=120)
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"error": out.stdout.strip() or out.stderr.strip()}


def click_with_retry(driver, attempts=3, **args):
    """AXPress intermittently fails with kAXErrorCannotComplete (-25204) while
    the target is busy; the same press succeeds a moment later."""
    for attempt in range(attempts):
        result = cua(driver, "click", **args)
        if "-25204" not in result.get("error", ""):
            return result
        time.sleep(0.3)
    return result


def index_for_text(tree, text):
    """Index of the nearest actionable element at or above the matching line.

    Static text often has no index of its own; its enclosing row or link does.
    """
    lines = tree.splitlines()
    for number, line in enumerate(lines):
        if text not in line:
            continue
        indent = len(line) - len(line.lstrip())
        for candidate in reversed(lines[: number + 1]):
            candidate_indent = len(candidate) - len(candidate.lstrip())
            match = INDEX.search(candidate)
            if match and (candidate is line or candidate_indent < indent):
                return int(match.group(1))
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--window-id", type=int, required=True)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--text", help="accessibility text of the element to click")
    target.add_argument("--index", type=int, help="element index from the cua-driver tree")
    parser.add_argument("--driver", default="cua-driver", help="cua-driver binary to use")
    parser.add_argument("--session", default="agent-click")
    args = parser.parse_args()

    state = cua(args.driver, "get_window_state", pid=args.pid, window_id=args.window_id,
                session=args.session, include_screenshot=False, timeout_ms=5000)
    if "elements" not in state:
        sys.exit(f"snapshot failed: {json.dumps(state, ensure_ascii=False)[:300]}")

    index = args.index if args.index is not None else index_for_text(state["tree_markdown"], args.text)
    if index is None:
        sys.exit(f"no element contains {args.text!r}")
    token = f"{state['snapshot_id']}:{index}"
    element = next((e for e in state["elements"] if e.get("element_token") == token), None)
    if element is None:
        sys.exit(f"element {index} is not in the snapshot")

    frame = element.get("frame")
    if frame:
        x, y = frame["x"] + frame["w"] / 2, frame["y"] + frame["h"] / 2
        subprocess.run([str(VDISPLAY), "cursor", "click", str(x), str(y)], check=False)
        time.sleep(0.4)  # let the cursor arrive before the click lands

    result = click_with_retry(args.driver, pid=args.pid, window_id=args.window_id,
                              session=args.session, element_token=token)
    print(json.dumps({"index": index, "frame": frame, "effect": result.get("effect"),
                      "route": result.get("route"), "refusal": result.get("refusal"),
                      "error": result.get("error")}, ensure_ascii=False))
    return 0 if result.get("effect") not in (None, "refused") else 1


if __name__ == "__main__":
    sys.exit(main())
