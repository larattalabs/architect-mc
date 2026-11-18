package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * (v0.79.0 release review P1) DR2's repair barrier rides T0's world barrier: a swallowed chunk serialization failure (an owed save, not an
 * undurable write) must refuse the repair before Repairs releases the journal group or saves the pending site's removal.
 */
class RepairBarrierT0Test {
	@Test
	void theRepairBarrierUsesT0sBarrierAndRefusesOnOwedSaves() throws Exception {
		String s = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		int a = s.indexOf("static void durableBarrier(MinecraftServer srv)");
		int b = s.indexOf("static @Nullable String savingOff(", a);
		assertTrue(a > 0 && b > a, "durableBarrier found");
		String body = s.substring(a, b);
		assertTrue(body.contains("DurableBarrier.Result r = barrier(srv);") && body.contains("if (!r.ok())"),
			"with the ledger loaded it runs T0's barrier and refuses on anything short of OK");
		assertTrue(!body.contains("saveWithWorld(srv);"), "never the older saveWithWorld, which ignores a swallowed serialization failure");
		assertTrue(body.contains("DurableBarrier.owedSaves()"), "with the ledger off, an owed chunk or player save still refuses");
	}
}
