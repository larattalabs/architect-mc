package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Batch;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Stage;
import dev.larattalabs.architect.apiimpl.ApiEvents;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.batch.BatchRules;
import dev.larattalabs.architect.batch.CratePlacement;
import dev.larattalabs.architect.batch.LotFitting;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.batch.StageRules;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.LeafGuard;
import dev.larattalabs.architect.survival.SurvivalWorld;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.level.TicketType;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Rotation;
import org.jspecify.annotations.Nullable;

/**
 * The placement queue (docs/CONTRACT.md phase 4d "The placement queue", R7): batches of placements tried one item at a time
 * per batch, in stage / after / proximity order, under the per-tick budget ({@link Placement}). An item blocked by something
 * temporary (a player or mob in or next to its box, unloaded chunks) waits and is checked again every 20 ticks, up to the
 * batch's wait limit; anything else refuses it for good. Instant items become {@link PlaceJob}s, construction items are put
 * down at once (their builder does the rest). Persisted with the jobs in {@code architect-queue.json}. Server thread.
 */
public final class Batches {
	/** Ticks between two checks of a waiting item. */
	static final int RECHECK = 20;
	/** At most one BATCH_PROGRESS per batch per this many ticks. */
	static final int PROGRESS_TICKS = 20;
	/** Short-lived chunk tickets: LOAD_BOUNDED items, and the chunks of a job while it writes. */
	static final TicketType TICKET = net.minecraft.core.Registry.register(BuiltInRegistries.TICKET_TYPE,
		Identifier.fromNamespaceAndPath(Architect.MOD_ID, "placement"), new TicketType(0L, TicketType.FLAG_LOADING));
	/** Temporary blockers: an item refused only for these waits instead of failing. */
	static final Set<Reason> TEMPORARY = Set.of(Reason.PLAYER_IN_BOX, Reason.OCCUPIED, Reason.NOT_LOADED);

	private static final Map<String, QBatch> BATCHES = new LinkedHashMap<>();
	private static int next = 1;
	private static long tick;
	private static final Map<String, Long> LAST_PROGRESS = new HashMap<>();
	private static final Set<String> CHANGED = new HashSet<>();
	/** Chunk tickets held, per batch, per item (or job) key. */
	private static final Map<String, Map<String, Set<Long>>> TICKETS = new HashMap<>();
	private static final Map<String, List<CompletableFuture<QBatch>>> CANCELLED = new HashMap<>();

	private Batches() {
	}

	static void init() {
		// the ticket type registers with the class (during mod init, before the registries freeze)
		Architect.LOGGER.debug("placement ticket {}", TICKET);
	}

	// ------------------------------------------------------------------ reads

	public static @Nullable QBatch get(String id) {
		return BATCHES.get(id);
	}

	public static List<QBatch> all() {
		return List.copyOf(BATCHES.values());
	}

	static boolean anyRunning() {
		for (QBatch b : BATCHES.values()) {
			if (b.running()) {
				return true;
			}
		}
		return false;
	}

	static int running() {
		return (int) BATCHES.values().stream().filter(QBatch::running).count();
	}

	static int nextNumber() {
		return next;
	}

	// ------------------------------------------------------------------ queue

	/**
	 * Queues a batch (docs/CONTRACT.md phase 4d). Refuses the whole batch with an {@link IllegalArgumentException} for the
	 * rules {@link BatchRules#plan} checks, an id in use, or a group that is gone. Items the world refuses for good (an unknown
	 * design, an actorless INSTANT where it isn't allowed) fail at once. Returns the batch id. Server thread.
	 */
	public static String queue(MinecraftServer server, Batch spec) {
		String id = spec.id() != null && !spec.id().isBlank() ? spec.id() : newId();
		if (BATCHES.containsKey(id)) {
			throw new IllegalArgumentException("batch id " + id + " is in use");
		}
		SiteGroupRec g = spec.group() == null ? null : Sites.group(spec.group());
		if (spec.group() != null && g == null) {
			throw new IllegalArgumentException("no site group " + spec.group());
		}
		if (g != null && !SiteGroupRec.ACTIVE.equals(g.state())) {
			throw new IllegalArgumentException("site group " + g.id() + " is " + g.state() + "; it takes no more sites");
		}
		List<BatchRules.ItemSpec> specs = new ArrayList<>();
		for (Batch.Item it : spec.items()) {
			specs.add(new BatchRules.ItemSpec(it.itemKey(), it.stage(), it.after()));
		}
		List<BatchRules.StageSpec> stageSpecs = spec.stages().stream().map(s -> new BatchRules.StageSpec(s.name(), s.items())).toList();
		BatchRules.StagePlan plan = BatchRules.plan(id, specs, stageSpecs, g == null ? List.of() : g.stageNames(), g != null, g == null ? null : g.owner(),
			spec.owner());
		boolean survival = SurvivalWorld.on();
		boolean creative = server.getDefaultGameType() == GameType.CREATIVE;
		List<QItem> items = new ArrayList<>();
		for (Batch.Item it : spec.items()) {
			var r = it.request();
			JsonObject ext = spec.ext().deepCopy();
			r.ext().entrySet().forEach(e -> ext.add(e.getKey(), e.getValue().deepCopy()));
			boolean construction = ApiRules.construction(r.mode(), survival);
			ServerPlayer actor = r.actor();
			QItem q = new QItem(it.itemKey(), plan.stageOf().get(it.itemKey()), it.after(), r.blueprintId(), Sites.dimensionId(r.level()), r.origin().getX(),
				r.origin().getY(), r.origin().getZ(), r.rotation().ordinal(), r.force(), ext, actor == null ? null : actor.getStringUUID(), construction,
				survival);
			if (Blueprints.get(r.blueprintId()) == null) {
				q.fail(Reason.UNKNOWN_BLUEPRINT.name(), "No design " + r.blueprintId() + " in the library");
			} else if (!construction) {
				String no = instantRefusal(r.mode(), survival, creative, actor);
				if (no != null) {
					q.fail(Reason.NOT_ALLOWED.name(), no);
				}
			}
			items.add(q);
		}
		Batch.WaitPolicy w = spec.waitPolicy();
		int[] crateAt = spec.crateAt() == null ? null : new int[] {spec.crateAt().getX(), spec.crateAt().getY(), spec.crateAt().getZ()};
		if (spec.sharedCrate() && crateAt == null && (g == null || g.crate() == null && g.crateAt() == null)) {
			crateAt = defaultCrate(server, spec, items);
		}
		String groupId = g != null ? g.id() : Sites.newGroupId();
		QBatch b = new QBatch(id, spec.owner(), spec.ext(), groupId, items, plan.stages(), (long) w.maxWaitSeconds() * 20L, spec.load().maxChunks(),
			spec.nearestFirst(), spec.stopOnFailure(), spec.autoApprove(), spec.sharedCrate(), crateAt, System.currentTimeMillis());
		// the group: new, or grown by this batch's stages (in the order given, after the group's own)
		List<SiteGroupRec.StageRec> stages = new ArrayList<>(g == null ? List.of() : g.stages());
		List<SiteGroupRec.StageRec> added = new ArrayList<>();
		for (String st : plan.stages()) {
			List<String> keys = items.stream().filter(i -> i.stage.equals(st)).map(i -> i.key).toList();
			Stage.State state = st.equals(id) || spec.autoApprove() ? Stage.State.APPROVED : Stage.State.PLANNED;
			SiteGroupRec.StageRec rec = new SiteGroupRec.StageRec(st, keys, state, List.of(), id);
			stages.add(rec);
			added.add(rec);
		}
		SiteGroupRec grp = g != null ? g.withStages(stages)
			: new SiteGroupRec(groupId, spec.owner(), spec.ext(), List.of(), stages, SiteGroupRec.ACTIVE, spec.sharedCrate(), null, crateAt,
				System.currentTimeMillis());
		if (g != null && spec.sharedCrate() && !g.sharedCrate()) {
			grp = grp.withSharedCrate(true, crateAt);
		}
		Sites.putGroup(server, grp);
		BATCHES.put(id, b);
		Placement.save(server, false);
		Architect.LOGGER.info("Queued batch {} ({} item(s), stages {}) into group {}{}", id, items.size(), plan.stages(), groupId,
			g == null ? "" : " (appended)");
		for (SiteGroupRec.StageRec st : added) {
			ApiEvents.stageState(groupId, st);
		}
		for (QItem q : items) {
			if (q.status == QItem.Status.FAILED) {
				ApiEvents.itemFailed(b, q);
			}
		}
		CHANGED.add(id);
		return id;
	}

	/**
	 * The shared crate's cell when the batch names none (R6): beside the first construction item's approach end, outside every
	 * item's predicted restore box and every standing site's ({@link CratePlacement}). Refuses the batch when there is none.
	 */
	private static int @Nullable [] defaultCrate(MinecraftServer server, Batch spec, List<QItem> items) {
		Batch.Item first = null;
		for (int k = 0; k < items.size(); k++) {
			if (items.get(k).construction && items.get(k).status != QItem.Status.FAILED) {
				first = spec.items().get(k);
				break;
			}
		}
		if (first == null) {
			return null;
		}
		List<Anchors.Bounds> boxes = new ArrayList<>();
		Sites.Prediction start = null;
		for (Batch.Item it : spec.items()) {
			Blueprint bp = Blueprints.get(it.request().blueprintId());
			if (bp == null) {
				continue;
			}
			Sites.Prediction p = Sites.predict(it.request().level(), bp, it.request().origin(), it.request().rotation());
			boxes.add(p.snapBox());
			if (it == first) {
				start = p;
			}
		}
		String dim = Sites.dimensionId(first.request().level());
		for (Site s : Sites.all()) {
			if (s.dimension().equals(dim)) {
				boxes.add(s.restoreBox());
			}
		}
		int[] c = start == null ? null : CratePlacement.choose(start.end(), start.out(), boxes);
		if (c == null) {
			throw new IllegalArgumentException("OTHER: no free cell for the shared crate within " + CratePlacement.MAX_STEPS
				+ " cells of " + first.itemKey() + "'s approach end (every candidate lies in an item's restore box); pass crateAt");
		}
		Architect.LOGGER.info("Shared crate of the batch: {} (beside {}'s approach end)", java.util.Arrays.toString(c), first.itemKey());
		return c;
	}

	/**
	 * The actor rule of a queued INSTANT item (MUST 3 of Steward's 4d review): without an actor, only where an actorless
	 * INSTANT is allowed (a creative world, or the survival toggle off); with one, the phase 4a rule (permission level 2 in a
	 * survival world). Null = allowed.
	 */
	static @Nullable String instantRefusal(Mode mode, boolean survival, boolean creativeWorld, @Nullable ServerPlayer actor) {
		if (!survival) {
			return null;
		}
		if (actor == null) {
			return creativeWorld ? null : "Instant placement in a survival world needs an actor with permission level 2 (or a creative world); none was given";
		}
		return ApiRules.modeRefusal(Mode.INSTANT, true, true, actor.createCommandSourceStack().permissions().hasPermission(
			net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER));
	}

	private static String newId() {
		while (BATCHES.containsKey("b" + next)) {
			next++;
		}
		return "b" + next++;
	}

	// ------------------------------------------------------------------ the tick

	static void tick(MinecraftServer server, long deadline) {
		tick++;
		for (QBatch b : List.copyOf(BATCHES.values())) {
			if (!b.running()) {
				continue;
			}
			try {
				tick(server, b, deadline);
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Batch {} tick failed", b.id, e);
			}
		}
	}

	private static void tick(MinecraftServer server, QBatch b, long deadline) {
		if (b.cancelling) {
			if (!hasJob(b)) {
				finishCancel(server, b);
			}
			return;
		}
		// INSTANT items queued while the survival toggle was off are not converted when it is switched on (MUST 3)
		if (SurvivalWorld.on()) {
			for (QItem i : b.items) {
				if (!i.construction && !i.survivalAtQueue && (i.status == QItem.Status.QUEUED || i.status == QItem.Status.WAITING)) {
					fail(b, i, Reason.NOT_ALLOWED, "survival was switched on after this was queued; queue it again");
				}
			}
		}
		for (QItem i : b.items) {
			if (i.status == QItem.Status.QUEUED || i.status == QItem.Status.WAITING) {
				QItem d = BatchRules.failedDependency(b, i);
				if (d != null) {
					fail(b, i, Reason.OTHER, "it comes after " + d.key + ", which failed");
				}
			}
		}
		if (b.stopOnFailure && b.items.stream().anyMatch(i -> i.status == QItem.Status.FAILED && !Reason.CANCELLED.name().equals(i.reason))) {
			QItem f = b.items.stream().filter(i -> i.status == QItem.Status.FAILED && !Reason.CANCELLED.name().equals(i.reason)).findFirst().orElseThrow();
			stop(server, b, "stopped: " + f.key + " failed (" + f.message + ")");
			return;
		}
		String running = settleStages(server, b);
		SiteGroupRec g = Sites.group(b.group);
		Stage.State rs = running == null || g == null || g.stage(running) == null ? null : g.stage(running).state();
		boolean approved = rs == Stage.State.APPROVED || rs == Stage.State.PLACING;
		QItem item = BatchRules.next(b, running, approved, tick, i -> distance(server, i));
		if (item != null) {
			tryStart(server, b, item);
		}
		if (BatchRules.allDone(b) && !hasJob(b) && stagesDone(b)) {
			finish(server, b, QBatch.Status.DONE, "");
			return;
		}
		progress(b);
	}

	/**
	 * Finishes the group's running stages that belong to this batch and have nothing left to place (PLACED or PARTIAL), and
	 * returns the group's running stage (the first not finished), or null.
	 */
	private static @Nullable String settleStages(MinecraftServer server, QBatch b) {
		for (int guard = 0; guard < 64; guard++) {
			SiteGroupRec g = Sites.group(b.group);
			if (g == null) {
				return null;
			}
			int r = StageRules.running(g.stageStates());
			if (r < 0) {
				return null;
			}
			SiteGroupRec.StageRec st = g.stages().get(r);
			if (!b.id.equals(st.batchId()) || !(st.state() == Stage.State.APPROVED || st.state() == Stage.State.PLACING)) {
				return st.name();
			}
			int[] c = BatchRules.counts(b, st.name());
			boolean busy = b.inStage(st.name()).stream().anyMatch(i -> !i.status.terminal());
			if (busy) {
				return st.name();
			}
			setStage(server, g, st.name(), StageRules.finish(c[0], c[2]));
		}
		return null;
	}

	private static boolean stagesDone(QBatch b) {
		SiteGroupRec g = Sites.group(b.group);
		if (g == null) {
			return true;
		}
		for (SiteGroupRec.StageRec st : g.stages()) {
			if (st.batchId().equals(b.id) && !st.state().terminal()) {
				return false;
			}
		}
		return true;
	}

	static void setStage(MinecraftServer server, SiteGroupRec g, String stage, Stage.State state) {
		SiteGroupRec.StageRec was = g.stage(stage);
		if (was == null || was.state() == state) {
			return;
		}
		SiteGroupRec n = g.withStage(stage, s -> s.withState(state));
		Sites.putGroup(server, n);
		Architect.LOGGER.info("Group {}: stage {} {} -> {}", g.id(), stage, StageRules.name(was.state()), StageRules.name(state));
		ApiEvents.stageState(g.id(), n.stage(stage));
	}

	private static boolean hasJob(QBatch b) {
		for (Placement.Job j : Placement.jobs()) {
			if (b.id.equals(j.batchId())) {
				return true;
			}
		}
		return false;
	}

	/** Horizontal distance from an item's box centre to the nearest player in its dimension (0 with none). */
	private static double distance(MinecraftServer server, QItem i) {
		Blueprint bp = Blueprints.get(i.blueprint);
		int sx = bp == null ? 1 : BlueprintTransform.rotatedSizeX(bp.sizeX(), bp.sizeZ(), i.turns);
		int sz = bp == null ? 1 : BlueprintTransform.rotatedSizeZ(bp.sizeX(), bp.sizeZ(), i.turns);
		double cx = i.x + sx / 2.0;
		double cz = i.z + sz / 2.0;
		double best = Double.MAX_VALUE;
		for (ServerPlayer p : server.getPlayerList().getPlayers()) {
			if (!Sites.dimensionId(p.level()).equals(i.dimension)) {
				continue;
			}
			double dx = p.getX() - cx;
			double dz = p.getZ() - cz;
			best = Math.min(best, dx * dx + dz * dz);
		}
		return best == Double.MAX_VALUE ? 0 : Math.sqrt(best);
	}

	/** Checks an item and starts it, makes it wait, or fails it. */
	private static void tryStart(MinecraftServer server, QBatch b, QItem i) {
		ServerLevel level = Sites.levelOf(server, i.dimension);
		if (level == null) {
			fail(b, i, Reason.NOT_LOADED, i.dimension + " is not loaded");
			return;
		}
		Blueprint bp = Blueprints.get(i.blueprint);
		if (bp == null) {
			fail(b, i, Reason.UNKNOWN_BLUEPRINT, "No design " + i.blueprint + " in the library");
			return;
		}
		BlockPos origin = new BlockPos(i.x, i.y, i.z);
		Rotation rot = Rotation.values()[Math.floorMod(i.turns, 4)];
		if (b.loadChunks > 0) {
			ticketItem(server, b, i, level, bp);
		}
		Sites.Verdict v = Sites.verdict(level, bp, origin, rot, i.force, null, true, i.construction);
		if (!v.ok()) {
			Sites.Refusal hard = v.typed().stream().filter(r -> !TEMPORARY.contains(r.reason())).findFirst().orElse(null);
			if (hard != null) {
				fail(b, i, hard.reason(), hard.message());
			} else {
				Sites.Refusal t = v.typed().get(0);
				waitFor(b, i, t.reason(), t.message());
			}
			return;
		}
		// the cells around the box a placement reads and writes (held leaves, edge shape updates) must be loaded too
		Anchors.Bounds snap = v.snapshotBox();
		if (snap != null && !loaded(level, snap.grow(LeafGuard.RADIUS + 1))) {
			waitFor(b, i, Reason.NOT_LOADED, "the area around the site is not loaded on the server (walk closer)");
			return;
		}
		Site.Member member = new Site.Member(b.group, b.id, i.key);
		try {
			if (i.construction) {
				Site s;
				Builder.SHARED_CRATE.set(b.sharedCrate || groupShared(b) ? b.group : null);
				try {
					s = Sites.place(level, bp, origin, rot, i.force, i.actor, true, b.owner, i.ext, null, member);
				} finally {
					Builder.SHARED_CRATE.remove();
				}
				i.siteId = s.id();
				startStage(server, b, i);
				placedItem(server, b, i);
			} else {
				PlaceJob job = Sites.beginPlacing(level, bp, origin, rot, i.force, b.owner, i.ext, member);
				i.status = QItem.Status.PLACING;
				i.siteId = job.siteId;
				i.reason = null;
				i.message = "";
				startStage(server, b, i);
				untickItem(server, b, i.key);
				ticketJob(server, b, i, level, job.snapBox);
				Placement.add(server, job);
				CHANGED.add(b.id);
			}
		} catch (Sites.SiteException e) {
			if (TEMPORARY.contains(e.reason())) {
				waitFor(b, i, e.reason(), e.getMessage());
			} else {
				fail(b, i, e.reason(), e.getMessage());
			}
		}
	}

	private static boolean groupShared(QBatch b) {
		SiteGroupRec g = Sites.group(b.group);
		return g != null && g.sharedCrate();
	}

	private static void startStage(MinecraftServer server, QBatch b, QItem i) {
		SiteGroupRec g = Sites.group(b.group);
		SiteGroupRec.StageRec st = g == null ? null : g.stage(i.stage);
		if (st != null && st.state() == Stage.State.APPROVED) {
			setStage(server, g, i.stage, StageRules.start(st.state()));
		}
	}

	private static boolean loaded(ServerLevel level, Anchors.Bounds box) {
		for (int cx = box.minX() >> 4; cx <= box.maxX() >> 4; cx++) {
			for (int cz = box.minZ() >> 4; cz <= box.maxZ() >> 4; cz++) {
				if (!level.hasChunk(cx, cz)) {
					return false;
				}
			}
		}
		return true;
	}

	private static void waitFor(QBatch b, QItem i, Reason why, String msg) {
		boolean first = i.status != QItem.Status.WAITING;
		boolean changed = first || !why.name().equals(i.reason);
		if (!first) {
			i.waited += RECHECK;
		}
		if (i.waited >= b.maxWaitTicks) {
			fail(b, i, Reason.TIMED_OUT, "waited " + i.waited / 20 + " s for: " + msg);
			return;
		}
		i.status = QItem.Status.WAITING;
		i.reason = why.name();
		i.message = msg;
		i.nextCheck = tick + RECHECK;
		CHANGED.add(b.id);
		if (changed) {
			ApiEvents.itemWaiting(b, i);
		}
	}

	private static void fail(QBatch b, QItem i, Reason why, String msg) {
		i.fail(why.name(), msg);
		CHANGED.add(b.id);
		MinecraftServer srv = serverOf();
		if (srv != null) {
			untickItem(srv, b, i.key);
			Placement.save(srv, false);
		}
		Architect.LOGGER.info("Batch {}: item {} failed ({}): {}", b.id, i.key, why, msg);
		ApiEvents.itemFailed(b, i);
	}

	private static void placedItem(MinecraftServer server, QBatch b, QItem i) {
		i.status = QItem.Status.PLACED;
		i.reason = null;
		i.message = "";
		CHANGED.add(b.id);
		untickItem(server, b, i.key);
		untickItem(server, b, "job:" + i.key);
		Placement.save(server, false);
		ApiEvents.itemPlaced(b, i);
	}

	private static void progress(QBatch b) {
		if (!CHANGED.contains(b.id)) {
			return;
		}
		Long last = LAST_PROGRESS.get(b.id);
		if (last != null && tick - last < PROGRESS_TICKS) {
			return;
		}
		LAST_PROGRESS.put(b.id, tick);
		CHANGED.remove(b.id);
		ApiEvents.batchProgress(b);
	}

	private static void finish(MinecraftServer server, QBatch b, QBatch.Status status, String note) {
		b.status = status;
		b.doneAt = System.currentTimeMillis();
		b.note = note;
		b.cancelling = false;
		untickBatch(server, b);
		Placement.save(server, false);
		Architect.LOGGER.info("Batch {} {}: {} placed, {} failed{}", b.id, status.name().toLowerCase(java.util.Locale.ROOT),
			b.items.stream().filter(i -> i.status == QItem.Status.PLACED).count(), b.items.stream().filter(i -> i.status == QItem.Status.FAILED).count(),
			note.isEmpty() ? "" : " (" + note + ")");
		ApiEvents.batchProgress(b);
		ApiEvents.batchDone(b);
		List<CompletableFuture<QBatch>> fs = CANCELLED.remove(b.id);
		if (fs != null) {
			fs.forEach(f -> f.complete(b));
		}
	}

	// ------------------------------------------------------------------ job callbacks (Placement)

	/** A ticked placement completed: its item is placed. */
	static void placed(MinecraftServer server, PlaceJob job) {
		QBatch b = job.batchId == null ? null : BATCHES.get(job.batchId);
		QItem i = b == null || job.itemKey == null ? null : b.item(job.itemKey);
		if (i == null) {
			return;
		}
		placedItem(server, b, i);
	}

	/** A placing site was rolled back (a cancel, a broken job, or a crash: then its item queues again). */
	static void rolledBack(MinecraftServer server, RestoreJob job) {
		QBatch b = job.batchId == null ? null : BATCHES.get(job.batchId);
		QItem i = b == null || job.itemKey == null ? null : b.item(job.itemKey);
		if (i == null) {
			return;
		}
		untickItem(server, b, "job:" + i.key);
		if (job.requeue && b.running() && !b.cancelling) {
			i.status = QItem.Status.QUEUED;
			i.siteId = null;
			i.reason = null;
			i.message = "";
			CHANGED.add(b.id);
			Architect.LOGGER.info("Batch {}: item {} queued again after its rollback", b.id, i.key);
			return;
		}
		if (i.status == QItem.Status.PLACING) {
			boolean cancel = b.cancelling;
			fail(b, i, cancel ? Reason.CANCELLED : Reason.OTHER, cancel ? "cancelled: rolled back from its snapshot"
				: "rolled back: " + (job.why.isEmpty() ? "it could not be placed" : job.why));
		}
	}

	/** Remove during placing took the job out (the site was restored at once). */
	static void aborted(MinecraftServer server, PlaceJob job, String why) {
		QBatch b = job.batchId == null ? null : BATCHES.get(job.batchId);
		QItem i = b == null || job.itemKey == null ? null : b.item(job.itemKey);
		if (i != null && i.status == QItem.Status.PLACING) {
			untickItem(server, b, "job:" + i.key);
			fail(b, i, Reason.CANCELLED, why);
		}
	}

	// ------------------------------------------------------------------ cancel / stop

	/**
	 * Cancels a running batch (SHOULD 6 of Steward's 4d review): items not started fail CANCELLED at once, the item being
	 * placed is rolled back over ticks, placed items stay. Completes when the batch is CANCELLED (BATCH_DONE fired). Server thread.
	 */
	public static CompletableFuture<QBatch> cancel(MinecraftServer server, String id) {
		QBatch b = BATCHES.get(id);
		if (b == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("no batch " + id));
		}
		if (!b.running()) {
			return CompletableFuture.completedFuture(b);
		}
		CompletableFuture<QBatch> f = new CompletableFuture<>();
		CANCELLED.computeIfAbsent(id, k -> new ArrayList<>()).add(f);
		if (!b.cancelling) {
			drop(server, b, "cancelled", true);
		}
		if (!hasJob(b)) {
			finishCancel(server, b);
		}
		return f;
	}

	private static void stop(MinecraftServer server, QBatch b, String why) {
		b.note = why;
		drop(server, b, why, false);
		b.stopping = true;
		if (!hasJob(b)) {
			finishCancel(server, b);
		}
	}

	private static void drop(MinecraftServer server, QBatch b, String why, boolean rollBackPlacing) {
		List<QItem> dropped = BatchRules.cancel(b, why);
		for (QItem q : dropped) {
			untickItem(server, b, q.key);
			ApiEvents.itemFailed(b, q);
		}
		QItem placing = b.placing();
		if (placing != null && placing.siteId != null && rollBackPlacing) {
			Placement.rollBack(server, placing.siteId, why);
		}
		// a stop lets the item being placed finish (it is not half-placed); a cancel rolls it back
		Placement.save(server, false);
	}

	private static void finishCancel(MinecraftServer server, QBatch b) {
		SiteGroupRec g = Sites.group(b.group);
		if (g != null) {
			for (SiteGroupRec.StageRec st : g.stages()) {
				if (st.batchId().equals(b.id) && !st.state().terminal()) {
					int[] c = BatchRules.counts(b, st.name());
					setStage(server, Sites.group(b.group), st.name(), StageRules.cancelled(st.state(), c[0]));
				}
			}
		}
		finish(server, b, b.stopping ? QBatch.Status.STOPPED : QBatch.Status.CANCELLED, b.note.isEmpty() ? "cancelled" : b.note);
	}

	/** A stage was skipped: its items not started fail CANCELLED. */
	static void skipped(MinecraftServer server, String batchId, String stage) {
		QBatch b = BATCHES.get(batchId);
		if (b == null) {
			return;
		}
		for (QItem q : BatchRules.skip(b, stage)) {
			untickItem(server, b, q.key);
			ApiEvents.itemFailed(b, q);
		}
		CHANGED.add(b.id);
		Placement.save(server, false);
	}

	// ------------------------------------------------------------------ chunk tickets

	private static Set<Long> chunks(Anchors.Bounds box) {
		Set<Long> out = new LinkedHashSet<>();
		for (int cx = box.minX() >> 4; cx <= box.maxX() >> 4; cx++) {
			for (int cz = box.minZ() >> 4; cz <= box.maxZ() >> 4; cz++) {
				out.add(ChunkPos.pack(cx, cz));
			}
		}
		return out;
	}

	/** LOAD_BOUNDED: tickets for the chunks an item may touch, while the batch holds at most {@code loadChunks}. */
	private static void ticketItem(MinecraftServer server, QBatch b, QItem i, ServerLevel level, Blueprint bp) {
		Map<String, Set<Long>> held = TICKETS.computeIfAbsent(b.id, k -> new HashMap<>());
		if (held.containsKey(i.key)) {
			return;
		}
		int sx = BlueprintTransform.rotatedSizeX(bp.sizeX(), bp.sizeZ(), i.turns);
		int sz = BlueprintTransform.rotatedSizeZ(bp.sizeX(), bp.sizeZ(), i.turns);
		int m = LotFitting.frontMargin(bp) + LeafGuard.RADIUS + 1;
		Set<Long> want = chunks(new Anchors.Bounds(i.x - m, i.y, i.z - m, i.x + sx - 1 + m, i.y + bp.sizeY() - 1, i.z + sz - 1 + m));
		int count = held.values().stream().mapToInt(Set::size).sum();
		if (count + want.size() > b.loadChunks) {
			return; // over the bound: it waits for a player like LOADED_ONLY
		}
		for (long c : want) {
			level.getChunkSource().addTicketWithRadius(TICKET, ChunkPos.unpack(c), 0);
		}
		held.put(i.key, want);
		levels.put(b.id + "/" + i.key, i.dimension);
	}

	/** While a job writes, its chunks (and the ring around them) stay loaded. */
	private static void ticketJob(MinecraftServer server, QBatch b, QItem i, ServerLevel level, Anchors.Bounds snap) {
		Set<Long> want = chunks(snap.grow(LeafGuard.RADIUS + 1));
		for (long c : want) {
			level.getChunkSource().addTicketWithRadius(TICKET, ChunkPos.unpack(c), 0);
		}
		TICKETS.computeIfAbsent(b.id, k -> new HashMap<>()).put("job:" + i.key, want);
		levels.put(b.id + "/job:" + i.key, i.dimension);
	}

	private static final Map<String, String> levels = new HashMap<>();

	private static void untickItem(MinecraftServer server, QBatch b, String key) {
		Map<String, Set<Long>> held = TICKETS.get(b.id);
		Set<Long> cs = held == null ? null : held.remove(key);
		String dim = levels.remove(b.id + "/" + key);
		ServerLevel level = dim == null ? null : Sites.levelOf(server, dim);
		if (cs == null || level == null) {
			return;
		}
		for (long c : cs) {
			level.getChunkSource().removeTicketWithRadius(TICKET, ChunkPos.unpack(c), 0);
		}
	}

	private static void untickBatch(MinecraftServer server, QBatch b) {
		Map<String, Set<Long>> held = TICKETS.get(b.id);
		if (held == null) {
			return;
		}
		for (String k : List.copyOf(held.keySet())) {
			untickItem(server, b, k);
		}
		TICKETS.remove(b.id);
	}

	// ------------------------------------------------------------------ persistence

	static JsonArray toJson() {
		JsonArray a = new JsonArray();
		BATCHES.values().forEach(b -> a.add(b.toJson()));
		return a;
	}

	static void load(JsonArray a, int nextNumber) {
		BATCHES.clear();
		for (JsonElement e : a) {
			try {
				QBatch b = QBatch.fromJson(e.getAsJsonObject());
				BATCHES.put(b.id, b);
			} catch (RuntimeException ex) {
				Architect.LOGGER.warn("Could not read a queued batch {}", e, ex);
			}
		}
		next = Math.max(nextNumber, 1);
		for (String id : BATCHES.keySet()) {
			next = Math.max(next, Site.number(id, 'b') + 1);
		}
		// a job that was running resumes (Placement); a waiting item is checked at once
	}

	static void reset() {
		BATCHES.clear();
		LAST_PROGRESS.clear();
		CHANGED.clear();
		TICKETS.clear();
		levels.clear();
		CANCELLED.values().forEach(fs -> fs.forEach(f -> f.completeExceptionally(new IllegalStateException("the world stopped"))));
		CANCELLED.clear();
		next = 1;
		tick = 0;
	}

	private static @Nullable MinecraftServer serverOf() {
		return Placement.server();
	}
}
