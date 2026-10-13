package dev.larattalabs.architect.placed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.BuildState;
import org.junit.jupiter.api.Test;

/**
 * 6c PT2 §9: an ADOPTED build is written to builds.json with the state it had before (ACTIVE or CLAIMED) plus {@code adopted {site,
 * prior}}, so a 0.27.0 reader (whose {@code BuildState.valueOf} would throw on ADOPTED and drop the rest of the index) reads a build
 * there; this reader reads it back ADOPTED with its site and prior state. A build that is not adopted is written as before.
 */
class BuildsAdoptTest {
	static Builds.Rec rec(BuildState s) {
		Builds.Rec r = new Builds.Rec();
		r.id = "build-4";
		r.n = 4;
		r.bounds = new int[] {0, 64, 0, 8, 70, 8};
		r.state = s;
		return r;
	}

	@Test
	void adoptedWritesThePriorState() {
		Builds.Rec r = rec(BuildState.CLAIMED);
		r.prior = BuildState.CLAIMED;
		r.state = BuildState.ADOPTED;
		r.siteId = "s12";
		JsonObject o = Builds.toJson(r);
		assertEquals("CLAIMED", o.get("state").getAsString(), "an older reader reads the prior state");
		BuildState.valueOf(o.get("state").getAsString()); // 0.27.0's valueOf: no throw
		assertEquals("s12", o.getAsJsonObject("adopted").get("site").getAsString());
		Builds.Rec back = Builds.fromJson(o);
		assertEquals(BuildState.ADOPTED, back.state);
		assertEquals("s12", back.siteId);
		assertEquals(BuildState.CLAIMED, back.prior);
		assertTrue(back.kept(), "an adopted build is kept by every write path");
	}

	@Test
	void notAdoptedUnchanged() {
		JsonObject o = Builds.toJson(rec(BuildState.ACTIVE));
		assertFalse(o.has("adopted"));
		assertEquals("ACTIVE", o.get("state").getAsString());
		Builds.Rec back = Builds.fromJson(o);
		assertEquals(BuildState.ACTIVE, back.state);
		assertNull(back.siteId);
	}
}
