"""URL map for the register-map app."""

from django.urls import path

from . import views

app_name = "registermap"

urlpatterns = [
    path("", views.dashboard, name="dashboard"),
    path("projects/new/", views.project_create, name="create"),
    path("projects/import/", views.project_import_create, name="import_create"),
    path("projects/<int:pk>/", views.editor, name="editor"),
    path("projects/<int:pk>/edit/", views.project_rename, name="rename"),
    path("projects/<int:pk>/delete/", views.project_delete, name="delete"),
    path("projects/<int:pk>/duplicate/", views.project_duplicate, name="duplicate"),
    path("projects/<int:pk>/settings/", views.settings_page, name="settings"),
    path("projects/<int:pk>/save/", views.project_save, name="save"),
    path("projects/<int:pk>/settings/save/", views.settings_save, name="settings_save"),
    path("projects/<int:pk>/export/", views.export_yaml, name="export"),
    path("projects/<int:pk>/import/", views.import_yaml, name="import"),
]
