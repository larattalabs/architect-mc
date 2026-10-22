package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.region.Packed;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The survival ledger lint's calibration (docs/FAST-CHECKS.md "5. Survival ledger lint"; tools/p3-probe.mjs ledger, release tier): the
 * refund cu-survival measured in game for a deconstruct after weathering, waxing and scraping equals the lint's model's refund of the
 * same standing blocks ({@link LedgerSim#costs}, the items of the block standing). Skipped without {@code -Dledger.probe=<file>}.
 */
class LedgerProbeTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void theMeasuredRefundIsTheModelsRefundOfTheStandingBlocks() throws Exception {
		String file = System.getProperty("ledger.probe");
		assumeTrue(file != null && !file.isBlank(), "no -Dledger.probe");
		JsonObject o = JsonParser.parseString(Files.readString(Path.of(file))).getAsJsonObject();
		Map<String, Integer> model = new TreeMap<>();
		o.getAsJsonArray("standing").forEach(s -> LedgerSim.addAll(model, LedgerSim.costs(Packed.parse(s.getAsString())), 1));
		Map<String, Integer> measured = new TreeMap<>();
		o.getAsJsonObject("returned").entrySet().forEach(e -> {
			if (e.getValue().getAsInt() != 0) {
				measured.put(e.getKey(), e.getValue().getAsInt());
			}
		});
		assertEquals(model, measured, "the model's refund of the standing blocks against the game's");
	}
}
