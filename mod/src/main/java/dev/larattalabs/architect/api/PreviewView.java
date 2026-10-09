package dev.larattalabs.architect.api;

/**
 * The four region previews (docs/CONTRACT.md phase 6b §3.3): a top view, sections along up to 4 axes, an isometric view and the
 * site plan (SVG and PNG, plus {@code siteplan.json}). Deterministic: the same IR and survey give byte-identical PNGs. New
 * values are only ever appended. Since 1.9.0.
 */
public enum PreviewView { TOP, SECTION, ISO, SITEPLAN }
