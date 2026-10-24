"""Console entry point: ``register-map-editor`` starts the local server."""

from __future__ import annotations

import os
import sys


def main() -> None:
    """Run the Django development server (the app is a local tool)."""
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:  # pragma: no cover - developer aid
        raise ImportError(
            "Couldn't import Django. Are you sure it's installed and "
            "available on your PYTHONPATH environment variable? Did you "
            "forget to activate a virtual environment?"
        ) from exc

    host = os.environ.get("HOST", "127.0.0.1")
    port = os.environ.get("PORT", "5000")
    argv = sys.argv[:1] + ["runserver", f"{host}:{port}"]
    execute_from_command_line(argv)
