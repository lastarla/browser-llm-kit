#!/usr/bin/env python3

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT_DIR = Path(__file__).resolve().parents[1]
DIST_INDEX = ROOT_DIR / "dist" / "front" / "index.html"
DIST_APP = ROOT_DIR / "dist" / "front" / "app.js"
DEFAULT_PORT = 3101
HEALTH_URL_TEMPLATE = "http://127.0.0.1:{port}/health"
APP_URL_TEMPLATE = "http://127.0.0.1:{port}/"
MODEL_ID = "gemma4:e2b"
PLAYWRIGHT_CACHE_DIR = Path.home() / "Library" / "Caches" / "ms-playwright"


def ensure_build():
    if DIST_INDEX.exists() and DIST_APP.exists():
        return

    subprocess.run(
        ["npm", "run", "build"],
        cwd=ROOT_DIR,
        check=True,
    )


def find_chromium_executable():
    candidates = sorted(
        PLAYWRIGHT_CACHE_DIR.glob("chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
        reverse=True,
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate

    raise RuntimeError("no Chromium executable found in Playwright cache")


def wait_for_health(port, timeout_seconds=20):
    deadline = time.time() + timeout_seconds
    health_url = HEALTH_URL_TEMPLATE.format(port=port)
    last_error = None

    while time.time() < deadline:
      try:
          with urllib.request.urlopen(health_url, timeout=1) as response:
              if response.status == 200:
                  return
      except (urllib.error.URLError, TimeoutError) as error:
          last_error = error
          time.sleep(0.25)

    raise RuntimeError(f"server did not become healthy: {last_error}")


def start_server(port):
    env = os.environ.copy()
    env["PORT"] = str(port)
    return subprocess.Popen(
        ["node", "server/index.js"],
        cwd=ROOT_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )


def stop_server(process):
    if process.poll() is not None:
        return

    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def read_server_output(process):
    if process.stdout is None:
        return ""
    try:
        return process.stdout.read()
    except Exception:
        return ""


def main():
    port = int(os.environ.get("VERIFY_SW_PORT", DEFAULT_PORT))
    headless = os.environ.get("VERIFY_SW_HEADLESS", "1") != "0"
    integrity_mode = os.environ.get("VERIFY_SW_INTEGRITY_MODE", "size-only")
    ensure_build()
    server = start_server(port)

    try:
        wait_for_health(port)
        app_url = APP_URL_TEMPLATE.format(port=port)

        with sync_playwright() as playwright:
            with tempfile.TemporaryDirectory(prefix="gemma4-sw-verify-") as user_data_dir:
                context = playwright.chromium.launch_persistent_context(
                    user_data_dir=user_data_dir,
                    executable_path=str(find_chromium_executable()),
                    headless=headless,
                )
                page = context.new_page()
                page.set_default_timeout(600_000)

                print("step: goto first load", flush=True)
                page.goto(app_url, wait_until="domcontentloaded")
                page.wait_for_function("() => Boolean(window.llm)")

                first_load = page.evaluate(
                    """() => ({
                        controller: Boolean(navigator.serviceWorker.controller),
                        registrationCount: 0,
                    })"""
                )

                print("step: first prepare to trigger service worker registration", flush=True)
                first_prepare = page.evaluate(
                    f"""async () => {{
                        const state = await window.llm.prepare('{MODEL_ID}');
                        return JSON.parse(JSON.stringify(state));
                    }}"""
                )
                if first_prepare.get("ready") is True:
                    raise RuntimeError("expected first prepare on uncontrolled page to require reload")
                if first_prepare.get("errorCode") != "INSTALL_CONTROL_REQUIRED":
                    raise RuntimeError(f"unexpected first prepare result: {first_prepare}")

                print("step: wait for service worker registration", flush=True)
                page.evaluate(
                    """() => navigator.serviceWorker && navigator.serviceWorker.ready"""
                )
                print("step: reload for controller", flush=True)
                page.reload(wait_until="domcontentloaded")
                page.wait_for_function("() => Boolean(window.llm)")
                page.wait_for_function("() => Boolean(navigator.serviceWorker.controller)")

                started_at = time.time()
                print("step: start prepare", flush=True)
                page.evaluate(
                    f"""() => {{
                        window.__verifyPrepareDone = false;
                        window.__verifyPrepareError = '';
                        window.__verifyPrepareResult = null;
                        window.llm.setIntegrityMode('{integrity_mode}');
                        window.llm.prepare('{MODEL_ID}')
                          .then((state) => {{
                            window.__verifyPrepareDone = true;
                            window.__verifyPrepareResult = JSON.parse(JSON.stringify(state));
                          }})
                          .catch((error) => {{
                            window.__verifyPrepareDone = true;
                            window.__verifyPrepareError = String(error);
                          }});
                        return true;
                    }}"""
                )

                install_state = None
                deadline = time.time() + 600
                while time.time() < deadline:
                    snapshot = page.evaluate(
                        """() => ({
                            done: Boolean(window.__verifyPrepareDone),
                            error: window.__verifyPrepareError || '',
                            result: window.__verifyPrepareResult,
                            install: JSON.parse(JSON.stringify(window.llm.getInstallState('gemma4:e2b'))),
                        })"""
                    )
                    install_snapshot = snapshot.get("install", {})
                    print(
                        "progress:",
                        json.dumps(
                            {
                                "state": install_snapshot.get("state"),
                                "ready": install_snapshot.get("ready"),
                                "errorCode": install_snapshot.get("errorCode"),
                                "percent": install_snapshot.get("progress", {}).get("percent"),
                                "currentAsset": install_snapshot.get("currentAsset"),
                            },
                            ensure_ascii=False,
                        ),
                        flush=True,
                    )
                    if snapshot.get("done"):
                        if snapshot.get("error"):
                            raise RuntimeError(f"prepare rejected: {snapshot['error']}")
                        install_state = snapshot.get("result")
                        break
                    time.sleep(5)

                if install_state is None:
                    raise RuntimeError("prepare did not finish within 600 seconds")

                duration_ms = round((time.time() - started_at) * 1000, 2)

                print("step: collect diagnostics", flush=True)
                diagnostics = page.evaluate(
                    f"""() => JSON.parse(JSON.stringify(
                        window.llm.getDiagnosticsSnapshot('{MODEL_ID}')
                    ))"""
                )

                cache_summary = page.evaluate(
                    """async () => {
                        const registrations = await navigator.serviceWorker.getRegistrations();
                        const cacheKeys = await caches.keys();
                        const requestLists = await Promise.all(
                            cacheKeys.map(async (cacheName) => {
                                const cache = await caches.open(cacheName);
                                const requests = await cache.keys();
                                return {
                                    cacheName,
                                    urls: requests.map((request) => request.url),
                                };
                            })
                        );
                        return {
                            controller: Boolean(navigator.serviceWorker.controller),
                            registrations: registrations.length,
                            caches: requestLists,
                        };
                    }"""
                )

                context.close()

        asset_records = install_state.get("assetRecords", [])
        verification_sources = [record.get("verificationSource", "") for record in asset_records]
        page_sources = [source for source in verification_sources if source.startswith("page-")]
        unverified = [record.get("url", "") for record in asset_records if not record.get("verified")]

        result = {
            "appUrl": app_url,
            "prepareDurationMs": duration_ms,
            "integrityMode": integrity_mode,
            "firstLoad": first_load,
            "firstPrepare": {
                "state": first_prepare.get("state"),
                "ready": first_prepare.get("ready"),
                "errorCode": first_prepare.get("errorCode"),
            },
            "installState": {
                "state": install_state.get("state"),
                "ready": install_state.get("ready"),
                "errorCode": install_state.get("errorCode"),
                "missingRequired": install_state.get("missingRequired"),
                "controller": install_state.get("controller"),
            },
            "diagnostics": {
                "installReady": diagnostics.get("install", {}).get("ready"),
                "requiredAssetCount": len(diagnostics.get("manifest", {}).get("requiredAssets", [])),
                "assetRecordCount": len(diagnostics.get("install", {}).get("assetRecords", [])),
                "runtimeState": diagnostics.get("runtime", {}).get("state"),
            },
            "cacheSummary": cache_summary,
            "verificationSources": verification_sources,
        }

        if first_load.get("controller") is True:
            raise RuntimeError("expected first load to be uncontrolled before reload")
        if install_state.get("ready") is not True:
            raise RuntimeError(f"prepare did not reach ready: {install_state}")
        if install_state.get("errorCode"):
            raise RuntimeError(f"prepare returned error code: {install_state.get('errorCode')}")
        if install_state.get("missingRequired"):
            raise RuntimeError(f"missing required assets: {install_state.get('missingRequired')}")
        if page_sources:
            raise RuntimeError(f"unexpected page verification sources: {page_sources}")
        if unverified:
            raise RuntimeError(f"unverified assets remain: {unverified}")

        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        stop_server(server)
        if server.returncode not in (None, 0, -15):
            server_output = read_server_output(server)
            if server_output:
                sys.stderr.write(server_output)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"verify_sw_install failed: {error}", file=sys.stderr)
        sys.exit(1)
