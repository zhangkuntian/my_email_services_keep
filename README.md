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

What works, verified against the live site: load the page in Chromium, click the
**Wake it up** button, which navigates to `/?blitz-wake=<token>` and returns
`303`, then wait for the app to answer. `main.py` does exactly that and confirms
the app is actually serving before it reports success.

## The scheduling problem

GitHub's `schedule` event is best-effort. The docs say runs *"can be delayed
during periods of high loads"* and *"some queued jobs may be dropped"*. Others
measured public workflows scheduled every 15 minutes firing on only **64%** of
their slots over 7 days, with a median start delay of **7.4 minutes**.

A late or dropped run is a missed visit, and a missed visit lets the app sleep.
So the cron in this repo is only a backstop. The reliable driver is an external
trigger that calls `workflow_dispatch` every 5 minutes.

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

```bash
pip install playwright
playwright install chromium
python main.py
```

Exit code `0` means the app is awake (either it already was, or the wake button
worked). Exit code `1` means it could not be woken.

## Files

| File | Purpose |
|---|---|
| `main.py` | Loads the page in Chromium, clicks the wake button if asleep, verifies the app answers |
| `.github/workflows/browser.yml` | Hourly backstop; each job loops 36 checks 5 minutes apart |
