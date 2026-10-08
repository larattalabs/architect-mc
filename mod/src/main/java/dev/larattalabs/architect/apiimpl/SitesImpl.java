package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Batch;
import dev.larattalabs.architect.api.BatchView;
import dev.larattalabs.architect.api.FitOptions;
import dev.larattalabs.architect.api.LotFit;
import dev.larattalabs.architect.api.OverlapMargin;
import dev.larattalabs.architect.api.PlaceRequest;
import dev.larattalabs.architect.api.SiteGroup;
import dev.larattalabs.architect.api.Stage;
import dev.larattalabs.architect.api.Stock;
import dev.larattalabs.architect.batch.LotFitting;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.site.Batches;
import dev.larattalabs.architect.site.Groups;
import dev.larattalabs.architect.site.SiteGroupRec;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import dev.larattalabs.architect.api.PlaceResult;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.api.RemoveOptions;
import dev.larattalabs.architect.api.RemoveResult;
import dev.larattalabs.architect.api.SiteView;
import dev.larattalabs.architect.api.Verdict;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.TemplateGrid;
import dev.larattalabs.architect.site.Builder;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.Sites;
import dev.larattalabs.architect.survival.SurvivalWorld;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/** {@link dev.larattalabs.architect.api.Sites} over the internal {@link Sites}. Internal. */
final class SitesImpl implements dev.larattalabs.architect.api.Sites {
	private final MinecraftServer server;

	SitesImpl(MinecraftServer server) {
		this.server = server;
	}

	@Override
	public List<SiteView> list() {
		List<SiteView> out = new ArrayList<>(Sites.all().stream().map(s -> Views.site(server, s)).toList());
		dev.larattalabs.architect.site.Infras.all().forEach(i -> out.add(Views.infra(i)));
		return out;
	}

	@Override
	public List<SiteView> list(@Nullable String owner) {
		return list().stream().filter(s -> ApiRules.ownerMatches(s.owner(), owner)).toList();
	}

	@Override
	public Optional<SiteView> get(String siteId) {
		Site s = Sites.get(siteId);
		if (s != null) {
			return Optional.of(Views.site(server, s));
		}
		dev.larattalabs.architect.site.Infra i = dev.larattalabs.architect.site.Infras.get(siteId);
		return i == null ? Optional.empty() : Optional.of(Views.infra(i));
	}

	/** Runs on the server thread: now when already there, else queued. */
	private <T> CompletableFuture<T> onServer(Supplier<T> work) {
		if (server.isSameThread()) {
			try {
				return CompletableFuture.completedFuture(work.get());
			} catch (Throwable t) {
				return CompletableFuture.failedFuture(t);
			}
		}
		return CompletableFuture.supplyAsync(work, server);
	}

	static boolean permission2(@Nullable ServerPlayer p) {
		return p != null && p.createCommandSourceStack().permissions().hasPermission(net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER);
	}

	private static boolean layer(PlaceRequest r) {
		return r.overlap() == dev.larattalabs.architect.api.OverlapPolicy.LAYER;
	}

	/** The checks before the world is touched: design, actor rule, the dry-run verdict. Empty = place it. */
	private List<Refusal> precheck(PlaceRequest r, boolean construction, @Nullable Blueprint bp, Sites.@Nullable Verdict[] out) {
		if (bp == null) {
			return List.of(new Refusal(Reason.UNKNOWN_BLUEPRINT, "No design " + r.blueprintId() + " in the library"));
		}
		String no = ApiRules.modeRefusal(r.mode(), SurvivalWorld.on(), r.actor() != null, permission2(r.actor()));
		if (no != null) {
			return List.of(new Refusal(Reason.NOT_ALLOWED, no));
		}
		// the dry run first: it never loads a chunk, and it lists every reason, not only the first
		Sites.Verdict v = Sites.verdict(r.level(), bp, r.origin(), r.rotation(), r.force(), null, true, construction, layer(r), r.owner());
		out[0] = v;
		return v.typed().stream().map(x -> new Refusal(x.reason(), x.message())).toList();
	}

	@Override
	public CompletableFuture<PlaceResult> place(PlaceRequest r) {
		return onServer(() -> {
			boolean construction = ApiRules.construction(r.mode(), SurvivalWorld.on());
			Blueprint bp = Blueprints.get(r.blueprintId());
			List<Refusal> refused = precheck(r, construction, bp, new Sites.Verdict[1]);
			if (!refused.isEmpty()) {
				ApiEvents.placeFailed(r, refused);
				return new PlaceResult(false, Optional.empty(), refused, List.of());
			}
			try {
				Site s = Sites.place(r.level(), bp, r.origin(), r.rotation(), r.force(), r.actor() == null ? null : r.actor().getStringUUID(),
					construction, r.owner(), r.ext(), r.actor(), null, layer(r));
				String note = Sites.lastNote();
				return new PlaceResult(true, Optional.of(s.id()), List.of(), note == null ? List.of() : Arrays.asList(note.split("; ")));
			} catch (Sites.SiteException e) {
				return new PlaceResult(false, Optional.empty(), List.of(new Refusal(e.reason(), e.getMessage())), List.of());
			}
		});
	}

	@Override
	public Verdict check(PlaceRequest r) {
		boolean construction = ApiRules.construction(r.mode(), SurvivalWorld.on());
		Blueprint bp = Blueprints.get(r.blueprintId());
		Sites.Verdict[] v = new Sites.Verdict[1];
		List<Refusal> refused = precheck(r, construction, bp, v);
		Map<String, Integer> bom = Map.of();
		if (construction && bp != null) {
			TemplateGrid grid = TemplateGrid.of(bp.id());
			bom = grid == null ? Map.of() : Builder.templateBom(grid);
		}
		Anchors.Bounds box = v[0] == null ? null : v[0].box();
		Anchors.Bounds snap = v[0] == null ? null : v[0].snapshotBox();
		return new Verdict(refused, v[0] == null ? List.of() : v[0].notes(), construction, Views.items(bom),
			Optional.ofNullable(box).map(Views::box), Optional.ofNullable(snap).map(Views::box), v[0] == null ? List.of() : overlaps(v[0].overlaps(),
				refused), 0);
	}

	/** The overlapped sites per site: owner, cells, whether one of the refusals is about it. */
	static List<dev.larattalabs.architect.api.Overlap> overlaps(List<dev.larattalabs.architect.site.SiteJournal.Hit> hits, List<Refusal> refused) {
		java.util.Map<String, Integer> by = new java.util.LinkedHashMap<>();
		hits.forEach(h -> by.merge(h.site(), h.cells(), Integer::sum));
		boolean blocking = refused.stream().anyMatch(x -> x.reason() == Reason.OVERLAP || x.reason() == Reason.OVERLAP_BUSY
			|| x.reason() == Reason.OVERLAP_OWNED || x.reason() == Reason.LAYER_DEPTH);
		List<dev.larattalabs.architect.api.Overlap> out = new ArrayList<>();
		by.forEach((s, n) -> out.add(new dev.larattalabs.architect.api.Overlap(s, Sites.ownerOf(s), n, blocking)));
		return out;
	}

	static Sites.Covered covered(@Nullable RemoveOptions o) {
		if (o == null || o.covered() == null) {
			return Sites.Covered.KEEP;
		}
		return Sites.Covered.valueOf(o.covered().name());
	}

	@Override
	public CompletableFuture<RemoveResult> remove(String siteId, RemoveOptions o) {
		if (Sites.get(siteId) == null && dev.larattalabs.architect.site.Infras.get(siteId) != null) {
			return onServer(() -> removeInfra(siteId, o)).thenCompose(f -> f);
		}
		return onServer(() -> {
			Site s = Sites.get(siteId);
			if (s == null) {
				return CompletableFuture.completedFuture(refused("No site " + siteId));
			}
			String owner = ApiRules.removeRefusal(siteId, s.owner(), o == null ? null : o.requester(), o != null && o.force());
			if (owner != null) {
				return CompletableFuture.completedFuture(refused(owner));
			}
			ServerLevel level = Sites.levelOf(server, s);
			if (level == null) {
				return CompletableFuture.completedFuture(refused(s.dimension() + " is not loaded"));
			}
			if (!loaded(level, s.restoreBox())) {
				return CompletableFuture.completedFuture(refused(siteId + " is not loaded on the server (a player must be near it)"));
			}
			List<String> blockers = Sites.removalBlockers(level, s);
			if (!blockers.isEmpty()) {
				return CompletableFuture.completedFuture(new RemoveResult(false, blockers, Map.of()));
			}
			try {
				CompletableFuture<Sites.Removed> large = Sites.removeLarge(level, siteId, false, covered(o));
				if (large != null) {
					return large.thenApply(SitesImpl::result);
				}
				Sites.Removed done = Sites.removeDetailed(level, siteId, false, covered(o));
				return CompletableFuture.completedFuture(result(done));
			} catch (Sites.SiteException e) {
				return CompletableFuture.completedFuture(refused(e.getMessage()));
			}
		}).thenCompose(f -> f);
	}

	static RemoveResult result(Sites.Removed done) {
		return new RemoveResult(true, List.of(), Views.items(done.returned()), done.restored(), done.kept(), done.handedDown(), done.cascaded());
	}

	/** A road's or cell site's removal (over ticks): the owner rule, then the job. */
	private CompletableFuture<RemoveResult> removeInfra(String siteId, @Nullable RemoveOptions o) {
		dev.larattalabs.architect.site.Infra i = dev.larattalabs.architect.site.Infras.get(siteId);
		String owner = ApiRules.removeRefusal(siteId, i.owner(), o == null ? null : o.requester(), o != null && o.force());
		if (owner != null) {
			return CompletableFuture.completedFuture(refused(owner));
		}
		ServerLevel level = Sites.levelOf(server, i.dimension());
		if (level == null) {
			return CompletableFuture.completedFuture(refused(i.dimension() + " is not loaded"));
		}
		try {
			return dev.larattalabs.architect.site.InfraApi.remove(level, siteId, covered(o)).thenApply(SitesImpl::result);
		} catch (Sites.SiteException e) {
			return CompletableFuture.completedFuture(refused(e.getMessage()));
		}
	}

	private static RemoveResult refused(String why) {
		return new RemoveResult(false, new ArrayList<>(List.of(why)), Map.of());
	}

	private static boolean loaded(ServerLevel level, Anchors.Bounds b) {
		for (int cx = b.minX() >> 4; cx <= b.maxX() >> 4; cx++) {
			for (int cz = b.minZ() >> 4; cz <= b.maxZ() >> 4; cz++) {
				if (!level.hasChunk(cx, cz)) {
					return false;
				}
			}
		}
		return true;
	}

	@Override
	public dev.larattalabs.architect.api.SurvivalInfo survival() {
		return new dev.larattalabs.architect.api.SurvivalInfo(SurvivalWorld.on(), SurvivalWorld.blocksPerTick());
	}

	// ------------------------------------------------------------------ 1.4.0 (docs/CONTRACT.md phase 4d)

	@Override
	public CompletableFuture<String> queue(Batch batch) {
		return onServer(() -> Batches.queue(server, batch));
	}

	@Override
	public Optional<BatchView> batch(String batchId) {
		QBatch b = Batches.get(batchId);
		return b == null ? Optional.empty() : Optional.of(Views.batch(b));
	}

	@Override
	public List<BatchView> batches(@Nullable String owner) {
		return Batches.all().stream().filter(b -> ApiRules.ownerMatches(b.owner, owner)).map(Views::batch).toList();
	}

	@Override
	public CompletableFuture<BatchView> cancelBatch(String batchId) {
		return onServer(() -> Batches.cancel(server, batchId)).thenCompose(f -> f).thenApply(Views::batch);
	}

	@Override
	public List<SiteGroup> groups(@Nullable String owner) {
		return Sites.groups().stream().filter(g -> ApiRules.ownerMatches(g.owner(), owner)).map(Views::group).toList();
	}

	@Override
	public Optional<SiteGroup> group(String groupId) {
		SiteGroupRec g = Sites.group(groupId);
		return g == null ? Optional.empty() : Optional.of(Views.group(g));
	}

	@Override
	public CompletableFuture<RemoveResult> removeGroup(String groupId, RemoveOptions o) {
		return onServer(() -> Groups.removeGroup(server, groupId, o == null ? null : o.requester(), o != null && o.force(), covered(o))).thenCompose(f -> f)
			.thenApply(SitesImpl::result);
	}

	@Override
	public Stage approveStage(String groupId, String stage) {
		return Views.stage(Groups.approve(server, groupId, stage));
	}

	@Override
	public Stage skipStage(String groupId, String stage) {
		return Views.stage(Groups.skip(server, groupId, stage));
	}

	@Override
	public List<Stage> reorderStages(String groupId, List<String> names) {
		return Groups.reorder(server, groupId, names).stages().stream().map(Views::stage).toList();
	}

	@Override
	public CompletableFuture<RemoveResult> undoStage(String groupId, String stage, boolean force) {
		return onServer(() -> Groups.undoStage(server, groupId, stage, force, Sites.Covered.KEEP)).thenCompose(f -> f).thenApply(SitesImpl::result);
	}

	@Override
	public CompletableFuture<RemoveResult> undoStage(String groupId, String stage, RemoveOptions o) {
		return onServer(() -> Groups.undoStage(server, groupId, stage, o != null && o.force(), covered(o))).thenCompose(f -> f).thenApply(SitesImpl::result);
	}

	private static RemoveResult result(Groups.Removed r) {
		return new RemoveResult(r.removed(), r.blockers(), Views.items(r.refund()), r.restored(), 0, r.handedDown(), r.cascaded());
	}

	@Override
	public Stock stock(String groupId) {
		return Views.stock(server, groupId);
	}

	@Override
	public LotFit fitToLot(String blueprintId, BoundingBox lot, Direction streetSide, FitOptions o) {
		FitOptions opt = o == null ? FitOptions.DEFAULT : o;
		Blueprint bp = Blueprints.get(blueprintId);
		ServerLevel level = opt.level() != null ? opt.level() : server.overworld();
		Anchors.Bounds lb = new Anchors.Bounds(lot.minX(), lot.minY(), lot.minZ(), lot.maxX(), lot.maxY(), lot.maxZ());
		if (bp == null) {
			Verdict v = new Verdict(List.of(new Refusal(Reason.UNKNOWN_BLUEPRINT, "No design " + blueprintId + " in the library")), List.of(), false, Map.of(),
				Optional.empty(), Optional.empty());
			return new LotFit(new BlockPos(lot.minX(), lot.minY(), lot.minZ()), Rotation.NONE, lot, Optional.empty(), v);
		}
		if (streetSide == null || streetSide.getAxis().isVertical()) {
			throw new IllegalArgumentException("streetSide must be north, east, south or west");
		}
		LotFitting.Fit f = LotFitting.fit(bp, lb, streetSide.getName(), opt.centreOn() == FitOptions.CentreOn.BOX, opt.setback(), opt.approachIntoStreet());
		BlockPos origin = new BlockPos(f.ox(), f.oy(), f.oz());
		Rotation rot = Rotation.values()[f.turns()];
		Verdict v;
		if (!f.fits()) {
			boolean construction = ApiRules.construction(opt.mode(), SurvivalWorld.on());
			v = new Verdict(List.of(new Refusal(Reason.LOT_TOO_SMALL, "The lot is too small for " + blueprintId + ": " + f.why())), List.of(), construction,
				Map.of(), Optional.of(Views.box(f.box())), Optional.empty());
		} else {
			v = check(new PlaceRequest(blueprintId, level, origin, rot, opt.mode(), null, new JsonObject(), opt.force(), opt.actor()));
		}
		return new LotFit(origin, rot, Views.box(f.box()), v.restoreBox(), v);
	}

	@Override
	public OverlapMargin overlapMargin(String blueprintId) {
		Blueprint bp = Blueprints.get(blueprintId);
		if (bp == null) {
			throw new IllegalArgumentException("No design " + blueprintId + " in the library");
		}
		return new OverlapMargin(LotFitting.frontMargin(bp), 0, 0);
	}

	// ------------------------------------------------------------------ 1.5.0 (docs/CONTRACT.md phase 4e)

	@Override
	public CompletableFuture<PlaceResult> placeRoad(dev.larattalabs.architect.api.RoadRequest r) {
		return onServer(() -> dev.larattalabs.architect.site.InfraApi.placeRoad(r)).thenCompose(f -> f);
	}

	@Override
	public Verdict checkRoad(dev.larattalabs.architect.api.RoadRequest r) {
		return dev.larattalabs.architect.site.InfraApi.checkRoad(r);
	}

	@Override
	public CompletableFuture<PlaceResult> placeCells(dev.larattalabs.architect.api.CellsRequest r) {
		return onServer(() -> dev.larattalabs.architect.site.InfraApi.placeCells(r)).thenCompose(f -> f);
	}

	@Override
	public Verdict checkCells(dev.larattalabs.architect.api.CellsRequest r) {
		return dev.larattalabs.architect.site.InfraApi.checkCells(r);
	}

	@Override
	public List<dev.larattalabs.architect.api.Layer> stack(net.minecraft.resources.ResourceKey<net.minecraft.world.level.Level> dimension, BlockPos pos) {
		return dev.larattalabs.architect.site.InfraApi.stack(dimension.identifier().toString(), pos);
	}

	// ------------------------------------------------------------------ phase 5b: delta apply

	/** Whether a delta by {@code actor} runs instantly: the survival toggle off, or an actor with permission level 2. */
	static boolean instantDelta(@Nullable ServerPlayer actor) {
		return !SurvivalWorld.on() || permission2(actor);
	}

	static dev.larattalabs.architect.site.SiteDeltas.Request deltaRequest(dev.larattalabs.architect.api.DeltaRequest r) {
		dev.larattalabs.architect.delta.DeltaPlanner.Edits e = r.playerEdits() == null ? dev.larattalabs.architect.delta.DeltaPlanner.Edits.KEEP
			: dev.larattalabs.architect.delta.DeltaPlanner.Edits.valueOf(r.playerEdits().name());
		return new dev.larattalabs.architect.site.SiteDeltas.Request(r.siteId(), r.toVersion(), e, r.overlap()
			== dev.larattalabs.architect.api.OverlapPolicy.LAYER, r.owner(), r.force());
	}

	@Override
	public dev.larattalabs.architect.api.DeltaVerdict checkDelta(dev.larattalabs.architect.api.DeltaRequest r) {
		Site b = Sites.get(r.siteId());
		ServerLevel level = b == null ? null : Sites.levelOf(server, b);
		if (level == null) {
			return Views.deltaVerdict(null, List.of(new Refusal(Reason.OTHER, b == null ? "No site " + r.siteId() : r.siteId() + "'s dimension is not "
				+ "loaded")), instantDelta(r.actor()));
		}
		boolean instant = instantDelta(r.actor());
		dev.larattalabs.architect.site.SiteDeltas.Check c = instant ? dev.larattalabs.architect.site.SiteDeltas.check(level, deltaRequest(r))
			: Builder.checkConstructionDelta(level, deltaRequest(r));
		return Views.deltaVerdict(c, List.of(), instant);
	}

	@Override
	public CompletableFuture<dev.larattalabs.architect.api.DeltaResult> applyDelta(dev.larattalabs.architect.api.DeltaRequest r) {
		CompletableFuture<CompletableFuture<dev.larattalabs.architect.api.DeltaResult>> f = onServer(() -> {
			Site b = Sites.get(r.siteId());
			ServerLevel level = b == null ? null : Sites.levelOf(server, b);
			if (level == null) {
				return CompletableFuture.completedFuture(Views.deltaFailed(r.siteId(), new Refusal(Reason.OTHER, b == null ? "No site " + r.siteId() : r.siteId()
					+ "'s dimension is not loaded")));
			}
			try {
				if (instantDelta(r.actor())) {
					return dev.larattalabs.architect.site.SiteDeltas.applyAsync(level, deltaRequest(r)).handle((res, err) -> res != null ? Views.deltaResult(res)
						: Views.deltaFailed(r.siteId(), refusalOf(err)));
				}
				return CompletableFuture.completedFuture(Views.deltaResult(Builder.applyConstructionDelta(level, deltaRequest(r), r.actor())));
			} catch (Sites.SiteException e) {
				return CompletableFuture.completedFuture(Views.deltaFailed(r.siteId(), new Refusal(e.reason(), e.getMessage())));
			}
		});
		return f.thenCompose(x -> x);
	}

	static Refusal refusalOf(Throwable err) {
		Throwable c = err instanceof java.util.concurrent.CompletionException && err.getCause() != null ? err.getCause() : err;
		return c instanceof Sites.SiteException se ? new Refusal(se.reason(), se.getMessage()) : new Refusal(Reason.OTHER, String.valueOf(c.getMessage()));
	}

	@Override
	public CompletableFuture<dev.larattalabs.architect.api.DeltaResult> revert(String siteId, int toVersion, @Nullable ServerPlayer actor) {
		CompletableFuture<CompletableFuture<dev.larattalabs.architect.api.DeltaResult>> f = onServer(() -> {
			Site b = Sites.get(siteId);
			ServerLevel level = b == null ? null : Sites.levelOf(server, b);
			if (level == null) {
				return CompletableFuture.completedFuture(Views.deltaFailed(siteId, new Refusal(Reason.OTHER, b == null ? "No site " + siteId : siteId
					+ "'s dimension is not loaded")));
			}
			try {
				if (instantDelta(actor)) {
					return dev.larattalabs.architect.site.SiteDeltas.revertAsync(level, siteId, toVersion, b.owner(), true).handle((res, err) -> res != null
						? Views.deltaResult(res) : Views.deltaFailed(siteId, refusalOf(err)));
				}
				// survival: a paid forward delta, never a journal undo (N6)
				return CompletableFuture.completedFuture(Views.deltaResult(Builder.applyConstructionDelta(level, new dev.larattalabs.architect.site.SiteDeltas
					.Request(siteId, toVersion, dev.larattalabs.architect.delta.DeltaPlanner.Edits.KEEP, false, b.owner(), true), actor)));
			} catch (Sites.SiteException e) {
				return CompletableFuture.completedFuture(Views.deltaFailed(siteId, new Refusal(e.reason(), e.getMessage())));
			}
		});
		return f.thenCompose(x -> x);
	}

	@Override
	public List<dev.larattalabs.architect.api.SiteVersion> history(String siteId) {
		List<dev.larattalabs.architect.api.SiteVersion> out = new ArrayList<>();
		for (Site.History h : dev.larattalabs.architect.site.SiteDeltas.history(server, siteId)) {
			out.add(new dev.larattalabs.architect.api.SiteVersion(h.version(), h.appliedAt(), switch (h.kind()) {
				case "delta" -> dev.larattalabs.architect.api.SiteVersion.Kind.DELTA;
				case "revert" -> dev.larattalabs.architect.api.SiteVersion.Kind.REVERT;
				case "forward" -> dev.larattalabs.architect.api.SiteVersion.Kind.FORWARD;
				default -> dev.larattalabs.architect.api.SiteVersion.Kind.PLACED;
			}, h.revertible()));
		}
		return out;
	}

	@Override
	public List<dev.larattalabs.architect.api.OutdatedSite> outdated(@Nullable String owner) {
		List<dev.larattalabs.architect.api.OutdatedSite> out = new ArrayList<>();
		for (Object[] o : dev.larattalabs.architect.site.SiteDeltas.outdated(server, owner, false)) {
			out.add(new dev.larattalabs.architect.api.OutdatedSite((String) o[0], (String) o[1], (int) o[2], (int) o[3]));
		}
		return out;
	}
}
