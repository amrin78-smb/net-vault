@AGENTS.md

---

## Versioning Policy

This app follows semantic versioning. Baseline: 1.2.0 (Jun 2026)

Every commit must include a version bump:
- Bug fix, UI tweak, copy change, config fix → PATCH (x.x.+1)
  Run: npm version patch --no-git-tag-version
- New feature, new page, new API, new chart → MINOR (x.+1.0)
  Run: npm version minor --no-git-tag-version
- Breaking change, DB migration, architecture overhaul → MAJOR (+1.0.0)
  Run: npm version major --no-git-tag-version

Examples of what counts as each type:
- Login page overhaul → Minor
- New dashboard with charts → Minor
- Health score tracking → Minor
- Bug fix (hardcoded IP, broken link, wrong email) → Patch
- New EOL intelligence integration → Minor
- Schema breaking change → Major

Rules:
- ALWAYS bump version as part of the same commit as the changes
- NEVER skip the version bump
- Run npm version BEFORE npm run build
- The app reads version from package.json via /api/health
- NocVault suite itself has no version number — only the 4 apps
- When bumping version, also update the releaseNotes object in the update status API with 3-5 bullets describing what changed. No CHANGELOG.md — release notes live in the update status API only.

---

## UI design

Styling is a custom CSS design system in `app/globals.css` (CSS custom properties in
`:root` + theme) plus inline `style={{ ... }}` on components — NOT Tailwind. Inter is the
body font (loaded via `next/font` in `app/layout.tsx`). `--radius: 8px` / `--radius-sm: 6px`.

### Typography & design tokens (suite standard)

- **Body font:** Inter (via `next/font`).
- **Monospace:** `var(--font-mono)` = `'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New', monospace`. One mono stack everywhere — never hardcode a mono font-family.

**7-step type scale** (defined once in `:root`; sizes do NOT change per theme):

| Token         | px   | Use |
|---------------|------|-----|
| `--text-xs`   | 11px | table headers, badges, micro-labels |
| `--text-sm`   | 12px | secondary labels, captions |
| `--text-base` | 13px | buttons, inputs, table body |
| `--text-md`   | 14px | body text, card titles (base body size) |
| `--text-lg`   | 16px | section / panel headings |
| `--text-xl`   | 20px | page titles |
| `--text-2xl`  | 28px | stat numbers / display |

**Rule:** On app surfaces (`app/(app)/...` and shared components) NEVER hardcode font
sizes or colors that duplicate a token. Always use `var(--text-*)` for type and the color
tokens (`--text-primary/-secondary/-muted`, `--bg-primary/-card`, `--border`,
`--border-light`, `--primary`, `--primary-dark`, etc.). Hardcoded hex that duplicates a
token breaks theming (hex doesn't flip themes). Display/hero sizes >= 34px (e.g. the
settings update-status glyphs ~44px, the compliance score ~52px) may stay literal — they
are intentional display sizes, not body type.

**Exception:** the animated **login** (`app/(auth)/login/`) and **launcher**
(`app/(auth)/launcher/`) pages use intentional hero/marketing typography (40px headlines,
Rubik logo, condensed letter-spacing). They are EXEMPT from the scale — leave their font
sizes, the Rubik logo, and hero styling as-is.

This is the **NocVault SUITE-WIDE standard** — the same scale and rule apply to spanvault,
ddivault, and logvault. SpanVault is the reference implementation; copy this pattern exactly.
