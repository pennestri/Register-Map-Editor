# Register Map Editor

A small Flask web app for editing hardware register maps and exporting them as
YAML.

## Features

- Add as many registers as you like.
- Per register: address, mnemonic, width, access (`r` / `w` / `rw`), description,
  reset value.
- Per register: any number of bit-field rows with `position`, `width`, `name`,
  access and description (the bit's function).
- **Register map settings** at the top of the page lets you tune the editor
  to match your register-map conventions:
  - **Address increment** applied to the default address of each newly added
    register (default `0x4`; hex `0x..` or decimal both accepted).
  - **Default data size** used as the default width for newly added registers
    (default `32` bits).
  - **Default fields** checkboxes hide the corresponding input on every
    register card; hidden fields are also dropped from the exported YAML.
    Mnemonic is always shown because it's the register identifier.
  - **Custom fields** lets you define additional keys (e.g. `vendor`,
    `ip_version`) that are added to every register with a default value.
    Custom fields appear in each register's *Custom fields* section as an
    editable key/value row. Renaming a custom field in settings renames it
    everywhere; removing a custom field deletes its key from every register.
    Ad-hoc keys present in uploaded YAML (but not defined here) are also
    preserved on the register and exported.
  - **Settings round-trip**: every export writes the current settings under
    `register_map.settings:` in the YAML. Uploading a file that carries
    settings applies them to the editor (existing per-register values
    survive; only registers missing a custom field get the imported default).
    Files without a `settings:` block leave the editor's local settings
    untouched.
  - Settings persist in `localStorage` and can be restored with the
    *Reset settings to defaults* button.
- **Download YAML** generates `register_map.yaml` from the current form.
- **Upload YAML** loads an existing register map back into the editor for
  editing.

## Run

The project is managed with [uv](https://docs.astral.sh/uv/). Install uv
once (`curl -LsSf https://astral.sh/uv/install.sh | sh`), then from the repo
root:

```bash
# One-shot run (uv creates .venv and installs deps on first invocation)
uv run python app.py
# open http://127.0.0.1:5000
```

Other common entry points:

```bash
uv sync                       # create .venv and install deps
uv run app                    # same as `uv run python app.py`
uv run register-map-editor    # via the console script defined in pyproject.toml
```

Bind to all interfaces on a custom port with env vars:

```bash
HOST=0.0.0.0 PORT=8080 uv run python app.py
```

Pin the Python interpreter (optional — uv honours `.python-version`):

```bash
uv python install 3.12
```

### Without uv

If you prefer the standard tooling, the legacy workflow still works:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
```

## YAML format

The exporter produces, and the importer accepts, the following shape:

```yaml
register_map:
  metadata:
    generator: register-map-app
    version: "1.0"
  settings:                       # editor settings; round-trippable
    address_increment: '0x4'      # hex or decimal string; default for new registers
    default_width: 32             # bits; default for new registers
    enabled_fields:               # which standard fields to show per register
      - address
      - width
      - access
      - description
      - reset_value
    custom_fields:                # user-defined register keys
      - key: vendor
        default: acme
      - key: ip_version
        default: "1.0"
  registers:
    - address: 0x00000000
      mnemonic: CTRL
      width: 32
      access: rw            # r | w | rw
      description: ...
      reset_value: 0
      # Any additional top-level keys are user-defined custom fields and
      # are preserved verbatim through the import/export round-trip.
      vendor: acme
      ip_version: "1.0"
      bits:
        - position: 0
          width: 1
          name: ENABLE
          access: rw        # omitted => inherits register access
          description: Module enable
          reset_value: 0
```

The importer is tolerant: it will also accept a bare list of registers, or a
top-level `registers:` key, or a flat `register_map: [ ... ]` list.

See `examples/sample_register_map.yaml` for a full example.

## REST endpoints

| Method | Path        | Body / form          | Returns                          |
|--------|-------------|----------------------|----------------------------------|
| GET    | `/`         | —                    | HTML editor page                 |
| POST   | `/generate` | JSON `{registers:[]}`| `register_map.yaml` (attachment) |
| POST   | `/upload`   | multipart `file=...` | JSON `{registers:[]}`            |
