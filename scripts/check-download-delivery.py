"""Read-only, bounded public download checks; no account credentials required."""

import json
import re
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE = "https://download.hellodog.net/"
SAMPLE_SIZE = 1024 * 1024


def open_public(url, headers, timeout):
    headers = {"User-Agent": "translator-release-verification", **headers}
    try:
        return urlopen(Request(url, headers=headers), timeout=timeout)
    except HTTPError as error:
        # Do not log cookies or request/account credentials.
        print(json.dumps({"http_error": error.code, "path": url.removeprefix(BASE),
                          "server": error.headers.get("Server"),
                          "cf_mitigated": error.headers.get("CF-Mitigated"),
                          "cf_ray": error.headers.get("CF-Ray"),
                          "content_type": error.headers.get("Content-Type")}), flush=True)
        raise


def sample(key, label, offset, total_size, attempt):
    start = time.monotonic()
    headers = {"Range": f"bytes={offset}-{offset + SAMPLE_SIZE - 1}", "Accept-Encoding": "identity"}
    with open_public(BASE + key, headers, timeout=30) as response:
        first_byte_ms = round((time.monotonic() - start) * 1000, 1)
        if response.status != 206:
            raise ValueError(f"{label}: server did not honor the byte range")
        expected_range = f"bytes {offset}-{offset + SAMPLE_SIZE - 1}/{total_size}"
        if response.headers.get("Content-Range") != expected_range:
            raise ValueError(f"{label}: incorrect Content-Range")
        data = response.read(SAMPLE_SIZE + 1)
        if len(data) != SAMPLE_SIZE:
            raise ValueError(f"{label}: incomplete or oversized byte range")
        seconds = time.monotonic() - start
        cache_control = response.headers.get("Cache-Control", "")
        if label == "versioned" and not re.search(r"max-age=[1-9][0-9]*", cache_control):
            raise ValueError("Versioned installer is missing a positive cache lifetime")
        print(json.dumps({
            "download": label, "attempt": attempt, "offset": offset,
            "http_status": response.status, "bytes": len(data),
            "cache_control": cache_control,
            "cf_cache_status": response.headers.get("CF-Cache-Status"),
            "cache_age_seconds": response.headers.get("Age"),
            "edge": response.headers.get("CF-Ray", "").rsplit("-", 1)[-1],
            "first_byte_ms": first_byte_ms,
            "seconds": round(seconds, 3),
            "sample_mib_per_second": round(len(data) / 1024 / 1024 / seconds, 2),
        }), flush=True)
    return data


def main():
    with open_public(BASE + "metadata/version.json", {"Origin": "https://hellodog.net"}, timeout=20) as response:
        metadata = json.loads(response.read(65536).decode("utf-8-sig"))
        if response.headers.get("Access-Control-Allow-Origin") not in ("*", "https://hellodog.net"):
            raise ValueError("Metadata does not allow the website origin")
    for field in ("versionKey", "latestKey"):
        key = metadata.get(field)
        if not isinstance(key, str) or not re.fullmatch(r"windows/[A-Za-z0-9./_-]+\.exe", key) or ".." in key:
            raise ValueError("Unexpected installer key")
    if not isinstance(metadata.get("size"), int) or metadata["size"] < 2 * SAMPLE_SIZE:
        raise ValueError("Unexpected installer size")
    print(f"Checking public Windows v{metadata['version']}; size={metadata['size']}", flush=True)
    for attempt, offset in enumerate((0, SAMPLE_SIZE, 0), start=1):
        versioned = sample(metadata["versionKey"], "versioned", offset, metadata["size"], attempt)
        latest = sample(metadata["latestKey"], "latest", offset, metadata["size"], attempt)
        if versioned != latest:
            raise ValueError("Download URLs returned different installer bytes")
    print("PASS: public metadata/CORS, matching installer samples, version cache lifetime and resumable byte ranges", flush=True)


if __name__ == "__main__":
    main()
