package dev.larattalabs.architect.apiimpl;

import dev.larattalabs.architect.api.PlaceRequest;
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
		return Sites.all().stream().map(s -> Views.site(server, s)).toList();
	}

	@Override
	public List<SiteView> list(@Nullable String owner) {
		return Sites.all().stream().filter(s -> ApiRules.ownerMatches(s.owner(), owner)).map(s -> Views.site(server, s)).toList();
	}

	@Override
	public Optional<SiteView> get(String siteId) {
		Site s = Sites.get(siteId);
		return s == null ? Optional.empty() : Optional.of(Views.site(server, s));
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
		Sites.Verdict v = Sites.verdict(r.level(), bp, r.origin(), r.rotation(), r.force(), null, true, construction);
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
					construction, r.owner(), r.ext(), r.actor());
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
			Optional.ofNullable(box).map(Views::box), Optional.ofNullable(snap).map(Views::box));
	}

	@Override
	public CompletableFuture<RemoveResult> remove(String siteId, RemoveOptions o) {
		return onServer(() -> {
			Site s = Sites.get(siteId);
			if (s == null) {
				return refused("No site " + siteId);
			}
			String owner = ApiRules.removeRefusal(siteId, s.owner(), o == null ? null : o.requester(), o != null && o.force());
			if (owner != null) {
				return refused(owner);
			}
			ServerLevel level = Sites.levelOf(server, s);
			if (level == null) {
				return refused(s.dimension() + " is not loaded");
			}
			if (!loaded(level, s.restoreBox())) {
				return refused(siteId + " is not loaded on the server (a player must be near it)");
			}
			List<String> blockers = Sites.removalBlockers(level, s);
			if (!blockers.isEmpty()) {
				return new RemoveResult(false, blockers, Map.of());
			}
			try {
				Sites.Removed done = Sites.removeDetailed(level, siteId, false);
				return new RemoveResult(true, List.of(), Views.items(done.returned()));
			} catch (Sites.SiteException e) {
				return refused(e.getMessage());
			}
		});
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
}
