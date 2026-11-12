package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.SiteBinding;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.GhostModel;
import dev.larattalabs.architect.placement.TemplateGrid;
import dev.larattalabs.architect.placement.TerrainFit;
import dev.larattalabs.architect.region.volume.Arvx;
import dev.larattalabs.architect.survival.BuildOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.function.Function;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (7b slice SO) The support order over slice SV's five non-pad fit examples on their fixtures' land (the frozen volumes, each class as
 * {@code dev.pl.terrain} builds it): planConvert's own anchors and queue ({@link Builder#anchors}, {@link Builder#queueOrder}) give an
 * order whose every prefix is connected to the site (checked against the volume's classes, not Architect's predicate), with gravity
 * blocks after their support; and the builder's runtime gate ({@link Builder.Run#attached}) keeps every built set connected however the
 * crate's stock skips cells (random partial stock, many seeds), while the same steps without the gate leave a floating cell.
 */
class SupportOrderFixtureTest {
	static final List<String[]> EXAMPLES = List.of(new String[] {"fit_wrap_trunk", "trunk"}, new String[] {"fit_attach_to_cliff", "cliff_face"},
		new String[] {"fit_suspend", "overhang"}, new String[] {"fit_carve_into", "tunnel_hill"}, new String[] {"fit_span", "rift_site"});

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	/** The site classes a building may bear on (the kit's SITE_SOLID). */
	static boolean solidClass(int c) {
		String n = VoxelClass.values()[c].name();
		return n.equals("ROCK") || n.equals("SOIL") || n.equals("LOOSE") || n.equals("ICE") || n.equals("SNOW") || n.equals("LOG");
	}

	static BlockState blockOf(int c) {
		return switch (VoxelClass.values()[c].name()) {
			case "AIR" -> Blocks.AIR.defaultBlockState();
			case "ROCK" -> Blocks.STONE.defaultBlockState();
			case "SOIL" -> Blocks.DIRT.defaultBlockState();
			case "LOG" -> Blocks.OAK_LOG.defaultBlockState();
			case "LEAVES" -> Blocks.OAK_LEAVES.defaultBlockState();
			case "WATER" -> Blocks.WATER.defaultBlockState();
			case "PLANT" -> Blocks.SHORT_GRASS.defaultBlockState();
			default -> Blocks.STONE.defaultBlockState();
		};
	}

	/** One example on its site: the run (queue in support order, its record bound to the fit), the world, the classes. */
	record Case(String id, Builder.Run run, Function<BlockPos, BlockState> world, Arvx.Decoded volume, Set<Long> keep, int[] queue, Anchors.Bounds box) {
		boolean siteSolid(BlockPos p) {
			int[] b = volume.box();
			if (p.getX() < b[0] || p.getY() < b[1] || p.getZ() < b[2] || p.getX() > b[3] || p.getY() > b[4] || p.getZ() > b[5]) {
				return false;
			}
			return keep.contains(p.asLong()) || solidClass(volume.classAt(p.getX(), p.getY(), p.getZ()));
		}
	}

	static Case load(String id, String fixture) throws Exception {
		Path dir = Path.of("../kit/examples", id);
		JsonObject json = JsonParser.parseString(Files.readString(dir.resolve(id + ".blueprint.json"))).getAsJsonObject();
		Blueprint bp = Blueprint.fromJson(json);
		SiteSpec spec = SiteSpec.fromWire(json.getAsJsonObject("site"));
		BuildOrderGoldenTest.Probe p0 = BuildOrderGoldenTest.probe(bp, BuildOrderGoldenTest.template(dir.resolve(id + ".nbt")));
		// re-home the probe at the site's frame (rotation none in every fixture)
		BlockPos o = spec.frame().origin();
		Anchors.Bounds box = new Anchors.Bounds(o.getX(), o.getY(), o.getZ(), o.getX() + p0.box().maxX() - p0.box().minX(), o.getY() + p0.box().maxY()
			- p0.box().minY(), o.getZ() + p0.box().maxZ() - p0.box().minZ());
		byte[] gz = Files.readAllBytes(Path.of("../kit/test/fixtures/site", fixture, "volume.bin"));
		Arvx.Decoded vol = Arvx.decode(Arvx.gunzip(gz));
		TemplateGrid g = TemplateGrid.read(bp, BuildOrderGoldenTest.template(dir.resolve(id + ".nbt")));
		GhostModel m = g.ghost(0);
		byte[] writes = TerrainFit.writes(m);
		Map<Long, Journal.Value> values = new HashMap<>();
		List<Integer> idx = new ArrayList<>();
		int dx = m.sizeX;
		int dz = m.sizeZ;
		Map<Long, BlockState> placed = new HashMap<>();
		for (int i = 0; i < m.count(); i++) {
			BlockState st = g.states()[i];
			if (st.isAir()) {
				continue;
			}
			BlockPos p = new BlockPos(box.minX() + m.x(i), box.minY() + m.y(i), box.minZ() + m.z(i));
			values.put(p.asLong(), WorldJournal.value(st));
			placed.put(p.asLong(), st);
			idx.add(dev.larattalabs.architect.site.Construction.index(m.x(i), m.y(i), m.z(i), dx, dz));
		}
		Cells c = Cells.fromValues(box, values);
		int[] boxIdx = idx.stream().mapToInt(Integer::intValue).toArray();
		Set<Long> keep = new HashSet<>();
		spec.keepCritical().forEach(k -> keep.add(k.asLong()));
		// the world after the instant placement: the template's cells (blocks, and the air it writes) over the frozen land
		Function<BlockPos, BlockState> instant = q -> {
			BlockState t = placed.get(q.asLong());
			if (t != null) {
				return t;
			}
			int x = q.getX() - box.minX();
			int y = q.getY() - box.minY();
			int z = q.getZ() - box.minZ();
			if (x >= 0 && y >= 0 && z >= 0 && x < m.sizeX && y < m.sizeY && z < m.sizeZ && writes[(y * m.sizeZ + z) * m.sizeX + x] != 0) {
				return Blocks.AIR.defaultBlockState();
			}
			int[] b = vol.box();
			if (q.getX() < b[0] || q.getY() < b[1] || q.getZ() < b[2] || q.getX() > b[3] || q.getY() > b[4] || q.getZ() > b[5]) {
				return Blocks.AIR.defaultBlockState();
			}
			return blockOf(vol.classAt(q.getX(), q.getY(), q.getZ()));
		};
		Site probe = new Site("probe", bp.id(), "none", box, box, Map.of(), 0L, Site.OVERWORLD, box, "none", null, null,
			new Construction(Construction.BUILDING, boxIdx, Builder.JOURNAL_TARGET, null, new BitSet(), false, null));
		Builder.Run pr = new Builder.Run(probe, c);
		boolean[] anchor = Builder.anchors(instant, pr, box, m.sizeX, m.sizeY, m.sizeZ, writes, keep);
		int[] queue = Builder.queueOrder(pr, boxIdx, anchor);
		// the construction site's run: its queue in that order, its record bound to the fit (as SitesImpl writes the ext)
		JsonObject ext = new JsonObject();
		ext.add(SiteBinding.EXT_KEY, SiteBinding.of(spec, null).wire());
		Site site = new Site("s1", bp.id(), "none", box, box, Map.of(), 0L, Site.OVERWORLD, box, "none", null, null,
			new Construction(Construction.BUILDING, queue, Builder.JOURNAL_TARGET, null, new BitSet(), false, null), null, ext, null, false);
		Builder.Run run = new Builder.Run(site, c);
		// the world of the construction site: the queued cells cleared (air), the rest as after the instant placement
		Set<Long> queuedPos = new HashSet<>();
		for (int i = 0; i < run.size(); i++) {
			queuedPos.add(run.pos(i).asLong());
		}
		Function<BlockPos, BlockState> cleared = q -> queuedPos.contains(q.asLong()) ? Blocks.AIR.defaultBlockState() : instant.apply(q);
		return new Case(id, run, cleared, vol, keep, queue, box);
	}

	/** Whether cell {@code i} (queue position) touches the site's solid (by the volume's classes) or a built cell. */
	static boolean connected(Case k, int i, BitSet built) {
		BlockPos p = k.run().pos(i);
		for (Direction d : Direction.values()) {
			BlockPos q = p.relative(d);
			int j = k.run().queuePos(q);
			if (j >= 0 ? built.get(j) : k.siteSolid(q)) {
				return true;
			}
		}
		return false;
	}

	@Test
	void everyPrefixOfTheQueueIsConnectedToTheSite() throws Exception {
		for (String[] e : EXAMPLES) {
			Case k = load(e[0], e[1]);
			Builder.Run r = k.run();
			assertTrue(r.bySupport, e[0] + ": the run reads its fit from the record's binding");
			BitSet built = new BitSet();

			for (int i = 0; i < r.size(); i++) {
				assertTrue(connected(k, i, built), e[0] + ": queue cell " + i + " (" + r.pos(i).toShortString() + " " + r.target[i] + ") is connected when it comes");
				if (r.below[i] >= 0) {

					assertTrue(built.get(r.below[i]), e[0] + ": a gravity block after the cell under it");
				}
				if (r.support[i] >= 0 && !r.isSecond[i]) {
					assertTrue(built.get(r.support[i]), e[0] + ": an attachable after its support");
				}
				built.set(i);
			}
		}
	}

	@Test
	void theBottomUpOrderWouldFloat() throws Exception {
		// fit_suspend bottom-up: its floor comes first, under nothing it touches (why the support order exists; fit_span's bottom row
		// bears on both rims, so bottom-up happens to hold there)
		for (String id : List.of("fit_suspend")) {
			String fixture = "overhang";
			Case k = load(id, fixture);
			Builder.Run r = k.run();
			int[] y = new int[r.size()];
			int[] kind = new int[r.size()];
			int[] pair = new int[r.size()];
			for (int i = 0; i < r.size(); i++) {
				y[i] = r.pos(i).getY();
				kind[i] = Builder.kind(r.target[i]);
				pair[i] = r.isSecond[i] ? r.pairFirst(i) : -1;
			}
			int[] old = BuildOrder.order(y, kind, r.support, pair);
			BitSet built = new BitSet();
			int floating = 0;
			for (int i : old) {
				if (!connected(k, i, built)) {
					floating++;
				}
				built.set(i);
			}
			assertTrue(floating > 0, id + ": today's bottom-up order places floating cells (" + floating + ")");
		}
	}

	/**
	 * The builder's step over random partial stock: per tick, cells scanned in queue order, a cell placed when its "item" (its block)
	 * is in stock (each block id in stock with probability 1/2 per tick) and, with the gate, when {@link Builder.Run#attached}. Every
	 * placement with the gate is connected; without it some are not.
	 */
	@Test
	void theRuntimeGateKeepsEveryBuiltSetConnected() throws Exception {
		int ungatedFloating = 0;
		for (String[] e : EXAMPLES) {
			Case k = load(e[0], e[1]);
			Builder.Run r = k.run();
			java.util.TreeSet<String> items = new java.util.TreeSet<>();
			for (int i = 0; i < r.size(); i++) {
				items.add(BuiltInRegistries.BLOCK.getKey(r.target[i].getBlock()).toString());
			}
			for (int seed = 0; seed < 12; seed++) {
				for (boolean gate : new boolean[] {true, false}) {
					Random rnd = new Random(seed * 31L + e[0].hashCode());
					BitSet built = new BitSet();
					Map<Long, BlockState> world = new HashMap<>();
					Function<BlockPos, BlockState> w = q -> world.containsKey(q.asLong()) ? world.get(q.asLong()) : k.world().apply(q);
					int floating = 0;
					for (int tick = 0; tick < 20_000 && built.cardinality() < r.size(); tick++) {
						Set<String> stock = new HashSet<>();
						for (String item : items) {
							if (rnd.nextBoolean()) {
								stock.add(item); // one coin per item kind per tick
							}
						}
						int budget = 4;
						for (int i = built.nextClearBit(0); i < r.size() && budget > 0; i = built.nextClearBit(i + 1)) {
							if (r.isSecond[i]) {
								continue;
							}
							String item = BuiltInRegistries.BLOCK.getKey(r.target[i].getBlock()).toString();
							if (gate && !r.attached(w, i)) {
								continue;
							}
							if (!stock.contains(item) || r.support[i] >= 0 && !built.get(r.support[i])) {
								continue;
							}
							if (!connected(k, i, built)) {
								floating++;
							}
							built.set(i);
							r.built.set(i);
							world.put(r.pos(i).asLong(), r.target[i]);
							if (r.second[i] >= 0) {
								built.set(r.second[i]);
								r.built.set(r.second[i]);
								world.put(r.pos(r.second[i]).asLong(), r.target[r.second[i]]);
							}
							budget--;
						}
					}
					r.built.clear();
					assertEquals(r.size(), built.cardinality(), e[0] + " seed " + seed + (gate ? " gated" : "") + ": every cell built");
					if (gate) {
						assertEquals(0, floating, e[0] + " seed " + seed + ": every placement connected with the gate");
					} else {
						ungatedFloating += floating;
					}
				}
			}
		}
		assertTrue(ungatedFloating > 0, "without the gate some placement floats (the test bites): " + ungatedFloating);
	}
}
