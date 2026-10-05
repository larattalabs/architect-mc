package dev.larattalabs.architect.api;

/**
 * A massing at one version (docs/CONTRACT.md "Phase 4c contract"): what a massing job makes, what a group item's massing is
 * and what a detail pass is bound to. Massing ids are {@code [a-z0-9_]{1,64}} ({@code mas_<slug>} when the sidecar names
 * them); versions start at 1 and a redirect adds one. Since 1.3.0.
 */
public record MassingRef(String id, int version) {
	@Override
	public String toString() {
		return id + "@" + version;
	}
}
