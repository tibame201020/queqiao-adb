# Queqiao ADB

A bounded Android Debug Bridge extension for Queqiao Workers. It exposes device discovery, app lifecycle, screenshots, and basic input without exposing arbitrary `adb shell` or a host shell.

[蝜?銝剜?](./README.zh-TW.md)

## Capabilities

- `adb_devices` ??list connected ADB devices.
- `adb_device_info` ??model, Android version, display size, density.
- `adb_packages` ??list installed packages with optional prefix filtering.
- `adb_foreground_app` ??current resumed package/activity.
- `adb_screenshot` ??capture PNG on-device, pull it into the authorized Workspace, return a bounded JPEG preview, then remove temporary files.
- `adb_app_start` / `adb_app_stop` ??launch or force-stop one validated package.
- `adb_tap` / `adb_swipe` / `adb_keyevent` ??bounded input actions.

## Security boundary

The extension does not accept arbitrary shell text. ADB commands are assembled as validated argv and executed by the Worker-owned extension runtime with `shell: false`. Its runtime manifest only allows `adb` and `adb.exe`; emulator-specific ADB locations must be exposed through the Worker PATH. Package names, device IDs, coordinates, durations, and key codes are schema-bounded.

The first screenshot contract intentionally returns a compressed JPEG preview because Queqiao 0.9.7 extension stdio is bounded. It can move to native binary/media results once the Queqiao extension SDK exposes that primitive.

## Development

```powershell
npm ci
npm run check
npm pack --dry-run
```

Requires Node.js 22.19??4 and Queqiao 0.9.7 extension API.

## License

MIT