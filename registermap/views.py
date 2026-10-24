"""Views for the dashboard and the per-project editor.

The app is local and single-user: there is no login, no permissions and no
CSRF exemption. Every view works on one :class:`~registermap.models.Project`,
which stores both the register map and the settings that belong to it.
"""

from __future__ import annotations

import json
from typing import Any

from django.contrib import messages
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from . import yamlio
from .forms import ImportForm, NewProjectFromFileForm, ProjectForm
from .models import Project


def json_for_html(obj: Any) -> str:
    """JSON for embedding in a <script> block.

    ``</`` is escaped so a value containing "</script>" cannot break out of
    the tag, and the result is marked safe by the template.
    """
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


def _project_payload(project: Project) -> dict[str, Any]:
    """The blob the editor and settings pages read on boot."""
    return {
        "project": {
            "id": project.pk,
            "name": project.name,
            "editor_url": project.get_absolute_url(),
            "settings_url": project.get_settings_url(),
            "save_url": reverse("registermap:save", args=[project.pk]),
            "settings_save_url": reverse("registermap:settings_save", args=[project.pk]),
            "export_url": reverse("registermap:export", args=[project.pk]),
            "import_url": reverse("registermap:import", args=[project.pk]),
        },
        "settings": project.settings or {},
        "registers": project.registers or [],
    }


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

@require_GET
def dashboard(request: HttpRequest) -> HttpResponse:
    projects = list(Project.objects.all())
    return render(request, "registermap/dashboard.html", {
        "projects": projects,
        "new_form": ProjectForm(),
        "import_form": NewProjectFromFileForm(),
    })


@require_http_methods(["GET", "POST"])
def project_create(request: HttpRequest) -> HttpResponse:
    """Create an empty project and open it."""
    form = ProjectForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        project = form.save()
        messages.success(request, f"Created “{project.name}”.")
        return redirect(project)
    return render(request, "registermap/project_form.html", {
        "form": form,
        "title": "New project",
        "submit_label": "Create project",
        "cancel_url": reverse("registermap:dashboard"),
    })


@require_http_methods(["GET", "POST"])
def project_rename(request: HttpRequest, pk: int) -> HttpResponse:
    project = get_object_or_404(Project, pk=pk)
    form = ProjectForm(request.POST or None, instance=project)
    if request.method == "POST" and form.is_valid():
        form.save()
        messages.success(request, "Renamed.")
        return redirect(project)
    return render(request, "registermap/project_form.html", {
        "form": form,
        "title": f"Rename “{project.name}”",
        "submit_label": "Save name",
        "cancel_url": project.get_absolute_url(),
    })


@require_http_methods(["GET", "POST"])
def project_delete(request: HttpRequest, pk: int) -> HttpResponse:
    project = get_object_or_404(Project, pk=pk)
    if request.method == "POST":
        name = project.name
        project.delete()
        messages.success(request, f"Deleted “{name}”.")
        return redirect(reverse("registermap:dashboard"))
    return render(request, "registermap/project_delete.html", {"project": project})


@require_POST
def project_duplicate(request: HttpRequest, pk: int) -> HttpResponse:
    project = get_object_or_404(Project, pk=pk)
    copy = Project.objects.create(
        name=_unique_name(f"{project.name} (copy)"),
        registers=project.registers,
        settings=project.settings,
    )
    messages.success(request, f"Duplicated as “{copy.name}”.")
    return redirect(copy)


def _unique_name(base: str) -> str:
    """Return ``base`` or ``base 2``, ``base 3``… if it's already taken."""
    name = base
    n = 2
    while Project.objects.filter(name=name).exists():
        name = f"{base} {n}"
        n += 1
    return name


@require_http_methods(["GET", "POST"])
def project_import_create(request: HttpRequest) -> HttpResponse:
    """Create a new project straight from a YAML file."""
    form = NewProjectFromFileForm(request.POST or None, request.FILES or None)
    if request.method == "POST" and form.is_valid():
        uploaded = form.cleaned_data["file"]
        try:
            registers, settings = yamlio.parse_yaml(uploaded.read())
        except yamlio.YamlError as exc:
            form.add_error("file", str(exc))
        else:
            name = (form.cleaned_data.get("name") or "").strip()
            if not name:
                name = uploaded.name.rsplit(".", 1)[0] or "Imported project"
            project = Project.objects.create(
                name=_unique_name(name),
                registers=registers,
                settings=settings,
            )
            messages.success(
                request, f"Imported {len(registers)} register(s) into “{project.name}”.")
            return redirect(project)
    return render(request, "registermap/project_form.html", {
        "form": form,
        "title": "Import a register map",
        "submit_label": "Import",
        "cancel_url": reverse("registermap:dashboard"),
    })


# ---------------------------------------------------------------------------
# Editor
# ---------------------------------------------------------------------------

@require_GET
@ensure_csrf_cookie
def editor(request: HttpRequest, pk: int) -> HttpResponse:
    project = get_object_or_404(Project, pk=pk)
    return render(request, "registermap/editor.html", {
        "project": project,
        "project_json": json_for_html(_project_payload(project)),
    })


@require_GET
@ensure_csrf_cookie
def settings_page(request: HttpRequest, pk: int) -> HttpResponse:
    project = get_object_or_404(Project, pk=pk)
    return render(request, "registermap/settings.html", {
        "project": project,
        "project_json": json_for_html(_project_payload(project)),
    })


@require_POST
def project_save(request: HttpRequest, pk: int) -> JsonResponse:
    """Store the registers of a project.

    Settings are *not* written here: they belong to the settings page and
    are saved on their own, so a stale editor tab can't roll them back.
    """
    project = get_object_or_404(Project, pk=pk)
    try:
        payload = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Malformed JSON body."}, status=400)

    registers = yamlio.coerce_registers(payload.get("registers"))
    project.registers = registers
    project.save(update_fields=["registers", "updated_at"])
    return JsonResponse({
        "ok": True,
        "register_count": len(registers),
        "updated_at": project.updated_at.isoformat(),
    })


@require_POST
def settings_save(request: HttpRequest, pk: int) -> JsonResponse:
    """Store the settings of a project and hand back the coerced version."""
    project = get_object_or_404(Project, pk=pk)
    try:
        payload = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Malformed JSON body."}, status=400)

    settings = yamlio.coerce_settings(payload.get("settings"))
    project.settings = settings
    project.save(update_fields=["settings", "updated_at"])
    return JsonResponse({"ok": True, "settings": settings})


# ---------------------------------------------------------------------------
# Import / export
# ---------------------------------------------------------------------------

@require_http_methods(["GET", "POST"])
def export_yaml(request: HttpRequest, pk: int) -> HttpResponse:
    """Download a register map as YAML.

    GET exports what is stored. POST exports whatever the browser sends, so
    the editor can download exactly what is on screen, saved or not.
    """
    project = get_object_or_404(Project, pk=pk)

    if request.method == "POST":
        try:
            payload = json.loads(request.body or b"{}")
        except json.JSONDecodeError:
            payload = {}
        registers = yamlio.coerce_registers(payload.get("registers"))
        settings = yamlio.coerce_settings(payload.get("settings")) or project.settings
    else:
        registers = project.registers or []
        settings = project.settings or {}

    text = yamlio.dump_yaml(registers, settings)
    filename = f"{_slugify(project.name) or 'register_map'}.yaml"
    response = HttpResponse(text, content_type="application/x-yaml; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


@require_http_methods(["GET", "POST"])
def import_yaml(request: HttpRequest, pk: int) -> HttpResponse:
    """Replace a project's content with an uploaded YAML file."""
    project = get_object_or_404(Project, pk=pk)
    # The editor uploads with fetch() and can't render a re-displayed form,
    # so it gets a JSON error instead.
    wants_json = "application/json" in (request.headers.get("Accept") or "")
    form = ImportForm(request.POST or None, request.FILES or None)
    if request.method == "POST" and form.is_valid():
        try:
            registers, settings = yamlio.parse_yaml(form.cleaned_data["file"].read())
        except yamlio.YamlError as exc:
            form.add_error("file", str(exc))
        else:
            project.registers = registers
            # A file without settings leaves the project's own settings
            # alone — they belong to the project, not to the file.
            if settings:
                project.settings = settings
            project.save(update_fields=["registers", "settings", "updated_at"])
            messages.success(
                request, f"Imported {len(registers)} register(s) into “{project.name}”.")
            return redirect(project)
    if request.method == "POST" and wants_json:
        errors = form.errors.get("file") or ["Upload failed."]
        return JsonResponse({"error": errors[0]}, status=400)
    return render(request, "registermap/project_import.html", {
        "project": project,
        "form": form,
    })


def _slugify(name: str) -> str:
    keep = [c.lower() if c.isalnum() else "_" for c in name]
    slug = "".join(keep).strip("_")
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug
