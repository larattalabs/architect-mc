package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * (8b review P1) The connector dry run and every API place survey with a policy that cannot generate terrain, so an over-cap check (and a
 * capped place, whose cap is known only after its check) generates nothing near ungenerated chunks. Only the player's own marker path may
 * generate. Failing first: on 0e7e98ab both used LOAD_BOUNDED (generate true).
 */
class ApiCKNoGenTest {
	private static final BoundingBox CLAIM = new BoundingBox(-16, -64, -16, 16, 319, 25);

	@Test
	void theDryRunAndTheApiNeverGenerate() {
		assertFalse(ConnectorPlace.surveyPolicy(CLAIM, false).generates(), "checkConnector and the API's placeConnector: never generated");
		assertTrue(ConnectorPlace.surveyPolicy(CLAIM, false).loads(), "chunks already generated are still read");
		assertTrue(ConnectorPlace.surveyPolicy(CLAIM, true).generates(), "the player's marker path, as before");
	}
}
