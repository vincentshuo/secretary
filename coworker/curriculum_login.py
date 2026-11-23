"""The owner's classroom platform login, held in Edison's own browser profile.

The campus CAS login is a QR scan only the owner can perform. The profile keeps CAS's
ticket-granting cookie, so an expired platform session is first renewed without a window and
the owner is asked to scan only when that fails.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone

from .curriculum import SOURCES, CourseArchive
from .curriculum_sync import HOST, PLATFORM_SESSION, fetch_json
from .secrets import write_private_text

log = logging.getLogger(__name__)
PROFILE = "platform-browser"
SCAN_TIMEOUT = 600
RENEW_TIMEOUT = 45
_browser = threading.Lock()


def signing_in() -> bool:
    return _browser.locked()


def _authorized(cookie: str) -> bool:
    _, cid = next(iter(SOURCES.values()))
    try:
        fetch_json(f"/courseapi/v2/course/catalogue?course_id={cid}", cookie)
    except Exception:
        # Not signed in yet, or the platform is briefly unreachable; keep waiting.
        return False
    return True


def renew(store: CourseArchive) -> bool:
    """Renew the session without a window from an earlier scan's profile; False if it cannot."""
    if not (store.root / PROFILE).is_dir() or not _browser.acquire(blocking=False):
        return False
    try:
        return _sign_in(store, interactive=False)
    finally:
        _browser.release()


def start_scan(store: CourseArchive, on_signed_in: Callable[[], None]) -> None:
    """Open the login window unless one is already open; `on_signed_in` runs after a scan."""
    if not _browser.acquire(blocking=False):
        return

    def scan() -> None:
        try:
            signed_in = _sign_in(store, interactive=True)
        except Exception:
            log.exception("classroom platform sign-in failed")
            signed_in = False
        finally:
            _browser.release()
        if signed_in:
            on_signed_in()

    threading.Thread(target=scan, name="classroom-sign-in", daemon=True).start()


def _sign_in(store: CourseArchive, *, interactive: bool) -> bool:
    from playwright.sync_api import sync_playwright

    from .connectors.browser_automation import launch_persistent_chromium

    profile = store.root / PROFILE
    profile.mkdir(mode=0o700, exist_ok=True)
    deadline = time.monotonic() + (SCAN_TIMEOUT if interactive else RENEW_TIMEOUT)
    with sync_playwright() as pw:
        context = launch_persistent_chromium(pw, str(profile), headless=not interactive)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(HOST + "/", wait_until="domcontentloaded")
            while time.monotonic() < deadline:
                cookies = [
                    {"name": c["name"], "value": c["value"], "domain": c["domain"]}
                    for c in context.cookies(HOST)
                ]
                cookie = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
                if cookies and _authorized(cookie):
                    write_private_text(
                        store.root / PLATFORM_SESSION,
                        json.dumps(
                            {"saved_at": datetime.now(timezone.utc).isoformat(), "cookies": cookies}
                        ),
                    )
                    status = store.sync_status("automation")
                    status["auth_required"] = False
                    store.save_sync_status("automation", status)
                    return True
                page.wait_for_timeout(3000)
            return False
        finally:
            context.close()
