#!/usr/bin/env node
/**
 * Wake the blitz.cloud app by driving a real browser over raw CDP.
 *
 * Why not Playwright: Cloudflare Turnstile scores the *control plane* hardest.
 * Playwright's launch sends Runtime.enable + Target.setAutoAttach, which the
 * challenge recognises on the protocol layer; no amount of fingerprint patching
 * reaches that. Measured on this exact site, same machine, same IP:
 *
 *   Playwright chromium.launch + click        -> widget renders, token never comes
 *   raw CDP + fingerprint-chromium            -> widget renders, token in ~13s, zero clicks
 *
 * So this script talks to DevTools over a plain WebSocket and never enables
 * Runtime/Target/DOM/Page domains. Node >= 22 has WebSocket built in.
 *
 * Discipline (see skills/antiDetectbrowser/SKILL.md §4):
 *   - Do NOT click the Turnstile widget while it says "Verifying…". A managed
 *     widget is computing; a click resets the computation.
 *   - Only when the widget is the interactive 480x66 / 300x287 form with a
 *     visible checkbox has Cloudflare already decided you look suspicious. Then
 *     a single click with a real pointer path is the only way through.
 *   - Never reload the page in a loop. Every reload restarts the challenge.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.env.TARGET_URL || "https://kuntianzhang-email.prod.page/";
const PORT = Number(process.env.CDP_PORT || 9333);
const SEED = process.env.FP_SEED || String(Math.floor(Math.random() * 900000) + 100000);

// How long to wait for the widget to hand us a token without touching it.
const TOKEN_WAIT_MS = Number(process.env.TOKEN_WAIT_MS || 45_000);
// How long the app may take to answer after the wake form is submitted.
const WAKE_WAIT_MS = Number(process.env.WAKE_WAIT_MS || 120_000);
const POLL_MS = 750;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- browser bin

function findBrowser() {
  if (process.env.BROWSER_BIN) return process.env.BROWSER_BIN;
  const home = process.env.HOME || "";
  const candidates = [
    // fingerprint-chromium: patched at the binary level, navigator.webdriver=false,
    // and fakeShadowRoot lets us read closed shadow roots if we ever need to.
    join(home, "Applications/FPChromium/Chromium.app/Contents/MacOS/Chromium"),
    "/Applications/FPChromium/Chromium.app/Contents/MacOS/Chromium",
    // Linux (GitHub Actions): unpacked fingerprint-chromium tarball.
    "/opt/fpchromium/chrome",
    "/opt/fpchromium/chrome-linux/chrome",
    // Fallbacks: a real installed Chrome beats a Playwright build.
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("no browser binary found; set BROWSER_BIN");
}

// ---------------------------------------------------------------- raw CDP

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const id = this.nextId++;
      this.pending.set(id, { res, rej });
      const msg = sessionId ? { id, sessionId, method, params } : { id, method, params };
      this.ws.send(JSON.stringify(msg));
    });
  }
}

async function connect(port, deadlineMs = 20_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (v.webSocketDebuggerUrl) {
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener("open", res, { once: true });
          ws.addEventListener("error", rej, { once: true });
        });
        return new CDP(ws);
      }
    } catch {
      /* devtools not up yet */
    }
    await sleep(250);
  }
  throw new Error("devtools endpoint never came up");
}

// ---------------------------------------------------------------- page probes

// Everything the loop needs, in one round trip. Never enables a domain.
const PROBE = `(() => {
  const host = document.querySelector('.cf-turnstile');
  const hr = host ? host.getBoundingClientRect() : null;
  const ifr = host ? host.querySelector('iframe') : null;
  const ir = ifr ? ifr.getBoundingClientRect() : null;
  const tok = document.querySelector('input[name="cf-turnstile-response"]');
  const btn = document.getElementById('wake');
  const br = btn ? btn.getBoundingClientRect() : null;
  return {
    ready: document.readyState,
    title: document.title,
    url: location.href,
    visible: document.visibilityState,
    focused: document.hasFocus(),
    gate: !!host,
    host: hr ? { x: Math.round(hr.x), y: Math.round(hr.y), w: Math.round(hr.width), h: Math.round(hr.height) } : null,
    iframe: ir && ir.width > 0 ? { x: Math.round(ir.x), y: Math.round(ir.y), w: Math.round(ir.width), h: Math.round(ir.height) } : null,
    token: tok ? (tok.value || '').length : -1,
    button: br ? { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height), disabled: btn.disabled } : null,
    body: (document.body ? document.body.innerText : '').slice(0, 160),
  };
})()`;

// The gate pages all carry "· blitz.cloud" in the title ("... is asleep",
// "... is waking up"). The real app does not: its title is 我的邮箱. So the app
// is up only when the gate widget is gone AND the title left the gate family.
const isAwake = (s) => !!s && !s.gate && s.ready !== "loading" && !!s.title && !/blitz\.cloud/i.test(s.title);

// ---------------------------------------------------------------- human input

/**
 * Move the pointer along a jittered bezier from outside the target, hover, then
 * press and release. Three instantaneous mouseMoved/pressed/released events with
 * zero dwell are exactly the robot signature interactive Turnstile looks for.
 */
async function humanClick(cdp, sid, target, label) {
  const startAngle = Math.random() * Math.PI * 2;
  const dist = 90 + Math.random() * 130;
  const sx = target.x + target.w / 2 + Math.cos(startAngle) * dist;
  const sy = target.y + target.h / 2 + Math.sin(startAngle) * dist;
  const ex = target.x + target.w / 2 + (Math.random() - 0.5) * 6;
  const ey = target.y + target.h / 2 + (Math.random() - 0.5) * 4;
  // Control points bow the path so it is not a straight line.
  const c1x = sx + (ex - sx) * 0.3 + (Math.random() - 0.5) * 60;
  const c1y = sy + (ey - sy) * 0.3 + (Math.random() - 0.5) * 60;
  const c2x = sx + (ex - sx) * 0.7 + (Math.random() - 0.5) * 40;
  const c2y = sy + (ey - sy) * 0.7 + (Math.random() - 0.5) * 40;

  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex;
    const y = u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey;
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: x + (Math.random() - 0.5) * 3, y: y + (Math.random() - 0.5) * 3, buttons: 0 },
      sid,
    );
    await sleep(8 + Math.random() * 18);
  }

  await sleep(90 + Math.random() * 170); // settle before pressing
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ex, y: ey, buttons: 0 }, sid);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: ex, y: ey, button: "left", buttons: 1, clickCount: 1 }, sid);
  await sleep(60 + Math.random() * 90); // hold
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: ex + (Math.random() - 0.5) * 3, y: ey + (Math.random() - 0.5) * 2, button: "left", buttons: 1 },
    sid,
  );
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ex, y: ey, button: "left", buttons: 0, clickCount: 1 }, sid);
  await sleep(120 + Math.random() * 180);
  // Drift away so the pointer does not sit on the target.
  const driftAngle = startAngle + Math.PI;
  await cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseMoved",
      x: ex + Math.cos(driftAngle) * (20 + Math.random() * 40),
      y: ey + Math.sin(driftAngle) * (20 + Math.random() * 40),
      buttons: 0,
    },
    sid,
  );
  log(`clicked ${label}`);
}

// ---------------------------------------------------------------- main

async function main() {
  const bin = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), "blitz-wake-"));
  log(`browser: ${bin}`);
  log(`seed: ${SEED}  profile: ${profile}`);

  const args = [
    "--headless=new",
    "--fingerprint=" + SEED,
    "--fingerprint-platform=macos",
    `--user-agent=${UA}`,
    "--lang=en-US",
    "--accept-lang=en-US,en",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--window-size=1280,900",
    "about:blank",
  ];

  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let browserErr = "";
  child.stderr.on("data", (d) => {
    const s = String(d);
    if (!/OID|CVDisplayLink|keychain|password_store|Encryption is not available|Fontconfig/i.test(s)) {
      browserErr += s;
    }
  });

  let cdp;
  let exitCode = 1;
  try {
    cdp = await connect(PORT);
    // Target.createTarget + attachToTarget only. No Runtime.enable, no
    // Target.setAutoAttach, no DOM.enable, no Page.enable.
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const ev = async (expr) => {
      const r = await cdp.send(
        "Runtime.evaluate",
        { expression: expr, returnByValue: true, awaitPromise: true },
        sid,
      );
      if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 200));
      return r.result.value;
    };

    await cdp.send("Page.navigate", { url: URL_ }, sid);

    // ---- phase 1: is the app already awake?
    let state = null;
    const firstUntil = Date.now() + 20_000;
    while (Date.now() < firstUntil) {
      await sleep(POLL_MS);
      state = await ev(PROBE);
      if (state.gate) break; // asleep: gate page with the widget
      if (isAwake(state)) break; // app is serving
      // otherwise: still loading, or the "waking up" interstitial — keep waiting
    }
    if (!state) throw new Error("page never became readable");

    if (!state.gate && isAwake(state)) {
      log(`no wake gate — app already awake (title=${JSON.stringify(state.title)})`);
      exitCode = 0;
      return;
    }
    if (!state.gate) {
      log(`no gate, but not the app yet (title=${JSON.stringify(state.title)}) — waiting for it`);
      const until = Date.now() + WAKE_WAIT_MS;
      while (Date.now() < until) {
        await sleep(1_500);
        state = await ev(PROBE);
        if (isAwake(state)) {
          log(`app awake: title=${JSON.stringify(state.title)}`);
          exitCode = 0;
          return;
        }
        if (state.gate) break; // it fell back asleep mid-wait
      }
      if (isAwake(state)) {
        exitCode = 0;
        return;
      }
      if (!state.gate) {
        log(`FAIL: page never became the app (title=${JSON.stringify(state.title)})`);
        exitCode = 1;
        return;
      }
    }
    log(`gate present: ${JSON.stringify(state.body)}`);

    // ---- phase 2: wait for the Turnstile token. Do not touch the widget.
    const tokenUntil = Date.now() + TOKEN_WAIT_MS;
    let clickedWidget = false;
    let sawInteractive = false;

    while (Date.now() < tokenUntil) {
      await sleep(POLL_MS);
      state = await ev(PROBE);
      if (!state.gate) {
        log("gate disappeared on its own — app is up");
        exitCode = 0;
        return;
      }
      if (state.token > 0) {
        log(`token acquired (${state.token} chars) with ${clickedWidget ? "one" : "zero"} widget clicks`);
        break;
      }
      // Interactive form = Cloudflare already flagged us. A single traced click
      // is the only way through, and only once.
      const interactive =
        state.iframe && state.iframe.w >= 250 && state.iframe.h >= 60 && state.iframe.h <= 300;
      if (interactive && !clickedWidget) {
        sawInteractive = true;
        log(`widget is interactive (${state.iframe.w}x${state.iframe.h}) — one traced click`);
        // Checkbox sits in the upper-left of the widget box.
        await humanClick(
          cdp,
          sid,
          { x: state.iframe.x + 14, y: state.iframe.y + 10, w: 40, h: 40 },
          "turnstile checkbox",
        );
        clickedWidget = true;
        await sleep(2_000);
      }
    }

    if (!(state.token > 0)) {
      log(
        `FAIL: no token after ${TOKEN_WAIT_MS / 1000}s ` +
          `(host=${JSON.stringify(state.host)} iframe=${JSON.stringify(state.iframe)} interactive=${sawInteractive})`,
      );
      exitCode = 1;
      return;
    }

    // ---- phase 3: press the wake button, which submits /?blitz-wake=<token>
    if (!state.button) throw new Error("wake button vanished");
    if (state.button.disabled) {
      log("FAIL: token present but button still disabled");
      exitCode = 1;
      return;
    }
    await humanClick(cdp, sid, state.button, "wake button");

    // ---- phase 4: the form navigates and the app boots. Poll for the app.
    const wakeUntil = Date.now() + WAKE_WAIT_MS;
    let lastUrl = "";
    while (Date.now() < wakeUntil) {
      await sleep(1_500);
      try {
        state = await ev(PROBE);
      } catch {
        continue; // mid-navigation
      }
      if (state.url !== lastUrl) {
        lastUrl = state.url;
        log(`url -> ${state.url.slice(0, 120)}`);
      }
      if (isAwake(state)) {
        log(`app awake: title=${JSON.stringify(state.title)}`);
        exitCode = 0;
        return;
      }
      if (!state.gate && /asleep/i.test(state.body)) {
        // Still the gate page without the widget: the wake token was rejected.
        log(`gate still asleep: ${JSON.stringify(state.body)}`);
      }
    }

    log(`FAIL: app did not answer within ${WAKE_WAIT_MS / 1000}s (url=${lastUrl.slice(0, 120)})`);
    exitCode = 1;
  } finally {
    try {
      cdp?.ws.close();
    } catch {}
    child.kill("SIGKILL");
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
    if (browserErr.trim()) log("browser stderr:", browserErr.trim().split("\n").slice(0, 5).join(" | "));
    log(`exit ${exitCode}`);
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    log(`FATAL: ${e?.stack || e}`);
    process.exit(1);
  });
