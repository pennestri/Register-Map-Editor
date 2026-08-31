# Register Map Editor

A small Flask web app for editing hardware register maps and exporting them as
YAML.

## Features

- Add as many registers as you like.
- Per register: address, mnemonic, width, access (`r` / `w` / `rw`), description,
  reset value.
- Per register: any number of bit-field rows with `position`, `width`, `name`,
  access and description (the bit's function).
- **Download YAML** generates `register_map.yaml` from the current form.
- **Upload YAML** loads an existing register map back into the editor for
  editing.

## Run

```bash
cd register-map-app
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
# open http://127.0.0.1:5000
```

You can also bind to all interfaces with `HOST=0.0.0.0 PORT=8080 python app.py`.

## YAML format

The exporter produces, and the importer accepts, the following shape:

```yaml
register_map:
  metadata:
    generator: register-map-app
    version: "1.0"
  registers:
    - address: 0x00000000
      mnemonic: CTRL
      width: 32
      access: rw            # r | w | rw
      description: ...
      reset_value: 0
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
