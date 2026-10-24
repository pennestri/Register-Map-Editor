"""Django settings for the Register Map Editor.

A deliberately small, local-only configuration: the app runs on the
developer's own machine, stores everything in a local SQLite file and has no
accounts, no external services and no mail.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _secret_key() -> str:
    """Return a stable secret key for this machine.

    The app has no accounts and no sessions that matter, but Django still
    wants a key. An environment variable wins; otherwise one is generated and
    kept in a gitignored file next to the database so restarts don't
    invalidate anything.
    """
    env = os.environ.get("DJANGO_SECRET_KEY")
    if env:
        return env
    key_file = BASE_DIR / ".django-secret-key"
    if key_file.exists():
        return key_file.read_text(encoding="utf-8").strip()
    key = secrets.token_urlsafe(50)
    key_file.write_text(key, encoding="utf-8")
    key_file.chmod(0o600)
    return key


SECRET_KEY = _secret_key()

DEBUG = _env_bool("DJANGO_DEBUG", True)

# Local app: it is served on 127.0.0.1 and occasionally reached over the
# LAN, so don't police the Host header.
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "registermap",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

AUTH_PASSWORD_VALIDATORS: list[dict] = []

LANGUAGE_CODE = "en-us"
TIME_ZONE = "Europe/Berlin"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Local-only app: no login, so the CSRF cookie is only needed to keep the
# JSON endpoints honest. It stays enabled.
SESSION_ENGINE = "django.contrib.sessions.backends.db"
MESSAGE_STORAGE = "django.contrib.messages.storage.session.SessionStorage"

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
}
