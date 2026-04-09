# nano-zyrkel-vusTracker

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://schlein-lab.github.io/nano-zyrkel-vusTracker/)
[![ClinVar Sync](https://img.shields.io/github/actions/workflow/status/schlein-lab/nano-zyrkel-vusTracker/sync.yml?label=ClinVar%20Sync)](https://github.com/schlein-lab/nano-zyrkel-vusTracker/actions)

**ClinVar Variant Intelligence Platform** — Track 4.4M+ variants across 21,000+ genes. Detect reclassifications before they hit your clinic.

<!-- Screenshot: replace with actual screenshot of the gene dashboard -->
<!-- ![vusTracker Dashboard](docs/screenshot.png) -->

---

## What It Does

vusTracker continuously ingests ClinVar data and surfaces **classification drift** — variants that shift between Benign, VUS, Likely Pathogenic, and Pathogenic over time. It pairs variant data with HPO phenotype annotations to enable phenotype-driven gene discovery.

**Live at** [vus.zyrkel.com](https://vus.zyrkel.com) (API) | [schlein-lab.github.io/nano-zyrkel-vusTracker](https://schlein-lab.github.io/nano-zyrkel-vusTracker/) (Frontend)

## Features

| Feature | Description |
|---|---|
| **Gene Dashboard** | Search any gene &rarr; full variant analysis with classification history |
| **HPO Phenotype Search** | Search by clinical phenotype &rarr; ranked gene list |
| **Classification Drift Charts** | Visualize how variant interpretations change over time |
| **Genome Browser** | Positional variant view with functional annotations |
| **Submission Timeline** | Track when and by whom variants were submitted |
| **VUS Survival Curves** | Kaplan-Meier-style analysis of VUS resolution rates |
| **Submitter Concordance** | Compare classifications across submitting laboratories |
| **ACMG Filtering** | Filter by Pathogenic, Likely Pathogenic, VUS, Likely Benign, Benign |
| **Time Period Filtering** | 7 days, 1 month, 1 year, 5 years, or all time |
| **Top Genes & Phenotypes** | Overview of most active genes and phenotypes |
| **Export** | CSV, TSV, and XLS download for any result set |
| **Email Watchlist** | Subscribe to genes or variants &rarr; get alerts on reclassification |

## Architecture

```
                    GitHub Actions (daily)
                          |
                    ClinVar XML/VCF
                          |
                          v
               +---------------------+
               |   Laravel REST API  |
               |   vus.zyrkel.com    |
               +---------------------+
               |  MySQL (4.4M vars)  |
               |  1M HPO assoc.      |
               |  11.8K HPO terms    |
               +---------------------+
                          |
                          v
               +---------------------+
               | Frontend (SPA)      |
               | Vanilla JS + WASM   |
               | GitHub Pages        |
               +---------------------+
```

- **Sync pipeline**: GitHub Actions fetches ClinVar releases daily, parses XML/VCF, and upserts into MySQL
- **API**: Laravel backend exposes RESTful endpoints for gene lookup, phenotype search, drift analysis, and export
- **Frontend**: Single-page application using vanilla JS with Rust/WASM modules for computation-heavy operations
- **WASM modules**: Rust compiled to WebAssembly handles survival curve fitting and concordance calculations client-side

## Data Sources

| Source | Records | Update Frequency |
|---|---|---|
| [ClinVar](https://www.ncbi.nlm.nih.gov/clinvar/) | 4.4M+ variants | Daily |
| [HPO](https://hpo.jax.org/) | 11.8K terms, 1M associations | Weekly |

## Embed

Embed the gene dashboard in any page:

```html
<iframe
  src="https://schlein-lab.github.io/nano-zyrkel-vusTracker/?gene=BRCA1&embed=true"
  width="100%" height="700" frameborder="0">
</iframe>
```

## Build

```bash
# Rust CLI (data pipeline)
cargo build --release

# WASM frontend modules
trunk build --release

# API (Laravel)
composer install
php artisan migrate
php artisan serve
```

## License

MIT

---

<sub>Part of the [nano-zyrkel](https://github.com/schlein-lab) ecosystem — autonomous agents for computational biology. Built by [Schlein Lab](https://zyrkel.com).</sub>
