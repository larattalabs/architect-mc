package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.PlaceRequest;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.api.RemoveResult;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.Sites;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Rotation;
import org.jspecify.annotations.Nullable;

/**
 * Where Architect's internals fire the public events (R7), so API calls, the UI and commands fire the same ones. Every
 * method runs on the server thread and never throws (a failing view or listener is logged). Internal.
 */
public final class ApiEvents {
	private ApiEvents() {
	}

	private static void guard(String what, Runnable r) {
		try {
			r.run();
		} catch (Throwable t) {
			Architect.LOGGER.warn("Firing {} failed", what, t);
		}
	}

	// ------------------------------------------------------------------ phase 4d: batches and stages

	public static void batchProgress(dev.larattalabs.architect.batch.QBatch b) {
		guard("BATCH_PROGRESS", () -> SiteEvents.BATCH_PROGRESS.invoker().onProgress(Views.batch(b)));
	}

	public static void batchDone(dev.larattalabs.architect.batch.QBatch b) {
		guard("BATCH_DONE", () -> SiteEvents.BATCH_DONE.invoker().onDone(Views.batch(b)));
	}

	public static void itemPlaced(dev.larattalabs.architect.batch.QBatch b, dev.larattalabs.architect.batch.QItem i) {
		guard("ITEM_PLACED", () -> SiteEvents.ITEM_PLACED.invoker().onPlaced(Views.itemEvent(b, i)));
	}

	public static void itemFailed(dev.larattalabs.architect.batch.QBatch b, dev.larattalabs.architect.batch.QItem i) {
		guard("ITEM_FAILED", () -> SiteEvents.ITEM_FAILED.invoker().onFailed(Views.itemEvent(b, i)));
	}

	public static void itemWaiting(dev.larattalabs.architect.batch.QBatch b, dev.larattalabs.architect.batch.QItem i) {
		guard("ITEM_WAITING", () -> SiteEvents.ITEM_WAITING.invoker().onWaiting(Views.itemEvent(b, i)));
	}

	public static void stageState(String groupId, dev.larattalabs.architect.site.SiteGroupRec.StageRec st) {
		guard("STAGE_STATE", () -> SiteEvents.STAGE_STATE.invoker().onState(groupId, Views.stage(st)));
	}

	public static void placed(MinecraftServer server, Site s) {
		guard("SITE_PLACED", () -> SiteEvents.SITE_PLACED.invoker().onPlaced(Views.site(server, s)));
	}

	public static void removed(MinecraftServer server, Sites.Removed r) {
		guard("SITE_REMOVED", () -> SiteEvents.SITE_REMOVED.invoker().onRemoved(Views.site(null, r.site()),
			new RemoveResult(true, List.of(), Views.items(r.returned()))));
	}

	/** A site moved to another version of its entry (phase 5b: an apply or a revert; SITE_UPDATED, wired with API 1.7.0). */
	public static void siteUpdated(MinecraftServer server, dev.larattalabs.architect.site.SiteDeltas.Result r) {
		if (r.before() != null && r.after() != null) {
			guard("SITE_UPDATED", () -> SiteEvents.SITE_UPDATED.invoker().onUpdated(Views.site(server, r.before()), Views.site(server, r.after()), Views
				.deltaResult(r)));
		}
		UPDATED.forEach(l -> {
			try {
				l.accept(r);
			} catch (RuntimeException e) {
				dev.larattalabs.architect.Architect.LOGGER.warn("SITE_UPDATED listener failed", e);
			}
		});
	}

	/** Internal listeners of site updates (the API event, the client sync). */
	public static final java.util.List<java.util.function.Consumer<dev.larattalabs.architect.site.SiteDeltas.Result>> UPDATED =
		new java.util.concurrent.CopyOnWriteArrayList<>();

	/** A road or cell site was placed (phase 4e: SITE_PLACED fires for them too; their view's kind tells them apart). */
	public static void placedInfra(MinecraftServer server, dev.larattalabs.architect.site.Infra i) {
		guard("SITE_PLACED", () -> SiteEvents.SITE_PLACED.invoker().onPlaced(Views.infra(i)));
	}

	/** A road or cell site was removed. */
	public static void removedInfra(MinecraftServer server, dev.larattalabs.architect.site.Infra i, int restored) {
		guard("SITE_REMOVED", () -> SiteEvents.SITE_REMOVED.invoker().onRemoved(Views.infra(i), new RemoveResult(true, List.of(), java.util.Map.of())));
	}

	public static void moved(MinecraftServer server, Site before, Site after) {
		guard("SITE_MOVED", () -> SiteEvents.SITE_MOVED.invoker().onMoved(Views.site(null, before), Views.site(server, after)));
	}

	public static void progress(MinecraftServer server, Site s) {
		guard("SITE_PROGRESS", () -> SiteEvents.SITE_PROGRESS.invoker().onProgress(Views.site(server, s)));
	}

	public static void built(MinecraftServer server, Site s) {
		guard("SITE_BUILT", () -> SiteEvents.SITE_BUILT.invoker().onBuilt(Views.site(server, s)));
	}

	/** A refused placement attempt (API, UI confirm, command). {@code construction}: null = AUTO. */
	public static void placeFailed(ServerLevel level, String blueprintId, BlockPos origin, Rotation rotation, boolean force,
		@Nullable Boolean construction, @Nullable String owner, @Nullable JsonObject ext, @Nullable ServerPlayer actor, List<Sites.Refusal> refusals) {
		Mode mode = construction == null ? Mode.AUTO : construction ? Mode.CONSTRUCTION : Mode.INSTANT;
		placeFailed(new PlaceRequest(blueprintId, level, origin, rotation, mode, owner, ext == null ? new JsonObject() : ext.deepCopy(), force, actor),
			refusals.stream().map(r -> new Refusal(r.reason(), r.message())).toList());
	}

	public static void placeFailed(PlaceRequest r, List<Refusal> refusals) {
		guard("PLACE_FAILED", () -> SiteEvents.PLACE_FAILED.invoker().onFailed(r, List.copyOf(refusals)));
	}

	public static void designUpdated(Design d) {
		guard("DESIGN_UPDATED", () -> SiteEvents.DESIGN_UPDATED.invoker().onUpdated(d));
	}

	public static void designDone(Design d) {
		guard("DESIGN_DONE", () -> SiteEvents.DESIGN_DONE.invoker().onDone(d));
	}

	public static void designCritiqued(String designId, dev.larattalabs.architect.api.Critique.Round r) {
		guard("DESIGN_CRITIQUED", () -> SiteEvents.DESIGN_CRITIQUED.invoker().onCritiqued(designId, r));
	}

	public static void variantDone(Library.Entry e) {
		guard("VARIANT_DONE", () -> SiteEvents.VARIANT_DONE.invoker().onDone(e));
	}

	public static void groupUpdated(dev.larattalabs.architect.api.Group g) {
		guard("GROUP_UPDATED", () -> SiteEvents.GROUP_UPDATED.invoker().onUpdated(g));
	}

	public static void groupDone(dev.larattalabs.architect.api.Group g) {
		guard("GROUP_DONE", () -> SiteEvents.GROUP_DONE.invoker().onDone(g));
	}

	public static void groupAwaitingApproval(dev.larattalabs.architect.api.Group g) {
		guard("GROUP_AWAITING_APPROVAL", () -> SiteEvents.GROUP_AWAITING_APPROVAL.invoker().onAwaiting(g));
	}

	public static void massingDone(dev.larattalabs.architect.api.Massing m) {
		guard("MASSING_DONE", () -> SiteEvents.MASSING_DONE.invoker().onDone(m));
	}

	public static void bibleUpdated(dev.larattalabs.architect.api.BibleJob j) {
		guard("BIBLE_UPDATED", () -> SiteEvents.BIBLE_UPDATED.invoker().onUpdated(j));
	}

	public static void bibleDone(dev.larattalabs.architect.api.BibleJob j) {
		guard("BIBLE_DONE", () -> SiteEvents.BIBLE_DONE.invoker().onDone(j));
	}

	public static void reskinDone(dev.larattalabs.architect.api.Reskin r) {
		guard("RESKIN_DONE", () -> SiteEvents.RESKIN_DONE.invoker().onDone(r));
	}

	/** The world's survival toggle changed, or got its default at the first load (server thread). */
	public static void worldModeChanged(boolean on, int blocksPerTick) {
		dev.larattalabs.architect.api.SurvivalInfo info = new dev.larattalabs.architect.api.SurvivalInfo(on, blocksPerTick);
		guard("WORLD_MODE_CHANGED", () -> SiteEvents.WORLD_MODE_CHANGED.invoker().onChanged(info));
	}
}
