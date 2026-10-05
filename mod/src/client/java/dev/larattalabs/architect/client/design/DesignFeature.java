package dev.larattalabs.architect.client.design;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.client.hud.Keys;
import dev.larattalabs.architect.client.hud.Toasts;
import dev.larattalabs.architect.client.placement.PlacementFeature;
import dev.larattalabs.architect.client.placement.PlotMarker;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.sidecar.SidecarLink;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import dev.larattalabs.architect.client.sidecar.SidecarState.Design;
import dev.larattalabs.architect.client.sidecar.SidecarState.DesignStatus;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import org.jspecify.annotations.Nullable;

/**
 * Designs, mod side: the Design tab's form ({@link #form()}), "Mark a plot…" through {@link PlotMarker},
 * {@code design.request} / {@code design.cancel}, and what happens when a design finishes: a toast, the library reloaded
 * on the integrated server ({@code Blueprints.reload}), and (when a plot was marked for it) placement locked on the plot.
 * Plots are remembered per design and, once done, per library id (this session). Client thread.
 */
public final class DesignFeature {
	private static DesignForm form = new DesignForm();
	private static final Map<String, DesignSpec.Plot> PLOT_BY_DESIGN = new HashMap<>();
	private static final Map<String, DesignSpec.Plot> PLOT_BY_BLUEPRINT = new HashMap<>();
	/** Designs seen queued or running: a snapshot that shows one finished (while offline) still reloads. */
	private static final Set<String> RUNNING = new HashSet<>();
	private static final Set<String> HANDLED = new HashSet<>();
	private static boolean sending;
	private static @Nullable String lastSent;
	private static @Nullable String lastReload;
	/** Reopens the Architect screen after plot marking (set by the screen). */
	public static @Nullable Consumer<String> reopen;

	private DesignFeature() {
	}

	public static void init() {
		Sidecar.state().addListener(new SidecarState.Listener() {
			@Override
			public void onDesign(@Nullable Design previous, Design d) {
				changed(previous == null ? null : previous.status(), d);
			}
		});
	}

	public static DesignForm form() {
		return form;
	}

	public static void resetForm() {
		form = new DesignForm();
	}

	public static boolean sending() {
		return sending;
	}

	public static @Nullable String lastSent() {
		return lastSent;
	}

	public static @Nullable String lastReload() {
		return lastReload;
	}

	/** The outcome of a submit: the design id, or why not (validation, sidecar offline, refused). */
	public record Sent(@Nullable String designId, @Nullable String error) {
	}

	/** Validates the form and sends {@code design.request}; completes on the client thread. */
	public static CompletableFuture<Sent> submit() {
		DesignForm f = form;
		f.sendError = null;
		Map<String, String> errors = f.errors();
		if (!errors.isEmpty()) {
			return CompletableFuture.completedFuture(new Sent(null, "Fix the marked fields: " + String.join("; ", errors.values())));
		}
		if (sending) {
			return CompletableFuture.completedFuture(new Sent(null, "Already sending"));
		}
		if (!Sidecar.connected()) {
			f.sendError = "The design helper is not running (see the Status tab)";
			return CompletableFuture.completedFuture(new Sent(null, f.sendError));
		}
		DesignSpec.Plot plot = DesignForm.PLOT.equals(f.size) ? f.plot : null;
		JsonObject request = f.requestJson();
		// (4c) "Massing first": a massing job; its massing opens the review (MassingReview) when it is installed
		boolean massing = f.massingFirst() && SetFeature.has("massing");
		if (massing) {
			request.addProperty("massing", true);
		}
		sending = true;
		return Sidecar.designRequest(request).handle((ack, err) -> {
			sending = false;
			if (err != null) {
				Throwable c = err instanceof CompletionException && err.getCause() != null ? err.getCause() : err;
				f.sendError = "Not sent: " + c.getMessage();
				return new Sent(null, f.sendError);
			}
			if (!ack.ok()) {
				f.sendError = "The helper refused it: " + (ack.error() != null ? ack.error() : "no reason given");
				return new Sent(null, f.sendError);
			}
			String id = designId(ack);
			if (id == null) {
				f.sendError = "The helper accepted it but sent no design id";
				return new Sent(null, f.sendError);
			}
			lastSent = id;
			RUNNING.add(id);
			if (massing) {
				MassingReview.expect(id, plot);
			} else if (plot != null) {
				PLOT_BY_DESIGN.put(id, plot);
			}
			Architect.LOGGER.info("Design {} requested ({} {}{}{})", id, request.get("type").getAsString(), request.get("style").getAsString(),
				plot != null ? ", on a plot" : "", massing ? ", massing first" : "");
			return new Sent(id, null);
		});
	}

	private static @Nullable String designId(SidecarLink.Ack ack) {
		JsonObject r = ack.result();
		if (r == null) {
			return null;
		}
		if (r.has("designId") && r.get("designId").isJsonPrimitive()) {
			return r.get("designId").getAsString();
		}
		return r.has("id") && r.get("id").isJsonPrimitive() ? r.get("id").getAsString() : null;
	}

	/** (4c) A detail pass the massing review started: tracked as a design of this tab (its plot kept for "Place on the plot"). */
	static void trackDetail(String designId, DesignSpec.@Nullable Plot plot) {
		RUNNING.add(designId);
		lastSent = designId;
		if (plot != null) {
			PLOT_BY_DESIGN.put(designId, plot);
		}
	}

	public static CompletableFuture<SidecarLink.Ack> cancel(String designId) {
		return Sidecar.designCancel(designId);
	}

	// ------------------------------------------------------------------ plot

	/** "Mark a plot…": closes the screen, marks a plot, comes back to the Design tab (with the size filled, unless cancelled). */
	public static void startPlot() {
		DesignSpec.Plot had = form.plot;
		PlotMarker.start(had != null ? had.height() : DesignSpec.DEFAULT_PLOT_HEIGHT, p -> {
			form.setPlot(p);
			back();
		}, DesignFeature::back);
	}

	private static void back() {
		Consumer<String> r = reopen;
		if (r != null && Minecraft.getInstance().player != null) {
			r.accept("design");
		}
	}

	public static DesignSpec.@Nullable Plot plotForBlueprint(String blueprintId) {
		return PLOT_BY_BLUEPRINT.get(blueprintId);
	}

	public static DesignSpec.@Nullable Plot plotForDesign(String designId) {
		return PLOT_BY_DESIGN.get(designId);
	}

	/** "Place on the plot": placement mode locked on the plot. Returns why not, or null when the ghost is up. */
	public static @Nullable String placeOnPlot(String blueprintId) {
		DesignSpec.Plot p = PLOT_BY_BLUEPRINT.get(blueprintId);
		Blueprint bp = Blueprints.get(blueprintId);
		Minecraft mc = Minecraft.getInstance();
		if (p == null) {
			return "No plot was marked for " + blueprintId;
		}
		if (bp == null) {
			return "Design " + blueprintId + " is not loaded";
		}
		if (mc.player == null) {
			return "Not in a world";
		}
		String here = mc.player.level().dimension().identifier().toString();
		if (!here.equals(p.dimension())) {
			return "The plot is in " + p.dimension() + " and you are in " + here + ": go there to place it";
		}
		int[] spot = p.placement(bp.front(), bp.sizeX(), bp.sizeZ(), bp.groundY());
		return PlacementFeature.placeNowAt(blueprintId, spot, spot[3]);
	}

	// ------------------------------------------------------------------ progress

	private static void changed(@Nullable DesignStatus before, Design d) {
		if (d.status().isRunning()) {
			RUNNING.add(d.id());
			return;
		}
		boolean wasRunning = before == null ? RUNNING.contains(d.id()) : before.isRunning();
		RUNNING.remove(d.id());
		if (!wasRunning || !HANDLED.add(d.id())) {
			return;
		}
		String key = Keys.screen == null ? "B" : Keys.label(Keys.screen);
		if (d.raw().has("massing")) {
			// (4c) a massing job: never a library entry; MassingReview shows it when its massing is installed
			if (d.status() == DesignStatus.FAILED) {
				Toasts.push(Toasts.Level.WARN, "Massing failed: " + d.title(), firstLine(d.error() != null ? d.error() : d.step()), key, "designs");
			}
			return;
		}
		switch (d.status()) {
			case DONE -> done(d, key);
			case FAILED -> Toasts.push(Toasts.Level.WARN, "Design failed: " + d.title(), firstLine(d.error() != null ? d.error() : d.step()), key,
				"designs");
			default -> {
			}
		}
	}

	private static String firstLine(String s) {
		String l = s.strip();
		int nl = l.indexOf('\n');
		l = nl >= 0 ? l.substring(0, nl) : l;
		return l.length() > 140 ? l.substring(0, 139) + "…" : l;
	}

	private static void done(Design d, String key) {
		String bp = d.blueprintId();
		DesignSpec.Plot plot = PLOT_BY_DESIGN.get(d.id());
		if (bp != null && plot != null) {
			PLOT_BY_BLUEPRINT.put(bp, plot);
		}
		String size = d.size() == null ? "" : " (" + d.size()[0] + "×" + d.size()[1] + "×" + d.size()[2] + ")";
		Toasts.push(Toasts.Level.INFO, "Design ready: " + d.title(), (bp == null ? d.id() : bp) + size + (plot != null ? ": place it on your plot"
			: ": review and place it") + " from the Library.", key, "library");
		if (bp != null) {
			reload(bp);
		}
	}

	/** Reloads the library on the integrated server; completes with whether {@code blueprintId} loaded. */
	public static CompletableFuture<Boolean> reload(@Nullable String blueprintId) {
		return ServerTasks.callOnServer(server -> {
			Blueprints.reload(server);
			return blueprintId == null || Blueprints.get(blueprintId) != null;
		}).handle((loaded, err) -> {
			if (err != null) {
				lastReload = blueprintId + ": " + (err.getMessage() == null ? err.toString() : err.getMessage());
				Architect.LOGGER.warn("Reloading the library failed: {}", lastReload);
				return false;
			}
			lastReload = blueprintId + (loaded ? ": loaded" : ": NOT loaded");
			if (!loaded) {
				Toasts.push(Toasts.Level.WARN, "The new design did not load", blueprintId + ": " + String.join("; ", Blueprints.lastProblems()));
			}
			return loaded;
		});
	}
}
