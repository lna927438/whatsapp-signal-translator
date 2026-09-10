"""Verify the public downloads against metadata produced by the release job."""

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

DOWNLOAD = "https://download.hellodog.net/"
WEBSITE = "https://hellodog.net"


def request(url, *, origin=False):
    headers = {"User-Agent": "translator-release-verification", "Cache-Control": "no-cache"}
    if origin:
        headers["Origin"] = WEBSITE
    return urlopen(Request(url, headers=headers), timeout=90)


def verify_metadata(expected):
    # Check the exact URL used by the website, including its CORS response.
    with request(DOWNLOAD + "metadata/version.json", origin=True) as response:
        actual = json.loads(response.read().decode("utf-8-sig"))
        allowed_origin = response.headers.get("Access-Control-Allow-Origin")
    if allowed_origin not in ("*", WEBSITE):
        raise ValueError("Release metadata does not allow the website origin")
    for field in ("version", "platform", "versionKey", "latestKey", "sha256", "size", "sourceCommit"):
        if actual.get(field) != expected.get(field):
            raise ValueError(f"Public metadata mismatch: {field}")


def verify_installer(key, expected):
    if not isinstance(key, str) or not key.startswith("windows/") or ".." in key:
        raise ValueError("Unexpected installer key")
    digest = hashlib.sha256()
    size = 0
    with request(DOWNLOAD + key) as response:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    if size != expected["size"] or digest.hexdigest() != expected["sha256"]:
        raise ValueError(f"Public installer checksum or size mismatch: {key}")
    print(f"VERIFIED installer {key}: size={size}, sha256={digest.hexdigest()}", flush=True)


def verify_website():
    with request(WEBSITE + "/download") as response:
        html = response.read().decode("utf-8")
    scripts = re.findall(r'<script\b[^>]*\bsrc=[\"\']([^\"\']+)[\"\']', html)
    code = ""
    for script in scripts:
        url = urljoin(WEBSITE, script)
        if not url.startswith(WEBSITE + "/"):
            continue
        with request(url) as response:
            code += response.read().decode("utf-8")
    for marker in ("download.hellodog.net", "metadata/version.json", "windows/latest/WhatsApp-Signal-Translator-Setup.exe"):
        if marker not in code:
            raise ValueError(f"Website bundle is missing its expected download configuration: {marker}")
    print("VERIFIED website /download and R2 download configuration", flush=True)


def main():
    expected = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    if expected["sourceCommit"] != os.environ["GITHUB_SHA"]:
        raise ValueError("Release source does not match this workflow commit")
    for attempt in range(12):
        try:
            verify_metadata(expected)
            break
        except Exception:
            if attempt == 11:
                raise
            print("Waiting for public release metadata to update", flush=True)
            time.sleep(5)
    for field in ("versionKey", "latestKey"):
        verify_installer(expected[field], expected)
    verify_website()
    print(f"VERIFIED public Windows release v{expected['version']} from {expected['sourceCommit']}", flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as output:
            output.write(f"## Windows v{expected['version']} published and verified\n\n")
            output.write(f"[Website download]({WEBSITE}/download)\n\n")
            output.write(f"[Versioned installer]({DOWNLOAD}{expected['versionKey']})\n\n")
            output.write(f"Source commit: `{expected['sourceCommit']}`\n\n")
            output.write(f"SHA256: `{expected['sha256']}`\n\nSize: {expected['size']} bytes\n")


if __name__ == "__main__":
    main()
