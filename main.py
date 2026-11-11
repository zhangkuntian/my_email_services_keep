"""Keep the blitz.cloud app awake by driving a real browser.

blitz.cloud sleeps an app after ~15 minutes without a visit. Plain HTTP clients
cannot wake it: the gate answers them with

    {"status":"asleep","message":"This app is asleep. A program cannot wake it.
     Opening it in a browser does."}

and it says so explicitly on the wake page: "automated requests also come from
your network, and we do not wake an app for those on the free plan." So a
curl/uptime-monitor probe is a dead end no matter what headers it sends.

What does work, verified against the live site: load the page in a real browser,
find the "Wake it up" button, and click it. The click navigates to
/?blitz-wake=<token>, which returns 303 and starts the app; the page then polls
until the app answers. This script does exactly that and then confirms the app
is actually serving before it reports success.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

URL = "https://kuntianzhang-email.prod.page/"
# A real Chrome UA. With Playwright's default UA the gate returns bare JSON with
# no button; with a browser UA it returns the wake page that has one.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
TIMEOUT_MS = 60_000
# The wake page says it can take longer than usual; 90s covers a cold start.
WAKE_TIMEOUT_MS = 90_000
POLL_MS = 2_000


def now() -> str:
    return datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")


def main() -> int:
    print(f"[{now()}] Starting browser check", flush=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            viewport={"width": 1440, "height": 900},
            user_agent=USER_AGENT,
        )
        context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
        )
        page = context.new_page()
        try:
            response = page.goto(URL, wait_until="domcontentloaded", timeout=TIMEOUT_MS)
            code = response.status if response else 0
            print(f"HTTP status: {code}", flush=True)

            if code == 200:
                print(f"Page title: {page.title()}", flush=True)
                print("OK: app already awake", flush=True)
                return 0

            # Asleep. The gate serves a wake page with a button; clicking it is
            # the only thing that starts the app on the free plan.
            page.wait_for_timeout(2_000)
            button = page.query_selector("button")
            if button is None:
                print("FAIL: asleep and no wake button on the page", flush=True)
                return 1
            print(f"Wake button: {button.inner_text()!r}", flush=True)
            button.click()
            print("Clicked wake button", flush=True)

            # The page polls by itself; wait for the real app to answer.
            deadline = WAKE_TIMEOUT_MS
            waited = 0
            while waited < deadline:
                page.wait_for_timeout(POLL_MS)
                waited += POLL_MS
                title = page.title()
                if "waking up" in title.lower() or "asleep" in title.lower():
                    continue
                print(f"Woke after ~{waited // 1000}s: {title!r}", flush=True)
                print("OK: app awake", flush=True)
                return 0

            print(f"FAIL: still not awake after {deadline // 1000}s "
                  f"(title={page.title()!r})", flush=True)
            return 1
        except Exception as e:  # noqa: BLE001 - report whatever the browser hit
            print(f"Browser check failed: {type(e).__name__}: {e}", flush=True)
            return 1
        finally:
            context.close()
            browser.close()
            print("Browser closed", flush=True)
            print("Finished", flush=True)


if __name__ == "__main__":
    sys.exit(main())
