package dev.larattalabs.architect.client.screen;

import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.client.design.SetFeature;
import dev.larattalabs.architect.client.library.LibraryFeature;
import dev.larattalabs.architect.library.StyleCatalog;
import dev.larattalabs.labui.client.picker.PickerEntry;
import dev.larattalabs.labui.client.picker.PickerScreen;
import dev.larattalabs.labui.client.picker.PickerSpec;
import dev.larattalabs.labui.client.picker.PickerStore;
import dev.larattalabs.labui.client.text.TextFieldView;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.labui.client.widget.Button;
import dev.larattalabs.labui.client.widget.Chip;
import dev.larattalabs.labui.client.widget.ScrollList;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) The Style browser: lab-ui's {@link PickerScreen} in CARDS mode over every Style ({@link StyleCatalog}). Cards are
 * preview sheets drawn from each Style's roles, with its tags (+N); the rail is Yours / Built-in / Made by Claude / Settlements, and
 * ★ Favourites is the head row's chip (lab-ui's PickerStore keeps them, per player, under {@value #ID}). The detail pane says where the
 * Style came from, what it is based on, its tags, what it suggests and how many designs use it; "Use this style" picks it; Duplicate
 * and Edit sit above (Edit only for the player's own: {@link Bible#editable()}).
 *
 * <p>The Compare chip is "+ New style ▾": copy the selected Style, start from a built-in, or describe one (Claude drafts it: a bible
 * job, with its cost line). The Tags chip filters by tag. A single click selects a card (so Duplicate and Edit have something to act
 * on); a double click, Enter or "Use this style" uses it. Client thread.
 */
public final class StyleBrowserScreen extends PickerScreen {
	public static final String ID = "architect_mc.styles";
	private static final int TITLE_H = 22;
	private static final int ROW_GAP = 5;

	private final Consumer<Bible> use;
	private final Map<String, StyleCatalog.Card> cards;
	private final Button duplicate = new Button("Duplicate", this::duplicateSelected);
	private final Button edit = new Button("Edit", this::editSelected);
	/** The "+ New style" menu (null: closed) and, under it, the built-in list. */
	private @Nullable Menu menu;
	private boolean gridClick;
	private boolean stay;
	private boolean clickSelected;
	private @Nullable String message;

	enum Menu {
		NEW, BUILTIN, TAGS
	}

	private final List<Button> menuButtons = new ArrayList<>();
	private final ScrollList<Bible> builtinList;
	private final ScrollList<String> tagList;
	private int[] menuRect = new int[4];

	private StyleBrowserScreen(PickerSpec spec, Map<String, StyleCatalog.Card> cards, @Nullable Screen parent, Consumer<Bible> use) {
		super(spec, parent);
		this.cards = cards;
		this.use = use;
		builtinList = ScrollList.text((Bible b) -> b.name()).filter(Bible::name, "Search built-ins…");
		builtinList.items(cards.values().stream().map(StyleCatalog.Card::bible).filter(Bible::builtin).toList());
		builtinList.onActivate(b -> {
			menu = null;
			openEditor(b, false);
		});
		LinkedHashSet<String> tags = new LinkedHashSet<>();
		cards.values().forEach(c -> tags.addAll(c.bible().tags()));
		tagList = ScrollList.text((String t) -> t).filter(t -> t, "Search tags…");
		tagList.items(new ArrayList<>(tags));
		tagList.onActivate(t -> {
			menu = null;
			setQuery(t);
		});
		compareChip().label("+ New style ▾");
		tagsChip().label("Tags ▾");
	}

	/** Every Style as a card (the helper's, plus the built-in ones it didn't send), {@code current} selected. */
	public static StyleBrowserScreen create(@Nullable String current, @Nullable Screen parent, Consumer<Bible> use) {
		List<Bible> all = StyleCatalog.withBuiltins(SetFeature.bibles(), LibraryFeature.palettes());
		List<StyleCatalog.Card> list = StyleCatalog.cards(all, StyleCatalog.usage(LibraryFeature.cards()), current, id -> all.stream().filter(b -> b.id()
			.equals(id)).map(Bible::name).findFirst().orElse(null));
		Map<String, StyleCatalog.Card> byId = new LinkedHashMap<>();
		List<PickerEntry> entries = new ArrayList<>();
		for (StyleCatalog.Card c : list) {
			byId.put(c.id(), c);
			entries.add(StylePaint.styleEntry(c));
		}
		long yours = list.stream().filter(c -> c.rail().equals(StyleCatalog.YOURS)).count();
		@Nullable StyleBrowserScreen[] self = new StyleBrowserScreen[1];
		PickerSpec spec = PickerSpec.of(ID, "Choose a style", entries).layout(PickerSpec.Layout.CARDS).groupOrder(StyleCatalog.RAIL).noun("styles")
			.pickLabel("Use this style").current(current).subtitle(list.size() + " styles · " + yours + " yours").onPick(e -> self[0].picked(e))
			// lab-ui's Compare and Tags chips are enabled by their hooks (read when the screen is made): "+ New style ▾" and "Tags ▾"
			.onCompare(s -> ((StyleBrowserScreen) s).toggleMenu(Menu.NEW)).onTags(s -> ((StyleBrowserScreen) s).toggleMenu(Menu.TAGS));
		self[0] = new StyleBrowserScreen(spec, byId, parent, use);
		return self[0];
	}

	private void picked(PickerEntry e) {
		StyleCatalog.Card c = cards.get(e.id());
		if (gridClick) {
			// a single click selects (lab-ui's grid picks on click): keep the recents and the current as they were
			stay = true;
			clickSelected = true;
			model().select(e.id());
			return;
		}
		if (c != null) {
			use.accept(c.bible());
		}
	}

	@Override
	public void back() {
		if (stay) {
			stay = false;
			return;
		}
		super.back();
	}

	/** The Style the detail pane and the buttons act on: the selection, else the current one. */
	public StyleCatalog.@Nullable Card selectedCard() {
		PickerEntry s = model().selected();
		String id = s != null ? s.id() : spec().current();
		return id == null ? null : cards.get(id);
	}

	public List<StyleCatalog.Card> cards() {
		return List.copyOf(cards.values());
	}

	/** Selects a card without using it (DevBridge). */
	public boolean select(String id) {
		if (!cards.containsKey(id)) {
			return false;
		}
		model().select(id);
		return true;
	}

	/** Uses the selected card (as "Use this style"). */
	public void useSelected() {
		StyleCatalog.Card c = selectedCard();
		if (c != null) {
			PickerStore.used(ID, c.id());
			use.accept(c.bible());
			super.back();
		}
	}

	public void duplicateSelected() {
		StyleCatalog.Card c = selectedCard();
		if (c != null) {
			openEditor(c.bible(), false);
		}
	}

	public void editSelected() {
		StyleCatalog.Card c = selectedCard();
		if (c != null && c.canEdit()) {
			openEditor(c.bible(), true);
		}
	}

	/** Opens the Style editor on {@code b}: a new version of it ({@code edit}), else a copy. Back returns here. */
	void openEditor(Bible b, boolean edit) {
		menu = null;
		try {
			minecraft.gui.setScreen(StyleEditorScreen.open(b, edit, this));
		} catch (IllegalArgumentException ex) {
			message = ex.getMessage();
		}
	}

	public void toggleMenu(Menu m) {
		menu = menu == m ? null : m;
	}

	/** The "+ New style" menu by name (DevBridge): new, builtin, tags; or null to close it. */
	public void menu(@Nullable String which) {
		menu = which == null ? null : Menu.valueOf(which.toUpperCase(java.util.Locale.ROOT));
	}

	public @Nullable String menuOpen() {
		return menu == null ? null : menu.name().toLowerCase(java.util.Locale.ROOT);
	}

	/** "Describe it": the screen where Claude drafts a Style (a bible job). */
	public void describe() {
		menu = null;
		minecraft.gui.setScreen(new DescribeStyleScreen(this));
	}

	// ------------------------------------------------------------------ drawing

	/** The detail pane's x, inner width and the y of its "Use this style" row, as PickerScreen lays it out. */
	private int[] detailGeometry() {
		int ix = 8;
		int iw = width - 16;
		int detailW = Math.max(104, Math.min(200, iw * 26 / 100));
		int x = ix + iw - detailW;
		int pad = 6;
		int cw = detailW - pad * 2;
		int by = height - 8 - pad - Button.H;
		boolean fav = selectedCard() != null && model().isFavourite(selectedCard().id());
		boolean stack = Button.width(font, spec().pickLabel()) + Button.width(font, fav ? "★ Unfavourite" : "☆ Favourite") + 4 > cw;
		int pickTop = stack ? by - Button.H - 4 : by;
		return new int[] {x + pad, cw, pickTop, detailW};
	}

	/** The grid's x range and its top, as PickerScreen lays it out (for "a click on a card selects it"). */
	private int[] gridGeometry() {
		int ix = 8;
		int iw = width - 16;
		int railW = Math.max(70, Math.min(130, iw / 6));
		int detailW = Math.max(104, Math.min(200, iw * 26 / 100));
		int gridX = ix + railW + 1;
		int gridW = iw - railW - detailW - 2;
		int mainY = 8 + TITLE_H + TextFieldView.BASE_H + ROW_GAP * 2 + Chip.H + ROW_GAP;
		return new int[] {gridX, gridX + gridW, mainY};
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float a) {
		if (U3Dev.park) {
			mx = -1000;
			my = -1000;
		}
		super.extractRenderState(g, mx, my, a);
		StyleCatalog.Card c = selectedCard();
		int[] d = detailGeometry();
		int ew = Button.width(font, "Edit");
		int dw = Button.width(font, "Duplicate");
		// a narrow pane: Duplicate and Edit each on a row of its own (whole words, never "Duplic…")
		boolean stack = dw + 4 + ew > d[1];
		int rowTop = d[2] - Button.H - 4;
		int top = stack ? rowTop - Button.H - 4 : rowTop;
		g.nextStratum();
		// Duplicate / Edit above "Use this style": a band of the pane's paper first, from a line boundary of the pane's detail lines
		// (PickerScreen's layout: the big sheet, the name, the subtitle, then lines 10 px apart), so no line is cut in half under them
		int[] gg = gridGeometry();
		int paneH = height - 8 - gg[2];
		int first = gg[2] + 6 + Math.min(60, paneH / 3) + 5 + 10 + 10 + 2;
		int band = top - 3;
		if (band > first) {
			band = first + (band - first) / 10 * 10;
		}
		g.fill(d[0] - 6, band, d[0] - 6 + d[3] - 1, d[2] - 1, UiStyle.CREAM);
		if (c != null) {
			edit.disabled(!c.canEdit()).tooltip(c.canEdit() ? null : c.bible().builtin() ? "Built-in: duplicate it to make your own"
				: "Owned by a mod: duplicate it to make your own");
			if (stack) {
				duplicate.draw(g, font, d[0], top, d[1], Button.H, mx, my);
				edit.draw(g, font, d[0], rowTop, d[1], Button.H, mx, my);
			} else {
				duplicate.draw(g, font, d[0], rowTop, dw, Button.H, mx, my);
				edit.draw(g, font, d[0] + dw + 4, rowTop, ew, Button.H, mx, my);
			}
			if (!c.canEdit() && edit.contains(mx, my)) {
				dev.larattalabs.labui.client.widget.Tooltip.render(g, font, edit.tooltip(), mx, my);
			}
		} else {
			duplicate.hide();
			edit.hide();
		}
		if (message != null) {
			g.text(font, TextUtil.ellipsize(font, message, d[3] - 12), d[0], band - 11, UiStyle.error(), false);
		}
		drawMenu(g, mx, my);
	}

	private void drawMenu(GuiGraphicsExtractor g, int mx, int my) {
		menuButtons.clear();
		if (menu == null) {
			menuRect = new int[4];
			return;
		}
		Chip anchor = menu == Menu.TAGS ? tagsChip() : compareChip();
		int w = Math.min(width - 16, menu == Menu.NEW ? 200 : 170);
		int x = Math.max(8, Math.min(anchor.x() + anchor.width() - w, width - 8 - w));
		int y = anchor.y() + Chip.H + 2;
		g.nextStratum();
		if (menu == Menu.NEW) {
			StyleCatalog.Card c = selectedCard();
			String[][] items = {{"copy", c == null ? "Copy the selected style" : "Copy " + c.bible().name(), "free"}, {"builtin", "Start from a built-in…",
				"free"}, {"describe", "Describe it (Claude drafts it)…", Claude.costHint()}};
			int h = items.length * 30 + 8;
			menuRect = new int[] {x, y, w, h};
			Panels.framed(g, x - 2, y - 2, w + 4, h + 4);
			g.fill(x, y, x + w, y + h, UiStyle.CREAM);
			int yy = y + 4;
			for (String[] it : items) {
				Button b = new Button(it[1], () -> menuPick(it[0]));
				b.disabled(it[0].equals("copy") && c == null);
				b.draw(g, font, x + 4, yy, w - 8, Button.H, mx, my);
				menuButtons.add(b);
				g.text(font, TextUtil.ellipsize(font, it[2], w - 12), x + 6, yy + Button.H + 1, UiStyle.mutedText(), false);
				yy += 30;
			}
		} else {
			ScrollList<?> list = menu == Menu.BUILTIN ? builtinList : tagList;
			int rows = Math.max(3, Math.min(8, (height - y - 16 - TextFieldView.BASE_H) / ScrollList.ROW_H));
			int lh = list.heightFor(rows);
			int h = lh + 8;
			menuRect = new int[] {x, y, w, h};
			Panels.framed(g, x - 2, y - 2, w + 4, h + 4);
			g.fill(x, y, x + w, y + h, UiStyle.CREAM);
			list.focused(true);
			list.draw(g, font, x + 4, y + 4, w - 8, lh, mx, my);
		}
	}

	private void menuPick(String id) {
		switch (id) {
			case "copy" -> duplicateSelected();
			case "builtin" -> menu = Menu.BUILTIN;
			case "describe" -> describe();
			default -> {
			}
		}
	}

	/** The "+ New style" menu's items by id (DevBridge): copy, builtin, describe. */
	public void menuItem(String id) {
		menuPick(id);
	}

	/** Starts a copy of the built-in {@code id} (the "Start from a built-in…" list, DevBridge). */
	public boolean fromBuiltin(String id) {
		StyleCatalog.Card c = cards.get(id);
		if (c == null || !c.bible().builtin()) {
			return false;
		}
		openEditor(c.bible(), false);
		return true;
	}

	// ------------------------------------------------------------------ input

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean doubleClick) {
		message = null;
		double mx = e.x();
		double my = e.y();
		if (menu != null) {
			boolean inside = mx >= menuRect[0] && mx < menuRect[0] + menuRect[2] && my >= menuRect[1] && my < menuRect[1] + menuRect[3];
			if (inside) {
				for (Button b : List.copyOf(menuButtons)) {
					if (b.mouseClicked(mx, my, e.button())) {
						return true;
					}
				}
				ScrollList<?> list = menu == Menu.BUILTIN ? builtinList : menu == Menu.TAGS ? tagList : null;
				if (list != null) {
					list.mouseClicked(mx, my, e.button());
				}
				return true;
			}
			if (!compareChip().contains(mx, my) && !tagsChip().contains(mx, my)) {
				menu = null;
				return true;
			}
		}
		if (duplicate.mouseClicked(mx, my, e.button()) || edit.mouseClicked(mx, my, e.button())) {
			return true;
		}
		int[] gg = gridGeometry();
		gridClick = !doubleClick && mx >= gg[0] && mx < gg[1] - 9 && my >= gg[2];
		List<String> recents = List.copyOf(PickerStore.memory().recents(ID));
		String current = spec().current();
		try {
			return super.mouseClicked(e, doubleClick);
		} finally {
			gridClick = false;
			stay = false;
			if (clickSelected) {
				// selecting is not using: the recents and the current one stay as they were
				clickSelected = false;
				spec().current(current);
				for (String r : PickerStore.memory().recents(ID)) {
					if (!recents.contains(r)) {
						PickerStore.memory().forget(ID, r);
					}
				}
				for (int i = recents.size() - 1; i >= 0; i--) {
					PickerStore.memory().used(ID, recents.get(i));
				}
				PickerStore.save();
			}
		}
	}

	@Override
	public boolean mouseScrolled(double mx, double my, double sx, double sy) {
		if (menu == Menu.BUILTIN && builtinList.mouseScrolled(mx, my, sy) || menu == Menu.TAGS && tagList.mouseScrolled(mx, my, sy)) {
			return true;
		}
		return super.mouseScrolled(mx, my, sx, sy);
	}

	@Override
	public boolean keyPressed(KeyEvent e) {
		if (menu != null) {
			if (e.isEscape()) {
				menu = null;
				return true;
			}
			ScrollList<?> list = menu == Menu.BUILTIN ? builtinList : menu == Menu.TAGS ? tagList : null;
			if (list != null && list.keyPressed(e)) {
				return true;
			}
		}
		return super.keyPressed(e);
	}

	@Override
	public boolean charTyped(CharacterEvent e) {
		ScrollList<?> list = menu == Menu.BUILTIN ? builtinList : menu == Menu.TAGS ? tagList : null;
		if (list != null) {
			return list.charTyped(e) || true;
		}
		return super.charTyped(e);
	}

	/** What the browser shows (DevBridge). */
	public com.google.gson.JsonObject stateJson() {
		com.google.gson.JsonObject o = new com.google.gson.JsonObject();
		o.addProperty("screen", "style_browser");
		o.addProperty("debug", debugState());
		StyleCatalog.Card c = selectedCard();
		o.addProperty("selected", c == null ? null : c.id());
		o.addProperty("current", spec().current());
		o.addProperty("menu", menuOpen());
		o.addProperty("canEdit", c != null && c.canEdit());
		o.addProperty("message", message);
		com.google.gson.JsonArray details = new com.google.gson.JsonArray();
		if (c != null) {
			c.details().forEach(details::add);
			o.addProperty("rail", c.rail());
		}
		o.add("details", details);
		com.google.gson.JsonArray all = new com.google.gson.JsonArray();
		for (StyleCatalog.Card k : cards.values()) {
			com.google.gson.JsonObject j = new com.google.gson.JsonObject();
			j.addProperty("id", k.id());
			j.addProperty("name", k.bible().name());
			j.addProperty("rail", k.rail());
			j.addProperty("usedBy", k.usedBy());
			j.addProperty("canEdit", k.canEdit());
			all.add(j);
		}
		o.add("cards", all);
		return o;
	}

	/** Cost hints for "describe it" (the helper's estimate, else the contract's ballpark). */
	static final class Claude {
		private Claude() {
		}

		static String costHint() {
			return DescribeStyleScreen.costLine();
		}
	}

	/** A fresh browser (the Styles as they are now) with the same parent and use, {@code id} selected. */
	StyleBrowserScreen reopen(String id) {
		StyleBrowserScreen b = create(spec().current(), parent(), use);
		b.select(id);
		return b;
	}

	static void open(@Nullable String current, Consumer<Bible> use) {
		Minecraft mc = Minecraft.getInstance();
		mc.gui.setScreen(create(current, mc.gui.screen(), use));
	}
}
