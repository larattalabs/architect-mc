package dev.larattalabs.architect.client.survival;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.hud.UiBits;
import dev.larattalabs.architect.client.ui.Kit;
import dev.larattalabs.architect.client.ui.Panels;
import dev.larattalabs.architect.client.ui.TextUtil;
import dev.larattalabs.architect.client.ui.UiStyle;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.site.Builder;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.Sites;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import org.jspecify.annotations.Nullable;

/**
 * The construction crate's screen (docs/CONTRACT.md phase 3 "The crate"): the bill of materials with needed / delivered /
 * placed per item (and what is still missing), progress, "Insert from inventory", Pause / Resume and Deconstruct (pressed
 * twice). Notes: waterlogged cells built dry, cells blocked for 200 ticks ("blocked at x,y,z"), credit, a missing crate.
 * Reads the site's state on the integrated server twice a second (singleplayer, as the rest of the mod).
 */
public final class CrateScreen extends Screen {
	static final int MAX_W = 380;
	static final int MAX_H = 300;
	static final int ROW = 18;

	final String siteId;
	@Nullable JsonObject state;
	@Nullable String error;
	@Nullable String flash;
	boolean flashBad;
	long flashAt;
	boolean confirmDeconstruct;
	int scroll;
	int ticks;
	private final List<Hit> hits = new ArrayList<>();

	record Hit(String id, String label, int x, int y, int w, int h, boolean enabled, Runnable action) {
		boolean contains(double mx, double my) {
			return mx >= x && my >= y && mx < x + w && my < y + h;
		}
	}

	public CrateScreen(String siteId) {
		super(Component.literal("Construction crate"));
		this.siteId = siteId;
	}

	@Override
	protected void init() {
		refresh();
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public void tick() {
		if (++ticks % 10 == 0) {
			refresh();
		}
	}

	void refresh() {
		ServerTasks.callOnServer(server -> {
			try {
				return Builder.state(server, siteId);
			} catch (Sites.SiteException e) {
				JsonObject o = new JsonObject();
				o.addProperty("error", e.getMessage());
				return o;
			}
		}).whenComplete((o, t) -> {
			if (t != null) {
				error = t.getMessage();
			} else if (o.has("error") && !o.has("state")) {
				error = o.get("error").getAsString();
				state = null;
			} else {
				error = null;
				state = o;
				if (!"building".equals(str(o, "state"))) {
					flash("The site is " + str(o, "state") + "; the crate is gone", false);
				}
			}
		});
	}

	void flash(String s, boolean bad) {
		flash = s;
		flashBad = bad;
		flashAt = System.currentTimeMillis();
	}

	// ------------------------------------------------------------------ actions (also the DevBridge's)

	public void insertFromInventory() {
		ServerTasks.callAsPlayer((level, player) -> {
			try {
				return "Moved " + Builder.insertFromInventory(player, siteId) + " item(s) into the crate";
			} catch (Sites.SiteException e) {
				return "!" + e.getMessage();
			}
		}).whenComplete((m, t) -> {
			String msg = t != null ? "!" + t.getMessage() : m;
			flash(msg.startsWith("!") ? msg.substring(1) : msg, msg.startsWith("!"));
			refresh();
		});
	}

	public void togglePause() {
		boolean paused = state != null && state.has("paused") && state.get("paused").getAsBoolean();
		ServerTasks.callOnServer(server -> {
			try {
				Builder.setPaused(server, siteId, !paused);
				return paused ? "Resumed" : "Paused";
			} catch (Sites.SiteException e) {
				return "!" + e.getMessage();
			}
		}).whenComplete((m, t) -> {
			String msg = t != null ? "!" + t.getMessage() : m;
			flash(msg.startsWith("!") ? msg.substring(1) : msg, msg.startsWith("!"));
			refresh();
		});
	}

	public void deconstruct() {
		if (!confirmDeconstruct) {
			confirmDeconstruct = true;
			flash("Press Deconstruct again: the terrain comes back, placed blocks are refunded here", false);
			return;
		}
		confirmDeconstruct = false;
		ServerTasks.callAsPlayer((level, player) -> {
			try {
				Site s = Sites.get(siteId);
				var sl = s == null ? level : Sites.levelOf(level.getServer(), s);
				Sites.remove(sl == null ? level : sl, siteId, false);
				return "Deconstructed " + siteId;
			} catch (Sites.SiteException e) {
				return "!" + e.getMessage();
			}
		}).whenComplete((m, t) -> {
			String msg = t != null ? "!" + t.getMessage() : m;
			if (!msg.startsWith("!") && minecraft != null) {
				minecraft.gui.setScreen(null);
				return;
			}
			flash(msg.startsWith("!") ? msg.substring(1) : msg, msg.startsWith("!"));
		});
	}

	// ------------------------------------------------------------------ input

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean doubleClick) {
		for (Hit h : List.copyOf(hits)) {
			if (h.contains(e.x(), e.y())) {
				if (h.enabled()) {
					if (!h.id().equals("deconstruct")) {
						confirmDeconstruct = false;
					}
					h.action().run();
				}
				return true;
			}
		}
		return super.mouseClicked(e, doubleClick);
	}

	@Override
	public boolean mouseScrolled(double x, double y, double sx, double sy) {
		scroll = Math.max(0, scroll - (int) Math.signum(sy));
		return true;
	}

	@Override
	public boolean keyPressed(KeyEvent e) {
		if (e.isEscape()) {
			onClose();
			return true;
		}
		return super.keyPressed(e);
	}

	/** DevBridge: the screen's controls and what it shows. */
	public JsonObject json() {
		JsonObject o = new JsonObject();
		o.addProperty("site", siteId);
		o.addProperty("flash", flash);
		o.addProperty("confirmDeconstruct", confirmDeconstruct);
		JsonArray c = new JsonArray();
		for (Hit h : hits) {
			JsonObject j = new JsonObject();
			j.addProperty("id", h.id());
			j.addProperty("label", h.label());
			j.addProperty("enabled", h.enabled());
			j.addProperty("x", h.x() + h.w() / 2);
			j.addProperty("y", h.y() + h.h() / 2);
			c.add(j);
		}
		o.add("controls", c);
		o.add("state", state);
		return o;
	}

	public boolean press(String id) {
		for (Hit h : List.copyOf(hits)) {
			if (h.id().equals(id) && h.enabled()) {
				if (!id.equals("deconstruct")) {
					confirmDeconstruct = false;
				}
				h.action().run();
				return true;
			}
		}
		return false;
	}

	// ------------------------------------------------------------------ drawing

	@Override
	public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		extractBlurredBackground(g);
		g.fillGradient(0, 0, width, height, UiStyle.withAlpha(UiStyle.INK, 50), UiStyle.withAlpha(UiStyle.INK, 100));
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		hits.clear();
		int pw = Math.min(MAX_W, width - 16);
		int ph = Math.min(MAX_H, height - 16);
		int px = (width - pw) / 2;
		int py = (height - ph) / 2;
		Kit.Padding pad = Kit.padding("panel_paper");
		int cx = px + pad.left();
		int cy = py + pad.top();
		int cw = pw - pad.left() - pad.right();
		int bottom = py + ph - pad.bottom();
		Panels.panel(g, px, py, pw, ph);
		JsonObject s = state;
		String name = s != null && s.has("name") ? s.get("name").getAsString() : siteId;
		Panels.header(g, font, "Construction crate · " + name + " (" + siteId + ")", cx - 2, cy - 2, cw + 4);
		int y = cy + 18;
		if (s == null) {
			Panels.text(g, font, error != null ? error : "Reading the site…", cx, y, error != null ? UiBits.errorText() : UiBits.muted());
			button(g, "close", "Close", cx + cw - 70, bottom - 20, 70, false, true, mouseX, mouseY, this::onClose);
			return;
		}
		boolean building = "building".equals(str(s, "state"));
		boolean paused = s.has("paused") && s.get("paused").getAsBoolean();
		int built = num(s, "built");
		int queue = num(s, "queue");
		double frac = queue == 0 ? 1 : (double) built / queue;
		String line = num(s, "percent") + "% · " + built + " of " + queue + " cells" + (paused ? " · paused" : building ? " · building" : " · " + str(s, "state"));
		Panels.text(g, font, line, cx, y, UiBits.ink());
		String bom = num(s, "bomTotal") + " items in all";
		Panels.text(g, font, bom, cx + cw - font.width(bom), y, UiBits.muted());
		y += 11;
		Panels.progress(g, cx, y, cw, frac, paused ? "brass" : "sage");
		y += 10;
		// notes
		List<String> notes = new ArrayList<>();
		if (s.has("notes")) {
			s.getAsJsonArray("notes").forEach(n -> notes.add(n.getAsString()));
		}
		if (s.has("blocked")) {
			for (JsonElement b : s.getAsJsonArray("blocked")) {
				if (notes.size() < 4) {
					notes.add("blocked at " + b.getAsJsonObject().get("at").getAsString() + " (something stands there)");
				}
			}
		}
		JsonObject credit = s.has("ledger") ? s.getAsJsonObject("ledger").getAsJsonObject("credit") : new JsonObject();
		if (credit.size() > 0) {
			List<String> parts = new ArrayList<>();
			credit.entrySet().forEach(e -> parts.add(e.getValue().getAsInt() + " " + Builder.itemNameClient(e.getKey())));
			notes.add("credit: " + String.join(", ", parts) + " (given back when the site is done)");
		}
		for (String n : notes) {
			for (String l : TextUtil.wrapPlain(font, n, cw)) {
				Panels.text(g, font, l, cx, y, n.startsWith("crate missing") || n.startsWith("blocked") ? UiBits.errorText() : UiBits.muted());
				y += 10;
			}
		}
		y += 2;
		// the BOM table
		int colItem = cx + 2;
		int colNeed = cx + cw - 216;
		int colDel = cx + cw - 162;
		int colPl = cx + cw - 98;
		int colMiss = cx + cw - 46;
		int listTop = y + 12;
		int listBottom = bottom - 38; // room below for the flash line and the scroll hint
		Panels.text(g, font, "Item", colItem + 20, y, UiBits.muted());
		Panels.text(g, font, "Needed", colNeed, y, UiBits.muted());
		Panels.text(g, font, "Delivered", colDel, y, UiBits.muted());
		Panels.text(g, font, "Placed", colPl, y, UiBits.muted());
		Panels.text(g, font, "Missing", colMiss, y, UiBits.muted());
		Panels.inset(g, cx, listTop - 1, cw, listBottom - listTop + 2);
		// what is still missing first (most first), then the rest by name
		List<JsonObject> rows = new ArrayList<>();
		if (s.has("rows")) {
			s.getAsJsonArray("rows").forEach(e -> rows.add(e.getAsJsonObject()));
		}
		rows.sort((p, q) -> num(q, "missing") != num(p, "missing") ? Integer.compare(num(q, "missing"), num(p, "missing"))
			: str(p, "name").compareTo(str(q, "name")));
		int visible = Math.max(1, (listBottom - listTop) / ROW);
		scroll = Math.min(scroll, Math.max(0, rows.size() - visible));
		int ry = listTop + 1;
		for (int i = scroll; i < rows.size() && ry + ROW <= listBottom + 1; i++) {
			JsonObject r = rows.get(i);
			Item item = item(str(r, "item"));
			if (item != null) {
				g.item(new ItemStack(item), colItem, ry);
			}
			int missing = num(r, "missing");
			String nm = TextUtil.ellipsize(font, str(r, "name"), colNeed - colItem - 26);
			int ink = UiBits.ink();
			Panels.text(g, font, nm, colItem + 20, ry + 5, ink);
			Panels.text(g, font, String.valueOf(num(r, "needed")), colNeed, ry + 5, ink);
			Panels.text(g, font, String.valueOf(num(r, "delivered")), colDel, ry + 5, ink);
			Panels.text(g, font, String.valueOf(num(r, "placed")), colPl, ry + 5, ink);
			Panels.text(g, font, missing > 0 ? String.valueOf(missing) : UiBits.CHECK, colMiss, ry + 5, missing > 0 ? UiStyle.CLAY_DARK : UiBits.okText());
			ry += ROW;
		}
		if (rows.size() > visible) {
			String more = (scroll + 1) + "-" + Math.min(rows.size(), scroll + visible) + " of " + rows.size() + " (scroll)";
			Panels.text(g, font, more, cx + cw - font.width(more), listBottom + 3, UiBits.muted());
		}
		// footer: flash, buttons
		int by = bottom - 20;
		int bx = cx;
		bx += button(g, "insert", "Insert from inventory", bx, by, 124, true, building, mouseX, mouseY, this::insertFromInventory) + 4;
		bx += button(g, "pause", paused ? "Resume" : "Pause", bx, by, 60, false, building, mouseX, mouseY, this::togglePause) + 4;
		bx += button(g, "deconstruct", confirmDeconstruct ? "Really deconstruct" : "Deconstruct", bx, by, confirmDeconstruct ? 104 : 80, false, true,
			mouseX, mouseY, this::deconstruct) + 4;
		button(g, "close", "Close", cx + cw - 50, by, 50, false, true, mouseX, mouseY, this::onClose);
		if (flash != null && System.currentTimeMillis() - flashAt < 6000) {
			Panels.text(g, font, TextUtil.ellipsize(font, flash, cw - 110), cx, listBottom + 3, flashBad ? UiBits.errorText() : UiBits.okText());
		}
	}

	private int button(GuiGraphicsExtractor g, String id, String label, int x, int y, int w, boolean primary, boolean enabled, int mx, int my,
		Runnable action) {
		Hit h = new Hit(id, label, x, y, w, 20, enabled, action);
		hits.add(h);
		Panels.button(g, font, label, x, y, w, primary, h.contains(mx, my), !enabled);
		return w;
	}

	static @Nullable Item item(String id) {
		Identifier key = Identifier.tryParse(id);
		return key == null ? null : BuiltInRegistries.ITEM.getOptional(key).orElse(null);
	}

	static String str(JsonObject o, String k) {
		return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : "";
	}

	static int num(JsonObject o, String k) {
		return o.has(k) && o.get(k).isJsonPrimitive() ? o.get(k).getAsInt() : 0;
	}
}
