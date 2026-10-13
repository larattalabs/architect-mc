package dev.larattalabs.architect.api;

import java.util.List;

/**
 * A build in the way (§9, C32's named refusal): its id, kind, how many of its cells block the op, and the first 8 of them with
 * their block ids. Since PT.
 */
public record BuildHit(String buildId, BuildKind kind, int blocking, List<BlockHit> first) {
	public BuildHit {
		first = List.copyOf(first);
	}
}
