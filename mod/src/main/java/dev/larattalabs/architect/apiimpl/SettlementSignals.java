package dev.larattalabs.architect.apiimpl;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.api.SiteView;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * (8b EV, docs/CONTRACT.md "Phase 8b" §4) {@link SiteEvents#SETTLEMENT_CHANGED}: one "re-read this settlement" signal per (owner,
 * region), fired from the edges the settlement screens show, coalesced to at most one per {@link #EVERY} ticks per key and never dropped
 * (an edge sooner is deferred to the key's next slot). Its sources are Architect's own events (SITE_WAITING, SITE_PLACED, SITE_REMOVED,
 * SITE_BUILT, SITE_UPDATED, REGION_STATE, STOCKPILE_CHANGED, ITEM_WAITING / PLACED / FAILED) and direct marks where no event exists (a
 * pause, a region ext change Steward reads, a site's deviations). Once per owner after a world load. Server thread. Internal.
 */
public final class SettlementSignals {
	/** The coalescing window: at most one event per key per this many ticks. */
	public static final int EVERY = 20;

	private SettlementSignals() {
	}

	/** A key: the owner and the region (null: the owner's settlement as a whole). */
	public record Key(String owner, @Nullable String region) {
	}

	/**
	 * The pure coalescer: marks are pending until the key's slot opens ({@code lastFired + EVERY <= now}); {@link #due} hands the keys to fire
	 * now and records them. A key never fires twice within {@link #EVERY} ticks, and a mark is never lost.
	 */
	public static final class Coalescer {
		private final Set<Key> pending = new LinkedHashSet<>();
		private final Map<Key, Long> last = new LinkedHashMap<>();

		public synchronized void mark(Key k) {
			pending.add(k);
		}

		public synchronized List<Key> due(long now) {
			List<Key> out = new ArrayList<>();
			for (var it = pending.iterator(); it.hasNext();) {
				Key k = it.next();
				Long t = last.get(k);
				if (t == null || now - t >= EVERY) {
					out.add(k);
					last.put(k, now);
					it.remove();
				}
			}
			if (last.size() > 4096) {
				last.values().removeIf(t -> now - t >= EVERY); // keys out of their window need no memory
			}
			return out;
		}

		public synchronized boolean idle() {
			return pending.isEmpty();
		}

		public synchronized void clear() {
			pending.clear();
			last.clear();
		}
	}

	static final Coalescer C = new Coalescer();
	private static long tick;

	/** Marks the owner's settlement changed (a null owner, a player's own, has no settlement: ignored). Any thread. */
	public static void mark(@Nullable String owner, @Nullable String region) {
		if (owner != null && !owner.isBlank()) {
			C.mark(new Key(owner, region));
		}
	}

	/**
	 * A standing site's record was replaced: marks its owner when what a row shows changed (its version, deviations, updating or reverting,
	 * pause, or construction state). Pure apart from the mark.
	 */
	public static void siteChanged(dev.larattalabs.architect.site.@Nullable Site before, dev.larattalabs.architect.site.Site after) {
		if (before == null || shown(before) .equals(shown(after))) {
			return;
		}
		var m = after.member();
		mark(after.owner(), Views.regionOfGroup(m == null ? null : m.group()));
	}

	/** What a building row shows of a site record (its edges). */
	static List<Object> shown(dev.larattalabs.architect.site.Site s) {
		var v = s.versioning();
		var c = s.construction();
		return List.of(v.version(), v.deviations(), v.updating() > 0 || v.reverting() > 0, c == null ? "instant" : c.state() + (c.paused() ? ":paused" : ""));
	}

	private static void site(SiteView v) {
		mark(v.owner(), v.region());
	}

	/** Registers the sources and the tick. Called once from the mod's init. */
	public static void init() {
		SiteEvents.SITE_WAITING.register((v, w) -> site(v));
		SiteEvents.SITE_PLACED.register(SettlementSignals::site);
		SiteEvents.SITE_REMOVED.register((v, r) -> site(v));
		SiteEvents.SITE_BUILT.register(SettlementSignals::site);
		SiteEvents.SITE_UPDATED.register((a, b, r) -> {
			site(a);
			if (b != null && !Objects.equals(b.owner(), a.owner())) {
				site(b);
			}
		});
		SiteEvents.REGION_STATE.register(v -> mark(v.owner(), v.id()));
		SiteEvents.STOCKPILE_CHANGED.register(owner -> mark(owner, null));
		SiteEvents.ITEM_WAITING.register(e -> item(e));
		SiteEvents.ITEM_PLACED.register(e -> item(e));
		SiteEvents.ITEM_FAILED.register(e -> item(e));
		// BL seam (T2b): once SiteEvents.OWED_CHANGED is on main, register it here as mark(recipient, null) (the recipient is the owner)
		ServerTickEvents.END_SERVER_TICK.register(SettlementSignals::tick);
		ServerLifecycleEvents.SERVER_STARTED.register(SettlementSignals::loaded);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> C.clear());
	}

	private static void item(dev.larattalabs.architect.api.ItemEvent e) {
		var b = dev.larattalabs.architect.site.Batches.get(e.batchId());
		if (b != null) {
			mark(b.owner, e.region());
		}
	}

	/** Once per owner after a world load: every owner with a site, a road, a region or a stockpile (edges while it was down are lost). */
	static void loaded(MinecraftServer server) {
		try {
			Set<String> owners = new LinkedHashSet<>();
			dev.larattalabs.architect.site.Sites.all().forEach(s -> owners.add(s.owner()));
			dev.larattalabs.architect.site.Infras.all().forEach(i -> owners.add(i.owner()));
			dev.larattalabs.architect.api.ArchitectApi.get().regions().list(null).forEach(v -> owners.add(v.owner()));
			owners.forEach(o -> mark(o, null));
		} catch (RuntimeException e) {
			Architect.LOGGER.warn("SETTLEMENT_CHANGED at load: {}", e.toString());
		}
	}

	static void tick(MinecraftServer server) {
		tick++;
		if (C.idle()) {
			return;
		}
		for (Key k : C.due(tick)) {
			SiteEvents.SETTLEMENT_CHANGED.invoker().onChanged(k.owner(), k.region());
		}
	}
}
