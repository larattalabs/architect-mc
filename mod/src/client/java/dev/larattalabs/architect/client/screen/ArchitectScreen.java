package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.larattalabs.architect.client.design.DesignFeature;
import dev.larattalabs.architect.client.design.DesignForm;
import dev.larattalabs.architect.client.design.PreviewImages;
import dev.larattalabs.labui.client.hud.UiBits;
import dev.larattalabs.architect.client.launcher.Launcher;
import dev.larattalabs.architect.client.library.LibraryFeature;
import dev.larattalabs.architect.client.placement.BlueprintPreview;
import dev.larattalabs.architect.client.placement.PlacementFeature;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import dev.larattalabs.labui.client.text.TextFieldView;
import dev.larattalabs.labui.client.text.TextKeys;
import dev.larattalabs.labui.client.text.TextModel;
import dev.larattalabs.labui.client.ui.Kit;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
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
import net.minecraft.client.gui.Font;
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
 * <li><b>Library</b>: the designs ({@link LibraryTab}: a grid of cards with search, filters and sort, the detail panel with
 * Place, Rename, Tags, Star, Delete, Export, Remix…, Variants…, and the Variants… / Import… dialogs) and the sites placed in
 * this world (Remove, Move, Undo move);</li>
 * <li><b>Designs</b>: the queue and its progress (designs, variants and imports), Cancel;</li>
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
	static final int CHIP_H = 14;
	private static final int ROW_H = 24;

	enum Focus {
		NONE, STYLE, MATERIALS, NAME, NOTES, KEY, SEARCH, RENAME, TAGS, VNAME, OTYPE, SET_NAME, SET_PROMPT, SET_TYPE, SET_INAME, SET_NOTES, SET_CONTEXT,
		/** (4c) the Designs tab's redirect notes for a set's item. */
		REDIRECT,
		/** (U3) words alongside the picked Style; the "Save as style…" name. */
		STYLE_NOTE, SAVE_NAME,
		/** (U3) the Import dialog's search. */
		IMPORT_FILTER;

		/** A field of the set dialog's item rows (focused with an index). */
		boolean perItem() {
			return this == SET_TYPE || this == SET_INAME || this == SET_NOTES;
		}

		boolean set() {
			return name().startsWith("SET_");
		}
	}

	/** A choice in a popup (the type/tag filters, the palette dropdowns). */
	record Option(String id, String label, boolean on) {
	}

	/**
	 * An open popup (U3: one searchable list, lab-ui {@link dev.larattalabs.labui.client.widget.ScrollList}, for the Type, Tag, Collection,
	 * profile, sort and re-skin choices): a filter line (focused: typing searches), a capped scrolling list, picked by a click or Enter;
	 * drawn last, clicked first, Esc closes it. Each option is also a zero-size control {@code option:<popup>:<option>} for the DevBridge.
	 */
	private final class Popup {
		final String id;
		final int ax;
		final int ay;
		final int w;
		final List<Option> options;
		final java.util.function.Consumer<String> pick;
		final dev.larattalabs.labui.client.widget.ScrollList<Option> list;
		boolean clicking;
		int x;
		int y;
		int h;

		Popup(String id, int ax, int ay, int w, List<Option> options, java.util.function.Consumer<String> pick) {
			this.id = id;
			this.ax = ax;
			this.ay = ay;
			this.w = w;
			this.options = options;
			this.pick = pick;
			list = new dev.larattalabs.labui.client.widget.ScrollList<Option>(dev.larattalabs.labui.client.widget.ScrollList.ROW_H, (g, f, o, rx, ry, rw,
				rh, sel, hov) -> {
				int tx = rx + 5;
				if (o.on()) {
					g.text(f, "✓", tx, ry + (rh - 8) / 2, UiStyle.CLAY_DARK, false);
				}
				g.text(f, TextUtil.ellipsize(f, o.label(), rw - 20), tx + 10, ry + (rh - 8) / 2, UiBits.ink(), false);
			});
			if (options.size() > 5) {
				list.filter(Option::label, "Search " + options.size() + "…");
			}
			list.empty("Nothing matches");
			list.items(options);
			list.focused(true);
			list.onActivate(this::choose);
			list.onSelect(o -> {
				if (clicking) {
					choose(o);
				}
			});
			for (Option o : options) {
				if (o.on()) {
					list.select(o);
					break;
				}
			}
		}

		void choose(Option o) {
			closePopup();
			pick.accept(o.id());
		}

		boolean contains(double mx, double my) {
			return mx >= x && mx < x + w && my >= y && my < y + h;
		}
	}

	/** A text field drawn this frame (for click-to-focus). */
	private record FieldRect(Focus focus, int index, TextFieldView view, TextModel model, int x, int y, int w, TextFieldView.Style style,
		int @Nullable [] clip) {
		boolean clipped(double mx, double my) {
			return clip != null && (mx < clip[0] || mx >= clip[0] + clip[2] || my < clip[1] || my >= clip[1] + clip[3]);
		}
	}

	record Hit(String id, String label, int x, int y, int w, int h, boolean enabled, boolean on, Runnable action) {
		boolean contains(double mx, double my) {
			return mx >= x && mx < x + w && my >= y && my < y + h;
		}
	}

	private static Tab lastTab = Tab.DESIGN;
	/**
	 * The second confirmation before removing a site another mod owns (docs/CONTRACT.md phase 4a, R5; lab-ui {@link
	 * dev.larattalabs.labui.ui.ConfirmArm} since UI-2b, replacing OwnedConfirm): the first press explains whose it is and arms
	 * "Press again to remove (N)"; a second press on the same site within the window removes it. The player's own sites remove on
	 * one press, as before.
	 */
	private static final dev.larattalabs.labui.ui.ConfirmArm OWNED_REMOVE = new dev.larattalabs.labui.ui.ConfirmArm();
	private static final String OWNED_KEY = "owned:";

	/** "owned by steward_mc" (the mod id part of the owner), or null for the player's own site. */
	static @Nullable String ownedLabel(Site s) {
		if (s.owner() == null) {
			return null;
		}
		int colon = s.owner().indexOf(':');
		return "owned by " + (colon > 0 ? s.owner().substring(0, colon) : s.owner());
	}

	/** True when the removal may go ahead: the player's own site, or the second press on an owned one (else it arms and says so). */
	private static boolean ownedRemoveOk(Site s) {
		if (s.owner() == null) {
			return true;
		}
		if (OWNED_REMOVE.press(OWNED_KEY + s.id(), net.minecraft.util.Util.getMillis()) == dev.larattalabs.labui.ui.ConfirmArm.Result.CONFIRMED) {
			return true;
		}
		LibraryFeature.say(s.id() + " is " + ownedLabel(s) + " (" + s.owner() + "); removing it may break that mod's plans. Press Remove again to "
			+ "remove it", true);
		return false;
	}

	/** Opens the Library on this world's placed sites with {@code site} selected (the "Placed" chat line's [Open in Library]). */
	public static ArchitectScreen openPlaced(@Nullable String site) {
		showPlaced = true;
		if (site != null) {
			selectedSite = site;
		}
		return open(Tab.LIBRARY);
	}

	/** (J3) Opens the Designs tab on a job (the Jobs panel's Open for a set, bible, running design or variant). */
	public static ArchitectScreen openJob(String jobId) {
		selectedDesign = jobId;
		return open(Tab.DESIGNS);
	}

	/** (J3) Opens the Library on its designs with {@code entryId} selected (the Jobs panel's Open for a finished design or variant). */
	public static ArchitectScreen openEntry(String entryId) {
		ArchitectScreen s = open(Tab.LIBRARY);
		s.showDesigns();
		LibraryFeature.select(entryId);
		return s;
	}

	private static boolean showPlaced;
	private static @Nullable String selectedDesign;
	private static @Nullable String selectedEntry;
	private static @Nullable String selectedSite;

	private Tab tab;
	private Focus focus = Focus.NONE;
	/** The item row of a per-item set field ({@link Focus#perItem()}), else -1. */
	private int focusIndex = -1;
	private final SetDialog set = new SetDialog(this);
	private final TextFieldView openTypeView = new TextFieldView();
	private final List<Hit> hits = new ArrayList<>();
	private final List<Hit> overlayHits = new ArrayList<>();
	private final List<FieldRect> fieldRects = new ArrayList<>();
	private @Nullable Popup popup;
	/** (U3) The lab-ui Confirms drawn this frame: every click goes to them first (a click elsewhere disarms them). */
	private final List<dev.larattalabs.labui.client.widget.Confirm> confirms = new ArrayList<>();
	/** (U3) Widgets drawn this frame that take their own mouse events (compact pickers, lists, chip rows). */
	private final List<MouseTarget> mouseTargets = new ArrayList<>();
	/** (U3) The viewport of the scrolling body: a control drawn outside it can't be clicked (it is scissored away). */
	private int @Nullable [] clipRect;
	/** (U3) The current list's scrollbar (x, y, w, h) and a drag on its thumb (the grab offset, or -1). */
	private int[] barRect = new int[4];
	private int barGrab = -1;
	/** (U3) The screen's tooltip (lab-ui: one per screen, drawn last). */
	final dev.larattalabs.labui.client.widget.Tooltip tooltip = new dev.larattalabs.labui.client.widget.Tooltip();
	/** (U3) The unified design editor (NEW on this tab, VARIANT in the Library's Variants dialog). */
	final DesignEditor editor = new DesignEditor(this);

	/** A widget with its own mouse handling (lab-ui CompactPicker, ScrollList, ChipRow). */
	interface MouseTarget {
		boolean click(double mx, double my, int button);

		default boolean drag(double mx, double my, int button) {
			return false;
		}

		default boolean release(double mx, double my, int button) {
			return false;
		}

		default boolean wheel(double mx, double my, double dy) {
			return false;
		}
	}
	private final LibraryTab library = new LibraryTab(this);
	private final TextFieldView styleView = new TextFieldView();
	private final TextFieldView materialsView = new TextFieldView();
	private final TextFieldView nameView = new TextFieldView();
	private final TextFieldView notesView = new TextFieldView();
	private final int[][] fields = new int[Focus.values().length][3];
	private int notesLines = 4;
	/** The API key being typed (never shown, logged or kept after sending). */
	private final StringBuilder key = new StringBuilder();
	private @Nullable String keyMessage;
	private boolean keyMessageError;
	private @Nullable String survivalMessage;
	private boolean survivalMessageError;
	private @Nullable String armedRemove;
	private int listScroll;
	private int listNeeded;
	private int listAvailable;
	private int scrollStep = ROW_H;
	private int[] listArea = new int[4];
	/** The Designs tab's set detail: its item list (wheel-scrolled by rows). */
	private int[] groupArea = new int[4];
	private int groupScroll;

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
		if (focus == Focus.RENAME || focus == Focus.TAGS) {
			library.cancelEdit();
		}
		setFocus(Focus.NONE);
		closePopup();
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
		setFocus(f, f.perItem() ? focusIndex : -1);
	}

	private void setFocus(Focus f, int index) {
		if ((f != Focus.NONE) != (focus != Focus.NONE) && minecraft != null) {
			minecraft.onTextInputFocusChange(this, f != Focus.NONE);
		}
		focus = f;
		focusIndex = f.perItem() ? index : -1;
		TextModel m = model();
		if (m != null) {
			m.touch();
		}
	}

	String focusName() {
		return focus.name().toLowerCase(Locale.ROOT) + (focus.perItem() ? ":" + focusIndex : "");
	}

	private @Nullable TextModel model() {
		DesignForm f = DesignFeature.form();
		return switch (focus) {
			case STYLE -> f.styleText;
			case STYLE_NOTE -> f.styleNote;
			case SAVE_NAME -> editor.saveName;
			case MATERIALS -> f.materials;
			case NAME -> f.name;
			case NOTES -> f.notes;
			case SEARCH, RENAME, TAGS, VNAME, IMPORT_FILTER -> library.model(focus);
			case OTYPE -> f.openType;
			case SET_NAME, SET_PROMPT, SET_TYPE, SET_INAME, SET_NOTES, SET_CONTEXT -> set.model(focus, focusIndex);
			case REDIRECT -> redirectNotes;
			default -> null;
		};
	}

	private boolean libraryField() {
		return focus == Focus.SEARCH || focus == Focus.RENAME || focus == Focus.TAGS || focus == Focus.VNAME || focus == Focus.IMPORT_FILTER;
	}

	// ------------------------------------------------------------------ input

	@Override
	public boolean keyPressed(KeyEvent e) {
		int k = e.key();
		Popup pp = popup;
		if (pp != null && !e.isEscape() && pp.list.keyPressed(e)) {
			return true;
		}
		if (e.isEscape()) {
			if (popup != null) {
				closePopup();
			} else if (disarmConfirms()) {
				// an armed Confirm takes the Esc first
			} else if (editor.escape()) {
				// the editor's inline name field (Save as style…)
			} else if (focus == Focus.RENAME || focus == Focus.TAGS) {
				library.cancelEdit();
			} else if (focus != Focus.NONE) {
				setFocus(Focus.NONE);
			} else if (tab == Tab.DESIGN && dev.larattalabs.architect.client.design.SetFeature.form() != null) {
				closeSet();
			} else if (!(tab == Tab.LIBRARY && library.escape())) {
				onClose();
			}
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
		if (k == InputConstants.KEY_TAB && tab == Tab.DESIGN && dev.larattalabs.architect.client.design.SetFeature.form() != null) {
			tabSet(e.hasShiftDown() ? -1 : 1);
			return true;
		}
		if (k == InputConstants.KEY_TAB && tab == Tab.DESIGN) {
			Focus words = DesignFeature.form().ownWords() ? Focus.STYLE : Focus.STYLE_NOTE;
			Focus[] order = DesignForm.OTHER.equals(DesignFeature.form().type) ? new Focus[] {Focus.OTYPE, Focus.NAME, Focus.NOTES, words, Focus.MATERIALS}
				: new Focus[] {Focus.NAME, Focus.NOTES, words, Focus.MATERIALS};
			int i = java.util.Arrays.asList(order).indexOf(focus);
			setFocus(order[Math.floorMod(i + (e.hasShiftDown() ? -1 : 1), order.length)]);
			return true;
		}
		if (TextKeys.isEnter(e)) {
			if (editor.enter(focus) || library.enter(focus)) {
				return true;
			}
			if (focus == Focus.REDIRECT) {
				sendRedirect();
				return true;
			}
			if (tab == Tab.DESIGN && e.hasControlDown() && dev.larattalabs.architect.client.design.SetFeature.form() != null) {
				submitSet();
			} else if (tab == Tab.DESIGN && e.hasControlDown()) {
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
			edited();
			return true; // a focused field swallows the rest
		}
		if (focus == Focus.NONE && k >= InputConstants.KEY_1 && k <= InputConstants.KEY_4 && !e.hasControlDown()) {
			setTab(Tab.values()[k - InputConstants.KEY_1]);
			return true;
		}
		return super.keyPressed(e);
	}

	/** After a keystroke in the focused field. */
	private void edited() {
		if (libraryField()) {
			library.edited(focus);
		} else if (focus.set()) {
			var sf = dev.larattalabs.architect.client.design.SetFeature.form();
			if (sf != null) {
				sf.sendError = null;
			}
		} else {
			DesignFeature.form().sendError = null;
		}
	}

	/** Tab in the set dialog: name, prompt (a new bible), then each row's type, name and notes. */
	private void tabSet(int dir) {
		var sf = dev.larattalabs.architect.client.design.SetFeature.form();
		if (sf == null) {
			return;
		}
		List<Object[]> order = new ArrayList<>();
		order.add(new Object[] {Focus.SET_NAME, -1});
		if (sf.newBible) {
			order.add(new Object[] {Focus.SET_PROMPT, -1});
		}
		for (int i = 0; i < sf.items.size(); i++) {
			for (Focus f : SetDialog.ITEM_FIELDS) {
				order.add(new Object[] {f, i});
			}
		}
		if (dev.larattalabs.architect.client.design.SetFeature.has("massing")) {
			order.add(new Object[] {Focus.SET_CONTEXT, -1});
		}
		int at = -1;
		for (int i = 0; i < order.size(); i++) {
			if (order.get(i)[0] == focus && (int) order.get(i)[1] == (focus.perItem() ? focusIndex : -1)) {
				at = i;
			}
		}
		Object[] next = order.get(Math.floorMod(at + dir, order.size()));
		setFocus((Focus) next[0], (int) next[1]);
		TextModel m = model();
		if (m != null) {
			m.moveTo(m.length(), false);
		}
	}

	@Override
	public boolean charTyped(CharacterEvent e) {
		Popup pp = popup;
		if (pp != null) {
			return pp.list.charTyped(e) || true;
		}
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
			edited();
			return true;
		}
		return false;
	}

	@Override
	public boolean mouseScrolled(double x, double y, double scrollX, double scrollY) {
		Popup pp = popup;
		if (pp != null) {
			pp.list.mouseScrolled(x, y, scrollY);
			return true;
		}
		for (MouseTarget t : List.copyOf(mouseTargets)) {
			if (t.wheel(x, y, scrollY)) {
				return true;
			}
		}
		if (tab == Tab.DESIGNS && x >= groupArea[0] && x < groupArea[0] + groupArea[2] && y >= groupArea[1] && y < groupArea[1] + groupArea[3]) {
			groupScroll = Math.max(0, groupScroll + (scrollY > 0 ? -1 : 1));
			return true;
		}
		if (listNeeded > listAvailable && x >= listArea[0] && x < listArea[0] + listArea[2] + 8 && y >= listArea[1] && y < listArea[1] + listArea[3]) {
			listScroll = Math.max(0, Math.min(listNeeded - listAvailable, listScroll + (scrollY > 0 ? -scrollStep : scrollStep)));
			return true;
		}
		return super.mouseScrolled(x, y, scrollX, scrollY);
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean doubleClick) {
		Popup pp = popup;
		if (pp != null) {
			if (pp.contains(e.x(), e.y())) {
				pp.clicking = true;
				try {
					pp.list.mouseClicked(e.x(), e.y(), e.button());
				} finally {
					pp.clicking = false;
				}
				return true;
			}
			closePopup(); // a click outside closes it
			return true;
		}
		// (U3) lab-ui Confirms first: a click on one presses it, a click anywhere else disarms it
		for (dev.larattalabs.labui.client.widget.Confirm c : List.copyOf(confirms)) {
			if (c.mouseClicked(e.x(), e.y(), e.button())) {
				return true;
			}
		}
		MouseTarget ov = overlay;
		if (ov != null && ov.click(e.x(), e.y(), e.button())) {
			return true;
		}
		// (U3) the list's scrollbar: drag the thumb, or page towards the click
		if (listNeeded > listAvailable && barRect[3] > 0 && e.x() >= barRect[0] && e.x() < barRect[0] + barRect[2] + 2 && e.y() >= barRect[1]
			&& e.y() < barRect[1] + barRect[3]) {
			dev.larattalabs.labui.ui.ScrollMath.Thumb t = dev.larattalabs.labui.ui.ScrollMath.thumb(barRect[3], listNeeded, listAvailable, listScroll);
			if (t.contains(barRect[1], (int) e.y())) {
				barGrab = (int) e.y() - barRect[1] - t.y();
			} else {
				listScroll = dev.larattalabs.labui.ui.ScrollMath.pageTowards(barRect[3], listNeeded, listAvailable, listScroll, (int) e.y() - barRect[1]);
			}
			return true;
		}
		for (MouseTarget t : List.copyOf(mouseTargets)) {
			if (t.click(e.x(), e.y(), e.button())) {
				setFocus(Focus.NONE);
				return true;
			}
		}
		// UI-2b: confirms first: a click anywhere but the armed Remove disarms it (lab-ui ConfirmArm)
		String clicked = null;
		for (Hit h : List.copyOf(hits)) {
			if (h.contains(e.x(), e.y())) {
				clicked = h.id();
				break;
			}
		}
		OWNED_REMOVE.clickedElsewhere("remove".equals(clicked) && selectedSite != null ? OWNED_KEY + selectedSite : null);
		for (Hit h : List.copyOf(hits)) {
			if (h.contains(e.x(), e.y())) {
				if (h.enabled()) {
					DesignFeature.form().sendError = null;
					h.action().run();
				}
				return true;
			}
		}
		for (FieldRect r : List.copyOf(fieldRects)) {
			if (r.clipped(e.x(), e.y())) {
				continue;
			}
			int at = r.view().hit(font, r.model(), r.x(), r.y(), r.w(), r.style(), e.x(), e.y());
			if (at >= 0) {
				if (focus != r.focus() && (focus == Focus.RENAME || focus == Focus.TAGS)) {
					library.commitEdit(); // clicking another field keeps what was typed
				}
				setFocus(r.focus(), r.index());
				r.model().moveTo(at, false);
				return true;
			}
		}
		if (focus == Focus.RENAME || focus == Focus.TAGS) {
			library.commitEdit();
		}
		setFocus(Focus.NONE);
		return super.mouseClicked(e, doubleClick);
	}

	@Override
	public boolean mouseDragged(MouseButtonEvent e, double dx, double dy) {
		Popup pp = popup;
		if (pp != null && pp.list.mouseDragged(e.x(), e.y(), e.button())) {
			return true;
		}
		if (barGrab >= 0) {
			listScroll = dev.larattalabs.labui.ui.ScrollMath.offsetForThumbTop(barRect[3], listNeeded, listAvailable, (int) e.y() - barRect[1] - barGrab);
			return true;
		}
		for (MouseTarget t : List.copyOf(mouseTargets)) {
			if (t.drag(e.x(), e.y(), e.button())) {
				return true;
			}
		}
		return super.mouseDragged(e, dx, dy);
	}

	@Override
	public boolean mouseReleased(MouseButtonEvent e) {
		Popup pp = popup;
		if (pp != null && pp.list.mouseReleased(e.x(), e.y(), e.button())) {
			return true;
		}
		if (barGrab >= 0) {
			barGrab = -1;
			return true;
		}
		for (MouseTarget t : List.copyOf(mouseTargets)) {
			if (t.release(e.x(), e.y(), e.button())) {
				return true;
			}
		}
		return super.mouseReleased(e);
	}

	/** Disarms an armed Confirm (Esc); true when one was armed. */
	private boolean disarmConfirms() {
		boolean any = false;
		for (dev.larattalabs.labui.client.widget.Confirm c : confirms) {
			any |= c.escape();
		}
		return any;
	}

	// ------------------------------------------------------------------ (U3) lab-ui controls in the hit list

	/**
	 * Registers a lab-ui control drawn this frame as control {@code id} (dev.ui.state / dev.ui.click see it; a mouse click on it
	 * presses it through the hit list). Clipped to the scrolling body when one is set: scrolled out of view, it is still a control for
	 * the DevBridge (zero size) but no click lands on it.
	 */
	void control(String id, String label, dev.larattalabs.labui.client.widget.Control c, boolean on) {
		if (!c.shown()) {
			return;
		}
		int x = c.x();
		int y = c.y();
		int w = c.width();
		int h = c.height();
		int[] r = clipRect;
		if (r != null) {
			int x0 = Math.max(x, r[0]);
			int y0 = Math.max(y, r[1]);
			int x1 = Math.min(x + w, r[0] + r[2]);
			int y1 = Math.min(y + h, r[1] + r[3]);
			x = x0;
			y = y0;
			w = Math.max(0, x1 - x0);
			h = Math.max(0, y1 - y0);
		}
		if (c instanceof dev.larattalabs.labui.client.widget.Confirm cf) {
			confirms.add(cf);
		}
		hits.add(new Hit(id, label, x, y, w, h, !c.isDisabled(), on, c::press));
		tooltip.offer(c, (int) mouseX(), (int) mouseY());
	}

	/** (U3) A lab-ui EmptyState with its action, as control {@code id}. */
	void emptyState(GuiGraphicsExtractor g, String id, String line, String action, Runnable run, int x, int y, int w, int h, int mx, int my) {
		dev.larattalabs.labui.client.widget.EmptyState es = new dev.larattalabs.labui.client.widget.EmptyState(line).action(action, run);
		es.draw(g, font, x, y, w, h, mx, my);
		if (es.actionButton() != null) {
			control(id, action, es.actionButton(), false);
		}
	}

	/** A control for the DevBridge only (zero size: no mouse click lands on it), e.g. a compact picker's choice. */
	void devControl(String id, String label, boolean enabled, boolean on, Runnable action) {
		hits.add(new Hit(id, label, 0, 0, 0, 0, enabled, on, action));
	}

	/** (U3) An overlay drawn this frame (the Library's ⋯ menu): it takes every click first, after the Confirms. */
	private @Nullable MouseTarget overlay;

	void overlay(MouseTarget t) {
		overlay = t;
	}

	/** (U3) Drawn after the tab's body and footer (an overlay such as the ⋯ menu stays on top of them). */
	private final List<java.util.function.Consumer<GuiGraphicsExtractor>> late = new ArrayList<>();

	void late(java.util.function.Consumer<GuiGraphicsExtractor> c) {
		late.add(c);
	}

	/** Takes this widget's mouse events this frame (compact pickers, lists, chip rows). */
	void mouseTarget(MouseTarget t) {
		mouseTargets.add(t);
	}

	/** Controls drawn after this are clipped to {@code r} (x, y, w, h); null = none. */
	void clipControls(int @Nullable [] r) {
		clipRect = r;
	}

	private double lastMx;
	private double lastMy;

	double mouseX() {
		return lastMx;
	}

	double mouseY() {
		return lastMy;
	}

	/** Runs the control with id {@code id} as a click would (DevBridge {@code dev.ui.click}). Returns false when there is none. */
	public boolean click(String id) {
		List<Hit> all = new ArrayList<>(overlayHits);
		all.addAll(hits);
		if (popup != null && overlayHits.stream().noneMatch(h -> h.id().equals(id))) {
			closePopup(); // as a click elsewhere would
		}
		for (Hit h : all) {
			if (h.id().equals(id)) {
				if (h.enabled()) {
					h.action().run();
				}
				return h.enabled();
			}
		}
		return false;
	}

	/**
	 * Focuses a text field by name (style, materials, name, notes, key, search, rename, tags, vname, otype, set_name,
	 * set_prompt, and set_type:<row>, set_iname:<row>, set_notes:<row>) for the DevBridge.
	 */
	public void focus(String name) {
		int colon = name.indexOf(':');
		Focus f = Focus.valueOf((colon < 0 ? name : name.substring(0, colon)).toUpperCase(Locale.ROOT));
		setFocus(f, colon < 0 ? -1 : Integer.parseInt(name.substring(colon + 1)));
		TextModel m = model();
		if (m != null) {
			m.moveTo(m.length(), false);
		}
	}

	/** The Library tab shows the designs (not the placed sites). */
	void showDesigns() {
		showPlaced = false;
	}

	/** The Library tab's designs view (DevBridge). */
	LibraryTab library() {
		return library;
	}

	// ------------------------------------------------------------------ helpers for LibraryTab

	Font font() {
		return font;
	}

	void setFocusPublic(Focus f) {
		setFocus(f);
	}

	boolean inWorld() {
		return minecraft != null && minecraft.player != null;
	}

	void addHit(Hit h) {
		hits.add(h);
	}

	void resetScroll() {
		listScroll = 0;
	}

	/** Scrolls the current list to {@code px} (clamped by the next frame's scroll area). */
	void scrollTo(int px) {
		listScroll = Math.max(0, px);
	}

	int scroll() {
		return listScroll;
	}

	/** Declares the scrollable region of this frame ({@code needed} px of content, {@code step} px a wheel notch). */
	void setScrollArea(int x, int y, int w, int h, int needed, int step) {
		listArea = new int[] {x, y, w, h};
		listAvailable = h;
		listNeeded = needed;
		scrollStep = step;
		listScroll = Math.max(0, Math.min(listScroll, Math.max(0, needed - h)));
	}

	void scrollbarAt(GuiGraphicsExtractor g, int x, int y, int h) {
		scrollbar(g, x, y, h);
	}

	void statusLineAt(GuiGraphicsExtractor g, @Nullable String text, boolean error, int x, int y, int w) {
		statusLine(g, text, error, x, y, w);
	}

	/** Draws a text field and registers it for click-to-focus. */
	void textField(GuiGraphicsExtractor g, Focus f, TextFieldView view, TextModel m, int x, int y, int w, TextFieldView.Style st) {
		textField(g, f, -1, view, m, x, y, w, st);
	}

	/** A text field of an item row ({@code index} >= 0) or a single one (-1). */
	void textField(GuiGraphicsExtractor g, Focus f, int index, TextFieldView view, TextModel m, int x, int y, int w, TextFieldView.Style st) {
		int[] r = fields[f.ordinal() - 1];
		r[0] = x;
		r[1] = y;
		r[2] = w;
		fieldRects.add(new FieldRect(f, index, view, m, x, y, w, st, clipRect));
		boolean on = focus == f && (index < 0 || focusIndex == index);
		int[] cr = clipRect;
		int hy = cr == null ? y : Math.max(y, cr[1]);
		int hh = cr == null ? TextFieldView.BASE_H : Math.max(0, Math.min(y + TextFieldView.BASE_H, cr[1] + cr[3]) - hy);
		hits.add(new Hit("field:" + f.name().toLowerCase(Locale.ROOT) + (index >= 0 ? ":" + index : ""), "text field", x, hy, w, hh,
			true, on, () -> {
				setFocus(f, index);
				m.moveTo(m.length(), false);
			}));
		view.draw(g, font, m, x, y, w, on, st);
	}

	/** A dropdown-looking chip (fixed width, the label ellipsized). */
	void dropdown(GuiGraphicsExtractor g, String id, String label, int x, int y, int w, int mx, int my, Runnable action) {
		Hit h = new Hit(id, label, x, y, w, CHIP_H, true, false, action);
		hits.add(h);
		Panels.sprite(g, Kit.TEXT_FIELD, x, y, w, CHIP_H);
		if (h.contains(mx, my)) {
			g.fill(x + 1, y + 1, x + w - 1, y + CHIP_H - 1, 0x10000000);
		}
		g.text(font, TextUtil.ellipsize(font, label, w - 10), x + 5, y + 3, UiBits.ink(), false);
	}

	void openPopup(String id, int x, int y, int w, List<Option> options, java.util.function.Consumer<String> pick) {
		setFocus(Focus.NONE);
		popup = new Popup(id, x, y, w, List.copyOf(options), pick);
	}

	void closePopup() {
		popup = null;
		overlayHits.clear();
	}

	/** Remix…: the Design tab prefilled from the entry, remix set, the notes focused for "what to change". */
	void remix(String id) {
		try {
			LibraryFeature.prefillRemix(id);
		} catch (IllegalArgumentException ex) {
			LibraryFeature.say(ex.getMessage(), true);
			return;
		}
		setTab(Tab.DESIGN);
		setFocus(Focus.NOTES);
	}

	/** Shows a design, variant or import job in the Designs tab. */
	void showJob(String jobId) {
		selectedDesign = jobId;
		if (minecraft != null && minecraft.gui.screen() == this) {
			setTab(Tab.DESIGNS);
		}
	}

	private void drawPopup(GuiGraphicsExtractor g, int mx, int my) {
		overlayHits.clear();
		Popup p = popup;
		if (p == null) {
			return;
		}
		int pad = 3;
		int w = Math.min(Math.max(p.w, 120), width - 8);
		int rows = Math.max(1, Math.min(p.options.size(), 8));
		int lh = p.list.heightFor(rows);
		// at most what fits under or over the anchor
		int below = height - 4 - p.ay;
		int above = p.ay - CHIP_H - 6;
		int room = Math.max(below, above) - 2 * pad;
		while (lh > room && rows > 2) {
			rows--;
			lh = p.list.heightFor(rows);
		}
		int h = lh + 2 * pad;
		int x = Math.max(4, Math.min(p.ax, width - w - 4));
		int y = p.ay + h > height - 4 ? Math.max(4, p.ay - h - CHIP_H - 2) : p.ay;
		p.x = x;
		p.y = y;
		p.h = h;
		g.nextStratum();
		Panels.framed(g, x - 2, y - 2, w + 4, h + 4);
		g.fill(x, y, x + w, y + h, UiStyle.CREAM);
		p.list.draw(g, font, x + pad, y + pad, w - 2 * pad, lh, mx, my);
		// every option as a control for the DevBridge (dev.ui.click option:<popup>:<id>), whether it is scrolled into view or not
		for (Option o : p.options) {
			overlayHits.add(new Hit("option:" + p.id + ":" + o.id(), o.label(), x, y, 0, 0, true, o.on(), () -> p.choose(o)));
		}
	}

	/** DevBridge: types into the API key field (as keystrokes would). */
	public void typeKey(String s) {
		key.append(s);
	}

	// ------------------------------------------------------------------ actions

	/** (U3) Generate (the editor's footer). */
	void submitDesign() {
		submit();
	}

	private void submit() {
		setFocus(Focus.NONE);
		DesignFeature.submit().thenAccept(sent -> {
			if (sent.designId() != null) {
				// (U3) a sent design's draft is done with
				dev.larattalabs.architect.client.design.Drafts.dropDesign();
			}
			if (sent.designId() != null && minecraft != null && minecraft.gui.screen() == this) {
				selectedDesign = sent.designId();
				setTab(Tab.DESIGNS);
			}
		});
	}

	/** "Design a set…": the set dialog takes the Design tab's body. */
	void openSet() {
		setFocus(Focus.NONE);
		closePopup();
		dev.larattalabs.architect.client.design.SetFeature.open();
		setTab(Tab.DESIGN);
		listScroll = 0;
	}

	void closeSet() {
		setFocus(Focus.NONE);
		closePopup();
		dev.larattalabs.architect.client.design.SetFeature.close();
		listScroll = 0;
	}

	void submitSet() {
		setFocus(Focus.NONE);
		dev.larattalabs.architect.client.design.SetFeature.submit().thenAccept(id -> {
			if (minecraft != null && minecraft.gui.screen() == this) {
				selectedDesign = id;
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

	/** The Status tab's survival toggle: runs /architect survival on|off as the player, so the server's permission rule applies. */
	private void toggleSurvival(boolean on) {
		if (minecraft == null || minecraft.player == null) {
			return;
		}
		if (!dev.larattalabs.architect.client.survival.SurvivalFeature.mayToggle()) {
			survivalMessage = "Changing it needs cheats (permission level 2)";
			survivalMessageError = true;
			return;
		}
		minecraft.player.connection.sendCommand("architect survival " + (on ? "on" : "off"));
		survivalMessage = "Construction sites turned " + (on ? "on" : "off") + " for this world";
		survivalMessageError = false;
	}

	private void removeSite(Site s, boolean force) {
		removeSite(s, force, null);
	}

	/**
	 * Remove (phase 4e): a site another site covers asks first ("3 cells of this site are under ...: [Remove] [Remove both]
	 * [Cancel]"); {@code covered} null = ask when covered, else KEEP (hand-down) or CASCADE (both).
	 */
	private void removeSite(Site s, boolean force, Sites.@org.jspecify.annotations.Nullable Covered covered) {
		// SAFETY: the one removal path the "Undo last placement" key shares (PlayerRemove.remove)
		dev.larattalabs.architect.client.world.ServerTasks.callAsPlayer((level, player) -> dev.larattalabs.architect.site.PlayerRemove.remove(level, s, force,
			covered)).whenComplete((msg, err) -> {
			String m = err != null ? "!" + err.getMessage() : msg;
			if (m.startsWith("?")) {
				coveredArmed = s.id();
				LibraryFeature.say(m.substring(1), false);
				return;
			}
			coveredArmed = null;
			boolean bad = m.startsWith("!");
			LibraryFeature.say(bad ? m.substring(1) : m, bad);
			armedRemove = bad && m.contains("confirm again with force") ? s.id() : null;
		});
	}

	/** The site whose Remove asked "Remove / Remove both / Cancel" (another site covers it), or null. */
	private @org.jspecify.annotations.Nullable String coveredArmed;

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
			boolean bad = m.startsWith("!");
			LibraryFeature.say(bad ? m.substring(1) : m, bad);
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
		if (U3Dev.park) {
			mouseX = -1000;
			mouseY = -1000;
		}
		hits.clear();
		fieldRects.clear();
		confirms.clear();
		mouseTargets.clear();
		overlay = null;
		clipRect = null;
		barRect = new int[4];
		lastMx = mouseX;
		lastMy = mouseY;
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
		// (J3) the Jobs & spend panel, left of the helper pill: "Jobs (K)", with how many wait for the player
		int waiting = dev.larattalabs.labui.ui.JobBoardModel.needsYouCount(dev.larattalabs.labui.client.jobs.JobBoard.model().rows());
		String jl = "Jobs" + (waiting > 0 ? " · " + waiting + (waiting == 1 ? " needs you" : " need you") : "") + " (" + dev.larattalabs.labui.client.jobs.JobBoard.keyLabel() + ")";
		int jw = font.width(jl) + 12;
		int jx = cx + cw - ow - 6 - jw;
		Hit jh = new Hit("header:jobs", jl, jx, cy - 3, jw, 13, true, waiting > 0, () -> dev.larattalabs.labui.client.jobs.JobBoard.open(null));
		hits.add(jh);
		boolean jhov = jh.contains(mouseX, mouseY);
		dev.larattalabs.labui.client.widget.Paint.box(g, jx, cy - 3, jw, 13, jhov ? UiStyle.rowHover() : UiStyle.withAlpha(UiStyle.PAPER, 255),
			waiting > 0 ? UiStyle.selectedEdge() : jhov ? UiStyle.rowHoverEdge() : UiStyle.chipEdge());
		g.text(font, jl, jx + 6, cy, UiBits.ink(), false);
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
		clipRect = null;
		for (var c : List.copyOf(late)) {
			c.accept(g);
		}
		late.clear();
		if (popup != null) {
			drawPopup(g, mouseX, mouseY);
		} else {
			g.nextStratum();
			tooltip.draw(g, font, mouseX, mouseY);
		}
	}

	private String badge(Tab t) {
		if (t == Tab.DESIGNS) {
			long running = Sidecar.state().designs().stream().filter(d -> d.status().isRunning()).count()
				+ Sidecar.state().variants().stream().filter(v -> v.status().isRunning()).count()
				+ Sidecar.state().bibleJobs().stream().filter(b -> !dev.larattalabs.architect.apiimpl.Wire4b.bibleJob(b).finished()).count();
			return running > 0 ? " (" + running + ")" : "";
		}
		return "";
	}

	void button(GuiGraphicsExtractor g, String id, String label, int x, int y, int w, boolean primary, boolean enabled, int mx, int my,
		Runnable action) {
		Hit h = new Hit(id, label, x, y, w, 20, enabled, primary, action);
		hits.add(h);
		UiBits.ButtonState st = !enabled ? UiBits.ButtonState.DISABLED : h.contains(mx, my) ? UiBits.ButtonState.HOVER : UiBits.ButtonState.NORMAL;
		UiBits.button(g, font, label, 0, x, y, w, primary, st, false);
	}

	int bw(String label) {
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

	int chip(GuiGraphicsExtractor g, String id, String label, int x, int y, boolean on, boolean enabled, int mx, int my, Runnable action) {
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
			case OTYPE -> new TextFieldView.Style(null, 0, "your type, e.g. hellish_lair", null, null, 0, 1);
			default -> notesStyle();
		};
	}

	private TextFieldView.Style notesStyle() {
		return new TextFieldView.Style(null, 0, DesignFeature.form().remix != null ? "what to change, e.g. add a second floor and a bigger porch"
			: "rooms, mood, anything the designer should know", null, null, 0, notesLines);
	}

	private void field(GuiGraphicsExtractor g, Focus f, TextFieldView view, TextModel m, int x, int y, int w) {
		int[] r = fields[f.ordinal() - 1];
		r[0] = x;
		r[1] = y;
		r[2] = w;
		fieldRects.add(new FieldRect(f, -1, view, m, x, y, w, styleFor(f), clipRect));
		view.draw(g, font, m, x, y, w, focus == f, styleFor(f));
	}

	/** The type chips with "Other…" (an open type, phase 4b) at the end. */
	private static final List<DesignSpec.Choice> TYPE_CHIPS;

	static {
		List<DesignSpec.Choice> l = new ArrayList<>(DesignSpec.TYPES);
		l.add(new DesignSpec.Choice(DesignForm.OTHER, "Other…", "your own type, checked by the profile you pick"));
		TYPE_CHIPS = List.copyOf(l);
	}

	private void drawDesign(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my) {
		if (dev.larattalabs.architect.client.design.SetFeature.form() != null) {
			set.draw(g, x, top, w, footerY, mx, my);
			return;
		}
		// (Style unification U3) the unified design editor, NEW mode (it replaces the form and U2's drawStyleRows)
		editor.drawNew(g, x, top, w, footerY, mx, my);
	}

	// ------------------------------------------------------------------ Library tab

	private void drawLibrary(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my) {
		boolean dialog = !showPlaced && LibraryTab.dialog != LibraryTab.Dialog.NONE;
		int cx = x;
		if (!dialog) {
			cx += chip(g, "library:designs", "Designs (" + Blueprints.entries().size() + ")", cx, top, !showPlaced, true, mx, my, () -> {
				showPlaced = false;
				listScroll = 0;
			}) + 3;
			cx += chip(g, "library:placed", "Placed here (" + Sites.all().size() + ")", cx, top, showPlaced, true, mx, my, () -> {
				showPlaced = true;
				listScroll = 0;
				if (focus == Focus.SEARCH) {
					setFocus(Focus.NONE);
				}
			});
		}
		if (!showPlaced) {
			library.draw(g, x, top, w, footerY, mx, my, cx);
			if (dialog) {
				return;
			}
		} else {
			int listW = Math.min(240, (w - 12) / 2);
			int ly = top + CHIP_H + 6;
			int lh = footerY - 16 - ly;
			listArea = new int[] {x, ly, listW, lh};
			listAvailable = lh;
			scrollStep = ROW_H;
			Panels.inset(g, x, ly, listW, lh);
			drawSites(g, x, ly, listW, lh, x + listW + 12, w - listW - 12, footerY, mx, my);
		}
		statusLine(g, LibraryFeature.message(), LibraryFeature.messageError(), x, footerY - 13, w);
		int bx = x + w;
		String reload = "Reload library";
		bx -= bw(reload);
		button(g, "reload", reload, bx, footerY, bw(reload), false, true, mx, my, () -> {
			LibraryFeature.say("Reloading…", false);
			DesignFeature.reload(null).thenAccept(ok -> LibraryFeature.say("Library: " + Blueprints.ids().size() + " design(s)" + (Blueprints
				.lastProblems().isEmpty() ? "" : ", " + Blueprints.lastProblems().size() + " skipped (see the log)"), !Blueprints.lastProblems().isEmpty()));
		});
		if (!showPlaced) {
			String imp = "Import…";
			bx -= bw(imp) + 6;
			button(g, "import", imp, bx, footerY, bw(imp), false, inWorld(), mx, my, library::openImport);
		}
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
				String owned = ownedLabel(s);
				g.text(font, TextUtil.ellipsize(font, s.box().minX() + ", " + s.box().minY() + ", " + s.box().minZ() + " · " + s.rotation().replace('_', ' ')
					+ (owned == null ? "" : " · " + owned) + (s.group() == null ? "" : " · group " + s.group()) + (s.placing() ? " · placing" : ""), listW - 14),
					x + 6, ry + 12, UiBits.muted(), false);
			}
			ry += ROW_H;
		}
		g.disableScissor();
		if (sites.isEmpty()) {
			// (U3) no dead ends
			emptyState(g, "empty:placed", "Nothing placed in this world yet: pick a design and Place it.", "Show the designs", () -> {
				showPlaced = false;
				listScroll = 0;
			}, x, ly, listW, lh, mx, my);
		}
		scrollbar(g, x + listW + 2, ly, lh);
		Site s = selectedSite == null ? null : Sites.get(selectedSite);
		if (s == null) {
			return;
		}
		int y = ly;
		g.text(font, TextUtil.ellipsize(font, s.id() + " · " + s.blueprint(), dw), dx, y, UiBits.ink(), false);
		y += 12;
		List<String> lines = new java.util.ArrayList<>(List.of("box " + Anchors.str(s.box()), "restores " + Anchors.str(s.restoreBox()),
			s.dimension() + " · " + s.rotation(),
			s.movedFrom() == null ? "never moved" : "moved from " + s.movedFrom().x() + ", " + s.movedFrom().y() + ", " + s.movedFrom().z()));
		if (s.owner() != null) {
			lines.add(0, ownedLabel(s) + " (" + s.owner() + ")");
		}
		if (s.member() != null) {
			// phase 4d: the site group (one undo for the set), the batch and item that placed it
			lines.add("group " + s.member().group() + (s.member().batchId() == null ? "" : " · batch " + s.member().batchId())
				+ (s.member().itemKey() == null ? "" : " · item " + s.member().itemKey()) + (s.placing() ? " · placing" : ""));
		}
		for (String line : lines) {
			g.text(font, TextUtil.ellipsize(font, line, dw), dx, y, UiBits.muted(), false);
			y += 10;
		}
		y = drawVersions(g, s, dx, y, dw, footerY, mx, my);
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
		long nowMs = net.minecraft.util.Util.getMillis();
		boolean ownedArmed = s.owner() != null && OWNED_REMOVE.armed(OWNED_KEY + s.id(), nowMs);
		String rm = ownedArmed ? "Press again to remove (" + OWNED_REMOVE.secondsLeft(nowMs) + ")" : force ? "Remove anyway" : "Remove";
		boolean coveredAsk = s.id().equals(coveredArmed);
		int rmW = s.owner() != null ? Math.max(bw(rm), bw("Press again to remove (9)")) : bw(rm); // arming never shifts the row
		button(g, "remove", rm, bx, by, rmW, true, true, mx, my, () -> {
			// a site another mod owns asks twice (R5)
			if (ownedRemoveOk(s)) {
				removeSite(s, force, coveredAsk ? Sites.Covered.KEEP : null);
			}
		});
		bx += rmW + 4;
		if (coveredAsk) {
			// phase 4e: the site is covered: Remove keeps the covered cells (hand-down), Remove both takes the covering sites first
			String both = "Remove both";
			button(g, "remove_both", both, bx, by, bw(both), true, true, mx, my, () -> removeSite(s, force, Sites.Covered.CASCADE));
			bx += bw(both) + 4;
			String cancel = "Cancel";
			button(g, "remove_cancel", cancel, bx, by, bw(cancel), false, true, mx, my, () -> {
				coveredArmed = null;
				LibraryFeature.say("Not removed", false);
			});
			bx += bw(cancel) + 4;
		}
		String mv = "Move…";
		button(g, "move", mv, bx, by, bw(mv), false, true, mx, my, () -> {
			String why = PlacementFeature.startMove(s.id());
			LibraryFeature.say(why, why != null);
		});
		bx += bw(mv) + 4;
		String undo = "Undo move";
		button(g, "undo_move", undo, bx, by, bw(undo), false, s.movedFrom() != null, mx, my, () -> undoMove(s));
	}

	// ------------------------------------------------------------------ phase 5b: versions of a placed site

	/** The site whose update is being previewed (its delta ghost shows), its verdict once the server answered. */
	private static @Nullable String updateSite;
	private static dev.larattalabs.architect.site.SiteDeltas.@Nullable Check updateCheck;
	private static boolean showHistory;
	static final String UPDATE_KEY = "architect:update";

	/**
	 * The version lines of a placed site (docs/CONTRACT.md phase 5b "Preview and UI"): "v1 · v3 available · Update…"; Update…
	 * shows the delta ghost, the per-part list, the kept cells and in survival the bill of materials and the refunds, with Apply
	 * and Cancel; History lists the versions with "Revert to vK" (creative) or "Rebuild as vK" (survival, a paid forward delta).
	 */
	private int drawVersions(GuiGraphicsExtractor g, Site s, int dx, int y, int dw, int footerY, int mx, int my) {
		var server = net.minecraft.client.Minecraft.getInstance().getSingleplayerServer();
		int v = server == null ? Math.max(1, s.versioning().version()) : dev.larattalabs.architect.site.SiteDeltas.versionOf(server, s);
		int head = dev.larattalabs.architect.site.SiteDeltas.headVersion(s.blueprint());
		y += 2;
		String line = v == 0 ? "its version can't be found (remove or place it again)" : "v" + v + (head > v ? " · v" + head + " available" : " · up to date")
			+ (s.versioning().deviations() > 0 ? " · " + s.versioning().deviations() + " cell(s) you changed kept" : "");
		g.text(font, TextUtil.ellipsize(font, line, dw), dx, y, head > v && v > 0 ? UiStyle.CLAY_DARK : UiBits.muted(), false);
		y += 12;
		int bx = dx;
		if (v > 0 && head > v && !s.id().equals(updateSite)) {
			String up = "Update…";
			button(g, "site_update", up, bx, y, bw(up), true, !s.building() && !s.placing(), mx, my, () -> previewUpdate(s, head));
			bx += bw(up) + 4;
		}
		String hist = showHistory ? "Hide history" : "History";
		button(g, "site_history", hist, bx, y, bw(hist), false, true, mx, my, () -> showHistory = !showHistory);
		y += 22;
		if (s.id().equals(updateSite)) {
			var c = updateCheck;
			if (c == null) {
				g.text(font, "Working out the update…", dx, y, UiBits.muted(), false);
				y += 12;
			} else {
				List<String> info = new java.util.ArrayList<>();
				info.add("v" + c.from() + " -> v" + c.to() + ": +" + c.added() + " -" + c.removed() + " ~" + c.changed() + " cells");
				c.parts().forEach((n, p) -> {
					if (p.status() != dev.larattalabs.architect.delta.TemplateDelta.Status.UNCHANGED) {
						info.add("  " + n + ": " + p.status().name().toLowerCase(java.util.Locale.ROOT) + " (+" + p.added() + " -" + p.removed() + " ~" + p
							.changed() + ")");
					}
				});
				// UI-0.3: the kept cells' frame colour as a swatch beside the words (no colour word: colour is never the only signal)
				String keptLine = c.kept().isEmpty() ? null : c.kept().size() + " cell(s) you changed stay as they are (framed in the preview)";
				if (keptLine != null) {
					info.add(keptLine);
				}
				if (!c.bom().isEmpty()) {
					info.add("needs " + summarize(c.bom()));
				}
				if (!c.refund().isEmpty()) {
					info.add("gives back " + summarize(c.refund()));
				}
				for (var rf : c.refusals()) {
					info.add("! " + rf.message());
				}
				for (String l : info.subList(0, Math.min(info.size(), 9))) {
					if (l == keptLine) {
						g.fill(dx, y, dx + 7, y + 7, UiBits.muted());
						g.fill(dx + 1, y + 1, dx + 6, y + 6, dev.larattalabs.architect.placement.CompositeMesh.keptColor());
						g.text(font, TextUtil.ellipsize(font, l, dw - 10), dx + 10, y, UiBits.muted(), false);
					} else {
						g.text(font, TextUtil.ellipsize(font, l, dw), dx, y, l.startsWith("!") ? UiBits.errorText() : UiBits.muted(), false);
					}
					y += 10;
				}
				y += 2;
				String apply = "Apply";
				button(g, "update_apply", apply, dx, y, bw(apply), true, c.ok(), mx, my, () -> applyUpdate(s, c.to()));
				String cancel = "Cancel";
				button(g, "update_cancel", cancel, dx + bw(apply) + 4, y, bw(cancel), false, true, mx, my, this::cancelUpdate);
				y += 22;
			}
		}
		if (showHistory) {
			boolean survival = dev.larattalabs.architect.survival.SurvivalWorld.on();
			List<int[]> chain = dev.larattalabs.architect.site.SiteDeltas.chain(s);
			for (Site.History h : s.versioning().history()) {
				g.text(font, TextUtil.ellipsize(font, "v" + h.version() + " · " + h.kind() + (h.revertible() ? "" : " · kept for good"), dw), dx, y, UiBits
					.muted(), false);
				y += 10;
			}
			int hx = dx;
			java.util.Set<Integer> offered = new java.util.TreeSet<>();
			for (int i = 0; i < chain.size() - 1; i++) {
				offered.add(chain.get(i)[0]);
			}
			for (int k = 1; k <= head; k++) {
				if (k != v && (survival || !offered.contains(k)) && offered.size() < 3) {
					offered.add(k);
				}
			}
			offered.remove(v);
			for (int k : offered) {
				String lbl = (survival ? "Rebuild as v" : "Revert to v") + k;
				button(g, "site_revert_" + k, lbl, hx, y, bw(lbl), false, !s.building(), mx, my, () -> revertSite(s, k));
				hx += bw(lbl) + 4;
			}
			y += 22;
		}
		return y;
	}

	static String summarize(java.util.Map<String, Integer> items) {
		List<String> out = new java.util.ArrayList<>();
		items.entrySet().stream().sorted((a, b) -> b.getValue() - a.getValue()).limit(4).forEach(e -> out.add(e.getValue() + " " + e.getKey().replace(
			"minecraft:", "")));
		return String.join(", ", out) + (items.size() > 4 ? ", ..." : "");
	}

	private void previewUpdate(Site s, int to) {
		updateSite = s.id();
		updateCheck = null;
		dev.larattalabs.architect.client.placement.DeltaGhost.request(UPDATE_KEY, s.id(), to).whenComplete((c, err) -> net.minecraft.client.Minecraft
			.getInstance().execute(() -> {
				if (err != null) {
					LibraryFeature.say("No update preview: " + err.getMessage(), true);
					updateSite = null;
				} else if (s.id().equals(updateSite)) {
					updateCheck = dev.larattalabs.architect.survival.SurvivalWorld.on() ? null : c;
					if (updateCheck == null) {
						// survival: the construction delta's verdict (its bill of materials and refunds)
						dev.larattalabs.architect.client.world.ServerTasks.callAsPlayer((level, player) -> dev.larattalabs.architect.site.Builder
							.checkConstructionDelta(level, new dev.larattalabs.architect.site.SiteDeltas.Request(s.id(), to,
								dev.larattalabs.architect.delta.DeltaPlanner.Edits.KEEP, false, s.owner(), true))).whenComplete((cc, e2) -> net.minecraft.client
									.Minecraft.getInstance().execute(() -> updateCheck = cc != null ? cc : c));
					}
				}
			}));
	}

	private void cancelUpdate() {
		updateSite = null;
		updateCheck = null;
		dev.larattalabs.architect.client.placement.CompositePreview.clear(UPDATE_KEY);
	}

	private void applyUpdate(Site s, int to) {
		dev.larattalabs.architect.client.world.ServerTasks.callAsPlayer((level, player) -> {
			var r = new dev.larattalabs.architect.site.SiteDeltas.Request(s.id(), to, dev.larattalabs.architect.delta.DeltaPlanner.Edits.KEEP, false, s.owner(),
				true);
			boolean instant = !dev.larattalabs.architect.survival.SurvivalWorld.on() || dev.larattalabs.architect.apiimpl.ApiRules.permission2(player);
			try {
				var res = instant ? dev.larattalabs.architect.site.SiteDeltas.apply(level, r) : dev.larattalabs.architect.site.Builder.applyConstructionDelta(
					level, r, player);
				return "Updated " + s.id() + " to v" + res.to() + (instant ? "" : ": feed its crate");
			} catch (Sites.SiteException e) {
				return "!" + e.getMessage();
			}
		}).whenComplete((msg, err) -> net.minecraft.client.Minecraft.getInstance().execute(() -> {
			String m = err != null ? "!" + err.getMessage() : msg;
			boolean bad = m.startsWith("!");
			LibraryFeature.say(bad ? m.substring(1) : m, bad);
			cancelUpdate();
		}));
	}

	private void revertSite(Site s, int k) {
		dev.larattalabs.architect.client.world.ServerTasks.callAsPlayer((level, player) -> {
			boolean instant = !dev.larattalabs.architect.survival.SurvivalWorld.on() || dev.larattalabs.architect.apiimpl.ApiRules.permission2(player);
			try {
				var res = instant ? dev.larattalabs.architect.site.SiteDeltas.revert(level, s.id(), k, s.owner(), true)
					: dev.larattalabs.architect.site.Builder.applyConstructionDelta(level, new dev.larattalabs.architect.site.SiteDeltas.Request(s.id(), k,
						dev.larattalabs.architect.delta.DeltaPlanner.Edits.KEEP, false, s.owner(), true), player);
				return (instant ? "Reverted " : "Rebuilding ") + s.id() + " as v" + res.to();
			} catch (Sites.SiteException e) {
				return "!" + e.getMessage();
			}
		}).whenComplete((msg, err) -> net.minecraft.client.Minecraft.getInstance().execute(() -> {
			String m = err != null ? "!" + err.getMessage() : msg;
			boolean bad = m.startsWith("!");
			LibraryFeature.say(bad ? m.substring(1) : m, bad);
		}));
	}

	private void scrollbar(GuiGraphicsExtractor g, int x, int y, int h) {
		if (listNeeded > listAvailable && h > 8) {
			// (U3) lab-ui's thumb: draggable, a click on the track pages towards it
			barRect = new int[] {x, y, 6, h};
			Panels.sprite(g, Kit.SCROLL_TRACK, x, y, 6, h);
			dev.larattalabs.labui.ui.ScrollMath.Thumb t = dev.larattalabs.labui.ui.ScrollMath.thumb(h, listNeeded, listAvailable, listScroll);
			boolean hot = barGrab >= 0 || lastMx >= x && lastMx < x + 6 && t.contains(y, (int) lastMy);
			Panels.sprite(g, hot ? Kit.SCROLL_THUMB_HOVER : Kit.SCROLL_THUMB, x, y + t.y(), 6, t.h());
			if (t.h() >= 10) {
				Panels.sprite(g, Kit.SCROLL_GRIP, x + 2, y + t.y() + t.h() / 2 - 1, 2, 3);
			}
		}
	}

	// ------------------------------------------------------------------ Designs tab

	/** A row of the Designs tab: a design (Claude), a variant or an import (the variant pipeline). */
	record Job(String id, String kind, String title, String fam, String status, String step, @Nullable String blueprintId, int @Nullable [] size,
		@Nullable String error, long createdAt, boolean running, SidecarState.@Nullable Design design, SidecarState.@Nullable Variant variant,
		dev.larattalabs.architect.api.@Nullable Group group, dev.larattalabs.architect.api.@Nullable BibleJob bible) {
		Job(String id, String kind, String title, String fam, String status, String step, @Nullable String blueprintId, int @Nullable [] size,
			@Nullable String error, long createdAt, boolean running, SidecarState.@Nullable Design design, SidecarState.@Nullable Variant variant) {
			this(id, kind, title, fam, status, step, blueprintId, size, error, createdAt, running, design, variant, null, null);
		}
	}

	/** A group's status as a dot family. */
	static String fam(dev.larattalabs.architect.api.Group.Status st) {
		return switch (st) {
			case DONE -> "done";
			case FAILED -> "error";
			case CANCELLED -> "idle";
			case QUEUED, HELD_USAGE, PAUSED_BUDGET, AWAITING_APPROVAL -> "waiting";
			default -> "working";
		};
	}

	/** (4c) A set item's dot: its massing waiting for approval is "waiting", not done. */
	static String itemFam(dev.larattalabs.architect.api.Group.Item it) {
		if (it.awaitingApproval()) {
			return "waiting";
		}
		return switch (it.status()) {
			case DONE -> "done";
			case FAILED -> "error";
			case CANCELLED -> "idle";
			case QUEUED -> "waiting";
			default -> "working";
		};
	}

	/** (4c) A set item's stage line: "massing v2 waits for approval · round 1/3", "detail · designing", ... */
	static String itemStage(dev.larattalabs.architect.api.Group gr, dev.larattalabs.architect.api.Group.Item it) {
		String status = it.status().name().toLowerCase(Locale.ROOT);
		if (it.stage().isEmpty()) {
			return status;
		}
		String m = it.massing().map(r -> " v" + r.version()).orElse("");
		String rounds = gr.maxRedirects() > 0 || it.rounds() > 0 ? " · round " + it.rounds() + "/" + gr.maxRedirects() : "";
		return switch (it.stage().get()) {
			case MASSING -> "massing" + m + " · " + status + rounds;
			case APPROVAL -> it.awaitingApproval() ? "massing" + m + " waits for approval" + rounds : "massing" + m + " · " + status + rounds;
			case DETAIL -> "detail of massing" + m + " · " + status;
			case COPY -> "copy of " + it.copyOf().orElse("?") + " · " + status;
		};
	}

	/** (4c) The set item whose redirect notes are being typed ({@code group/itemKey}), and the notes. */
	private static @Nullable String redirectItem;
	private final TextModel redirectNotes = new TextModel(2000);
	private final TextFieldView redirectView = new TextFieldView();

	private void startRedirect(String groupId, String itemKey) {
		redirectItem = groupId + "/" + itemKey;
		redirectNotes.clear();
		setFocus(Focus.REDIRECT);
	}

	/** Sends the typed redirect notes for {@link #redirectItem}. */
	void sendRedirect() {
		String ri = redirectItem;
		if (ri == null || redirectNotes.value().isBlank()) {
			return;
		}
		int slash = ri.indexOf('/');
		String g = ri.substring(0, slash);
		String key = ri.substring(slash + 1);
		dev.larattalabs.architect.client.design.SetFeature.approve(g, List.of(), Map.of(key, redirectNotes.value().strip()), List.of());
		redirectItem = null;
		redirectNotes.clear();
		setFocus(Focus.NONE);
	}

	static List<Job> jobs() {
		List<Job> out = new ArrayList<>();
		// (4b) design sets: one row each (their items' designs show in the set's detail, not as rows)
		for (JsonObject raw : Sidecar.state().groups()) {
			dev.larattalabs.architect.api.Group gr = dev.larattalabs.architect.apiimpl.Wire4b.group(raw);
			String st = gr.status().wire();
			String step = gr.done() + "/" + gr.items().size() + " done" + (gr.failed() > 0 ? ", " + gr.failed() + " failed" : "")
				+ String.format(Locale.ROOT, " · $%.2f", gr.cost().usd());
			out.add(new Job(gr.id(), "set", gr.name(), fam(gr.status()), st.replace('_', ' '), step, null, null, gr.reason().orElse(null), gr.createdAt(),
				!gr.finished(), null, null, gr, null));
		}
		for (JsonObject raw : Sidecar.state().bibleJobs()) {
			dev.larattalabs.architect.api.BibleJob bj = dev.larattalabs.architect.apiimpl.Wire4b.bibleJob(raw);
			String f = switch (bj.status()) {
				case DONE -> "done";
				case FAILED -> "error";
				case CANCELLED -> "idle";
				case QUEUED -> "waiting";
				default -> "working";
			};
			String name = bj.bible().map(dev.larattalabs.architect.api.Bible::name).orElse(bj.request().has("name") ? bj.request().get("name").getAsString()
				: bj.bibleId());
			out.add(new Job(bj.id(), "bible", (bj.kind().equals("revise") ? "Revise " : "Bible ") + name + " v" + bj.version(), f, bj.status().name()
				.toLowerCase(Locale.ROOT), bj.step(), null, null, bj.error().orElse(null), bj.createdAt(), !bj.finished(), null, null, null, bj));
		}
		for (SidecarState.Design d : Sidecar.state().designs()) {
			if (d.request().has("group")) {
				continue; // shown in its set
			}
			String fam = switch (d.status()) {
				case DONE -> "done";
				case FAILED -> "error";
				case CANCELLED -> "idle";
				case QUEUED -> "waiting";
				default -> "working";
			};
			String kind = d.raw().has("critiqueOf") ? "report" : d.raw().has("massing") ? "massing" : d.request().has("fromMassing") ? "detail" : d.request()
				.has("remix") ? "remix" : "design";
			out.add(new Job(d.id(), kind, d.title(), fam, d.status().wire(), d.step(), d.blueprintId(), d.size(), d.error(), d.createdAt(),
				d.status().isRunning(), d, null));
		}
		for (SidecarState.Variant v : Sidecar.state().variants()) {
			String fam = switch (v.status()) {
				case DONE -> "done";
				case FAILED -> "error";
				case QUEUED -> "waiting";
				case BUILDING -> "working";
				default -> "idle";
			};
			out.add(new Job(v.id(), v.isImport() ? "import" : "variant", LibraryFeature.title(v), fam, v.status().wire(), v.step(), v.blueprintId(),
				v.size(), v.error(), v.createdAt(), v.status().isRunning(), null, v));
		}
		out.sort((a, b) -> Long.compare(b.createdAt(), a.createdAt()));
		return out;
	}

	private void drawDesigns(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my) {
		groupArea = new int[4];
		List<Job> jobs = jobs();
		int listW = Math.min(240, (w - 12) / 2);
		int lh = footerY - 16 - top;
		listArea = new int[] {x, top, listW, lh};
		listAvailable = lh;
		scrollStep = ROW_H;
		Panels.inset(g, x, top, listW, lh);
		Job sel = null;
		for (Job j : jobs) {
			if (j.id().equals(selectedDesign)) {
				sel = j;
			}
		}
		if (sel == null && !jobs.isEmpty()) {
			sel = jobs.get(0);
			selectedDesign = sel.id();
		}
		listNeeded = jobs.size() * ROW_H + 4;
		listScroll = Math.max(0, Math.min(listScroll, Math.max(0, listNeeded - lh)));
		g.enableScissor(x + 1, top + 1, x + listW - 1, top + lh - 1);
		int ry = top + 3 - listScroll;
		for (Job j : jobs) {
			boolean isSel = j == sel;
			if (ry + ROW_H > top && ry < top + lh) {
				Hit h = new Hit("design:" + j.id(), j.title(), x + 2, Math.max(ry, top), listW - 4, Math.min(ROW_H - 2, top + lh - ry), true, isSel,
					() -> selectedDesign = j.id());
				hits.add(h);
				if (isSel) {
					g.fill(x + 2, ry, x + listW - 2, ry + ROW_H - 2, 0x22D97757);
				} else if (h.contains(mx, my)) {
					g.fill(x + 2, ry, x + listW - 2, ry + ROW_H - 2, 0x12000000);
				}
				Panels.dot(g, j.fam(), x + 6, ry + 4, false);
				String kind = j.kind().equals("design") ? "" : j.kind().toUpperCase(Locale.ROOT);
				int kw = kind.isEmpty() ? 0 : font.width(kind) + 6;
				g.text(font, TextUtil.ellipsize(font, j.title(), listW - 26 - kw), x + 16, ry + 2, UiBits.ink(), false);
				if (!kind.isEmpty()) {
					g.text(font, kind, x + listW - 6 - font.width(kind), ry + 2, UiStyle.CLAY_DARK, false);
				}
				g.text(font, TextUtil.ellipsize(font, j.status() + (j.step().isEmpty() ? "" : " · " + j.step()), listW - 24), x + 16, ry + 12,
					UiBits.muted(), false);
			}
			ry += ROW_H;
		}
		g.disableScissor();
		if (jobs.isEmpty()) {
			// (U3) no dead ends
			if (Sidecar.connected()) {
				emptyState(g, "empty:designs", "Nothing is being designed: describe a building and Claude designs it.", "Design one", () -> setTab(Tab.DESIGN),
					x, top, listW, lh, mx, my);
			} else {
				emptyState(g, "empty:designs", "The design helper is not connected.", "Status tab", () -> setTab(Tab.STATUS), x, top, listW, lh, mx, my);
			}
		}
		scrollbar(g, x + listW + 2, top, lh);
		if (sel == null) {
			return;
		}
		Job j = sel;
		int dx = x + listW + 12;
		int dw = w - listW - 12;
		int y = top;
		if (j.group() != null) {
			drawGroup(g, j.group(), dx, y, dw, footerY, mx, my);
			return;
		}
		if (j.bible() != null) {
			drawBibleJob(g, j.bible(), dx, y, dw, footerY, mx, my);
			return;
		}
		g.text(font, TextUtil.ellipsize(font, j.title() + "  (" + j.id() + ")", dw), dx, y, UiBits.ink(), false);
		y += 12;
		g.text(font, TextUtil.ellipsize(font, j.status() + (j.step().isEmpty() ? "" : ": " + j.step()), dw), dx, y, UiBits.muted(), false);
		y += 12;
		if (j.design() != null) {
			JsonObject r = j.design().request();
			for (String k : List.of("type", "style", "materials", "name")) {
				if (r.has(k)) {
					g.text(font, TextUtil.ellipsize(font, k + ": " + r.get(k).getAsString(), dw), dx, y, UiBits.ink(), false);
					y += 10;
				}
			}
			if (r.has("remix")) {
				g.text(font, TextUtil.ellipsize(font, "remix of: " + LibraryFeature.nameOf(r.get("remix").getAsString()), dw), dx, y, UiBits.ink(), false);
				y += 10;
			}
			if (r.has("features")) {
				g.text(font, TextUtil.ellipsize(font, "features: " + r.get("features").toString().replaceAll("[\\[\\]\"]", "").replace(",", ", "), dw),
					dx, y, UiBits.ink(), false);
				y += 10;
			}
			if (r.has("maxSize")) {
				JsonObject sz = r.getAsJsonObject("maxSize");
				g.text(font, "at most " + sz.get("x") + " × " + sz.get("y") + " × " + sz.get("z"), dx, y, UiBits.ink(), false);
				y += 10;
			}
			// (4c) a massing job, or a detail pass and its conformance
			var mref = dev.larattalabs.architect.apiimpl.Wire4c.designMassing(j.design().raw());
			if (mref.isPresent()) {
				JsonObject mraw = Sidecar.state().massing(mref.get().id());
				String extra = mraw == null ? "" : " · " + dev.larattalabs.architect.apiimpl.Wire4c.massing(mraw).parts().size() + " masses" + (mraw.has(
					"detail") ? " · detailed" : "");
				g.text(font, TextUtil.ellipsize(font, "massing " + mref.get().id() + " v" + mref.get().version() + extra, dw), dx, y, UiStyle.CLAY_DARK, false);
				y += 10;
				if (r.has("redirect") && r.get("redirect").isJsonObject()) {
					for (String line : TextUtil.wrapPlain(font, "redirect: " + r.getAsJsonObject("redirect").get("notes").getAsString(), dw).stream().limit(2)
						.toList()) {
						g.text(font, line, dx, y, UiBits.ink(), false);
						y += 10;
					}
				}
			}
			if (r.has("fromMassing")) {
				g.text(font, TextUtil.ellipsize(font, "detail of massing " + r.get("fromMassing").getAsString() + (r.has("massingVersion") ? " v" + r.get(
					"massingVersion").getAsString() : ""), dw), dx, y, UiStyle.CLAY_DARK, false);
				y += 10;
			}
			var conf = dev.larattalabs.architect.apiimpl.Wire4c.conformance(j.design().raw().get("conformance"));
			if (conf.isPresent()) {
				var c = conf.get();
				String cl = c.ok() && c.warnings() == 0 ? "conformance: ok (" + UiBits.CHECK + " part names, boxes, size, roofs)" : "conformance: " + (c.ok()
					? "ok" : "not ok") + ", " + c.warnings() + " warning" + (c.warnings() == 1 ? "" : "s");
				g.text(font, TextUtil.ellipsize(font, cl, dw), dx, y, c.ok() && c.warnings() == 0 ? UiBits.okText() : UiStyle.CLAY_DARK, false);
				y += 10;
				List<String> all = new ArrayList<>(c.errors());
				all.addAll(c.issues());
				for (String warn : all.stream().limit(4).toList()) {
					g.text(font, TextUtil.ellipsize(font, "· " + warn, dw), dx, y, UiStyle.CLAY_DARK, false);
					y += 10;
				}
				if (all.size() > 4) {
					g.text(font, "· " + (all.size() - 4) + " more", dx, y, UiBits.muted(), false);
					y += 10;
				}
			}
			// (5a) the critique: how it ended, every round with its overall (the best one starred), the best round's scores and issues
			var crit = dev.larattalabs.architect.apiimpl.Wire5a.record(j.design().raw().get("critique"));
			if (crit.isPresent()) {
				y = drawCritique(g, crit.get(), j.design().raw().has("critiqueOf") ? j.design().raw().get("critiqueOf").getAsString() : null, dx, y + 2, dw,
					footerY - 16 - 24);
			}
		} else if (j.variant() != null) {
			SidecarState.Variant v = j.variant();
			if (v.from() != null) {
				g.text(font, TextUtil.ellipsize(font, "from: " + LibraryFeature.nameOf(v.from()) + " (" + v.from() + ")", dw), dx, y, UiBits.ink(), false);
				y += 10;
			}
			if (v.path() != null) {
				g.text(font, TextUtil.ellipsize(font, "file: " + v.path(), dw), dx, y, UiBits.ink(), false);
				y += 10;
			}
			g.text(font, TextUtil.ellipsize(font, "no Claude call: the helper " + (v.isImport() ? "checks the structure (custom profile)"
				: "re-runs the design's code"), dw), dx, y, UiBits.muted(), false);
			y += 10;
		}
		if (j.blueprintId() != null) {
			g.text(font, TextUtil.ellipsize(font, "result: " + j.blueprintId() + (j.size() == null ? "" : " (" + j.size()[0] + "×" + j.size()[1] + "×"
				+ j.size()[2] + ")"), dw), dx, y, UiBits.okText(), false);
			y += 10;
		}
		if (j.error() != null) {
			for (String line : TextUtil.wrapPlain(font, j.error(), dw).stream().limit(6).toList()) {
				g.text(font, line, dx, y, UiBits.errorText(), false);
				y += 10;
			}
		}
		int by = footerY - 16 - 20;
		int bx = dx;
		if (j.design() != null) {
			String cancel = "Cancel";
			button(g, "cancel_design", cancel, bx, by, bw(cancel), false, j.running() && Sidecar.connected(), mx, my,
				() -> DesignFeature.cancel(j.id()));
			bx += bw(cancel) + 4;
		}
		var jm = j.design() == null ? java.util.Optional.<dev.larattalabs.architect.api.MassingRef>empty() : dev.larattalabs.architect.apiimpl.Wire4c
			.designMassing(j.design().raw());
		if (j.fam().equals("done") && jm.isPresent()) {
			// (4c) a finished massing: show it in the world with the Approve / Redirect… / Cancel bar
			String rv = "Review massing";
			JsonObject mraw = Sidecar.state().massing(jm.get().id());
			boolean grouped = mraw != null && mraw.has("group");
			button(g, "design:review_massing", rv, bx, by, bw(rv), true, mraw != null && !grouped && inWorld(), mx, my, () -> {
				String why = dev.larattalabs.architect.client.design.MassingReview.open(jm.get().id());
				if (why != null) {
					LibraryFeature.say(why, true);
				} else {
					onClose();
				}
			});
			bx += bw(rv) + 4;
		}
		if (j.fam().equals("done") && j.blueprintId() != null) {
			String show = "Show in Library";
			button(g, "show_library", show, bx, by, bw(show), true, Blueprints.get(j.blueprintId()) != null, mx, my, () -> {
				LibraryFeature.select(j.blueprintId());
				LibraryFeature.setQuery(dev.larattalabs.architect.library.LibraryQuery.ALL.withSort(LibraryFeature.query().sort()));
				LibraryTab.dialog = LibraryTab.Dialog.NONE;
				showPlaced = false;
				setTab(Tab.LIBRARY);
			});
		}
	}

	/**
	 * (5a) A design's critique in the Designs tab: the end line, a line per round (overall, ships, issues; the best round starred),
	 * then the best round's scores and as many of its issues as fit above {@code bottom}. Returns the next y.
	 */
	private int drawCritique(GuiGraphicsExtractor g, dev.larattalabs.architect.api.Critique c, @Nullable String of, int dx, int y, int dw, int bottom) {
		String head = dev.larattalabs.architect.design.CritiqueRules.endLine(c) + (of != null ? " · of " + of : "") + String.format(Locale.ROOT,
			" · $%.2f", c.usd());
		g.text(font, TextUtil.ellipsize(font, head, dw), dx, y, c.ended() && c.end() == dev.larattalabs.architect.api.Critique.EndReason.SHIP
			? UiBits.okText() : UiStyle.CLAY_DARK, false);
		y += 11;
		List<String> rounds = dev.larattalabs.architect.design.CritiqueRules.roundLines(c);
		for (int i = 0; i < rounds.size() && y + 10 <= bottom; i++) {
			var r = c.rounds().get(i);
			boolean best = r.n() == c.best() && (c.ended() || r.scored());
			if (best) {
				g.fill(dx, y - 1, dx + dw, y + 9, 0x22D97757);
			}
			g.text(font, TextUtil.ellipsize(font, rounds.get(i), dw - 4), dx + 2, y, best ? UiBits.ink() : r.error().isPresent() ? UiStyle.CLAY_DARK
				: UiBits.muted(), false);
			y += 10;
		}
		if (!c.scores().isEmpty() && y + 10 <= bottom) {
			g.text(font, TextUtil.ellipsize(font, dev.larattalabs.architect.design.CritiqueRules.scoresLine(c.scores()), dw), dx, y, UiBits.ink(), false);
			y += 10;
		}
		List<String> issues = dev.larattalabs.architect.design.CritiqueRules.issueLines(c.openIssues());
		for (int i = 0; i < issues.size() && y + 10 <= bottom; i++) {
			g.text(font, TextUtil.ellipsize(font, "· " + issues.get(i), dw), dx, y, UiStyle.CLAY_DARK, false);
			y += 10;
		}
		return y;
	}

	/** A design set's detail: status, bible, cost and budget, every item's progress, and its actions. */
	private void drawGroup(GuiGraphicsExtractor g, dev.larattalabs.architect.api.Group gr, int dx, int top, int dw, int footerY, int mx, int my) {
		int y = top;
		g.text(font, TextUtil.ellipsize(font, gr.name() + "  (" + gr.id() + ")", dw), dx, y, UiBits.ink(), false);
		y += 12;
		var st = gr.status();
		String head = st.wire().replace('_', ' ') + " · " + gr.done() + " of " + gr.items().size() + " done" + (gr.failed() > 0 ? ", " + gr.failed()
			+ " failed" : "") + (gr.wave() >= 0 && !gr.finished() ? " · wave " + gr.wave() : "");
		Panels.dot(g, fam(st), dx, y + 1, false);
		g.text(font, TextUtil.ellipsize(font, head, dw - 10), dx + 10, y, st == dev.larattalabs.architect.api.Group.Status.FAILED ? UiBits.errorText()
			: UiBits.ink(), false);
		y += 11;
		String bibleName = dev.larattalabs.architect.client.design.SetFeature.bible(gr.bible().id()).map(dev.larattalabs.architect.api.Bible::name)
			.orElse(gr.bible().id());
		String cost = String.format(Locale.ROOT, "$%.2f", gr.cost().usd()) + gr.budgetUsd().map(b -> String.format(Locale.ROOT, " of $%.2f budget", b))
			.orElse(" (no budget)");
		g.text(font, TextUtil.ellipsize(font, "bible " + bibleName + " v" + gr.bible().version() + " · " + gr.concurrency() + " at a time · " + cost, dw),
			dx, y, UiBits.muted(), false);
		y += 10;
		if (st == dev.larattalabs.architect.api.Group.Status.HELD_USAGE) {
			String until = gr.usageLimitUntil() > 0 ? UiBits.clock(gr.usageLimitUntil()) : "the reset";
			g.text(font, TextUtil.ellipsize(font, "Held by a usage limit: every building waits until " + until + ", then all resume.", dw), dx, y,
				UiStyle.CLAY_DARK, false);
			y += 10;
		} else if (gr.reason().isPresent()) {
			for (String line : TextUtil.wrapPlain(font, gr.reason().get(), dw).stream().limit(2).toList()) {
				g.text(font, line, dx, y, st == dev.larattalabs.architect.api.Group.Status.PAUSED_BUDGET ? UiStyle.CLAY_DARK : UiBits.errorText(), false);
				y += 10;
			}
		}
		// (4c) who approves a massingFirst set
		boolean architectUi = gr.approvalUi() == dev.larattalabs.architect.api.GroupRequest.ApprovalUi.ARCHITECT;
		boolean approving = gr.massingFirst() && architectUi && !gr.finished() && Sidecar.connected();
		if (gr.massingFirst()) {
			String who = architectUi ? "massings first · approve each shape here" + (gr.maxRedirects() > 0 ? ", " + gr.maxRedirects() + " redirect"
				+ (gr.maxRedirects() == 1 ? "" : "s") + " each" : "") : "massings first · its owner approves: " + gr.owner().orElse("?");
			g.text(font, TextUtil.ellipsize(font, who, dw), dx, y, architectUi ? UiStyle.CLAY_DARK : UiBits.muted(), false);
			y += 10;
		}
		y += 3;
		// the items
		int by = footerY - 16 - 20;
		boolean typing = redirectItem != null && redirectItem.startsWith(gr.id() + "/") && approving;
		if (typing) {
			by -= TextFieldView.BASE_H + 4;
		}
		int rowH = 20;
		int listH = by - 4 - y;
		Panels.inset(g, dx, y, dw, listH);
		int fit = Math.max(1, (listH - 4) / rowH);
		groupArea = new int[] {dx, y, dw, listH};
		groupScroll = Math.max(0, Math.min(groupScroll, Math.max(0, gr.items().size() - fit)));
		int first = groupScroll;
		for (int i = first; i < Math.min(gr.items().size(), first + fit); i++) {
			var it = gr.items().get(i);
			int ry = y + 3 + (i - first) * rowH;
			Panels.dot(g, itemFam(it), dx + 4, ry + 2, false);
			String name = it.name().orElse(it.itemKey());
			String right = String.format(Locale.ROOT, "$%.2f", it.cost().usd());
			int rw = font.width(right);
			// (4c) Approve / Redirect… / × on a massing that waits (Architect's UI only)
			int actionsW = 0;
			if (approving && it.awaitingApproval()) {
				String ik = it.itemKey();
				int ax = dx + dw - 8;
				ax -= font.width("×") + 12;
				chip(g, "group:item_cancel:" + ik, "×", ax, ry - 2, false, true, mx, my, () -> dev.larattalabs.architect.client.design.SetFeature.approve(
					gr.id(), List.of(), Map.of(), List.of(ik)));
				boolean canRedirect = it.rounds() < gr.maxRedirects();
				ax -= font.width("Redirect…") + 12 + 3;
				chip(g, "group:item_redirect:" + ik, "Redirect…", ax, ry - 2, (gr.id() + "/" + ik).equals(redirectItem), canRedirect, mx, my,
					() -> startRedirect(gr.id(), ik));
				ax -= font.width("Approve") + 12 + 3;
				chip(g, "group:item_approve:" + ik, "Approve", ax, ry - 2, true, true, mx, my, () -> dev.larattalabs.architect.client.design.SetFeature
					.approve(gr.id(), List.of(ik), Map.of(), List.of()));
				actionsW = dx + dw - 8 - ax + 6;
			}
			String role = it.role() == dev.larattalabs.architect.api.GroupRequest.Role.LANDMARK ? " ★" : "";
			int titleRoom = actionsW > 0 ? dw - 16 - actionsW : dw - 30 - rw;
			g.text(font, TextUtil.ellipsize(font, name + role + " · " + it.type() + (it.wave() == 0 ? " · anchor" : " · wave " + it.wave()), titleRoom),
				dx + 14, ry, UiBits.ink(), false);
			if (actionsW == 0) {
				g.text(font, right, dx + dw - 10 - rw, ry, UiBits.muted(), false);
			}
			String stage = gr.massingFirst() ? itemStage(gr, it) : it.status().name().toLowerCase(Locale.ROOT);
			// (4c) a detail pass's conformance: ok, or its warnings (the first one shown)
			String conf = "";
			SidecarState.Design dd = it.stage().orElse(null) == dev.larattalabs.architect.api.Group.Stage.DETAIL ? Sidecar.state().design(it.designId())
				: null;
			var c = dd == null ? java.util.Optional.<dev.larattalabs.architect.api.Conformance>empty() : dev.larattalabs.architect.apiimpl.Wire4c
				.conformance(dd.raw().get("conformance"));
			boolean warn = false;
			if (c.isPresent()) {
				warn = !c.get().ok() || c.get().warnings() > 0;
				List<String> all = new ArrayList<>(c.get().errors());
				all.addAll(c.get().issues());
				conf = warn ? " · conformance: " + c.get().warnings() + " warning" + (c.get().warnings() == 1 ? "" : "s") + (all.isEmpty() ? "" : " ("
					+ all.get(0) + ")") : " · conformance ok";
			}
			// (5a) the item's critique: its overall and how the loop ended (or the round it is in)
			// the rounds come from the item's design record when the client has it ("5.0 → 8.0★")
			SidecarState.Design idd = it.critique().isPresent() ? Sidecar.state().design(it.designId()) : null;
			var full = idd == null ? java.util.Optional.<dev.larattalabs.architect.api.Critique>empty() : dev.larattalabs.architect.apiimpl.Wire5a.record(idd
				.raw().get("critique"));
			String crit = it.critique().map(cr -> " · " + dev.larattalabs.architect.design.CritiqueRules.brief(full.orElse(cr)) + full.map(fc -> " ("
				+ dev.larattalabs.architect.design.CritiqueRules.roundsShort(fc) + ")").orElse("")).orElse("");
			String line = stage + conf + crit + (it.step().isEmpty() || it.awaitingApproval() || !conf.isEmpty() || !crit.isEmpty() ? "" : " · " + it.step()) + it.entryId().map(
				e -> " → " + e).orElse("") + it.error().map(e -> " · " + e).orElse("") + (actionsW > 0 ? " · " + right : "");
			g.text(font, TextUtil.ellipsize(font, line, dw - 24 - actionsW), dx + 14, ry + 9, it.status() == dev.larattalabs.architect.api.Design.Status.FAILED
				? UiBits.errorText() : it.awaitingApproval() || warn ? UiStyle.CLAY_DARK : UiBits.muted(), false);
		}
		if (gr.items().size() > fit) {
			TextUtil.Scroll sc = new TextUtil.Scroll().update(gr.items().size() * rowH, fit * rowH);
			sc.scrollBy(-1_000_000);
			sc.scrollBy(first * rowH);
			Panels.scrollbar(g, dx + dw - 6, y, listH, sc, false);
		}
		// (4c) the redirect notes of one item
		if (typing) {
			String key = redirectItem.substring(gr.id().length() + 1);
			String iname = gr.item(key).flatMap(dev.larattalabs.architect.api.Group.Item::name).orElse(key);
			String send = "Redirect";
			int sw = bw(send);
			int fy = by - 1;
			textField(g, Focus.REDIRECT, redirectView, redirectNotes, dx, fy + 1, dw - sw - 6, new TextFieldView.Style(TextUtil.ellipsize(font, iname, 70)
				+ ": ", UiStyle.CLAY_DARK, "how should it change? Enter sends", null, null, 0, 1));
			button(g, "group:redirect_send", send, dx + dw - sw, fy, sw, true, !redirectNotes.value().isBlank(), mx, my, this::sendRedirect);
			by += TextFieldView.BASE_H + 4;
		}
		// actions
		int bx = dx;
		boolean live = Sidecar.connected() && !gr.finished();
		if (approving && !gr.awaiting().isEmpty()) {
			String all = "Approve all";
			button(g, "group:approve_all", all, bx, by, bw(all), true, true, mx, my, () -> dev.larattalabs.architect.client.design.SetFeature.approve(gr
				.id(), gr.awaiting(), Map.of(), List.of()));
			bx += bw(all) + 4;
			String show = "Show massings";
			// on a narrow panel (GUI scale 4) it gives way to Cancel set (the row shows by itself when the set starts waiting)
			if (bx + bw(show) + 4 + bw("Cancel set") <= dx + dw) {
				button(g, "group:show_massings", show, bx, by, bw(show), false, inWorld(), mx, my, () -> {
					String why = dev.larattalabs.architect.client.design.MassingReview.showSet(gr.id());
					dev.larattalabs.architect.client.design.SetFeature.say(why != null ? why
						: "The massings stand in a row in front of you (close this screen to see them)", why != null);
				});
				bx += bw(show) + 4;
			}
		}
		if (st == dev.larattalabs.architect.api.Group.Status.PAUSED_BUDGET) {
			String res = "Resume";
			button(g, "group:resume", res, bx, by, bw(res), true, live, mx, my, () -> dev.larattalabs.architect.client.design.SetFeature.resumeGroup(gr
				.id()));
			bx += bw(res) + 4;
		}
		if (gr.budgetUsd().isPresent() && !gr.finished()) {
			double to = extendTo(gr.budgetUsd().get(), gr.cost().usd());
			String ext = String.format(Locale.ROOT, "Budget → $%.0f", to);
			button(g, "group:extend", ext, bx, by, bw(ext), false, live, mx, my, () -> dev.larattalabs.architect.client.design.SetFeature.extendGroup(gr
				.id(), to));
			bx += bw(ext) + 4;
		}
		// a set its owner approves (approvalUi owner) is the owner's to run: no buttons but Show in Library
		if (architectUi || !gr.massingFirst()) {
			String cancel = "Cancel set";
			button(g, "group:cancel", cancel, bx, by, bw(cancel), false, live, mx, my, () -> dev.larattalabs.architect.client.design.SetFeature
				.cancelGroup(gr.id()));
			bx += bw(cancel) + 4;
		}
		String show = "Show in Library";
		if (bx + bw(show) <= dx + dw) {
			button(g, "group:library", show, bx, by, bw(show), gr.finished(), gr.done() > 0, mx, my, () -> showCollection(
				dev.larattalabs.architect.library.LibraryQuery.GROUP_PREFIX + gr.id()));
		}
		String msg = dev.larattalabs.architect.client.design.SetFeature.message();
		if (msg != null) {
			statusLine(g, msg, dev.larattalabs.architect.client.design.SetFeature.messageError(), dx, footerY - 13, dw);
		}
	}

	/** The next budget step: half again, at least $1 above what was spent, rounded up to a dollar. */
	static double extendTo(double budget, double spent) {
		return Math.ceil(Math.max(budget * 1.5, spent + 1));
	}

	/** A bible job's detail: status, step, cost, the sheet once done. */
	private void drawBibleJob(GuiGraphicsExtractor g, dev.larattalabs.architect.api.BibleJob bj, int dx, int top, int dw, int footerY, int mx, int my) {
		int y = top;
		g.text(font, TextUtil.ellipsize(font, (bj.kind().equals("revise") ? "Revise " : "Bible ") + bj.bibleId() + " v" + bj.version() + "  (" + bj.id()
			+ ")", dw), dx, y, UiBits.ink(), false);
		y += 12;
		String bst = bj.status().name().toLowerCase(Locale.ROOT);
		g.text(font, TextUtil.ellipsize(font, bj.step().isEmpty() ? bst : bj.step().startsWith(bst) ? bj.step() : bst + ": " + bj.step(), dw), dx, y,
			UiBits.muted(), false);
		y += 11;
		String prompt = bj.request().has("prompt") ? bj.request().get("prompt").getAsString() : "";
		for (String line : TextUtil.wrapPlain(font, "prompt: " + prompt, dw).stream().limit(2).toList()) {
			g.text(font, line, dx, y, UiBits.ink(), false);
			y += 10;
		}
		g.text(font, String.format(Locale.ROOT, "cost $%.2f · %d component round%s", bj.cost().usd(), bj.rounds(), bj.rounds() == 1 ? "" : "s"), dx, y,
			UiBits.muted(), false);
		y += 10;
		if (bj.error().isPresent()) {
			for (String line : TextUtil.wrapPlain(font, bj.error().get(), dw).stream().limit(3).toList()) {
				g.text(font, line, dx, y, UiBits.errorText(), false);
				y += 10;
			}
		}
		int by = footerY - 16 - 20;
		var bible = bj.bible().or(() -> bj.finished() ? dev.larattalabs.architect.client.design.SetFeature.bible(bj.bibleId()) : java.util.Optional.empty());
		if (bible.isPresent()) {
			RolesSwatch.draw(g, bible.get(), dx, y + 2, dw);
			y += 20;
			var sheet = RolesSwatch.sheet(bible.get());
			int sh = by - 4 - y;
			if (sheet != null && sh > 30) {
				Panels.inset(g, dx, y, dw, sh);
				PreviewImages.draw(g, sheet, dx + 2, y + 2, dw - 4, sh - 4);
			}
		}
		int bx = dx;
		String cancel = "Cancel";
		button(g, "bible:cancel", cancel, bx, by, bw(cancel), false, !bj.finished() && Sidecar.connected(), mx, my,
			() -> dev.larattalabs.architect.client.design.SetFeature.cancelBible(bj.id()));
		bx += bw(cancel) + 4;
		String use = "Design a set with it…";
		button(g, "bible:use", use, bx, by, bw(use), true, bj.status() == dev.larattalabs.architect.api.BibleJob.Status.DONE, mx, my, () -> {
			var f = dev.larattalabs.architect.client.design.SetFeature.open();
			f.bible = bj.bibleId();
			f.newBible = false;
			openSet();
		});
	}

	/** Shows the Library filtered to a collection ({@code bible:<id>} / {@code group:<id>}). */
	void showCollection(String key) {
		LibraryFeature.setQuery(dev.larattalabs.architect.library.LibraryQuery.ALL.withSort(LibraryFeature.query().sort()).withCollection(key));
		LibraryTab.dialog = LibraryTab.Dialog.NONE;
		showPlaced = false;
		setTab(Tab.LIBRARY);
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
		// UI-2b: the plain sentence first; the technical detail (exit codes, ports, env vars) as small print under it
		String plain = Launcher.summary().isEmpty() ? Launcher.detail() : Launcher.summary();
		for (String line : TextUtil.wrapPlain(font, plain, colW).stream().limit(3).toList()) {
			g.text(font, line, lx, y, st == LauncherPlan.State.NODE_MISSING || st == LauncherPlan.State.CRASHED ? UiStyle.error() : UiBits.ink(), false);
			y += 10;
		}
		if (st == LauncherPlan.State.INSTALLING && Launcher.installStartedAt() > 0) {
			dev.larattalabs.architect.client.hud.ProgressStrip.draw(g, font, lx, y, colW, "Installing · " + dev.larattalabs.architect.client.hud
				.ProgressStrip.elapsed(Launcher.installStartedAt()), -1, UiBits.muted(), UiStyle.status("working"), UiStyle.rule());
			y += 13;
		}
		String small = (Launcher.summary().isEmpty() ? "" : "Details: " + Launcher.detail()) + (Launcher.devBuildWithoutBundle()
			&& !Launcher.detail().equals(Launcher.NO_BUNDLE) ? (Launcher.summary().isEmpty() ? "" : " · ") + Launcher.NO_BUNDLE : "");
		for (String line : TextUtil.wrapPlain(font, small, colW).stream().limit(3).toList()) {
			g.text(font, line, lx, y, UiStyle.mutedText(), false);
			y += 10;
		}
		if (Launcher.installLine() != null) {
			g.text(font, TextUtil.ellipsize(font, "npm: " + Launcher.installLine(), colW), lx, y, UiStyle.mutedText(), false);
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
		// SAFETY: the big-placement confirm's threshold and the undo key (the left column: the right one is full at GUI scale 4)
		g.text(font, "Safety", lx, y, UiStyle.CLAY_DARK, false);
		y += 12;
		String safety = "Placing " + dev.larattalabs.architect.placement.PlaceConfirm.count(dev.larattalabs.architect.client.placement.BuildPlacement
			.confirmThreshold()) + "+ blocks, or over blocks that aren't terrain, takes Enter twice (confirmBlocks in config/architect_mc.json). Undo last "
			+ "placement: " + dev.larattalabs.architect.client.hud.Keys.label(dev.larattalabs.architect.client.hud.Keys.undoLast) + " twice (Controls to rebind).";
		for (String line : TextUtil.wrapPlain(font, safety, colW)) {
			g.text(font, line, lx, y, UiBits.muted(), false);
			y += 10;
		}
		y += 6;
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
		// (5a, N1) critique by default: the Design tab's and the set dialog's "Critique and revise" start on
		ry += 6;
		boolean crit = dev.larattalabs.architect.client.design.UiPrefs.critiqueByDefault();
		String cl = "Critique and revise new designs by default (experimental)";
		Hit ct = new Hit("critique_default", cl, rx, ry, Math.min(colW, 13 + font.width(cl)), 12, true, crit, () -> dev.larattalabs.architect.client.design.UiPrefs.setCritiqueByDefault(!crit));
		hits.add(ct);
		Panels.sprite(g, crit ? Kit.CHECKBOX_CHECKED : Kit.CHECKBOX, rx, ry + 1, 10, 10, 0xFFFFFFFF);
		g.text(font, TextUtil.ellipsize(font, cl, colW - 13), rx + 13, ry + 2, UiBits.ink(), false);
		ry += 14;
		for (String line : TextUtil.wrapPlain(font, "A critic reviews each design's renders and the designer revises it (up to 2 rounds, at most about doubling its cost). Off by default.", colW)) {
			g.text(font, line, rx, ry, UiBits.muted(), false);
			ry += 10;
		}
		// UI-2b: the construction HUD's size (the J key cycles it too)
		ry += 4;
		var hudMode = dev.larattalabs.architect.client.design.UiPrefs.siteHud();
		String hl = "Construction HUD: " + switch (hudMode) {
			case FULL -> "full";
			case LINE -> "one line";
			case HIDDEN -> "hidden";
		} + " (click or " + dev.larattalabs.architect.client.hud.Keys.label(dev.larattalabs.architect.client.hud.Keys.siteHud) + " to change)";
		hits.add(new Hit("site_hud", hl, rx, ry, Math.min(colW, font.width(hl)), 12, true, hudMode != dev.larattalabs.architect.client.design.UiPrefs.SiteHud
			.HIDDEN, () -> dev.larattalabs.architect.client.design.UiPrefs.setSiteHud(hudMode.next())));
		g.text(font, TextUtil.ellipsize(font, hl, colW), rx, ry + 2, UiStyle.link(), false);
		ry += 12;
		// survival construction sites: this world's toggle (docs/CONTRACT.md phase 3 "UI")
		ry += 8;
		g.text(font, "Survival (this world)", rx, ry, UiStyle.CLAY_DARK, false);
		ry += 12;
		boolean inWorld = dev.larattalabs.architect.survival.SurvivalWorld.loaded();
		boolean survivalOn = dev.larattalabs.architect.survival.SurvivalWorld.on();
		boolean may = inWorld && dev.larattalabs.architect.client.survival.SurvivalFeature.mayToggle();
		String sl = "Construction sites";
		Hit sv = new Hit("survival_toggle", sl, rx, ry, Math.min(colW, 13 + font.width(sl)), 12, may, survivalOn, () -> toggleSurvival(!survivalOn));
		hits.add(sv);
		Panels.sprite(g, survivalOn ? Kit.CHECKBOX_CHECKED : Kit.CHECKBOX, rx, ry + 1, 10, 10, may ? 0xFFFFFFFF : 0x90FFFFFF);
		g.text(font, TextUtil.ellipsize(font, sl + (survivalOn ? ": on" : ": off"), colW - 13), rx + 13, ry + 2, UiBits.ink(), false);
		ry += 14;
		String svNote = !inWorld ? "Open a world to see its setting." : (survivalOn
			? "Place makes a construction site that builds as its crate is fed (hoppers welcome)."
			: "Placement is instant and free.") + (may ? " Changing it needs cheats (permission level 2): you have them."
			: " Changing it needs cheats (permission level 2): ask an operator, or /architect survival on or off with cheats.");
		for (String line : TextUtil.wrapPlain(font, svNote, colW)) {
			g.text(font, line, rx, ry, UiBits.muted(), false);
			ry += 10;
		}
		statusLine(g, survivalMessage, survivalMessageError, rx, ry, colW);
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
		o.addProperty("libraryMessage", LibraryFeature.message());
		o.addProperty("libraryDialog", LibraryTab.dialog.name().toLowerCase(Locale.ROOT));
		o.addProperty("libraryEdit", library.edit.name().toLowerCase(Locale.ROOT));
		// (U3) the ⋯ menu and its Delete's two presses
		o.addProperty("libraryMenu", library.menuOpen);
		o.addProperty("deleteArmed", library.deleteArmed());
		o.addProperty("popup", popup == null ? null : popup.id);
		o.addProperty("showPlaced", showPlaced);
		o.addProperty("selectedEntry", selectedEntry);
		o.addProperty("selectedSite", selectedSite);
		o.addProperty("selectedDesign", selectedDesign);
		o.addProperty("setDialog", dev.larattalabs.architect.client.design.SetFeature.form() != null);
		JsonArray a = new JsonArray();
		List<Hit> all = new ArrayList<>(overlayHits);
		all.addAll(hits);
		for (Hit h : all) {
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
