"""Tests for the register map editor."""

from __future__ import annotations

import io
import json

from django.test import Client, TestCase
from django.urls import reverse

from . import yamlio
from .models import Project


class YamlIoTests(TestCase):
    """The YAML format has to stay interchangeable with the old Flask app."""

    def test_parse_export_round_trip(self):
        registers = [{"address": "0x00000000", "mnemonic": "CTRL", "width": 32,
                      "access": "rw", "description": "Top level"}]
        settings = {"address_increment": "0x4", "default_width": 32,
                    "enabled_fields": ["address", "width"],
                    "custom_fields": [{"key": "vendor", "type": "string",
                                       "default": "acme"}]}
        text = yamlio.dump_yaml(registers, settings)
        back_registers, back_settings = yamlio.parse_yaml(text)
        self.assertEqual(back_registers[0]["mnemonic"], "CTRL")
        self.assertEqual(back_settings["custom_fields"][0]["key"], "vendor")

    def test_parse_accepts_the_tolerant_shapes(self):
        shapes = [
            "registers:\n  - mnemonic: A\n",
            "register_map:\n  registers:\n    - mnemonic: A\n",
            "register_map:\n  - mnemonic: A\n",
            "- mnemonic: A\n",
        ]
        for text in shapes:
            with self.subTest(text=text):
                registers, _ = yamlio.parse_yaml(text)
                self.assertEqual(registers[0]["mnemonic"], "A")

    def test_parse_rejects_garbage(self):
        with self.assertRaises(yamlio.YamlError):
            yamlio.parse_yaml("just a string")
        with self.assertRaises(yamlio.YamlError):
            yamlio.parse_yaml("a: [1, 2\nb: }")

    def test_select_default_must_be_one_of_the_options(self):
        settings = yamlio.coerce_settings({"custom_fields": [
            {"key": "mode", "type": "select", "options": ["a", "b"], "default": "c"},
        ]})
        self.assertEqual(settings["custom_fields"][0]["default"], "")

    def test_boolean_default_accepts_the_usual_words(self):
        for raw, expected in [("yes", True), ("no", False), (True, True),
                              (False, False), ("1", True), ("0", False)]:
            with self.subTest(raw=raw):
                out = yamlio.coerce_settings({"custom_fields": [
                    {"key": "flag", "type": "boolean", "default": raw},
                ]})
                self.assertIs(out["custom_fields"][0]["default"], expected)

    def test_unset_default_stays_unset_for_every_type(self):
        for ftype in ("string", "integer", "float", "boolean", "select"):
            with self.subTest(ftype=ftype):
                out = yamlio.coerce_settings({"custom_fields": [
                    {"key": "x", "type": ftype},
                ]})
                self.assertEqual(out["custom_fields"][0]["default"], "")

    def test_options_are_normalised(self):
        out = yamlio.coerce_settings({"custom_fields": [
            {"key": "mode", "type": "select", "options": "a, b ,a"},
        ]})
        self.assertEqual(out["custom_fields"][0]["options"], ["a", "b"])

    def test_export_keeps_booleans_unquoted(self):
        text = yamlio.dump_yaml([{"mnemonic": "X", "latched": True}], {})
        self.assertIn("latched: true", text)


class ProjectModelTests(TestCase):
    def test_counts(self):
        project = Project.objects.create(name="P", registers=[
            {"mnemonic": "A", "bits": [{"position": 0}, {"position": 1}]},
            {"mnemonic": "B"},
        ])
        self.assertEqual(project.register_count, 2)
        self.assertEqual(project.bit_count, 2)

    def test_as_yaml_round_trips(self):
        project = Project.objects.create(
            name="P",
            registers=[{"mnemonic": "A", "width": 32}],
            settings={"default_width": 32},
        )
        registers, settings = yamlio.parse_yaml(project.as_yaml())
        self.assertEqual(registers[0]["mnemonic"], "A")
        self.assertEqual(settings["default_width"], 32)


class DashboardTests(TestCase):
    def test_dashboard_lists_projects(self):
        Project.objects.create(name="Alpha")
        Project.objects.create(name="Beta")
        response = self.client.get(reverse("registermap:dashboard"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Alpha")
        self.assertContains(response, "Beta")

    def test_create_project(self):
        response = self.client.post(reverse("registermap:create"), {"name": "New one"})
        self.assertEqual(response.status_code, 302)
        project = Project.objects.get(name="New one")
        self.assertRedirects(response, project.get_absolute_url())

    def test_create_project_needs_a_name(self):
        response = self.client.post(reverse("registermap:create"), {"name": "  "})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(Project.objects.exists())

    def test_rename(self):
        project = Project.objects.create(name="Old")
        response = self.client.post(
            reverse("registermap:rename", args=[project.pk]), {"name": "New"})
        self.assertEqual(response.status_code, 302)
        project.refresh_from_db()
        self.assertEqual(project.name, "New")

    def test_duplicate_copies_registers_and_settings(self):
        project = Project.objects.create(
            name="Original",
            registers=[{"mnemonic": "A"}],
            settings={"default_width": 8},
        )
        response = self.client.post(reverse("registermap:duplicate", args=[project.pk]))
        self.assertEqual(response.status_code, 302)
        copy = Project.objects.exclude(pk=project.pk).get()
        self.assertEqual(copy.registers, project.registers)
        self.assertEqual(copy.settings, project.settings)
        self.assertIn("copy", copy.name)

    def test_delete(self):
        project = Project.objects.create(name="Doomed")
        response = self.client.post(reverse("registermap:delete", args=[project.pk]))
        self.assertEqual(response.status_code, 302)
        self.assertFalse(Project.objects.filter(pk=project.pk).exists())

    def test_import_creates_a_project_from_a_file(self):
        yaml_text = yamlio.dump_yaml([{"mnemonic": "A"}], {})
        response = self.client.post(reverse("registermap:import_create"), {
            "name": "Imported",
            "file": io.BytesIO(yaml_text.encode()),
        })
        self.assertEqual(response.status_code, 302)
        project = Project.objects.get(name="Imported")
        self.assertEqual(project.registers[0]["mnemonic"], "A")

    def test_import_without_a_file_is_rejected(self):
        response = self.client.post(reverse("registermap:import_create"), {"name": "x"})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(Project.objects.exists())


class EditorTests(TestCase):
    def setUp(self):
        self.project = Project.objects.create(name="Map")

    def test_editor_renders_the_project_data(self):
        self.project.registers = [{"mnemonic": "CTRL"}]
        self.project.save()
        response = self.client.get(self.project.get_absolute_url())
        self.assertEqual(response.status_code, 200)
        body = response.content.decode()
        self.assertIn('id="project-data"', body)
        self.assertIn("CTRL", body)

    def test_save_stores_the_registers(self):
        url = reverse("registermap:save", args=[self.project.pk])
        response = self.client.post(url, json.dumps({
            "registers": [{"mnemonic": "NEW", "width": 16}],
        }), content_type="application/json")
        self.assertEqual(response.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(self.project.registers[0]["mnemonic"], "NEW")

    def test_save_rejects_malformed_json(self):
        url = reverse("registermap:save", args=[self.project.pk])
        response = self.client.post(url, "{not json", content_type="application/json")
        self.assertEqual(response.status_code, 400)

    def test_save_does_not_touch_the_settings(self):
        self.project.settings = {"default_width": 8}
        self.project.save()
        url = reverse("registermap:save", args=[self.project.pk])
        self.client.post(url, json.dumps({"registers": []}),
                         content_type="application/json")
        self.project.refresh_from_db()
        self.assertEqual(self.project.settings["default_width"], 8)

    def test_export_get_returns_the_stored_map(self):
        self.project.registers = [{"mnemonic": "STORED"}]
        self.project.save()
        response = self.client.get(reverse("registermap:export", args=[self.project.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertIn("STORED", response.content.decode())
        self.assertIn("attachment", response["Content-Disposition"])

    def test_export_post_exports_what_the_browser_sends(self):
        response = self.client.post(
            reverse("registermap:export", args=[self.project.pk]),
            json.dumps({"registers": [{"mnemonic": "LIVELY"}]}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("LIVELY", response.content.decode())

    def test_import_replaces_the_registers(self):
        yaml_text = yamlio.dump_yaml([{"mnemonic": "IMPORTED"}], {})
        response = self.client.post(
            reverse("registermap:import", args=[self.project.pk]),
            {"file": io.BytesIO(yaml_text.encode())},
        )
        self.assertEqual(response.status_code, 302)
        self.project.refresh_from_db()
        self.assertEqual(self.project.registers[0]["mnemonic"], "IMPORTED")

    def test_import_keeps_the_projects_own_settings_when_the_file_has_none(self):
        self.project.settings = {"default_width": 8}
        self.project.save()
        yaml_text = yamlio.dump_yaml([{"mnemonic": "IMPORTED"}], {})
        self.client.post(reverse("registermap:import", args=[self.project.pk]),
                         {"file": io.BytesIO(yaml_text.encode())})
        self.project.refresh_from_db()
        self.assertEqual(self.project.settings["default_width"], 8)

    def test_import_adopts_the_settings_the_file_carries(self):
        yaml_text = yamlio.dump_yaml([{"mnemonic": "X"}], {"default_width": 16})
        self.client.post(reverse("registermap:import", args=[self.project.pk]),
                         {"file": io.BytesIO(yaml_text.encode())})
        self.project.refresh_from_db()
        self.assertEqual(self.project.settings["default_width"], 16)

    def test_import_reports_a_bad_file_as_json_to_the_editor(self):
        url = reverse("registermap:import", args=[self.project.pk])
        response = self.client.post(
            url,
            {"file": io.BytesIO(b"just a string")},
            HTTP_ACCEPT="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json())
        self.project.refresh_from_db()
        self.assertEqual(self.project.registers, [])


class SettingsTests(TestCase):
    """Every project keeps its own settings."""

    def setUp(self):
        self.project = Project.objects.create(name="Map")
        self.other = Project.objects.create(name="Other")

    def test_settings_page_renders(self):
        response = self.client.get(self.project.get_settings_url())
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Custom fields")

    def test_settings_are_stored_per_project(self):
        url = reverse("registermap:settings_save", args=[self.project.pk])
        response = self.client.post(url, json.dumps({"settings": {
            "address_increment": "0x8",
            "default_width": 16,
            "enabled_fields": ["address", "width"],
            "custom_fields": [{"key": "mode", "type": "select",
                               "options": ["a", "b"], "default": "a"}],
        }}), content_type="application/json")
        self.assertEqual(response.status_code, 200)

        self.project.refresh_from_db()
        self.other.refresh_from_db()
        self.assertEqual(self.project.settings["default_width"], 16)
        self.assertEqual(self.project.settings["custom_fields"][0]["options"], ["a", "b"])
        # The other project is untouched.
        self.assertEqual(self.other.settings, {})

    def test_settings_survive_a_reload(self):
        url = reverse("registermap:settings_save", args=[self.project.pk])
        self.client.post(url, json.dumps({"settings": {"default_width": 64}}),
                         content_type="application/json")
        response = self.client.get(self.project.get_settings_url())
        self.assertIn("64", response.content.decode())

    def test_the_server_coerces_what_it_is_given(self):
        url = reverse("registermap:settings_save", args=[self.project.pk])
        response = self.client.post(url, json.dumps({"settings": {
            "default_width": 9999,          # out of range
            "custom_fields": [{"key": "flag", "type": "boolean", "default": "yes"}],
        }}), content_type="application/json")
        payload = response.json()
        self.assertNotIn("default_width", payload["settings"])
        self.assertIs(payload["settings"]["custom_fields"][0]["default"], True)
        self.project.refresh_from_db()
        self.assertNotIn("default_width", self.project.settings)


class LocalOnlyTests(TestCase):
    """There is no login: everything works for whoever opens the app."""

    def test_no_login_page_is_reachable(self):
        for path in ("/login/", "/accounts/login/", "/admin/"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)

    def test_dashboard_needs_no_credentials(self):
        response = self.client.get(reverse("registermap:dashboard"))
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("password", response.content.decode().lower())
