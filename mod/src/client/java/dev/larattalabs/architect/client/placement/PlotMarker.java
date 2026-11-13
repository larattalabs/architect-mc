package dev.larattalabs.architect.client.placement;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.architect.api.FitMode;
import dev.larattalabs.architect.api.SiteSpec;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.core.Direction;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * Plot-marking mode (docs/HUB.md "Generated buildings": the design form's "Fit a plot…"), built on the
 * placement mode's pieces: the same look ray ({@link BuildPlacement#spot}), keys (the keyboard mixin ->
 * {@link BuildingWizardFeature#onKey}), HUD ({@link PlotHud}) and level renderer ({@link GhostRenderer}).
 * Client thread only.
 *
 * <p>Look at the first corner, Enter; look at the second corner (a translucent rectangle follows the
 * look, with its size and the height limit), Enter. PgUp/PgDn change the height limit (Shift: by 4),
 * Backspace goes back a corner, Esc cancels. The plot's front is the side facing the player when the
 * second corner is confirmed (the entrance goes there); its ground is the lower corner's surface.
 *
 * <p>(7b ST, SETTLEMENTS §7.8) <b>The fit picker:</b> F cycles the fit ({@code on_pad}, the default, then the five site fits; Shift+F
 * back). {@code on_pad} is today's plot exactly (no sample, no site). With a site fit the second corner starts the <b>sample</b>: the lot
 * (the plot's rectangle from its ground up to the height limit) plus 8 is frozen and analysed on the integrated server
 * ({@link dev.larattalabs.architect.apiimpl.SiteAnalysis#standalone}, Survey.site's path with the kit's standalone spec), then the
 * <b>frame</b> is shown on the plot (its entrance side, its ports) for the player to confirm (Enter) or go back (Backspace: to the second
 * corner). A refusal (no such land at the plot, the helper missing) goes back to the second corner with the reason.
 *
 * <p>(7c CX) <b>The connector mode</b> ({@link #startConnector}): the two marks are a connector's two ends (the cells looked at, feet level),
 * F cycles the kind ({@code rope_bridge}, the default, {@code ladder}, {@code catwalk}, {@code rock_stair}, {@code spiral}; Shift+F back),
 * and Enter on the second end places it on the integrated server ({@code Sites.placeConnector}'s path for the player: the player's UUID as
 * the owner, so in survival the player's stockpile feeds it). A refusal stays on the second end with its reason; placed, the mode ends.
 */
public final class PlotMarker {
	/** What the renderer and HUD draw this frame. {@code first} null = still choosing the first corner. */
	record View(int @Nullable [] first, int[] hover, int height, String front, boolean pinned, FitMode fit, boolean fitLocked, Phase phase,
		@Nullable SiteSpec site, @Nullable String connector) {
		DesignSpec.Plot plot(String dimension) {
			int[] a = first != null ? first : hover;
			return DesignSpec.Plot.of(a[0], a[1], a[2], hover[0], hover[1], hover[2], height, front, dimension);
		}
	}

	/** (7b ST) Where the marking is: the two corners, then (a site fit) the sample on the server and the frame to confirm. */
	public enum Phase {
		FIRST, SECOND, SAMPLING, FRAME,
		/** (7c CX) The connector asked of the integrated server, its answer awaited. */
		PLACING
	}

	/** (7c CX) The connector kinds in picker order (rope_bridge first: the default); ConnectorPlace.KINDS's player words. */
	public static final String[] CONNECTORS = {"rope_bridge", "ladder", "catwalk", "rock_stair", "spiral"};

	/** (7b ST) The fits in picker order (on_pad first: the default). */
	static final FitMode[] FITS = {FitMode.ON_PAD, FitMode.ATTACH_TO_CLIFF, FitMode.CARVE_INTO, FitMode.SPAN, FitMode.WRAP_TRUNK, FitMode.SUSPEND};

	private static boolean active;
	private static @Nullable Level level;
	private static FitMode fit = FitMode.ON_PAD;
	private static boolean fitLocked;
	private static Phase phase = Phase.FIRST;
	private static @Nullable SiteSpec frameSpec;
	private static DesignSpec.@Nullable Plot framePlot;
	/** The sample in flight (a later answer for an older one is dropped). */
	private static int sampleGen;
	private static @Nullable BiConsumer<DesignSpec.Plot, SiteSpec> onDoneSite;
	private static @Nullable SiteSpec lastSite;
	private static String dimension = "";
	private static int @Nullable [] first;
	/** DevBridge: a pinned hover corner (preview without confirming). */
	private static int @Nullable [] pinned;
	private static @Nullable String frontOverride;
	private static int height = DesignSpec.DEFAULT_PLOT_HEIGHT;
	private static @Nullable Consumer<DesignSpec.Plot> onDone;
	private static @Nullable Runnable onCancel;
	private static @Nullable View view;
	/** (7c CX) Marking a connector's two ends (not a plot), the kind picked, its callback and the last answer. */
	private static boolean connector;
	private static int connectorKind;
	private static @Nullable Consumer<dev.larattalabs.architect.api.PlaceResult> onPlaced;
	private static @Nullable JsonObject lastConnector;
	private static int placeGen;
	private static DesignSpec.@Nullable Plot last;
	private static @Nullable String status;
	static long statusAt;

	private PlotMarker() {
	}

	public static boolean active() {
		return active;
	}

	/**
	 * Enters plot-marking mode (closes any screen, leaves placement mode). {@code done} gets the plot after
	 * the second corner; {@code cancel} runs on Esc. Throws IllegalArgumentException when not in a world.
	 */
	public static void start(int startHeight, Consumer<DesignSpec.Plot> done, Runnable cancel) {
		start(startHeight, null, done, (p, site) -> done.accept(p), cancel);
	}

	/**
	 * (7b ST) {@link #start} with the fit picker's outcome: {@code done} gets an {@code on_pad} plot (no site, today's), {@code doneSite}
	 * the plot and its confirmed {@link SiteSpec} (a site fit). {@code lockFit} non-null: the picker is fixed to it (a site-bound entry's
	 * "Site variant here": its own fit).
	 */
	public static void start(int startHeight, @Nullable FitMode lockFit, Consumer<DesignSpec.Plot> done, BiConsumer<DesignSpec.Plot, SiteSpec> doneSite,
		Runnable cancel) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player == null || mc.level == null) {
			throw new IllegalArgumentException("Not in a world");
		}
		BuildPlacement.cancel();
		reset();
		active = true;
		level = mc.level;
		dimension = mc.level.dimension().identifier().toString();
		height = DesignSpec.clampY(startHeight);
		onDone = done;
		onDoneSite = doneSite;
		onCancel = cancel;
		fitLocked = lockFit != null;
		fit = lockFit != null ? lockFit : FitMode.ON_PAD; // on_pad is every new plot's default (the picker changes it)
		status = null;
		mc.gui.setScreen(null);
		update(mc);
	}

	/**
	 * (7c CX) Enters the connector mode: mark the two ends (Enter each), F picks the kind, Enter on the second places it. {@code from} non-null:
	 * the first end is already marked (the drop warning's "build a link here": the port's outside cell). {@code done} gets each placed answer
	 * (the mode ends then); {@code cancel} runs on Esc. Throws IllegalArgumentException when not in a world.
	 */
	public static void startConnector(int @Nullable [] from, Consumer<dev.larattalabs.architect.api.PlaceResult> done, Runnable cancel) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player == null || mc.level == null) {
			throw new IllegalArgumentException("Not in a world");
		}
		BuildPlacement.cancel();
		reset();
		active = true;
		connector = true;
		level = mc.level;
		dimension = mc.level.dimension().identifier().toString();
		onPlaced = done;
		onCancel = cancel;
		if (from != null) {
			first = from.clone();
			phase = Phase.SECOND;
		}
		status = null;
		mc.gui.setScreen(null);
		update(mc);
	}

	/** (7c CX) Whether the marking is a connector's ends. */
	public static boolean connectorMode() {
		return active && connector;
	}

	/** (7c CX) The connector kind picked (the default rope_bridge when not marking one). */
	public static String connectorKind() {
		return CONNECTORS[connectorKind];
	}

	/** (7c CX) DevBridge: pick the connector kind. Throws IllegalStateException when not marking a connector's ends. */
	public static void setConnectorKind(String kind) {
		if (!connectorMode() || !cornerPhase()) {
			throw new IllegalStateException("not marking a connector's ends");
		}
		int i = java.util.Arrays.asList(CONNECTORS).indexOf(kind);
		if (i < 0) {
			throw new IllegalArgumentException("kind: one of " + String.join(", ", CONNECTORS));
		}
		connectorKind = i;
		update(Minecraft.getInstance());
	}

	private static void reset() {
		active = false;
		level = null;
		first = null;
		pinned = null;
		frontOverride = null;
		view = null;
		onDone = null;
		onDoneSite = null;
		onCancel = null;
		phase = Phase.FIRST;
		frameSpec = null;
		framePlot = null;
		sampleGen++;
		connector = false;
		onPlaced = null;
		placeGen++;
		if (fitLocked) {
			fitLocked = false;
			fit = FitMode.ON_PAD; // a locked fit was the entry's, not the player's pick
		}
	}

	/** Leaves plot mode without calling back (placement starting, leaving the world). */
	static void cancelQuietly() {
		reset();
	}

	/** Esc: leaves plot mode and calls the cancel callback (back to the form). */
	public static void cancel() {
		if (!active) {
			return;
		}
		Runnable c = onCancel;
		boolean link = connector;
		reset();
		setStatus(link ? "Connector cancelled" : "Plot marking cancelled");
		if (c != null) {
			c.run();
		}
	}

	/** Backspace: forget the first corner (or cancel when there is none). */
	static void back() {
		if (!active) {
			return;
		}
		if (phase == Phase.PLACING) {
			return; // (7c CX) the server has the connector: wait for its answer
		}
		if (phase == Phase.SAMPLING || phase == Phase.FRAME) {
			// (7b ST) back to the second corner (the sample is dropped)
			phase = Phase.SECOND;
			frameSpec = null;
			framePlot = null;
			pinned = null;
			sampleGen++;
			update(Minecraft.getInstance());
			return;
		}
		if (first == null) {
			cancel();
			return;
		}
		first = null;
		pinned = null;
		phase = Phase.FIRST;
		update(Minecraft.getInstance());
	}

	public static void adjustHeight(int delta) {
		if (active && !connector && cornerPhase()) {
			height = DesignSpec.clampY(height + delta);
			update(Minecraft.getInstance());
		}
	}

	public static void setHeight(int h) {
		if (active && cornerPhase()) {
			height = DesignSpec.clampY(h);
			update(Minecraft.getInstance());
		}
	}

	private static boolean cornerPhase() {
		return phase == Phase.FIRST || phase == Phase.SECOND;
	}

	/** (7b ST) F: the next fit (Shift: the previous); not while sampling or confirming the frame, nor when the fit is locked. */
	static void cycleFit(int step) {
		if (active && connector && cornerPhase()) {
			connectorKind = Math.floorMod(connectorKind + step, CONNECTORS.length); // (7c CX) F picks the connector kind
			update(Minecraft.getInstance());
			return;
		}
		if (!active || fitLocked || !cornerPhase()) {
			return;
		}
		int i = java.util.Arrays.asList(FITS).indexOf(fit);
		fit = FITS[Math.floorMod(i + step, FITS.length)];
		update(Minecraft.getInstance());
	}

	/** (7b ST) DevBridge: pick a fit. Throws IllegalStateException when the fit can't change now. */
	public static void setFit(FitMode f) {
		if (!active) {
			throw new IllegalStateException("not marking a plot");
		}
		if (fitLocked && f != fit) {
			throw new IllegalStateException("the fit is fixed to " + fit.wire() + " (the entry's own)");
		}
		if (!cornerPhase()) {
			throw new IllegalStateException("the fit can't change while " + (phase == Phase.SAMPLING ? "sampling the site" : "confirming the frame"));
		}
		fit = f;
		update(Minecraft.getInstance());
	}

	public static FitMode fit() {
		return fit;
	}

	/** (7b ST) DevBridge: Enter (a corner, or the frame). */
	public static void enter() {
		confirm();
	}

	/** (7b ST) The phase now (FIRST when not marking). */
	public static Phase phase() {
		return active ? phase : Phase.FIRST;
	}

	/** Enter: confirms the corner under the look (or the pinned one); (7b ST) in the frame step, confirms the frame. */
	static void confirm() {
		Minecraft mc = Minecraft.getInstance();
		if (!active || mc.player == null) {
			return;
		}
		if (phase == Phase.SAMPLING || phase == Phase.PLACING) {
			return; // wait for the sample (or the connector's answer)
		}
		if (phase == Phase.FRAME) {
			SiteSpec site = frameSpec;
			DesignSpec.Plot p = framePlot;
			BiConsumer<DesignSpec.Plot, SiteSpec> done = onDoneSite;
			if (site == null || p == null) {
				return;
			}
			reset();
			last = p;
			lastSite = site;
			setStatus("Site plot " + p.dx() + " × " + p.dz() + ", height " + p.height() + ", fit " + site.fit().wire() + ", entrance " + p.front());
			if (done != null) {
				done.accept(p, site);
			}
			return;
		}
		update(mc);
		View v = view;
		if (v == null) {
			return;
		}
		if (first == null) {
			first = v.hover().clone();
			pinned = null;
			phase = Phase.SECOND;
			update(mc);
			return;
		}
		if (connector) {
			placeConnector(mc, first, v.hover());
			return;
		}
		DesignSpec.Plot p = v.plot(dimension);
		if (fit != FitMode.ON_PAD) {
			sample(mc, v);
			return;
		}
		Consumer<DesignSpec.Plot> done = onDone;
		reset();
		last = p;
		lastSite = null;
		setStatus("Plot " + p.dx() + " × " + p.dz() + ", height " + p.height() + ", entrance " + p.front());
		if (done != null) {
			done.accept(p);
		}
	}

	/** (7b ST) The lot box of a plot: its rectangle from the ground row up to the height limit. Pure. */
	public static net.minecraft.world.level.levelgen.structure.BoundingBox lotOf(DesignSpec.Plot p) {
		return new net.minecraft.world.level.levelgen.structure.BoundingBox(p.minX(), p.y(), p.minZ(), p.maxX(), p.y() + p.height() - 1, p.maxZ());
	}

	/** (7b ST) The design-frame front (south) in the world for a frame's rotation. Pure. */
	public static String frontOf(SiteSpec s) {
		return dev.larattalabs.architect.placement.BlueprintTransform.rotateDirection("south", s.frame().rotation().ordinal());
	}

	/** (7b ST) The sample: the second corner held, Survey.site's path with the standalone spec on the integrated server. */
	private static void sample(Minecraft mc, View v) {
		net.minecraft.client.server.IntegratedServer srv = mc.getSingleplayerServer();
		if (srv == null || mc.player == null) {
			setStatus("Site plots need the integrated server (singleplayer)");
			return;
		}
		DesignSpec.Plot p = v.plot(dimension);
		if (p.tooSmall() || p.tooLarge() || p.height() < DesignSpec.MIN_Y) {
			setStatus("A site plot is " + DesignSpec.MIN_XZ + ".." + DesignSpec.MAX_XZ + " a side: mark it again");
			return;
		}
		pinned = v.hover().clone();
		phase = Phase.SAMPLING;
		int gen = ++sampleGen;
		FitMode f = fit;
		var dim = mc.player.level().dimension();
		var lot = lotOf(p);
		setStatus("Sampling the site…");
		update(mc);
		srv.execute(() -> {
			var sl = srv.getLevel(dim);
			if (sl == null) {
				mc.execute(() -> sampled(gen, p, null, "that dimension is not loaded"));
				return;
			}
			dev.larattalabs.architect.apiimpl.SiteAnalysis.standalone(sl, lot, f, dev.larattalabs.architect.api.LoadPolicy.LOAD_BOUNDED(64)).whenComplete((st,
				e) -> mc.execute(() -> {
				Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
				sampled(gen, p, st == null ? null : st.spec(), c != null ? (c.getMessage() == null ? c.toString() : c.getMessage()) : st.reason());
			}));
		});
	}

	private static void sampled(int gen, DesignSpec.Plot p, @Nullable SiteSpec spec, @Nullable String why) {
		if (!active || gen != sampleGen || phase != Phase.SAMPLING) {
			return; // cancelled or gone back meanwhile
		}
		if (spec == null) {
			phase = Phase.SECOND;
			pinned = null;
			setStatus("Not a " + fit.wire() + " site: " + (why == null ? "no reason given" : why));
			update(Minecraft.getInstance());
			return;
		}
		frameSpec = spec;
		framePlot = new DesignSpec.Plot(p.minX(), p.y(), p.minZ(), p.dx(), p.dz(), p.height(), frontOf(spec), p.dimension());
		phase = Phase.FRAME;
		setStatus("Frame proposed: entrance " + framePlot.front() + ", " + spec.ports().size() + " port" + (spec.ports().size() == 1 ? "" : "s"));
		update(Minecraft.getInstance());
	}

	/**
	 * (7c CX) The second end confirmed: the connector asked of the integrated server ({@code ConnectorPlace.place} for the player: the
	 * player's UUID as the owner, the player as the actor, AUTO: the world's mode), under a fresh operation key.
	 */
	private static void placeConnector(Minecraft mc, int[] a, int[] b) {
		net.minecraft.client.server.IntegratedServer srv = mc.getSingleplayerServer();
		if (srv == null || mc.player == null) {
			setStatus("Connectors need the integrated server (singleplayer)");
			return;
		}
		String kind = CONNECTORS[connectorKind];
		var from = new net.minecraft.core.BlockPos(a[0], a[1], a[2]);
		var to = new net.minecraft.core.BlockPos(b[0], b[1], b[2]);
		java.util.UUID uuid = mc.player.getUUID();
		var dim = mc.player.level().dimension();
		String key = "player.cx." + Long.toString(System.currentTimeMillis(), 36);
		pinned = b.clone();
		phase = Phase.PLACING;
		int gen = ++placeGen;
		setStatus("Placing the " + kindWords(kind) + "…");
		update(mc);
		srv.execute(() -> {
			var sl = srv.getLevel(dim);
			if (sl == null) {
				mc.execute(() -> placed(gen, kind, null, "that dimension is not loaded"));
				return;
			}
			var req = new dev.larattalabs.architect.api.ConnectorRequest(kind, from, to, null, new JsonObject(), dev.larattalabs.architect.api.Mode.AUTO, key);
			dev.larattalabs.architect.apiimpl.ConnectorPlace.place(srv, req, sl, uuid.toString(), srv.getPlayerList().getPlayer(uuid)).whenComplete((r, e) -> mc.execute(
				() -> placed(gen, kind, r, e == null ? null : e.getMessage() == null ? e.toString() : e.getMessage())));
		});
	}

	private static void placed(int gen, String kind, dev.larattalabs.architect.api.@Nullable PlaceResult r, @Nullable String error) {
		if (!active || !connector || gen != placeGen || phase != Phase.PLACING) {
			return;
		}
		JsonObject j = new JsonObject();
		j.addProperty("kind", kind);
		j.add("from", first == null ? null : xyz(first));
		j.add("to", pinned == null ? null : xyz(pinned));
		if (r == null || !r.placed()) {
			String why = r == null ? error : r.refusals().isEmpty() ? "refused" : r.refusals().get(0).reason().name() + ": " + r.refusals().get(0).message();
			j.addProperty("placed", false);
			j.addProperty("refused", why);
			lastConnector = j;
			phase = Phase.SECOND; // stay on the second end with the reason
			pinned = null;
			setStatus("No " + kindWords(kind) + " here: " + why);
			update(Minecraft.getInstance());
			return;
		}
		j.addProperty("placed", true);
		j.addProperty("siteId", r.siteId().orElse(null));
		JsonArray ns = new JsonArray();
		r.notes().forEach(ns::add);
		j.add("notes", ns);
		lastConnector = j;
		Consumer<dev.larattalabs.architect.api.PlaceResult> done = onPlaced;
		reset();
		setStatus("Placed the " + kindWords(kind) + " (" + r.siteId().orElse("?") + ")");
		if (done != null) {
			done.accept(r);
		}
	}

	/** (7c CX) A connector kind in the HUD's words. */
	static String kindWords(String kind) {
		return switch (kind) {
			case "rope_bridge" -> "rope bridge";
			case "rock_stair" -> "rock stair";
			case "spiral" -> "spiral stair";
			default -> kind;
		};
	}

	/** (7b ST) The ports of the frame being confirmed as world cells (x, y, z triples), or empty. */
	static int[] framePorts() {
		SiteSpec s = frameSpec;
		if (s == null || phase != Phase.FRAME) {
			return new int[0];
		}
		var lot = lotOf(framePlot);
		int turns = s.frame().rotation().ordinal();
		int sx = turns % 2 == 0 ? lot.getXSpan() : lot.getZSpan();
		int sz = turns % 2 == 0 ? lot.getZSpan() : lot.getXSpan();
		int[] out = new int[s.ports().size() * 3];
		int i = 0;
		for (var port : s.ports()) {
			int[] r = dev.larattalabs.architect.placement.BlueprintTransform.rotateBlock(port.atDesign().getX(), port.atDesign().getZ(), sx, sz, turns);
			out[i++] = s.frame().origin().getX() + r[0];
			out[i++] = s.frame().origin().getY() + port.atDesign().getY();
			out[i++] = s.frame().origin().getZ() + r[1];
		}
		return out;
	}

	/**
	 * DevBridge: a corner at {@code x, y, z} ({@code y} = the surface: feet level on the ground). With
	 * {@code confirm} it counts as looked at + Enter; without, it is pinned as the hover corner (a
	 * shootable preview). {@code front} overrides the side the entrance faces (default: towards the player).
	 */
	public static void corner(int x, int y, int z, @Nullable String front, boolean confirm) {
		if (!active) {
			throw new IllegalStateException("not marking a plot");
		}
		if (!cornerPhase()) {
			throw new IllegalStateException("not choosing a corner (" + phase.name().toLowerCase(java.util.Locale.ROOT) + ")");
		}
		if (front != null) {
			if (BlueprintTransform.directionIndex(front) < 0) {
				throw new IllegalArgumentException("front must be north, east, south or west");
			}
			frontOverride = front.toLowerCase(java.util.Locale.ROOT);
		}
		pinned = new int[] {x, y, z};
		update(Minecraft.getInstance());
		if (confirm) {
			confirm();
		}
	}

	/** Called every client tick. */
	static void tick(Minecraft mc) {
		if (!active) {
			return;
		}
		if (mc.player == null || mc.level == null || mc.level != level) {
			reset();
			setStatus("Plot marking cancelled (left the world or dimension)");
			return;
		}
		update(mc);
	}

	private static void update(Minecraft mc) {
		if (!active || mc.player == null) {
			view = null;
			return;
		}
		int[] hover = pinned != null ? pinned : lookCorner(mc, mc.player);
		String front = frontOverride != null ? frontOverride : BlueprintTransform.rotateDirection(facing(mc.player), 2);
		if (phase == Phase.FRAME && framePlot != null) {
			front = framePlot.front(); // the frame's entrance, not the player's facing
		}
		view = new View(first == null ? null : first.clone(), hover, height, front, pinned != null, fit, fitLocked, phase, phase == Phase.FRAME ? frameSpec
			: null, connector ? CONNECTORS[connectorKind] : null);
	}

	private static int[] lookCorner(Minecraft mc, Player p) {
		int[] s = BuildPlacement.spot(mc, p);
		return new int[] {s[0], s[1], s[2]};
	}

	private static String facing(Player p) {
		Direction d = p.getDirection();
		return d.getAxis().isHorizontal() ? d.getName() : "south";
	}

	// ------------------------------------------------------------------ reads

	static @Nullable View view() {
		return active ? view : null;
	}

	static String dimension() {
		return dimension;
	}

	/** The last plot marked this session (also after it went back to the form), or null. */
	public static DesignSpec.@Nullable Plot last() {
		return last;
	}

	static @Nullable String status() {
		return status;
	}

	/** (7b ST) The site of the last plot marked (null: the last was an on_pad plot, or none). */
	public static @Nullable SiteSpec lastSite() {
		return lastSite;
	}

	private static void setStatus(String s) {
		status = s;
		statusAt = Util.getMillis();
	}

	public static JsonObject state() {
		JsonObject o = new JsonObject();
		o.addProperty("active", active);
		o.addProperty("status", status);
		o.addProperty("fit", fit.wire());
		o.addProperty("fitLocked", active && fitLocked);
		View v = view();
		if (v != null) {
			o.addProperty("phase", switch (v.phase()) {
				case FIRST -> "first_corner";
				case SECOND -> "second_corner";
				case SAMPLING -> "sampling";
				case FRAME -> "frame";
				case PLACING -> "placing";
			});
			if (v.connector() != null) {
				o.addProperty("connector", v.connector());
			}
			if (v.site() != null) {
				o.add("site", v.site().wire());
				o.add("ports", portsJson(framePorts()));
			}
			o.add("first", v.first() == null ? null : xyz(v.first()));
			o.add("hover", xyz(v.hover()));
			o.addProperty("pinned", v.pinned());
			o.addProperty("height", v.height());
			o.addProperty("front", v.front());
			if (v.first() != null) {
				o.add("plot", plotJson(v.plot(dimension)));
			}
		}
		o.add("last", last == null ? null : plotJson(last));
		o.add("lastSite", lastSite == null ? null : lastSite.wire());
		o.add("lastConnector", lastConnector == null ? null : lastConnector.deepCopy());
		return o;
	}

	private static JsonArray portsJson(int[] cells) {
		JsonArray a = new JsonArray();
		for (int i = 0; i + 2 < cells.length; i += 3) {
			a.add(xyz(new int[] {cells[i], cells[i + 1], cells[i + 2]}));
		}
		return a;
	}

	public static JsonObject plotJson(DesignSpec.Plot p) {
		JsonObject o = new JsonObject();
		o.add("min", xyz(new int[] {p.minX(), p.y(), p.minZ()}));
		o.add("max", xyz(new int[] {p.maxX(), p.y(), p.maxZ()}));
		o.addProperty("x", p.dx());
		o.addProperty("z", p.dz());
		o.addProperty("height", p.height());
		o.addProperty("front", p.front());
		o.addProperty("dimension", p.dimension());
		int[] m = p.maxSize();
		JsonObject ms = new JsonObject();
		ms.addProperty("x", m[0]);
		ms.addProperty("y", m[1]);
		ms.addProperty("z", m[2]);
		o.add("maxSize", ms);
		o.addProperty("clamped", p.tooSmall() || p.tooLarge() || p.height() != m[1]);
		return o;
	}

	private static JsonArray xyz(int[] a) {
		JsonArray j = new JsonArray();
		j.add(a[0]);
		j.add(a[1]);
		j.add(a[2]);
		return j;
	}
}
