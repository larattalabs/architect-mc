package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.PlaceResult;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.journal.ChangeTracker;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalNbt;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.WorldJournal;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.storage.TagValueInput;
import org.jspecify.annotations.Nullable;

/**
 * A road or cell site written over ticks (docs/CONTRACT.md phase 4e "Roads as sites", "Cell sites"), on the journal's state
 * sequence: P1 the {@code before} of every cell (one tick up to 50k cells, else sliced with change tracking), P3 the PLACING
 * commit with the planned {@code after} (known for roads and cell sites), P4 the record, P5 the writes (lowest first, with
 * {@link Sites#CELL_FLAGS}, under the per-tick budget), P7 the ACTIVE commit, P8 the record placed and SITE_PLACED. After a
 * load the cells to write are read back from the committed entry; before P3 a clean stop captures again, a crash queues the
 * item again.
 */
final class InfraJob implements Placement.Job {
	static final int CAPTURE = 0;
	static final int COMMIT = 1;
	static final int START = 2;
	static final int WRITE = 3;
	static final int AFTER_COMMIT = 4;
	static final int DONE = 5;
	private static final int CLOCK = 64;

	final String siteId;
	final String dimension;
	final String entryKind;
	final Journal.Policy policy;
	final @Nullable String batchId;
	final @Nullable String itemKey;
	Infra record;
	int phase = CAPTURE;
	int cursor;
	@Nullable String entry;
	boolean beforeRecord = true;
	@Nullable String broken;
	/** The cells to write, lowest first, and their planned values (rebuilt from the entry after a load). */
	transient long[] positions = new long[0];
	transient Value[] afters = new Value[0];
	transient Value @Nullable [] befores;
	transient @Nullable ChangeTracker tracker;
	transient @Nullable CompletableFuture<Void> commit;
	@Nullable List<String> dropsBefore;
	final List<String> notes = new ArrayList<>();
	/** Who waits for it (the API's placeRoad / placeCells). */
	transient final List<CompletableFuture<PlaceResult>> futures = new ArrayList<>();

	InfraJob(String siteId, String dimension, String entryKind, Journal.Policy policy, Infra record, @Nullable String batchId, @Nullable String itemKey) {
		this.siteId = siteId;
		this.dimension = dimension;
		this.entryKind = entryKind;
		this.policy = policy;
		this.record = record;
		this.batchId = batchId;
		this.itemKey = itemKey;
	}

	/** Sets the planned cells (sorted lowest first) and starts P1. */
	void plan(ServerLevel level, long[] pos, Value[] values) throws Sites.SiteException {
		Integer[] order = new Integer[pos.length];
		for (int i = 0; i < order.length; i++) {
			order[i] = i;
		}
		Arrays.sort(order, (a, b) -> {
			int c = Integer.compare(Journal.y(pos[a]), Journal.y(pos[b]));
			if (c != 0) {
				return c;
			}
			c = Integer.compare(Journal.x(pos[a]), Journal.x(pos[b]));
			return c != 0 ? c : Integer.compare(Journal.z(pos[a]), Journal.z(pos[b]));
		});
		positions = new long[pos.length];
		afters = new Value[pos.length];
		for (int i = 0; i < order.length; i++) {
			positions[i] = pos[order[i]];
			afters[i] = values[order[i]];
		}
		befores = new Value[positions.length];
		cursor = 0;
		if (positions.length > SiteJournal.ONE_TICK_CELLS) {
			Set<Long> secs = new LinkedHashSet<>();
			for (long p : positions) {
				secs.add(Sections.key(p));
			}
			tracker = ChangeTracker.start(level, secs);
			phase = CAPTURE;
		} else {
			captureSome(level, Long.MAX_VALUE);
			submit(level);
		}
	}

	private boolean captureSome(ServerLevel level, long deadline) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		Value[] b = befores;
		while (cursor < positions.length) {
			long p = positions[cursor];
			b[cursor] = WorldJournal.valueAt(level, m.set(Journal.x(p), Journal.y(p), Journal.z(p)));
			cursor++;
			if (cursor % 4096 == 0 && System.nanoTime() >= deadline) {
				return false;
			}
		}
		return true;
	}

	/** P2-P3: the entry (before as captured, after as planned), PLACING. */
	/** A large cell site's sections, built off the server thread (the capture is complete; changes meanwhile are tracked). */
	transient @Nullable CompletableFuture<List<SectionCells>> building;
	transient long buildingLayer;

	/** P3 for a large capture: sections built off-thread first; false while that runs. */
	private boolean submitLarge(ServerLevel level) throws Sites.SiteException {
		if (positions.length <= SiteJournal.SYNC_CELLS || tracker == null) {
			submit(level);
			return true;
		}
		if (building == null) {
			SiteJournal.requireAvailable();
			long layer = SiteJournal.store().newLayer();
			buildingLayer = layer;
			long[] ps = positions;
			Journal.Value[] bs = befores.clone();
			Journal.Value[] as = afters;
			building = CompletableFuture.supplyAsync(() -> {
				List<Cell> cells = new ArrayList<>(ps.length);
				for (int i = 0; i < ps.length; i++) {
					cells.add(new Cell(ps[i], layer, bs[i], as[i]));
				}
				return JournalStore.bySection(cells);
			});
			return false;
		}
		if (!building.isDone()) {
			return false;
		}
		List<SectionCells> secs = building.join();
		building = null;
		long[] changed = tracker.drain();
		tracker.stop();
		tracker = null;
		if (changed.length > 0) {
			// changed while the sections were built: captured again, and the sections made again (rare)
			java.util.Map<Long, Integer> at = new java.util.HashMap<>();
			for (int i = 0; i < positions.length; i++) {
				at.put(positions[i], i);
			}
			BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
			for (long c : changed) {
				Integer i = at.get(c);
				if (i != null) {
					befores[i] = WorldJournal.valueAt(level, m.set(Journal.x(c), Journal.y(c), Journal.z(c)));
				}
			}
			List<Cell> cells = new ArrayList<>(positions.length);
			for (int i = 0; i < positions.length; i++) {
				cells.add(new Cell(positions[i], buildingLayer, befores[i], afters[i]));
			}
			secs = JournalStore.bySection(cells);
		}
		JournalStore s = SiteJournal.store();
		String id = s.newId();
		commit = s.submit(s.begin().label("P3:" + siteId).create(JournalStore.Meta.header(id, entryKind, siteId, record.group(), dimension, policy,
			buildingLayer, Journal.Status.PLACING, System.currentTimeMillis()), secs, new JournalNbt.Head(record.toJson(), new int[0])));
		entry = id;
		befores = null;
		phase = COMMIT;
		return true;
	}

	private void submit(ServerLevel level) throws Sites.SiteException {
		if (tracker != null) {
			long[] changed = tracker.drain();
			tracker.stop();
			tracker = null;
			if (changed.length > 0) {
				java.util.Map<Long, Integer> at = new java.util.HashMap<>();
				for (int i = 0; i < positions.length; i++) {
					at.put(positions[i], i);
				}
				BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
				for (long c : changed) {
					Integer i = at.get(c);
					if (i != null) {
						befores[i] = WorldJournal.valueAt(level, m.set(Journal.x(c), Journal.y(c), Journal.z(c)));
					}
				}
			}
		}
		SiteJournal.requireAvailable();
		JournalStore s = SiteJournal.store();
		long layer = s.newLayer();
		String id = s.newId();
		List<Cell> cells = new ArrayList<>(positions.length);
		for (int i = 0; i < positions.length; i++) {
			cells.add(new Cell(positions[i], layer, befores[i], afters[i]));
		}
		commit = s.submit(s.begin().label("P3:" + siteId).create(JournalStore.Meta.header(id, entryKind, siteId, record.group(), dimension, policy, layer,
			Journal.Status.PLACING, System.currentTimeMillis()), JournalStore.bySection(cells), new JournalNbt.Head(record.toJson(), new int[0])));
		entry = id;
		befores = null;
		cursor = 0;
		phase = COMMIT;
	}

	@Override
	public String siteId() {
		return siteId;
	}

	@Override
	public @Nullable String batchId() {
		return batchId;
	}

	@Override
	public String kind() {
		return "place";
	}

	@Override
	public boolean step(MinecraftServer server, long deadline) {
		long t0 = System.nanoTime();
		int p0 = phase;
		boolean r = step0(server, deadline);
		if (Sites.Trace.ON) {
			dev.larattalabs.architect.Architect.LOGGER.info("TRACE tick {} infra {} phase {} -> {} {} ms{}", server.getTickCount(), siteId, p0, phase,
				(System.nanoTime() - t0) / 1e6, r ? " done" : "");
		}
		return r;
	}

	private boolean step0(MinecraftServer server, long deadline) {
		// phases follow each other inside the budget (a commit is waited for there): no tick lost per phase
		while (true) {
			int was = phase;
			if (stepPhase(server, deadline)) {
				return true;
			}
			if (phase == was || System.nanoTime() >= deadline) {
				return false;
			}
		}
	}

	private boolean stepPhase(MinecraftServer server, long deadline) {
		ServerLevel level = Sites.levelOf(server, dimension);
		if (level == null) {
			broken = dimension + " is not loaded";
			return true;
		}
		try {
			switch (phase) {
				case CAPTURE -> {
					if (befores == null) {
						broken = "its capture was lost";
						return true;
					}
					if (captureSome(level, deadline)) {
						submitLarge(level);
					}
					return false;
				}
				case COMMIT -> {
					CompletableFuture<Void> f = commit;
					if (f != null && !PlaceJob.waitFor(f, deadline)) {
						return false;
					}
					if (f != null && f.isCompletedExceptionally()) {
						broken = "its cells could not be saved to the world journal";
						return true;
					}
					commit = null;
					WorldJournal.kill("K2");
					if (positions.length == 0) {
						readBack();
					}
					// P4: the record, placing
					Infras.put(server, record.withPlacing(true));
					beforeRecord = false;
					dropsBefore = record.box().volume() <= 4_000_000 ? Sites.Drops.before(level, record.box()).uuids() : null;
					phase = WRITE;
					cursor = 0;
					return false;
				}
				case WRITE -> {
					if (positions.length == 0 && cursor == 0) {
						readBack();
					}
					BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
					int n = 0;
					while (cursor < positions.length) {
						if (n > 0 && n % CLOCK == 0 && System.nanoTime() >= deadline) {
							return false;
						}
						long p = positions[cursor];
						Value v = afters[cursor];
						m.set(Journal.x(p), Journal.y(p), Journal.z(p));
						level.setBlock(m, WorldJournal.state(v), Sites.CELL_FLAGS);
						if (v.nbt() != null) {
							BlockEntity be = level.getBlockEntity(m);
							if (be != null) {
								be.loadWithComponents(TagValueInput.create(ProblemReporter.DISCARDING, level.registryAccess(), v.nbt()));
								be.setChanged();
							}
						}
						cursor++;
						n++;
						if (n == 1) {
							WorldJournal.kill("K3");
						}
					}
					if (dropsBefore != null) {
						Sites.Drops.of(level, record.box(), dropsBefore).clearNew(level);
					}
					commit = SiteJournal.complete(siteId, WorldJournal.empty(new dev.larattalabs.architect.placement.Anchors.Bounds(0, 0, 0, 0, 0, 0)), null);
					phase = AFTER_COMMIT;
					return false;
				}
				case AFTER_COMMIT -> {
					CompletableFuture<Void> f = commit;
					Batches.committing(batchId, itemKey);
					if (f != null && !PlaceJob.waitFor(f, deadline)) {
						return false;
					}
					if (f != null && f.isCompletedExceptionally()) {
						broken = "its placement could not be saved to the world journal";
						return true;
					}
					commit = null;
					WorldJournal.kill("K4");
					Infra done = record.withPlacing(false);
					Infras.put(server, done);
					record = done;
					phase = DONE;
					Architect.LOGGER.info("Placed {} ({} cells){}", done.describe(), positions.length, notes.isEmpty() ? "" : "; " + String.join("; ", notes));
					dev.larattalabs.architect.apiimpl.ApiEvents.placedInfra(server, done);
					if (done.road()) {
						dev.larattalabs.architect.site.roads.RoadSync.changed(server, dimension, done.box());
					}
					futures.forEach(x -> x.complete(new PlaceResult(true, Optional.of(siteId), List.of(), List.copyOf(notes))));
					return true;
				}
				default -> {
					return true;
				}
			}
		} catch (Sites.SiteException e) {
			broken = e.getMessage();
			return true;
		}
	}

	/** After a load: the cells to write are the committed entry's cells (after as planned), lowest first. */
	private void readBack() throws Sites.SiteException {
		JournalStore s = SiteJournal.store();
		JournalStore.Meta m = entry == null ? null : s.meta(entry);
		if (m == null) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "the journal entry of " + siteId + " is gone");
		}
		List<long[]> pv = new ArrayList<>();
		List<Value> vs = new ArrayList<>();
		try {
			for (long k : m.sections()) {
				SectionCells sc = s.section(entry, k);
				if (sc == null) {
					continue;
				}
				for (int i = 0; i < sc.size(); i++) {
					pv.add(new long[] {sc.pos(i)});
					vs.add(sc.after(i) == null ? sc.before(i) : sc.after(i));
				}
			}
		} catch (IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, e.getMessage());
		}
		long[] pos = new long[pv.size()];
		for (int i = 0; i < pos.length; i++) {
			pos[i] = pv.get(i)[0];
		}
		Integer[] order = new Integer[pos.length];
		for (int i = 0; i < order.length; i++) {
			order[i] = i;
		}
		Arrays.sort(order, (a, b) -> {
			int c = Integer.compare(Journal.y(pos[a]), Journal.y(pos[b]));
			if (c != 0) {
				return c;
			}
			c = Integer.compare(Journal.x(pos[a]), Journal.x(pos[b]));
			return c != 0 ? c : Integer.compare(Journal.z(pos[a]), Journal.z(pos[b]));
		});
		positions = new long[pos.length];
		afters = new Value[pos.length];
		for (int i = 0; i < order.length; i++) {
			positions[i] = pos[order[i]];
			afters[i] = vs.get(order[i]);
		}
	}

	/** The job failed: whoever waits learns why. */
	void failed(String why) {
		futures.forEach(x -> x.complete(new PlaceResult(false, Optional.empty(), List.of(new Refusal(Reason.OTHER, why)), List.of())));
	}

	@Override
	public int progress() {
		return phase == WRITE || phase == AFTER_COMMIT || phase == DONE ? cursor : 0;
	}

	@Override
	public int total() {
		return Math.max(1, positions.length);
	}

	@Override
	public void aborted(MinecraftServer server) {
		if (tracker != null) {
			tracker.stop();
			tracker = null;
		}
	}

	@Override
	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("kind", "infra");
		o.addProperty("siteId", siteId);
		o.addProperty("dimension", dimension);
		o.addProperty("entryKind", entryKind);
		o.addProperty("policy", policy.name());
		if (batchId != null) {
			o.addProperty("batchId", batchId);
		}
		if (itemKey != null) {
			o.addProperty("itemKey", itemKey);
		}
		o.add("record", record.toJson());
		o.addProperty("phase", phase);
		o.addProperty("cursor", cursor);
		if (entry != null) {
			o.addProperty("entry", entry);
		}
		o.addProperty("beforeRecord", beforeRecord);
		if (dropsBefore != null) {
			JsonArray d = new JsonArray();
			dropsBefore.forEach(d::add);
			o.add("dropsBefore", d);
		}
		JsonArray n = new JsonArray();
		notes.forEach(n::add);
		o.add("notes", n);
		return o;
	}

	static InfraJob fromJson(JsonObject o) {
		InfraJob j = new InfraJob(o.get("siteId").getAsString(), o.get("dimension").getAsString(), o.get("entryKind").getAsString(),
			Journal.Policy.valueOf(o.get("policy").getAsString()), Infra.fromJson(o.getAsJsonObject("record")), o.has("batchId") ? o.get("batchId")
				.getAsString() : null, o.has("itemKey") ? o.get("itemKey").getAsString() : null);
		j.phase = o.get("phase").getAsInt();
		j.cursor = o.get("cursor").getAsInt();
		j.entry = o.has("entry") ? o.get("entry").getAsString() : null;
		j.beforeRecord = o.has("beforeRecord") && o.get("beforeRecord").getAsBoolean();
		if (o.has("dropsBefore")) {
			List<String> d = new ArrayList<>();
			o.getAsJsonArray("dropsBefore").forEach(e -> d.add(e.getAsString()));
			j.dropsBefore = d;
		}
		if (o.has("notes")) {
			o.getAsJsonArray("notes").forEach(e -> j.notes.add(e.getAsString()));
		}
		if (j.phase == WRITE) {
			j.cursor = 0; // the cells are written again from the start (the same values: idempotent)
		}
		return j;
	}

	@Override
	public String toString() {
		return "InfraJob[" + siteId + " " + entryKind + " phase " + phase + "]";
	}

	/** For SiteViews: the placing progress. */
	Map<String, Integer> stats() {
		return Map.of("cells", positions.length, "written", cursor);
	}
}
