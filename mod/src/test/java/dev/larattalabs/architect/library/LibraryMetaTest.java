package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** User metadata: in-place edits of a user entry's sidecar, and the overlay for bundled entries. */
class LibraryMetaTest {
	static final String SIDECAR = """
		{
		  "id": "gen_cabin",
		  "name": "Lakeside Cabin",
		  "type": "cabin",
		  "size": { "x": 11, "y": 9, "z": 13 },
		  "palette": { "preset": "rustic", "wood": "spruce", "stone": "cobblestone", "roof": "dark_oak", "accent": "dark_oak" },
		  "params": { "floors": { "type": "int", "min": 1, "max": 3, "default": 1, "label": "Floors" } },
		  "values": { "floors": 1 },
		  "variantOf": "gen_lake",
		  "someFutureKey": { "nested": [1, 2, 3] }
		}
		""";

	@Test
	void readsDefaultsWhenAbsent() {
		LibraryMeta m = LibraryMeta.read(JsonParser.parseString(SIDECAR).getAsJsonObject());
		assertFalse(m.favorite());
		assertEquals(List.of(), m.userTags());
		assertNull(m.displayName());
		assertTrue(m.isEmpty());
	}

	@Test
	void tagsAreTrimmedLowerCasedAndDeduplicated() {
		assertEquals(List.of("mine", "river_side", "big"), LibraryMeta.parseTags(" Mine, river  side,, MINE ;big"));
		assertEquals(List.of(), LibraryMeta.parseTags("  ,  "));
		LibraryMeta m = new LibraryMeta(false, List.of("a", "A ", " "), "  ");
		assertEquals(List.of("a"), m.userTags());
		assertNull(m.displayName(), "a blank name means none");
	}

	@Test
	void editInPlaceKeepsEveryOtherKeyAndIsAtomic(@TempDir Path dir) throws Exception {
		Path f = dir.resolve("gen_cabin.blueprint.json");
		Files.writeString(f, SIDECAR);
		LibraryMeta m = LibraryMeta.editInPlace(f, x -> x.withFavorite(true).withTags(List.of("Mine", "lake")).withDisplayName("Lakeside (birch)"));
		assertTrue(m.favorite());
		JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
		assertTrue(o.get("favorite").getAsBoolean());
		assertEquals("[\"mine\",\"lake\"]", o.get("userTags").toString());
		assertEquals("Lakeside (birch)", o.get("displayName").getAsString());
		// untouched: everything else, including keys the mod does not know
		JsonObject before = JsonParser.parseString(SIDECAR).getAsJsonObject();
		for (String k : before.keySet()) {
			assertEquals(before.get(k), o.get(k), k);
		}
		// no temp files left next to it
		try (Stream<Path> s = Files.list(dir)) {
			assertEquals(List.of(f.getFileName().toString()), s.map(p -> p.getFileName().toString()).toList());
		}
		// a blank name removes the key; the rest survives a second edit
		LibraryMeta.editInPlace(f, x -> x.withDisplayName(" "));
		o = JsonParser.parseString(Files.readString(f)).getAsJsonObject();
		assertFalse(o.has("displayName"));
		assertTrue(o.get("favorite").getAsBoolean());
		assertEquals(LibraryMeta.read(o), new LibraryMeta(true, List.of("mine", "lake"), null));
	}

	@Test
	void overlayRoundTrip(@TempDir Path dir) throws Exception {
		Path f = dir.resolve("architect").resolve("library-meta.json");
		LibraryMeta.Overlay ov = new LibraryMeta.Overlay(f).load();
		assertEquals(LibraryMeta.NONE, ov.get("cabin"));
		ov.edit("cabin", m -> m.withFavorite(true));
		ov.edit("tower", m -> m.withDisplayName("My tower").withTags(List.of("tall")));
		LibraryMeta.Overlay again = new LibraryMeta.Overlay(f).load();
		assertNull(again.loadError());
		assertTrue(again.get("cabin").favorite());
		assertEquals("My tower", again.get("tower").displayName());
		assertEquals(List.of("tall"), again.get("tower").userTags());
		// clearing an entry drops it from the file
		again.edit("cabin", m -> m.withFavorite(false));
		JsonObject root = JsonParser.parseString(Files.readString(f)).getAsJsonObject();
		assertFalse(root.getAsJsonObject("entries").has("cabin"));
		assertTrue(root.getAsJsonObject("entries").has("tower"));
		assertEquals(1, root.get("version").getAsInt());
	}

	@Test
	void brokenOverlayReadsEmptyWithAnError(@TempDir Path dir) throws Exception {
		Path f = dir.resolve("library-meta.json");
		Files.writeString(f, "{ not json");
		LibraryMeta.Overlay ov = new LibraryMeta.Overlay(f).load();
		assertNotNull(ov.loadError());
		assertEquals(LibraryMeta.NONE, ov.get("cabin"));
	}
}
