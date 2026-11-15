# Outpost website

The landing page for [Outpost](https://github.com/niruxx/outpost), the self-hosted panel for game servers, apps and containers.

The page uses Outpost's own five themes: **Outpost** (Material 3 dark), **Windows XP**, **Minecraft**, **Windows Vista / 7** and **Frutiger Aero**. The color tokens, `ui-*` component hooks and animated wallpapers are ported from the panel's `web/src/index.css` and `web/src/lib/theme.ts`, so each theme looks the same here as it does in the app. Visitors can switch themes from the nav bar or the Themes section. Their choice is saved in their browser.

## Structure

```
index.html         the page
assets/styles.css  tokens, components, the five themes and their wallpapers
assets/app.js      theme picker, wallpaper toggle, install tabs, copy buttons
assets/demo.js     the live demo: a simulated panel that runs entirely in the browser
assets/demo.css    styles for the live demo (badges, console, dialog, toasts per theme)
assets/screenshots/ current desktop and mobile UI captures from Outpost docs
favicon.svg        the Outpost watchtower mark
.nojekyll          tells GitHub Pages to serve the files as-is
```

There's no build step and no dependencies other than Google Fonts.

## Hosting on GitHub Pages

1. Push website changes to the `website` branch of `niruxx/Outpost`.
2. In the repo, go to **Settings → Pages** and set **Source** to **Deploy from a branch**, then pick **`website`** / **`/ (root)`**.
3. The site goes live at `https://niruxx.github.io/Outpost/`. All paths are relative, so it also works from a custom domain.

The service lives on `main`; this branch contains only the public website and preserves its original commit history. Do not merge this branch into `main`.

The previous `niruxx/Outpost-website` repository can be archived after this deployment is verified. If it uses a custom domain, move that domain in the GitHub Pages settings and verify DNS before retiring the previous deployment.

## Previewing locally

```bash
python -m http.server 8000   # then open http://localhost:8000
```

To link to a specific theme, add `?theme=` with one of `outpost`, `xp`, `minecraft`, `vista` or `aero`, e.g. `index.html?theme=minecraft`.

## Keeping it in sync

The overview and screenshots reflect the local Outpost documentation at commit `426ddc5` (reviewed October 28, 2026). The desktop and mobile PNGs in `assets/screenshots/` are actual UI captures from Outpost's `docs/screenshots/`, with illustrative metrics and sample instances. They are static images; the separate interactive demo remains a browser-only simulation.

When refreshing the site, review the project's README and implemented features, copy updated desktop and mobile captures into `assets/screenshots/`, and update image dimensions and alt text if the captures change. Keep historical changelog dates intact and move shipped work out of the future-work list.

When Outpost changes a theme, copy the matching token block and component rules from `web/src/index.css` into `assets/styles.css`. If a theme is added, also add its entry to `THEMES` in `assets/app.js` and to the id list in the inline script in `index.html`.
