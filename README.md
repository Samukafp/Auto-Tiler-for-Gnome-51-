# Auto Tiler

A GNOME Shell extension that automatically organizes application windows into clean and efficient layouts.

**Compatibility:** GNOME Shell 51

## Status

Under Active Development

Auto Tiler is already usable but may contain bugs or unexpected behaviour. New features, improvements and fixes are still being developed.

## Features

- Automatic window tiling
- Quick Settings integration
- Enable or disable tiling directly from Quick Settings

## Installation

Make sure Git is installed, then open a terminal and run:

```bash
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/auto-tiler@local"

git clone https://github.com/Samukafp/Auto-Tiler-for-Gnome-51-.git "$EXT_DIR"
```

**Important:** After cloning the repository, you must log out of your GNOME session and log back in before enabling the extension.

This step is required for GNOME Shell to recognize the newly installed extension correctly.

Once you have logged back in, open a terminal and run:

```bash
gnome-extensions enable auto-tiler@local
```

The extension should now be enabled and ready to use.

## Updating

To update the extension to the latest version, open a terminal and run:

```bash
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/auto-tiler@local"

git -C "$EXT_DIR" pull
```

After updating, log out and log back in to ensure all changes are properly loaded.

## Uninstallation

To remove the extension, open a terminal and run:

```bash
gnome-extensions disable auto-tiler@local

rm -rf "$HOME/.local/share/gnome-shell/extensions/auto-tiler@local"
```

## Compatibility

- GNOME Shell 51
- Linux distributions using GNOME Shell

## License

See the repository for license information.
