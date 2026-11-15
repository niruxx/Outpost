# UI consistency review

The review covers the shared control system and its use in instance pages, host management, jobs, player/mod management and the operations queue. It preserves the six theme styles while giving controls consistent dimensions, wrapping and interaction rules.

## Fixed findings

- Buttons and text fields use a consistent 40px baseline, with larger touch controls where applicable. Icons keep their shape and action buttons no longer compress into broken words beside inputs. Ordinary shared buttons default to `type="button"`; form submit actions remain explicit.
- Card headings and action groups wrap on narrow screens. Fields, titles, errors, badges and long filenames have room to shrink or wrap without pushing the page sideways. Service/software searches, host file breadcrumbs, network/terminal toolbars and mod rows fit small screens.
- Dialog headers keep their close control visible; content scrolls inside the viewport, and long confirmation actions wrap. Mobile navigation is inert when closed, traps keyboard focus while open, closes on Escape, returns focus and releases its lock when resized to desktop.
- The header keeps navigation and account controls visible at 320px. Explicitly positioned hover controls retain their positioning. Optional font downloads no longer block application startup.
- Player whitelist controls align with their fields, support Enter submission, preserve input after failures and prevent overlapping mutations. Job views distinguish host jobs from removed instances and explain empty filter results with a reset action.
- Queue and toast controls have larger targets, readable wrapping, labeled dismissal and status announcements. Toast dismissal pauses while hovered/focused. Retried uploads reappear after a previously dismissed failed entry.
- Instance details, permissions and endpoint addresses cannot be overwritten by delayed reads from a different instance. Old console sockets cannot append to a new instance; reconnect history replaces buffered output and malformed messages are ignored. Revoked access clears stale controls.

## Verification

Run `npm run test:ui` with Chrome/Chromium available, using `OUTPOST_TEST_BROWSER` to specify its executable when needed. The suite exercises real shared React controls, the production navigation shell and delayed API/socket fixtures. It checks seven theme/palette variants (including Outpost light/dark), 320/390/768/1440px widths, long content, control dimensions, dropdown foreground/background pairs, form behavior, dialogs, focus return, menu resizing and an intentionally stalled font stylesheet.

The existing instance, operations queue, workspace, game-capability and release-resilience checks provide additional coverage for real pages, permissions, repeated navigation, reconnects and uploads. Screenshots and failure diagnostics are retained under `artifacts/ui-consistency/`, `artifacts/page-layout-review/` and the existing test artifact folders.

This is a review of the implemented panel and tested fixture flows. It is not a guarantee that every game, third-party editor, host configuration, browser or future change is defect-free, nor a complete accessibility certification. Dropdown color-pair checks do not replace a full contrast/accessibility audit.
