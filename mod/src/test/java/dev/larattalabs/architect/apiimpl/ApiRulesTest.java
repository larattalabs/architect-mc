package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.placement.Occupancy.Kind;
import java.util.List;
import org.junit.jupiter.api.Test;

class ApiRulesTest {
	@Test
	void occupancyReasonPrefersPlayer() {
		assertEquals(Reason.PLAYER_IN_BOX, ApiRules.occupancyReason(List.of(Kind.OWNED, Kind.PLAYER)));
		assertEquals(Reason.PLAYER_IN_BOX, ApiRules.occupancyReason(List.of(Kind.PLAYER)));
		assertEquals(Reason.OCCUPIED, ApiRules.occupancyReason(List.of(Kind.OWNED, Kind.LIVING, Kind.ITEM)));
		assertEquals(Reason.OCCUPIED, ApiRules.occupancyReason(List.of()));
	}

	@Test
	void modeResolvesAgainstTheToggle() {
		assertTrue(ApiRules.construction(Mode.AUTO, true));
		assertFalse(ApiRules.construction(Mode.AUTO, false));
		assertFalse(ApiRules.construction(Mode.INSTANT, true));
		assertTrue(ApiRules.construction(Mode.CONSTRUCTION, false));
	}

	@Test
	void instantInSurvivalNeedsAnOpActor() {
		// survival toggle on: no actor, or an actor without permission 2, is refused
		assertNotNull(ApiRules.modeRefusal(Mode.INSTANT, true, false, false));
		assertNotNull(ApiRules.modeRefusal(Mode.INSTANT, true, true, false));
		assertNull(ApiRules.modeRefusal(Mode.INSTANT, true, true, true));
		// toggle off: instant is the normal placement
		assertNull(ApiRules.modeRefusal(Mode.INSTANT, false, false, false));
		// other modes never need a permission (construction costs items)
		assertNull(ApiRules.modeRefusal(Mode.AUTO, true, false, false));
		assertNull(ApiRules.modeRefusal(Mode.CONSTRUCTION, true, false, false));
		assertNull(ApiRules.modeRefusal(Mode.CONSTRUCTION, false, false, false));
	}

	@Test
	void removeNeedsForceForAnotherOwner() {
		assertNull(ApiRules.removeRefusal("s1", "steward_mc:set/a", "steward_mc:set/a", false));
		assertNull(ApiRules.removeRefusal("s1", null, null, false)); // the player's own site, the player asks
		String r = ApiRules.removeRefusal("s1", "steward_mc:set/a", "other_mod:x", false);
		assertNotNull(r);
		assertTrue(r.contains("steward_mc:set/a") && r.contains("force"), r);
		assertNotNull(ApiRules.removeRefusal("s1", "steward_mc:set/a", null, false)); // the player removing a mod's site through the API
		assertNotNull(ApiRules.removeRefusal("s1", null, "steward_mc:x", false)); // a mod removing the player's site
		assertNull(ApiRules.removeRefusal("s1", "steward_mc:set/a", "other_mod:x", true));
	}

	@Test
	void ownerFilter() {
		assertTrue(ApiRules.ownerMatches(null, null));
		assertTrue(ApiRules.ownerMatches("a:b", "a:b"));
		assertFalse(ApiRules.ownerMatches("a:b", null));
		assertFalse(ApiRules.ownerMatches(null, "a:b"));
	}

	@Test
	void extKeysAreNamespaced() {
		assertTrue(ApiRules.extKeyValid("steward_mc:lot"));
		assertTrue(ApiRules.extKeyValid("apitest:a/b"));
		assertFalse(ApiRules.extKeyValid("lot"));
		assertFalse(ApiRules.extKeyValid(":lot"));
		assertFalse(ApiRules.extKeyValid("Steward:lot"));
		assertFalse(ApiRules.extKeyValid(null));
	}

	@Test
	void surveyResolution() {
		assertEquals(1, ApiRules.surveyResolution(1, 256, 256));
		assertEquals(4, ApiRules.surveyResolution(1, 257, 10));
		assertEquals(4, ApiRules.surveyResolution(1, 10, 300));
		assertEquals(4, ApiRules.surveyResolution(4, 16, 16));
		assertEquals(4, ApiRules.surveyResolution(2, 16, 16));
		assertEquals(64, ApiRules.surveyColumns(256, 4));
		assertEquals(65, ApiRules.surveyColumns(257, 4));
	}
}
