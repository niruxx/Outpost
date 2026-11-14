# Appearance and backgrounds

Open **Configuration → Appearance → Background animation** to choose a background independently of your theme.

Six custom styles are available:

| Style | Animation |
| --- | --- |
| Aurora | Drifting curtains of colored light |
| Starfield | Softly twinkling stars |
| Bubbles | Translucent rising bubbles |
| Fireflies | Warm, gently wandering lights |
| Rain | Thin diagonal rain trails |
| Waves | Overlapping waves of color |

**Use theme background** restores the selected theme’s original wallpaper. Custom styles use the current theme’s palette. The page background becomes translucent while a custom style is active; cards and controls keep their normal surfaces.

Custom styles have **Slow / Normal / Fast** speed and **Subtle / Balanced / Bold** intensity controls. Turn **Animate background** off to keep a still version. Speed and intensity apply to custom styles rather than changing the original theme artwork.

Choices save automatically to the signed-in account and are restored when signing in on another browser. Each account has its own preference. Theme/color-mode choices retain their existing browser-based behavior and administrator-assigned themes.

**Reduce effects** and the operating system’s reduced-motion preference stop background motion, even when animation is selected. Backgrounds pause while the browser tab is hidden. Picker previews animate only on hover or keyboard focus. All decorative layers ignore pointer input and are hidden from screen readers.

Verification: `npm run build` and `node server/test/appearance.mjs`. Set `OUTPOST_TEST_BROWSER_UI=1` and, if needed, `OUTPOST_TEST_BROWSER` to a Chromium-compatible executable to check the picker, real animation, reduced motion, reload persistence and account isolation in the browser.
