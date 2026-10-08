package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.delta.DeltaPlanner;
import dev.larattalabs.architect.delta.SitePlanner;
import dev.larattalabs.architect.delta.TemplateDelta;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalNbt;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.UpdateMask;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.LeafGuard;
import dev.larattalabs.architect.placement.Occupancy;
import dev.larattalabs.architect.placement.TemplateGrid;
import dev.larattalabs.architect.placement.TerrainFit;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.WeakHashMap;
import java.util.function.LongPredicate;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

/**
 * Delta apply to placed sites (docs/CONTRACT.md phase 5b "Delta apply to a placed site"): the site's version, the delta set
 * (plan against plan on the pre-site view, {@link DeltaPlanner}), the verdict before any write, the apply (D1-D8: a BOX
 * {@code delta} entry in the site's undo group, committed PLACING, the record {@code updating}, the writes through the 4d
 * restore path under the other sites' mask, the {@code after} capture, ACTIVE, the record at the new version), the revert
 * (one undo of a suffix of deltas, or a forward delta), the history fold and the world-start settle. Instant (creative, or
 * wherever INSTANT is allowed); survival construction deltas are {@link Builder}'s. Server thread.
 */
public final class SiteDeltas {
	/** At most this many deltas per site before the oldest folds into the base (config {@code maxSiteDeltas}, 2-6). */
	static volatile int maxSiteDeltas = 6;

	private SiteDeltas() {
	}

	/** The running server (world start to stop): versions are loaded through it. */
	static volatile @Nullable MinecraftServer server;

	/** The template grid of the version a site stands at, when its pin matches it (null: gone). */
	static @Nullable TemplateGrid gridOf(Site b) {
		MinecraftServer sv = server;
		if (sv == null || b.pin() == null) {
			return null;
		}
		int v = b.versioning().version();
		if (v > 0) {
			Blueprints.Version bv = Blueprints.version(sv, b.blueprint(), v);
			if (bv != null) {
				TemplateGrid g = TemplateGrid.of(bv.entry());
				return g.fingerprint().equals(b.pin().template()) ? g : null;
			}
		}
		return null;
	}

	/** World start: records a 0.9.0 save stripped of their versions get them back from the delta entries, then {@link #settle}. */
	static void atStart(MinecraftServer sv) {
		for (Site b : Sites.all()) {
			Site nb = rebuildVersioning(b);
			if (nb != null) {
				Sites.replace(sv, nb);
				Architect.LOGGER.info("Deltas: {}'s versions were rebuilt from its delta entries (a 0.9.0 save dropped them)", b.id());
			}
		}
		settle(sv);
	}

	public static void setMaxSiteDeltas(int n) {
		maxSiteDeltas = Math.max(2, Math.min(6, n));
	}

	/** An apply's request (the API's {@code DeltaRequest} without its ext). {@code toVersion} 0 = the head. */
	public record Request(String siteId, int toVersion, DeltaPlanner.Edits edits, boolean layer, @Nullable String owner, boolean force) {
	}

	/** One refusal or wait. */
	public record Refusal(Reason reason, String message, boolean waits) {
	}

	/**
	 * The verdict of a delta (docs/CONTRACT.md "Refusals and waits"; Steward SHOULD 1: the preview as data): its refusals, the
	 * versions, the world delta's counts, the per-part summary (the blueprint delta), the kept cells, the overlaps, the cells to
	 * write ({@code Δ'}) with their kind for the ghost, the box, notes. {@link #plan} carries what {@link #apply} needs.
	 */
	public record Check(List<Refusal> refusals, String siteId, int from, int to, int added, int removed, int changed, Map<String, TemplateDelta.Part> parts,
		List<DeltaPlanner.Kept> kept, Map<String, Integer> overlaps, Map<Long, Byte> ghost, Anchors.@Nullable Bounds box, List<String> notes,
		@Nullable Planned plan, Map<String, Integer> bom, Map<String, Integer> refund) {
		public Check(List<Refusal> refusals, String siteId, int from, int to, int added, int removed, int changed, Map<String, TemplateDelta.Part> parts,
			List<DeltaPlanner.Kept> kept, Map<String, Integer> overlaps, Map<Long, Byte> ghost, Anchors.@Nullable Bounds box, List<String> notes,
			@Nullable Planned plan) {
			this(refusals, siteId, from, to, added, removed, changed, parts, kept, overlaps, ghost, box, notes, plan, Map.of(), Map.of());
		}

		/** The same verdict with survival's bill of materials and refunds, and more refusals. */
		public Check withSurvival(Map<String, Integer> b, Map<String, Integer> r, List<Refusal> more) {
			List<Refusal> rs = new ArrayList<>(refusals);
			rs.addAll(more);
			return new Check(rs, siteId, from, to, added, removed, changed, parts, kept, overlaps, ghost, box, notes, plan, b, r);
		}

		public boolean ok() {
			return refusals.isEmpty();
		}

		public boolean waits() {
			return !refusals.isEmpty() && refusals.stream().allMatch(Refusal::waits);
		}
	}

	/** Ghost kinds (the {@code delta_preview} payload). */
	public static final byte ADDED = 0;
	public static final byte REMOVED = 1;
	public static final byte CHANGED = 2;
	public static final byte KEPT = 3;

	/** What an apply writes: the outcome, the new version's plan and box corner, its loaded version. */
	public record Planned(Site site, int from, int to, Blueprints.Version vb, DeltaPlanner.Outcome outcome, SitePlanner.Plan pb, int[] minB, int turns,
		TemplateDelta.Result tdelta) {
	}

	/** The result of an apply or a revert (the API's {@code DeltaResult}). */
	public record Result(boolean applied, String siteId, int from, int to, int written, List<DeltaPlanner.Kept> kept, int reshaped, List<Refusal> refusals,
		List<String> notes, @Nullable Site before, @Nullable Site after, Map<String, Integer> refund) {
		public Result(boolean applied, String siteId, int from, int to, int written, List<DeltaPlanner.Kept> kept, int reshaped, List<Refusal> refusals,
			List<String> notes, @Nullable Site before, @Nullable Site after) {
			this(applied, siteId, from, to, written, kept, reshaped, refusals, notes, before, after, Map.of());
		}
	}

	// ------------------------------------------------------------------ versions

	/** The head version of a site's entry (0 when the entry is gone). */
	public static int headVersion(String entryId) {
		Blueprints.Entry e = Blueprints.entry(entryId);
		return e == null ? 0 : Blueprints.headVersion(e);
	}

	/**
	 * The version a site stands at: its record's, or for a pre-5b record the stored version whose template fingerprint equals
	 * its pin's (derived once and kept). 0 = {@code VERSION_GONE}.
	 */
	public static int versionOf(MinecraftServer server, Site b) {
		if (b.versioning().version() > 0) {
			return b.versioning().version();
		}
		int v = derive(server, b);
		if (v > 0 && server.isSameThread() && Sites.get(b.id()) != null) {
			Sites.replace(server, b.withVersioning(new Site.Versioning(v, List.of(new Site.History(v, b.placedAt(), "placed", null, new int[] {b.box()
				.minX(), b.box().minY(), b.box().minZ()}, true)), 0, 0)));
		}
		return v;
	}

	private static final Map<String, Integer> DERIVED = new java.util.concurrent.ConcurrentHashMap<>();

	/** The stored version whose template fingerprint equals the site's pin (cached per library revision); 0 = none. */
	static int derive(MinecraftServer server, Site b) {
		if (b.pin() == null) {
			return 0;
		}
		String key = b.blueprint() + "|" + b.pin().template() + "|" + Blueprints.revision();
		Integer c = DERIVED.get(key);
		if (c != null) {
			return c;
		}
		Blueprints.Entry head = Blueprints.entry(b.blueprint());
		int found = 0;
		if (head != null) {
			for (int v = Blueprints.headVersion(head); v >= 1 && found == 0; v--) {
				Blueprints.Version bv = Blueprints.version(server, b.blueprint(), v);
				if (bv != null && TemplateGrid.of(bv.entry()).fingerprint().equals(b.pin().template())) {
					found = v;
				}
			}
		}
		DERIVED.put(key, found);
		return found;
	}

	private static final Map<Blueprints.Version, SitePlanner.VersionCells> CELLS = Collections.synchronizedMap(new WeakHashMap<>());

	static SitePlanner.VersionCells cells(Blueprints.Version v) {
		return CELLS.computeIfAbsent(v, k -> SitePlanner.VersionCells.of(k.entry().template()));
	}

	/** The blueprint delta of two versions (the per-part summary, authoritative for world writes; off-thread capable). */
	public static TemplateDelta.Result templateDelta(Blueprints.Version a, Blueprints.Version b) {
		TemplateDelta.Result r = templateDeltaCached(a, b);
		if (r != null) {
			return r;
		}
		r = TemplateDelta.delta(new TemplateDelta.Version(a.raw(), a.parts(), a.entry().json()), new TemplateDelta.Version(b.raw(), b.parts(), b.entry()
			.json()));
		synchronized (DIFFS) {
			DIFFS.put(diffKey(a, b), r);
		}
		return r;
	}

	/** Template deltas by the two versions' content (the diff of a kit pair costs tens of ms: never twice, and off the server thread for batches). */
	private static final Map<String, TemplateDelta.Result> DIFFS = new LinkedHashMap<>(32, 0.75f, true) {
		@Override
		protected boolean removeEldestEntry(Map.Entry<String, TemplateDelta.Result> e) {
			return size() > 64;
		}
	};
	private static final Map<String, java.util.concurrent.CompletableFuture<TemplateDelta.Result>> DIFFING = new java.util.concurrent.ConcurrentHashMap<>();

	private static String diffKey(Blueprints.Version a, Blueprints.Version b) {
		return a.sha256() + ">" + b.sha256() + ":" + a.entry().json().hashCode() + ":" + b.entry().json().hashCode();
	}

	static TemplateDelta.@Nullable Result templateDeltaCached(Blueprints.Version a, Blueprints.Version b) {
		synchronized (DIFFS) {
			return DIFFS.get(diffKey(a, b));
		}
	}

	/** Whether the template delta of the site's current version and {@code to} is ready; when not, starts it on a worker thread. */
	static boolean diffReady(MinecraftServer server, String siteId, int toVersion) {
		Site b = Sites.get(siteId);
		if (b == null) {
			return true;
		}
		int head = headVersion(b.blueprint());
		int to = toVersion <= 0 ? head : toVersion;
		int from = versionOf(server, b);
		Blueprints.Version va = from == 0 ? null : Blueprints.version(server, b.blueprint(), from);
		Blueprints.Version vb = Blueprints.version(server, b.blueprint(), to);
		if (va == null || vb == null || templateDeltaCached(va, vb) != null) {
			return true;
		}
		String k = diffKey(va, vb);
		java.util.concurrent.CompletableFuture<TemplateDelta.Result> f = DIFFING.computeIfAbsent(k, x -> java.util.concurrent.CompletableFuture.supplyAsync(
			() -> templateDelta(va, vb)));
		if (f.isDone()) {
			DIFFING.remove(k);
			return true;
		}
		return false;
	}

	// ------------------------------------------------------------------ the site's journal side

	/** A site's own non-guard cells (its {@code site} and {@code delta} entries), and the other entries near it. */
	static final class SiteCells {
		final String site;
		final String dim;
		/** pos -> the site's cells there, bottom first. */
		final Map<Long, List<Cell>> mine = new HashMap<>();
		final List<JournalStore.Meta> deltas = new ArrayList<>();
		JournalStore.@Nullable Meta base;
		/** section -> other active non-guard entries' cells there (entry meta, cells). */
		private final Map<Long, List<Object[]>> others = new HashMap<>();
		private final JournalStore store;

		SiteCells(JournalStore store, String site, String dim) throws IOException {
			this.store = store;
			this.site = site;
			this.dim = dim;
			for (JournalStore.Meta m : SiteJournal.active(site)) {
				boolean d = m.kind().equals(WorldJournal.DELTA);
				if (!m.kind().equals(WorldJournal.SITE) && !d) {
					continue;
				}
				if (d) {
					deltas.add(m);
				} else {
					base = m;
				}
				for (long k : m.sections()) {
					SectionCells sc = store.section(m.id(), k);
					if (sc == null) {
						continue;
					}
					for (int i = 0; i < sc.size(); i++) {
						mine.computeIfAbsent(sc.pos(i), x -> new ArrayList<>(2)).add(sc.cell(i));
					}
				}
			}
			for (List<Cell> l : mine.values()) {
				l.sort(java.util.Comparator.comparingLong(Cell::layer));
			}
			deltas.sort(java.util.Comparator.comparingLong(JournalStore.Meta::layer));
		}

		boolean has(long p) {
			return mine.containsKey(p);
		}

		@Nullable Value lowestBefore(long p) {
			List<Cell> l = mine.get(p);
			return l == null ? null : l.get(0).before();
		}

		@Nullable Cell top(long p) {
			List<Cell> l = mine.get(p);
			return l == null ? null : l.get(l.size() - 1);
		}

		/** The highest other active non-guard cell at {@code p}: {meta, layer}, or null. */
		Object @Nullable [] otherTop(long p) {
			long key = Sections.key(p);
			List<Object[]> l = others.computeIfAbsent(key, k -> {
				List<Object[]> out = new ArrayList<>();
				for (String id : store.inSection(dim, k)) {
					JournalStore.Meta m = store.meta(id);
					if (m == null || !m.active() || m.site().equals(site) || m.kind().equals(WorldJournal.LEAVES)) {
						continue;
					}
					try {
						SectionCells sc = store.section(id, k);
						if (sc != null) {
							out.add(new Object[] {m, sc});
						}
					} catch (IOException e) {
						// unreadable: treated as not there (the write path reads it again and refuses)
					}
				}
				return out;
			});
			int idx = Sections.index(p);
			Object[] best = null;
			for (Object[] o : l) {
				SectionCells sc = (SectionCells) o[1];
				int k = sc.find(idx);
				if (k >= 0 && (best == null || sc.layer(k) > (long) best[1])) {
					best = new Object[] {o[0], sc.layer(k)};
				}
			}
			return best;
		}

		DeltaPlanner.Holder holder(long p) {
			Object[] o = otherTop(p);
			Cell t = top(p);
			if (t == null) {
				return o == null ? DeltaPlanner.Holder.NONE : DeltaPlanner.Holder.OTHER;
			}
			return o != null && (long) o[1] > t.layer() ? DeltaPlanner.Holder.OTHER : DeltaPlanner.Holder.SITE;
		}

		@Nullable String topSite(long p) {
			Object[] o = otherTop(p);
			return o == null ? null : ((JournalStore.Meta) o[0]).site();
		}

		/** Positions another site holds on top within {@code box} (the update mask of the writes). */
		LongPredicate othersOnTop() {
			return p -> holder(p) == DeltaPlanner.Holder.OTHER;
		}
	}

	// ------------------------------------------------------------------ check

	/** The verdict of applying {@code r} (changes nothing). */
	public static Check check(ServerLevel level, Request r) {
		return check(level, r, null, null);
	}

	/**
	 * {@link #check}; with {@code cap} (a large delta's sliced capture of the world around the site, {@link DeltaJob}) every world
	 * read comes from it and the check may run off the server thread (occupancy is then the job's, on the server thread;
	 * {@code bedsUnsafe} replaces the bed rule's per-head test).
	 */
	static Check check(ServerLevel level, Request r, WorldJournal.@Nullable Captured cap, @Nullable Boolean bedsUnsafe) {
		List<Refusal> out = new ArrayList<>();
		List<String> notes = new ArrayList<>();
		MinecraftServer server = level.getServer();
		Site b = Sites.get(r.siteId());
		if (b == null) {
			out.add(new Refusal(Reason.OTHER, "No site " + r.siteId(), false));
			return empty(out, r.siteId(), 0, 0, notes);
		}
		if (!b.dimension().equals(Sites.dimensionId(level))) {
			out.add(new Refusal(Reason.OTHER, r.siteId() + " is in " + b.dimension(), false));
			return empty(out, r.siteId(), 0, 0, notes);
		}
		String why = SiteJournal.unavailable();
		if (why != null) {
			out.add(new Refusal(Reason.JOURNAL_UNAVAILABLE, why, false));
			return empty(out, r.siteId(), 0, 0, notes);
		}
		int head = headVersion(b.blueprint());
		int to = r.toVersion() <= 0 ? head : r.toVersion();
		int from = versionOf(server, b);
		if (from == 0) {
			out.add(new Refusal(Reason.VERSION_GONE, "The version " + r.siteId() + " was placed from can't be found any more (its template changed or "
				+ "its version folder is gone): remove it or place it again", false));
			return empty(out, r.siteId(), 0, to, notes);
		}
		b = Sites.get(r.siteId()); // versionOf may have recorded the derived version
		Blueprints.Version va = Blueprints.version(server, b.blueprint(), from);
		Blueprints.Version vb = Blueprints.version(server, b.blueprint(), to);
		if (va == null || vb == null) {
			out.add(new Refusal(Reason.VERSION_GONE, "Version " + (va == null ? from : to) + " of " + b.blueprint() + " can't be found", false));
			return empty(out, r.siteId(), from, to, notes);
		}
		// busy: placing, a construction site (or a construction delta) still building, being removed, an update in progress
		// (a check with a capture is the site's own DeltaJob planning: its job is not "busy")
		if (b.placing() || b.building() || b.versioning().updating() > 0 || b.versioning().reverting() > 0 || Groups.removing(b.id())
			|| cap == null && Placement.job(b.id()) != null) {
			out.add(new Refusal(Reason.SITE_BUSY, r.siteId() + " is busy (" + (b.placing() ? "still being placed" : b.building() ? "still building"
				: b.versioning().updating() > 0 ? "an update is running" : "being removed or reverted") + ")", true));
			return empty(out, r.siteId(), from, to, notes);
		}
		// the owner rule (Steward SHOULD 4)
		if (b.owner() != null && !b.owner().equals(r.owner()) && !r.force()) {
			out.add(new Refusal(Reason.OVERLAP_OWNED, r.siteId() + " is owned by " + b.owner() + "; updating it needs force", false));
		}
		TemplateDelta.Result td = templateDelta(va, vb);
		if (!td.frameKept()) {
			out.add(new Refusal(Reason.FRAME_CHANGED, "Version " + to + " of " + b.blueprint() + " changes the frame (" + String.join("; ", td.notes())
				+ "): rotating or moving a building is a re-place", false));
			return new Check(out, r.siteId(), from, to, 0, 0, 0, td.parts(), List.of(), Map.of(), Map.of(), null, td.notes(), null);
		}
		if (td.approximate()) {
			notes.add("part labels are approximate (an entry without a part map)");
		}
		notes.addAll(td.notes());
		int turns = BlueprintTransform.parseTurns(b.rotation());
		SiteCells sc;
		try {
			sc = new SiteCells(WorldJournal.store(), b.id(), b.dimension());
		} catch (IOException e) {
			out.add(new Refusal(Reason.JOURNAL_UNAVAILABLE, "The journal of " + b.id() + " can't be read (" + e.getMessage() + ")", false));
			return empty(out, r.siteId(), from, to, notes);
		}
		if (sc.base == null) {
			out.add(new Refusal(Reason.OTHER, "No journal entry for " + b.id() + ": it can't be updated (remove it or forget it)", false));
			return empty(out, r.siteId(), from, to, notes);
		}
		// the pre-site view: the world outside the site's cells, the before of its lowest cell inside them
		boolean[] unloaded = {false};
		Map<Long, Value> world = new HashMap<>();
		java.util.function.LongFunction<Value> now = cap != null ? p -> {
			Value v = cap.at(p);
			if (v == null) {
				unloaded[0] = true; // outside the capture: the job grows its region and plans again
				return Journal.AIR;
			}
			return v;
		} : p -> world.computeIfAbsent(p, q -> {
			BlockPos bp = BlockPos.of(q);
			if (level.getChunkSource().getChunkNow(bp.getX() >> 4, bp.getZ() >> 4) == null) {
				unloaded[0] = true;
				return Journal.AIR;
			}
			return WorldJournal.valueAt(level, bp);
		});
		it.unimi.dsi.fastutil.longs.LongOpenHashSet roads = dev.larattalabs.architect.site.roads.Roads.roadCells(b.dimension(), b.restoreBox().grow(24));
		SitePlanner.World pre = new SitePlanner.World() {
			@Override
			public Value value(long pos) {
				Value v = sc.lowestBefore(pos);
				return v != null ? v : now.apply(pos);
			}

			@Override
			public int flags(int x, int y, int z) {
				if (y < level.getMinY() || y > level.getMaxY()) {
					return TerrainFit.FILLABLE;
				}
				long p = Journal.pos(x, y, z);
				int f = TerrainFit.flags(WorldJournal.state(value(p)));
				return !roads.isEmpty() && roads.contains(p) ? f | TerrainFit.ROAD : f;
			}
		};
		int[] minA = siteMin(b, va);
		SitePlanner.Plan pa = plan(level, va, minA, turns, pre, bedsUnsafe);
		int[][] os = TemplateDelta.origins(va.entry().json(), vb.entry().json());
		int[] oa = os[0];
		int[] ob = os[1];
		int[] minB = SitePlanner.alignedMin(minA, oa, va.entry().blueprint().sizeX(), va.entry().blueprint().sizeZ(), ob, vb.entry().blueprint().sizeX(),
			vb.entry().blueprint().sizeZ(), turns);
		SitePlanner.Plan pb = plan(level, vb, minB, turns, pre, bedsUnsafe);
		DeltaPlanner.Set3 set = DeltaPlanner.deltaSet(pa, pb, pre);
		DeltaPlanner.Stacks stacks = new DeltaPlanner.Stacks() {
			@Override
			public DeltaPlanner.Holder holder(long pos) {
				return sc.holder(pos);
			}

			@Override
			public boolean siteHas(long pos) {
				return sc.has(pos);
			}

			@Override
			public @Nullable Value siteAfter(long pos) {
				Cell t = sc.top(pos);
				return t == null ? null : t.after();
			}

			@Override
			public @Nullable String topSite(long pos) {
				return sc.topSite(pos);
			}
		};
		DeltaPlanner.Now nowW = new DeltaPlanner.Now() {
			@Override
			public Value value(long pos) {
				return now.apply(pos);
			}

			@Override
			public boolean holds(long pos, Value after) {
				return WorldJournal.same(now.apply(pos), after);
			}
		};
		DeltaPlanner.Outcome o = DeltaPlanner.outcome(set.delta(), pb.snapBox(), stacks, nowW, r.edits());
		if (unloaded[0]) {
			out.add(new Refusal(Reason.NOT_LOADED, "the site is not loaded on the server (walk closer)", true));
		}
		if (pb.snapBox().minY() < level.getMinY() || pb.box().maxY() > level.getMaxY()) {
			out.add(new Refusal(Reason.BUILD_HEIGHT, "Version " + to + " leaves the build height", false));
		}
		if (!o.covered().isEmpty()) {
			List<String> names = new ArrayList<>();
			o.covered().forEach((s, n) -> names.add(Sites.describe(s) + " (" + n + " cell" + (n == 1 ? "" : "s") + ")"));
			out.add(new Refusal(Reason.COVERED, "The update writes cells another site covers: " + String.join(", ", names) + "; remove "
				+ (names.size() == 1 ? "it" : "them") + " first, or apply a version that leaves those cells alone", false));
		}
		if (o.refusedForEdits(r.edits())) {
			out.add(new Refusal(Reason.PLAYER_EDITS, o.edited().size() + " cell" + (o.edited().size() == 1 ? "" : "s") + " of the update changed since "
				+ r.siteId() + " was placed (" + describeKept(o.edited()) + "); use KEEP or OVERWRITE", false));
		}
		// growth over other sites' cells: as placement (REFUSE by default; LAYER goes on top unless busy, owned or too deep)
		if (!o.overlaps().isEmpty()) {
			if (!r.layer()) {
				List<String> names = new ArrayList<>();
				o.overlaps().forEach((s, n) -> names.add(Sites.describe(s)));
				out.add(new Refusal(Reason.OVERLAP, "The new version grows into " + String.join(", ", names) + "; use LAYER to build on top", false));
			} else {
				for (String other : o.overlaps().keySet()) {
					String busy = Sites.busy(other, Status.ACTIVE);
					if (busy != null) {
						out.add(new Refusal(Reason.OVERLAP_BUSY, Sites.describe(other) + " " + busy, true));
					}
					String own = Sites.ownerOf(other);
					if (own != null && !own.equals(r.owner()) && !r.force()) {
						out.add(new Refusal(Reason.OVERLAP_OWNED, Sites.describe(other) + " is owned by " + own, false));
					}
				}
			}
		}
		// depth: the site's own entries never pass 1 + maxSiteDeltas (the fold); others below count
		for (long p : o.entryCells()) {
			int depth = (sc.mine.containsKey(p) ? sc.mine.get(p).size() : 0) + 1;
			if (depth + otherDepth(sc, p) > SiteJournal.MAX_DEPTH && sc.deltas.size() < maxSiteDeltas) {
				out.add(new Refusal(Reason.LAYER_DEPTH, "More than " + SiteJournal.MAX_DEPTH + " layers at " + BlockPos.of(p).toShortString(), false));
				break;
			}
		}
		// a container the player filled in a Δ cell, in any mode (a kept cell too: docs/CONTRACT.md phase 5b "Refusals")
		List<String> filled = new ArrayList<>();
		java.util.LinkedHashSet<Long> beCells = new java.util.LinkedHashSet<>(o.write().keySet());
		for (DeltaPlanner.Kept k : o.edited()) {
			beCells.add(k.pos());
		}
		for (long p : beCells) {
			if (cap != null) {
				Value v = cap.at(p);
				if (v != null && v.nbt() != null && !v.nbt().getListOrEmpty("Items").isEmpty()) {
					filled.add(v.name().replace("minecraft:", "") + " at " + BlockPos.of(p).toShortString());
				}
				continue;
			}
			BlockEntity be = level.getBlockEntity(BlockPos.of(p));
			if (be instanceof Container c && !c.isEmpty()) {
				filled.add(be.getBlockState().getBlock().getName().getString().toLowerCase(java.util.Locale.ROOT) + " at " + BlockPos.of(p).toShortString());
			}
		}
		if (!filled.isEmpty()) {
			out.add(new Refusal(Reason.BLOCK_ENTITIES, "The update would replace " + filled.size() + " container(s) with items (" + String.join(", ",
				filled.subList(0, Math.min(3, filled.size()))) + "); empty them first", false));
		}
		// a player or an animal in the cells it writes
		Anchors.Bounds wb = boundsOf(o.entryCells());
		if (wb != null && !unloaded[0] && cap == null) {
			Set<Long> cells = o.entryCells();
			List<Occupancy.Found> found = new ArrayList<>();
			for (Occupancy.Found f : Occupancy.scan(level, wb, e -> !near(cells, e.blockPosition()))) {
				found.add(f);
			}
			List<String> occ = Occupancy.refusals(found);
			if (!occ.isEmpty()) {
				out.add(new Refusal(dev.larattalabs.architect.apiimpl.ApiRules.occupancyReason(found.stream().map(Occupancy.Found::kind).toList()),
					"Not now: " + String.join("; ", occ), true));
			}
		}
		Map<Long, Byte> ghost = new LinkedHashMap<>();
		for (var e : o.write().entrySet()) {
			long p = e.getKey();
			boolean wa = pa.writes().containsKey(p);
			boolean wbb = pb.writes().containsKey(p);
			ghost.put(p, wa && wbb ? CHANGED : wbb ? ADDED : REMOVED);
		}
		for (DeltaPlanner.Kept k : o.kept()) {
			ghost.put(k.pos(), KEPT);
		}
		if (set.delta().isEmpty()) {
			notes.add("nothing to write");
		}
		if (!o.kept().isEmpty()) {
			notes.add(o.kept().size() + " cell" + (o.kept().size() == 1 ? "" : "s") + " the player changed kept (" + describeKept(o.kept()) + ")");
		}
		Planned planned = new Planned(b, from, to, vb, o, pb, minB, turns, td);
		return new Check(out, r.siteId(), from, to, set.added(), set.removed(), set.changed(), td.parts(), o.kept(), o.overlaps(), ghost, boundsOf(o
			.write().keySet()), notes, planned);
	}

	private static Check empty(List<Refusal> out, String siteId, int from, int to, List<String> notes) {
		return new Check(out, siteId, from, to, 0, 0, 0, Map.of(), List.of(), Map.of(), Map.of(), null, notes, null);
	}

	private static int otherDepth(SiteCells sc, long p) {
		int n = 0;
		long key = Sections.key(p);
		int idx = Sections.index(p);
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return 0;
		}
		for (String id : s.inSection(sc.dim, key)) {
			JournalStore.Meta m = s.meta(id);
			if (m == null || !m.active() || m.site().equals(sc.site) || m.kind().equals(WorldJournal.LEAVES)) {
				continue;
			}
			try {
				SectionCells c = s.section(id, key);
				if (c != null && c.find(idx) >= 0) {
					n++;
				}
			} catch (IOException e) {
				// ignored
			}
		}
		return n;
	}

	private static boolean near(Set<Long> cells, BlockPos p) {
		return cells.contains(p.asLong()) || cells.contains(p.above().asLong()) || cells.contains(p.below().asLong());
	}

	static String describeKept(List<DeltaPlanner.Kept> kept) {
		List<String> s = new ArrayList<>();
		for (DeltaPlanner.Kept k : kept.subList(0, Math.min(3, kept.size()))) {
			s.add(k.found().name().replace("minecraft:", "") + " at " + BlockPos.of(k.pos()).toShortString());
		}
		return String.join(", ", s) + (kept.size() > 3 ? ", ..." : "");
	}

	static Anchors.@Nullable Bounds boundsOf(Iterable<Long> ps) {
		int[] b = null;
		for (long p : ps) {
			int x = Journal.x(p);
			int y = Journal.y(p);
			int z = Journal.z(p);
			if (b == null) {
				b = new int[] {x, y, z, x, y, z};
			} else {
				b[0] = Math.min(b[0], x);
				b[1] = Math.min(b[1], y);
				b[2] = Math.min(b[2], z);
				b[3] = Math.max(b[3], x);
				b[4] = Math.max(b[4], y);
				b[5] = Math.max(b[5], z);
			}
		}
		return b == null ? null : new Anchors.Bounds(b[0], b[1], b[2], b[3], b[4], b[5]);
	}

	/** The box corner a site's version {@code v} stands at: its history's, else the record's box (placed at that version). */
	static int[] siteMin(Site b, Blueprints.Version v) {
		List<Site.History> h = b.versioning().history();
		for (int i = h.size() - 1; i >= 0; i--) {
			if (h.get(i).version() == v.version()) {
				return h.get(i).origin().clone();
			}
		}
		return new int[] {b.box().minX(), b.box().minY(), b.box().minZ()};
	}

	static SitePlanner.Plan plan(ServerLevel level, Blueprints.Version v, int[] min, int turns, SitePlanner.World w, @Nullable Boolean bedsUnsafe) {
		var bp = v.entry().blueprint();
		String dim = Sites.dimensionId(level);
		SitePlanner.Beds beds = bedsUnsafe != null ? (h, bed) -> bedsUnsafe : (h, bed) -> {
			var rule = bed.getBedRule(level, BlockPos.of(h));
			return dev.larattalabs.architect.placement.BedSafety.unsafe(rule.canSleep() == net.minecraft.world.attribute.BedRule.Rule.NEVER, rule
				.destroyOnUse(), rule.destroyOnLeave());
		};
		return SitePlanner.plan(cells(v), bp, turns, min[0], min[1], min[2], w, beds, Sites.foundationState(bp), Sites.approachBlock(bp, false), Sites
			.approachBlock(bp, true), null);
	}

	// ------------------------------------------------------------------ apply (D1-D8)

	/**
	 * Applies a delta (instant): a kit building at once ({@link #apply}), a large one over ticks ({@link DeltaJob}). The future
	 * completes when the writes are done; refusals complete it exceptionally.
	 */
	public static java.util.concurrent.CompletableFuture<Result> applyAsync(ServerLevel level, Request r) {
		Site b = Sites.get(r.siteId());
		MinecraftServer server = level.getServer();
		if (b != null) {
			int head = headVersion(b.blueprint());
			Blueprints.Version vb = Blueprints.version(server, b.blueprint(), r.toVersion() <= 0 ? head : r.toVersion());
			if (DeltaJob.large(b, vb)) {
				if (b.placing() || b.building() || b.versioning().updating() > 0 || Placement.job(b.id()) != null) {
					return java.util.concurrent.CompletableFuture.failedFuture(new Sites.SiteException(Reason.SITE_BUSY, b.id() + " is busy"));
				}
				DeltaJob j = new DeltaJob(b.id(), DeltaJob.APPLY, r);
				java.util.concurrent.CompletableFuture<Result> f = new java.util.concurrent.CompletableFuture<>();
				j.futures.add(f);
				Placement.add(server, j);
				return f.thenCompose(res -> res.applied() ? java.util.concurrent.CompletableFuture.completedFuture(res) : java.util.concurrent.CompletableFuture
					.failedFuture(new Sites.SiteException(res.refusals().isEmpty() ? Reason.OTHER : res.refusals().get(0).reason(), String.join("; ", res
						.notes()))));
			}
		}
		try {
			return java.util.concurrent.CompletableFuture.completedFuture(apply(level, r));
		} catch (Sites.SiteException e) {
			return java.util.concurrent.CompletableFuture.failedFuture(e);
		}
	}

	/** {@link #revert}, a large site's undo over ticks ({@link DeltaJob}). */
	public static java.util.concurrent.CompletableFuture<Result> revertAsync(ServerLevel level, String siteId, int k, @Nullable String owner, boolean force) {
		LARGE_REVERT.set(Boolean.TRUE);
		PENDING.remove();
		try {
			Result r = revert(level, siteId, k, owner, force);
			java.util.concurrent.CompletableFuture<Result> f = PENDING.get();
			return f != null ? f : java.util.concurrent.CompletableFuture.completedFuture(r);
		} catch (Sites.SiteException e) {
			return java.util.concurrent.CompletableFuture.failedFuture(e);
		} finally {
			LARGE_REVERT.remove();
			PENDING.remove();
		}
	}

	/** Set around {@link #revertAsync}: a large suffix undo goes to a {@link DeltaJob} and returns its pending result. */
	static final ThreadLocal<Boolean> LARGE_REVERT = new ThreadLocal<>();
	/** The future of the last large revert started by {@link #undoSuffix} (read by {@link #revertAsync}'s callers). */
	static final ThreadLocal<java.util.concurrent.CompletableFuture<Result>> PENDING = new ThreadLocal<>();

	/** Applies a delta now (instant). Throws with the first refusal when the check refuses. */
	public static Result apply(ServerLevel level, Request r) throws Sites.SiteException {
		Check c = check(level, r);
		if (!c.ok()) {
			Refusal f = c.refusals().get(0);
			throw new Sites.SiteException(f.reason(), f.message());
		}
		return applyChecked(level, c, r.edits() == DeltaPlanner.Edits.OVERWRITE, "delta");
	}

	/** D1-D8 of a checked delta; {@code kind}: {@code delta} or {@code forward} (a revert done as a forward delta). */
	private static String ms(long nanos) {
		return String.format(java.util.Locale.ROOT, "%.1f", nanos / 1e6);
	}

	static Result applyChecked(ServerLevel level, Check c, boolean overwrite, String kind) throws Sites.SiteException {
		long tA = System.nanoTime();
		Planned p = c.plan();
		MinecraftServer server = level.getServer();
		Site b = Sites.get(c.siteId());
		JournalStore s = SiteJournal.store();
		DeltaPlanner.Outcome o = p.outcome();
		String dim = b.dimension();
		List<String> notes = new ArrayList<>(c.notes());
		if (p.to() == p.from() && o.write().isEmpty() && o.growth().isEmpty()) {
			Result res = new Result(true, b.id(), p.from(), p.to(), 0, o.kept(), 0, List.of(), notes, b, b);
			return res; // already at that version: no step
		}
		if (o.write().isEmpty() && o.growth().isEmpty()) {
			// an empty Δ is not a refusal: the site's version becomes b (a step without an entry; chain() keeps it as the top)
			Site nb = b.withVersioning(b.versioning().append(new Site.History(p.to(), System.currentTimeMillis(), kind, null, p.minB(), true)))
				.withGeometry(boxOf(p), interiorOf(p), anchorsOf(p), Sites.union(b.restoreBox(), p.pb().snapBox()), pinOf(p));
			Sites.replace(server, nb);
			Result res = new Result(true, b.id(), p.from(), p.to(), 0, o.kept(), 0, List.of(), notes, b, nb);
			dev.larattalabs.architect.apiimpl.ApiEvents.siteUpdated(server, res);
			return res;
		}
		// D1: capture the before of the entry's cells (one tick), the leaves the growth holds
		List<Long> cells = new ArrayList<>(o.entryCells());
		Map<Long, Value> before = new LinkedHashMap<>();
		BlockPos.MutableBlockPos mp = new BlockPos.MutableBlockPos();
		for (long q : cells) {
			before.put(q, WorldJournal.valueAt(level, mp.set(q)));
		}
		List<Integer> held = o.growth().isEmpty() ? List.of() : SiteJournal.holdable(level, p.pb().snapBox());
		// the leaf ring of the growth (4d): leaves around the new restore box, outside the ring the site already keeps
		int[] ring = o.growth().isEmpty() ? new int[0] : growthRing(level, b.restoreBox(), p.pb().snapBox());
		WorldJournal.kill("D1");
		long layer = s.newLayer();
		String id = s.newId();
		long now = System.currentTimeMillis();
		JsonObject meta = new JsonObject();
		meta.addProperty("from", p.from());
		meta.addProperty("to", p.to());
		meta.addProperty("entryId", b.blueprint());
		meta.addProperty("fingerprint", TemplateGrid.of(p.vb().entry()).fingerprint());
		JsonArray or = new JsonArray();
		for (int v : p.minB()) {
			or.add(v);
		}
		meta.add("origin", or);
		meta.addProperty("kind", kind);
		meta.addProperty("appliedAt", now);
		List<Cell> placing = new ArrayList<>(cells.size());
		for (long q : cells) {
			placing.add(new Cell(q, layer, before.get(q), null));
		}
		JournalStore.Txn t = s.begin().label("D3:" + b.id());
		t.create(JournalStore.Meta.header(id, WorldJournal.DELTA, b.id(), b.group(), dim, Policy.BOX, layer, Status.PLACING, now), JournalStore.bySection(
			placing), new JournalNbt.Head(meta, ring));
		String leaves = null;
		if (!held.isEmpty()) {
			leaves = s.newId();
			long ll = s.newLayer();
			t.create(JournalStore.Meta.header(leaves, WorldJournal.LEAVES, b.id(), b.group(), dim, Policy.CELL, ll, Status.PLACING, now), JournalStore
				.bySection(SiteJournal.leafCells(level, held, ll)), JournalNbt.Head.EMPTY);
		}
		// the history bound: the 7th delta folds the oldest into the base, in the same commit
		String folded = null;
		List<JournalStore.Meta> active = SiteJournal.active(b.id()).stream().filter(m -> m.kind().equals(WorldJournal.DELTA)).sorted(java.util.Comparator
			.comparingLong(JournalStore.Meta::layer)).toList();
		if (active.size() >= maxSiteDeltas) {
			JournalStore.Meta oldest = active.get(0);
			JournalStore.Meta base = SiteJournal.main(b.id());
			try {
				Journal.Entry nb = dev.larattalabs.architect.delta.DeltaPlanner.fold(s.load(base.id()), s.load(oldest.id()));
				t.sections(base.id(), JournalStore.bySection(nb.cells()));
				t.release(oldest.id());
				folded = oldest.id();
			} catch (IOException e) {
				throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "The journal of " + b.id() + " can't be read (" + e.getMessage() + ")");
			}
		}
		// D2-D3: the PLACING commit (synchronous, as a single Place)
		SiteJournal.await(s.submit(t), "the update of " + b.id());
		long tD3 = System.nanoTime();
		WorldJournal.kill("D3");
		// D4: the record, updating
		Site updating = b.withVersioning(b.versioning().withUpdating(p.to()));
		Sites.replace(server, updating);
		WorldJournal.kill("D4");
		// D5: the writes (Δ' through the 4d restore path, under the mask of cells other sites hold on top)
		Sites.Drops drops = Sites.Drops.before(level, p.pb().snapBox());
		int reshaped = write(level, b.id(), o, before);
		LeafGuard.holdCells(level, held, Sites.FLAGS);
		drops.clearNew(level);
		WorldJournal.kill("D5");
		long tD5 = System.nanoTime();
		// D6: the after capture
		Map<Long, Value> after = new HashMap<>();
		for (long q : cells) {
			after.put(q, WorldJournal.valueAt(level, mp.set(q)));
		}
		WorldJournal.kill("D6");
		// D7: ACTIVE with after
		List<Cell> done = new ArrayList<>(cells.size());
		for (long q : cells) {
			done.add(new Cell(q, layer, before.get(q), after.get(q)));
		}
		JournalStore.Txn t2 = s.begin().label("D7:" + b.id()).sections(id, JournalStore.bySection(done)).status(id, Status.ACTIVE, null, 0L);
		if (leaves != null) {
			t2.status(leaves, Status.ACTIVE, null, 0L);
		}
		SiteJournal.await(s.submit(t2), "the update of " + b.id());
		long tD7 = System.nanoTime();
		WorldJournal.kill("D7");
		// D8: the record at b
		Site.Versioning v = updating.versioning().withUpdating(0);
		if (folded != null) {
			List<Site.History> h = new ArrayList<>(v.history());
			for (int i = 0; i < h.size(); i++) {
				if (folded.equals(h.get(i).deltaEntry())) {
					h.set(i, h.get(i).withRevertible(false));
				}
			}
			// the version below the folded delta is not reachable by an undo any more
			for (int i = 0; i < h.size(); i++) {
				if (h.get(i).deltaEntry() == null || folded.equals(h.get(i).deltaEntry())) {
					h.set(i, h.get(i).withRevertible(false));
				}
				if (folded.equals(h.get(i).deltaEntry())) {
					break;
				}
			}
			v = new Site.Versioning(v.version(), h, 0, 0);
			notes.add("history folded (v" + p.from() + ")");
		}
		v = v.append(new Site.History(p.to(), now, kind, id, p.minB(), true)).withDeviations(o.kept().size());
		Site nb = updating.withVersioning(v).withGeometry(boxOf(p), interiorOf(p), anchorsOf(p), Sites.union(b.restoreBox(), p.pb().snapBox()), pinOf(p));
		Sites.replace(server, nb);
		SiteJournal.updateMeta(b.id(), nb.toJson());
		WorldJournal.kill("D8");
		if (reshaped > 0) {
			notes.add(reshaped + " neighbour cell" + (reshaped == 1 ? "" : "s") + " reshaped");
		}
		long tEnd = System.nanoTime();
		Architect.LOGGER.info("Updated site {} ({}) v{} -> v{}: {} cells written, {} kept{} in {} ms (to D3 {}, writes {}, to D7 {}, record {})", b.id(), b
			.blueprint(), p.from(), p.to(), o.write().size(), o.kept().size(), folded != null ? ", oldest delta folded" : "", ms(tEnd - tA), ms(tD3 - tA), ms(
				tD5 - tD3), ms(tD7 - tD5), ms(tEnd - tD7));
		Result res = new Result(true, b.id(), p.from(), p.to(), o.write().size(), o.kept(), reshaped, List.of(), notes, b, nb);
		dev.larattalabs.architect.apiimpl.ApiEvents.siteUpdated(server, res);
		return res;
	}

	/** The ring of {@code snapB} without the cells within the ring distance of {@code snapA} (the base's own ring covers those). */
	static int[] growthRing(ServerLevel level, Anchors.Bounds snapA, Anchors.Bounds snapB) {
		int[] all = LeafGuard.ring(level, snapB);
		Anchors.Bounds near = snapA.grow(LeafGuard.RING);
		List<Integer> out = new ArrayList<>();
		for (int i = 0; i + 3 < all.length; i += 4) {
			if (!near.contains(all[i], all[i + 1], all[i + 2])) {
				for (int k = 0; k < 4; k++) {
					out.add(all[i + k]);
				}
			}
		}
		return out.stream().mapToInt(Integer::intValue).toArray();
	}

	/**
	 * D5: writes {@code Δ'} as a structure template over its box through the 4d restore path ({@code placeInWorld}: the cells,
	 * the edge shape update, {@code updateFromNeighbourShapes} and neighbour updates), with no update delivered into cells
	 * other sites hold on top. Returns how many of the site's own neighbour cells (shape guards) changed state.
	 */
	static int write(ServerLevel level, String siteId, DeltaPlanner.Outcome o, Map<Long, Value> before) throws Sites.SiteException {
		Anchors.Bounds wb = boundsOf(o.write().keySet());
		if (wb == null) {
			return 0;
		}
		SiteCells sc;
		try {
			sc = new SiteCells(WorldJournal.store(), siteId, Sites.dimensionId(level));
		} catch (IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, e.getMessage());
		}
		// two passes: the cells that become air first, then the rest. A fresh placement writes onto the pre-site terrain; a
		// delta writes where version a's blocks still stand, and a block written under one that the delta removes (a dirt path
		// under a porch deck) would react to it (the path schedules its turn to dirt) before the removal reaches it.
		Map<Long, Value> clears = new LinkedHashMap<>();
		Map<Long, Value> rest = new LinkedHashMap<>();
		for (var e : o.write().entrySet()) {
			(WorldJournal.state(e.getValue()).isAir() ? clears : rest).put(e.getKey(), e.getValue());
		}
		int sx = wb.maxX() - wb.minX() + 1;
		int sy = wb.maxY() - wb.minY() + 1;
		int sz = wb.maxZ() - wb.minZ() + 1;
		CompoundTag tplClears = clears.isEmpty() ? null : JournalNbt.toTemplate(clears, wb.minX(), wb.minY(), wb.minZ(), sx, sy, sz, 0);
		CompoundTag tpl = rest.isEmpty() ? null : JournalNbt.toTemplate(rest, wb.minX(), wb.minY(), wb.minZ(), sx, sy, sz, 0);
		// other sites' cells on top near the writes: masked (no shape or neighbour update reaches them)
		Set<Long> masked = new HashSet<>();
		Anchors.Bounds g = wb.grow(1);
		for (int y = g.minY(); y <= g.maxY(); y++) {
			for (int z = g.minZ(); z <= g.maxZ(); z++) {
				for (int x = g.minX(); x <= g.maxX(); x++) {
					long q = Journal.pos(x, y, z);
					if (!o.write().containsKey(q) && sc.holder(q) == DeltaPlanner.Holder.OTHER) {
						masked.add(q);
					}
				}
			}
		}
		if (!masked.isEmpty()) {
			UpdateMask.begin(masked::contains);
		}
		try {
			if (tplClears != null) {
				Sites.restoreTemplate(level, wb, tplClears);
			}
			if (tpl != null) {
				Sites.restoreTemplate(level, wb, tpl);
			}
		} finally {
			if (!masked.isEmpty()) {
				UpdateMask.end();
			}
		}
		int reshaped = 0;
		BlockPos.MutableBlockPos mp = new BlockPos.MutableBlockPos();
		for (long q : o.shapeGuards()) {
			Value was = before.get(q);
			if (was != null && !was.state().equals(WorldJournal.value(level.getBlockState(mp.set(q))).state())) {
				reshaped++;
			}
		}
		return reshaped;
	}

	static Anchors.Bounds boxOf(Planned p) {
		return p.pb().box();
	}

	static Anchors.Bounds interiorOf(Planned p) {
		var bp = p.vb().entry().blueprint();
		return BlueprintTransform.worldBounds(bp, p.turns(), p.minB()[0], p.minB()[1], p.minB()[2]);
	}

	static Map<String, dev.larattalabs.architect.placement.Anchor> anchorsOf(Planned p) {
		var bp = p.vb().entry().blueprint();
		return BlueprintTransform.worldAnchors(bp, p.turns(), p.minB()[0], p.minB()[1], p.minB()[2]);
	}

	static Site.Pin pinOf(Planned p) {
		TemplateGrid g = TemplateGrid.of(p.vb().entry());
		Site.Pin old = p.site().pin();
		Site.Pin pin = new Site.Pin(g.fingerprint(), g.blockEntityOffsets(p.turns()));
		return old == null ? pin : pin.withHeldLeaves(old.heldLeaves());
	}

	// ------------------------------------------------------------------ revert, history

	/** The versions a site can reach by undoing a suffix of its deltas (creative): chain[0] the base, then each delta's target. */
	public static List<int[]> chain(Site b) {
		List<int[]> out = new ArrayList<>(); // {version, index into the active deltas (-1 = base)}
		List<JournalStore.Meta> deltas = SiteJournal.active(b.id()).stream().filter(m -> m.kind().equals(WorldJournal.DELTA)).sorted(
			java.util.Comparator.comparingLong(JournalStore.Meta::layer)).toList();
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return out;
		}
		int baseVersion = -1;
		List<Integer> tos = new ArrayList<>();
		for (JournalStore.Meta m : deltas) {
			try {
				JsonObject meta = s.head(m.id()).meta();
				if (meta == null) {
					return out;
				}
				if (baseVersion < 0) {
					baseVersion = meta.get("from").getAsInt();
				}
				tos.add(meta.get("to").getAsInt());
			} catch (IOException e) {
				return out;
			}
		}
		int cur = b.versioning().version();
		if (deltas.isEmpty()) {
			out.add(new int[] {cur, -1});
			return out;
		}
		out.add(new int[] {baseVersion, -1});
		for (int i = 0; i < tos.size(); i++) {
			out.add(new int[] {tos.get(i), i});
		}
		if (cur > 0 && cur != tos.get(tos.size() - 1)) {
			// a later step wrote nothing (a version plan-identical to the last): the record's version is the top, no entry
			out.add(new int[] {cur, tos.size()});
		}
		return out;
	}

	/**
	 * Reverts a site to version {@code k} (docs/CONTRACT.md "Undo: revert, remove, history"): in creative (INSTANT allowed) a
	 * version in its chain is reached by one undo of the deltas above it (the revertible ones); any other target is a forward
	 * delta. {@code instant}: false (survival) always makes a paid forward delta ({@link Builder}).
	 */
	public static Result revert(ServerLevel level, String siteId, int k, @Nullable String owner, boolean force) throws Sites.SiteException {
		Site b = Sites.get(siteId);
		if (b == null) {
			throw new Sites.SiteException("No site " + siteId);
		}
		MinecraftServer server = level.getServer();
		int from = versionOf(server, b);
		b = Sites.get(siteId);
		if (b.owner() != null && !b.owner().equals(owner) && !force) {
			throw new Sites.SiteException(Reason.OVERLAP_OWNED, siteId + " is owned by " + b.owner() + "; reverting it needs force");
		}
		if (b.placing() || b.building() || b.versioning().updating() > 0 || b.versioning().reverting() > 0 || Placement.job(siteId) != null) {
			throw new Sites.SiteException(Reason.SITE_BUSY, siteId + " is busy");
		}
		List<int[]> ch = chain(b);
		int idx = -1;
		for (int i = ch.size() - 1; i >= 0; i--) {
			if (ch.get(i)[0] == k) {
				idx = i;
				break;
			}
		}
		List<JournalStore.Meta> deltas = SiteJournal.active(siteId).stream().filter(m -> m.kind().equals(WorldJournal.DELTA)).sorted(java.util.Comparator
			.comparingLong(JournalStore.Meta::layer)).toList();
		boolean revertible = idx >= 0;
		if (revertible) {
			for (int i = idx; i < deltas.size(); i++) {
				if (!historyRevertible(b, deltas.get(i).id())) {
					revertible = false;
				}
			}
		}
		if (idx == ch.size() - 1 && revertible) {
			return new Result(true, siteId, from, from, 0, List.of(), 0, List.of(), List.of("already at v" + k), b, b);
		}
		if (!revertible) {
			// a forward delta to k
			Check c = check(level, new Request(siteId, k, DeltaPlanner.Edits.KEEP, false, owner, force));
			if (!c.ok()) {
				Refusal f = c.refusals().get(0);
				throw new Sites.SiteException(f.reason(), f.message());
			}
			return applyChecked(level, c, false, "forward");
		}
		return undoSuffix(level, b, idx, deltas, ch.get(idx)[0], from);
	}

	/**
	 * Reverts the delta entry {@code entryId} of a site and every delta above it (a stage undo of a delta stage): one undo of the
	 * suffix that starts at it; refused when a later delta stands on the site and {@code force} is off (4d's dependency rule).
	 */
	public static Result revertDelta(ServerLevel level, String siteId, String entryId, boolean force) throws Sites.SiteException {
		Site b = Sites.get(siteId);
		if (b == null) {
			throw new Sites.SiteException("No site " + siteId);
		}
		MinecraftServer server = level.getServer();
		int from = versionOf(server, b);
		b = Sites.get(siteId);
		List<JournalStore.Meta> deltas = SiteJournal.active(siteId).stream().filter(m -> m.kind().equals(WorldJournal.DELTA)).sorted(java.util.Comparator
			.comparingLong(JournalStore.Meta::layer)).toList();
		int at = -1;
		for (int i = 0; i < deltas.size(); i++) {
			if (deltas.get(i).id().equals(entryId)) {
				at = i;
			}
		}
		if (at < 0) {
			return new Result(true, siteId, from, from, 0, List.of(), 0, List.of(), List.of("delta " + entryId + " is not standing (reverted or folded)"), b,
				b);
		}
		if (at < deltas.size() - 1 && !force) {
			throw new Sites.SiteException(Reason.OTHER, siteId + " has " + (deltas.size() - 1 - at) + " later update(s) on top of this one; undo them "
				+ "first, or pass force");
		}
		for (int i = at; i < deltas.size(); i++) {
			if (!historyRevertible(b, deltas.get(i).id())) {
				throw new Sites.SiteException(Reason.NOT_ALLOWED, siteId + "'s update " + deltas.get(i).id() + " was built as a construction delta; "
					+ "only a forward delta goes back");
			}
		}
		List<int[]> ch = chain(b);
		return undoSuffix(level, b, at, deltas, ch.get(at)[0], from);
	}

	/** R1-R5 over the suffix of {@code deltas} starting at {@code idx}: one undo of those deltas (and their guard entries). */
	static Result undoSuffix(ServerLevel level, Site b, int idx, List<JournalStore.Meta> deltas, int k, int from) throws Sites.SiteException {
		MinecraftServer server = level.getServer();
		String siteId = b.id();
		List<int[]> ch = chain(b);
		if (idx >= deltas.size()) {
			// the target is the last delta's version and a later step wrote nothing: only the record moves
			Site after = reverted(level, b, k, ch.get(Math.min(idx, ch.size() - 1)), Set.of());
			Sites.replace(server, after);
			Result res = new Result(true, siteId, from, k, 0, List.of(), 0, List.of(), List.of("nothing to write"), b, after);
			dev.larattalabs.architect.apiimpl.ApiEvents.siteUpdated(server, res);
			return res;
		}
		List<String> ids = new ArrayList<>();
		Set<String> undoDeltas = new LinkedHashSet<>();
		for (int i = idx; i < deltas.size(); i++) {
			ids.add(deltas.get(i).id());
			undoDeltas.add(deltas.get(i).id());
		}
		// the guard entries made with those deltas (leaves after the delta, same site, created after the first undone delta)
		long firstLayer = deltas.get(idx).layer();
		for (JournalStore.Meta m : SiteJournal.active(siteId)) {
			if (m.kind().equals(WorldJournal.LEAVES) && m.layer() > firstLayer) {
				ids.add(m.id());
			}
		}
		refusePlayer(level, b, ids);
		if (Boolean.TRUE.equals(LARGE_REVERT.get()) && b.restoreBox().volume() > DeltaJob.LARGE_CELLS) {
			DeltaJob j = new DeltaJob(siteId, DeltaJob.REVERT, new Request(siteId, k, DeltaPlanner.Edits.KEEP, false, b.owner(), true));
			j.revertTo = k;
			j.revertIds = List.copyOf(ids);
			java.util.concurrent.CompletableFuture<Result> f = new java.util.concurrent.CompletableFuture<>();
			j.futures.add(f);
			PENDING.set(f);
			Placement.add(server, j);
			return new Result(true, siteId, from, k, 0, List.of(), 0, List.of(), List.of("pending: reverting over ticks"), b, null);
		}
		WorldJournal.kill("K5");
		String group = SiteJournal.group(siteId + "-r" + k);
		SiteJournal.Undone undone = SiteJournal.undoEntries(level, ids, group);
		SiteJournal.await(undone.commit(), "the revert of " + siteId);
		WorldJournal.kill("K6");
		Site reverting = b.withVersioning(b.versioning().withReverting(k));
		Sites.replace(server, reverting);
		Sites.Drops drops = Sites.Drops.before(level, b.restoreBox());
		SiteJournal.Restore rs = SiteJournal.writeNow(level, siteId, group);
		SiteJournal.restoreRing(level, rs.ring());
		drops.clearNew(level);
		WorldJournal.kill("K7");
		Site after = reverted(level, reverting, k, ch.get(idx), undoDeltas);
		Sites.replace(server, after);
		SiteJournal.updateMeta(siteId, after.toJson());
		Result res = new Result(true, siteId, from, k, rs.cells().size() + (rs.template() == null ? 0 : 1), List.of(), 0, List.of(), List.of(
			"reverted by undoing " + undoDeltas.size() + " delta" + (undoDeltas.size() == 1 ? "" : "s")), b, after);
		dev.larattalabs.architect.apiimpl.ApiEvents.siteUpdated(server, res);
		return res;
	}

	private static boolean historyRevertible(Site b, String deltaEntry) {
		for (Site.History h : b.versioning().history()) {
			if (deltaEntry.equals(h.deltaEntry())) {
				return h.revertible();
			}
		}
		return true;
	}

	private static void refusePlayer(ServerLevel level, Site b, List<String> ids) throws Sites.SiteException {
		Sites.refusePlayerIn(level, b.restoreBox(), b.id(), "reverting it");
	}

	/** The record after a revert to {@code k}: version k, its geometry, the history with a revert step. */
	static Site reverted(ServerLevel level, Site b, int k, int[] chainItem, Set<String> undone) {
		MinecraftServer server = level.getServer();
		Blueprints.Version vk = Blueprints.version(server, b.blueprint(), k);
		int[] min = null;
		for (Site.History h : b.versioning().history()) {
			if (h.version() == k && (h.deltaEntry() == null || !undone.contains(h.deltaEntry()))) {
				min = h.origin();
			}
		}
		if (min == null) {
			min = new int[] {b.box().minX(), b.box().minY(), b.box().minZ()};
		}
		int turns = BlueprintTransform.parseTurns(b.rotation());
		List<Site.History> h = new ArrayList<>();
		for (Site.History x : b.versioning().history()) {
			if (x.deltaEntry() == null || !undone.contains(x.deltaEntry())) {
				h.add(x);
			}
		}
		Site.Versioning v = new Site.Versioning(k, h, 0, 0).append(new Site.History(k, System.currentTimeMillis(), "revert", null, min, true));
		Site nb = b.withVersioning(v);
		if (vk != null) {
			var bp = vk.entry().blueprint();
			var g = TemplateGrid.of(vk.entry());
			var ghost = g.ghost(turns);
			Anchors.Bounds box = new Anchors.Bounds(min[0], min[1], min[2], min[0] + ghost.sizeX - 1, min[1] + ghost.sizeY - 1, min[2] + ghost.sizeZ - 1);
			Site.Pin pin = new Site.Pin(g.fingerprint(), g.blockEntityOffsets(turns));
			nb = nb.withGeometry(box, BlueprintTransform.worldBounds(bp, turns, min[0], min[1], min[2]), BlueprintTransform.worldAnchors(bp, turns, min[0],
				min[1], min[2]), b.restoreBox(), b.pin() == null ? pin : pin.withHeldLeaves(b.pin().heldLeaves()));
		}
		return nb;
	}

	/** A site's history (oldest first). */
	public static List<Site.History> history(MinecraftServer server, String siteId) {
		Site b = Sites.get(siteId);
		if (b == null) {
			return List.of();
		}
		versionOf(server, b);
		b = Sites.get(siteId);
		return b.versioning().history();
	}

	/** Standing sites whose version is older than their entry's head (Steward SHOULD 3), for {@code owner} (null = every owner). */
	public static List<Object[]> outdated(MinecraftServer server, @Nullable String owner, boolean anyOwner) {
		List<Object[]> out = new ArrayList<>();
		for (Site b : Sites.all()) {
			if (!anyOwner && !java.util.Objects.equals(owner, b.owner())) {
				continue;
			}
			int head = headVersion(b.blueprint());
			int v = versionOf(server, b);
			if (v > 0 && head > v) {
				out.add(new Object[] {b.id(), b.blueprint(), v, head});
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ world start (crash safety)

	/**
	 * Settles deltas at world start (docs/CONTRACT.md "Crash safety"): a PLACING delta entry whose record is not
	 * {@code updating} is released (K1/K2: nothing was written); one whose record is {@code updating} was stopped while it wrote
	 * (K3, unclean): it is rolled back by the undo of its PLACING entries; an ACTIVE delta whose record is not at its version
	 * gives the record that version (K4: the journal wins). An undone delta suffix of a standing site (a revert) is released when
	 * most of its cells where before and after differ hold their before, reactivated (the record back at its version) when most
	 * hold after, else kept for the next start.
	 */
	static void settle(MinecraftServer server) {
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return;
		}
		List<String> release = new ArrayList<>();
		for (JournalStore.Meta m : List.copyOf(s.index().entries().values())) {
			if (!m.kind().equals(WorldJournal.DELTA)) {
				continue;
			}
			Site b = Sites.get(m.site());
			if (m.status() == Status.PLACING) {
				if (b == null || b.versioning().updating() == 0) {
					release.add(m.id());
					for (JournalStore.Meta x : SiteJournal.active(m.site())) {
						if (x.kind().equals(WorldJournal.LEAVES) && x.status() == Status.PLACING) {
							release.add(x.id());
						}
					}
					Architect.LOGGER.info("Deltas: {} of {} stopped before its record changed; released, nothing written", m.id(), m.site());
					if (b != null && b.versioning().updating() > 0) {
						Sites.replace(server, b.withVersioning(b.versioning().withUpdating(0)));
					}
				} else {
					ServerLevel level = Sites.levelOf(server, b);
					if (level == null) {
						continue;
					}
					try {
						List<String> ids = new ArrayList<>();
						ids.add(m.id());
						for (JournalStore.Meta x : SiteJournal.active(m.site())) {
							if (x.kind().equals(WorldJournal.LEAVES) && x.status() == Status.PLACING) {
								ids.add(x.id());
							}
						}
						String group = SiteJournal.group(m.site() + "-rb");
						SiteJournal.Undone u = SiteJournal.undoEntries(level, ids, group);
						SiteJournal.await(u.commit(), "the rollback of " + m.site());
						SiteJournal.Restore rs = SiteJournal.writeNow(level, m.site(), group);
						SiteJournal.restoreRing(level, rs.ring());
						Sites.replace(server, b.withVersioning(b.versioning().withUpdating(0)));
						Architect.LOGGER.info("Deltas: {}'s update to v{} stopped while it wrote; rolled back to v{}", m.site(), b.versioning().updating(), b
							.versioning().version());
					} catch (Sites.SiteException e) {
						Architect.LOGGER.warn("Deltas: could not roll back {} ({})", m.site(), e.getMessage());
					}
				}
				continue;
			}
			if (m.status() == Status.ACTIVE && b != null && b.versioning().updating() > 0) {
				// K4: the journal wins
				try {
					JsonObject meta = s.head(m.id()).meta();
					if (meta != null && meta.get("to").getAsInt() == b.versioning().updating()) {
						Site nb = finishFromMeta(server, b, m, meta);
						Sites.replace(server, nb);
						Architect.LOGGER.info("Deltas: {} was updated to v{} before its record was saved; the record follows the journal", b.id(), nb
							.versioning().version());
					}
				} catch (IOException e) {
					Architect.LOGGER.warn("Deltas: {} unreadable ({})", m.id(), e.getMessage());
				}
			}
		}
		if (!release.isEmpty()) {
			SiteJournal.releaseGroup(release);
		}
		// reverts: undone deltas of standing sites
		Map<String, List<JournalStore.Meta>> undoneBySite = new LinkedHashMap<>();
		for (JournalStore.Meta m : s.index().entries().values()) {
			if (m.status() == Status.UNDONE && (m.kind().equals(WorldJournal.DELTA) || m.kind().equals(WorldJournal.LEAVES)) && Sites.get(m.site()) != null
				&& !SiteJournal.active(m.site()).isEmpty() && m.undoGroup() != null) {
				undoneBySite.computeIfAbsent(m.site() + "|" + m.undoGroup(), k -> new ArrayList<>()).add(m);
			}
		}
		for (var e : undoneBySite.entrySet()) {
			String sid = e.getKey().substring(0, e.getKey().indexOf('|'));
			String group = e.getKey().substring(e.getKey().indexOf('|') + 1);
			Site b = Sites.get(sid);
			ServerLevel level = Sites.levelOf(server, b);
			if (level == null) {
				continue;
			}
			int holdBefore = 0;
			int holdAfter = 0;
			int total = 0;
			try {
				for (JournalStore.Meta m : e.getValue()) {
					if (!m.kind().equals(WorldJournal.DELTA)) {
						continue;
					}
					Journal.Entry en = s.load(m.id());
					for (Cell c : en.cells()) {
						if (c.after() == null || c.before().equals(c.after()) || SiteJournal.owned(m.dimension(), c.pos()) && !SiteJournal.isOwnedBy(m
							.dimension(), c.pos(), sid)) {
							continue;
						}
						total++;
						Value w = WorldJournal.valueAt(level, BlockPos.of(c.pos()));
						if (WorldJournal.same(w, c.before())) {
							holdBefore++;
						} else if (WorldJournal.same(w, c.after())) {
							holdAfter++;
						}
					}
				}
			} catch (IOException ex) {
				continue;
			}
			if (total == 0 || holdBefore * 2 > total) {
				SiteJournal.releaseGroup(e.getValue().stream().map(JournalStore.Meta::id).toList());
				if (b.versioning().reverting() > 0) {
					Sites.replace(server, reverted(level, b, b.versioning().reverting(), new int[0], e.getValue().stream().map(JournalStore.Meta::id).collect(
						java.util.stream.Collectors.toSet())));
				}
			} else if (holdAfter * 2 > total) {
				try {
					SiteJournal.reactivate(group);
					if (b.versioning().reverting() > 0) {
						Sites.replace(server, b.withVersioning(b.versioning().withReverting(0)));
					}
					Architect.LOGGER.info("Deltas: {}'s revert never reached the disk; its deltas are active again", sid);
				} catch (IOException ex) {
					Architect.LOGGER.warn("Deltas: could not reactivate {} ({})", group, ex.getMessage());
				}
			}
		}
		lostWrites(server, s);
	}

	/**
	 * After an unclean stop the journal and the site records are on disk, but block writes since the world's last save are
	 * not: a site's top delta (applied, journal ACTIVE, record at its version) may find its cells back at their {@code before}.
	 * The evidence decides, as for a pending revert (counted over the delta's own uncovered cells where before and after
	 * differ): most hold {@code after}: it stands (the journal wins); most hold {@code before}: the world lost the update, and
	 * the delta is undone (one undo, exact) so the record matches the world. A construction delta is left alone (its queue is
	 * derived from the world).
	 */
	static void lostWrites(MinecraftServer server, JournalStore s) {
		for (Site b : Sites.all()) {
			List<Site.History> h = b.versioning().history();
			if (h.size() < 2 || b.construction() != null || b.versioning().updating() > 0 || b.versioning().reverting() > 0) {
				continue;
			}
			Site.History top = h.get(h.size() - 1);
			if (top.deltaEntry() == null || !"delta".equals(top.kind()) && !"revert".equals(top.kind())) {
				continue;
			}
			JournalStore.Meta m = s.index().entries().get(top.deltaEntry());
			if (m == null || m.status() != Status.ACTIVE || !m.kind().equals(WorldJournal.DELTA)) {
				continue;
			}
			ServerLevel level = Sites.levelOf(server, b);
			if (level == null) {
				continue;
			}
			int holdBefore = 0;
			int holdAfter = 0;
			int total = 0;
			try {
				for (Cell c : s.load(m.id()).cells()) {
					if (c.after() == null || c.before().equals(c.after()) || SiteJournal.owned(m.dimension(), c.pos()) && !SiteJournal.isOwnedBy(m.dimension(),
						c.pos(), b.id())) {
						continue;
					}
					total++;
					Value w = WorldJournal.valueAt(level, BlockPos.of(c.pos()));
					if (WorldJournal.same(w, c.after())) {
						holdAfter++;
					} else if (WorldJournal.same(w, c.before())) {
						holdBefore++;
					}
				}
			} catch (IOException ex) {
				continue;
			}
			if (total == 0 || holdBefore * 2 <= total) {
				continue;
			}
			int prev = h.get(h.size() - 2).version();
			try {
				revert(level, b.id(), prev, null, true);
				Architect.LOGGER.warn("Deltas: {}'s update to v{} never reached the world's save ({} of {} cells hold their before); undone, the site is at v{}",
					b.id(), top.version(), holdBefore, total, prev);
			} catch (Sites.SiteException ex) {
				Architect.LOGGER.warn("Deltas: could not undo {}'s unsaved update ({})", b.id(), ex.getMessage());
			}
		}
	}


	/** The record after an ACTIVE delta whose D8 did not happen (K4). */
	static Site finishFromMeta(MinecraftServer server, Site b, JournalStore.Meta m, JsonObject meta) {
		int to = meta.get("to").getAsInt();
		int[] min = new int[3];
		JsonArray a = meta.getAsJsonArray("origin");
		for (int i = 0; i < 3; i++) {
			min[i] = a.get(i).getAsInt();
		}
		Site.Versioning v = b.versioning().withUpdating(0).append(new Site.History(to, meta.has("appliedAt") ? meta.get("appliedAt").getAsLong() : 0L,
			meta.has("kind") ? meta.get("kind").getAsString() : "delta", m.id(), min, true));
		Site nb = b.withVersioning(v);
		Blueprints.Version vb = Blueprints.version(server, b.blueprint(), to);
		if (vb != null) {
			int turns = BlueprintTransform.parseTurns(b.rotation());
			var bp = vb.entry().blueprint();
			var g = TemplateGrid.of(vb.entry());
			var ghost = g.ghost(turns);
			Anchors.Bounds box = new Anchors.Bounds(min[0], min[1], min[2], min[0] + ghost.sizeX - 1, min[1] + ghost.sizeY - 1, min[2] + ghost.sizeZ - 1);
			int[] eb = m.box();
			Anchors.Bounds snap = eb == null ? b.restoreBox() : Sites.union(b.restoreBox(), new Anchors.Bounds(eb[0], eb[1], eb[2], eb[3], eb[4], eb[5]));
			Site.Pin pin = new Site.Pin(g.fingerprint(), g.blockEntityOffsets(turns));
			nb = nb.withGeometry(box, BlueprintTransform.worldBounds(bp, turns, min[0], min[1], min[2]), BlueprintTransform.worldAnchors(bp, turns, min[0],
				min[1], min[2]), snap, b.pin() == null ? pin : pin.withHeldLeaves(b.pin().heldLeaves()));
		}
		return nb;
	}

	/**
	 * A record a 0.9.0 save stripped of its versions (no {@code versions} key) while delta entries stand: rebuilt from the
	 * entries' meta (the journal wins, as in 4e).
	 */
	static @Nullable Site rebuildVersioning(Site b) {
		if (b.versioning().version() > 0) {
			return null;
		}
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return null;
		}
		List<JournalStore.Meta> deltas = SiteJournal.active(b.id()).stream().filter(m -> m.kind().equals(WorldJournal.DELTA) && m.status()
			== Status.ACTIVE).sorted(java.util.Comparator.comparingLong(JournalStore.Meta::layer)).toList();
		if (deltas.isEmpty()) {
			return null;
		}
		List<Site.History> h = new ArrayList<>();
		int version = 0;
		try {
			for (JournalStore.Meta m : deltas) {
				JsonObject meta = s.head(m.id()).meta();
				if (meta == null) {
					return null;
				}
				if (h.isEmpty()) {
					h.add(new Site.History(meta.get("from").getAsInt(), b.placedAt(), "placed", null, new int[] {b.box().minX(), b.box().minY(), b.box()
						.minZ()}, true));
				}
				int[] min = new int[3];
				JsonArray a = meta.getAsJsonArray("origin");
				for (int i = 0; i < 3; i++) {
					min[i] = a.get(i).getAsInt();
				}
				version = meta.get("to").getAsInt();
				h.add(new Site.History(version, meta.has("appliedAt") ? meta.get("appliedAt").getAsLong() : 0L, meta.has("kind") ? meta.get("kind")
					.getAsString() : "delta", m.id(), min, true));
			}
		} catch (IOException e) {
			return null;
		}
		return b.withVersioning(new Site.Versioning(version, h, 0, 0));
	}

	static Rotation rotation(Site b) {
		return Rotation.values()[BlueprintTransform.parseTurns(b.rotation())];
	}

	static @Nullable StructureTemplate templateOf(Blueprints.Version v) {
		return v.entry().template();
	}

	static BlockState stateOf(Value v) {
		return WorldJournal.state(v);
	}
}
