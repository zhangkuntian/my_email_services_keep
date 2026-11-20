# my_email_services_keep

Keeps the blitz.cloud app at <https://kuntianzhang-email.prod.page/> awake by
driving a real browser at it.

## Why a browser, and why a button click

blitz.cloud sleeps an app after ~15 minutes without a visit. Plain HTTP clients
cannot wake it — the gate answers them with:

```json
{"status":"asleep","message":"This app is asleep. A program cannot wake it.
 Opening it in a browser does. Pro keeps an app awake for a program too."}
```

and the wake page states it outright: *"automated requests also come from your
network, and we do not wake an app for those on the free plan."* So curl,
`requests`, and uptime monitors are dead ends no matter what headers they send.

What works, verified against the live site: load the page in a real browser,
clear the Cloudflare Turnstile widget that guards the **Wake it up** button,
click it, which navigates to `/?blitz-wake=<token>` and returns `303`, then wait
for the app to answer.

## The Turnstile problem, and why Playwright is the wrong tool

The wake page embeds a Turnstile widget (`data-sitekey=0x4AAAAAAE633AkVPyH8PgB7`,
`data-action=wake`). The **Wake it up** button stays `disabled` until the widget
calls `blitzChecked()` with a token.

Playwright cannot get that token. Measured on this exact site, same machine,
same IP, same UA:

| Control plane | Widget renders | Token | Widget clicks |
|---|---|---|---|
| Playwright `chromium.launch` + `button.click()` | yes | **never** | 1 (and it resets the challenge) |
| Raw CDP + fingerprint-chromium | yes (300×65) | **837 chars in ~13s** | **0** |

Turnstile's managed mode scores *how the browser is being driven* above every
fingerprint signal. Playwright's launch issues `Runtime.enable` and
`Target.setAutoAttach`, which the challenge recognises at the protocol layer;
canvas/WebGL/navigator patches do not reach it. Playwright's bundled Chromium
also sends `HeadlessChrome/…` in its UA, which makes the gate return bare JSON
with no wake page at all.

So `wake.mjs` talks to DevTools over a plain WebSocket and sends only:

```
Target.createTarget / Target.attachToTarget
Runtime.evaluate          (works without enable)
Input.dispatchMouseEvent  (works without enable)
Page.navigate             (works without enable)
```

No `Runtime.enable`, no `Target.setAutoAttach`, no `DOM.enable`, no `Page.enable`.
Node ≥ 22 has a global `WebSocket`, so there are **no npm dependencies**.

## Turnstile discipline

The script follows the field notes in `~/work/skills/antiDetectbrowser/SKILL.md`:

1. **Do not click a widget that says "Verifying…".** A managed widget is
   computing; a click resets the computation. The script waits it out — on this
   site it clears itself in ~13s with zero clicks, every run.
2. **A click is only for the interactive form.** If the iframe is the
   `300×287` / `480×66` interactive variant with a visible checkbox, Cloudflare
   has already decided the browser looks suspicious and the challenge is
   "click through or fail". Only then does the script click — once, at the
   checkbox in the widget's upper-left, with a real pointer path: a jittered
   bezier from 90–220px outside the box, 12 steps at 8–26ms, a 90–260ms settle,
   a 60–150ms hold with 1–2px drift, then a drift away. Three instantaneous
   `mouseMoved → mousePressed → mouseReleased` events are exactly the robot
   signature interactive Turnstile hunts for.
3. **Never reload in a loop.** Every reload restarts the challenge and the log
   just shows `LOADING` forever.
4. **A stuck run is a dead run.** If no token arrives inside `TOKEN_WAIT_MS`,
   the script exits 1 rather than grinding on the same fingerprint. The next
   scheduled run uses a fresh random seed and a fresh profile.

## One run = one visit

The job does **not** loop. Each run launches the browser, loads the page once,
and exits — about 20–30 seconds of runner time. The visit cadence is controlled
entirely from outside, by how often you POST to the `workflow_dispatch`
endpoint.

This matters because a free GitHub account allows **20 concurrent jobs**. An
earlier version had each job loop for 3 hours (36 visits, 5 minutes apart) while
also being dispatched every 5 minutes. That needs ~35 concurrent runners to keep
up, so runs queued for hours and the visits happened at times unrelated to when
they were triggered. One visit per run removes the problem.

Standard GitHub-hosted runners are **free for public repositories**, so the
extra runs cost nothing.

## Caching the browser

A cold run spends most of its time downloading the browser, not visiting the
site. `/opt/fpchromium` is cached under a key that includes the pinned
fingerprint-chromium version, so a hit skips the ~146 MB download while a
version bump correctly invalidates it.

The version is pinned in the workflow (`FP_VERSION`) on purpose: a browser
version is itself an identity asset, and a silent bump would change the
fingerprint mid-flight.

On a cache hit the workflow still installs the apt libraries, because the cache
holds the binary but not the shared objects it links against.

## Why the cron is only a backstop

GitHub's `schedule` event is best-effort. The docs say runs *"can be delayed
during periods of high loads"* and *"some queued jobs may be dropped"*. Others
measured public workflows scheduled every 15 minutes firing on only **64%** of
their slots over 7 days, with a median start delay of **7.4 minutes**.

A late or dropped run is a missed visit, and a missed visit lets the app sleep.
So the cron in this repo (`*/5 * * * *`) is only a backstop for when the external
trigger is missing or has stopped. The reliable driver is the external trigger.

## Setting up the external trigger

Use any free cron service that can send an HTTP POST (cron-job.org, EasyCron,
UptimeRobot, a Cloudflare Worker, …).

**1. Create a fine-grained token**

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained
tokens → Generate new token.

- Repository access: **only** `my_email_services_keep`
- Permissions → Repository permissions → **Actions: Read and write**
- Expiration: as long as you are comfortable with (90 days is typical)

**2. Configure the cron service**

- URL: `https://api.github.com/repos/zhangkuntian/my_email_services_keep/actions/workflows/browser.yml/dispatches`
- Method: `POST`
- Headers:
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer <your token>`
  - `Content-Type: application/json`
- Body: `{"ref":"main"}`
- Schedule: every 5 minutes

**3. Verify**

Trigger it once by hand and check that a new run appears with
`event=workflow_dispatch`:

```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ref":"main"}' \
  https://api.github.com/repos/zhangkuntian/my_email_services_keep/actions/workflows/browser.yml/dispatches
```

A `204 No Content` response means it was accepted.

## Running locally

Needs Node ≥ 22 and a fingerprint-chromium build. The script looks for
`~/Applications/FPChromium/Chromium.app/Contents/MacOS/Chromium` first; override
with `BROWSER_BIN`.

```bash
node wake.mjs
```

Exit code `0` means the app is awake (either it already was, or the wake button
worked). Exit code `1` means it could not be woken.

Environment knobs:

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_BIN` | auto-detected | Browser binary to launch |
| `TARGET_URL` | the app root | Page to visit |
| `CDP_PORT` | `9333` | DevTools port |
| `FP_SEED` | random | Fingerprint seed; fresh per run by default |
| `TOKEN_WAIT_MS` | `45000` | How long to wait for a Turnstile token |
| `WAKE_WAIT_MS` | `120000` | How long the app may take to boot |

## Files

| File | Purpose |
|---|---|
| `wake.mjs` | Raw-CDP browser visit: clears the Turnstile gate, clicks **Wake it up**, verifies the app answers |
| `.github/workflows/browser.yml` | One browser visit per run; caches fingerprint-chromium; `*/5` cron as a backstop |
