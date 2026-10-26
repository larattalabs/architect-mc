package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.region.volume.Arvx;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (7a RK, docs/CONTRACT.md "Phase 7a slice RK" §3) The only Java of the slice: a plan with a {@code rock_stair} connector part checks in
 * the two-plan flow (its corridor's frozen volume), as a tunnel's; a rock stair's guard ({@code connector: "rock_stair"}) names it in the
 * stale rock's message; a tunnel's guard reads as before.
 */
class PlanChecksRKTest {
	private static JsonObject json(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	@Test
	void rockStairPartsAskForVolumes() {
		assertTrue(PlanChecks.hasTunnel(json("{\"connectors\":[{\"id\":\"a\",\"kind\":\"road\"},{\"id\":\"f\",\"kind\":\"rock_stair\"}]}")));
		assertTrue(PlanChecks.hasTunnel(json("{\"connectors\":[{\"id\":\"t\",\"kind\":\"tunnel\"}]}")), "a tunnel still does");
		assertFalse(PlanChecks.hasTunnel(json("{\"connectors\":[{\"id\":\"s\",\"kind\":\"stair\"},{\"id\":\"c\",\"kind\":\"catwalk\"}]}")), "a built stair or a catwalk does not");
		assertFalse(PlanChecks.hasTunnel(json("{\"forms\":[{\"id\":\"f\",\"kind\":\"rock_stair\"}]}")), "only a connector part");
	}

	@Test
	void guardNamesItsConnector() {
		assertEquals("rock_stair", PlanChecks.connectorOf(json("{\"part\":\"f\",\"connector\":\"rock_stair\"}")));
		assertEquals("tunnel", PlanChecks.connectorOf(json("{\"part\":\"t\",\"tunnel\":\"x\"}")), "a tunnel's guard (no connector member) reads as before");
		assertEquals("tunnel", PlanChecks.connectorOf(json("{\"part\":\"t\",\"connector\":\"lift\"}")), "an unknown connector reads as a tunnel's");
		JsonArray runs = new JsonArray();
		for (int v : new int[] {0, 0, 0, 5}) {
			runs.add(v);
		}
		int rock = VoxelClass.ROCK.ordinal(), air = VoxelClass.AIR.ordinal();
		Arvx.Decoded before = vol(new int[] {rock, rock, rock, rock, air, air});
		Arvx.Decoded mined = vol(new int[] {rock, air, rock, rock, air, air});
		assertNull(PlanChecks.rockDiff("rock_stair", "flight", before, before, runs));
		String why = PlanChecks.rockDiff("rock_stair", "flight", before, mined, runs);
		assertTrue(why != null && why.startsWith("rock_stair flight: the rock it was checked against changed since the check, 1 cell: (0, 1, 0) ROCK->AIR"), why);
		assertEquals(PlanChecks.rockDiff("tunnel", "t1", before, mined, runs), PlanChecks.rockDiff("t1", before, mined, runs), "the tunnel's message unchanged");
	}

	private static Arvx.Decoded vol(int[]... cols) {
		List<int[][]> columns = new ArrayList<>();
		for (int[] col : cols) {
			List<int[]> runs = new ArrayList<>();
			for (int cls : col) {
				runs.add(new int[] {cls, 1});
			}
			columns.add(runs.toArray(new int[0][]));
		}
		return new Arvx.Decoded(new int[] {0, 0, 0, 0, 5, cols.length - 1}, columns, List.of(), new int[0]);
	}
}
