# AnimeShelf desktop candidate — asset provenance

This candidate contains no third-party poster/demo asset bundle. It contains the approved TMDB attribution mark described below. The ledger records code-visible assets and keeps unknown origin explicit.

## Icons and Logo

- The UI icons are inline SVG path data in `src/components/ui/Icons.tsx:18-39`. No external icon package or downloaded icon font is referenced there.
- The library mark is the existing `LibraryIcon` path in `src/components/ui/Icons.tsx:21`, reused by the sidebar/navigation code. This is code provenance, not a claim that the underlying visual is an independently registered logo.
- No project-logo authorship or external UI-icon attribution record was found. Treat their provenance as unknown until the project owner confirms it.
- `src/assets/tmdb-approved.svg` is the unmodified approved "Alt short (blue)" TMDB logo, retrieved 2026-09-21 from `https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg`, linked by the official logos-attribution page. The permitted purpose is API attribution, not project branding or a transfer of trademark ownership. `src/components/settings/DataCredits.tsx` displays it at its original aspect ratio with the required non-endorsement statement and provider link. No endorsement is implied.

## Fonts

- No `.ttf`, `.otf`, `.woff`, `.woff2`, or `.eot` asset is present in the candidate source tree.
- The original HTML loaded Inter from Google Fonts at startup; this was confirmed in the candidate browser check. The candidate removes those three external links and now uses its existing system-font fallbacks. This is not a claim that the original application always used system fonts only. Installed OS fonts are not redistributed.
- Do not describe a system font as an included project asset or as an original font.

## Images and fixtures

- `docs/images/settings-appearance.png` is an unedited screenshot of the public desktop source's actual Settings page, captured on 2026-09-23 with an empty, isolated library (application source corresponding to `203f52e`). It contains no user media, credentials or third-party poster artwork. It documents the interface rather than a mockup; the unresolved UI-icon provenance above still applies.
- No poster/demo image directory is included in this desktop candidate's publication scope.
- Any images under tests or fixtures are excluded from this ledger unless a future release explicitly packages them. They must be reviewed individually for source, permission, and attribution before publication.
- This document intentionally does not convert existing source-checkout poster caches or real-site fixtures into a redistributable asset claim.

## Review state

| Item | Current evidence | State | Minimum follow-up |
|---|---|---|---|
| Inline UI icons | `src/components/ui/Icons.tsx` | Code-visible; external provenance not documented | Confirm project authorship or add the applicable attribution/permission record. |
| Library mark | `LibraryIcon` path used by sidebar | Origin/permission not independently confirmed | Confirm trademark/logo status before public branding. |
| System fonts | CSS/system stack only | No bundled font obligation found | Recheck packaging if a font file is added later. |
| Posters/demo images | Not in candidate publication scope | Excluded, not cleared | Replace with cleared assets and add per-file provenance before release. |

Unknown provenance remains `unknown`; this file does not infer originality from absence of a notice.
