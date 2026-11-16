# FakeCall

A personal PWA that rings your own iPhone with a realistic incoming-call screen. Tap **Call me**, optionally wait out a delay on a black "idle" screen, then accept the call to get an in-call screen with a running timer and an optional recorded voice.

Vanilla HTML, CSS and JavaScript. No framework and no backend. The app itself needs no build: the generated assets are committed, so you can serve this folder as it is. On Vercel, `npm run build` regenerates them and publishes `dist/`.

Live at https://fakecall-mu.vercel.app

## Files

| File | Purpose |
| --- | --- |
| `index.html` | All four screens, the settings sheet and the icon sprite |
| `styles.css` | Layout, safe areas, transitions |
| `app.js` | Audio scheduling, wake lock, call flow, settings |
| `sw.js` | Cache-first service worker for offline use |
| `manifest.webmanifest` | Standalone, portrait, black theme |
| `assets/` | Icons, three original ringtones, a silent keep-awake clip |
| `tools/generate-assets.mjs` | Generates the ringtones, icons and clip |
| `package.json`, `vercel.json` | Vercel build: runs the generator and copies the app into `dist/` |

The caller name is fixed in `app.js` (`CALLER_NAME`). Bump `VERSION` in `sw.js` whenever you change any file, or installed copies keep serving the old cache.

## Testing on an iPhone

Service workers, the microphone and Wake Lock all need HTTPS, and `localhost` on your computer is not reachable from the phone. Use one of these.

**Vercel deploy**

```bash
npx vercel deploy --prod
```

Run it from this folder and open the production URL in Safari on the phone. `vercel.json` already holds the build settings. Use the public production domain, not the per-deployment URLs, which sit behind Vercel's login.

**HTTPS tunnel to a local server**

```bash
python3 -m http.server 4173
```

```bash
npx cloudflared tunnel --url http://localhost:4173
```

Open the `https://…trycloudflare.com` URL on the phone. `ngrok http 4173` works the same way.

## Add to Home Screen

1. Open the URL in **Safari** (not an in-app browser).
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Launch FakeCall from the new icon. It opens full screen with no Safari bars.
4. Open it once while online so everything is cached. After that it works in airplane mode.

Home Screen apps keep their own storage, so settings made in the Safari tab do not carry over. Set up the photo, ringtone and voice clip after installing.

## Using it

- **Call me** rings after the delay you pick: Now, 10s, 30s, 1 min or 5 min.
- With a delay, the screen goes black until it rings. **Double-tap** the black screen to cancel.
- **Caller settings** (top right): subtitle, photo, ringtone, call-screen style (Accept/Decline buttons or slide to answer) and the voice clip.
- In the call, **Speaker** raises the voice clip from a quiet "earpiece" level to full volume. Mute and the other controls are visual only.

## Known iOS limitations

- **Foreground only.** A web app cannot show a call over the lock screen or other apps. If you switch apps or lock the phone while it is armed, the call is cancelled and you are told when you return.
- **Keeping the screen on.** The app uses the Screen Wake Lock API. In Home Screen apps that API only became reliable in iOS 18.4, so on older versions the app falls back to looping a silent video, which is a best-effort workaround. If the screen still dims during long delays, set Settings > Display & Brightness > Auto-Lock to "Never" while you use it. Low Power Mode can also refuse the wake lock.
- **Silent switch.** The ringtone ignores the ring/silent switch through `navigator.audioSession` (iOS 16.4 and later). Volume still follows the media volume, so turn it up with the side buttons first.
- **Loudspeaker only.** Web audio cannot be routed to the earpiece, so the voice clip comes out of the main speaker. That is why it starts quiet until you tap Speaker.
- **No vibration.** iOS Safari does not support `navigator.vibrate`.
- **Status bar.** The real clock and battery stay visible, as they do on a real call.
- **Voice clip size.** Clips are stored in `localStorage`, so keep them to roughly 2 MB or 60 seconds.
- **Recording.** The first recording asks for microphone permission. iOS may ask again after the app is relaunched.

## Verification status

Tested in desktop Chromium with a phone-sized viewport: both answer styles, the delayed ring, recording, the voice clip, background cancellation, offline reload and settings persistence, with no console errors. It has not been run on a physical iPhone, so the iOS-specific parts (silent switch, wake lock, the video fallback) still need a check on the device.
