"""Template tags for the register map app."""

from __future__ import annotations

import os

from django import template
from django.contrib.staticfiles.finders import find
from django.templatetags.static import static

register = template.Library()


@register.simple_tag
def static_v(path: str) -> str:
    """``static()`` plus a cache-busting version string.

    Django's dev server sends no ``Cache-Control`` for static files, so a
    browser is free to reuse a copy it cached earlier — and the editor's
    JavaScript is tightly coupled to the Python behind it. Tying the URL to
    the file's mtime means a changed script can never be served from a stale
    cache.
    """
    url = static(path)
    absolute = find(path)
    if not absolute:
        return url
    try:
        version = int(os.stat(absolute).st_mtime)
    except OSError:
        return url
    return f"{url}?v={version}"
