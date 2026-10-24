"""Root URL configuration."""

from django.urls import include, path

urlpatterns = [
    path("", include("registermap.urls")),
]
