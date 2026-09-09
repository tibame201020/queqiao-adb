# Queqiao ADB

Queqiao Worker 的受限 ADB extension。提供 Android 裝置探索、App lifecycle、截圖與基本輸入，不暴露任意 `adb shell` 或主機 shell。

[English](./README.md)

## 能力

- `adb_devices`：列出 ADB 裝置。
- `adb_device_info`：讀取型號、Android 版本、解析度與 density。
- `adb_packages`：列出已安裝 package，可依 prefix 過濾。
- `adb_foreground_app`：讀取目前前景 package/activity。
- `adb_screenshot`：裝置端擷取 PNG、pull 到授權 Workspace、轉成 bounded JPEG preview，最後清除暫存檔。
- `adb_app_start` / `adb_app_stop`：啟動或停止經 schema 驗證的 package。
- `adb_tap` / `adb_swipe` / `adb_keyevent`：受限的輸入操作。

## 安全邊界

Extension 不接受任意 shell 字串。ADB 指令由經驗證的 argv 組成，交由 Worker-owned extension runtime 以 `shell: false` 執行。Runtime manifest 僅允許 `adb`、`adb.exe` 與已知 MuMu ADB executable 路徑。

第一版 screenshot 回傳壓縮後 JPEG preview，原因是 Queqiao 0.9.7 extension stdio 有 bounded output；待 extension SDK 的原生 binary/media primitive 可用後，可直接替換 transport，不需要改上層 ADB capability。

## 開發

```powershell
npm ci
npm run check
npm pack --dry-run
```

需求：Node.js 22.19–24、Queqiao 0.9.7 extension API。

## License

MIT