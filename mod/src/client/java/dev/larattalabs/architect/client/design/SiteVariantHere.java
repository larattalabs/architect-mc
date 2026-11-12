package dev.larattalabs.architect.client.design;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.FitMode;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.client.placement.PlacementFeature;
import dev.larattalabs.architect.client.placement.PlotMarker;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.labui.client.hud.Toasts;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import org.jspecify.annotations.Nullable;

/**
 * (7b ST, N-7b-6) "Site variant here…": a site-bound design placed elsewhere only as a site variant of it (docs/CONTRACT.md "Phase 7b",
 * "Noah's answers" N-7b-6). The player marks a plot with the fit fixed to the entry's own ({@link PlotMarker} with a locked fit), the
 * site is sampled and its frame confirmed, then {@code Designs.siteVariant(entryId, site, opKey)} re-runs the design's program on the
 * new site ($0, DS) and installs the variant, and placement starts on the variant's site. A refusal ({@code SITE_UNFIT} with the failing
 * rule, {@code SITE_UNSUPPORTED}) is a toast with the reason. Client thread.
 */
public final class SiteVariantHere {
	private static @Nullable String running;
	private static @Nullable String lastEntry;
	private static @Nullable String lastError;

	private SiteVariantHere() {
	}

	/** The entry a variant is being made of now, or null. */
	public static @Nullable String running() {
		return running;
	}

	/** The last variant installed by this flow (this session), or null. */
	public static @Nullable String lastEntry() {
		return lastEntry;
	}

	public static @Nullable String lastError() {
		return lastError;
	}

	/**
	 * Starts the flow for site-bound entry {@code entryId}: plot marking with the fit locked. {@code back} reopens the screen (on cancel or
	 * a refusal). Returns why it can't start, or null.
	 */
	public static @Nullable String start(String entryId, @Nullable Consumer<String> back) {
		SiteSpec own = PlacementFeature.siteOf(entryId);
		if (own == null) {
			return entryId + " is not bound to a site: place it anywhere";
		}
		if (running != null) {
			return "A site variant of " + running + " is being made";
		}
		if (!SetFeature.has(dev.larattalabs.architect.apiimpl.SiteDesigns.FEATURE)) {
			return "This design helper can't make site variants (no " + dev.larattalabs.architect.apiimpl.SiteDesigns.FEATURE + "): update it";
		}
		FitMode fit = own.fit();
		dev.larattalabs.architect.placement.Blueprint bp = dev.larattalabs.architect.placement.Blueprints.get(entryId);
		int h = bp == null ? DesignSpec.DEFAULT_PLOT_HEIGHT : bp.sizeY();
		try {
			PlotMarker.start(h, fit, p -> {
			}, (p, site) -> make(entryId, site, back), () -> {
				if (back != null && Minecraft.getInstance().player != null) {
					back.accept("library");
				}
			});
		} catch (IllegalArgumentException e) {
			return e.getMessage();
		}
		return null;
	}

	/** The variant on {@code site}: Designs.siteVariant with a fresh opKey, then placement on the variant's site. */
	public static CompletableFuture<String> make(String entryId, SiteSpec site, @Nullable Consumer<String> back) {
		String opKey = "st-here-" + Long.toString(System.currentTimeMillis(), 36) + "-" + Integer.toHexString(site.volumeSha().hashCode());
		running = entryId;
		lastError = null;
		Toasts.push(Toasts.Spec.of(Toasts.Level.INFO, "Making a site variant", entryId + " re-run on the site you marked ($0)…"));
		Minecraft mc = Minecraft.getInstance();
		return ServerTasks.callOnServer(s -> ArchitectApi.get().designs().siteVariant(entryId, site, opKey)).thenCompose(x -> x).handle((id, err) -> {
			mc.execute(() -> {
				running = null;
				if (err != null) {
					Throwable c = err instanceof CompletionException && err.getCause() != null ? err.getCause() : err;
					lastError = c instanceof ArchitectRefused r ? r.reason().name() + (r.detail() == null ? "" : " " + r.detail()) + ": " + r.getMessage()
						: String.valueOf(c.getMessage());
					Architect.LOGGER.info("Site variant of {} refused: {}", entryId, lastError);
					Toasts.push(Toasts.Spec.of(Toasts.Level.WARN, "No site variant of " + entryId, lastError).bodyLines(3));
					if (back != null && mc.player != null) {
						back.accept("library");
					}
					return;
				}
				lastEntry = id;
				String why = PlacementFeature.placeOnSite(id);
				Toasts.push(Toasts.Spec.of(why == null ? Toasts.Level.INFO : Toasts.Level.WARN, "Site variant ready: " + id, why == null
					? "placed on the site you marked: Enter to place it" : why));
			});
			if (err != null) {
				throw err instanceof CompletionException ce ? ce : new CompletionException(err);
			}
			return id;
		});
	}
}
