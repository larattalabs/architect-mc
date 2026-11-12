package dev.larattalabs.architect.api;

import java.util.Locale;
import java.util.Optional;

/**
 * (7b) How a site-aware design meets its site (docs/CONTRACT.md "Phase 7b" §2, SETTLEMENTS §7.1). The wire name is the lowercase
 * name ({@code on_pad}, {@code carve_into}, ...), the same ids as the kit's fit table ({@code kit/lib/siteFits.mjs}).
 * <ul>
 * <li>{@code ON_PAD}: today's placement (TerrainFit CLEAR, the ground approach); a {@link SiteSpec} with it changes nothing.</li>
 * <li>{@code CARVE_INTO}: rooms cut into rock; every cell the design does not write is kept.</li>
 * <li>{@code ATTACH_TO_CLIFF}: hangs on or stands against a face, bearing on it; no foundation fill.</li>
 * <li>{@code SPAN}: bridges a gap between two faces or two trunks.</li>
 * <li>{@code WRAP_TRUNK}: rings a trunk (natural, generated or a spike); the trunk cells are keep-critical.</li>
 * <li>{@code SUSPEND}: hangs from a ceiling, overhang or branch; the hang points are keep-critical.</li>
 * </ul>
 * New values are only ever appended. Since NEXT.
 */
public enum FitMode {
	ON_PAD, CARVE_INTO, ATTACH_TO_CLIFF, SPAN, WRAP_TRUNK, SUSPEND;

	/** The wire name: the lowercase name ({@code attach_to_cliff}). */
	public String wire() {
		return name().toLowerCase(Locale.ROOT);
	}

	/** The fit of a wire name (any case); empty when it names none. */
	public static Optional<FitMode> of(String wire) {
		if (wire == null) {
			return Optional.empty();
		}
		for (FitMode f : values()) {
			if (f.wire().equals(wire.toLowerCase(Locale.ROOT))) {
				return Optional.of(f);
			}
		}
		return Optional.empty();
	}
}
