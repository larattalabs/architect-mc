package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.delta.DeltaPlanner;
import dev.larattalabs.architect.journal.ChangeTracker;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalNbt;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.UpdateMask;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.Occupancy;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

/**
 * A large delta over ticks (docs/CONTRACT.md phase 5b "Performance budgets": the size-cap fixture with every cell changed,
 * applied and reverted, no tick over 50 ms). Apply: the world around the site is captured in slices with change tracking, the
 * delta is planned off the server thread from that capture ({@link SiteDeltas#check} on it), positions that changed meanwhile
 * are captured again and planned again; then D1-D8 as the instant apply does, with the PLACING and ACTIVE commits built off the
 * server thread, the writes through {@link TemplateWriter} under the placement budget, and the {@code after} capture sliced.
 * Revert: the undo of the deltas above the target planned per section over ticks, one commit, the writes over ticks. A stop
 * mid-way is settled at the next world start (a PLACING delta whose record is {@code updating} rolls back; an undone suffix
 * settles on evidence). Server thread.
 */
final class DeltaJob implements Placement.Job {
	/** A delta whose restore box or new template box is larger than this goes over ticks. */
	static final int LARGE_CELLS = SiteJournal.ONE_TICK_CELLS;
	static final String APPLY = "delta";
	static final String REVERT = "delta-revert";

	final String siteId;
	final String kind;
	final SiteDeltas.Request request;
	/** revert: the target version, the entries undone. */
	int revertTo;
	List<String> revertIds = List.of();
	int phase;
	@Nullable String broken;
	final List<CompletableFuture<SiteDeltas.Result>> futures = new ArrayList<>();

	// apply state
	Anchors.@Nullable Bounds region;
	WorldJournal.@Nullable Captured cap;
	int capCursor;
	@Nullable ChangeTracker tracker;
	@Nullable CompletableFuture<SiteDeltas.Check> planning;
	SiteDeltas.@Nullable Check check;
	int replans;
	@Nullable CompletableFuture<Object[]> prepared;
	@Nullable CompletableFuture<Void> commit;
	@Nullable String entryId;
	long layer;
	@Nullable List<Long> cells;
	@Nullable Map<Long, Value> before;
	@Nullable TemplateWriter writer;
	@Nullable Set<Long> masked;
	WorldJournal.@Nullable Captured after;
	int afterCursor;
	@Nullable Site rec;
	int total = 1;
	int progress;
	final List<TickDeferral.Held> held = new ArrayList<>();
	// revert state
	WorldJournal.@Nullable UndoPlanner planner;
	@Nullable String group;
	SiteJournal.@Nullable Restore restore;
	@Nullable Site before0;

	DeltaJob(String siteId, String kind, SiteDeltas.Request request) {
		this.siteId = siteId;
		this.kind = kind;
		this.request = request;
	}

	@Override
	public String siteId() {
		return siteId;
	}

	@Override
	public @Nullable String batchId() {
		return null;
	}

	@Override
	public String kind() {
		return kind;
	}

	@Override
	public int progress() {
		return progress;
	}

	@Override
	public int total() {
		return total;
	}

	@Override
	public void aborted(MinecraftServer server) {
		if (tracker != null) {
			tracker.stop();
		}
		fail("aborted");
	}

	@Override
	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("siteId", siteId);
		o.addProperty("phase", phase);
		return o; // not resumed: the next world start settles it (rollback of a PLACING delta, evidence for an undone suffix)
	}

	/** Whether a delta of {@code b} to {@code vb} goes over ticks. */
	static boolean large(Site b, Blueprints.@Nullable Version vb) {
		long vol = (long) b.restoreBox().volume();
		if (vb != null) {
			var bp = vb.entry().blueprint();
			vol = Math.max(vol, (long) bp.sizeX() * bp.sizeY() * bp.sizeZ());
		}
		return vol > LARGE_CELLS;
	}

	private void fail(String why) {
		broken = why;
		SiteDeltas.Result r = new SiteDeltas.Result(false, siteId, 0, 0, 0, List.of(), 0, List.of(new SiteDeltas.Refusal(Reason.OTHER, why, false)), List.of(
			why), null, null);
		futures.forEach(f -> f.complete(r));
	}

	private void finish(SiteDeltas.Result r) {
		futures.forEach(f -> f.complete(r));
	}

	@Override
	public boolean step(MinecraftServer server, long deadline) {
		if (broken != null) {
			return true;
		}
		Site b = Sites.get(siteId);
		ServerLevel level = b == null ? null : Sites.levelOf(server, b);
		if (b == null || level == null) {
			fail(b == null ? "no site " + siteId : b.dimension() + " is not loaded");
			return true;
		}
		try {
			long t0 = System.nanoTime();
			int ph = phase;
			boolean done = REVERT.equals(kind) ? revertStep(server, level, b, deadline) : applyStep(server, level, b, deadline);
			long ms = (System.nanoTime() - t0) / 1_000_000;
			if (ms > 20) {
				Architect.LOGGER.warn("Delta job of {} ({}): phase {} -> {} took {} ms in one tick", siteId, kind, ph, phase, ms);
			}
			return done;
		} catch (Sites.SiteException | RuntimeException e) {
			Architect.LOGGER.error("Delta job of {} failed", siteId, e);
			if (tracker != null) {
				tracker.stop();
				tracker = null;
			}
			fail(e.getMessage());
			return true;
		}
	}

	// ------------------------------------------------------------------ apply

	private boolean applyStep(MinecraftServer server, ServerLevel level, Site b, long deadline) throws Sites.SiteException {
		while (System.nanoTime() < deadline) {
			switch (phase) {
				case 0 -> { // the region: the site's restore box and the new version's box, grown by the approach and the foundation
					int head = SiteDeltas.headVersion(b.blueprint());
					int to = request.toVersion() <= 0 ? head : request.toVersion();
					int from = SiteDeltas.versionOf(server, b);
					Blueprints.Version va = Blueprints.version(server, b.blueprint(), from);
					Blueprints.Version vb = Blueprints.version(server, b.blueprint(), to);
					if (va == null || vb == null) {
						fail("Version " + (va == null ? from : to) + " of " + b.blueprint() + " can't be found");
						return true;
					}
					SiteDeltas.cells(va);
					SiteDeltas.cells(vb);
					var bpb = vb.entry().blueprint();
					int m = Math.max(bpb.sizeX(), bpb.sizeZ());
					Anchors.Bounds rb = b.restoreBox();
					int g = dev.larattalabs.architect.placement.Approach.Spec.MAX_LENGTH + dev.larattalabs.architect.placement.Approach.EXTEND + 2;
					region = new Anchors.Bounds(rb.minX() - m - g, Math.max(level.getMinY(), rb.minY() - 14), rb.minZ() - m - g, rb.maxX() + m + g, Math.min(level
						.getMaxY(), rb.maxY() + bpb.sizeY() + 2), rb.maxZ() + m + g);
					cap = WorldJournal.empty(region);
					tracker = ChangeTracker.start(level, WorldJournal.sectionsOf(region));
					capCursor = 0;
					total = cap.size() * 2;
					phase = 1;
				}
				case 1 -> { // the capture, sliced
					int end = Math.min(cap.size(), capCursor + 8192);
					WorldJournal.captureSlice(level, cap, capCursor, end);
					capCursor = end;
					progress = capCursor;
					if (capCursor >= cap.size()) {
						phase = 2;
					}
				}
				case 2 -> { // the plan, off the server thread
					if (planning == null) {
						boolean beds = bedsUnsafe(level, b);
						WorldJournal.Captured c = cap;
						planning = CompletableFuture.supplyAsync(() -> SiteDeltas.check(level, request, c, beds));
					}
					if (!planning.isDone()) {
						return false;
					}
					check = planning.join();
					planning = null;
					long[] changed = tracker.drain();
					if (changed.length > 0 && replans < 3) {
						WorldJournal.recapture(level, cap, changed);
						replans++;
						Architect.LOGGER.info("Delta of {}: {} cell(s) changed while it planned; planned again", siteId, changed.length);
						continue;
					}
					if (!check.ok()) {
						tracker.stop();
						tracker = null;
						SiteDeltas.Refusal f = check.refusals().get(0);
						fail(f.message());
						return true;
					}
					// occupancy (server thread)
					Anchors.Bounds wb = SiteDeltas.boundsOf(check.plan().outcome().entryCells());
					if (wb != null) {
						List<String> occ = Occupancy.refusals(Occupancy.scan(level, wb, e -> false));
						if (!occ.isEmpty()) {
							tracker.stop();
							tracker = null;
							fail("Not now: " + String.join("; ", occ));
							return true;
						}
					}
					phase = 3;
				}
				case 3 -> { // D1-D3: the before (from the capture, re-taken where it changed), the PLACING commit built off-thread
					if (prepared == null) {
						long[] changed = tracker.drain();
						if (changed.length > 0) {
							WorldJournal.recapture(level, cap, changed);
						}
						DeltaPlanner.Outcome o = check.plan().outcome();
						JournalStore s = SiteJournal.store();
						layer = s.newLayer();
						entryId = s.newId();
						cells = new ArrayList<>(o.entryCells());
						WorldJournal.Captured c = cap;
						rec = b;
						long now = System.currentTimeMillis();
						JsonObject meta = meta(b, now);
						String id = entryId;
						long l = layer;
						List<Long> cs = cells;
						prepared = CompletableFuture.supplyAsync(() -> {
							Map<Long, Value> bf = new java.util.HashMap<>(cs.size() * 2);
							List<Cell> placing = new ArrayList<>(cs.size());
							for (long q : cs) {
								Value v = c.at(q);
								bf.put(q, v);
								placing.add(new Cell(q, l, v, null));
							}
							return new Object[] {bf, JournalStore.bySection(placing), meta};
						});
						WorldJournal.kill("D1");
					}
					if (!prepared.isDone()) {
						return false;
					}
					Object[] p = prepared.join();
					prepared = null;
					@SuppressWarnings("unchecked")
					Map<Long, Value> bf = (Map<Long, Value>) p[0];
					before = bf;
					JournalStore s = SiteJournal.store();
					@SuppressWarnings("unchecked")
					List<dev.larattalabs.architect.journal.SectionCells> secs = (List<dev.larattalabs.architect.journal.SectionCells>) p[1];
					JournalStore.Txn t = s.begin().label("D3:" + siteId);
					t.create(JournalStore.Meta.header(entryId, WorldJournal.DELTA, siteId, b.group(), b.dimension(), Policy.BOX, layer, Status.PLACING, System
						.currentTimeMillis()), secs, new JournalNbt.Head((JsonObject) p[2], new int[0]));
					commit = s.submit(t);
					phase = 4;
				}
				case 4 -> { // D3 durable, D4 the record updating
					if (!PlaceJob.waitFor(commit, deadline)) {
						return false;
					}
					if (commit.isCompletedExceptionally()) {
						fail("its delta could not be saved to the world journal; nothing was changed");
						return true;
					}
					commit = null;
					WorldJournal.kill("D3");
					tracker.stop();
					tracker = null;
					Sites.replace(server, b.withVersioning(b.versioning().withUpdating(check.to())));
					WorldJournal.kill("D4");
					phase = 5;
				}
				case 5 -> { // D5: the writes over ticks (the template of Δ' prepared off-thread)
					if (writer == null) {
						if (prepared == null) {
							DeltaPlanner.Outcome o = check.plan().outcome();
							Anchors.Bounds wb = SiteDeltas.boundsOf(o.write().keySet());
							if (wb == null) {
								phase = 6;
								continue;
							}
							prepared = CompletableFuture.supplyAsync(() -> {
								CompoundTag tpl = JournalNbt.toTemplate(o.write(), wb.minX(), wb.minY(), wb.minZ(), wb.maxX() - wb.minX() + 1, wb.maxY() - wb.minY() + 1, wb
									.maxZ() - wb.minZ() + 1, 0);
								StructureTemplate tt = new StructureTemplate();
								tt.load(level.registryAccess().lookupOrThrow(Registries.BLOCK), tpl);
								return new Object[] {TemplateWriter.cells(level, tt, Sites.placeSettings(Rotation.NONE)).airFirst(), wb}; // clears first (SiteDeltas.write)
							});
						}
						if (!prepared.isDone()) {
							return false;
						}
						Object[] p = prepared.join();
						prepared = null;
						Anchors.Bounds wb = (Anchors.Bounds) p[1];
						writer = new TemplateWriter((TemplateWriter.Cells) p[0], new BlockPos(wb.minX(), wb.minY(), wb.minZ()), Sites.FLAGS);
						masked = othersOnTop(level, b, check.plan().outcome(), wb);
					}
					TickDeferral.begin(level, held);
					if (!masked.isEmpty()) {
						Set<Long> mk = masked;
						UpdateMask.begin(mk::contains);
					}
					try {
						writer.step(level, deadline);
					} finally {
						UpdateMask.end();
						TickDeferral.end();
					}
					progress = cap.size() + writer.progress();
					if (!writer.done()) {
						return false;
					}
					TickDeferral.release(level, TickDeferral.withoutLeaves(held));
					held.clear();
					WorldJournal.kill("D5");
					phase = 6;
				}
				case 6 -> { // D6: the after, sliced over the entry's box
					if (after == null) {
						Anchors.Bounds eb = SiteDeltas.boundsOf(cells);
						after = WorldJournal.empty(eb);
						afterCursor = 0;
						tracker = ChangeTracker.start(level, WorldJournal.sectionsOf(eb));
					}
					int end = Math.min(after.size(), afterCursor + 8192);
					WorldJournal.captureSlice(level, after, afterCursor, end);
					afterCursor = end;
					if (afterCursor < after.size()) {
						continue;
					}
					long[] changed = tracker.drain();
					tracker.stop();
					tracker = null;
					if (changed.length > 0) {
						WorldJournal.recapture(level, after, changed);
					}
					WorldJournal.kill("D6");
					phase = 7;
				}
				case 7 -> { // D7: ACTIVE with after (built off-thread)
					if (prepared == null && commit == null) {
						WorldJournal.Captured a = after;
						Map<Long, Value> bf = before;
						List<Long> cs = cells;
						long l = layer;
						prepared = CompletableFuture.supplyAsync(() -> {
							List<Cell> done = new ArrayList<>(cs.size());
							for (long q : cs) {
								done.add(new Cell(q, l, bf.get(q), a.at(q)));
							}
							return new Object[] {JournalStore.bySection(done)};
						});
					}
					if (prepared != null) {
						if (!prepared.isDone()) {
							return false;
						}
						@SuppressWarnings("unchecked")
						List<dev.larattalabs.architect.journal.SectionCells> secs = (List<dev.larattalabs.architect.journal.SectionCells>) prepared.join()[0];
						prepared = null;
						JournalStore s = SiteJournal.store();
						commit = s.submit(s.begin().label("D7:" + siteId).sections(entryId, secs).status(entryId, Status.ACTIVE, null, 0L));
					}
					if (!PlaceJob.waitFor(commit, deadline)) {
						return false;
					}
					commit = null;
					WorldJournal.kill("D7");
					phase = 8;
				}
				default -> { // D8: the record at the new version
					Site cur = Sites.get(siteId);
					SiteDeltas.Planned p = check.plan();
					long now = System.currentTimeMillis();
					Site.Versioning v = cur.versioning().withUpdating(0).append(new Site.History(p.to(), now, "delta", entryId, p.minB(), true)).withDeviations(p
						.outcome().kept().size());
					Site nb = cur.withVersioning(v).withGeometry(SiteDeltas.boxOf(p), SiteDeltas.interiorOf(p), SiteDeltas.anchorsOf(p), Sites.union(cur
						.restoreBox(), p.pb().snapBox()), SiteDeltas.pinOf(p));
					Sites.replace(server, nb);
					SiteJournal.updateMeta(siteId, nb.toJson());
					WorldJournal.kill("D8");
					Architect.LOGGER.info("Updated site {} over ticks v{} -> v{}: {} cells written", siteId, p.from(), p.to(), p.outcome().write().size());
					SiteDeltas.Result r = new SiteDeltas.Result(true, siteId, p.from(), p.to(), p.outcome().write().size(), p.outcome().kept(), 0, List.of(), check
						.notes(), rec, nb);
					dev.larattalabs.architect.apiimpl.ApiEvents.siteUpdated(server, r);
					finish(r);
					return true;
				}
			}
		}
		return false;
	}

	private JsonObject meta(Site b, long now) {
		SiteDeltas.Planned p = check.plan();
		JsonObject meta = new JsonObject();
		meta.addProperty("from", p.from());
		meta.addProperty("to", p.to());
		meta.addProperty("entryId", b.blueprint());
		meta.addProperty("fingerprint", dev.larattalabs.architect.placement.TemplateGrid.of(p.vb().entry()).fingerprint());
		JsonArray or = new JsonArray();
		for (int v : p.minB()) {
			or.add(v);
		}
		meta.add("origin", or);
		meta.addProperty("kind", "delta");
		meta.addProperty("appliedAt", now);
		return meta;
	}

	private static boolean bedsUnsafe(ServerLevel level, Site b) {
		var rule = ((net.minecraft.world.level.block.BedBlock) net.minecraft.core.registries.BuiltInRegistries.BLOCK.getValue(net.minecraft.resources.Identifier.parse("minecraft:white_bed"))).getBedRule(level, new BlockPos(b.box()
			.minX(), b.box().minY(), b.box().minZ()));
		return dev.larattalabs.architect.placement.BedSafety.unsafe(rule.canSleep() == net.minecraft.world.attribute.BedRule.Rule.NEVER, rule.destroyOnUse(),
			rule.destroyOnLeave());
	}

	private static Set<Long> othersOnTop(ServerLevel level, Site b, DeltaPlanner.Outcome o, Anchors.Bounds wb) throws Sites.SiteException {
		Set<Long> masked = new HashSet<>();
		SiteDeltas.SiteCells sc;
		try {
			sc = new SiteDeltas.SiteCells(WorldJournal.store(), b.id(), b.dimension());
		} catch (java.io.IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, e.getMessage());
		}
		// only the sections other sites have cells in can hold them
		JournalStore s = WorldJournal.storeOrNull();
		for (long k : WorldJournal.sectionsOf(wb.grow(1))) {
			boolean other = false;
			for (String id : s.inSection(b.dimension(), k)) {
				JournalStore.Meta m = s.meta(id);
				if (m != null && m.active() && !m.site().equals(b.id())) {
					other = true;
				}
			}
			if (!other) {
				continue;
			}
			int sx = dev.larattalabs.architect.journal.Sections.sx(k) << 4;
			int sy = dev.larattalabs.architect.journal.Sections.sy(k) << 4;
			int sz = dev.larattalabs.architect.journal.Sections.sz(k) << 4;
			for (int i = 0; i < 4096; i++) {
				long q = Journal.pos(sx + (i & 15), sy + (i >> 8), sz + (i >> 4 & 15));
				if (!o.write().containsKey(q) && sc.holder(q) == DeltaPlanner.Holder.OTHER) {
					masked.add(q);
				}
			}
		}
		return masked;
	}

	// ------------------------------------------------------------------ revert

	private boolean revertStep(MinecraftServer server, ServerLevel level, Site b, long deadline) throws Sites.SiteException {
		while (System.nanoTime() < deadline) {
			switch (phase) {
				case 0 -> {
					before0 = b;
					group = SiteJournal.group(siteId + "-r" + revertTo);
					try {
						planner = new WorldJournal.UndoPlanner(level, revertIds, group);
					} catch (java.io.IOException e) {
						throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, e.getMessage());
					}
					planner.ready();
					phase = 1;
				}
				case 1 -> { // R1 per section over ticks, the commit built off-thread (R2)
					try {
						if (prepared == null && !planner.step(deadline)) {
							return false;
						}
					} catch (java.io.IOException e) {
						throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, e.getMessage());
					}
					if (prepared == null) {
						WorldJournal.UndoPlanner p = planner;
						prepared = CompletableFuture.supplyAsync(() -> {
							try {
								WorldJournal.UndoWork w = p.work();
								return new Object[] {w, SiteJournal.undoTxn(w)};
							} catch (Sites.SiteException e) {
								throw new java.util.concurrent.CompletionException(e);
							}
						});
					}
					if (!prepared.isDone()) {
						return false;
					}
					Object[] built = prepared.join();
					prepared = null;
					WorldJournal.kill("K5");
					commit = SiteJournal.submitUndo((WorldJournal.UndoWork) built[0], (JournalStore.Txn) built[1]).commit();
					phase = 2;
				}
				case 2 -> {
					if (!PlaceJob.waitFor(commit, deadline)) {
						return false;
					}
					commit = null;
					WorldJournal.kill("K6");
					Sites.replace(server, b.withVersioning(b.versioning().withReverting(revertTo)));
					phase = 3;
				}
				case 3 -> { // R4: the writes over ticks
					if (writer == null) {
						if (prepared == null) {
							String g = group;
							prepared = CompletableFuture.supplyAsync(() -> {
								try {
									SiteJournal.Restore rs = SiteJournal.restore(level, siteId, g);
									TemplateWriter.Cells cs = null;
									if (rs.template() != null && rs.box() != null) {
										StructureTemplate t = new StructureTemplate();
										t.load(level.registryAccess().lookupOrThrow(Registries.BLOCK), rs.template());
										cs = TemplateWriter.cells(level, t, Sites.placeSettings(Rotation.NONE));
									}
									return new Object[] {rs, cs};
								} catch (Sites.SiteException e) {
									throw new java.util.concurrent.CompletionException(e);
								}
							});
						}
						if (!prepared.isDone()) {
							return false;
						}
						Object[] ready = prepared.join();
						prepared = null;
						restore = (SiteJournal.Restore) ready[0];
						SiteJournal.writeCells(level, restore.pre());
						writer = ready[1] == null ? new TemplateWriter(new TemplateWriter.Cells(new int[0], new net.minecraft.world.level.block.state.BlockState[0],
							new CompoundTag[0]), BlockPos.ZERO, Sites.FLAGS) : new TemplateWriter((TemplateWriter.Cells) ready[1], new BlockPos(restore.box().minX(),
								restore.box().minY(), restore.box().minZ()), Sites.FLAGS);
						total = writer.cells.size() * 2 + 1;
					}
					TickDeferral.begin(level, held);
					if (restore.mask() != null) {
						UpdateMask.begin(restore.mask());
					}
					try {
						writer.step(level, deadline);
					} finally {
						UpdateMask.end();
						TickDeferral.end();
					}
					progress = writer.progress();
					if (!writer.done()) {
						return false;
					}
					TickDeferral.release(level, TickDeferral.withoutLeaves(held));
					held.clear();
					SiteJournal.writeCells(level, restore.cells());
					SiteJournal.fixHalves(level, restore.halves());
					SiteJournal.restoreRing(level, restore.ring());
					WorldJournal.kill("K7");
					Site cur = Sites.get(siteId);
					Site after = SiteDeltas.reverted(level, cur, revertTo, new int[0], new HashSet<>(revertIds));
					Sites.replace(server, after);
					SiteJournal.updateMeta(siteId, after.toJson());
					SiteDeltas.Result r = new SiteDeltas.Result(true, siteId, before0.versioning().version(), revertTo, writer.total(), List.of(), 0, List.of(), List
						.of("reverted over ticks"), before0, after);
					dev.larattalabs.architect.apiimpl.ApiEvents.siteUpdated(server, r);
					finish(r);
					return true;
				}
				default -> {
					return true;
				}
			}
		}
		return false;
	}
}
