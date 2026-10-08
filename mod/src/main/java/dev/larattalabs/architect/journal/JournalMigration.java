package dev.larattalabs.architect.journal;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.site.Construction;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.SiteGroupRec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.TagParser;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * The import of a 4d world's box snapshots into the world journal (docs/CONTRACT.md "Phase 4e contract", "Migration from 4d
 * worlds"). AgentCraft's {@code JournalMigration} structure is kept (plan, then the index commit as the only "done" marker,
 * then the old folder moves to {@code legacy/}); the formats are Architect's:
 * <ul>
 * <li>a standing site's snapshot ({@code architect-sites/<file>.nbt}): an ACTIVE {@code site} BOX entry over its restore box,
 * the snapshot's blocks and block entity data as {@code before} ({@code after} unknown), its {@code architect_leafRing} as the
 * entry's ring;</li>
 * <li>its pin's held leaves: a {@code leaves} CELL entry, each cell read from the world ({@code before} the natural leaf with
 * the recorded distance, {@code after} the leaf as read; a cell that is no longer a persistent leaf is not held);</li>
 * <li>a construction site's target file: the site entry's {@code after}; its crate {@code {pos, snapshot}} (and a group's
 * shared crate) a {@code crate} BOX entry;</li>
 * <li>a pending site: UNDONE entries whose undo wrote the whole box (settled at this start by the evidence rules);</li>
 * <li>a placing site: a PLACING entry with the snapshot as {@code before} (its job resumes or rolls back as in 4d).</li>
 * </ul>
 * Layers follow {@code placedAt}; each site's entries are consecutive. An unreadable snapshot imports its site without an entry
 * (flagged: Remove refuses it with the forget way out). An unreadable sites file means no import. Late imports: at every
 * start, a record that names a snapshot file in {@code architect-sites/} and has no entry (a site 0.7.0 placed after a
 * downgrade) is imported the same way, as the top layer.
 */
public final class JournalMigration {
	public static final String SITES_FILE = "architect-sites.json";
	public static final String SNAPSHOT_DIR = "architect-sites";
	public static final String LEGACY_DIR = "legacy";
	static final String RING = "architect_leafRing";

	private JournalMigration() {
	}

	/** What an import did: entries made, legacy names, notes (unreadable snapshots, dropped leaves). */
	public record Plan(int entries, Map<String, String> legacy, List<String> notes, List<String> flagged, boolean late) {
	}

	/**
	 * The world the import reads (held leaves): the production adapter wraps the server and loads the chunk for each read;
	 * tests use a map of block states.
	 */
	public interface MigrationWorld {
		/** The block at {@code pos} in {@code dimension} (its chunk loaded for the read), or null when there is no such level. */
		@Nullable BlockState read(String dimension, BlockPos pos);

		boolean hasDimension(String dimension);

		static MigrationWorld of(MinecraftServer server) {
			return new MigrationWorld() {
				@Override
				public @Nullable BlockState read(String dimension, BlockPos pos) {
					ServerLevel level = level(server, dimension);
					return level == null ? null : level.getBlockState(pos);
				}

				@Override
				public boolean hasDimension(String dimension) {
					return level(server, dimension) != null;
				}
			};
		}
	}

	private static volatile @Nullable Plan last;

	public static @Nullable Plan last() {
		return last;
	}

	/** Registers the import as a journal-open hook (before the sites load). */
	public static void init() {
		WorldJournal.onOpen(JournalMigration::onOpen);
	}

	static void onOpen(MinecraftServer server, JournalStore store) {
		last = null;
		try {
			Plan p = start(MigrationWorld.of(server), store);
			if (p != null && (!p.late() || p.entries() > 0)) {
				last = p;
				if (p.late()) {
					Architect.LOGGER.info("World journal: late import of {} entr{} (sites placed by an older Architect)", p.entries(),
						p.entries() == 1 ? "y" : "ies");
				} else {
					Architect.LOGGER.info("World journal: imported {} entr{} from the 4d snapshots ({} file names){}", p.entries(), p.entries() == 1 ? "y" : "ies",
						p.legacy().size(), p.notes().isEmpty() ? "" : "; " + String.join("; ", p.notes()));
				}
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.error("World journal: the import of the 4d snapshots failed; nothing was written", e);
			WorldJournal.disable("The 4d snapshots could not be imported into the world journal (" + e.getMessage()
				+ "): Architect changes no blocks until it is fixed (see the log)");
		}
	}

	/**
	 * What a world start does once its journal opened: the import of a world that has a sites file and no journal index yet,
	 * else a late import (records 0.7.0 made after a downgrade) and the end of a move a crash interrupted, when the snapshot
	 * folder is still there. Null when there was nothing to do. Throws when the import failed (nothing was written then, or
	 * only the move is left for the next start).
	 */
	static @Nullable Plan start(MigrationWorld world, JournalStore store) throws IOException {
		Path w = store.dir().getParent();
		boolean fresh = store.index().entries().isEmpty() && !JournalStore.exists(w);
		if (fresh && Files.exists(w.resolve(SITES_FILE))) {
			return run(world, store, w, false);
		}
		if (Files.isDirectory(w.resolve(SNAPSHOT_DIR))) {
			return run(world, store, w, true);
		}
		return null;
	}

	/** One thing to import: a site's snapshot, standing, placing or pending. */
	private record Item(Site site, String status, long time, @Nullable Long undoneAt) {
	}

	/**
	 * Imports the sites file's snapshots ({@code late}: only records without any entry) in one commit, then moves the
	 * snapshot folder's files into {@code architect-journal/legacy/}. Null when there is nothing to do.
	 */
	static @Nullable Plan run(MinecraftServer server, JournalStore store, Path w, boolean late) throws IOException {
		return run(MigrationWorld.of(server), store, w, late);
	}

	/** {@link #run(MinecraftServer, JournalStore, Path, boolean)} over any {@link MigrationWorld} (the seam the unit tests use). */
	public static @Nullable Plan run(MigrationWorld world, JournalStore store, Path w, boolean late) throws IOException {
		Path f = w.resolve(SITES_FILE);
		Site.FileData data;
		JsonObject root;
		if (Files.exists(f)) {
			try {
				root = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
				data = Site.fileFromJson(root);
			} catch (RuntimeException e) {
				if (late) {
					return null;
				}
				throw new IOException(SITES_FILE + " could not be read (" + e.getMessage() + "): the journal import waits until it is fixed", e);
			}
		} else {
			data = new Site.FileData(List.of(), 1, List.of());
		}
		Path snapDir = w.resolve(SNAPSHOT_DIR);
		Set<String> placing = placingSites(w);
		List<Item> items = new ArrayList<>();
		for (Site s : data.sites()) {
			items.add(new Item(s, s.placing() || placing.contains(s.id()) ? "placing" : "standing", s.placedAt(), null));
		}
		for (Site.Pending p : data.pending()) {
			items.add(new Item(p.site(), "pending", p.at(), p.at()));
		}
		List<String> unreferenced = unreferenced(snapDir, items);
		if (late) {
			items.removeIf(i -> !store.find(m -> m.site().equals(i.site().id())).isEmpty() || !Files.exists(snapDir.resolve(i.site().snapshot())));
		}
		items.sort(Comparator.comparingLong(i -> i.site().placedAt())); // layers follow placedAt (a pending site's time is its removal)
		List<String> notes = new ArrayList<>();
		List<String> flagged = new ArrayList<>();
		Map<String, String> legacy = new LinkedHashMap<>();
		if (!unreferenced.isEmpty()) {
			notes.add("snapshot files no record names (not imported, moved to " + JournalStore.DIR + "/" + LEGACY_DIR + "/" + SNAPSHOT_DIR + "): "
				+ String.join(", ", unreferenced));
		}
		JournalStore.Txn t = store.begin().label(late ? "migrate:late" : "migrate");
		int made = 0;
		Set<String> crates = new HashSet<>();
		for (Item it : items) {
			Site s = it.site();
			Path snap = snapDir.resolve(s.snapshot());
			CompoundTag tpl;
			try {
				tpl = NbtIo.readCompressed(snap, NbtAccounter.unlimitedHeap());
				if (!JournalNbt.isTemplate(tpl)) {
					throw new IOException("not a structure template");
				}
			} catch (IOException e) {
				notes.add(s.id() + ": snapshot " + s.snapshot() + " unreadable (" + e.getMessage() + "); imported without an entry (forget drops it)");
				flagged.add(s.id());
				continue;
			}
			Anchors.Bounds box = s.restoreBox();
			long layer = store.newLayer();
			String id = store.newId();
			Map<Long, Value> before = JournalNbt.values(tpl, box.minX(), box.minY(), box.minZ());
			Map<Long, Value> after = null;
			Construction c = s.construction();
			if (c != null && !"journal".equals(c.target())) {
				Path tf = snapDir.resolve(c.target());
				try {
					after = JournalNbt.values(NbtIo.readCompressed(tf, NbtAccounter.unlimitedHeap()), box.minX(), box.minY(), box.minZ());
					legacy.put(SNAPSHOT_DIR + "/" + c.target(), id);
				} catch (IOException e) {
					notes.add(s.id() + ": construction target " + c.target() + " unreadable; it can only be removed");
				}
			}
			List<Cell> cells = new ArrayList<>(before.size());
			for (var e : before.entrySet()) {
				cells.add(new Cell(e.getKey(), layer, e.getValue(), after == null ? null : after.get(e.getKey())));
			}
			Status st = "placing".equals(it.status()) ? Status.PLACING : Status.ACTIVE;
			int[] ring = tpl.getIntArray(RING).orElse(new int[0]);
			JournalStore.Meta header = JournalStore.Meta.header(id, WorldJournal.SITE, s.id(), s.group(), s.dimension(), Policy.BOX, layer, st, it.time());
			List<SectionCells> secs = JournalStore.bySection(cells);
			boolean pending = "pending".equals(it.status());
			String group = "migrated:" + s.id() + ":" + it.time();
			if (pending) {
				secs = secs.stream().map(sc -> sc.withWritten(allBefore(sc))).toList();
			}
			t.create(header, secs, new JournalNbt.Head(s.toJson(), ring));
			if (pending) {
				t.status(id, Status.UNDONE, group, it.undoneAt());
			}
			legacy.put(SNAPSHOT_DIR + "/" + s.snapshot(), id);
			made++;
			// held leaves (4d pin): read from the world
			if (!pending && s.pin() != null && !s.pin().heldLeaves().isEmpty()) {
				if (world.hasDimension(s.dimension())) {
					List<Integer> held = s.pin().heldLeaves();
					List<Cell> lc = new ArrayList<>();
					long ll = store.newLayer();
					BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
					int dropped = 0;
					for (int i = 0; i + 3 < held.size(); i += 4) {
						BlockState now = world.read(s.dimension(), p.set(held.get(i), held.get(i + 1), held.get(i + 2)));
						if (now == null || !(now.getBlock() instanceof LeavesBlock) || !now.getValue(LeavesBlock.PERSISTENT)) {
							dropped++;
							continue;
						}
						BlockState natural = now.setValue(LeavesBlock.PERSISTENT, false).setValue(LeavesBlock.DISTANCE, held.get(i + 3));
						lc.add(new Cell(p.asLong(), ll, WorldJournal.value(natural), WorldJournal.value(now)));
					}
					if (!lc.isEmpty()) {
						String lid = store.newId();
						t.create(JournalStore.Meta.header(lid, WorldJournal.LEAVES, s.id(), s.group(), s.dimension(), Policy.CELL, ll, st, it.time()),
							JournalStore.bySection(lc), JournalNbt.Head.EMPTY);
						made++;
					}
					if (dropped > 0) {
						notes.add(s.id() + ": " + dropped + " held lea" + (dropped == 1 ? "f is" : "ves are") + " no longer persistent leaves (not held)");
					}
				}
			}
			// the crate (its own, or the group's shared crate once)
			if (c != null && c.crate() != null && !pending) {
				Construction.Crate cr = c.crate();
				String owner = s.id();
				SiteGroupRec g = null;
				for (SiteGroupRec x : data.groups()) {
					if (x.id().equals(s.group()) && x.sharedCrate() && x.crate() != null && x.crate().x() == cr.x() && x.crate().y() == cr.y()
						&& x.crate().z() == cr.z()) {
						g = x;
					}
				}
				if (g != null) {
					owner = SiteGroupRec.CRATE_PREFIX + g.id();
				}
				String key = cr.x() + "," + cr.y() + "," + cr.z();
				if (c.building() && crates.add(key)) {
					Value cb;
					try {
						CompoundTag stt = TagParser.parseCompoundFully(cr.snapshotState());
						cb = Value.of(stt, cr.snapshotNbt() == null ? null : TagParser.parseCompoundFully(cr.snapshotNbt()));
					} catch (Exception e) {
						cb = Journal.AIR;
					}
					long cl = store.newLayer();
					String cid = store.newId();
					t.create(JournalStore.Meta.header(cid, WorldJournal.CRATE, owner, g != null ? g.id() : s.group(), s.dimension(), Policy.BOX, cl, Status.ACTIVE,
						it.time()), JournalStore.bySection(List.of(new Cell(Journal.pos(cr.x(), cr.y(), cr.z()), cl, cb, null))), JournalNbt.Head.EMPTY);
					made++;
				}
			}
		}
		legacy.forEach(t::legacy);
		if (made == 0 && late) {
			moveLegacy(w, store.dir(), true);
			return null;
		}
		WorldJournal.kill("migrate-before-commit");
		try {
			store.submit(t).get();
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new IOException("interrupted", e);
		} catch (java.util.concurrent.ExecutionException e) {
			throw new IOException("the import commit failed: " + e.getCause().getMessage(), e.getCause());
		}
		WorldJournal.kill("migrate-after-commit");
		moveLegacy(w, store.dir(), late);
		return new Plan(made, legacy, notes, flagged, late);
	}

	private static Map<Long, Value> allBefore(SectionCells sc) {
		Map<Long, Value> m = new LinkedHashMap<>();
		for (int i = 0; i < sc.size(); i++) {
			m.put(sc.pos(i), sc.before(i));
		}
		return m;
	}

	/** The files in the snapshot folder that no record names (as its snapshot or its construction target), sorted. */
	private static List<String> unreferenced(Path snapDir, List<Item> items) throws IOException {
		if (!Files.isDirectory(snapDir)) {
			return List.of();
		}
		Set<String> named = new HashSet<>();
		for (Item it : items) {
			named.add(it.site().snapshot());
			Construction c = it.site().construction();
			if (c != null) {
				named.add(c.target());
			}
		}
		List<String> out = new ArrayList<>();
		try (var list = Files.list(snapDir)) {
			list.map(f -> f.getFileName().toString()).filter(n -> !named.contains(n)).sorted().forEach(out::add);
		}
		return out;
	}

	/** The sites a 4d queue file was placing (their snapshots become PLACING entries). */
	private static Set<String> placingSites(Path w) {
		Set<String> out = new HashSet<>();
		Path q = w.resolve("architect-queue.json");
		if (!Files.exists(q)) {
			return out;
		}
		try {
			JsonObject root = JsonParser.parseString(Files.readString(q, StandardCharsets.UTF_8)).getAsJsonObject();
			if (root.has("jobs")) {
				root.getAsJsonArray("jobs").forEach(e -> {
					JsonObject o = e.getAsJsonObject();
					if ("place".equals(o.get("kind").getAsString())) {
						out.add(o.get("siteId").getAsString());
					}
				});
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Journal import: could not read architect-queue.json", e);
		}
		return out;
	}

	/**
	 * After the index commit: the snapshot folder's files into {@code architect-journal/legacy/architect-sites/} (also finishes
	 * a move a crash interrupted). {@code late}: only files a journal entry names now (a 0.7.0 record still names its file).
	 */
	public static void moveLegacy(Path w, Path journalDir, boolean late) throws IOException {
		Path from = w.resolve(SNAPSHOT_DIR);
		if (!Files.isDirectory(from)) {
			return;
		}
		Path to = journalDir.resolve(LEGACY_DIR).resolve(SNAPSHOT_DIR);
		Files.createDirectories(to);
		try (var list = Files.list(from)) {
			for (Path f : (Iterable<Path>) list::iterator) {
				Path target = to.resolve(f.getFileName());
				if (Files.exists(target)) {
					target = to.resolve(f.getFileName() + ".dup-" + System.currentTimeMillis());
				}
				JournalStore.faultStep("legacy move " + f.getFileName());
				Files.move(f, target, StandardCopyOption.ATOMIC_MOVE);
			}
		}
		JournalStore.faultStep("legacy move done");
		Files.deleteIfExists(from);
	}

	static @Nullable ServerLevel level(MinecraftServer server, String dimension) {
		Identifier key = Identifier.tryParse(dimension);
		return key == null ? null : server.getLevel(ResourceKey.create(Registries.DIMENSION, key));
	}
}
