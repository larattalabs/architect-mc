package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.larattalabs.architect.client.design.DesignFeature;
import dev.larattalabs.architect.client.design.DesignForm;
import dev.larattalabs.architect.client.design.PreviewImages;
import dev.larattalabs.architect.client.hud.UiBits;
import dev.larattalabs.architect.client.launcher.Launcher;
import dev.larattalabs.architect.client.placement.BlueprintPreview;
import dev.larattalabs.architect.client.placement.PlacementFeature;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import dev.larattalabs.architect.client.text.TextFieldView;
import dev.larattalabs.architect.client.text.TextKeys;
import dev.larattalabs.architect.client.text.TextModel;
import dev.larattalabs.architect.client.ui.Kit;
import dev.larattalabs.architect.client.ui.Panels;
import dev.larattalabs.architect.client.ui.TextUtil;
import dev.larattalabs.architect.client.ui.UiStyle;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.architect.launcher.LauncherPlan;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.Sites;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.ConfirmLinkScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * The one Architect screen ({@code B}, {@code /architect}; docs/CONTRACT.md "Mod scope for phase 1"), with four tabs:
 * <ul>
 * <li><b>Design</b>: the request form (type, style chips or your own words, materials, features, size S/M/L/custom or a
 * marked plot, name, notes) and "Design it";</li>
 * <li><b>Library</b>: the designs (previews, Place, Delete with a confirm) and the sites placed in this world (Remove, Move,
 * Undo move);</li>
 * <li><b>Designs</b>: the queue and its progress, Cancel;</li>
 * <li><b>Status</b>: the helper (launcher) state, auth, the API key field and the claude-login toggle.</li>
 * </ul>
 * Controls are hit boxes with stable ids ({@link #click(String)}, DevBridge {@code dev.ui.click}). Client thread.
 */
public final class ArchitectScreen extends Screen {
	public enum Tab {
		DESIGN, LIBRARY, DESIGNS, STATUS;

		public String id() {
			return name().toLowerCase(Locale.ROOT);
		}

		public String label() {
			return switch (this) {
				case DESIGN -> "Design";
				case LIBRARY -> "Library";
				case DESIGNS -> "Designs";
				case STATUS -> "Status";
			};
		}

		public static @Nullable Tab of(String s) {
			for (Tab t : values()) {
				if (t.id().equalsIgnoreCase(s)) {
					return t;
				}
			}
			return null;
		}
	}

	/** The personal-use note next to the claude-login toggle (the task's exact words). */
	public static final String CLAUDE_LOGIN_NOTE = "Personal use only: runs on your own claude.ai login. Anthropic doesn't allow third-party "
		+ "products to offer claude.ai login, so it's off by default.";

	private static final int MAX_W = 640;
	private static final int MAX_H = 400;
	private static final int CHIP_H = 14;
	private static final int ROW_H = 24;

	enum Focus {
		NONE, STYLE, MATERIALS, NAME, NOTES, KEY
	}

	record Hit(String id, String label, int x, int y, int w, int h, boolean enabled, boolean on, Runnable action) {
		boolean contains(double mx, double my) {
			return mx >= x && mx < x + w && my >= y && my < y + h;
		}
	}

	private static Tab lastTab = Tab.DESIGN;
	private static boolean showPlaced;
	private static @Nullable String selectedDesign;
	private static @Nullable String selectedEntry;
	private static @Nullable String selectedSite;

	private Tab tab;
	private Focus focus = Focus.NONE;
	private final List<Hit> hits = new ArrayList<>();
	private final TextFieldView styleView = new TextFieldView();
	private final TextFieldView materialsView = new TextFieldView();
	private final TextFieldView nameView = new TextFieldView();
	private final TextFieldView notesView = new TextFieldView();
	private final int[][] fields = new int[5][3];
	private int notesLines = 4;
	/** The API key being typed (never shown, logged or kept after sending). */
	private final StringBuilder key = new StringBuilder();
	private @Nullable String keyMessage;
	private boolean keyMessageError;
	private @Nullable String armedDelete;
	private long armedAt;
	private @Nullable String armedRemove;
	private @Nullable String libraryMessage;
	private boolean libraryMessageError;
	private int listScroll;
	private int listNeeded;
	private int listAvailable;
	private int[] listArea = new int[4];

	public ArchitectScreen(@Nullable Tab tab) {
		super(Component.literal("Architect"));
		this.tab = tab == null ? lastTab : tab;
	}

	/** Opens the screen (B, /architect, after plot marking) at {@code tab} (null = the last one). */
	public static ArchitectScreen open(@Nullable Tab tab) {
		ArchitectScreen s = new ArchitectScreen(tab);
		net.minecraft.client.Minecraft.getInstance().gui.setScreen(s);
		return s;
	}

	public Tab tab() {
		return tab;
	}

	public void setTab(Tab t) {
		setFocus(Focus.NONE);
		tab = t;
		lastTab = t;
		listScroll = 0;
	}

	@Override
	public boolean isPauseScreen() {
		return dev.larattalabs.architect.client.ui.ScreenPause.pauses();
	}

	@Override
	public void removed() {
		if (focus != Focus.NONE && minecraft != null) {
			minecraft.onTextInputFocusChange(this, false);
		}
		focus = Focus.NONE;
		key.setLength(0);
		PreviewImages.releaseAll();
		super.removed();
	}

	private void setFocus(Focus f) {
		if ((f != Focus.NONE) != (focus != Focus.NONE) && minecraft != null) {
			minecraft.onTextInputFocusChange(this, f != Focus.NONE);
		}
		focus = f;
		TextModel m = model();
		if (m != null) {
			m.touch();
		}
	}

	String focusName() {
		return focus.name().toLowerCase(Locale.ROOT);
	}

	private @Nullable TextModel model() {
		DesignForm f = DesignFeature.form();
		return switch (focus) {
			case STYLE -> f.styleText;
			case MATERIALS -> f.materials;
			case NAME -> f.name;
			case NOTES -> f.notes;
			default -> null;
		};
	}

	// ------------------------------------------------------------------ input

	@Override
	public boolean keyPressed(KeyEvent e) {
		int k = e.key();
		if (e.isEscape()) {
			if (focus != Focus.NONE) {
				setFocus(Focus.NONE);
				return true;
			}
			onClose();
			return true;
		}
		if (focus == Focus.KEY) {
			if (k == InputConstants.KEY_BACKSPACE && key.length() > 0) {
				key.setLength(e.hasControlDown() || e.hasAltDown() ? 0 : key.length() - 1);
			} else if (TextKeys.isPaste(e) && minecraft != null) {
				String clip = minecraft.keyboardHandler.getClipboard().strip();
				if (clip.length() < 400) {
					key.append(clip);
				}
			} else if (TextKeys.isEnter(e)) {
				saveKey();
			}
			keyMessage = null;
			return true;
		}
		if (k == InputConstants.KEY_TAB && tab == Tab.DESIGN) {
			Focus[] order = {Focus.STYLE, Focus.MATERIALS, Focus.NAME, Focus.NOTES};
			int i = java.util.Arrays.asList(order).indexOf(focus);
			setFocus(order[Math.floorMod(i + (e.hasShiftDown() ? -1 : 1), order.length)]);
			return true;
		}
		if (TextKeys.isEnter(e)) {
			if (tab == Tab.DESIGN && e.hasControlDown()) {
				submit();
			} else if (focus == Focus.NOTES) {
				DesignFeature.form().notes.insert("\n");
			} else if (focus != Focus.NONE) {
				setFocus(Focus.NONE);
			}
			return true;
		}
		TextModel m = model();
		if (m != null) {
			if (focus == Focus.NOTES && (k == InputConstants.KEY_UP || k == InputConstants.KEY_DOWN)) {
				m.vertical(font, TextFieldView.wrapWidth(font, m, fields[Focus.NOTES.ordinal() - 1][2], notesStyle()), k == InputConstants.KEY_UP ? -1 : 1,
					e.hasShiftDown());
				return true;
			}
			TextKeys.handle(e, m);
			DesignFeature.form().sendError = null;
			return true; // a focused field swallows the rest
		}
		if (focus == Focus.NONE && k >= InputConstants.KEY_1 && k <= InputConstants.KEY_4 && !e.hasControlDown()) {
			setTab(Tab.values()[k - InputConstants.KEY_1]);
			return true;
		}
		return super.keyPressed(e);
	}

	@Override
	public boolean charTyped(CharacterEvent e) {
		if (focus == Focus.KEY) {
			if (e.codepoint() > 32 && e.codepoint() < 127 && key.length() < 400) {
				key.append(e.codepointAsString());
				keyMessage = null;
			}
			return true;
		}
		TextModel m = model();
		if (m != null && e.codepoint() >= 32) {
			m.insert(e.codepointAsString());
			DesignFeature.form().sendError = null;
			return true;
		}
		return false;
	}

	@Override
	public boolean mouseScrolled(double x, double y, double scrollX, double scrollY) {
		if (listNeeded > listAvailable && x >= listArea[0] && x < listArea[0] + listArea[2] + 8 && y >= listArea[1] && y < listArea[1] + listArea[3]) {
			listScroll = Math.max(0, Math.min(listNeeded - listAvailable, listScroll + (scrollY > 0 ? -ROW_H : ROW_H)));
			return true;
		}
		return super.mouseScrolled(x, y, scrollX, scrollY);
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean doubleClick) {
		for (Hit h : List.copyOf(hits)) {
			if (h.contains(e.x(), e.y())) {
				if (h.enabled()) {
					DesignFeature.form().sendError = null;
					h.action().run();
				}
				return true;
			}
		}
		if (tab == Tab.DESIGN) {
			DesignForm f = DesignFeature.form();
			TextModel[] models = {f.styleText, f.materials, f.name, f.notes};
			TextFieldView[] views = {styleView, materialsView, nameView, notesView};
			Focus[] foci = {Focus.STYLE, Focus.MATERIALS, Focus.NAME, Focus.NOTES};
			for (int i = 0; i < 4; i++) {
				int[] r = fields[i];
				int at = views[i].hit(font, models[i], r[0], r[1], r[2], styleFor(foci[i]), e.x(), e.y());
				if (at >= 0) {
					setFocus(foci[i]);
					models[i].moveTo(at, false);
					return true;
				}
			}
		}
		setFocus(Focus.NONE);
		return super.mouseClicked(e, doubleClick);
	}

	/** Runs the control with id {@code id} as a click would (DevBridge {@code dev.ui.click}). Returns false when there is none. */
	public boolean click(String id) {
		for (Hit h : List.copyOf(hits)) {
			if (h.id().equals(id)) {
				if (h.enabled()) {
					h.action().run();
				}
				return h.enabled();
			}
		}
		return false;
	}

	/** Focuses a text field by name (style, materials, name, notes, key) for the DevBridge. */
	public void focus(String name) {
		setFocus(Focus.valueOf(name.toUpperCase(Locale.ROOT)));
	}

	/** DevBridge: types into the API key field (as keystrokes would). */
	public void typeKey(String s) {
		key.append(s);
	}

	// ------------------------------------------------------------------ actions

	private void submit() {
		setFocus(Focus.NONE);
		DesignFeature.submit().thenAccept(sent -> {
			if (sent.designId() != null && minecraft != null && minecraft.gui.screen() == this) {
				selectedDesign = sent.designId();
				setTab(Tab.DESIGNS);
			}
		});
	}

	private void saveKey() {
		if (key.length() == 0) {
			keyMessage = "Type or paste a key first";
			keyMessageError = true;
			return;
		}
		String k = key.toString();
		key.setLength(0);
		setFocus(Focus.NONE);
		keyMessage = "Sending…";
		keyMessageError = false;
		Sidecar.authSet(k, false, null).whenComplete((ack, err) -> {
			if (err != null || ack == null || !ack.ok()) {
				keyMessage = "Not saved: " + (err != null ? err.getMessage() : ack == null ? "no answer" : ack.error());
				keyMessageError = true;
			} else {
				keyMessage = "Saved by the helper (never shown again)";
				keyMessageError = false;
			}
		});
	}

	private void clearKey() {
		Sidecar.authSet(null, true, null).whenComplete((ack, err) -> {
			keyMessage = err != null || ack == null || !ack.ok() ? "Not cleared: " + (err != null ? err.getMessage() : ack == null ? "no answer" : ack.error())
				: "Key removed";
			keyMessageError = err != null || ack == null || !ack.ok();
		});
	}

	private void toggleClaudeLogin() {
		boolean on = !Sidecar.state().status().useClaudeLogin();
		Sidecar.authSet(null, false, on).whenComplete((ack, err) -> {
			if (err != null || ack == null || !ack.ok()) {
				keyMessage = "Not changed: " + (err != null ? err.getMessage() : ack == null ? "no answer" : ack.error());
				keyMessageError = true;
			}
		});
	}

	private void place(String id) {
		String why = PlacementFeature.placeNow(id);
		libraryMessage = why;
		libraryMessageError = why != null;
	}

	private void placeOnPlot(String id) {
		String why = DesignFeature.placeOnPlot(id);
		libraryMessage = why;
		libraryMessageError = why != null;
	}

	private void delete(Blueprints.Entry e) {
		String id = e.blueprint().id();
		long now = Util.getMillis();
		if (!id.equals(armedDelete) || now - armedAt > 6000) {
			armedDelete = id;
			armedAt = now;
			libraryMessage = "Delete " + e.blueprint().name() + "? Click Delete again to move it to architect/library-trash";
			libraryMessageError = true;
			return;
		}
		armedDelete = null;
		try {
			LibraryFiles.trash(e);
			libraryMessage = "Deleted " + id + " (kept in architect/library-trash)";
			libraryMessageError = false;
			selectedEntry = null;
			DesignFeature.reload(null);
		} catch (Exception ex) {
			libraryMessage = "Could not delete " + id + ": " + ex.getMessage();
			libraryMessageError = true;
		}
	}

	private void removeSite(Site s, boolean force) {
		dev.larattalabs.architect.client.world.ServerTasks.callAsPlayer((level, player) -> {
			try {
				var sl = Sites.levelOf(level.getServer(), s);
				Site gone = Sites.remove(sl == null ? level : sl, s.id(), force);
				return "Removed " + gone.id() + "; the terrain is back";
			} catch (Sites.SiteException ex) {
				return "!" + ex.getMessage();
			}
		}).whenComplete((msg, err) -> {
			String m = err != null ? "!" + err.getMessage() : msg;
			libraryMessageError = m.startsWith("!");
			libraryMessage = libraryMessageError ? m.substring(1) : m;
			armedRemove = libraryMessageError && m.contains("confirm again with force") ? s.id() : null;
		});
	}

	private void undoMove(Site s) {
		dev.larattalabs.architect.client.world.ServerTasks.callOnServer(server -> {
			try {
				Sites.undoMove(server, s.id(), false);
				return "Moved " + s.id() + " back";
			} catch (Sites.SiteException ex) {
				return "!" + ex.getMessage();
			}
		}).whenComplete((msg, err) -> {
			String m = err != null ? "!" + err.getMessage() : msg;
			libraryMessageError = m.startsWith("!");
			libraryMessage = libraryMessageError ? m.substring(1) : m;
		});
	}

	// ------------------------------------------------------------------ drawing: frame

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
		Panels.header(g, font, "Architect", cx - 2, cy - 2, cw + 4);
		// helper pill, right of the header
		String pill;
		String fam;
		switch (Launcher.state()) {
			case RUNNING -> {
				pill = "helper running";
				fam = "done";
			}
			case STARTING, INSTALLING -> {
				pill = "helper " + Launcher.state().wire();
				fam = "working";
			}
			case NODE_MISSING -> {
				pill = "Node.js missing";
				fam = "error";
			}
			case CRASHED -> {
				pill = "helper stopped";
				fam = "error";
			}
			default -> {
				pill = "helper " + Launcher.state().wire();
				fam = "idle";
			}
		}
		int ow = UiBits.dotPillWidth(font, pill);
		UiBits.dotPill(g, font, fam, pill, cx + cw - ow, cy - 1, UiBits.ink());
		// tabs
		int ty = cy + 16;
		int tx = cx;
		for (Tab t : Tab.values()) {
			String label = t.label() + badge(t);
			int w = font.width(label) + 16;
			Hit h = new Hit("tab:" + t.id(), label, tx, ty, w, 16, true, t == tab, () -> setTab(t));
			hits.add(h);
			Panels.sprite(g, t == tab ? Kit.TAB_ACTIVE : Kit.TAB_INACTIVE, tx, ty, w, 16);
			g.text(font, label, tx + 8, ty + 4, t == tab ? UiBits.ink() : h.contains(mouseX, mouseY) ? UiBits.ink() : UiBits.muted(), false);
			tx += w + 3;
		}
		int top = ty + 22;
		int footerY = bottom - 20;
		switch (tab) {
			case DESIGN -> drawDesign(g, cx, top, cw, footerY, mouseX, mouseY);
			case LIBRARY -> drawLibrary(g, cx, top, cw, footerY, mouseX, mouseY);
			case DESIGNS -> drawDesigns(g, cx, top, cw, footerY, mouseX, mouseY);
			case STATUS -> drawStatus(g, cx, top, cw, footerY, mouseX, mouseY);
		}
	}

	private String badge(Tab t) {
		if (t == Tab.DESIGNS) {
			long running = Sidecar.state().designs().stream().filter(d -> d.status().isRunning()).count();
			return running > 0 ? " (" + running + ")" : "";
		}
		return "";
	}

	private void button(GuiGraphicsExtractor g, String id, String label, int x, int y, int w, boolean primary, boolean enabled, int mx, int my,
		Runnable action) {
		Hit h = new Hit(id, label, x, y, w, 20, enabled, primary, action);
		hits.add(h);
		UiBits.ButtonState st = !enabled ? UiBits.ButtonState.DISABLED : h.contains(mx, my) ? UiBits.ButtonState.HOVER : UiBits.ButtonState.NORMAL;
		UiBits.button(g, font, label, 0, x, y, w, primary, st, false);
	}

	private int bw(String label) {
		return UiBits.buttonWidth(font, label, 0);
	}

	private int label(GuiGraphicsExtractor g, String text, Map<String, String> errors, int x, int y, int w, String field) {
		g.text(font, text, x, y, UiStyle.CLAY_DARK, false);
		String err = errors.get(field);
		if (err != null) {
			int ex = x + font.width(text) + 6;
			g.text(font, TextUtil.ellipsize(font, err, Math.max(10, x + w - ex)), ex, y, UiBits.errorText(), false);
		}
		return y + 11;
	}

	private int chip(GuiGraphicsExtractor g, String id, String label, int x, int y, boolean on, boolean enabled, int mx, int my, Runnable action) {
		int w = font.width(label) + 12;
		Hit h = new Hit(id, label, x, y, w, CHIP_H, enabled, on, action);
		hits.add(h);
		Panels.sprite(g, on ? Kit.TAB_ACTIVE : Kit.TAB_INACTIVE, x, y, w, CHIP_H, enabled ? 0xFFFFFFFF : 0x90FFFFFF);
		if (enabled && !on && h.contains(mx, my)) {
			g.fill(x + 1, y + 1, x + w - 1, y + CHIP_H - 1, 0x14000000);
		}
		int color = !enabled ? UiStyle.color("paper.disabled", 0xFFA39B8E) : on ? UiBits.ink() : UiBits.muted();
		g.text(font, label, x + 6, y + 3, color, false);
		return w;
	}

	private int chips(GuiGraphicsExtractor g, String prefix, List<DesignSpec.Choice> choices, @Nullable String selected, int x, int y, int w, int mx,
		int my, java.util.function.Consumer<String> pick) {
		int cx = x;
		for (DesignSpec.Choice c : choices) {
			int cwid = font.width(c.label()) + 12;
			if (cx > x && cx + cwid > x + w) {
				cx = x;
				y += CHIP_H + 3;
			}
			cx += chip(g, prefix + c.id(), c.label(), cx, y, c.id().equals(selected), true, mx, my, () -> pick.accept(c.id())) + 3;
		}
		return y + CHIP_H + 5;
	}

	private void statusLine(GuiGraphicsExtractor g, @Nullable String text, boolean error, int x, int y, int w) {
		if (text != null && !text.isEmpty()) {
			g.text(font, TextUtil.ellipsize(font, text, w), x, y, error ? UiBits.errorText() : UiBits.okText(), false);
		}
	}

	// ------------------------------------------------------------------ Design tab

	private TextFieldView.Style styleFor(Focus f) {
		DesignForm form = DesignFeature.form();
		return switch (f) {
			case STYLE -> new TextFieldView.Style(null, 0, "or your own words, e.g. art deco seaside", null, null, 0, 1);
			case MATERIALS -> new TextFieldView.Style(null, 0, "optional, e.g. spruce and cobblestone", null, null, 0, 1);
			case NAME -> new TextFieldView.Style(null, 0, "optional, e.g. Lakeside cabin", null, form.name.length() + "/" + DesignSpec.MAX_NAME,
				UiBits.muted(), 1);
			default -> notesStyle();
		};
	}

	private TextFieldView.Style notesStyle() {
		return new TextFieldView.Style(null, 0, "rooms, mood, anything the designer should know", null, null, 0, notesLines);
	}

	private void field(GuiGraphicsExtractor g, Focus f, TextFieldView view, TextModel m, int x, int y, int w) {
		int[] r = fields[f.ordinal() - 1];
		r[0] = x;
		r[1] = y;
		r[2] = w;
		view.draw(g, font, m, x, y, w, focus == f, styleFor(f));
	}

	private void drawDesign(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my) {
		DesignForm f = DesignFeature.form();
		Map<String, String> errors = f.errors();
		int colW = (w - 14) / 2;
		int lx = x;
		int rx = x + colW + 14;
		int muted = UiBits.muted();
		int y = top;
		// left: type, style, materials, features
		y = label(g, "Building type", errors, lx, y, colW, "type");
		y = chips(g, "type:", DesignSpec.TYPES, f.type, lx, y, colW, mx, my, id -> f.type = id);
		DesignSpec.Choice tc = DesignSpec.find(DesignSpec.TYPES, f.type);
		if (tc != null) {
			g.text(font, TextUtil.ellipsize(font, tc.label() + ": " + tc.description(), colW), lx, y - 2, muted, false);
			y += 10;
		}
		y = label(g, "Style", errors, lx, y + 2, colW, "style");
		boolean typed = !f.styleText.value().isBlank();
		y = chips(g, "style:", DesignSpec.STYLES, typed ? null : f.styleChip, lx, y, colW, mx, my, id -> {
			f.styleChip = id;
			f.styleText.clear();
		});
		field(g, Focus.STYLE, styleView, f.styleText, lx, y - 2, colW);
		y += TextFieldView.BASE_H + 2;
		y = label(g, "Materials", errors, lx, y, colW, "materials");
		field(g, Focus.MATERIALS, materialsView, f.materials, lx, y, colW);
		y += TextFieldView.BASE_H + 4;
		y = label(g, "Features (up to " + DesignSpec.MAX_FEATURES + ")", errors, lx, y, colW, "features");
		int fx = lx;
		for (DesignSpec.Choice c : DesignSpec.FEATURES) {
			int fw = 12 + font.width(c.label()) + 10;
			if (fx > lx && fx + fw > lx + colW) {
				fx = lx;
				y += 14;
			}
			boolean on = f.features.contains(c.id());
			boolean can = on || f.features.size() < DesignSpec.MAX_FEATURES;
			Hit h = new Hit("feature:" + c.id(), c.label(), fx, y, fw, 12, can, on, () -> f.toggleFeature(c.id()));
			hits.add(h);
			Panels.sprite(g, on ? Kit.CHECKBOX_CHECKED : Kit.CHECKBOX, fx, y + 1, 10, 10, can ? 0xFFFFFFFF : 0x90FFFFFF);
			g.text(font, c.label(), fx + 13, y + 2, on || h.contains(mx, my) ? UiBits.ink() : muted, false);
			fx += fw;
		}
		// right: size, name, notes
		int ry = top;
		ry = label(g, "Size", errors, rx, ry, colW, "maxSize");
		int cx = rx;
		for (String s : List.of("S", "M", "L")) {
			cx += chip(g, "size:" + s, s, cx, ry, s.equals(f.size), true, mx, my, () -> f.size = s) + 3;
		}
		cx += chip(g, "size:custom", "Custom", cx, ry, DesignForm.CUSTOM.equals(f.size), true, mx, my, () -> {
			int[] m = f.maxSize();
			f.customX = m[0];
			f.customY = m[1];
			f.customZ = m[2];
			f.size = DesignForm.CUSTOM;
		}) + 3;
		if (f.plot != null) {
			cx += chip(g, "size:plot", "Plot", cx, ry, DesignForm.PLOT.equals(f.size), true, mx, my, () -> f.size = DesignForm.PLOT) + 3;
		}
		chip(g, "mark_plot", f.plot != null ? "Re-mark…" : "Mark a plot…", cx + 2, ry, false, minecraft != null && minecraft.player != null, mx, my, () -> {
			setFocus(Focus.NONE);
			DesignFeature.startPlot();
		});
		ry += CHIP_H + 4;
		if (DesignForm.CUSTOM.equals(f.size)) {
			int sx = rx;
			sx = stepper(g, "w", "W", f.customX, DesignSpec.MIN_XZ, DesignSpec.MAX_XZ, sx, ry, mx, my, v -> f.customX = v);
			sx = stepper(g, "h", "H", f.customY, DesignSpec.MIN_Y, DesignSpec.MAX_Y, sx + 6, ry, mx, my, v -> f.customY = v);
			stepper(g, "d", "D", f.customZ, DesignSpec.MIN_XZ, DesignSpec.MAX_XZ, sx + 6, ry, mx, my, v -> f.customZ = v);
			ry += CHIP_H + 4;
		}
		int[] m = f.maxSize();
		g.text(font, TextUtil.ellipsize(font, "at most " + m[0] + " wide × " + m[1] + " high × " + m[2] + " deep", colW), rx, ry, UiBits.ink(), false);
		ry += 10;
		DesignSpec.Plot p = f.plot;
		if (p != null && DesignForm.PLOT.equals(f.size)) {
			g.text(font, TextUtil.ellipsize(font, "plot " + p.dx() + " × " + p.dz() + " at " + p.minX() + ", " + p.y() + ", " + p.minZ() + " · entrance "
				+ p.front(), colW), rx, ry, muted, false);
			ry += 10;
		}
		ry += 4;
		ry = label(g, "Name", errors, rx, ry, colW, "name");
		field(g, Focus.NAME, nameView, f.name, rx, ry, colW);
		ry += TextFieldView.BASE_H + 4;
		ry = label(g, "Notes", errors, rx, ry, colW, "notes");
		int room = footerY - 18 - ry;
		notesLines = Math.max(2, Math.min(8, (room - TextFieldView.BASE_H) / TextFieldView.LINE + 1));
		field(g, Focus.NOTES, notesView, f.notes, rx, ry, colW);
		// status + footer
		String status;
		boolean err;
		if (DesignFeature.sending()) {
			status = "Sending…";
			err = false;
		} else if (f.sendError != null) {
			status = f.sendError;
			err = true;
		} else if (!errors.isEmpty()) {
			status = errors.size() == 1 ? "1 field needs a fix (in red)" : errors.size() + " fields need a fix (in red)";
			err = true;
		} else if (!Sidecar.connected()) {
			status = "The design helper is not running yet (Status tab).";
			err = true;
		} else {
			status = "Ready: Claude designs it in the background; the Designs tab shows progress.";
			err = false;
		}
		statusLine(g, status, err, x, footerY - 13, w);
		int bx = x + w;
		String go = "Design it";
		bx -= bw(go);
		button(g, "submit", go, bx, footerY, bw(go), true, !DesignFeature.sending() && errors.isEmpty(), mx, my, this::submit);
		String reset = "Clear";
		bx -= bw(reset) + 6;
		button(g, "reset", reset, bx, footerY, bw(reset), false, true, mx, my, DesignFeature::resetForm);
		String[] hints = {"Tab", "next field", "Ctrl+Enter", "design it", "Esc", "close"};
		if (UiBits.hintsWidth(font, hints) <= bx - x - 6) {
			UiBits.hints(g, font, x, footerY + 4, false, hints);
		}
	}

	private int stepper(GuiGraphicsExtractor g, String id, String name, int value, int min, int max, int x, int y, int mx, int my,
		java.util.function.IntConsumer set) {
		x += chip(g, "custom:" + id + "-", "−", x, y, false, value > min, mx, my, () -> set.accept(Math.max(min, value - 1))) + 2;
		String v = name + " " + value;
		g.text(font, v, x, y + 3, UiBits.ink(), false);
		x += font.width(v) + 2;
		x += chip(g, "custom:" + id + "+", "+", x, y, false, value < max, mx, my, () -> set.accept(Math.min(max, value + 1)));
		return x;
	}

	// ------------------------------------------------------------------ Library tab

	private void drawLibrary(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my) {
		int listW = Math.min(240, (w - 12) / 2);
		int cx = x;
		cx += chip(g, "library:designs", "Designs (" + Blueprints.entries().size() + ")", cx, top, !showPlaced, true, mx, my, () -> {
			showPlaced = false;
			listScroll = 0;
		}) + 3;
		chip(g, "library:placed", "Placed here (" + Sites.all().size() + ")", cx, top, showPlaced, true, mx, my, () -> {
			showPlaced = true;
			listScroll = 0;
		});
		int ly = top + CHIP_H + 6;
		int lh = footerY - 16 - ly;
		listArea = new int[] {x, ly, listW, lh};
		listAvailable = lh;
		Panels.inset(g, x, ly, listW, lh);
		int dx = x + listW + 12;
		int dw = w - listW - 12;
		if (showPlaced) {
			drawSites(g, x, ly, listW, lh, dx, dw, footerY, mx, my);
		} else {
			drawEntries(g, x, ly, listW, lh, dx, dw, footerY, mx, my);
		}
		statusLine(g, libraryMessage, libraryMessageError, x, footerY - 13, w);
		String reload = "Reload library";
		button(g, "reload", reload, x + w - bw(reload), footerY, bw(reload), false, true, mx, my, () -> {
			libraryMessage = "Reloading…";
			libraryMessageError = false;
			DesignFeature.reload(null).thenAccept(ok -> {
				libraryMessage = "Library: " + Blueprints.ids().size() + " design(s)" + (Blueprints.lastProblems().isEmpty() ? ""
					: ", " + Blueprints.lastProblems().size() + " skipped (see the log)");
				libraryMessageError = !Blueprints.lastProblems().isEmpty();
			});
		});
	}

	private void drawEntries(GuiGraphicsExtractor g, int x, int ly, int listW, int lh, int dx, int dw, int footerY, int mx, int my) {
		List<Blueprints.Entry> entries = new ArrayList<>(Blueprints.entries());
		entries.sort((a, b) -> Long.compare(b.blueprint().createdAt(), a.blueprint().createdAt()));
		if (selectedEntry == null || Blueprints.entry(selectedEntry) == null) {
			selectedEntry = entries.isEmpty() ? null : entries.get(0).blueprint().id();
		}
		listNeeded = entries.size() * ROW_H + 4;
		listScroll = Math.max(0, Math.min(listScroll, Math.max(0, listNeeded - lh)));
		g.enableScissor(x + 1, ly + 1, x + listW - 1, ly + lh - 1);
		int ry = ly + 3 - listScroll;
		for (Blueprints.Entry e : entries) {
			Blueprint b = e.blueprint();
			boolean sel = b.id().equals(selectedEntry);
			if (ry + ROW_H > ly && ry < ly + lh) {
				Hit h = new Hit("entry:" + b.id(), b.name(), x + 2, Math.max(ry, ly), listW - 4, Math.min(ROW_H - 2, ly + lh - ry), true, sel,
					() -> selectedEntry = b.id());
				hits.add(h);
				if (sel) {
					g.fill(x + 2, ry, x + listW - 2, ry + ROW_H - 2, 0x22D97757);
				} else if (h.contains(mx, my)) {
					g.fill(x + 2, ry, x + listW - 2, ry + ROW_H - 2, 0x12000000);
				}
				g.text(font, TextUtil.ellipsize(font, b.name(), listW - 14), x + 6, ry + 2, UiBits.ink(), false);
				String sub = b.type() + " · " + b.sizeX() + "×" + b.sizeY() + "×" + b.sizeZ() + " · " + (e.bundled() ? "bundled" : "yours");
				g.text(font, TextUtil.ellipsize(font, sub, listW - 14), x + 6, ry + 12, UiBits.muted(), false);
			}
			ry += ROW_H;
		}
		g.disableScissor();
		if (entries.isEmpty()) {
			g.text(font, "No designs yet: the Design tab makes one.", x + 6, ly + 6, UiBits.muted(), false);
		}
		scrollbar(g, x + listW + 2, ly, lh);
		Blueprints.Entry e = selectedEntry == null ? null : Blueprints.entry(selectedEntry);
		if (e == null) {
			return;
		}
		Blueprint b = e.blueprint();
		int y = ly;
		int box = Math.max(40, Math.min(dw, footerY - 16 - ly - 74));
		Panels.inset(g, dx, y, dw, box);
		List<PreviewImages.Found> previews = PreviewImages.find(b.id());
		boolean drawn = !previews.isEmpty() && PreviewImages.draw(g, previews.get(0), dx + 2, y + 2, dw - 4, box - 4);
		if (!drawn) {
			BlueprintPreview.draw(g, b.id(), dx + (dw - (box - 8)) / 2, y + 4, box - 8);
		}
		y += box + 4;
		g.text(font, TextUtil.ellipsize(font, b.name() + "  (" + b.id() + ")", dw), dx, y, UiBits.ink(), false);
		y += 11;
		String facts = b.type() + " · " + b.sizeX() + " × " + b.sizeY() + " × " + b.sizeZ() + " · entrance " + b.front()
			+ (b.tags().isEmpty() ? "" : " · " + String.join(", ", b.tags()));
		g.text(font, TextUtil.ellipsize(font, facts, dw), dx, y, UiBits.muted(), false);
		y += 11;
		for (String line : TextUtil.wrapPlain(font, b.description(), dw).stream().limit(2).toList()) {
			g.text(font, line, dx, y, UiBits.ink(), false);
			y += 10;
		}
		int by = footerY - 16 - 20;
		int bx = dx;
		String place = "Place";
		button(g, "place", place, bx, by, bw(place), true, minecraft != null && minecraft.player != null, mx, my, () -> place(b.id()));
		bx += bw(place) + 4;
		if (DesignFeature.plotForBlueprint(b.id()) != null) {
			String onPlot = "Place on the plot";
			button(g, "place_plot", onPlot, bx, by, bw(onPlot), false, true, mx, my, () -> placeOnPlot(b.id()));
			bx += bw(onPlot) + 4;
		}
		String del = b.id().equals(armedDelete) && Util.getMillis() - armedAt < 6000 ? "Delete (sure?)" : "Delete";
		button(g, "delete", del, dx + dw - bw(del), by, bw(del), false, !e.bundled(), mx, my, () -> delete(e));
	}

	private void drawSites(GuiGraphicsExtractor g, int x, int ly, int listW, int lh, int dx, int dw, int footerY, int mx, int my) {
		List<Site> sites = Sites.all();
		if (selectedSite == null || Sites.get(selectedSite) == null) {
			selectedSite = sites.isEmpty() ? null : sites.get(sites.size() - 1).id();
		}
		listNeeded = sites.size() * ROW_H + 4;
		listScroll = Math.max(0, Math.min(listScroll, Math.max(0, listNeeded - lh)));
		g.enableScissor(x + 1, ly + 1, x + listW - 1, ly + lh - 1);
		int ry = ly + 3 - listScroll;
		for (Site s : sites) {
			boolean sel = s.id().equals(selectedSite);
			if (ry + ROW_H > ly && ry < ly + lh) {
				Hit h = new Hit("site:" + s.id(), s.id(), x + 2, Math.max(ry, ly), listW - 4, Math.min(ROW_H - 2, ly + lh - ry), true, sel,
					() -> selectedSite = s.id());
				hits.add(h);
				if (sel) {
					g.fill(x + 2, ry, x + listW - 2, ry + ROW_H - 2, 0x22D97757);
				}
				Blueprint b = Blueprints.get(s.blueprint());
				g.text(font, TextUtil.ellipsize(font, s.id() + "  " + (b == null ? s.blueprint() : b.name()), listW - 14), x + 6, ry + 2, UiBits.ink(), false);
				g.text(font, TextUtil.ellipsize(font, s.box().minX() + ", " + s.box().minY() + ", " + s.box().minZ() + " · " + s.rotation().replace('_', ' '),
					listW - 14), x + 6, ry + 12, UiBits.muted(), false);
			}
			ry += ROW_H;
		}
		g.disableScissor();
		if (sites.isEmpty()) {
			g.text(font, "Nothing placed in this world yet.", x + 6, ly + 6, UiBits.muted(), false);
		}
		scrollbar(g, x + listW + 2, ly, lh);
		Site s = selectedSite == null ? null : Sites.get(selectedSite);
		if (s == null) {
			return;
		}
		int y = ly;
		g.text(font, TextUtil.ellipsize(font, s.id() + " · " + s.blueprint(), dw), dx, y, UiBits.ink(), false);
		y += 12;
		for (String line : List.of("box " + Anchors.str(s.box()), "restores " + Anchors.str(s.restoreBox()), s.dimension() + " · " + s.rotation(),
			s.movedFrom() == null ? "never moved" : "moved from " + s.movedFrom().x() + ", " + s.movedFrom().y() + ", " + s.movedFrom().z())) {
			g.text(font, TextUtil.ellipsize(font, line, dw), dx, y, UiBits.muted(), false);
			y += 10;
		}
		Sites.Report r = Sites.reports().get(s.id());
		if (r != null) {
			for (String line : TextUtil.wrapPlain(font, r.message(), dw).stream().limit(4).toList()) {
				g.text(font, line, dx, y, r.problem() ? UiBits.errorText() : UiBits.muted(), false);
				y += 10;
			}
		}
		int by = footerY - 16 - 20;
		int bx = dx;
		boolean force = s.id().equals(armedRemove);
		String rm = force ? "Remove anyway" : "Remove";
		button(g, "remove", rm, bx, by, bw(rm), true, true, mx, my, () -> removeSite(s, force));
		bx += bw(rm) + 4;
		String mv = "Move…";
		button(g, "move", mv, bx, by, bw(mv), false, true, mx, my, () -> {
			String why = PlacementFeature.startMove(s.id());
			libraryMessage = why;
			libraryMessageError = why != null;
		});
		bx += bw(mv) + 4;
		String undo = "Undo move";
		button(g, "undo_move", undo, bx, by, bw(undo), false, s.movedFrom() != null, mx, my, () -> undoMove(s));
	}

	private void scrollbar(GuiGraphicsExtractor g, int x, int y, int h) {
		if (listNeeded > h) {
			TextUtil.Scroll sc = new TextUtil.Scroll().update(listNeeded, h);
			sc.scrollBy(-1_000_000);
			sc.scrollBy(listScroll);
			Panels.scrollbar(g, x, y, h, sc, false);
		}
	}

	// ------------------------------------------------------------------ Designs tab

	private void drawDesigns(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my) {
		List<SidecarState.Design> designs = Sidecar.state().designs();
		int listW = Math.min(240, (w - 12) / 2);
		int lh = footerY - 16 - top;
		listArea = new int[] {x, top, listW, lh};
		listAvailable = lh;
		Panels.inset(g, x, top, listW, lh);
		if (selectedDesign == null || Sidecar.state().design(selectedDesign) == null) {
			selectedDesign = designs.isEmpty() ? null : designs.get(0).id();
		}
		listNeeded = designs.size() * ROW_H + 4;
		listScroll = Math.max(0, Math.min(listScroll, Math.max(0, listNeeded - lh)));
		g.enableScissor(x + 1, top + 1, x + listW - 1, top + lh - 1);
		int ry = top + 3 - listScroll;
		for (SidecarState.Design d : designs) {
			boolean sel = d.id().equals(selectedDesign);
			if (ry + ROW_H > top && ry < top + lh) {
				Hit h = new Hit("design:" + d.id(), d.title(), x + 2, Math.max(ry, top), listW - 4, Math.min(ROW_H - 2, top + lh - ry), true, sel,
					() -> selectedDesign = d.id());
				hits.add(h);
				if (sel) {
					g.fill(x + 2, ry, x + listW - 2, ry + ROW_H - 2, 0x22D97757);
				}
				String fam = switch (d.status()) {
					case DONE -> "done";
					case FAILED -> "error";
					case CANCELLED -> "idle";
					case QUEUED -> "waiting";
					default -> "working";
				};
				Panels.dot(g, fam, x + 6, ry + 4, false);
				g.text(font, TextUtil.ellipsize(font, d.title(), listW - 24), x + 16, ry + 2, UiBits.ink(), false);
				g.text(font, TextUtil.ellipsize(font, d.status().wire() + " · " + d.step(), listW - 24), x + 16, ry + 12, UiBits.muted(), false);
			}
			ry += ROW_H;
		}
		g.disableScissor();
		if (designs.isEmpty()) {
			g.text(font, Sidecar.connected() ? "No designs yet." : "The design helper is not connected.", x + 6, top + 6, UiBits.muted(), false);
		}
		scrollbar(g, x + listW + 2, top, lh);
		SidecarState.Design d = selectedDesign == null ? null : Sidecar.state().design(selectedDesign);
		if (d == null) {
			return;
		}
		int dx = x + listW + 12;
		int dw = w - listW - 12;
		int y = top;
		g.text(font, TextUtil.ellipsize(font, d.title() + "  (" + d.id() + ")", dw), dx, y, UiBits.ink(), false);
		y += 12;
		g.text(font, TextUtil.ellipsize(font, d.status().wire() + (d.step().isEmpty() ? "" : ": " + d.step()), dw), dx, y, UiBits.muted(), false);
		y += 12;
		JsonObject r = d.request();
		for (String k : List.of("type", "style", "materials", "name")) {
			if (r.has(k)) {
				g.text(font, TextUtil.ellipsize(font, k + ": " + r.get(k).getAsString(), dw), dx, y, UiBits.ink(), false);
				y += 10;
			}
		}
		if (r.has("features")) {
			g.text(font, TextUtil.ellipsize(font, "features: " + r.get("features").toString().replaceAll("[\\[\\]\"]", "").replace(",", ", "), dw), dx, y,
				UiBits.ink(), false);
			y += 10;
		}
		if (r.has("maxSize")) {
			JsonObject s = r.getAsJsonObject("maxSize");
			g.text(font, "at most " + s.get("x") + " × " + s.get("y") + " × " + s.get("z"), dx, y, UiBits.ink(), false);
			y += 10;
		}
		if (d.blueprintId() != null) {
			g.text(font, TextUtil.ellipsize(font, "result: " + d.blueprintId() + (d.size() == null ? "" : " (" + d.size()[0] + "×" + d.size()[1] + "×"
				+ d.size()[2] + ")"), dw), dx, y, UiBits.okText(), false);
			y += 10;
		}
		if (d.error() != null) {
			for (String line : TextUtil.wrapPlain(font, d.error(), dw).stream().limit(6).toList()) {
				g.text(font, line, dx, y, UiBits.errorText(), false);
				y += 10;
			}
		}
		int by = footerY - 16 - 20;
		String cancel = "Cancel";
		button(g, "cancel_design", cancel, dx, by, bw(cancel), false, d.status().isRunning() && Sidecar.connected(), mx, my,
			() -> DesignFeature.cancel(d.id()));
		if (d.status() == SidecarState.DesignStatus.DONE && d.blueprintId() != null) {
			String show = "Show in Library";
			button(g, "show_library", show, dx + bw(cancel) + 4, by, bw(show), true, Blueprints.get(d.blueprintId()) != null, mx, my, () -> {
				selectedEntry = d.blueprintId();
				showPlaced = false;
				setTab(Tab.LIBRARY);
			});
		}
	}

	// ------------------------------------------------------------------ Status tab

	private void drawStatus(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my) {
		int colW = (w - 14) / 2;
		int lx = x;
		int rx = x + colW + 14;
		int y = top;
		// left: the helper
		g.text(font, "Design helper", lx, y, UiStyle.CLAY_DARK, false);
		y += 12;
		LauncherPlan.State st = Launcher.state();
		String fam = switch (st) {
			case RUNNING -> "done";
			case STARTING, INSTALLING -> "working";
			case NODE_MISSING, CRASHED -> "error";
			default -> "idle";
		};
		Panels.dot(g, fam, lx, y + 1, false);
		g.text(font, st.wire(), lx + 10, y, UiBits.ink(), false);
		y += 11;
		for (String line : TextUtil.wrapPlain(font, Launcher.detail(), colW).stream().limit(4).toList()) {
			g.text(font, line, lx, y, st == LauncherPlan.State.RUNNING ? UiBits.muted() : st == LauncherPlan.State.NODE_MISSING
				|| st == LauncherPlan.State.CRASHED ? UiBits.errorText() : UiBits.muted(), false);
			y += 10;
		}
		if (Launcher.installLine() != null) {
			g.text(font, TextUtil.ellipsize(font, "npm: " + Launcher.installLine(), colW), lx, y, UiBits.muted(), false);
			y += 10;
		}
		y += 2;
		LauncherPlan.Source src = Launcher.source();
		List<String> facts = new ArrayList<>();
		facts.add("node: " + (Launcher.node() == null ? "not found" : Launcher.node() + " (" + Launcher.nodeVersion() + ")"));
		facts.add("from: " + (src == null ? "-" : src.origin() + (src.dir() == null ? "" : " " + src.dir())));
		facts.add("port " + Sidecar.port() + (Launcher.reusedRunning() ? " · reused" : Launcher.startedByUs() ? " · started by this game" : ""));
		facts.add("link: " + Sidecar.state().link().phaseName() + (Sidecar.state().link().lastError() == null ? "" : " (" + Sidecar.state().link()
			.lastError() + ")"));
		facts.add("log: " + Launcher.logFile());
		for (String f : facts) {
			g.text(font, TextUtil.ellipsize(font, f, colW), lx, y, UiBits.muted(), false);
			y += 10;
		}
		y += 4;
		int bx = lx;
		String restart = Launcher.state() == LauncherPlan.State.RUNNING || Launcher.startedByUs() ? "Restart helper" : "Start helper";
		button(g, "restart_helper", restart, bx, y, bw(restart), false, true, mx, my, () -> {
			if (Launcher.startedByUs()) {
				Launcher.restart();
			} else {
				Launcher.start();
			}
		});
		bx += bw(restart) + 4;
		if (st == LauncherPlan.State.NODE_MISSING) {
			String get = "Get Node.js…";
			button(g, "get_node", get, bx, y, bw(get), true, true, mx, my, () -> ConfirmLinkScreen.confirmLinkNow(this,
				java.net.URI.create(LauncherPlan.NODE_INSTALL_URL)));
		}
		y += 24;
		List<String> tail = Launcher.logTail();
		if (!tail.isEmpty()) {
			int th = Math.min(footerY - 4 - y, tail.size() * 9 + 6);
			if (th > 20) {
				Panels.inset(g, lx, y, colW, th);
				int ly = y + 3;
				for (String line : tail.subList(Math.max(0, tail.size() - (th - 6) / 9), tail.size())) {
					g.text(font, TextUtil.ellipsize(font, line, colW - 8), lx + 4, ly, UiBits.ink(), false);
					ly += 9;
				}
			}
		}
		// right: auth
		int ry = top;
		g.text(font, "Claude access", rx, ry, UiStyle.CLAY_DARK, false);
		ry += 12;
		SidecarState.Status s = Sidecar.state().status();
		String auth = !Sidecar.connected() ? "unknown (helper not connected)" : switch (s.auth()) {
			case "ok" -> "ready" + (s.authSource() == null ? "" : ": " + s.authSource());
			case "missing" -> "no credentials yet: add an API key";
			case "failed" -> "failed" + (s.authSource() == null ? "" : " (" + s.authSource() + ")");
			case "checking" -> "checking…";
			default -> s.auth();
		};
		Panels.dot(g, "ok".equals(s.auth()) ? "done" : "failed".equals(s.auth()) || "missing".equals(s.auth()) ? "error" : "idle", rx, ry + 1, false);
		g.text(font, TextUtil.ellipsize(font, auth, colW - 10), rx + 10, ry, UiBits.ink(), false);
		ry += 11;
		if (Sidecar.connected()) {
			g.text(font, TextUtil.ellipsize(font, "Agent SDK " + s.sdk() + (s.version() == null ? "" : " · helper " + s.version()), colW), rx, ry,
				UiBits.muted(), false);
			ry += 10;
		}
		ry += 6;
		g.text(font, "Anthropic API key", rx, ry, UiStyle.CLAY_DARK, false);
		ry += 11;
		int fw = colW;
		Hit field = new Hit("key_field", "API key", rx, ry, fw, TextFieldView.BASE_H, true, focus == Focus.KEY, () -> setFocus(Focus.KEY));
		hits.add(field);
		Panels.sprite(g, focus == Focus.KEY ? Kit.TEXT_FIELD_FOCUSED : Kit.TEXT_FIELD, rx, ry, fw, TextFieldView.BASE_H);
		String shown = key.length() == 0 ? "" : "•".repeat(Math.min(key.length(), 48));
		if (shown.isEmpty() && focus != Focus.KEY) {
			g.text(font, TextUtil.ellipsize(font, "sk-ant-… (paste with Ctrl+V)", fw - 12), rx + 6, ry + 5, UiStyle.color("ink_ui.ghost_on_paper",
				0xFFBCAD95), false);
		} else {
			String fit = TextUtil.ellipsize(font, shown, fw - 14);
			g.text(font, fit, rx + 6, ry + 5, UiBits.ink(), false);
			if (focus == Focus.KEY && UiBits.caretOn(0)) {
				int cxp = rx + 6 + font.width(fit);
				g.fill(cxp, ry + 4, cxp + 1, ry + 13, UiBits.ink());
			}
		}
		ry += TextFieldView.BASE_H + 4;
		String save = "Save key";
		button(g, "save_key", save, rx, ry, bw(save), true, key.length() > 0 && Sidecar.connected(), mx, my, this::saveKey);
		String clear = "Remove key";
		button(g, "clear_key", clear, rx + bw(save) + 4, ry, bw(clear), false, Sidecar.connected(), mx, my, this::clearKey);
		ry += 24;
		statusLine(g, keyMessage, keyMessageError, rx, ry, colW);
		ry += 12;
		for (String line : TextUtil.wrapPlain(font, "Stored by the helper in sidecar-data/secrets.json, never in the game's files.", colW)) {
			g.text(font, line, rx, ry, UiBits.muted(), false);
			ry += 10;
		}
		ry += 6;
		boolean on = s.useClaudeLogin();
		String toggle = "Use my claude.ai login instead";
		int tw = 13 + font.width(toggle);
		Hit t = new Hit("claude_login", toggle, rx, ry, Math.min(colW, tw), 12, Sidecar.connected(), on, this::toggleClaudeLogin);
		hits.add(t);
		Panels.sprite(g, on ? Kit.CHECKBOX_CHECKED : Kit.CHECKBOX, rx, ry + 1, 10, 10, Sidecar.connected() ? 0xFFFFFFFF : 0x90FFFFFF);
		g.text(font, TextUtil.ellipsize(font, toggle, colW - 13), rx + 13, ry + 2, UiBits.ink(), false);
		ry += 14;
		for (String line : TextUtil.wrapPlain(font, CLAUDE_LOGIN_NOTE, colW)) {
			g.text(font, line, rx, ry, UiBits.muted(), false);
			ry += 10;
		}
		String[] hints = {"1-4", "tabs", "Esc", "close"};
		UiBits.hints(g, font, x, footerY + 4, false, hints);
	}

	// ------------------------------------------------------------------ DevBridge

	public JsonObject stateJson() {
		JsonObject o = new JsonObject();
		o.addProperty("tab", tab.id());
		o.addProperty("focus", focusName());
		o.addProperty("guiWidth", width);
		o.addProperty("guiHeight", height);
		o.addProperty("keyTyped", key.length()); // the length only, never the key
		o.addProperty("keyMessage", keyMessage);
		o.addProperty("libraryMessage", libraryMessage);
		o.addProperty("showPlaced", showPlaced);
		o.addProperty("selectedEntry", selectedEntry);
		o.addProperty("selectedSite", selectedSite);
		o.addProperty("selectedDesign", selectedDesign);
		JsonArray a = new JsonArray();
		for (Hit h : hits) {
			JsonObject j = new JsonObject();
			j.addProperty("id", h.id());
			j.addProperty("label", h.label());
			j.addProperty("state", !h.enabled() ? "disabled" : h.on() ? "on" : "normal");
			j.addProperty("x", h.x() + h.w() / 2);
			j.addProperty("y", h.y() + h.h() / 2);
			a.add(j);
		}
		o.add("controls", a);
		return o;
	}
}
