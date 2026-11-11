package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (6d AD, CONTRACT AD §2.3) {@code JournalStore.Txn.regroup}: a metadata-only index transaction. It sets {@code Meta.group} and (with a head
 * beside it) the head's membership; the entry's cells, sections, status, box and region files are untouched (no section file written),
 * it survives a reopen, and applying the same values again changes nothing.
 */
class JournalRegroupTest {
	@TempDir
	Path world;

	/** Every region (section) file of the journal, name -> bytes. */
	private Map<String, byte[]> regionFiles() throws Exception {
		Map<String, byte[]> out = new TreeMap<>();
		try (Stream<Path> st = Files.walk(JournalStore.dirOf(world))) {
			for (Path p : st.filter(Files::isRegularFile).toList()) {
				String n = p.getFileName().toString();
				if (n.matches("-?\\d+\\.-?\\d+\\.\\d+\\.nbt")) {
					out.put(JournalStore.dirOf(world).relativize(p).toString(), Files.readAllBytes(p));
				}
			}
		}
		return out;
	}

	@Test
	void regroupMovesTheGroupAndTheHeadOnly() throws Exception {
		JournalStore s = JournalStore.open(world);
		String a = s.newId();
		String b = s.newId();
		s.submit(s.begin().create(JournalStoreTest.header(a, s.newLayer()), JournalStore.bySection(JournalStoreTest.cells(5)), JournalStoreTest.head())).get();
		s.submit(s.begin().create(JournalStore.Meta.header(b, "delta", "s1", "g1", "minecraft:overworld", Journal.Policy.BOX, s.newLayer(), Journal.Status.ACTIVE,
			7L), JournalStore.bySection(JournalStoreTest.cells(9)), JournalNbt.Head.EMPTY)).get();
		JournalStore.Meta a0 = s.meta(a), b0 = s.meta(b);
		Map<String, byte[]> files0 = regionFiles();
		assertTrue(files0.size() >= 2);
		// the head's membership patched, its ring kept
		JournalNbt.Head h0 = s.head(a);
		JsonObject meta = h0.meta().deepCopy();
		JsonObject m = new JsonObject();
		m.addProperty("group", "g9");
		meta.add("member", m);
		s.submit(s.begin().label("ADOPT:rg1").regroup(a, "g9").head(a, new JournalNbt.Head(meta, h0.ring())).regroup(b, "g9")).get();
		JournalStore.Meta a1 = s.meta(a), b1 = s.meta(b);
		assertEquals("g9", a1.group());
		assertEquals("g9", b1.group());
		for (JournalStore.Meta[] p : new JournalStore.Meta[][] {{a0, a1}, {b0, b1}}) {
			assertEquals(p[0].cells(), p[1].cells());
			assertArrayEquals(p[0].sections(), p[1].sections());
			assertArrayEquals(p[0].box(), p[1].box());
			assertEquals(p[0].status(), p[1].status());
			assertEquals(p[0].layer(), p[1].layer());
			assertEquals(p[0].kind(), p[1].kind());
			assertEquals(p[0].site(), p[1].site());
		}
		// no region file written: the same names, generations and bytes
		Map<String, byte[]> files1 = regionFiles();
		assertEquals(files0.keySet(), files1.keySet());
		files0.forEach((k, v) -> assertArrayEquals(v, files1.get(k), k));
		// only the head got a new generation
		assertEquals(a0.files().get(JournalStore.HEAD) + 1, a1.files().get(JournalStore.HEAD));
		assertEquals(b0.files(), b1.files());
		s.close();
		// durable: a reopen reads the new groups and the patched head
		JournalStore r = JournalStore.open(world);
		assertEquals("g9", r.meta(a).group());
		assertEquals("g9", r.meta(b).group());
		assertEquals("g9", r.head(a).meta().getAsJsonObject("member").get("group").getAsString());
		assertArrayEquals(h0.ring(), r.head(a).ring());
		// idempotent: the same values again leave the groups and the region files as they are
		r.submit(r.begin().regroup(b, "g9")).get();
		assertEquals("g9", r.meta(b).group());
		assertEquals(files0.keySet(), regionFiles().keySet());
		// and back (an un-adopt): the old group again
		r.submit(r.begin().regroup(a, "g1").regroup(b, "g1")).get();
		assertEquals("g1", r.meta(a).group());
		assertEquals("g1", r.meta(b).group());
		assertThrows(IllegalArgumentException.class, () -> r.begin().regroup("nope", "g1"));
		r.close();
	}
}
