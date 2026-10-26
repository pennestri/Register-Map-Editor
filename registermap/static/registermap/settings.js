// Register Map editor — settings page.
//
// Owns the settings form: address increment, default width, the standard
// field toggles and the custom-field definitions. Every change is written
// back to the server (debounced) by saveSettings() in core.js.
//
// Expects core.js to be loaded first.

function renderSettingsCustomFields() {
  const list = $("#settings-cf-list");
  if (!list) return;
  list.innerHTML = "";
  const cfs = state.settings.customFields;
  if (cfs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-mini";
    empty.textContent = "No custom fields defined. Add one below to make it appear on every register.";
    list.appendChild(empty);
    return;
  }
  for (const cf of cfs) list.appendChild(renderSettingsCustomFieldRow(cf));
}

function renderSettingsCustomFieldRow(cf) {
  const row = document.createElement("div");
  row.className = "settings-cf-row";

  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.value = cf.key;
  keyInput.placeholder = "field name";
  keyInput.spellcheck = false;
  keyInput.autocomplete = "off";
  keyInput.addEventListener("input", () => {
    const newKey = keyInput.value.trim();
    if (!newKey || !CF_KEY_RE.test(newKey)) return; // ignore intermediate invalid
    if (newKey === cf.key) return;
    if (state.settings.customFields.some((x) => x !== cf && x.key === newKey)) {
      setStatus(`Custom field '${newKey}' is already defined.`, "warn");
      return;
    }
    cf.key = newKey;
    markSettingsDirty();
    renderSettingsCustomFields();
  });
  row.appendChild(keyInput);

  // The type is fixed once the field is created: changing it would leave
  // the values already stored on the registers uninterpretable.
  const typeSelect = document.createElement("select");
  typeSelect.title = "The type can't be changed after the field is created.";
  typeSelect.disabled = true;
  for (const t of CUSTOM_FIELD_TYPES) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    if (t === (cf.type || "string")) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  row.appendChild(typeSelect);

  // Option list — only rendered for select fields; every other type lets the
  // default control stretch across the options column instead.
  const type = cf.type || "string";
  const isSelect = SELECT_LIKE_TYPES.has(type);
  if (isSelect) {
    const optInput = document.createElement("input");
    optInput.type = "text";
    optInput.className = "cf-options";
    optInput.value = formatOptions(cf.options);
    optInput.placeholder = "option a, option b";
    optInput.title = "Comma separated list of allowed values";
    optInput.spellcheck = false;
    optInput.autocomplete = "off";
    optInput.addEventListener("input", () => {
      const opts = parseOptions(optInput.value);
      cf.options = opts;
      // A default outside the new list can no longer be selected; flag it
      // instead of silently dropping the value.
      if (cf.default !== "" && !opts.includes(cf.default)) {
        optInput.classList.add("input-error");
        optInput.title = `Default "${formatCustomValue(cf.default)}" is not one of the options`;
      } else {
        optInput.classList.remove("input-error");
        optInput.title = "";
      }
      markSettingsDirty();
    });
    row.appendChild(optInput);
  }
  row.appendChild(buildSettingsDefaultControl(cf, !isSelect));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.title = "Remove this field from every register";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    const idx = state.settings.customFields.indexOf(cf);
    if (idx < 0) return;
    if (!confirm(`Remove custom field "${cf.key}" from every register?`)) return;
    state.settings.customFields.splice(idx, 1);
    markSettingsDirty();
    renderSettingsCustomFields();
  });
  row.appendChild(remove);

  return row;
}

// The "default value" cell of a settings custom-field row. Free-text for
// string/integer/float, a fixed three-way select for boolean, and a select
// over the configured options for select fields. `spanTwo` stretches the
// control over the options column when the row has no options editor.
function buildSettingsDefaultControl(cf, spanTwo) {
  const type = cf.type || "string";

  if (type === "boolean") {
    const sel = document.createElement("select");
    sel.className = "cf-default" + (spanTwo ? " span2" : "");
    sel.title = "Default value for newly added registers";
    for (const pair of [["", "— not set —"], ["true", "true"], ["false", "false"]]) {
      const o = document.createElement("option");
      o.value = pair[0];
      o.textContent = pair[1];
      sel.appendChild(o);
    }
    const cur = storedBool(cf.default);
    sel.value = cur === undefined ? "" : String(cur);
    sel.addEventListener("change", () => {
      const b = storedBool(sel.value);
      cf.default = b === undefined ? "" : b;
      markSettingsDirty();
    });
    return sel;
  }

  if (SELECT_LIKE_TYPES.has(type)) {
    const sel = document.createElement("select");
    sel.className = "cf-default";
    sel.title = "Default value for newly added registers";
    fillSettingsSelectOptions(sel, parseOptions(cf.options), cf.default);
    sel.addEventListener("change", () => {
      const parsed = parseTypedValue(sel.value, "select", { options: cf.options });
      cf.default = parsed.ok ? parsed.value : "";
      markSettingsDirty();
    });
    return sel;
  }

  const defInput = document.createElement("input");
  defInput.type = "text";
  defInput.className = "cf-default" + (spanTwo ? " span2" : "");
  defInput.value = formatCustomValue(cf.default);
  defInput.placeholder = defaultPlaceholder(type);
  defInput.inputMode = inputmodeForType(type);
  defInput.spellcheck = false;
  defInput.autocomplete = "off";
  defInput.addEventListener("input", () => {
    const parsed = parseTypedValue(defInput.value, type, { options: cf.options });
    if (!parsed.ok) {
      defInput.classList.add("input-error");
      defInput.title = `Not a valid ${type}`;
      return;
    }
    defInput.classList.remove("input-error");
    defInput.title = "";
    cf.default = parsed.value;
    // Default applies to NEW registers only; existing values are preserved.
    markSettingsDirty();
  });
  return defInput;
}

// Populate a settings-page <select> with an "unset" entry plus the
// configured options. Same orphan handling as the editor-side drop-down.
function fillSettingsSelectOptions(select, options, current) {
  const list = parseOptions(options);
  const cur = current == null ? "" : String(current);
  const orphan = cur !== "" && !list.includes(cur);
  if (orphan) list.push(cur);

  const unset = document.createElement("option");
  unset.value = "";
  unset.textContent = "— not set —";
  select.appendChild(unset);

  for (const opt of list) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt + (opt === cur && orphan ? " (unknown)" : "");
    select.appendChild(o);
  }
  select.value = cur;
}

// Re-sync every settings input from `state.settings`. Called once on boot
// and after any operation that replaces the settings wholesale (reset).
function syncSettingsUI() {
  const addrIncInput = $("#setting-addr-inc");
  const defaultWidthInput = $("#setting-default-width");
  const fieldCheckboxes = document.querySelectorAll("[data-setting-field]");
  if (addrIncInput) addrIncInput.value = state.settings.addressIncrement;
  if (defaultWidthInput) defaultWidthInput.value = state.settings.defaultWidth;
  fieldCheckboxes.forEach((cb) => {
    cb.checked = state.settings.enabledFields.has(cb.dataset.settingField);
  });
  renderSettingsCustomFields();
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const addrIncInput = $("#setting-addr-inc");
  const defaultWidthInput = $("#setting-default-width");
  const fieldCheckboxes = document.querySelectorAll("[data-setting-field]");
  const newCfKey = $("#new-cf-key");
  const newCfType = $("#new-cf-type");
  const newCfOptions = $("#new-cf-options");
  const newCfDefault = $("#new-cf-default");

  syncSettingsUI();
  updateSaveState();

  addrIncInput.addEventListener("input", () => {
    state.settings.addressIncrement = addrIncInput.value;
    markSettingsDirty();
  });

  defaultWidthInput.addEventListener("input", () => {
    const n = Number(defaultWidthInput.value);
    state.settings.defaultWidth =
      Number.isFinite(n) && n >= 1 ? Math.min(1024, Math.floor(n)) : 32;
    markSettingsDirty();
  });

  fieldCheckboxes.forEach((cb) => {
    cb.addEventListener("change", () => {
      const key = cb.dataset.settingField;
      if (cb.checked) state.settings.enabledFields.add(key);
      else state.settings.enabledFields.delete(key);
      markSettingsDirty();
    });
  });

  // Nothing is written back until you press Save.
  $("#save-settings").addEventListener("click", saveSettingsNow);

  $("#settings-reset").addEventListener("click", () => {
    if (!confirm(
      "Reset register-map settings to defaults?\n\n" +
      "Custom fields are removed from the definition, and their values are " +
      "stripped from every register.")) return;
    state.settings = defaultSettings();
    syncSettingsUI();
    markSettingsDirty();
    setStatus("Settings reset to defaults. Press Save to store them.", "warn");
  });

  // ---- Custom fields ----------------------------------------------------
  const newCfTypeNow = () =>
    CUSTOM_FIELD_TYPES.includes(newCfType.value) ? newCfType.value : "string";

  // Keep the add-form in step with the picked type: the options box only
  // exists for select fields, and the default input's hint changes.
  function syncNewCfForm() {
    const t = newCfTypeNow();
    const isSelect = SELECT_LIKE_TYPES.has(t);
    newCfOptions.hidden = !isSelect;
    newCfDefault.placeholder = defaultPlaceholder(t);
    newCfDefault.inputMode = inputmodeForType(t);
    newCfDefault.classList.remove("input-error");
    newCfOptions.classList.remove("input-error");
  }
  syncNewCfForm();

  const validateNewCfDefault = () => {
    const t = newCfTypeNow();
    const options = parseOptions(newCfOptions.value);
    const parsed = parseTypedValue(newCfDefault.value, t, { options });
    newCfDefault.classList.toggle("input-error",
      !parsed.ok && newCfDefault.value !== "");
    newCfOptions.classList.toggle("input-error",
      SELECT_LIKE_TYPES.has(t) && options.length === 0);
    return parsed;
  };

  $("#add-cf").addEventListener("click", () => {
    const key = newCfKey.value.trim();
    const type = newCfTypeNow();
    const isSelect = SELECT_LIKE_TYPES.has(type);
    const options = isSelect ? parseOptions(newCfOptions.value) : [];
    const defRaw = newCfDefault.value;
    if (!key) { setStatus("Custom field name is required.", "warn"); newCfKey.focus(); return; }
    if (!CF_KEY_RE.test(key)) {
      setStatus("Field name must be a valid identifier (letters, digits, underscore).", "warn");
      newCfKey.focus();
      return;
    }
    if (STANDARD_REGISTER_KEYS.has(key)) {
      setStatus(`'${key}' is a reserved name (use a different key).`, "warn");
      newCfKey.focus();
      return;
    }
    if (state.settings.customFields.some((cf) => cf.key === key)) {
      setStatus(`Custom field '${key}' is already defined.`, "warn");
      newCfKey.focus();
      return;
    }
    if (isSelect && options.length === 0) {
      setStatus("A select field needs at least one option.", "warn");
      newCfOptions.focus();
      return;
    }
    const parsed = parseTypedValue(defRaw, type, { options });
    if (!parsed.ok) {
      setStatus(isSelect
        ? `Default value must be one of: ${options.join(", ")}`
        : `Default value is not a valid ${type}.`, "warn");
      newCfDefault.focus();
      return;
    }
    state.settings.customFields.push({ key, type, default: parsed.value, options });
    markSettingsDirty();
    newCfKey.value = "";
    newCfOptions.value = "";
    newCfDefault.value = "";
    syncNewCfForm();
    renderSettingsCustomFields();
    setStatus(`Added custom field "${key}". It applies to newly added registers.`, "ok");
  });
  // Live-validate the Add-form's default value as the user changes type.
  newCfType.addEventListener("change", () => {
    syncNewCfForm();
    validateNewCfDefault();
  });
  newCfDefault.addEventListener("input", validateNewCfDefault);
  newCfOptions.addEventListener("input", validateNewCfDefault);
  newCfKey.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#add-cf").click(); } });
  newCfDefault.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#add-cf").click(); } });
});
