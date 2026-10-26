"""YAML import/export for register maps.

This is a direct port of the coercion logic the original Flask app used, so
files written by either version stay interchangeable. The rules:

* Every register is a mapping of standard keys (address, mnemonic, width,
  access, description, reset_value) plus any number of user-defined custom
  fields, plus an optional ``bits`` list.
* Custom fields are described in the settings block by key + type. Types are
  ``string``, ``integer``, ``float``, ``select`` (a drop-down with an option
  list) and ``boolean``.
* Import is tolerant: a bare list of registers, a top-level ``registers:``
  key and ``register_map: registers:`` are all accepted.
"""

from __future__ import annotations

import io
import re
from typing import Any

import yaml

# Standard register keys (these are reserved; user-defined "custom fields"
# can't collide with them). Mirrors STANDARD_REGISTER_KEYS on the JS side.
STANDARD_REGISTER_KEYS: frozenset[str] = frozenset({
    "address", "mnemonic", "width", "access", "description", "reset_value", "bits",
})

# Toggleable fields exposed in the settings panel (the "Default fields"
# checkboxes). Mirrors REGISTER_FIELDS on the JS side.
TOGGLEABLE_REGISTER_FIELDS: tuple[str, ...] = (
    "address", "width", "access", "description", "reset_value",
)

CUSTOM_FIELD_TYPES: frozenset[str] = frozenset(
    {"string", "integer", "float", "select", "boolean"}
)

CUSTOM_FIELD_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Words accepted as booleans in a custom-field default. Mirrors TRUE_WORDS /
# FALSE_WORDS on the JS side.
TRUE_WORDS: frozenset[str] = frozenset({"true", "1", "yes", "y", "on"})
FALSE_WORDS: frozenset[str] = frozenset({"false", "0", "no", "n", "off"})


class YamlError(ValueError):
    """Raised when an uploaded file cannot be understood."""


# ---------------------------------------------------------------------------
# Coercion helpers
# ---------------------------------------------------------------------------

def _as_scalar(value: Any) -> Any:
    """Try to keep numbers as ints, but pass strings (e.g. '0x10') through."""
    if isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return value
        # Try plain integer first.
        try:
            return int(s, 0)  # '0x..', '0o..', '0b..' and decimal all work
        except ValueError:
            return value
    return value


def _coerce_bit(bit: dict) -> dict:
    out: dict[str, Any] = {}
    for key in ("position", "name", "width", "access", "description",
                "reset_value"):
        if key in bit and bit[key] not in (None, ""):
            if key == "reset_value":
                out[key] = str(bit[key]).strip()
            else:
                out[key] = _as_scalar(bit[key])
    return out


def _coerce_register(reg: dict) -> dict:
    """Coerce a register dict from the browser into clean YAML-friendly types.

    Empty fields are dropped so the YAML stays compact. Numeric fields are
    kept as ints when possible, otherwise the raw string is preserved.
    Unknown top-level keys (custom fields defined by the user) are passed
    through verbatim.
    """
    known_keys = ("address", "mnemonic", "name", "width", "access",
                  "description", "reset_value")
    out: dict[str, Any] = {}
    for key, raw in reg.items():
        if key == "bits":
            continue
        if raw in (None, ""):
            continue
        if key in known_keys:
            # Address and reset_value are kept as the user typed them so
            # hex formatting (e.g. "0x10") survives the round-trip.
            if key in ("address", "reset_value"):
                out[key] = str(raw).strip()
            else:
                out[key] = _as_scalar(raw)
        else:
            # Custom field — pass through. We trust the JSON the browser
            # sent; _coerce_bit/recursion isn't relevant at register level.
            out[key] = raw

    bits = reg.get("bits")
    if isinstance(bits, list) and bits:
        out["bits"] = [_coerce_bit(b) for b in bits if isinstance(b, dict)]
    return out


def coerce_typed_default(value: Any, ftype: str,
                         options: list[str] | None = None) -> Any:
    """Coerce a settings-payload default value to its declared field type.

    Mirrors parseTypedValue() on the JS side: strings stay strings, integer
    accepts decimal / 0x.., float accepts any finite number, boolean accepts
    the usual truthy/falsey words, and select must match one of its options.
    An unset (None or empty) value stays unset for every type so an absent
    default isn't invented. Anything that can't parse to the declared type
    falls back to unset ("").

    ``options`` is the allowed value list of a ``select`` field; it is ignored
    by every other type.
    """
    if value is None or value == "":
        return ""
    if ftype == "string":
        return str(value)
    if ftype == "integer":
        # `int(x, 0)` only accepts str/bytes/bytearray; pass native ints
        # through unchanged.
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, int):
            return value
        try:
            return int(value, 0)  # base 0 => accepts "0x.." and decimal
        except (TypeError, ValueError):
            return ""
    if ftype == "float":
        if isinstance(value, bool):
            return float(int(value))
        if isinstance(value, (int, float)):
            f = float(value)
            return f if f == f and abs(f) != float("inf") else ""
        try:
            f = float(value)
            return f if f == f and abs(f) != float("inf") else ""
        except (TypeError, ValueError):
            return ""
    if ftype == "boolean":
        if isinstance(value, bool):
            return value
        word = str(value).strip().lower()
        if word in TRUE_WORDS:
            return True
        if word in FALSE_WORDS:
            return False
        return ""
    if ftype == "select":
        candidate = str(value).strip()
        return candidate if candidate in (options or []) else ""
    return value


def coerce_options(raw: Any) -> list[str]:
    """Normalise a select field's option list.

    Accepts a list of scalars or a comma/newline separated string (how the
    settings UI writes it). Entries are trimmed, blanks dropped and
    duplicates removed, matching parseOptions() on the JS side.
    """
    if isinstance(raw, str):
        items: Any = raw.split(",")
    elif isinstance(raw, list):
        items = raw
    else:
        return []
    out: list[str] = []
    for item in items:
        s = str(item).strip()
        if s and s not in out:
            out.append(s)
    return out


def coerce_settings(raw: Any) -> dict[str, Any]:
    """Validate and normalise an editor settings dict.

    The settings panel state has four sub-keys:
      address_increment: str (hex or decimal; kept as a string)
      default_width:     int  (1..1024 bits)
      enabled_fields:    list[str] of fields to show
      custom_fields:     list[{key, type, default, options}] of user-defined fields

    Unknown keys are dropped. Invalid values fall back to defaults. Returns
    an empty dict if nothing usable came in.
    """
    out: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return out

    inc = raw.get("address_increment")
    if isinstance(inc, str) and inc.strip():
        out["address_increment"] = inc.strip()
    elif isinstance(inc, (int, float)) and not isinstance(inc, bool):
        out["address_increment"] = str(int(inc))

    width = raw.get("default_width")
    try:
        w = int(width)
        if 1 <= w <= 1024:
            out["default_width"] = w
    except (TypeError, ValueError):
        pass

    ef = raw.get("enabled_fields")
    if isinstance(ef, list):
        cleaned = [k for k in ef if isinstance(k, str) and k in TOGGLEABLE_REGISTER_FIELDS]
        if cleaned:
            out["enabled_fields"] = cleaned

    cf = raw.get("custom_fields")
    if isinstance(cf, list):
        cleaned_fields = []
        for entry in cf:
            if not isinstance(entry, dict):
                continue
            k = entry.get("key")
            if not isinstance(k, str) or not CUSTOM_FIELD_KEY_RE.match(k):
                continue
            if k in STANDARD_REGISTER_KEYS:
                continue
            t = entry.get("type")
            ftype = t if isinstance(t, str) and t in CUSTOM_FIELD_TYPES else "string"
            options = coerce_options(entry.get("options"))
            # Coerce the default against the declared type so a YAML with
            # `type: integer` + `default: 0x10` arrives at the JS side as
            # the int 16 (matches how the editor writes it).
            coerced = coerce_typed_default(entry.get("default", ""), ftype, options)
            field: dict[str, Any] = {"key": k, "type": ftype, "default": coerced}
            if ftype == "select":
                field["options"] = options
            cleaned_fields.append(field)
        if cleaned_fields:
            out["custom_fields"] = cleaned_fields

    return out


def coerce_registers(raw: Any) -> list[dict]:
    """Coerce a list of registers coming from the browser."""
    if not isinstance(raw, list):
        return []
    return [_coerce_register(r) for r in raw if isinstance(r, dict)]


def _custom_fields(settings: Any) -> dict[str, dict]:
    """Index a settings dict's custom-field definitions by key."""
    if not isinstance(settings, dict):
        return {}
    out: dict[str, dict] = {}
    for entry in settings.get("custom_fields") or []:
        if isinstance(entry, dict) and isinstance(entry.get("key"), str):
            out[entry["key"]] = entry
    return out


def reconcile_registers(registers: list[dict], old_settings: Any,
                        new_settings: Any) -> list[dict]:
    """Apply a settings change to the stored registers.

    Two rules:

    * A custom field that is no longer defined is stripped from every
      register.
    * A register holding a select value that is no longer one of the
      field's options falls back to that field's default (which is unset
      when the default isn't a valid option either).

    Registers are modified in place and returned.
    """
    old_fields = _custom_fields(old_settings)
    new_fields = _custom_fields(new_settings)
    removed = [k for k in old_fields if k not in new_fields]

    for reg in registers:
        if not isinstance(reg, dict):
            continue
        for key in removed:
            reg.pop(key, None)
        for key, field in new_fields.items():
            if field.get("type") != "select":
                continue
            options = coerce_options(field.get("options"))
            value = reg.get(key)
            if value is None or value == "":
                continue  # an unset field stays unset
            if str(value) in options:
                continue  # still a valid choice
            default = field.get("default")
            reg[key] = default if default else ""
    return registers


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def extract_registers(data: Any) -> list[dict] | None:
    """Pull a list of register dicts out of a parsed YAML document.

    Accepts any of these shapes (the editor exports the first):
      register_map:
        registers: [ ... ]
      register_map: [ ... ]
      registers:    [ ... ]
      [ ... ]                       (bare list)
    """
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]

    if not isinstance(data, dict):
        return None

    if "register_map" in data:
        rm = data["register_map"]
        if isinstance(rm, dict) and isinstance(rm.get("registers"), list):
            return rm["registers"]
        if isinstance(rm, list):
            return rm

    if isinstance(data.get("registers"), list):
        return data["registers"]

    return None


def parse_yaml(text: str | bytes) -> tuple[list[dict], dict]:
    """Parse an uploaded YAML file into (registers, settings).

    Raises YamlError with a human-readable message when the file can't be
    understood.
    """
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise YamlError(f"YAML parse error: {exc}") from exc

    registers = extract_registers(data)
    if registers is None:
        raise YamlError(
            "Could not find a register list in the YAML. Expected a list, a "
            "'registers:' key, or a 'register_map: registers:' structure."
        )

    settings: dict = {}
    if isinstance(data, dict):
        rm = data.get("register_map")
        if isinstance(rm, dict) and isinstance(rm.get("settings"), dict):
            settings = coerce_settings(rm["settings"])

    return registers, settings


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def build_document(registers: list[dict], settings: dict) -> dict:
    """Assemble the full YAML document for a register map."""
    register_map: dict[str, Any] = {
        "metadata": {
            "generator": "register-map-app",
            "version": "1.0",
        },
    }
    if settings:
        register_map["settings"] = settings
    register_map["registers"] = registers
    return {"register_map": register_map}


def dump_yaml(registers: list[dict], settings: dict) -> str:
    """Render a register map as YAML text."""
    buf = io.StringIO()
    yaml.safe_dump(
        build_document(registers, settings),
        buf,
        sort_keys=False,
        default_flow_style=False,
        allow_unicode=True,
        width=100,
    )
    return buf.getvalue()
