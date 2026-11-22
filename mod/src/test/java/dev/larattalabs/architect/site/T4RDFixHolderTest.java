package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D fix round, P1-6; unit part of T4RDF-holder, whose in-game row in step t4rm-cargo asserts the stock) One paying path per holder
 * stack: an extraction takes a player's holder's contents out (CargoTxn: a plain stack credited into the pile, keyed per txn and effect)
 * before its P0, for every caller (a standalone road, a group's R1); a group's R1 no longer books plain contents as a pending credit keyed
 * per target and cell (a second extraction at the cell replayed it); the W never writes back a holder that holds items again.
 */
class T4RDFixHolderTest {
	static String body(String src, String from, String to) {
		int a = src.indexOf(from);
		int b = src.indexOf(to, a + 1);
		assertTrue(a >= 0 && b > a, "found " + from);
		return src.substring(a, b);
	}

	@Test
	void holderContentsHaveOnePayingPath() throws Exception {
		System.out.println("ROW T4RDF-holder (unit)");
		String ex = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Extractions.java"));
		String run = body(ex, "static @Nullable String run(MinecraftServer srv, ServerLevel level, Infra t", "/** Begins (or attaches to)");
		int take = run.indexOf("takeContents(level, t, tk, cells)");
		int p0 = run.indexOf("Stockpiles.saveWithWorldConfirmed(srv)");
		assertTrue(take > 0 && take < p0, "T4RDF-holder: the extraction takes its holders' contents out before its P0 save");
		String gr = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Groups.java"));
		String find = body(gr, "private static @Nullable String findCargo(", "/**");
		assertFalse(find.contains("r.cargo.putIfAbsent"), "T4RDF-holder: a group's R1 books no plain contents as a pending credit keyed per target and cell");
		String cargo = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/txn/CargoTxn.java"));
		assertTrue(cargo.contains("case CrateTxn.PILE_CREDIT -> CrateTxn.CREDITOR"), "T4RDF-holder: a plain stack is credited into the pile by the cargo txn");
		String rt = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/txn/RemovalTxn.java"));
		assertTrue(rt.contains("Extractions.holdsItems("), "T4RDF-holder: the W never writes back a holder that holds items");
	}
}
