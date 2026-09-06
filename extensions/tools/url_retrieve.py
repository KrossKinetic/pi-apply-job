"""
Playwright URL Scraper Tool

Opens a given URL in a headless browser, waits for it to load (up to the
specified timeout), then scrapes the page and returns the data as a
well-defined JSON object. If Playwright is unavailable, it uses a read-only
static HTML fallback. Neither mode clicks, submits forms, or navigates beyond
the initial page load.

Return JSON Schema
------------------
{
  "url": "<the requested URL string>",
  "status": "<'success' | 'timeout' | 'error'>",
  "title": "<page title string, or null on failure>",
  "meta": {
    "description": "<meta description content, or null>"
  },
  "headings": [
    {
      "level": "<integer 1-6>",
      "text": "<heading text content>"
    }
  ],
  "text_content": "<full visible text of the page body, trimmed>",
  "error": "<error message string, or null on success>"
}

Field details
-------------
- url: The exact URL that was requested.
- status: 'success' if the page loaded within the timeout, 'timeout' if
  the load exceeded the timeout, 'error' for any other failure.
- title: <title> text or null.
- meta.description: extracted from <meta> tags; null when absent.
- headings: ordered list of <h1>-<h6> elements found in the page body.
- text_content: visible text from the <body>, whitespace-normalized,
  truncated to 40 000 characters.
- error: descriptive message when status is not 'success'.
"""

import asyncio
import ipaddress
import json
import re
import socket
from html.parser import HTMLParser
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

try:
    from playwright.async_api import async_playwright
except ImportError:
    async_playwright = None

# --------------- configuration ---------------

MAX_TEXT_LENGTH = 40_000
DEFAULT_TIMEOUT = 30_000  # ms

# --------------- module exports ---------------

name = "url_retrieve"
description = (
    "Retrieve and scrape a URL using a headless Playwright browser. "
    "Returns a structured JSON object with page title, meta description, "
    "headings, and body text. Strictly read-only — no clicks or form "
    "submissions. "
    "Return JSON schema: "
    "{ "
    '  "url": string, '
    '  "status": "success" | "timeout" | "error", '
    '  "title": string | null, '
    '  "meta": { "description": string|null }, '
    '  "headings": [{ "level": int, "text": string }], '
    '  "text_content": string, '
    '  "error": string | null '
    "}"
)
parameters = {
    "url": {
        "type": "string",
        "description": "The URL to scrape (e.g. https://example.com)",
    },
    "timeout": {
        "type": "integer",
        "description": "Maximum time in milliseconds to wait for the page to load (default: 30000)",
    },
}


# --------------- core function ---------------


def _is_safe_public_url(url, dns_cache=None):
    """Require every resolved address to be globally routable before connecting."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    if parsed.username or parsed.password:
        return False
    hostname = (parsed.hostname or "").lower()
    if not hostname or hostname == "localhost" or hostname.endswith(".localhost") or hostname.endswith(".local"):
        return False
    try:
        return ipaddress.ip_address(hostname).is_global
    except ValueError:
        cache_key = (hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
        if dns_cache is not None and cache_key in dns_cache:
            return dns_cache[cache_key]
        try:
            addresses = {
                item[4][0].split("%", 1)[0]
                for item in socket.getaddrinfo(cache_key[0], cache_key[1], type=socket.SOCK_STREAM)
            }
            safe = bool(addresses) and all(ipaddress.ip_address(address).is_global for address in addresses)
        except (OSError, ValueError):
            safe = False
        if dns_cache is not None:
            dns_cache[cache_key] = safe
        return safe


class _PageTextParser(HTMLParser):
    """Small dependency-free fallback for static job boards."""

    def __init__(self):
        super().__init__()
        self.title = []
        self.meta_description = None
        self.headings = []
        self.text = []
        self._ignored_depth = 0
        self._current_heading = None
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag in {"script", "style", "noscript"}:
            self._ignored_depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag == "meta" and attributes.get("name", "").lower() == "description":
            self.meta_description = attributes.get("content")
        elif re.fullmatch(r"h[1-6]", tag):
            self._current_heading = (int(tag[1]), [])

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript"} and self._ignored_depth:
            self._ignored_depth -= 1
        elif tag == "title":
            self._in_title = False
        elif re.fullmatch(r"h[1-6]", tag) and self._current_heading:
            level, text = self._current_heading
            value = " ".join(text).strip()
            if value:
                self.headings.append({"level": level, "text": value})
            self._current_heading = None

    def handle_data(self, data):
        value = " ".join(data.split())
        if not value or self._ignored_depth:
            return
        self.text.append(value)
        if self._in_title:
            self.title.append(value)
        if self._current_heading:
            self._current_heading[1].append(value)


class _PublicRedirectHandler(HTTPRedirectHandler):
    """Reject unsafe redirect targets before urllib opens their connection."""

    def __init__(self, dns_cache):
        super().__init__()
        self._dns_cache = dns_cache

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _is_safe_public_url(newurl, self._dns_cache):
            raise ValueError("Redirected to a non-public URL")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _retrieve_with_urllib(url, timeout, result):
    """Fetch static HTML when Playwright is not installed."""
    try:
        dns_cache = {}
        request = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; PI-Scraper/1.0)"})
        opener = build_opener(_PublicRedirectHandler(dns_cache))
        with opener.open(request, timeout=max(timeout / 1000, 1)) as response:
            content_type = response.headers.get_content_type()
            if content_type not in {"text/html", "application/xhtml+xml"}:
                raise ValueError(f"Expected an HTML page, received {content_type}")
            html = response.read(MAX_TEXT_LENGTH * 4).decode(response.headers.get_content_charset() or "utf-8", "replace")
        parser = _PageTextParser()
        parser.feed(html)
        body_text = "\n".join(parser.text)[:MAX_TEXT_LENGTH]
        result["title"] = " ".join(parser.title) or None
        result["meta"]["description"] = parser.meta_description
        result["description"] = parser.meta_description or ""
        result["headings"] = parser.headings
        result["heading"] = next((item["text"] for item in parser.headings if item["level"] == 1), None)
        result["body"] = body_text
        result["text_content"] = body_text
    except Exception as exc:
        result["status"] = "error"
        result["error"] = f"Static-page fallback failed: {exc}"
    return result


async def run(params):
    url = params.get("url")
    try:
        timeout = int(params.get("timeout", DEFAULT_TIMEOUT))
    except (ValueError, TypeError):
        timeout = DEFAULT_TIMEOUT

    if not isinstance(url, str) or not url.strip():
        return json.dumps({"error": "Missing required parameter: url"})
    url = url.strip()
    if not _is_safe_public_url(url):
        return json.dumps({"error": "URL must be an absolute public http(s) URL"})

    result = {
        "url": url,
        "status": "success",
        "title": None,
        "description": None,
        "heading": None,
        "body": "",
        "meta": {"description": None},
        "headings": [],
        "text_content": "",
        "error": None,
    }

    if async_playwright is None:
        return json.dumps(await asyncio.to_thread(_retrieve_with_urllib, url, timeout, result))

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            try:
                context = await browser.new_context(
                    user_agent=(
                        "Mozilla/5.0 (compatible; PI-Scraper/1.0; +https://pi.dev)"
                    ),
                    java_script_enabled=True,
                )
                # A public page can embed requests to loopback, LAN, or cloud
                # metadata endpoints. Gate every browser request, not only the
                # top-level URL and its final redirect.
                dns_cache = {}

                async def route_public_only(route):
                    requested = route.request.url
                    scheme = urlparse(requested).scheme
                    if scheme in {"about", "blob", "data"}:
                        await route.continue_()
                    elif await asyncio.to_thread(_is_safe_public_url, requested, dns_cache):
                        await route.continue_()
                    else:
                        await route.abort("blockedbyclient")

                await context.route("**/*", route_public_only)
                page = await context.new_page()

                # Network-idle is useful when it works, but job boards often keep
                # analytics connections open indefinitely. Fall back to DOM-ready.
                try:
                    await page.goto(url, wait_until="networkidle", timeout=timeout)
                except Exception as first_exc:
                    try:
                        await page.goto(url, wait_until="domcontentloaded", timeout=timeout)
                    except Exception as second_exc:
                        result["status"] = "timeout" if "Timeout" in str(second_exc) else "error"
                        result["error"] = str(second_exc or first_exc)
                        return json.dumps(result)

                if not _is_safe_public_url(page.url):
                    result["status"] = "error"
                    result["error"] = "The page redirected to a non-public URL."
                    return json.dumps(result)

                # Detect actual challenge pages without rejecting legitimate roles
                # that merely mention Cloudflare or DDoS protection in their text.
                page_title = await page.title()
                page_text = await page.locator("body").inner_text(timeout=5_000)
                challenge_markers = ["just a moment", "checking your browser", "verify you are human"]
                if any(marker in page_title.lower() for marker in challenge_markers) or (
                    "ray id" in page_text.lower() and "cloudflare" in page_text.lower()
                ):
                    result["status"] = "error"
                    result["error"] = "Page is behind a WAF/Cloudflare challenge. Cannot scrape job description automatically."
                    result["title"] = page_title
                    return json.dumps(result)

                # ---- scrape ----
                data = await page.evaluate("""
            () => {
                const meta = {};
                document.querySelectorAll('meta').forEach(el => {
                    const name = (el.getAttribute('name') || '').toLowerCase();
                    const prop = (el.getAttribute('property') || '').toLowerCase();
                    const content = el.getAttribute('content') || '';
                    if (name === 'description' || prop === 'og:description') meta.description = content;
                });

                const headings = [];
                document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
                    headings.push({ level: parseInt(h.tagName[1]), text: h.textContent.trim() });
                });

                const bodyText = (document.body ? document.body.innerText : '').trim();

                return { meta, headings, bodyText };
            }
                """)

                result["title"] = await page.title()
                result["meta"]["description"] = data["meta"].get("description")
                result["headings"] = data.get("headings", [])
                body_text = data.get("bodyText", "")
                result["text_content"] = body_text[:MAX_TEXT_LENGTH]

                # Populate ScrapedJob-compatible fields for the pipeline
                result["description"] = result["meta"]["description"] or ""
                result["body"] = body_text[:MAX_TEXT_LENGTH]

                # Set heading from the first <h1> if available
                headings = result["headings"]
                h1s = [h for h in headings if h.get("level") == 1]
                result["heading"] = h1s[0]["text"] if h1s else None

            finally:
                await browser.close()
    except Exception as exc:
        result["status"] = "error"
        result["error"] = f"Unable to start or read the browser: {exc}"

    return json.dumps(result)
