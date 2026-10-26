# Register Map Editor

A small local web app for editing hardware register maps and exporting them
as YAML. Built with Django, runs on your own machine, no accounts and no
external services.

## Features

- **Dashboard** at `/` — every register map you have saved, with its register
  and bit count, when it was last touched, and actions to open, export,
  duplicate, rename or delete it. Create a new project from scratch, or
  import an existing YAML register map.
- **Per-project settings.** A project is one register map *plus* the settings
  it was written with: address increment, default data size, which standard
  fields appear on a register card, and the custom-field definitions. Two
  projects never share settings.
- **Editor** at `/projects/<id>/` — the register list with bit rows, plus a
  custom-field section per register.
  - Address, mnemonic, width, access (`r` / `w` / `rw`), description, reset
    value.
  - Any number of bit-field rows per register: position, width, name, access
    and description.
  - **Custom fields** on every register: `string`, `integer`, `float`,
    `select` (a drop-down limited to an option list you define) and
    `boolean` (a checkbox that emits a real `true` / `false`). The type is
    chosen when the field is created and can't be changed afterwards.
  - **Save** writes the map back to the project; **Download YAML** exports
    exactly what is on screen, saved or not.
  - **Upload YAML** replaces the project's registers with a file. Settings
    the file carries are adopted; settings it doesn't carry are left alone.
- **Settings page** at `/projects/<id>/settings/` — every change stays local
  until you press **Save settings**; the page warns you before you leave with
  unsaved edits.
  - The **type** of a custom field is fixed once the field is created, so the
    values already stored on the registers always stay interpretable.
  - **Removing a custom field strips it from every register** in the map.
  - **Removing an option from a `select` field** puts that field's default
    back on every register that used the removed option.
- **Download / import YAML** anywhere. The file format is stable: a file
  exported by this tool can be imported again, and files written by earlier
  versions still load.
- No login. The app binds to `127.0.0.1` and has no accounts; whoever opens
  it on the machine is the only user.

## Run

The project is managed with [uv](https://docs.astral.sh/uv/). Install uv
once (`curl -LsSf https://astral.sh/uv/install.sh | sh`), then from the repo
root:

```bash
# One-shot run: uv creates .venv and installs deps on first invocation
uv run python manage.py migrate      # create the local database
uv run python manage.py runserver
# editor:  http://127.0.0.1:5000/
```

Other entry points:

```bash
uv sync                       # create .venv and install deps
uv run manage.py test         # run the test suite
uv run register-map-editor    # console script: starts the local server
```

Bind to all interfaces on a custom port with env vars:

```bash
HOST=0.0.0.0 PORT=8080 uv run register-map-editor
```

`DJANGO_DEBUG=0` turns off debug mode and `DJANGO_SECRET_KEY=…` overrides the
locally generated key.

### Without uv

If you prefer the standard tooling, the legacy workflow still works:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

## Where the data lives

Everything is in a local SQLite file, `db.sqlite3`, next to `manage.py`
(gitignored). Each project is one row holding its registers and its settings
as JSON. Deleting the file deletes your projects; export anything you want to
keep. There is no server, no sync and no backup beyond that.

## Project layout

```
manage.py                 Django entry point
config/                   settings, root URLconf, WSGI/ASGI
registermap/
  models.py               the Project model (registers + settings)
  yamlio.py               YAML import/export and type coercion
  views.py                dashboard, editor, settings, save, export, import
  forms.py                project create / rename / import forms
  urls.py                 URL map
  tests.py                test suite
  migrations/
  templates/registermap/  base template + dashboard / editor / settings / forms
  static/registermap/     style.css, core.js, editor.js, settings.js
examples/                 a sample register map
```

`core.js` is loaded by both the editor and the settings page. Classic scripts
share one global scope, so `state` and the type helpers are defined once. The
project is embedded in the page as JSON and written back with `fetch()`.

## YAML format

The exporter produces, and the importer accepts, the following shape:

```yaml
register_map:
  metadata:
    generator: register-map-app
    version: "1.0"
  settings:                       # this project's settings; round-trippable
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
        type: string                # string | integer | float | select | boolean
        default: acme
      - key: ip_version
        type: integer
        default: 16                 # emitted as an unquoted integer in YAML
      - key: mode
        type: select                # drop-down; only these values are allowed
        default: normal
        options:
          - fast
          - normal
          - slow
      - key: latched
        type: boolean               # checkbox on each register
        default: true
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
      ip_version: 16
      mode: normal
      latched: true
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

## Endpoints

| Method | Path                              | Returns                        |
|--------|-----------------------------------|--------------------------------|
| GET    | `/`                               | dashboard                      |
| POST   | `/projects/new/`                  | create a project               |
| POST   | `/projects/import/`               | create a project from a YAML file |
| GET    | `/projects/<id>/`                 | editor                         |
| GET    | `/projects/<id>/settings/`        | settings page                  |
| POST   | `/projects/<id>/save/`            | store the registers (JSON)     |
| POST   | `/projects/<id>/settings/save/`   | store the settings (JSON)      |
| GET    | `/projects/<id>/export/`          | YAML of the stored project     |
| POST   | `/projects/<id>/export/`          | YAML of the registers sent in the request |
| POST   | `/projects/<id>/import/`          | replace the project from a YAML file |
| POST   | `/projects/<id>/duplicate/`       | copy the project               |
| GET    | `/projects/<id>/edit/`            | rename the project             |
| GET    | `/projects/<id>/delete/`          | delete the project             |

## Tests

```bash
uv run manage.py test
```

The suite covers the YAML format (round-trips, the tolerant import shapes,
type coercion for every custom-field type), the dashboard and project
actions, the JSON save endpoints, per-project settings isolation, and that
there is no login to get in the way.

## License

MIT — see [LICENSE](LICENSE).
