**English** | [中文](./character-packs.zh-CN.md)

# Character Pack Guide

Cyrene Agent ships by default with the character "Cyrene," but the name, speech style, avatar, and even the Live2D model can all be swapped out for a different character as a unit — that's a **Character Pack**. Switching packs doesn't affect functionality: tools, memory, Moments, TTS, and everything else keep working as usual. The only thing that changes is *who* you're chatting with.

---

## 1. Which character packs are available

Open **Settings → Character** to see a list of cards:

| Character Pack | id | Description |
| --- | --- | --- |
| Cyrene | `cyrene` | The built-in default character — a *Honkai: Star Rail* fan-made persona with its own Live2D model |
| Generic Assistant | `generic` | A built-in example character with no IP background, reusing Cyrene's Live2D model |
| (a pack you imported) | custom | Imported from a zip file — see below |

Click a card to switch; the change applies immediately across the chat window, desktop companion, status bar, call window, and every other surface. **If the new character pack ships its own Live2D model**, the desktop companion window reloads automatically; swapping only the name/avatar doesn't trigger a reload.

---

## 2. Building your own character pack

### Directory layout

A character pack is just a folder, zipped up for import:

```
my-pack/
├── manifest.json          ← required — the pack's "ID card"
├── avatar.png              ← required — avatar (square, ≥256×256 recommended)
├── icon.png                 ← optional — app icon (not yet wired into the picker UI; reserved field)
├── prompts/                 ← required — the complete set of persona prompt files
│   ├── chat_system.md
│   ├── chat_identity.md
│   ├── soul.md
│   ├── canon_quotes.md
│   ├── cyrene_harness.md
│   ├── work_system.md
│   ├── work_identity.md
│   ├── work_remark.md
│   ├── canon_quotes_lite.md
│   ├── learn_system.md
│   ├── learn_identity.md
│   ├── code_system.md
│   ├── code_identity.md
│   ├── code_remark.md
│   ├── phone_system.md
│   └── phone_identity.md
└── model/                   ← optional — custom Live2D model (falls back to the built-in Cyrene model if omitted)
    └── ...(Cubism 4 model files, with a .model3.json entry point)
```

When zipping the pack, `manifest.json` must sit at the **top level** of the zip (don't wrap everything in an extra `my-pack/` folder) — otherwise the import will report "manifest.json not found."

### manifest.json fields

```json
{
  "schemaVersion": 1,
  "id": "my-pack",
  "displayName": "My Character",
  "author": "Your name (optional)",
  "description": "A one-line blurb (optional)",
  "avatarFile": "avatar.png",
  "iconFile": "icon.png",
  "hasCustomModel": false,
  "modelEntryFile": "model/MyModel.model3.json"
}
```

| Field | Required | Description |
| --- | --- | --- |
| `id` | ✅ | Lowercase letters/digits/underscore/hyphen only, 1–64 chars; must not collide with a built-in pack (`cyrene`, `generic`) |
| `displayName` | ✅ | The name shown in the UI, replacing every hardcoded "Cyrene" reference |
| `avatarFile` | ✅ | Avatar path relative to the pack folder; must be png/jpg/jpeg/webp |
| `author` / `description` | ❌ | Display-only |
| `iconFile` | ❌ | Reserved field; not yet wired into the app-icon picker UI |
| `hasCustomModel` | ❌ | When `true`, `modelEntryFile` must also be provided; otherwise the built-in Cyrene Live2D model is reused |
| `modelEntryFile` | Conditional | Required when `hasCustomModel: true`; points at the `.model3.json` entry file |

### What has to go in prompts/

**None** of the 16 files listed above may be missing, and none may be empty. Skip one, and that scenario silently falls back to the built-in Cyrene version — producing a jarring "half-swapped persona" effect — so import is rejected outright instead of silently degrading.

Files that are automatically shared from the built-in set and don't need to be provided: `tool_usage.md`, `cita_system.md`, `phone_style.md`, `styles/*.md`, plus the `worldbook/` and `moments_personas/` directories (these two directory names are reserved — your pack must **not** contain files/folders with the same names, or you'll accidentally shadow content shared with other characters).

The easiest starting point: copy [`prompts/characters/generic/`](../../prompts/characters/generic) wholesale — it's a complete, ready-to-import minimal example. Just change the "Generic Assistant" persona to your character's name and speech style.

### A formatting convention: MOMENTS_CUTOFF

If `soul.md` has a section describing the character's appearance/outfit/visual look, it's recommended to add this line right before it:

```
<!-- MOMENTS_CUTOFF -->
```

Text-only surfaces like Moments posts and proactive messages automatically trim away everything after this marker — there's no need to describe "what I'm wearing today" in a pure-text context. Skipping the marker is fine too; it just means the entire `soul.md` gets pulled into text-only scenarios.

---

## 3. Importing a pack

1. Package it: zip up `manifest.json`, `avatar.png`, `prompts/` (plus the optional `icon.png` and `model/`), with `manifest.json` at the root of the archive.
2. Settings → Character → **Import Character Pack (.zip)…**, then pick the zip file.
3. On success, it appears in the card list — click it to switch.
4. If the `id` collides with an already-installed pack, you'll be asked whether to overwrite — choosing "Overwrite" replaces the old content, "Cancel" aborts the import.

### Common import failures

| Message | Cause | Fix |
| --- | --- | --- |
| manifest.json not found | `manifest.json` isn't at the top level of the zip, or the archive has an extra wrapping folder | Re-zip with `manifest.json` directly at the archive root |
| manifest.json field is invalid | `id` has an invalid format, or collides with a built-in pack (`cyrene`/`generic`) | Check that `id` only contains lowercase letters/digits/`_`/`-` |
| Missing required persona prompt files | Not all 16 files under `prompts/` are present, or some are empty | Fill in the full checklist above; copying the `generic` pack as a starting point helps |
| prompts/ contains a reserved name | A file/folder named `worldbook` or `moments_personas` is present | Remove or rename it |
| Avatar file referenced in manifest not found | `avatarFile` path is wrong, or the file wasn't actually included in the zip | Double-check the path spelling/casing and confirm the file is in the zip |
| Custom model declared but the entry file is missing | `hasCustomModel: true` but the file pointed to by `modelEntryFile` is missing | Check the path, or just set `hasCustomModel` to `false` to reuse the built-in model |
| zip / unpacked size too large | Exceeds 200MB (zip) or 500MB (unpacked) | Shrink model texture sizes, or drop unnecessary files |

---

## 4. Current limitations

A character pack can swap the **name, speech style, avatar, and (optionally) Live2D model**. The following are known limitations, not bugs:

- **The chat window's welcome illustration** — the default "Cyrene" welcome art is a hand-drawn illustration baked into that specific character design; it can't be fixed by changing text. Non-default character packs automatically fall back to a simplified "avatar + text" welcome message instead of showing the wrong illustration.
- **TTS voice timbre** — voice cloning/timbre is a per-user account asset configured in TTS settings, not part of the character pack's content; switching packs doesn't switch the voice.
- **The internal "cyrene" identifier in Moments** — inside the Moments feature, "cyrene" is a fixed internal identity key (it determines which scheduling logic a given post's activity follows) and doesn't change with the character pack; only the **name shown to the user** follows the current pack's `displayName`.
- **App icon / window icon** — the `iconFile` field is currently reserved only; it isn't wired into the icon picker in Settings yet.
