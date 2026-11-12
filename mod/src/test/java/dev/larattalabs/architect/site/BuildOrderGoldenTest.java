package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.GhostModel;
import dev.larattalabs.architect.placement.TemplateGrid;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Stream;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (7b slice SO) The build-order golden: for every {@code on_pad} kit example (every example and massing without a site, and
 * {@code fit_on_pad}), the construction queue {@link Builder#queueOrder} gives over its template cells is the one main (b1ee8dcc,
 * before SO) gave, as a sha256 of the queue per design (recorded in {@code so-buildorder-golden.json}; {@code ARCHITECT_WRITE_GOLDEN=1}
 * re-records). Template cells only: an {@code on_pad} placement's fill and approach cells depend on the world (PL's in-game on_pad
 * byte identity covers the whole placement).
 */
class BuildOrderGoldenTest {
	static final Path GOLDEN = Path.of("src/test/resources/so-buildorder-golden.json");

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	/** An example's template as a probe construction run at (1000, 64, -500): the cells and the run planConvert builds over them. */
	record Probe(Builder.Run run, int[] boxIdx, Anchors.Bounds box, List<BlockPos> cells, List<BlockState> states) {
	}

	static Probe probe(Blueprint bp, StructureTemplate t) {
		TemplateGrid g = TemplateGrid.read(bp, t);
		GhostModel m = g.ghost(0);
		var size = t.getSize();
		Anchors.Bounds box = new Anchors.Bounds(1000, 64, -500, 1000 + size.getX() - 1, 64 + size.getY() - 1, -500 + size.getZ() - 1);
		int dx = size.getX();
		int dz = size.getZ();
		Map<Long, Journal.Value> values = new HashMap<>();
		List<BlockPos> cells = new ArrayList<>();
		List<BlockState> states = new ArrayList<>();
		BlockState[] ts = g.states();
		for (int i = 0; i < m.count(); i++) {
			if (ts[i].isAir()) {
				continue;
			}
			BlockPos p = new BlockPos(box.minX() + m.x(i), box.minY() + m.y(i), box.minZ() + m.z(i));
			values.put(p.asLong(), WorldJournal.value(ts[i]));
			cells.add(p);
			states.add(ts[i]);
		}
		Cells c = Cells.fromValues(box, values);
		List<Integer> idx = new ArrayList<>();
		for (BlockPos p : cells) {
			int k = dev.larattalabs.architect.site.Construction.index(p.getX() - box.minX(), p.getY() - box.minY(), p.getZ() - box.minZ(), dx, dz);
			if (!c.states[k].isAir()) {
				idx.add(k);
			}
		}
		int[] boxIdx = idx.stream().mapToInt(Integer::intValue).toArray();
		Site probe = new Site("probe", bp.id(), "none", box, box, Map.of(), 0L, Site.OVERWORLD, box, "none", null, null,
			new Construction(Construction.BUILDING, boxIdx, Builder.JOURNAL_TARGET, null, new BitSet(), false, null));
		return new Probe(new Builder.Run(probe, c), boxIdx, box, cells, states);
	}

	static StructureTemplate template(Path nbt) throws IOException {
		CompoundTag tag = NbtIo.readCompressed(nbt, NbtAccounter.unlimitedHeap());
		StructureTemplate t = new StructureTemplate();
		t.load(BuiltInRegistries.BLOCK, tag);
		return t;
	}

	/** Every kit example and massing that places on a pad (no site, or an on_pad site): id -> [blueprint json, nbt]. */
	static TreeMap<String, Path[]> onPadExamples() throws IOException {
		TreeMap<String, Path[]> out = new TreeMap<>();
		for (String dir : List.of("../kit/examples", "../kit/massings")) {
			try (Stream<Path> s = Files.walk(Path.of(dir))) {
				for (Path p : s.filter(f -> f.getFileName().toString().endsWith(".blueprint.json")).sorted().toList()) {
					JsonObject json = JsonParser.parseString(Files.readString(p)).getAsJsonObject();
					if (json.has("fit") && !"on_pad".equals(json.get("fit").getAsString())) {
						continue;
					}
					String id = p.getFileName().toString().replace(".blueprint.json", "");
					Path nbt = p.resolveSibling(id + ".nbt");
					if (Files.exists(nbt)) {
						out.put(id, new Path[] {p, nbt});
					}
				}
			}
		}
		return out;
	}

	static String sha(int[] q) throws Exception {
		StringBuilder sb = new StringBuilder();
		for (int v : q) {
			sb.append(v).append(',');
		}
		byte[] d = MessageDigest.getInstance("SHA-256").digest(sb.toString().getBytes(StandardCharsets.UTF_8));
		StringBuilder hex = new StringBuilder();
		for (byte b : d) {
			hex.append(String.format("%02x", b));
		}
		return hex.toString();
	}

	@Test
	void onPadQueuesEqualMainsOrder() throws Exception {
		TreeMap<String, Path[]> ex = onPadExamples();
		assertTrue(ex.containsKey("cabin") && ex.containsKey("fit_on_pad") && ex.containsKey("tower_massing"), "the on_pad examples found: " + ex.keySet());
		Set<String> nonPad = new HashSet<>(List.of("fit_attach_to_cliff", "fit_carve_into", "fit_span", "fit_suspend", "fit_wrap_trunk"));
		assertTrue(ex.keySet().stream().noneMatch(nonPad::contains), "no non-pad example in the golden");
		TreeMap<String, String> now = new TreeMap<>();
		for (var e : ex.entrySet()) {
			Blueprint bp = Blueprint.fromJson(JsonParser.parseString(Files.readString(e.getValue()[0])).getAsJsonObject());
			Probe p = probe(bp, template(e.getValue()[1]));
			int[] q = Builder.queueOrder(p.run(), p.boxIdx(), null);
			assertEquals(p.boxIdx().length, q.length, e.getKey());
			now.put(e.getKey(), q.length + ":" + sha(q));
		}
		Gson gson = new GsonBuilder().setPrettyPrinting().create();
		if (System.getenv("ARCHITECT_WRITE_GOLDEN") != null) {
			Files.writeString(GOLDEN, gson.toJson(now) + "\n");
		}
		@SuppressWarnings("unchecked")
		Map<String, String> golden = gson.fromJson(Files.readString(GOLDEN), TreeMap.class);
		assertEquals(golden, now, "every on_pad example's queue equals main's (b1ee8dcc) byte for byte");
	}
}
