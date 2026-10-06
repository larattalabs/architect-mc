package dev.larattalabs.architect.journal;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.site.Construction;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.SiteGroupRec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.IntArrayTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtIo;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * Test only: writes a synthetic 0.7.0 world (the files 0.7.0 leaves in a world folder: {@code architect-sites.json} through
 * {@link V070SiteFile}, {@code architect-sites/<snapshot>.nbt} and construction targets as gzip structure templates,
 * {@code architect-queue.json}), and is the {@link JournalMigration.MigrationWorld} the import reads held leaves from (a map
 * of block states; everything else is air). The snapshot and target values are kept as the source maps, so a test compares
 * the journal against what was written, never against a re-parse of it.
 */
final class V070World implements JournalMigration.MigrationWorld {
	static final String DIM = Site.OVERWORLD;
	static final String STANDING = "standing";
	static final String PENDING = "pending";
	static final String PLACING = "placing";

	private static boolean booted;

	/** Vanilla's registries (block states, leaves), once per JVM, as the server has them. */
	static synchronized void boot() {
		if (!booted) {
			SharedConstants.tryDetectVersion();
			Bootstrap.bootStrap();
			booted = true;
		}
	}

	final Path dir;
	final Map<Long, BlockState> blocks = new HashMap<>();
	final Set<String> dimensions = new HashSet<>(Set.of(DIM));
	final List<SiteSpec> specs = new ArrayList<>();
	final List<SiteGroupRec> groups = new ArrayList<>();
	final List<String> placingJobs = new ArrayList<>();
	final Map<String, byte[]> extraFiles = new LinkedHashMap<>();
	int nextGroup = 1;

	V070World(Path dir) {
		boot();
		this.dir = dir;
	}

	// ------------------------------------------------------------------ MigrationWorld

	@Override
	public @Nullable BlockState read(String dimension, BlockPos pos) {
		return dimensions.contains(dimension) ? blocks.getOrDefault(pos.asLong(), Blocks.AIR.defaultBlockState()) : null;
	}

	@Override
	public boolean hasDimension(String dimension) {
		return dimensions.contains(dimension);
	}

	// ------------------------------------------------------------------ values

	static final Value[] TERRAIN = {Value.of("minecraft:stone"), Value.of("minecraft:dirt"), Value.of("minecraft:grass_block", "snowy", "false"),
		Journal.AIR, Value.of("minecraft:oak_log", "axis", "y"), Value.of("minecraft:gravel")};
	static final Value[] BUILDING = {Value.of("minecraft:oak_planks"), Value.of("minecraft:cobblestone"), Journal.AIR,
		Value.of("minecraft:glass_pane", "east", "false", "north", "true", "south", "true", "waterlogged", "false", "west", "false"),
		Value.of("minecraft:spruce_stairs", "facing", "north", "half", "bottom", "shape", "straight", "waterlogged", "false")};

	/** A chest with block entity data (one item when {@code full}), as a structure template keeps it. */
	static Value chest(boolean full) {
		CompoundTag nbt = new CompoundTag();
		nbt.putString("id", "minecraft:chest");
		ListTag items = new ListTag();
		if (full) {
			CompoundTag it = new CompoundTag();
			it.putString("id", "minecraft:bread");
			it.putInt("count", 3);
			it.putByte("Slot", (byte) 4);
			items.add(it);
		}
		nbt.put("Items", items);
		return Value.of("minecraft:chest", "facing", "south", "type", "single", "waterlogged", "false").withNbt(nbt);
	}

	/** The natural leaf a held leaf was ({@code distance} as recorded), as the import computes it from the leaf it reads. */
	static BlockState leaf(boolean persistent, int distance) {
		return Blocks.OAK_LEAVES.defaultBlockState().setValue(LeavesBlock.PERSISTENT, persistent).setValue(LeavesBlock.DISTANCE, distance);
	}

	// ------------------------------------------------------------------ sites

	/** One 0.7.0 site record and its files. */
	static final class SiteSpec {
		final String id;
		final Anchors.Bounds box;
		final Anchors.Bounds snapBox;
		long placedAt;
		String state = STANDING;
		long at;
		final LinkedHashMap<Long, Value> snapshot;
		@Nullable LinkedHashMap<Long, Value> target;
		int @Nullable [] queue;
		Construction.@Nullable Crate crate;
		boolean building = true;
		final List<Integer> held = new ArrayList<>();
		int[] ring = new int[0];
		@Nullable String group;
		@Nullable String batchId;
		@Nullable String itemKey;
		boolean placingFlag;
		boolean unreadable;
		String snapshotFile;
		@Nullable String targetFile;
		String dimension = DIM;

		SiteSpec(String id, Anchors.Bounds box, Anchors.Bounds snapBox, long placedAt, LinkedHashMap<Long, Value> snapshot) {
			this.id = id;
			this.box = box;
			this.snapBox = snapBox;
			this.placedAt = placedAt;
			this.snapshot = snapshot;
			this.snapshotFile = id + "-" + placedAt + ".nbt";
		}

		Site site() {
			Construction c = null;
			if (target != null) {
				c = new Construction(building ? Construction.BUILDING : Construction.BUILT, queue, targetFile, crate, new BitSet(), false,
					"45ec2bed-0a65-3047-9f6e-8e67d21b1b92");
			}
			Site.Member m = group == null ? null : new Site.Member(group, batchId, itemKey);
			Site.Pin pin = new Site.Pin("fp-" + id, List.of(1, 1, 1), held);
			return new Site(id, "cabin", "none", box, box, Map.of(), placedAt, dimension, snapBox, snapshotFile, null, pin, c, null, new JsonObject(), m,
				placingFlag);
		}

		/** The restore box's index of a world position (x fastest, then z, then y), as 0.7.0's queue holds it. */
		int index(long pos) {
			return Construction.index(Journal.x(pos) - snapBox.minX(), Journal.y(pos) - snapBox.minY(), Journal.z(pos) - snapBox.minZ(),
				snapBox.maxX() - snapBox.minX() + 1, snapBox.maxZ() - snapBox.minZ() + 1);
		}
	}

	/** Every position of {@code b}, y then z then x (the order a structure template saves). */
	static List<Long> cells(Anchors.Bounds b) {
		List<Long> out = new ArrayList<>();
		for (int y = b.minY(); y <= b.maxY(); y++) {
			for (int z = b.minZ(); z <= b.maxZ(); z++) {
				for (int x = b.minX(); x <= b.maxX(); x++) {
					out.add(Journal.pos(x, y, z));
				}
			}
		}
		return out;
	}

	/**
	 * A standing instant site: its template box {@code sx x sy x sz} at {@code (x, y, z)}, its restore box one row deeper and two
	 * cells longer towards +z (foundation and approach, so the restore box's corner is not the template box's), a random
	 * terrain snapshot with a chest now and then.
	 */
	SiteSpec site(String id, int x, int y, int z, int sx, int sy, int sz, long placedAt, Random r) {
		Anchors.Bounds box = new Anchors.Bounds(x, y, z, x + sx - 1, y + sy - 1, z + sz - 1);
		Anchors.Bounds snap = new Anchors.Bounds(x, y - 1, z, x + sx - 1, y + sy - 1, z + sz + 1);
		LinkedHashMap<Long, Value> snapshot = new LinkedHashMap<>();
		for (long p : cells(snap)) {
			snapshot.put(p, r.nextInt(23) == 0 ? chest(r.nextBoolean()) : TERRAIN[r.nextInt(TERRAIN.length)]);
		}
		SiteSpec s = new SiteSpec(id, box, snap, placedAt, snapshot);
		specs.add(s);
		return s;
	}

	/** Makes {@code s} a construction site: a random building as its target, the non-air target cells queued. */
	void construction(SiteSpec s, Random r, Construction.@Nullable Crate crate) {
		LinkedHashMap<Long, Value> t = new LinkedHashMap<>();
		List<Integer> q = new ArrayList<>();
		for (long p : cells(s.snapBox)) {
			Value v = r.nextInt(31) == 0 ? chest(false) : BUILDING[r.nextInt(BUILDING.length)];
			t.put(p, v);
			if (!v.equals(Journal.AIR)) {
				q.add(s.index(p));
			}
		}
		s.target = t;
		s.queue = q.stream().mapToInt(Integer::intValue).toArray();
		s.targetFile = s.id + "-" + (s.placedAt + 7) + "-target.nbt";
		s.crate = crate;
	}

	/** A crate cell whose snapshot is a leaf litter (state as SNBT, as 0.7.0 records it). */
	static Construction.Crate crate(int x, int y, int z) {
		return new Construction.Crate(x, y, z, Value.of("minecraft:leaf_litter", "facing", "south", "segment_amount", "3").state().toString(), null);
	}

	/** A held leaf of {@code s}: recorded with {@code distance}; the world holds {@code now} there. */
	void hold(SiteSpec s, int x, int y, int z, int distance, BlockState now) {
		s.held.add(x);
		s.held.add(y);
		s.held.add(z);
		s.held.add(distance);
		blocks.put(Journal.pos(x, y, z), now);
	}

	/** A site group (4d): its sites, one stage per site, an optional shared crate. */
	SiteGroupRec group(String id, List<SiteSpec> members, Construction.@Nullable Crate shared) {
		List<SiteGroupRec.StageRec> stages = new ArrayList<>();
		List<String> ids = new ArrayList<>();
		int n = 1;
		for (SiteSpec s : members) {
			s.group = id;
			s.batchId = "b" + id;
			s.itemKey = "K" + n;
			ids.add(s.id);
			stages.add(new SiteGroupRec.StageRec("s" + n, List.of("K" + n), dev.larattalabs.architect.api.Stage.State.PLACED, List.of(s.id), "b" + id));
			n++;
		}
		JsonObject ext = new JsonObject();
		ext.addProperty("steward_mc:village", "V1");
		SiteGroupRec g = new SiteGroupRec(id, "steward_mc:planner", ext, ids, stages, SiteGroupRec.ACTIVE, shared != null, shared,
			shared == null ? null : new int[] {shared.x(), shared.y(), shared.z()}, 1_000L);
		groups.add(g);
		nextGroup = Math.max(nextGroup, Site.number(id, 'g') + 1);
		return g;
	}

	// ------------------------------------------------------------------ files

	Path sitesFile() {
		return dir.resolve(JournalMigration.SITES_FILE);
	}

	Path snapDir() {
		return dir.resolve(JournalMigration.SNAPSHOT_DIR);
	}

	Path legacyDir() {
		return JournalStore.dirOf(dir).resolve(JournalMigration.LEGACY_DIR).resolve(JournalMigration.SNAPSHOT_DIR);
	}

	/** Writes a structure template (gzip NBT) of {@code values} over {@code b}, with the 4d leaf ring when given. */
	static void writeTemplate(Path f, Map<Long, Value> values, Anchors.Bounds b, int[] ring) throws IOException {
		CompoundTag t = JournalNbt.toTemplate(values, b.minX(), b.minY(), b.minZ(), b.maxX() - b.minX() + 1, b.maxY() - b.minY() + 1,
			b.maxZ() - b.minZ() + 1, 0);
		if (ring.length > 0) {
			t.put(JournalMigration.RING, new IntArrayTag(ring));
		}
		Files.createDirectories(f.getParent());
		NbtIo.writeCompressed(t, f);
	}

	/** The sites file 0.7.0 would write for these records. */
	JsonObject sitesJson() {
		List<Site> sites = new ArrayList<>();
		List<Site.Pending> pending = new ArrayList<>();
		int next = 1;
		for (SiteSpec s : specs) {
			if (PENDING.equals(s.state)) {
				pending.add(new Site.Pending(s.site(), s.at, "removed"));
			} else {
				sites.add(s.site());
			}
			next = Math.max(next, Site.idNumber(s.id) + 1);
		}
		return V070SiteFile.fileJson(sites, next, pending, groups, nextGroup);
	}

	/** Writes every file 0.7.0 would have left. */
	V070World write() throws IOException {
		Files.createDirectories(snapDir());
		for (SiteSpec s : specs) {
			Path f = snapDir().resolve(s.snapshotFile);
			if (s.unreadable) {
				Files.write(f, "not a gzip structure template".getBytes(StandardCharsets.UTF_8));
			} else {
				writeTemplate(f, s.snapshot, s.snapBox, s.ring);
			}
			if (s.target != null) {
				writeTemplate(snapDir().resolve(s.targetFile), s.target, s.snapBox, new int[0]);
			}
		}
		for (var e : extraFiles.entrySet()) {
			Files.write(snapDir().resolve(e.getKey()), e.getValue());
		}
		writeJson(sitesFile(), sitesJson());
		if (!placingJobs.isEmpty()) {
			JsonObject q = new JsonObject();
			q.addProperty("version", 1);
			q.addProperty("clean", true);
			q.add("batches", new JsonArray());
			q.addProperty("nextBatch", 1);
			JsonArray jobs = new JsonArray();
			for (String id : placingJobs) {
				JsonObject j = new JsonObject();
				j.addProperty("kind", "place");
				j.addProperty("siteId", id);
				j.addProperty("dimension", DIM);
				j.addProperty("blueprint", "cabin");
				j.addProperty("cursor", 117);
				jobs.add(j);
			}
			q.add("jobs", jobs);
			q.add("removals", new JsonArray());
			writeJson(dir.resolve("architect-queue.json"), q);
		}
		return this;
	}

	static void writeJson(Path f, JsonObject o) throws IOException {
		Files.writeString(f, new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create().toJson(o), StandardCharsets.UTF_8);
	}

	// ------------------------------------------------------------------ the journal, normalized

	/** An entry's whole content as text, without its id and file names (which a re-run after a fault may shift). */
	static String describe(JournalStore s, JournalStore.Meta m) throws IOException {
		Journal.Entry e = s.load(m.id());
		JournalNbt.Head h = s.head(m.id());
		StringBuilder b = new StringBuilder();
		b.append(m.kind()).append(' ').append(m.site()).append(" group=").append(m.group()).append(' ').append(m.dimension()).append(' ')
			.append(m.policy()).append(" layer=").append(m.layer()).append(' ').append(m.status()).append(" at=").append(m.createdAt())
			.append(" cells=").append(m.cells()).append(" box=").append(java.util.Arrays.toString(m.box())).append(" undo=").append(m.undoGroup())
			.append('@').append(m.undoneAt()).append(" meta=").append(h.meta()).append(" ring=").append(java.util.Arrays.toString(h.ring())).append('\n');
		TreeMap<Long, Journal.Cell> cells = new TreeMap<>();
		e.cells().forEach(c -> cells.put(c.pos(), c));
		for (Journal.Cell c : cells.values()) {
			b.append(c.pos()).append(' ').append(c.layer()).append(' ').append(text(c.before())).append(" -> ").append(c.after() == null ? "?" : text(c.after()));
			if (e.undo() != null) {
				Value w = e.undo().written().get(c.pos());
				b.append(" w=").append(w == null ? "-" : text(w));
			}
			b.append('\n');
		}
		return b.toString();
	}

	static String text(Value v) {
		return v.state() + (v.nbt() == null ? "" : "+" + v.nbt());
	}

	/** The journal by {@code site/kind}: every entry's content, the legacy names (by site/kind), the counters. */
	static TreeMap<String, String> summary(JournalStore s) throws IOException {
		TreeMap<String, String> out = new TreeMap<>();
		JournalStore.Index idx = s.index();
		for (JournalStore.Meta m : idx.entries().values()) {
			String key = m.site() + "/" + m.kind();
			if (out.containsKey(key)) {
				throw new AssertionError("two " + key + " entries");
			}
			out.put(key, describe(s, m));
		}
		TreeMap<String, String> leg = new TreeMap<>();
		idx.legacy().forEach((name, id) -> {
			JournalStore.Meta m = idx.entries().get(id);
			leg.put(name, m == null ? "?" + id : m.site() + "/" + m.kind());
		});
		out.put("~legacy", leg.toString());
		out.put("~counters", "layer=" + idx.nextLayer() + " road=" + idx.nextRoad() + " cells=" + idx.nextCells());
		return out;
	}

	/** File names in a folder (sorted; empty when it does not exist). */
	static List<String> list(Path d) throws IOException {
		if (!Files.isDirectory(d)) {
			return List.of();
		}
		try (var l = Files.list(d)) {
			return l.map(p -> p.getFileName().toString()).sorted().toList();
		}
	}
}
