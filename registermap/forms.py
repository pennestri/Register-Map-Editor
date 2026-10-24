"""Forms for creating, renaming and importing projects."""

from __future__ import annotations

from django import forms

from .models import Project


class ProjectForm(forms.ModelForm):
    """Create or rename a project."""

    class Meta:
        model = Project
        fields = ["name"]
        widgets = {
            "name": forms.TextInput(attrs={
                "placeholder": "e.g. STM32 UART",
                "autocomplete": "off",
                "spellcheck": "false",
            }),
        }

    def clean_name(self) -> str:
        name = (self.cleaned_data.get("name") or "").strip()
        if not name:
            raise forms.ValidationError("Give the project a name.")
        if len(name) > 120:
            raise forms.ValidationError("That name is too long (120 characters max).")
        return name


class ImportForm(forms.Form):
    """Upload a YAML register map."""

    file = forms.FileField(
        label="YAML file",
        help_text="A register map exported by this tool (or any file with a "
                  "register list).",
    )

    def clean_file(self):
        uploaded = self.cleaned_data["file"]
        if uploaded.size > 4 * 1024 * 1024:
            raise forms.ValidationError("File too large (max 4 MB).")
        return uploaded


class NewProjectFromFileForm(forms.Form):
    """Create a project straight from an uploaded YAML file."""

    name = forms.CharField(
        max_length=120,
        required=False,
        label="Project name",
        help_text="Leave empty to use the file name.",
        widget=forms.TextInput(attrs={
            "placeholder": "e.g. STM32 UART",
            "autocomplete": "off",
            "spellcheck": "false",
        }),
    )
    file = forms.FileField(label="YAML file")
