# Fixture corpus

Real alert emails, one `.eml` per platform per known layout (design §14). The
fixture harness (`test/fixtures.test.ts`) discovers every `<platform>/<name>.eml`
here and checks it against its `<name>.expected.json` sibling.

**These must be real emails** — the parsers are written against them, and I2
(re-parse idempotency) is only meaningful if re-running a fixed parser over
every stored layout still produces the right answers for the old ones. Do not
hand-craft fixtures.

## How to export one from Gmail

1. Open the alert email.
2. ⋮ (three-dot menu) → **"Show original"** / **"Original anzeigen"**.
3. **"Download original"** — saves a `.eml` file.
4. Drop it here as `linkedin/2026-07-28-alert.eml` (platform dir, date, short slug).

Nothing in the email needs redacting for a local repo, but before the repo goes
public, check for personal data in headers (your address is in every `To:`).

## expected.json shape

```json
{
  "platform": "LinkedIn",
  "declaredCount": 10,
  "adCount": 10,
  "titles": ["Sachbearbeiterin Kundenservice (m/w/d)", "…"]
}
```

Start minimal (platform + counts); grow the expectations as the extractor
learns more fields.
