package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * (chore LT) The world-start "crate missing" warning: still for a legacy crate site whose crate is gone and for a crate-less site no
 * stockpile feeds; never for a stockpile-fed site. The crate-less case is judged after the stockpiles load (the Sites check's
 * SERVER_STARTED listener runs before Stockpiles.load, so it read every stockpile-fed site as crate missing).
 */
class SitesCrateCheckLTTest {
	@Test
	void theDecision() {
		assertTrue(Sites.crateMissing(true, false, false), "legacy crate site, crate gone: warns");
		assertFalse(Sites.crateMissing(true, true, false), "legacy crate site, crate there: silent");
		assertFalse(Sites.crateMissing(false, false, true), "stockpile-fed crate-less site: silent");
		assertTrue(Sites.crateMissing(false, false, false), "crate-less site no stockpile feeds (dissolved, other dimension, failed load): warns");
	}

	@Test
	void theCrateLessCheckRunsAfterTheStockpilesLoad() throws Exception {
		String sp = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		int load = sp.indexOf("private static void load(MinecraftServer server) {");
		int end = sp.indexOf("\n\t}", load);
		String body = sp.substring(load, end);
		int loaded = body.indexOf("loadFrom(");
		int forget = body.indexOf("forgetEarlyRuns(server);");
		int check = body.indexOf("Sites.crateCheckAfterStockpiles(server);");
		assertTrue(loaded > 0 && forget > loaded && check > forget, "Stockpiles.load: loadFrom, forgetEarlyRuns, then the crate-less crate check");

		String s = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Sites.java"));
		int at = s.indexOf("if (b.building()) {\n\t\t\t\t\tServerLevel lv = levelOf(server, b);");
		assertTrue(at > 0, "the Sites check's crate block");
		String block = s.substring(at, s.indexOf("is a construction site: ", at));
		assertTrue(block.contains("cr != null && crateMissing(true,"), "the Sites check judges only sites with a crate of their own");
		assertFalse(block.contains("cr == null ||"), "a crate-less site is not reported before the stockpiles load");
		int after = s.indexOf("static void crateCheckAfterStockpiles(");
		String later = s.substring(after, s.indexOf("\n\t}", after));
		assertTrue(later.contains("crate() != null") && later.contains("Stockpiles.pileOf(b) != null") && later.contains("report(b.id(), true"),
			"the later check: crate-less sites only, fed means a stockpile, reported as the check does");
	}
}
