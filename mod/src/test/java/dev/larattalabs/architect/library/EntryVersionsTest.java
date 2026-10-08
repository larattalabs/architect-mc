package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Entry versions on disk (docs/CONTRACT.md phase 5b): the crash-safe install with a fault at every step, then repair. */
class EntryVersionsTest {
	@TempDir
	Path tmp;

	Path entry(String id) throws IOException {
		Path d = tmp.resolve("library").resolve(id);
		Files.createDirectories(d);
		Files.write(d.resolve(id + ".nbt"), new byte[] {1, 2, 3});
		Files.writeString(d.resolve(id + ".mjs"), "export default 1;\n");
		Files.writeString(d.resolve(id + ".blueprint.json"), "{\"id\":\"" + id + "\",\"size\":{\"x\":1,\"y\":1,\"z\":1},\"favorite\":true,"
			+ "\"userTags\":[\"keep\"],\"ext\":{\"steward_mc:lot\":\"L3\"}}\n");
		return d;
	}

	Path version(String id, byte b) throws IOException {
		Path s = tmp.resolve("src-" + b);
		Files.createDirectories(s);
		Files.write(s.resolve(id + ".nbt"), new byte[] {b, b});
		Files.write(s.resolve(id + ".parts.nbt"), new byte[] {9});
		Files.writeString(s.resolve(id + ".blueprint.json"), "{\"id\":\"" + id + "\",\"size\":{\"x\":2,\"y\":1,\"z\":1},\"favorite\":false}\n");
		return s;
	}

	static JsonObject json(Path f) throws IOException {
		return JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
	}

	@Test
	void installBumpsTheHeadKeepsUserKeysAndRecordsTheLineage() throws IOException {
		Path d = entry("inn");
		assertEquals(2, EntryVersions.install(d, "inn", version("inn", (byte) 7), "polish", null, "fixed the roof", null,
			EntryVersions.Faults.NONE));
		JsonObject top = json(d.resolve("inn.blueprint.json"));
		assertEquals(2, EntryVersions.version(top));
		assertTrue(top.get("favorite").getAsBoolean(), "the mod's keys come from the old top level");
		assertEquals("L3", top.getAsJsonObject("ext").get("steward_mc:lot").getAsString());
		assertArrayEquals(new byte[] {7, 7}, Files.readAllBytes(d.resolve("inn.nbt")));
		assertArrayEquals(new byte[] {9}, Files.readAllBytes(d.resolve("inn.parts.nbt")));
		assertFalse(Files.exists(d.resolve("inn.mjs")), "the head has no source: the old one went");
		assertTrue(Files.exists(d.resolve("versions/1/inn.mjs")));
		assertArrayEquals(new byte[] {1, 2, 3}, Files.readAllBytes(d.resolve("versions/1/inn.nbt")), "the first bump copies the old top level");
		List<EntryVersions.Lineage> l = EntryVersions.lineage(top, null);
		assertEquals(2, l.size());
		assertEquals("migrated", l.get(0).by());
		assertEquals("polish", l.get(1).by());
		assertEquals(1, l.get(1).parent());
		assertEquals("fixed the roof", l.get(1).summary());
		assertEquals(EntryVersions.sha256(d.resolve("inn.nbt")), l.get(1).nbtSha256());
		assertEquals(List.of(1, 2), EntryVersions.complete(d));
		assertEquals(d.resolve("versions/1"), EntryVersions.locate(d, "inn", 1));
		assertEquals(d.resolve("versions/2"), EntryVersions.locate(d, "inn", 2));
		assertNull(EntryVersions.locate(d, "inn", 3));
		// a third version: no second copy of the head
		assertEquals(3, EntryVersions.install(d, "inn", version("inn", (byte) 8), "revert", 1, "back", null, EntryVersions.Faults.NONE));
		assertEquals(List.of(1, 2, 3), EntryVersions.complete(d));
		assertEquals(3, EntryVersions.lineage(json(d.resolve("inn.blueprint.json")), null).size());
	}

	@Test
	void anEntryNeverBumpedIsVersionOneAtTheTopLevel() throws IOException {
		Path d = entry("hut");
		assertEquals(d, EntryVersions.locate(d, "hut", 1));
		assertNull(EntryVersions.locate(d, "hut", 2));
		assertEquals(1, EntryVersions.version(json(d.resolve("hut.blueprint.json"))));
		assertFalse(EntryVersions.repair(d, "hut"));
	}

	@Test
	void aFaultAtEveryStepIsRepairedToAConsistentEntry() throws IOException {
		String[] steps = {"copy-head", "rename-head", "write-new", "commit", "top:inn.nbt", "top-del:inn.mjs", "top:inn.parts.nbt", "top:json"};
		for (String step : steps) {
			Path d = entry("inn");
			Path src = version("inn", (byte) 5);
			IOException e = assertThrows(IOException.class, () -> EntryVersions.install(d, "inn", src, "polish", null, "s", null, at -> {
				if (at.equals(step)) {
					throw new IOException("fault at " + at);
				}
			}), step);
			assertTrue(e.getMessage().contains(step));
			EntryVersions.repair(d, "inn");
			boolean committed = Files.isDirectory(d.resolve("versions/2"));
			JsonObject top = json(d.resolve("inn.blueprint.json"));
			// after repair: the top level is a complete head, the version it says it is
			assertEquals(committed ? 2 : 1, EntryVersions.version(top), step);
			assertArrayEquals(committed ? new byte[] {5, 5} : new byte[] {1, 2, 3}, Files.readAllBytes(d.resolve("inn.nbt")), step);
			assertTrue(top.get("favorite").getAsBoolean(), step);
			try (Stream<Path> s = Files.list(d.resolve("versions"))) {
				assertFalse(s.anyMatch(p -> p.getFileName().toString().startsWith(".tmp-")), "tmp folders deleted: " + step);
			}
			// a later install works
			assertNotNull(EntryVersions.install(d, "inn", version("inn", (byte) 6), "polish", null, "again", null, EntryVersions.Faults.NONE));
			Files.walk(tmp).sorted(java.util.Comparator.reverseOrder()).filter(p -> !p.equals(tmp)).forEach(p -> p.toFile().delete());
		}
	}
}
