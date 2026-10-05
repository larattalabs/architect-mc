package dev.larattalabs.architect.client.design;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.api.Massing;
import dev.larattalabs.architect.api.MassingRef;
import dev.larattalabs.architect.api.PreviewLayer;
import dev.larattalabs.architect.api.PreviewStyle;
import dev.larattalabs.architect.apiimpl.Wire4b;
import dev.larattalabs.architect.apiimpl.Wire4c;
import dev.larattalabs.architect.client.hud.Keys;
import dev.larattalabs.architect.client.hud.Toasts;
import dev.larattalabs.architect.client.hud.UiBits;
import dev.larattalabs.architect.client.placement.BuildPlacement;
import dev.larattalabs.architect.client.placement.CompositePreview;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.sidecar.SidecarLink;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import dev.larattalabs.architect.client.ui.Kit;
import dev.larattalabs.architect.client.ui.Panels;
import dev.larattalabs.architect.client.ui.TextUtil;
import dev.larattalabs.architect.client.ui.UiStyle;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.architect.design.MassingRules;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.MassingFiles;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElement;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.core.BlockPos;
import net.minecraft.util.Util;
import net.minecraft.world.level.block.Rotation;
import org.jspecify.annotations.Nullable;

/**
 * Reviewing massings in the world (docs/CONTRACT.md phase 4c "UI"):
 * <ul>
 * <li><b>A design's massing</b> ("Massing first" on the Design tab): when its massing is installed it stands as a massing
 * ghost on the marked plot, else in front of where the player looks, with a bar: <b>Enter</b> Approve (the detail pass starts,
 * bound to this version), <b>R</b> Redirect… (notes, then a new version replaces the ghost), <b>Backspace</b> Cancel (the
 * ghost goes; the massing stays, "Review massing" in the Designs tab shows it again).</li>
 * <li><b>A set's massings</b> (a massingFirst group whose approvalUi is architect): when it waits for approval, all its massings
 * stand in a row in front of the player, numbered left to right in the bar; the Designs tab approves, redirects or cancels each.
 * A group with approvalUi owner shows nothing here (its owner approves).</li>
 * </ul>
 * Both are composite previews ({@link CompositePreview}, keys {@value #KEY} and {@code architect:set:<group>}). Client thread.
 */
public final class MassingReview {
	public static final String KEY = "architect:massing";
	private static final long STATUS_MS = 8000;

	/** The massing on review: its version, where it stands, the plot it was made for. */
	public record Review(Massing massing, String title, int[] origin, DesignSpec.@Nullable Plot plot) {
	}

	private static @Nullable Review review;
	/** Massing jobs (and redirects) the Design tab started: design id -> its plot (empty: none). Their massings open the review. */
	private static final Map<String, Optional<DesignSpec.Plot>> PENDING = new HashMap<>();
	/** The plot each massing was made for (massing id), so a later "Review massing" and the detail pass keep it. */
	private static final Map<String, DesignSpec.Plot> PLOT_BY_MASSING = new HashMap<>();
	/** The set shown, and its items left to right. */
	private static @Nullable String shownSet;
	private static List<String> shownItems = List.of();
	/** The awaiting tokens already shown (a set shows again only when a new massing version waits). */
	private static final Set<String> SHOWN_TOKENS = new HashSet<>();
	private static @Nullable String status;
	private static boolean statusError;
	private static long statusAt;
	private static boolean sending;

	private MassingReview() {
	}

	public static void init() {
		Sidecar.state().addListener(new SidecarState.Listener() {
			@Override
			public void onMassing(JsonObject raw) {
				massingInstalled(raw);
			}

			@Override
			public void onGroup(JsonObject raw) {
				groupChanged(raw);
			}

			@Override
			public void onMassingRemoved(String massingId, String reason) {
				Review r = review;
				if (r != null && r.massing().id().equals(massingId)) {
					close();
				}
			}
		});
		ClientPlayConnectionEvents.DISCONNECT.register((h, mc) -> mc.execute(() -> {
			review = null;
			shownSet = null;
			shownItems = List.of();
		}));
		HudElementRegistry.addLast(Architect.id("hud/massing_review"), dev.larattalabs.architect.client.ui.GuardedHud.of("hud.massing_review",
			new Hud()));
		MassingDev.register();
	}

	public static @Nullable Review review() {
		return review;
	}

	public static @Nullable String shownSet() {
		return shownSet;
	}

	public static List<String> shownItems() {
		return shownItems;
	}

	private static void say(@Nullable String s, boolean error) {
		status = s;
		statusError = error;
		statusAt = Util.getMillis();
	}

	public static @Nullable String status() {
		return status;
	}

	/** The Design tab sent a massing job: when its massing is installed, the review opens (on {@code plot} when one was marked). */
	public static void expect(String designId, DesignSpec.@Nullable Plot plot) {
		PENDING.put(designId, Optional.ofNullable(plot));
	}

	/** The plot a massing was made for, or null. */
	public static DesignSpec.@Nullable Plot plotOf(String massingId) {
		return PLOT_BY_MASSING.get(massingId);
	}

	private static void massingInstalled(JsonObject raw) {
		Massing m = Wire4c.massing(raw);
		Optional<DesignSpec.Plot> plot = PENDING.remove(m.designId());
		if (plot == null) {
			return; // not one the Design tab is waiting for (an API massing, a group's)
		}
		plot.ifPresent(p -> PLOT_BY_MASSING.put(m.id(), p));
		String key = Keys.screen == null ? "B" : Keys.label(Keys.screen);
		String why = open(m.id());
		if (why == null) {
			Toasts.push(Toasts.Level.INFO, "Massing ready: " + title(m), "v" + m.version() + ", " + m.parts().size() + " masses: Enter approves, R redirects",
				key, "designs");
		} else {
			Toasts.push(Toasts.Level.WARN, "Massing ready: " + title(m), why, key, "designs");
		}
	}

	static String title(Massing m) {
		String n = m.request().has("name") ? m.request().get("name").getAsString() : null;
		if (n != null && !n.isBlank()) {
			return n;
		}
		String t = m.type().isEmpty() ? "building" : m.type();
		return Character.toUpperCase(t.charAt(0)) + t.substring(1);
	}

	/** The massing (latest version) as the sidecar last sent it, or null. */
	static @Nullable Massing known(String massingId) {
		JsonObject raw = Sidecar.state().massing(massingId);
		return raw == null ? null : Wire4c.massing(raw);
	}

	/** The massing's blueprint (front, ground row) from its folder, or null. */
	static @Nullable Blueprint blueprint(String ref) {
		Path d = MassingFiles.dir(MassingFiles.root(), ref);
		if (d == null) {
			return null;
		}
		try {
			return Blueprint.fromJson(com.google.gson.JsonParser.parseString(Files.readString(d.resolve(MassingFiles.id(ref) + Blueprints.SIDECAR_SUFFIX),
				StandardCharsets.UTF_8)).getAsJsonObject());
		} catch (Exception e) {
			return null;
		}
	}

	/**
	 * Shows a massing's latest version for review: on its plot, else in front of where the player looks. Returns why not, or
	 * null when it shows.
	 */
	public static @Nullable String open(String massingId) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player == null || mc.level == null) {
			return "Not in a world";
		}
		Massing m = known(massingId);
		if (m == null) {
			return "The helper has no massing " + massingId;
		}
		if (m.group().isPresent()) {
			return massingId + " belongs to the set " + m.group().get() + ": approve it in the Designs tab";
		}
		String ref = m.id() + "@" + m.version();
		Blueprint bp = blueprint(ref);
		if (bp == null) {
			return "Massing " + ref + " is not on disk";
		}
		DesignSpec.Plot plot = PLOT_BY_MASSING.get(m.id());
		int[] o;
		if (plot != null && plot.dimension().equals(mc.player.level().dimension().identifier().toString())) {
			o = plot.placement(bp.front(), bp.sizeX(), bp.sizeZ(), bp.groundY());
		} else {
			int[] s = BuildPlacement.lookSpot(mc, mc.player);
			String facing = BlueprintTransform.DIRECTIONS.get(s[4]);
			o = MassingRules.row(s[0], s[1], s[2], facing, List.of(new MassingRules.Box(bp.sizeX(), bp.sizeZ(), bp.groundY(), bp.front())),
				MassingRules.AHEAD).get(0);
		}
		try {
			CompositePreview.show(KEY, List.of(PreviewLayer.of(ref, new BlockPos(o[0], o[1], o[2]), Rotation.values()[o[3]], PreviewStyle.MASSING)));
		} catch (IllegalArgumentException e) {
			return e.getMessage();
		}
		review = new Review(m, title(m), o, plot);
		say(null, false);
		return null;
	}

	/** Removes the review's ghost (the massing stays). */
	public static void close() {
		review = null;
		CompositePreview.clear(KEY);
	}

	/** Cancel: the ghost goes; the massing stays (Designs tab, "Review massing"). */
	public static void cancel() {
		Review r = review;
		if (r == null) {
			return;
		}
		close();
		say("Massing " + r.title() + " put aside: \"Review massing\" in the Designs tab shows it again", false);
	}

	/** Approve: the detail pass of the reviewed version ({@code design.request {fromMassing, massingVersion}}). */
	public static CompletableFuture<@Nullable String> approve() {
		Review r = review;
		if (r == null) {
			return CompletableFuture.completedFuture(null);
		}
		if (!Sidecar.connected()) {
			say("The design helper is not running", true);
			return CompletableFuture.completedFuture(null);
		}
		JsonObject req = MassingRules.detailRequest(r.massing().request(), r.massing().id(), r.massing().version());
		sending = true;
		return Sidecar.designRequest(req).handle((ack, err) -> {
			sending = false;
			if (err != null || !ack.ok()) {
				say("Not approved: " + (err != null ? err.getMessage() : ack.error()), true);
				return null;
			}
			String id = ack.result() != null && ack.result().has("designId") ? ack.result().get("designId").getAsString() : null;
			if (id != null) {
				DesignFeature.trackDetail(id, r.plot());
			}
			close();
			say("Approved " + r.title() + " v" + r.massing().version() + ": the detail design (" + id + ") is under way; the Designs tab shows it",
				false);
			return id;
		});
	}

	/** Redirect…: the notes dialog, then {@code massing.redirect}; the new version opens the review again. */
	public static void redirectDialog() {
		Review r = review;
		Minecraft mc = Minecraft.getInstance();
		if (r == null) {
			return;
		}
		mc.gui.setScreen(new RedirectScreen("How should " + r.title() + " v" + r.massing().version() + " change? A new massing version replaces it.",
			MassingReview::redirect, () -> {
			}));
	}

	/** {@code massing.redirect {massingId, notes}} for the reviewed massing. */
	public static CompletableFuture<@Nullable String> redirect(String notes) {
		Review r = review;
		if (r == null) {
			return CompletableFuture.completedFuture(null);
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "massing.redirect");
		m.addProperty("massingId", r.massing().id());
		m.addProperty("notes", notes);
		sending = true;
		return Sidecar.link().send(m).handle((ack, err) -> {
			sending = false;
			if (err != null || !ack.ok()) {
				say("Not redirected: " + (err != null ? err.getMessage() : ack.error()), true);
				return null;
			}
			String id = ack.result().get("designId").getAsString();
			int v = ack.result().get("version").getAsInt();
			PENDING.put(id, Optional.ofNullable(r.plot()));
			close();
			say("Redirecting " + r.title() + " (v" + v + ", " + id + "): it shows here when it is ready", false);
			return id;
		});
	}

	// ------------------------------------------------------------------ sets

	static String setKey(String groupId) {
		return "architect:set:" + groupId;
	}

	private static void groupChanged(JsonObject raw) {
		Group g = Wire4b.group(raw);
		if (shownSet != null && shownSet.equals(g.id()) && (g.finished() || g.status() != Group.Status.AWAITING_APPROVAL && g.awaiting().isEmpty())) {
			hideSet();
		}
		if (g.status() != Group.Status.AWAITING_APPROVAL || g.approvalUi() != GroupRequest.ApprovalUi.ARCHITECT) {
			return;
		}
		List<String> tokens = Wire4c.awaitingTokens(g);
		boolean fresh = false;
		for (String t : tokens) {
			fresh |= SHOWN_TOKENS.add(g.id() + "@" + g.createdAt() + "|" + t);
		}
		if (!fresh || Minecraft.getInstance().player == null) {
			return;
		}
		String why = showSet(g.id());
		String key = Keys.screen == null ? "B" : Keys.label(Keys.screen);
		Toasts.push(Toasts.Level.INFO, "Set " + g.name() + ": " + g.awaiting().size() + " massing" + (g.awaiting().size() == 1 ? "" : "s")
			+ " to approve", why != null ? why : "They stand in a row in front of you; approve, redirect or cancel each in the Designs tab", key,
			"designs");
	}

	/** Shows a set's massings in a row in front of the player. Returns why not, or null. */
	public static @Nullable String showSet(String groupId) {
		Minecraft mc = Minecraft.getInstance();
		JsonObject raw = Sidecar.state().group(groupId);
		if (raw == null || mc.player == null) {
			return mc.player == null ? "Not in a world" : "No set " + groupId;
		}
		Group g = Wire4b.group(raw);
		List<String> keys = new ArrayList<>();
		List<String> refs = new ArrayList<>();
		List<MassingRules.Box> boxes = new ArrayList<>();
		for (Group.Item it : g.items()) {
			if (it.massing().isEmpty() || it.stage().orElse(null) == Group.Stage.DETAIL) {
				continue;
			}
			MassingRef ref = it.massing().get();
			String r = ref.id() + "@" + ref.version();
			Blueprint bp = blueprint(r);
			if (bp == null || !MassingFiles.exists(r)) {
				continue; // a redirect still designing: its last version is not installed yet (or gone)
			}
			keys.add(it.itemKey());
			refs.add(r);
			boxes.add(new MassingRules.Box(bp.sizeX(), bp.sizeZ(), bp.groundY(), bp.front()));
		}
		if (boxes.isEmpty()) {
			return "None of its massings is ready to show";
		}
		int[] s = BuildPlacement.lookSpot(mc, mc.player);
		List<int[]> at = MassingRules.row(s[0], s[1], s[2], BlueprintTransform.DIRECTIONS.get(s[4]), boxes, MassingRules.AHEAD + 2);
		List<PreviewLayer> layers = new ArrayList<>();
		for (int i = 0; i < refs.size(); i++) {
			int[] o = at.get(i);
			layers.add(PreviewLayer.of(refs.get(i), new BlockPos(o[0], o[1], o[2]), Rotation.values()[o[3]], PreviewStyle.MASSING));
		}
		if (shownSet != null && !shownSet.equals(groupId)) {
			CompositePreview.clear(setKey(shownSet));
		}
		try {
			CompositePreview.show(setKey(groupId), layers);
		} catch (IllegalArgumentException e) {
			return e.getMessage();
		}
		shownSet = groupId;
		shownItems = List.copyOf(keys);
		return null;
	}

	public static void hideSet() {
		if (shownSet != null) {
			CompositePreview.clear(setKey(shownSet));
		}
		shownSet = null;
		shownItems = List.of();
	}

	// ------------------------------------------------------------------ keys

	/**
	 * The review bar's keys, before vanilla sees them (no screen open, not placing): Enter approves, R redirects…, Backspace (or
	 * Esc) cancels. Returns true when the key was consumed.
	 */
	public static boolean onKey(int action, KeyEvent e) {
		if (review == null || action == InputConstants.RELEASE) {
			return false;
		}
		Minecraft mc = Minecraft.getInstance();
		if (mc.gui.screen() != null || BuildPlacement.active()) {
			return false;
		}
		boolean ours = switch (e.key()) {
			case InputConstants.KEY_RETURN, InputConstants.KEY_NUMPADENTER, InputConstants.KEY_R, InputConstants.KEY_BACKSPACE, InputConstants.KEY_DELETE,
				InputConstants.KEY_ESCAPE -> true;
			default -> false;
		};
		if (action != InputConstants.PRESS) {
			return ours; // a held key repeats nothing
		}
		switch (e.key()) {
			case InputConstants.KEY_RETURN, InputConstants.KEY_NUMPADENTER -> {
				if (!sending) {
					approve();
				}
				return true;
			}
			case InputConstants.KEY_R -> {
				redirectDialog();
				return true;
			}
			case InputConstants.KEY_BACKSPACE, InputConstants.KEY_DELETE, InputConstants.KEY_ESCAPE -> {
				cancel();
				return true;
			}
			default -> {
				return false;
			}
		}
	}

	// ------------------------------------------------------------------ HUD

	/** The review bar (a design's massing) or the set's legend, above the hotbar. */
	static final class Hud implements HudElement {
		@Override
		public void extractRenderState(GuiGraphicsExtractor g, DeltaTracker dt) {
			Minecraft mc = Minecraft.getInstance();
			if (mc.player == null || BuildPlacement.active()) {
				return;
			}
			Font font = mc.font;
			Review r = review;
			boolean fresh = status != null && Util.getMillis() - statusAt < STATUS_MS;
			List<String[]> lines = new ArrayList<>(); // {text, colour}
			String[] hints = new String[0];
			int maxW = Math.min(440, g.guiWidth() - 16);
			Kit.Padding p = Kit.padding("tooltip");
			int inner = maxW - p.left() - p.right();
			if (r != null) {
				Massing m = r.massing();
				String head = "Massing: " + r.title() + " v" + m.version() + (m.redirect().isPresent() ? " (redirected)" : "");
				lines.add(new String[] {TextUtil.ellipsize(font, head, inner), Integer.toString(UiStyle.CREAM)});
				String detail = m.parts().size() + " masses (" + String.join(", ", m.parts().keySet()) + ") · " + m.size().x() + "×" + m.size().y() + "×"
					+ m.size().z() + (r.plot() != null ? " · on your plot" : "") + String.format(Locale.ROOT, " · $%.2f", m.cost().usd());
				lines.add(new String[] {TextUtil.ellipsize(font, detail, inner), Integer.toString(UiBits.activityOnInk())});
				lines.add(new String[] {TextUtil.ellipsize(font, sending ? "Sending…" : "Approve to design the detail inside these masses, or redirect it.", inner),
					Integer.toString(UiStyle.SAGE)});
				hints = new String[] {"Enter", "approve", "R", "redirect…", "Backspace", "cancel"};
			} else if (shownSet != null) {
				JsonObject raw = Sidecar.state().group(shownSet);
				Group gr = raw == null ? null : Wire4b.group(raw);
				if (gr != null) {
					lines.add(new String[] {TextUtil.ellipsize(font, "Set " + gr.name() + ": " + gr.awaiting().size() + " massing" + (gr.awaiting().size() == 1
						? "" : "s") + " to approve", inner), Integer.toString(UiStyle.CREAM)});
					StringBuilder sb = new StringBuilder("Left to right: ");
					for (int i = 0; i < shownItems.size(); i++) {
						String k = shownItems.get(i);
						String name = gr.item(k).flatMap(Group.Item::name).orElse(k);
						sb.append(i == 0 ? "" : "  ").append(i + 1).append(' ').append(name);
					}
					for (String l : TextUtil.wrapPlain(font, sb.toString(), inner).stream().limit(2).toList()) {
						lines.add(new String[] {l, Integer.toString(UiBits.activityOnInk())});
					}
					String k = Keys.screen == null ? "B" : Keys.label(Keys.screen);
					lines.add(new String[] {TextUtil.ellipsize(font, "Approve, redirect or cancel each in the Designs tab (" + k + ")", inner), Integer.toString(
						UiStyle.SAGE)});
				}
			}
			if (fresh) {
				for (String l : TextUtil.wrapPlain(font, status, inner)) {
					lines.add(new String[] {l, Integer.toString(statusError ? 0xFFF07060 : UiStyle.CREAM)});
				}
			}
			if (lines.isEmpty()) {
				lastRect = null;
				return;
			}
			int textW = hints.length == 0 ? 0 : UiBits.hintsWidth(font, hints);
			for (String[] l : lines) {
				textW = Math.max(textW, font.width(l[0]));
			}
			int w = Math.min(maxW, textW + p.left() + p.right());
			int h = p.top() + lines.size() * 10 + (hints.length == 0 ? 0 : 15) + p.bottom() - 1;
			int x = (g.guiWidth() - w) / 2;
			int y = g.guiHeight() - 64 - h;
			if (y < g.guiHeight() / 2 + 8) {
				y = Math.max(g.guiHeight() / 2 + 8, g.guiHeight() - 26 - h);
			}
			lastRect = new int[] {x, y, w, h};
			Panels.sprite(g, Kit.TOOLTIP, x, y, w, h, 0xF0FFFFFF);
			int ty = y + p.top();
			for (String[] l : lines) {
				g.text(font, l[0], x + p.left(), ty, Integer.parseInt(l[1]), false);
				ty += 10;
			}
			if (hints.length > 0) {
				UiBits.hints(g, font, x + p.left(), ty + 2, true, hints);
			}
		}
	}

	/** The bar drawn last frame (x, y, w, h), null when hidden. */
	static volatile int @Nullable [] lastRect;

	/** For the DevBridge ({@code dev.massing.state}). */
	public static JsonObject stateJson() {
		JsonObject o = new JsonObject();
		Review r = review;
		if (r != null) {
			JsonObject j = new JsonObject();
			j.addProperty("massing", r.massing().id());
			j.addProperty("version", r.massing().version());
			j.addProperty("title", r.title());
			j.addProperty("origin", r.origin()[0] + "," + r.origin()[1] + "," + r.origin()[2]);
			j.addProperty("turns", r.origin()[3]);
			j.addProperty("onPlot", r.plot() != null);
			o.add("review", j);
		}
		JsonArray pend = new JsonArray();
		PENDING.keySet().forEach(pend::add);
		o.add("pending", pend);
		o.addProperty("shownSet", shownSet);
		JsonArray items = new JsonArray();
		shownItems.forEach(items::add);
		o.add("shownItems", items);
		o.addProperty("status", status);
		o.addProperty("statusError", statusError);
		o.addProperty("sending", sending);
		int[] rect = lastRect;
		if (rect != null) {
			o.addProperty("barRect", rect[0] + "," + rect[1] + "," + rect[2] + "," + rect[3]);
		}
		return o;
	}

	static void sayFor(SidecarLink.@Nullable Ack ack, @Nullable Throwable err, String ok) {
		if (err != null || ack == null || !ack.ok()) {
			say(ok + " failed: " + (err != null ? err.getMessage() : ack == null ? "no answer" : ack.error()), true);
		} else {
			say(ok, false);
		}
	}
}
