package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * (8b, Steward's S-8b-8) The typed home of a region's {@code architect_mc:beside} ext ({@link RegionView#besideNote}): the standing region it
 * was planned beside, whether its join's end dangles (that region removed), and the gate region whose removal left it dangling. Since NEXT.
 */
public record BesideNote(String region, boolean dangling, @Nullable String gateRemoved) {
}
