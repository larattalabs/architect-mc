package dev.larattalabs.architect.api;

/**
 * A build's state (§4, §8): ACTIVE (promoted), CLAIMED (marked by "claim my build": no promote bar, never demoted), RELEASED (its
 * cells stay tracked but incidental; not promoted again unless claimed or grown by 25%), PROVISIONAL (24+ structural cells a
 * player changed in the last 10 minutes: kept like a build so a half-built house isn't cleared mid-build, N-PT-2), ADOPTED (PT2:
 * standing as a site, {@link Build#siteId()}; never demoted, kept by every write path, its own site's operations are implicitly
 * consented for the site's own cells). ACTIVE, CLAIMED, PROVISIONAL and ADOPTED builds are kept by every write path. New values are
 * only ever appended. Since PT.
 */
public enum BuildState {
	ACTIVE, CLAIMED, RELEASED, PROVISIONAL,
	/** PT2: adopted as a site ({@link Sites#adopt}). */
	ADOPTED
}
