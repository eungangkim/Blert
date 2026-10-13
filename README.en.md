# blert

[한국어](README.md) · **English**

A local CLI that lets you set up Binance spot and futures alerts with commands and receive them as desktop notifications and sounds on **your own PC**.
There is no server, and your API keys and settings never leave this PC. Network requests go only to Binance servers, and alert text is passed to an outside service **only if you turn on an external alert channel (Telegram) yourself** (off by default).

> This is not investment advice, and blert is not responsible for losses caused by missed or delayed alerts.

## Install

Node.js 24 or later is required.

```bash
npx @eungang/blert init        # start right away (initial setup)
npm install -g @eungang/blert@1.0.0   # global install (the command is `blert` afterwards)
```

**Updating:** we recommend using the latest version. Before updating, check the [release notes](https://github.com/eungangkim/Blert/releases) and the npm provenance badge, then run `npm install -g @eungang/blert@latest`. A running background monitor must be restarted to use the new version (`blert stop` → `blert start`). blert does not look up new versions by itself, so use Watch → Releases on the GitHub repository to get notified.

### Supported environments

| Environment | Status |
| --- | --- |
| **Windows 11** | **Verified** — desktop notifications and sounds, background monitor, start at login, account alerts, and the Telegram channel (receiving price alerts on your phone) were all checked on a real machine |
| macOS, Linux | Only automated tests (CI) pass. Desktop notifications, sounds and detached background running have **not been checked on a real machine yet**. Start at login is not supported yet |

## Language

blert speaks Korean and English. The language is decided in this order: the `BLERT_LANG` environment variable, then the saved setting, then your OS language, then Korean. `blert init` asks for the language first.

```bash
blert lang          # show the current language and how it was decided
blert lang en       # switch to English (blert lang ko for Korean)
```

A running background monitor keeps the language it started with. Restart it (`blert stop` → `blert start`) to get alerts in the new language.

## Quick start

```bash
blert init                              # accept the notice, set up sound, choose a preset
blert preset install major-swing        # BTC, ETH and SOL moving 5% within 1 hour
blert add price BTC above 70000         # alert the moment BTC goes above 70,000 (once)
blert add price BTC below 65000         # alert the moment it falls below 65,000 (once)
blert add change ETH 5% 1h down         # alert if ETH falls 5% within 1 hour
blert add volume SOL x4 5m/1h           # SOL 5-minute turnover is 4x the 1-hour average
blert add funding f:BTC above 0.05%     # futures BTC funding rate above 0.05%
blert list                              # show your alerts
blert run                               # start monitoring (stop with Ctrl+C)
```

For futures, put `f:` in front of the symbol (`f:BTC`). `BTC` is completed to `BTCUSDT` automatically.

## When alerts fire

- **Price and funding rate**: alerts fire at the moment the threshold is **crossed**. `above` fires when it goes above, `below` when it falls below.
  If the value is already past the threshold when you start `blert run`, no alert fires; it fires when the value goes to the other side and crosses again.
- **Change and volume**: these look at the current level. They fire when the condition holds, with a cooldown (30 minutes for change, 15 minutes for volume) so the same alert does not keep coming.
- When many alerts arrive within a short time, they are shown as one "N alerts" notification. Warnings (such as a lost connection) are never grouped.
- `blert run` starts only after you have accepted the notice (`blert init`), and refuses a second run while one is already running.
- If monitoring ended abnormally (force quit, security software, power loss), the next `blert run` reports it as a "gap in monitoring".

## Commands

| Command | Description |
| --- | --- |
| `blert init` | Initial setup |
| `blert add <type> ...` | Add an alert: `price`, `change`, `volume`, `funding` |
| `blert list [--all]` | List alerts (`--all`: include alerts that have finished) |
| `blert del` `pause` `resume <ID\|all>` | Delete, pause, resume |
| `blert preset list\|install\|remove` | Presets: `major-swing`, `volume-burst`, `futures-heat`. Also installable from a file or URL ([below](#sharing-presets-install-from-a-file-or-url)) |
| `blert run` | Start monitoring |
| `blert test [kind]` | Send a test alert |
| `blert sound on\|off\|test` | Turn sound on/off, test it |
| `blert sound set\|theme\|reset\|list` | Register your own sounds, themes, reset, check ([below](#your-own-alert-sounds)) |
| `blert voice on\|off\|kinds\|list\|use\|test` | Read alerts aloud ([below](#voice-alerts-read-aloud-by-your-pc)) |
| `blert lang [ko\|en]` | Show or change the message language |

Every command has `--help`, and advanced options are shown by `blert --help --advanced`.

## Account alerts (read-only key)

You can also be notified about your order fills and balance changes. Only a **read-only Ed25519 key** can be used, and the key is stored not in a file but only in the **OS keychain**.

```bash
blert key add                     # enter the API key and the private key (PEM) file path → saved to the keychain
blert add fill all                # every fill
blert add balance USDT 5%         # alert when the USDT balance changes 5% or more since the last alert (10 minute cooldown)
blert key check                   # re-check the permissions of the saved key
blert key remove                  # delete the key from the keychain
```

- Create a key with **only reading enabled**. If any of trading, withdrawal, margin or futures permission is on, blert refuses to save or use it.
- We recommend turning on **allowed-IP restriction** in Binance API Management. Without it, blert warns every time it runs.
- HMAC and RSA keys cannot be used. Create an Ed25519 key pair and register the public key on Binance: `openssl genpkey -algorithm ED25519 -out private_key.pem`
- If something goes wrong with the key (for example a permission change), **only account alerts stop and public alerts continue**. The reason is shown as an alert.
- On systems without an OS keychain (some Linux setups), account alerts cannot be used and only public alerts work. Keys are never stored in files or environment variables instead.

### Futures account alerts

```bash
blert add liq f:BTC 5%            # alert when the mark price gets within 5% of the liquidation price (5 minute cooldown)
blert add liq f:BTC 10%,5%,2%     # staged warnings: alert immediately each time it gets deeper (2-4 stages, largest first)
blert add fill f:BTC              # BTC futures order fills
```

- The same read-only key is used to read futures positions and the liquidation price. **Keys with futures permission (`enableFutures`) are refused because they can also place futures orders.**
- The liquidation price is re-read every 15 seconds and whenever a fill or account change event arrives. If you are already within the threshold at start, you are alerted right away.
- **Staged warnings** (`10%,5%,2%`): entering the first stage alerts you, and entering a deeper stage alerts you immediately regardless of the cooldown (caution → danger → urgent, using the single `warn` sound). Staying in the same stage repeats at the cooldown (5 minutes by default), and going back to a shallower stage only lowers the stage silently. When the distance goes above 1.1 times the first value, it is fully reset and the first stage alerts again. Only a cooldown repeat (`--mode cooldown:<time>`) can be used.
- Futures fills need a symbol (there is no `f:all`). When a symbol has both long and short positions, the one closer to liquidation is used.
- Binance only offers a listenKey for the futures user data stream, so listenKey is used for futures only (never for spot).

## Running in the background (daemon)

To keep monitoring after you close the terminal, use `start` instead of `run`.

```bash
blert start          # start monitoring in the background (waits until it is ready and reports the result)
blert status         # running or not, alert count, connection state, latest gap in monitoring
blert logs           # last 50 log lines (-n 20: number of lines, -f: keep following)
blert stop           # save state and stop cleanly
```

- While the background monitor is running, changing alerts with `blert add`, `del`, `pause` or `resume` takes effect **without a restart**. The same is true for foreground `blert run`.
- Alerts and sounds appear the same way as with `run`. There is no screen output, and every alert is kept in `blert logs`.
- If the background monitor is force-killed or ended by security software, any later command prints a one-line warning. Starting it again with `blert start` records the stopped period.
- `blert run` and `blert start` cannot run at the same time. If one is already running, blert points you to `blert status`.
- Rebooting the computer also stops the background monitor (starting at boot is a feature for a later version).

### Start at login (Windows)

```bash
blert service install     # register the monitor to start automatically 30 seconds after you log in (asks for confirmation)
blert service uninstall   # remove it (a running monitor is left as it is)
blert status              # the last line shows whether automatic start is registered
```

- This creates a logon task (`blert`) for the current user in Windows **Task Scheduler**. **Administrator rights are not needed.**
- Notifications, sounds and the OS keychain need a logged-in user session, so it starts **at login**, not right after the computer boots.
- Even if there is no network right after login, the monitor does not exit; it keeps retrying and tells you when it connects. If one is already running, it quietly does nothing.
- The paths of the `node` and `blert` currently running are recorded at registration. If an update or moving the folder changes the path, `blert status` tells you, so run `blert service install` again. It cannot be registered from the temporary path used by `npx`, so use a global install (`npm install -g @eungang/blert`).
- macOS and Linux are not supported yet (run `blert start` yourself).

## Alerts on your phone (Telegram, optional)

The external channel is **off by default** and turns on only when you register it.

```bash
blert channel add telegram     # read the notice and agree → enter the bot token → message the bot → test message
blert channel test             # send the test message again
blert channel account off      # keep the registration but stop sending account alerts to your phone (on: turn back on)
blert channel remove           # remove it (the token is also deleted from the keychain)
```

1. In Telegram, send `/newbot` to `@BotFather` to create a bot and get a **bot token**.
2. Run `blert channel add telegram`, enter the token, and follow the instructions to **send any message to the new bot** (for example `/start`). blert finds the chat and connects it.
3. By default only **public market alerts (price, change, volume, funding rate) and monitoring-gap warnings** are sent. **Account alerts such as fills, balances and liquidation price are sent only if you allowed them at registration.** After registering, change this with `blert channel account on|off` (turning it on asks for consent again; the token and chat ID stay as they are).
4. API keys and private keys are never sent. The bot token is stored only in the OS keychain, never in the settings file. Alert text passes through Telegram's servers and may remain there.
5. Even if sending fails (for example you are offline), desktop notifications and sounds keep working. Failed alerts are not sent again later.

Requests go to `api.telegram.org` only while this feature is on; after you remove it, requests go only to Binance again. One more case: `blert sound set|theme` and `blert preset install` download a file from a URL **only when you type that https URL yourself**.

## Voice alerts (read aloud by your PC)

Alerts are read aloud. **Only the voice built into your PC (TTS) is used**, and the spoken text never leaves your PC.

```bash
blert voice on                    # turn on (kinds read by default: warn, account)
blert voice kinds up,down,account,warn   # change which alert kinds are read
blert voice list                  # show whether it is on and the installed voices
blert voice use Microsoft Zira Desktop   # choose a voice (default: back to the OS default)
blert voice test                  # listen to it
blert voice off                   # turn off
```

- Instead of reading the on-screen title, a **short sentence** is read. Example: "BTC futures liquidation urgent, stage 3, 1.5% from liquidation". When many alerts are summarized, only "N alerts" is read.
- **Sound and voice are switched on and off separately.** If both are on, the voice is read after the alert sound ends. One sentence is read at a time, and if more than 2 are waiting, the oldest are skipped.
- A running monitor (`blert start`) follows changed settings **without a restart**.
- If you have not chosen a voice, an installed voice matching the current language is used (an English voice for English). If the voice you chose disappears, the OS default voice reads instead and you are told once. On a PC without voices, alerts and sounds still work normally.
- **Windows is verified** (Korean Heami, English Zira). macOS (`say`) and Linux (`spd-say`, `espeak-ng`) have not been checked on a real machine yet and will be judged from user reports.

## Sharing presets (install from a file or URL)

Besides the built-in presets, you can install preset files made by other people.

```bash
blert preset install ./my-preset.json                                   # a file on your PC (no network use)
blert preset install https://example.com/preset.json --sha256 <hash>    # an https URL (connects only because you typed it)
blert preset list                                                       # show installed presets with their source and hash
blert preset remove my-preset                                           # delete only that preset's alerts
```

- Before installing, blert shows the name, version, license, source, **the rule list (counts by type and the first 10)** and the sha256. **A URL install needs you to press `y`** (default No); a file install shows the summary and installs right away.
- **A URL install connects only to the URL you typed in the command.** Only https is allowed, there are size (256KB) and time (10 seconds) limits, and moving to another site is refused. **The server you connect to can see your IP address.** There is no automatic update. For a new version, `remove` and install again.
- If you give `--sha256` the hash published by the site, it installs only when the content is identical. If anything in the format is wrong, **nothing is installed** and the location of the problem is shown.
- A preset is only a list of rules, not executable code. Each rule's source is always recorded as `preset:<name>`, and value ranges are the same as `blert add`. If it contains fill, balance or liquidation alerts, the summary tells you that an API key is needed.

File format (at most 50 rules; strings with control characters are refused):

```json
{
  "schemaVersion": 1,
  "slug": "btc-breakout",
  "version": 1,
  "name": "BTC breakout watch",
  "description": "optional",
  "license": "CC0-1.0",
  "author": "optional",
  "rules": [
    { "type": "price", "market": "futures", "symbol": "BTCUSDT",
      "condition": { "type": "price", "direction": "above", "price": 84500 },
      "repeat": { "kind": "cooldown", "ms": 300000 } },
    { "type": "change", "market": "spot", "symbol": "ETHUSDT",
      "condition": { "type": "change", "pct": 5, "windowMs": 3600000, "direction": "both" },
      "sound": "warn", "name": "ETH sharp move" }
  ]
}
```

`slug` is 3-40 lowercase letters, digits or hyphens and must not clash with a built-in preset name (such as `major-swing`). `type` is one of `price`, `change`, `volume`, `funding`, `fill`, `balance`, `liq`, and if you leave out `repeat` the default for the type is used. Write symbols in full, like `BTCUSDT`.

## Your own alert sounds

You can change the sound of each of the 4 alert slots (`up` rising, `down` falling, `account` account, `warn` warning). A sound file must be **WAV (16-bit PCM), mono or stereo, 8,000-48,000Hz, 3 seconds or less, 512KB or less**, and blert checks it itself before saving.

```bash
blert sound set up ./alert.wav                          # register from a file on your PC
blert sound set up https://example.com/up.wav --sha256 <hash>   # register from a URL (connects only because you typed it)
blert sound theme ./theme.json                          # all 4 slots at once (a file or an https URL)
blert sound list                                        # show which slots use bundled or your sounds
blert sound test up                                     # listen to it
blert sound reset up                                    # back to the bundled sound (all: every slot)
```

- Registered sounds are copied to `sounds/` in the settings folder, and a **running monitor (`blert start`) also uses the new sound from the next alert, without a restart**.
- If the file is deleted or damaged, the bundled sound is played instead and you are told once. The alert itself works normally.
- **A URL install connects only to the URL you typed in the command.** Only https is allowed, there are size (512KB for sounds, 64KB for themes) and time (10 seconds) limits, and moving to another site is refused. Before installing, blert shows the source, size, length and hash, and you must press `y`. **The server you connect to can see your IP address.** A file install does not use the network.
- A theme file has the form `{ "schemaVersion": 1, "name", "version", "license", "sounds": { "up": { "url", "sha256" }, … } }` and the hash is required. The sounds of a local theme may only use relative paths inside the folder of the theme file.
- Do not use copyrighted sounds. The bundled sounds are CC0; the rights to any other sound belong to whoever registers it.

## Where data is stored

Windows `%APPDATA%\blert\`, macOS and Linux `~/.config/blert/` — `config.json`, `rules.json`, `state.json`, `logs/`, `sounds/` (your registered sounds).
Logs are kept for 7 days or 10MB.

## Troubleshooting

- **I do not see notifications** — run `blert test` and follow the guidance. On Windows, check Settings > System > Notifications and Focus assist (Do not disturb).
- **`blert run` stops without a sound** — some security software (for example Avast behavior shield) can kill processes that start PowerShell. blert shows notifications in a way that avoids this, but if it still stops, add blert (`node.exe`) to the exception list of your security software.
- **"blert monitoring is already running"** — `blert run` is on in another terminal. Stop it there with Ctrl+C. If it appears even though it is already off, try again after a minute (it is cleaned up automatically once the heartbeat stops).
- **It says it cannot connect** — you need access to `stream.binance.com`, `fstream.binance.com`, `api.binance.com` and `fapi.binance.com` (and `ws-api.binance.com` for account alerts). If the Telegram channel is on, `api.telegram.org` is needed too.
- **Telegram alerts do not arrive** — check with `blert channel test`. If the token or chat ID is wrong, run `blert channel add telegram` again. Account alerts (fills and so on) are not sent unless you allowed them at registration.

## License

MIT ([LICENSE](LICENSE)). The bundled sounds (`assets/sounds/`) are CC0, and their sources are listed in `assets/sounds/LICENSES.md`.
