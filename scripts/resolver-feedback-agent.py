#!/usr/bin/env python3
"""Privacy-safe, non-blocking resolver telemetry bridge for coding agents."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any


STATE_DIR = Path(os.environ.get("GBRAIN_RESOLVER_STATE_DIR", "~/.gbrain/resolver-feedback")).expanduser()
GBRAIN = os.environ.get("GBRAIN_BIN", "gbrain")
DOMAIN_TERMS = {
    "gbrain": ("gbrain", "stargraph", "knowledge graph", "memory graph"),
    "coding": ("code", "bug", "test", "implement", "repo", "git", "build"),
    "research": ("search", "research", "find", "look up", "verify"),
    "documents": ("pdf", "docx", "document", "resume", "spreadsheet", "slides"),
    "automation": ("cron", "automation", "schedule", "nightly", "workflow"),
    "capture": ("capture", "journal", "remember", "ingest", "link"),
}
ACTION_TERMS = {
    "fix": ("fix", "repair", "debug"),
    "build": ("build", "create", "implement", "add"),
    "research": ("search", "research", "find", "look up", "verify"),
    "explain": ("explain", "how", "why", "what"),
    "capture": ("capture", "remember", "ingest", "journal"),
}


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()


def _safe_component(value: Any, fallback: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(value or "")).strip("-")
    return text[:100] or fallback


def _payload_value(payload: dict[str, Any], *names: str) -> Any:
    for name in names:
        value: Any = payload
        for part in name.split("."):
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(part)
        if value not in (None, ""):
            return value
    return None


def _task_text(payload: dict[str, Any]) -> str:
    value = _payload_value(
        payload,
        "prompt",
        "user_prompt",
        "cleanedBody",
        "message",
        "input",
        "event.prompt",
    )
    return str(value or "")[:20000]


def summarize_task(text: str) -> tuple[str, list[str]]:
    lower = text.lower()
    domains = [name for name, terms in DOMAIN_TERMS.items() if any(term in lower for term in terms)]
    actions = [name for name, terms in ACTION_TERMS.items() if any(term in lower for term in terms)]
    if not domains:
        domains = ["general"]
    if not actions:
        actions = ["execute"]
    candidates = [f"resolver:{domain}" for domain in domains]
    return f"task action={actions[0]} domains={','.join(domains[:4])}", candidates[:8]


def _run_key(payload: dict[str, Any]) -> str:
    session = _payload_value(payload, "session_id", "sessionId", "sessionKey", "context.sessionId")
    turn = _payload_value(payload, "turn_id", "turnId", "runId", "context.runId", "hook_event_name")
    if session or turn:
        return f"{_safe_component(session, 'session')}:{_safe_component(turn, 'turn')}"
    digest = hashlib.sha256(_canonical({"cwd": payload.get("cwd"), "ts": int(time.time() // 30)})).hexdigest()[:20]
    return f"anonymous:{digest}"


def _state_paths() -> tuple[Path, Path, Path]:
    outbox = STATE_DIR / "outbox"
    runs = STATE_DIR / "runs"
    active = STATE_DIR / "active.json"
    outbox.mkdir(parents=True, exist_ok=True)
    runs.mkdir(parents=True, exist_ok=True)
    return outbox, runs, active


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(f".tmp-{os.getpid()}")
    temp.write_bytes(_canonical(value) + b"\n")
    os.replace(temp, path)


def _active_policy() -> dict[str, Any]:
    return _read_json(_state_paths()[2])


def _matching_route(summary: str, active: dict[str, Any]) -> str:
    policy = active.get("policy")
    if not isinstance(policy, dict):
        return ""
    summary_words = set(re.findall(r"[a-z0-9]+", summary.lower()))
    for rule in policy.get("rules", []):
        if not isinstance(rule, dict):
            continue
        cluster_words = set(re.findall(r"[a-z0-9]+", str(rule.get("intent_cluster", "")).lower()))
        if cluster_words and len(summary_words & cluster_words) >= min(2, len(cluster_words)):
            return str(rule.get("route", ""))[:160]
    return ""


def _queue(event: dict[str, Any]) -> Path:
    outbox, _, _ = _state_paths()
    digest = hashlib.sha256(str(event["event_id"]).encode()).hexdigest()
    path = outbox / f"{digest}.json"
    if not path.exists():
        _atomic_json(path, event)
    return path


def _parse_gbrain_output(stdout: str) -> dict[str, Any]:
    try:
        value = json.loads(stdout)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        for line in reversed(stdout.splitlines()):
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    return value
            except json.JSONDecodeError:
                continue
    return {}


def _gbrain_call(operation: str, payload: dict[str, Any], timeout: float = 8.0) -> dict[str, Any]:
    completed = subprocess.run(
        [GBRAIN, "call", operation, json.dumps(payload, separators=(",", ":"))],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env=os.environ.copy(),
    )
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or f"gbrain call failed: {completed.returncode}")
    result = _parse_gbrain_output(completed.stdout)
    if not result:
        raise RuntimeError("gbrain call returned no JSON object")
    return result


def drain(limit: int = 100) -> dict[str, int]:
    outbox, _, _ = _state_paths()
    sent = failed = 0
    for path in sorted(outbox.glob("*.json"))[:limit]:
        event = _read_json(path)
        if not event:
            path.unlink(missing_ok=True)
            continue
        try:
            _gbrain_call("resolver_events_submit", event)
            path.unlink(missing_ok=True)
            sent += 1
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            failed += 1
            break
    return {"sent": sent, "failed": failed, "remaining": len(list(outbox.glob("*.json")))}


def sync_release(environment: str) -> dict[str, Any]:
    result = _gbrain_call("resolver_releases_current", {"environment": environment})
    release = result.get("release")
    policy = result.get("policy")
    if not isinstance(release, dict) or not isinstance(policy, dict):
        return {"updated": False, "version": "unversioned"}
    checksum = hashlib.sha256(_canonical(policy)).hexdigest()
    if checksum != release.get("checksum"):
        raise RuntimeError("active resolver policy checksum mismatch")
    active_path = _state_paths()[2]
    current = _read_json(active_path)
    installed = {"release": release, "policy": policy, "environment": environment}
    updated = current.get("release", {}).get("version") != release.get("version")
    if updated:
        _atomic_json(active_path, installed)
    _gbrain_call("resolver_releases_ack", {
        "version": release["version"],
        "environment": environment,
        "checksum": checksum,
    })
    return {"updated": updated, "version": release["version"], "checksum": checksum}


def _spawn_maintenance(environment: str) -> None:
    if os.environ.get("GBRAIN_RESOLVER_DISABLE_BACKGROUND") == "1":
        return
    try:
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "maintain", "--environment", environment],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
            env=os.environ.copy(),
        )
    except OSError:
        pass


def process_hook(producer: str, phase: str, payload: dict[str, Any]) -> str:
    _, runs, _ = _state_paths()
    run_key = _run_key(payload)
    run_path = runs / f"{hashlib.sha256(run_key.encode()).hexdigest()}.json"
    active = _active_policy()
    if phase == "before":
        summary, candidates = summarize_task(_task_text(payload))
        route = _matching_route(summary, active) or f"{producer}-default"
        state = {"summary": summary, "candidates": candidates, "route": route, "run_key": run_key}
        _atomic_json(run_path, state)
        outcome = "unknown"
    else:
        state = _read_json(run_path)
        summary = str(state.get("summary", "task action=execute domains=general"))
        candidates = state.get("candidates") if isinstance(state.get("candidates"), list) else ["resolver:general"]
        route = str(state.get("route", f"{producer}-default"))
        success = _payload_value(payload, "success", "event.success")
        error = _payload_value(payload, "error", "event.error")
        outcome = "error" if success is False or error else "success"
    version = str(active.get("release", {}).get("version", "unversioned"))
    event_id = f"{producer}:{run_key}:{phase}"
    _queue({
        "event_id": event_id[:160],
        "producer": producer,
        "resolver_version": version[:80],
        "intent_summary": summary[:500],
        "candidate_resolvers": candidates[:20],
        "selected_route": route[:160],
        "outcome": outcome,
        "operation_path": f"agent-hook:{phase}",
        "client_timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    _spawn_maintenance(producer)
    if phase == "before" and route != f"{producer}-default":
        return f"Approved resolver policy {version}: prefer route {route} for this task."
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    hook = sub.add_parser("hook")
    hook.add_argument("--producer", choices=("codex", "openclaw"), required=True)
    hook.add_argument("--phase", choices=("before", "after"), required=True)
    drain_parser = sub.add_parser("drain")
    drain_parser.add_argument("--limit", type=int, default=100)
    sync = sub.add_parser("sync")
    sync.add_argument("--environment", choices=("codex", "openclaw"), required=True)
    maintain = sub.add_parser("maintain")
    maintain.add_argument("--environment", choices=("codex", "openclaw"), required=True)
    args = parser.parse_args()
    if args.command == "hook":
        try:
            payload = json.load(sys.stdin)
            payload = payload if isinstance(payload, dict) else {}
        except json.JSONDecodeError:
            payload = {}
        context = process_hook(args.producer, args.phase, payload)
        if context:
            print(context)
        return 0
    if args.command == "drain":
        print(json.dumps(drain(args.limit), sort_keys=True))
        return 0
    if args.command == "sync":
        print(json.dumps(sync_release(args.environment), sort_keys=True))
        return 0
    drain()
    try:
        sync_release(args.environment)
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
