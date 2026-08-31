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
from typing import Any

import yaml
from flask import Flask, jsonify, render_template, request, send_file

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024  # 4 MB upload cap

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
    """
    out: dict[str, Any] = {}
    for key in ("address", "mnemonic", "name", "width", "access",
                "description", "reset_value"):
        if key in reg and reg[key] not in (None, ""):
            # Address and reset_value are kept as the user typed them so
            # hex formatting (e.g. "0x10") survives the round-trip.
            if key in ("address", "reset_value"):
                out[key] = str(reg[key]).strip()
            else:
                out[key] = _as_scalar(reg[key])

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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index() -> str:
    return render_template("index.html")


@app.route("/generate", methods=["POST"])
def generate():
    payload = request.get_json(silent=True) or {}
    raw_registers = payload.get("registers") or []
    if not isinstance(raw_registers, list):
        return jsonify({"error": "registers must be a list"}), 400

    registers = [_coerce_register(r) for r in raw_registers if isinstance(r, dict)]

    doc = {
        "register_map": {
            "metadata": {
                "generator": "register-map-app",
                "version": "1.0",
            },
            "registers": registers,
        }
    }

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

    return jsonify({"registers": registers})


@app.errorhandler(413)
def too_large(_exc):
    return jsonify({"error": "File too large (max 4 MB)."}), 413


if __name__ == "__main__":
    # Bind to localhost by default; override with HOST=0.0.0.0 if needed.
    import os
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    app.run(host=host, port=port, debug=True)
