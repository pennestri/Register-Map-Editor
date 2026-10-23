"""
Register Map editor — a small Flask app.

- Add/remove registers in the browser.
- Each register: address, mnemonic, width, access (r/w/rw), description.
- Each register can contain any number of bit rows: position, name, width,
  access, description.
- POST /generate  -> returns register_map.yaml
- POST /upload    -> accepts a YAML file, returns its register list as JSON
"""

from __future__ import annotations

import io
import re
from typing import Any

import yaml
from flask import Flask, jsonify, render_template, request, send_file

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024  # 4 MB upload cap

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

CUSTOM_FIELD_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Mirrors CUSTOM_FIELD_TYPES on the JS side.
CUSTOM_FIELD_TYPES: frozenset[str] = frozenset(
    {"string", "integer", "float", "select", "boolean"}
)

# Words accepted as booleans in a custom-field default. Mirrors TRUE_WORDS /
# FALSE_WORDS on the JS side.
TRUE_WORDS: frozenset[str] = frozenset({"true", "1", "yes", "y", "on"})
FALSE_WORDS: frozenset[str] = frozenset({"false", "0", "no", "n", "off"})

# ---------------------------------------------------------------------------
# YAML helpers
# ---------------------------------------------------------------------------

def _extract_registers(data: Any) -> list[dict] | None:
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


def _coerce_typed_default(value: Any, ftype: str, options: list[str] | None = None) -> Any:
    """Coerce a settings-payload default value to its declared field type.

    Mirrors parseTypedValue() on the JS side: strings stay strings, integer
    accepts decimal / 0x.., float accepts any finite number, boolean accepts
    the usual truthy/falsey words, and select must match one of its options.
    An unset (None or empty) value stays unset for every type so an absent
    default isn't invented. Anything that can't parse to the declared type
    falls back to unset ("").

    `options` is the allowed value list of a `select` field; it is ignored by
    every other type.
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


def _coerce_options(raw: Any) -> list[str]:
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


def _coerce_settings(raw: Any) -> dict[str, Any]:
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
        cleaned = []
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
            options = _coerce_options(entry.get("options"))
            def_val = entry.get("default", "")
            # Coerce the default against the declared type so a YAML with
            # `type: integer` + `default: 0x10` arrives at the JS side as
            # the int 16 (matches how the editor writes it).
            coerced = _coerce_typed_default(def_val, ftype, options)
            field: dict[str, Any] = {"key": k, "type": ftype, "default": coerced}
            if ftype == "select":
                field["options"] = options
            cleaned.append(field)
        if cleaned:
            out["custom_fields"] = cleaned

    return out


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index() -> str:
    return render_template("index.html")


@app.route("/settings")
def settings() -> str:
    """Register-map settings live on their own page; both pages share state
    through localStorage (see static/core.js)."""
    return render_template("settings.html")


@app.route("/generate", methods=["POST"])
def generate():
    payload = request.get_json(silent=True) or {}
    raw_registers = payload.get("registers") or []
    if not isinstance(raw_registers, list):
        return jsonify({"error": "registers must be a list"}), 400

    registers = [_coerce_register(r) for r in raw_registers if isinstance(r, dict)]
    settings = _coerce_settings(payload.get("settings"))

    register_map: dict[str, Any] = {
        "metadata": {
            "generator": "register-map-app",
            "version": "1.0",
        },
    }
    if settings:
        register_map["settings"] = settings
    register_map["registers"] = registers

    doc = {"register_map": register_map}

    buf = io.StringIO()
    yaml.safe_dump(
        doc,
        buf,
        sort_keys=False,
        default_flow_style=False,
        allow_unicode=True,
        width=100,
    )
    payload = buf.getvalue().encode("utf-8")
    out = io.BytesIO(payload)
    out.seek(0)
    return send_file(
        out,
        mimetype="text/yaml; charset=utf-8",
        as_attachment=True,
        download_name="register_map.yaml",
    )


@app.route("/upload", methods=["POST"])
def upload():
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "No file uploaded"}), 400

    try:
        data = yaml.safe_load(file.read())
    except yaml.YAMLError as exc:
        return jsonify({"error": f"YAML parse error: {exc}"}), 400

    registers = _extract_registers(data)
    if registers is None:
        return jsonify(
            {"error": "Could not find a register list in the YAML. "
                      "Expected a list, a 'registers:' key, or a "
                      "'register_map: registers:' structure."}
        ), 400

    # Pull settings out of register_map.settings if present. Returned as None
    # (not {}) so the client can distinguish "no settings in file" from
    # "settings in file but every key invalid".
    settings = None
    if isinstance(data, dict):
        rm = data.get("register_map")
        if isinstance(rm, dict) and isinstance(rm.get("settings"), dict):
            settings = _coerce_settings(rm["settings"]) or None

    return jsonify({"registers": registers, "settings": settings})


@app.errorhandler(413)
def too_large(_exc):
    return jsonify({"error": "File too large (max 4 MB)."}), 413


def main() -> None:
    """Entry point used by `python app.py` and the `register-map-editor` script."""
    # Bind to localhost by default; override with HOST=0.0.0.0 if needed.
    import os
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    app.run(host=host, port=port, debug=True)


if __name__ == "__main__":
    main()
