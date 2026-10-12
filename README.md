# Ludo Hub

Free-play multiplayer Ludo with friends, chat, emoji, voice, accounts, virtual coins and ranks. No real-money features.

## Play
- **One device / vs computer:** open `index.html`.
- **Online with friends:** install Node.js, run `node server.js` (or double-click `start.bat`), open the printed address on every phone.
- Tests: `node test-online.js` and `node test-economy.js` (Node 22+).

## Files
| File | What it is |
|---|---|
| `index.html` | The whole game. Ads settings are at the top of its script (`ADS_CONFIG`, `APP_CONFIG`). |
| `server.js` + `engine/` | Online server and the game rules (no packages to install). |
| `android-app/` | Packs the game into an Android app (Capacitor + AdMob). |
| `.github/workflows/android.yml` | Builds the Android APK on GitHub for you. |
| `ANDROID-ADMOB.md` | AdMob and Android guide. |

## Build the Android APK on GitHub
1. Put these files in a GitHub repository (branch `main`).
2. (Optional) To use a different AdMob App ID: Settings > Secrets and variables > Actions > **Variables** > New variable `ADMOB_APP_ID`. By default the Ludo Hub App ID in `android-app/patch-android.js` is used.
3. Actions tab > **Build Android app (Ludo Hub)** > Run workflow.
4. When it finishes, download **LudoHub-debug-apk** from the run page, unzip it, and install the `.apk` on a phone.
That is a debug build for testing. A Play Store release needs a signed bundle (see ANDROID-ADMOB.md).
