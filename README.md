# Auto Tiler

A GNOME Shell extension that automatically organizes application windows into clean and efficient layouts.

**Compatibility:** GNOME Shell 51

## Status

**Under Active Development**

Auto Tiler is already usable but may contain bugs or unexpected behaviour. New features, improvements and bug fixes are still being developed.

## Features

- Automatic window tiling
- Quick Settings integration
- Enable or disable automatic tiling directly from Quick Settings

## Installation

Open a terminal and run the following commands:

```bash
REPO="https://github.com/Samukafp/Auto-Tiler-for-Gnome-51-.git"
TMP_DIR="$(mktemp -d)"

git clone "$REPO" "$TMP_DIR/auto-tiler"

UUID="$(python3 -c 'import json; print(json.load(open("'"$TMP_DIR"'/auto-tiler/metadata.json"))["uuid"])')"

mkdir -p "$HOME/.local/share/gnome-shell/extensions"

mv "$TMP_DIR/auto-tiler" "$HOME/.local/share/gnome-shell/extensions/$UUID"

rm -rf "$TMP_DIR"

gnome-extensions enable "$UUID"
```

The installation automatically reads the extension UUID from `metadata.json` and places the extension in the correct directory.

No manual UUID configuration is required.

## Updating

To update Auto Tiler to the latest version, run:

```bash
REPO="https://github.com/Samukafp/Auto-Tiler-for-Gnome-51-.git"
EXTENSIONS_DIR="$HOME/.local/share/gnome-shell/extensions"

for DIR in "$EXTENSIONS_DIR"/*; do
    [ -d "$DIR/.git" ] || continue

    if [ "$(git -C "$DIR" remote get-url origin 2>/dev/null)" = "$REPO" ]; then
        git -C "$DIR" pull --ff-only
        break
    fi
done
```

This automatically locates the installed extension by its Git repository and downloads the latest changes.

If the extension does not reload automatically, log out and log back in.

## Compatibility

| Component | Version |
|---|---|
| GNOME Shell | 51 |
| Status | Under Active Development |

## Contributing

Suggestions, bug reports and contributions are welcome!

Feel free to open an issue or submit a pull request.

## License

No license has been specified yet.
