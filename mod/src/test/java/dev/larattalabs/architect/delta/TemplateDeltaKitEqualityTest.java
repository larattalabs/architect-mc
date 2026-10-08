package dev.larattalabs.architect.delta;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The kit's {@code kit/tools/diff.mjs} and the mod's {@link TemplateDelta} give the same cell sets, part statuses, counts and
 * boxes, frame check, approximate flag and frame hint on every fixture pair (docs/CONTRACT.md phase 5b "Two implementations,
 * pinned equal"): the gate's hand-written tavern versions and every kit example against its param and palette variants, made
 * by {@code node kit/tools/delta-fixtures.mjs}. Needs node and the kit: under CI their absence fails the test; locally it skips.
 */
class TemplateDeltaKitEqualityTest {
	@TempDir
	Path tmp;

	static Path kitDir() {
		Path p = Path.of("").toAbsolutePath();
		for (int i = 0; i < 4 && p != null; i++, p = p.getParent()) {
			if (Files.isRegularFile(p.resolve("kit/tools/delta-fixtures.mjs"))) {
				return p;
			}
		}
		return null;
	}

	@Test
	void kitDiffEqualsTemplateDelta() throws Exception {
		boolean ci = System.getenv("CI") != null;
		Path root = kitDir();
		if (root == null) {
			if (ci) {
				fail("the kit (kit/tools/delta-fixtures.mjs) is missing under CI");
			}
			Assumptions.abort("no kit checkout");
		}
		Process p;
		try {
			p = new ProcessBuilder("node", root.resolve("kit/tools/delta-fixtures.mjs").toString(), "--out", tmp.toString(), "--no-previews").directory(root
				.toFile()).redirectErrorStream(true).start();
		} catch (java.io.IOException e) {
			if (ci) {
				fail("node is missing under CI: " + e.getMessage());
			}
			Assumptions.abort("no node: " + e.getMessage());
			return;
		}
		String log = new String(p.getInputStream().readAllBytes());
		assertTrue(p.waitFor(180, TimeUnit.SECONDS), "delta-fixtures timed out");
		assertEquals(0, p.exitValue(), log);
		JsonObject index = JsonParser.parseString(Files.readString(tmp.resolve("index.json"))).getAsJsonObject();
		JsonArray pairs = index.getAsJsonArray("pairs");
		assertTrue(pairs.size() >= 20, "pairs " + pairs.size());
		int cells = 0;
		for (JsonElement e : pairs) {
			String name = e.getAsJsonObject().get("name").getAsString();
			Path d = tmp.resolve("pairs").resolve(name);
			JsonObject exp = JsonParser.parseString(Files.readString(d.resolve("expected.json"))).getAsJsonObject();
			TemplateDelta.Result r = TemplateDelta.delta(version(d, "a"), version(d, "b"));
			assertEquals(exp.get("frameKept").getAsBoolean(), r.frameKept(), name + ": frameKept");
			assertEquals(exp.get("approximate").getAsBoolean(), r.approximate(), name + ": approximate");
			JsonObject c = exp.getAsJsonObject("cells");
			assertEquals(list(c.getAsJsonArray("added")), unpack(r.added()), name + ": added");
			assertEquals(list(c.getAsJsonArray("removed")), unpack(r.removed()), name + ": removed");
			assertEquals(list(c.getAsJsonArray("changed")), unpack(r.changed()), name + ": changed");
			assertEquals(exp.get("unchanged").getAsInt(), r.unchanged(), name + ": unchanged");
			cells += r.added().size() + r.removed().size() + r.changed().size();
			JsonObject parts = exp.getAsJsonObject("parts");
			assertEquals(parts.keySet(), r.parts().keySet(), name + ": part names");
			for (Map.Entry<String, JsonElement> pe : parts.entrySet()) {
				JsonObject ep = pe.getValue().getAsJsonObject();
				TemplateDelta.Part rp = r.parts().get(pe.getKey());
				String w = name + ": part " + pe.getKey();
				assertEquals(ep.get("status").getAsString(), rp.status().name(), w);
				assertEquals(ep.get("added").getAsInt(), rp.added(), w + " added");
				assertEquals(ep.get("removed").getAsInt(), rp.removed(), w + " removed");
				assertEquals(ep.get("changed").getAsInt(), rp.changed(), w + " changed");
				assertEquals(box(ep.get("boxFrom")), TemplateDelta.box(rp.boxFrom()), w + " boxFrom");
				assertEquals(box(ep.get("boxTo")), TemplateDelta.box(rp.boxTo()), w + " boxTo");
			}
			String hint = exp.has("frameHint") ? box(exp.get("frameHint")) : "null";
			assertEquals(hint, TemplateDelta.box(r.frameHint()), name + ": frameHint");
		}
		assertTrue(cells > 1000, "cells compared " + cells);
	}

	static TemplateDelta.Version version(Path d, String side) throws Exception {
		CompoundTag nbt = NbtIo.readCompressed(d.resolve(side + ".nbt"), NbtAccounter.unlimitedHeap());
		Path pf = d.resolve(side + ".parts.nbt");
		CompoundTag parts = Files.isRegularFile(pf) ? NbtIo.readCompressed(pf, NbtAccounter.unlimitedHeap()) : null;
		Path jf = d.resolve(side + ".blueprint.json");
		JsonObject json = Files.isRegularFile(jf) ? JsonParser.parseString(Files.readString(jf)).getAsJsonObject() : null;
		return new TemplateDelta.Version(nbt, parts, json);
	}

	static List<String> list(JsonArray a) {
		List<String> out = new ArrayList<>();
		for (JsonElement e : a) {
			JsonArray c = e.getAsJsonArray();
			out.add(c.get(0).getAsInt() + "," + c.get(1).getAsInt() + "," + c.get(2).getAsInt());
		}
		return out;
	}

	static List<String> unpack(List<Long> l) {
		List<String> out = new ArrayList<>();
		for (int[] c : TemplateDelta.unpack(l)) {
			out.add(c[0] + "," + c[1] + "," + c[2]);
		}
		return out;
	}

	static String box(JsonElement e) {
		if (e == null || e.isJsonNull()) {
			return "null";
		}
		JsonArray a = e.getAsJsonArray();
		int[] b = new int[a.size()];
		for (int i = 0; i < b.length; i++) {
			b[i] = a.get(i).getAsInt();
		}
		return java.util.Arrays.toString(b);
	}
}
