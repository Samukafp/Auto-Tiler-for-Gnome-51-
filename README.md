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

Make sure Git is installed, then open a terminal and run:

```bash
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/auto-tiler@local"

git clone https://github.com/Samukafp/Auto-Tiler-for-Gnome-51-.git "$EXT_DIR"

gnome-extensions enable auto-tiler@local
```

After installation, log out and log back in to ensure the extension loads correctly.

## Updating

To update Auto Tiler to the latest version, run:

```bash
git -C "$HOME/.local/share/gnome-shell/extensions/auto-tiler@local" pull --ff-only
```

If GNOME Shell does not reload the changes automatically, log out and log back in.

## Compatibility

| Component | Version |
|---|---|
| GNOME Shell | 51 |
| Status | Under Active Development |

## Contributing

Suggestions, bug reports and contributions are welcome!

Feel free to open an issue or submit a pull request.

## License

No license file is currently provided.
