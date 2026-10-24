"""Database models.

The app is a single-user, local tool: there is no User, no team and no
permission model. A project is one saved register map, and it carries its
own settings so every register map keeps the conventions it was written
with.
"""

from __future__ import annotations

from typing import Any

from django.db import models
from django.urls import reverse


def _empty_registers() -> list[dict]:
    return []


def _empty_settings() -> dict:
    return {}


class Project(models.Model):
    """One saved register map."""

    name = models.CharField("name", max_length=120)
    # The register map itself: a list of register dicts, exactly as the editor
    # holds them in memory.
    registers = models.JSONField("registers", default=_empty_registers)
    # The editor settings that belong to THIS register map (address
    # increment, default width, visible fields, custom-field definitions).
    settings = models.JSONField("settings", default=_empty_settings)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at", "name"]
        verbose_name = "project"
        verbose_name_plural = "projects"

    def __str__(self) -> str:
        return self.name

    def get_absolute_url(self) -> str:
        return reverse("registermap:editor", args=[self.pk])

    def get_settings_url(self) -> str:
        return reverse("registermap:settings", args=[self.pk])

    # -- helpers ----------------------------------------------------------

    @property
    def register_count(self) -> int:
        return len(self.registers or [])

    @property
    def bit_count(self) -> int:
        return sum(len(r.get("bits") or []) for r in (self.registers or [])
                   if isinstance(r, dict))

    def document(self) -> dict[str, Any]:
        """The YAML document for this project."""
        from . import yamlio

        return yamlio.build_document(self.registers or [], self.settings or {})

    def as_yaml(self) -> str:
        from . import yamlio

        return yamlio.dump_yaml(self.registers or [], self.settings or {})
