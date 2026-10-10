package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.ProtectedArea;
import dev.larattalabs.architect.journal.Journal;
import java.util.List;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** C17's store and tests (6c slice 0c §8): owners, limits, the per-owner rule, the file format. */
class ProtectedTest {
	private static final ResourceKey<Level> OVER = ResourceKey.create(Registries.DIMENSION, Identifier.parse("minecraft:overworld"));
	private static final ResourceKey<Level> NETHER = ResourceKey.create(Registries.DIMENSION, Identifier.parse("minecraft:the_nether"));

	@AfterEach
	void clear() {
		for (ProtectedArea a : Protected.list(null)) {
			Protected.unprotect(a.owner(), a.id());
		}
	}

	@Test
	void onlyTheOwnersOpsInItsDimension() {
		Protected.protect(new ProtectedArea("test:a", "farm", OVER, 0, 0, 9, 9, "the farm"));
		assertNotNull(Protected.hit("minecraft:overworld", "test:a", 5, 5, 20, 20));
		assertNull(Protected.hit("minecraft:overworld", "test:b", 5, 5, 20, 20), "another owner's ops pass");
		assertNull(Protected.hit("minecraft:overworld", null, 5, 5, 20, 20), "the player's ops pass");
		assertNull(Protected.hit("minecraft:the_nether", "test:a", 5, 5, 20, 20), "another dimension");
		assertNull(Protected.hit("minecraft:overworld", "test:a", 10, 0, 20, 20), "outside");
		assertNotNull(Protected.hitCells("minecraft:overworld", "test:a", List.of(Journal.pos(50, 70, 50), Journal.pos(9, -60, 0))));
		assertNull(Protected.hitCells("minecraft:overworld", "test:a", new long[] {Journal.pos(50, 70, 50)}));
		Protected.Columns c = Protected.columns("minecraft:overworld", "test:a");
		assertNotNull(c);
		assertEquals("farm", c.at(3, 3).id());
		assertNull(c.at(10, 3));
		assertNull(Protected.columns("minecraft:overworld", "test:b"));
		assertTrue(Protected.message("Placing x", c.at(3, 3)).contains("protected area farm (the farm) of test:a"));
	}

	@Test
	void replaceAndLift() {
		Protected.protect(new ProtectedArea("test:a", "farm", OVER, 0, 0, 9, 9, ""));
		Protected.protect(new ProtectedArea("test:a", "farm", OVER, 100, 100, 109, 109, ""));
		assertEquals(1, Protected.list("test:a").size(), "the same (owner, id) replaces");
		assertNull(Protected.hit("minecraft:overworld", "test:a", 0, 0, 9, 9));
		assertTrue(Protected.unprotect("test:a", "farm"));
		assertFalse(Protected.unprotect("test:a", "farm"));
		assertTrue(Protected.list(null).isEmpty());
	}

	@Test
	void limits() {
		assertThrows(IllegalArgumentException.class, () -> Protected.protect(new ProtectedArea(null, "x", OVER, 0, 0, 1, 1, "")));
		assertThrows(IllegalArgumentException.class, () -> Protected.protect(new ProtectedArea("steward", "x", OVER, 0, 0, 1, 1, "")), "<modid>:<thing>");
		assertThrows(IllegalArgumentException.class, () -> Protected.protect(new ProtectedArea("test:a", " ", OVER, 0, 0, 1, 1, "")));
		Protected.protect(new ProtectedArea("test:a", "big", OVER, 0, 0, 4095, 4095, ""));
		assertThrows(IllegalArgumentException.class, () -> Protected.protect(new ProtectedArea("test:a", "bigger", OVER, 0, 0, 4096, 10, "")));
		for (int i = 1; i < ProtectedArea.MAX_PER_OWNER; i++) {
			Protected.protect(new ProtectedArea("test:a", "a" + i, OVER, i, i, i, i, ""));
		}
		assertThrows(IllegalArgumentException.class, () -> Protected.protect(new ProtectedArea("test:a", "one-more", OVER, 0, 0, 1, 1, "")));
		Protected.protect(new ProtectedArea("test:a", "a1", OVER, 5, 5, 6, 6, "")); // replacing is not a new one
		Protected.protect(new ProtectedArea("test:b", "a1", OVER, 5, 5, 6, 6, "")); // per owner
	}

	@Test
	void fileRoundTrip() {
		List<ProtectedArea> in = List.of(new ProtectedArea("test:a", "farm", OVER, -5, 3, 9, 9, "the farm"), new ProtectedArea("test:b", "pit", NETHER, 1, 2,
			3, 4, ""));
		assertEquals(in, Protected.fromJson(Protected.toJson(in)));
	}
}
