package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonObject;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * C29 (a): a single stockpile road removal's refunds travel with its restore job (saved, so a restart mid-removal keeps them) and
 * are credited when the restore is written; a job without them saves no credit.
 */
class C29CreditTest {
	@Test
	void roadRemovalCreditSurvivesTheJobsSave() {
		RestoreJob j = new RestoreJob("r7", RestoreJob.REMOVE, null, null);
		j.credit = new Groups.Credit("test:settle", "road:r7@1234", Map.of("minecraft:gravel", 12, "minecraft:stone_slab", 3), 99L);
		JsonObject o = j.toJson();
		RestoreJob back = RestoreJob.fromJson(o);
		assertNotNull(back.credit);
		assertEquals("test:settle", back.credit.owner());
		assertEquals("road:r7@1234", back.credit.key());
		assertEquals(Map.of("minecraft:gravel", 12, "minecraft:stone_slab", 3), back.credit.items());
		assertEquals(99L, back.credit.at());
	}

	@Test
	void noCreditNoKey() {
		RestoreJob j = new RestoreJob("r8", RestoreJob.REMOVE, null, null);
		JsonObject o = j.toJson();
		assertFalse(o.has("credit"));
		assertNull(RestoreJob.fromJson(o).credit);
	}

	@Test
	void nothingLeavesWithoutARemoval() {
		assertFalse(Groups.leaving("s1"));
	}
}
