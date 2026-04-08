# ClinVar VUS Tracker

Live, autonomous tracking of ClinVar variant submissions and VUS reclassifications.

**This agent runs daily on GitHub Actions.** It fetches new ClinVar submissions, detects reclassifications, computes statistics, and generates a live HTML widget.

## What it computes

- **New submissions**: daily count of new ClinVar entries
- **VUS reclassifications**: detects when a VUS becomes pathogenic/benign (or vice versa)
- **VUS half-life**: median days until a VUS gets reclassified, per gene
- **Lab concordance**: agreement rate when multiple labs classify the same variant
- **Gene discord score**: which genes have the most conflicting interpretations
- **Monthly trend**: reclassification rate rising or falling

## Widget

An embeddable HTML widget (400px wide, 5 tabs) is generated at `staging/clinvar-tracker/index.html` — designed for embedding on [zyrkel.com](https://zyrkel.com).

## Data

All data accumulates in `staging/clinvar-tracker/`:
- `variants.jsonl` — all tracked variants (grows daily)
- `reclassifications.jsonl` — all detected reclassification events
- `daily_stats.jsonl` — daily snapshots
- `index.html` — live widget

## Powered by

[nano-zyrkel](https://github.com/christian-schlein/nano-zyrkel) — autonomous GitHub-native agents by [zyrkel.com](https://zyrkel.com)
