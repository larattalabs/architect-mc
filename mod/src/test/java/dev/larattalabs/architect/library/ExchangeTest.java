package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Export and import paths (26.3 structure-block layout). */
class ExchangeTest {
	@Test
	void exportPaths(@TempDir Path game) {
		Path data = game.resolve("architect");
		assertEquals(data.resolve("exports/gen_cabin"), Exchange.exportDir(data, "gen_cabin"));
		Path world = game.resolve("saves/Architect Dev");
		assertEquals(world.resolve("generated/architect_mc/structure/gen_cabin.nbt"), Exchange.worldStructure(world, Exchange.NAMESPACE, "gen_cabin"));
		assertThrows(IllegalArgumentException.class, () -> Exchange.exportDir(data, "../evil"));
		assertThrows(IllegalArgumentException.class, () -> Exchange.worldStructure(world, "architect_mc", "a/b"));
	}

	@Test
	void importCandidates(@TempDir Path game) throws Exception {
		Path data = game.resolve("architect");
		Path world = game.resolve("saves/w");
		Path a = touch(data.resolve("imports/old_house.nbt"), 1000);
		Path b = touch(data.resolve("imports/sub/New Barn.nbt"), 5000);
		touch(data.resolve("imports/readme.txt"), 6000);
		Path c = touch(world.resolve("generated/minecraft/structure/house.nbt"), 2000);
		Path d = touch(world.resolve("generated/architect_mc/structure/gen_cabin.nbt"), 3000);
		Path e = touch(world.resolve("generated/mymod/structures/deep/hall.nbt"), 4000);
		List<Exchange.Candidate> l = Exchange.importCandidates(data, world);
		assertEquals(List.of(b, a, e, d, c), l.stream().map(Exchange.Candidate::path).toList(), "imports first, each group newest first");
		assertEquals("sub/New Barn.nbt", l.get(0).label());
		assertEquals("imports", l.get(0).where());
		assertEquals("mymod:deep/hall", l.get(2).structureId());
		assertEquals("world", l.get(3).where());
		assertEquals("architect_mc:gen_cabin", l.get(3).label());
		assertTrue(Exchange.importCandidates(data, null).stream().allMatch(x -> x.where().equals("imports")));
		assertEquals(List.of(), Exchange.importCandidates(game.resolve("none"), game.resolve("none")));
	}

	@Test
	void suggestedIds() {
		assertEquals("new_barn", Exchange.suggestId("sub/New Barn.nbt"));
		assertEquals("hall", Exchange.suggestId("mymod:deep/hall"));
		assertEquals("imported", Exchange.suggestId("!!.nbt"));
	}

	static Path touch(Path p, long mtime) throws Exception {
		Files.createDirectories(p.getParent());
		Files.write(p, new byte[] {1, 2, 3});
		Files.setLastModifiedTime(p, FileTime.fromMillis(mtime));
		return p;
	}
}
