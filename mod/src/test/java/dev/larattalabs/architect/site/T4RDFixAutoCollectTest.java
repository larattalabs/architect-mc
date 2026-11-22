package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D fix round, P2-1; unit part of T4RDF-group-collect, whose in-game row in step t4rd-crash asserts the online player's inventory)
 * Every removal path that owes the player's blocks auto-collects them after it retired: a group's (stage's, region's, revision's) txn and an
 * extraction attempt, as a single removal's owner does, on a later tick from the path's immutable snapshot.
 */
class T4RDFixAutoCollectTest {
	@Test
	void everyRetiringPathAutoCollects() throws Exception {
		System.out.println("ROW T4RDF-group-collect (unit)");
		String gr = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Groups.java"));
		int end = gr.indexOf("private static void end(MinecraftServer server, Removal r, Removed given) {");
		int remove = gr.indexOf("REMOVALS.remove(r);", end);
		assertTrue(end > 0 && gr.substring(end, remove).contains("AutoCollect.afterPartsLater("), "T4RDF-group-collect: a group's end (its txn retired) auto-collects");
		String ex = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Extractions.java"));
		assertTrue(ex.contains("collectLater(srv, at);"), "T4RDF-group-collect: a kept extraction attempt auto-collects");
	}
}
