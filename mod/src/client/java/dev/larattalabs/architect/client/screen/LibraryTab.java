package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.client.design.DesignFeature;
import dev.larattalabs.architect.client.design.PreviewImages;
import dev.larattalabs.labui.client.hud.UiBits;
import dev.larattalabs.architect.client.library.LibraryFeature;
import dev.larattalabs.architect.client.placement.BlueprintPreview;
import dev.larattalabs.architect.client.placement.PlacementFeature;
import dev.larattalabs.architect.client.screen.ArchitectScreen.Focus;
import dev.larattalabs.architect.client.screen.ArchitectScreen.Hit;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.labui.client.text.TextFieldView;
import dev.larattalabs.labui.client.text.TextModel;
import dev.larattalabs.labui.client.ui.Kit;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.architect.library.Exchange;
import dev.larattalabs.architect.library.LibraryCard;
import dev.larattalabs.architect.library.LibraryMeta;
import dev.larattalabs.architect.library.LibraryQuery;
import dev.larattalabs.architect.library.Palettes;
import dev.larattalabs.architect.library.VariantForm;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * The Library tab's designs view (docs/CONTRACT.md "Mod: library screen"): search, filters (type, user tag, favourites)
 * and sort over a grid of cards, the detail panel of the selected card with its actions, and the two dialogs that take
 * the tab's body while open: <b>Variants…</b> (palette presets + advanced dropdowns, parameter controls, "Make variant")
 * and <b>Import…</b> (the {@code .nbt} and, since 6c SCH, {@code .schem} files to import). Drawn by {@link ArchitectScreen} into its hit list; actions are
 * {@link LibraryFeature}'s. Client thread.
 */
final class LibraryTab {
	enum Dialog {
		NONE, VARIANTS, IMPORT
	}

	/** Which inline edit the detail panel shows. */
	enum Edit {
		NONE, RENAME, TAGS
	}

	static final int CARD_MIN_W = 84;
	/** (U3) a shorter card: more rows of designs in the same grid. */
	static final int CARD_H = 70;
	static final int GAP = 5;
	static final List<String> VIEW_KINDS = List.of("iso", "top", "front", "cutaway");
	private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.ROOT).withZone(ZoneId.systemDefault());
	private static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("d MMM", Locale.ROOT).withZone(ZoneId.systemDefault());

	/** "4 Oct" this year, "4 Oct 2025" before. */
	static String date(long ms) {
		Instant t = Instant.ofEpochMilli(ms);
		int year = t.atZone(ZoneId.systemDefault()).getYear();
		return (year == java.time.Year.now().getValue() ? DAY : DATE).format(t);
	}

	static Dialog dialog = Dialog.NONE;
	static String previewKind = "iso";
	static int importSel = -1;

	final TextModel search = new TextModel(60);
	final TextModel rename = new TextModel(LibraryMeta.MAX_NAME);
	final TextModel tags = new TextModel(200);
	final TextModel variantName = new TextModel(40);
	/** (U3) The Import dialog's search. */
	final TextModel importFilter = new TextModel(60);
	final TextFieldView importFilterView = new TextFieldView();
	final TextFieldView searchView = new TextFieldView();
	final TextFieldView renameView = new TextFieldView();
	final TextFieldView tagsView = new TextFieldView();
	final TextFieldView variantNameView = new TextFieldView();
	Edit edit = Edit.NONE;
	@Nullable String editing;
	private @Nullable String armedDelete;
	private long armedAt;
	private final ArchitectScreen s;

	LibraryTab(ArchitectScreen s) {
		this.s = s;
		search.set(LibraryFeature.query().text());
	}

	private Font font() {
		return s.font();
	}

	// ------------------------------------------------------------------ text fields

	@Nullable TextModel model(Focus f) {
		return switch (f) {
			case SEARCH -> search;
			case RENAME -> rename;
			case TAGS -> tags;
			case VNAME -> variantName;
			case IMPORT_FILTER -> importFilter;
			default -> null;
		};
	}

	/** After a keystroke in a library field. */
	void edited(Focus f) {
		if (f == Focus.SEARCH) {
			LibraryFeature.setQuery(LibraryFeature.query().withText(search.value()));
			s.resetScroll();
		} else if (f == Focus.VNAME && LibraryFeature.variantForm() != null) {
			LibraryFeature.variantForm().setName(variantName.value());
		}
	}

	/** Enter in a library field: Rename and Tags save. Returns whether it was handled. */
	boolean enter(Focus f) {
		if (f == Focus.RENAME || f == Focus.TAGS) {
			commitEdit();
			return true;
		}
		return false;
	}

	/** Esc in a library field or dialog: cancels an edit, else closes a dialog. Returns whether it was handled. */
	boolean escape() {
		if (closeMenu()) {
			return true;
		}
		if (edit != Edit.NONE) {
			cancelEdit();
			return true;
		}
		if (dialog != Dialog.NONE) {
			closeDialog();
			return true;
		}
		return false;
	}

	void startEdit(Edit e, LibraryCard c) {
		edit = e;
		editing = c.id();
		if (e == Edit.RENAME) {
			rename.set(c.name());
			rename.selectAll();
			s.setFocusPublic(Focus.RENAME);
		} else {
			tags.set(String.join(", ", c.userTags()));
			tags.moveTo(tags.length(), false);
			s.setFocusPublic(Focus.TAGS);
		}
	}

	void commitEdit() {
		String id = editing;
		Edit e = edit;
		edit = Edit.NONE;
		editing = null;
		s.setFocusPublic(Focus.NONE);
		if (id == null) {
			return;
		}
		if (e == Edit.RENAME) {
			LibraryFeature.rename(id, rename.value());
		} else if (e == Edit.TAGS) {
			LibraryFeature.setTags(id, LibraryMeta.parseTags(tags.value()));
		}
	}

	void cancelEdit() {
		edit = Edit.NONE;
		editing = null;
		s.setFocusPublic(Focus.NONE);
	}

	// ------------------------------------------------------------------ actions

	void openVariants(String id) {
		try {
			LibraryFeature.openVariants(id);
			variantName.clear();
			cancelEdit();
			dialog = Dialog.VARIANTS;
			s.resetScroll();
		} catch (IllegalArgumentException ex) {
			LibraryFeature.say("No variants: " + ex.getMessage(), true);
		}
	}

	void openImport() {
		cancelEdit();
		LibraryFeature.refreshImports();
		importSel = LibraryFeature.importList().isEmpty() ? -1 : 0;
		dialog = Dialog.IMPORT;
		s.resetScroll();
	}

	void closeDialog() {
		if (dialog == Dialog.VARIANTS) {
			LibraryFeature.closeVariants();
		}
		dialog = Dialog.NONE;
		s.setFocusPublic(Focus.NONE);
		s.closePopup();
		s.resetScroll();
	}

	void submitVariant() {
		s.setFocusPublic(Focus.NONE);
		LibraryFeature.submitVariant().whenComplete((id, err) -> {
			if (err == null) {
				dialog = Dialog.NONE;
				LibraryFeature.closeVariants();
				s.showJob(id);
			}
		});
	}

	void importPick(int index) {
		List<Exchange.Candidate> l = LibraryFeature.importList();
		if (index < 0 || index >= l.size()) {
			return;
		}
		LibraryFeature.importFile(l.get(index).path()).whenComplete((id, err) -> {
			if (err == null) {
				dialog = Dialog.NONE;
				s.showJob(id);
			}
		});
	}

	void delete(LibraryCard c) {
		long now = Util.getMillis();
		if (!c.id().equals(armedDelete) || now - armedAt > 6000) {
			armedDelete = c.id();
			armedAt = now;
			LibraryFeature.say("Delete " + c.name() + "? Click Delete again to move it to architect/library-trash", true);
			return;
		}
		armedDelete = null;
		LibraryFeature.delete(c.id());
	}

	boolean deleteArmed(String id) {
		return id.equals(armedDelete) && Util.getMillis() - armedAt < 6000;
	}

	void place(String id) {
		String why = PlacementFeature.placeNow(id);
		LibraryFeature.say(why, why != null);
	}

	void placeOnPlot(String id) {
		String why = DesignFeature.placeOnPlot(id);
		LibraryFeature.say(why, why != null);
	}

	// ------------------------------------------------------------------ drawing: designs view

	/** The designs view below the Designs/Placed chips row: x..x+w, top..footerY. */
	void draw(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my, int chipsRight) {
		if (dialog == Dialog.VARIANTS && LibraryFeature.variantForm() != null) {
			// (Style unification U3) the unified design editor, VARIANT mode
			s.editor.drawVariant(g, x, top, w, footerY, mx, my, this);
			return;
		}
		if (dialog == Dialog.IMPORT) {
			drawImport(g, x, top, w, footerY, mx, my);
			return;
		}
		dialog = Dialog.NONE;
		Font font = font();
		int detailW = Math.max(200, Math.min(250, w * 2 / 5));
		int gridW = w - detailW - 12;
		int gx = x;
		// search, right of the Designs/Placed chips
		// (U3) at a narrow width (GUI scale 4) the search keeps to the room the chips leave, and the filters get short labels
		boolean narrow = gridW < 330;
		int sw = Math.max(56, gx + gridW - chipsRight - 6);
		int sx = gx + gridW - sw;
		s.textField(g, Focus.SEARCH, searchView, search, sx, top - 3, sw, new TextFieldView.Style(null, 0, "search name, tags, text…", null, null, 0, 1));
		// filters row
		int fy = top + 19;
		LibraryQuery q = LibraryFeature.query();
		List<LibraryCard> all = LibraryFeature.cards();
		int cx = gx;
		String typeLabel = narrow ? (q.type() == null ? "Type" : q.type()) + " ▾" : "Type: " + (q.type() == null ? "all" : q.type()) + " ▾";
		cx += s.chip(g, "filter:type", typeLabel, cx, fy, q.type() != null, true, mx, my, () -> {
			List<ArchitectScreen.Option> opts = new ArrayList<>();
			opts.add(new ArchitectScreen.Option("all", "All types", q.type() == null));
			for (String t : LibraryQuery.types(all)) {
				opts.add(new ArchitectScreen.Option(t, t, t.equals(LibraryFeature.query().type())));
			}
			s.openPopup("type", gx, fy + 16, 180, opts, v -> {
				LibraryFeature.setQuery(LibraryFeature.query().withType("all".equals(v) ? null : v));
				s.resetScroll();
			});
		}) + 3;
		List<String> userTags = LibraryQuery.userTags(all);
		String tagLabel = narrow ? (q.tag() == null ? "Tag" : "#" + q.tag()) + " ▾" : "Tag: " + (q.tag() == null ? "all" : q.tag()) + " ▾";
		int tagX = cx;
		cx += s.chip(g, "filter:tag", tagLabel, cx, fy, q.tag() != null, !userTags.isEmpty() || q.tag() != null, mx, my, () -> {
			List<ArchitectScreen.Option> opts = new ArrayList<>();
			opts.add(new ArchitectScreen.Option("all", "All tags", q.tag() == null));
			for (String t : userTags) {
				opts.add(new ArchitectScreen.Option(t, "#" + t, t.equals(LibraryFeature.query().tag())));
			}
			s.openPopup("tag", tagX, fy + 16, 180, opts, v -> {
				LibraryFeature.setQuery(LibraryFeature.query().withTag("all".equals(v) ? null : v));
				s.resetScroll();
			});
		}) + 3;
		cx += s.chip(g, "filter:favorites", narrow ? "★" : "★ Starred", cx, fy, q.favoritesOnly(), true, mx, my, () -> {
			LibraryFeature.setQuery(LibraryFeature.query().withFavoritesOnly(!LibraryFeature.query().favoritesOnly()));
			s.resetScroll();
		}) + 3;
		// collections (phase 4b, R10): the entries of one bible or one design set
		List<LibraryQuery.CollectionInfo> cols = LibraryQuery.collections(all);
		String colLabel = TextUtil.ellipsize(font, q.collection() == null ? narrow ? "Coll. ▾" : "Collection ▾" : collectionName(q.collection()) + " ▾", narrow ? 56 : 78);
		int colX = cx;
		cx += s.chip(g, "filter:collection", colLabel, cx, fy, q.collection() != null, !cols.isEmpty() || q.collection() != null, mx, my, () -> {
			List<ArchitectScreen.Option> opts = new ArrayList<>();
			opts.add(new ArchitectScreen.Option("all", "All entries", LibraryFeature.query().collection() == null));
			for (LibraryQuery.CollectionInfo c : cols) {
				opts.add(new ArchitectScreen.Option(c.key(), collectionName(c.key()) + " (" + c.count() + ")", c.key().equals(LibraryFeature.query()
					.collection())));
			}
			s.openPopup("collection", colX, fy + 16, 260, opts, v -> {
				LibraryFeature.setQuery(LibraryFeature.query().withCollection("all".equals(v) ? null : v));
				s.resetScroll();
			});
		}) + 3;
		// sort chips, right-aligned in the grid column
		int sortW = 0;
		for (LibraryQuery.Sort so : LibraryQuery.Sort.values()) {
			sortW += font.width(so.label()) + 12 + 2;
		}
		if (cx + 4 + sortW <= gx + gridW + 2) {
			int sortX = gx + gridW - sortW + 2;
			for (LibraryQuery.Sort so : LibraryQuery.Sort.values()) {
				sortX += s.chip(g, "sort:" + so.id(), so.label(), sortX, fy, q.sort() == so, true, mx, my, () -> LibraryFeature.setQuery(LibraryFeature
					.query().withSort(so))) + 2;
			}
		} else {
			// no room for three chips (a collection is picked): one that opens the sort choices
			String sl = narrow ? "↕ ▾" : "↕ " + q.sort().label() + " ▾";
			int sw0 = font.width(sl) + 12;
			int sortX = Math.max(cx + 2, gx + gridW - sw0);
			s.chip(g, "sort", sl, sortX, fy, false, true, mx, my, () -> {
				List<ArchitectScreen.Option> opts = new ArrayList<>();
				for (LibraryQuery.Sort so : LibraryQuery.Sort.values()) {
					opts.add(new ArchitectScreen.Option(so.id(), so.label(), LibraryFeature.query().sort() == so));
				}
				s.openPopup("sort", sortX, fy + 16, 160, opts, v -> LibraryFeature.setQuery(LibraryFeature.query().withSort(LibraryQuery.Sort.of(v))));
			});
		}
		// grid (under the collection's header when one is picked)
		int gy = fy + 19;
		if (q.collection() != null) {
			gy = drawCollectionHeader(g, q.collection(), gx, gy, gridW, mx, my) + 3;
		}
		// (U3) the jobs strip: what is being made, and a massing to approve, by mouse
		int stripH = JobStrip.height();
		int bottom = footerY - 16 - (stripH > 0 ? stripH + 3 : 0);
		if (stripH > 0) {
			JobStrip.draw(s, g, x, bottom + 3, w, mx, my);
		}
		int gh = bottom - gy;
		drawGrid(g, gx, gy, gridW, gh, mx, my);
		// detail
		drawDetail(g, x + gridW + 12, top - 3, detailW, bottom - (top - 3), mx, my);
		// the ⋯ menu over everything the tab draws after this (the footer included)
		s.late(gg -> drawMenu(gg, mx, my));
	}

	/** "Ashfall" for {@code bible:<id>}, "Set: Ashfall hamlet" for {@code group:<id>}. */
	static String collectionName(String key) {
		if (key.startsWith(LibraryQuery.BIBLE_PREFIX)) {
			String id = key.substring(LibraryQuery.BIBLE_PREFIX.length());
			return "Bible: " + dev.larattalabs.architect.client.design.SetFeature.bible(id).map(dev.larattalabs.architect.api.Bible::name).orElse(id);
		}
		String id = key.substring(LibraryQuery.GROUP_PREFIX.length());
		com.google.gson.JsonObject gr = Sidecar.state().group(id);
		return "Set: " + (gr != null && gr.has("name") ? gr.get("name").getAsString() : id);
	}

	/** The bible of a collection: the bible itself, or the set's (from the helper, else its entries). */
	static @Nullable String collectionBible(String key) {
		if (key.startsWith(LibraryQuery.BIBLE_PREFIX)) {
			return key.substring(LibraryQuery.BIBLE_PREFIX.length());
		}
		String id = key.substring(LibraryQuery.GROUP_PREFIX.length());
		com.google.gson.JsonObject gr = Sidecar.state().group(id);
		if (gr != null && gr.has("bible") && gr.get("bible").isJsonObject()) {
			return gr.getAsJsonObject("bible").get("id").getAsString();
		}
		for (LibraryCard c : LibraryFeature.cards()) {
			if (id.equals(c.group()) && c.bible() != null) {
				return c.bible();
			}
		}
		return null;
	}

	/**
	 * The collection header (R10): the bible's sample sheet, the collection's name and size, the bible's roles as block icons,
	 * "Re-skin collection…" (pick another bible: a variant of every entry with its roles, free) and a way out of the filter.
	 * Returns its bottom.
	 */
	private int drawCollectionHeader(GuiGraphicsExtractor g, String key, int x, int y, int w, int mx, int my) {
		Font font = font();
		int h = 44;
		Panels.inset(g, x, y, w, h);
		String bibleId = collectionBible(key);
		dev.larattalabs.architect.api.Bible bible = bibleId == null ? null : dev.larattalabs.architect.client.design.SetFeature.bible(bibleId).orElse(null);
		int tx = x + 4;
		PreviewImages.Found sheet = bible == null ? null : RolesSwatch.sheet(bible);
		if (sheet != null) {
			g.fill(x + 2, y + 2, x + 2 + 78, y + h - 2, 0x22FFFFFF);
			PreviewImages.draw(g, sheet, x + 3, y + 3, 76, h - 6);
			tx = x + 84;
		}
		long n = LibraryFeature.cards().stream().filter(c -> c.collections().contains(key)).count();
		String title = collectionName(key) + " · " + n + (n == 1 ? " entry" : " entries");
		String go = "Re-skin…";
		int gw = s.bw(go);
		int clearW = font.width("×") + 12;
		int textW = x + w - 4 - gw - 4 - clearW - 4 - tx;
		g.text(font, TextUtil.ellipsize(font, title, textW), tx, y + 4, UiBits.ink(), false);
		String sub = bible == null ? "bible unknown (not installed here)" : (bible.builtin() ? "built-in bible" : "bible v" + bible.version() + (bible
			.versions().size() > 1 ? " of " + bible.versions().size() : "")) + " · " + bible.roles().size() + " roles";
		if (key.startsWith(LibraryQuery.GROUP_PREFIX) && bible != null) {
			sub = bible.name() + " · " + sub;
		}
		g.text(font, TextUtil.ellipsize(font, sub, textW), tx, y + 14, UiBits.muted(), false);
		if (bible != null) {
			RolesSwatch.draw(g, bible, tx, y + h - 19, x + w - 4 - tx);
		}
		int bx = x + w - 4 - clearW - 4 - gw;
		String cur = bibleId;
		s.button(g, "collection:reskin", go, bx, y + 3, gw, false, dev.larattalabs.architect.client.design.SetFeature.has("reskin") && n > 0, mx, my,
			() -> {
				List<ArchitectScreen.Option> opts = new ArrayList<>();
				for (var b : dev.larattalabs.architect.client.design.SetFeature.bibles()) {
					// (5a) archived bibles are hidden from the pickers
					if (!b.id().equals(cur) && !b.archived()) {
						opts.add(new ArchitectScreen.Option(b.id(), b.builtin() ? b.name() : b.name() + " v" + b.version(), false));
					}
				}
				s.openPopup("reskin", bx - 150, y + 24, Math.max(240, gw + 150), opts, v -> dev.larattalabs.architect.client.design.SetFeature.reskin(key, v)
					.whenComplete((id, err) -> LibraryFeature.say(dev.larattalabs.architect.client.design.SetFeature.message(),
						dev.larattalabs.architect.client.design.SetFeature.messageError())));
			});
		s.chip(g, "collection:clear", "×", x + w - 4 - clearW, y + 6, false, true, mx, my, () -> {
			LibraryFeature.setQuery(LibraryFeature.query().withCollection(null));
			s.resetScroll();
		});
		return y + h;
	}

	private void drawGrid(GuiGraphicsExtractor g, int x, int y, int w, int h, int mx, int my) {
		Font font = font();
		Panels.inset(g, x, y, w, h);
		List<LibraryCard> cards = LibraryFeature.visible();
		LibraryCard sel = LibraryFeature.selected();
		int inner = w - 8 - 6; // padding + scrollbar room
		int cols = Math.max(1, (inner + GAP) / (CARD_MIN_W + GAP));
		int cw = (inner - (cols - 1) * GAP) / cols;
		int rows = (cards.size() + cols - 1) / cols;
		int needed = rows * (CARD_H + GAP) + 4;
		s.setScrollArea(x, y, w - 6, h, needed, CARD_H + GAP);
		int scroll = s.scroll();
		g.enableScissor(x + 1, y + 1, x + w - 1, y + h - 1);
		for (int i = 0; i < cards.size(); i++) {
			LibraryCard c = cards.get(i);
			int cx = x + 4 + (i % cols) * (cw + GAP);
			int cy = y + 4 + (i / cols) * (CARD_H + GAP) - scroll;
			if (cy + CARD_H < y || cy > y + h) {
				continue;
			}
			drawCard(g, c, cx, cy, cw, y, y + h, c == sel || sel != null && sel.id().equals(c.id()), mx, my);
		}
		g.disableScissor();
		s.scrollbarAt(g, x + w - 7, y + 1, h - 2);
		if (cards.isEmpty()) {
			// (U3) no dead ends: every empty state has an action
			boolean none = LibraryFeature.cards().isEmpty();
			dev.larattalabs.labui.client.widget.EmptyState es = new dev.larattalabs.labui.client.widget.EmptyState(none
				? "No designs yet: describe one and Claude designs it, or import a structure." : "Nothing matches the search and filters.");
			es.action(none ? "Design one" : "Clear filters", none ? () -> s.setTab(ArchitectScreen.Tab.DESIGN) : () -> {
				search.clear();
				LibraryFeature.setQuery(new LibraryQuery(null, null, false, "", LibraryFeature.query().sort(), null));
				s.resetScroll();
			});
			es.draw(g, font, x, y, w, h, mx, my);
			if (es.actionButton() != null) {
				s.control("library:empty_action", es.actionButton().label(), es.actionButton(), false);
			}
		}
	}

	private void drawCard(GuiGraphicsExtractor g, LibraryCard c, int x, int y, int w, int clipTop, int clipBottom, boolean selected, int mx, int my) {
		Font font = font();
		int hy = Math.max(y, clipTop);
		int hh = Math.min(y + CARD_H, clipBottom) - hy;
		boolean hover = mx >= x && mx < x + w && my >= hy && my < hy + hh;
		// star first: it takes the click before the card does
		int starX = x + w - 13;
		int starY = y + 3;
		if (hh > 0 && starY >= clipTop && starY + 11 <= clipBottom) {
			s.addHit(new Hit("fav:" + c.id(), c.favorite() ? "Unstar" : "Star", starX, starY, 11, 11, true, c.favorite(),
				() -> LibraryFeature.setFavorite(c.id(), !c.favorite())));
		}
		if (hh > 0) {
			s.addHit(new Hit("card:" + c.id(), c.name(), x, hy, w, hh, true, selected, () -> {
				LibraryFeature.select(c.id());
				cancelEdit();
			}));
		}
		g.fill(x, y, x + w, y + CARD_H, selected ? 0x30D97757 : hover ? 0x16000000 : 0x0C000000);
		int border = selected ? UiStyle.CLAY_DARK : 0x26000000;
		g.fill(x, y, x + w, y + 1, border);
		g.fill(x, y + CARD_H - 1, x + w, y + CARD_H, border);
		g.fill(x, y, x + 1, y + CARD_H, border);
		g.fill(x + w - 1, y, x + w, y + CARD_H, border);
		int ph = CARD_H - 27;
		g.fill(x + 2, y + 2, x + w - 2, y + 2 + ph, 0x22FFFFFF);
		drawPreview(g, c.id(), "iso", x + 3, y + 3, w - 6, ph - 2);
		// star (filled when starred, faint outline on hover)
		if (c.favorite()) {
			g.text(font, "★", starX + 2, starY + 2, UiStyle.BRASS, true);
		} else if (hover) {
			g.text(font, "☆", starX + 2, starY + 2, UiStyle.withAlpha(UiStyle.WALNUT, 170), false);
		}
		String badge = c.badge();
		if (badge != null) {
			int bw = font.width(badge) + 6;
			g.fill(x + 3, y + ph - 10, x + 3 + bw, y + ph, UiStyle.withAlpha(c.imported() ? UiStyle.TEAL : UiStyle.WALNUT, 220));
			g.text(font, badge, x + 6, y + ph - 9, UiStyle.OnDark.text(), false); // on the dark badge bar: the on-dark token
		}
		g.text(font, TextUtil.ellipsize(font, c.name(), w - 6), x + 3, y + ph + 4, UiBits.ink(), false);
		g.text(font, TextUtil.ellipsize(font, c.type() + " · " + c.sizeText(), w - 6), x + 3, y + ph + 14, UiBits.muted(), false);
	}

	/** A preview image of {@code kind}, else the iso one, else the built-in top-down plan. */
	private void drawPreview(GuiGraphicsExtractor g, String id, String kind, int x, int y, int w, int h) {
		List<PreviewImages.Found> found = PreviewImages.find(id);
		PreviewImages.Found pick = null;
		for (PreviewImages.Found f : found) {
			if (f.kind().equals(kind)) {
				pick = f;
			}
		}
		if (pick == null && !found.isEmpty()) {
			pick = found.get(0);
		}
		if (pick != null && PreviewImages.draw(g, pick, x, y, w, h)) {
			return;
		}
		int box = Math.max(8, Math.min(w, h) - 4);
		BlueprintPreview.draw(g, id, x + (w - box) / 2, y + (h - box) / 2, box);
	}

	private void drawDetail(GuiGraphicsExtractor g, int x, int y, int w, int h, int mx, int my) {
		Font font = font();
		LibraryCard c = LibraryFeature.selected();
		if (c == null) {
			Panels.inset(g, x, y, w, h);
			g.text(font, TextUtil.ellipsize(font, "Select a design.", w - 12), x + 6, y + 6, UiBits.muted(), false);
			return;
		}
		if (editing != null && !editing.equals(c.id())) {
			cancelEdit();
		}
		Blueprint b = Blueprints.get(c.id());
		// (U3) actions: Place (primary), Edit, and ⋯ (everything else; Delete there, behind a Confirm). The rest are menu items.
		boolean inWorld = s.inWorld();
		boolean survival = dev.larattalabs.architect.survival.SurvivalWorld.on();
		List<Btn> items = new ArrayList<>();
		if (DesignFeature.plotForBlueprint(c.id()) != null) {
			items.add(new Btn("place_plot", "Place on the plot", false, inWorld, () -> placeOnPlot(c.id())));
		}
		items.add(new Btn("variants", "Variants… (re-skin, parameters)", false, c.canVariant(), () -> openVariants(c.id())));
		items.add(new Btn("remix", "Remix… (Claude)", false, true, () -> s.remix(c.id())));
		// (5a) a report critique of the entry: one critic call (about $0.1), the verdict lands in its critique.json
		if (dev.larattalabs.architect.client.design.SetFeature.has("critique.report")) {
			String why = dev.larattalabs.architect.design.CritiqueRules.reportRefusal(c.bundled(), false, true, Sidecar.connected());
			items.add(new Btn("critique", DesignFeature.REPORT_PENDING.contains(c.id()) ? "Critiquing…" : dev.larattalabs.architect.design.CritiqueRules.reportLabel(
				reportEstimate(c)), false, why == null && !DesignFeature.REPORT_PENDING.contains(c.id()), () -> requestReport(c)));
		}
		items.add(new Btn("rename", "Rename", false, true, () -> startEdit(Edit.RENAME, c)));
		items.add(new Btn("tags", "Tags", false, true, () -> startEdit(Edit.TAGS, c)));
		items.add(new Btn("favorite", c.favorite() ? "★ Unstar" : "☆ Star", false, true, () -> LibraryFeature.setFavorite(c.id(), !c.favorite())));
		items.add(new Btn("export", "Export .nbt", false, inWorld, () -> LibraryFeature.export(c.id())));
		// (6c SCH) a Sponge schematic (version 3) for WorldEdit and other tools
		items.add(new Btn("export_schem", "Export .schem", false, inWorld, () -> LibraryFeature.exportSchem(c.id())));
		// phase 5b: versions (Compare…, Revert entry to the previous one, Polish…)
		Blueprints.Entry ve = Blueprints.entry(c.id());
		int headV = ve == null ? 1 : Blueprints.headVersion(ve);
		if (headV > 1) {
			items.add(new Btn("compare", "Compare v" + (headV - 1) + " and v" + headV + "…", false, inWorld, () -> compare(c.id(), headV - 1, headV)));
			items.add(new Btn("revert_entry", "Revert to v" + (headV - 1), false, Sidecar.connected() && !c.bundled(), () -> revertEntry(c.id(), headV - 1)));
		}
		// (5b) polish failed its gate (G4), so per the contract it stays behind a dev flag: -Darchitect.dev.polish=true
		if (dev.larattalabs.architect.client.design.SetFeature.has("design.polish") && Boolean.getBoolean("architect.dev.polish")) {
			items.add(new Btn("polish", POLISHING.contains(c.id()) ? "Polishing…" : "Polish…", false, !c.bundled() && c.canVariant() && !POLISHING.contains(c
				.id()), () -> polish(c.id())));
		}
		menuItems = items;
		menuFor = c;
		int buttonsTop = y + h - 20;

		// text block height
		// the expanded BOM takes the room of the description and the materials line
		boolean bomOpen = survival && showBom;
		List<String> desc = c.description().isBlank() || bomOpen ? List.of() : TextUtil.wrapPlain(font, c.description(), w);
		boolean mats = !c.materials().isEmpty() && !bomOpen;
		// (5a) its critique: the verdict line, the scores, the open issues (at most 2 lines)
		var critique = bomOpen ? java.util.Optional.<dev.larattalabs.architect.api.Critique>empty() : critiqueOf(c.id());
		int critLines = critique.map(cr -> 1 + (cr.scores().isEmpty() ? 0 : 1) + Math.min(2, cr.openIssues().size())).orElse(0);
		int textLines = 4 + (c.userTags().isEmpty() ? 0 : 1) + Math.min(2, desc.size()) + (mats ? 1 : 0) + (survival ? 1 : 0) + critLines;
		int textH = textLines * 10 + 4 + (edit != Edit.NONE ? 12 : 0);
		List<String> kinds = new ArrayList<>();
		for (PreviewImages.Found f : PreviewImages.find(c.id())) {
			kinds.add(f.kind());
		}
		int chipsH = kinds.size() > 1 ? 16 : 0;
		int box = Math.max(36, buttonsTop - 4 - textH - chipsH - y);
		Panels.inset(g, x, y, w, box);
		if (!kinds.contains(previewKind)) {
			previewKind = kinds.isEmpty() ? "iso" : kinds.get(0);
		}
		if (survival && showBom) {
			drawBom(g, c.id(), x + 2, y + 2, w - 4, box - 4, mx, my);
		} else {
			drawPreview(g, c.id(), previewKind, x + 2, y + 2, w - 4, box - 4);
		}
		int ty = y + box + 3;
		if (kinds.size() > 1) {
			int kx = x;
			for (String k : VIEW_KINDS) {
				if (kinds.contains(k)) {
					kx += s.chip(g, "view:" + k, k, kx, ty, k.equals(previewKind), true, mx, my, () -> previewKind = k) + 2;
				}
			}
			ty += chipsH;
		}
		// name line, or the inline editor
		if (edit != Edit.NONE && c.id().equals(editing)) {
			boolean ren = edit == Edit.RENAME;
			int okW = font.width("Save") + 12;
			s.textField(g, ren ? Focus.RENAME : Focus.TAGS, ren ? renameView : tagsView, ren ? rename : tags, x, ty - 2, w - okW - 3,
				new TextFieldView.Style(null, 0, ren ? "a name (empty = the design's own)" : "tags, comma separated", null, null, 0, 1));
			s.chip(g, "edit:save", "Save", x + w - okW, ty + 1, true, true, mx, my, this::commitEdit);
			ty += 18;
			g.text(font, TextUtil.ellipsize(font, "Enter saves · Esc cancels", w), x, ty, UiBits.muted(), false);
			ty += 10;
		} else {
			String star = c.favorite() ? "★ " : "";
			int nx = x;
			if (!star.isEmpty()) {
				g.text(font, star, nx, ty, UiStyle.BRASS, false);
				nx += font.width(star);
			}
			g.text(font, TextUtil.ellipsize(font, c.name(), w - (nx - x)), nx, ty, UiBits.ink(), false);
			ty += 11;
		}
		String facts = c.type() + " · " + c.sizeX() + " × " + c.sizeY() + " × " + c.sizeZ() + (b == null ? "" : " · entrance " + b.front())
			+ (c.createdAt() > 0 ? " · " + date(c.createdAt()) : "") + versionFacts(c.id());
		g.text(font, TextUtil.ellipsize(font, facts, w), x, ty, UiBits.muted(), false);
		ty += 10;
		String prov = c.provenance(LibraryFeature::nameOf) + (c.name().equals(c.baseName()) ? "" : " · was “" + c.baseName() + "”");
		if (c.bible() != null) {
			// phase 4b: the bible it was built with (and its set)
			prov = (c.group() != null ? collectionName(LibraryQuery.GROUP_PREFIX + c.group()) + " · " : "") + collectionName(LibraryQuery.BIBLE_PREFIX
				+ c.bible()) + " v" + c.bibleVersion() + " · " + prov;
		}
		g.text(font, TextUtil.ellipsize(font, prov, w), x, ty, UiStyle.CLAY_DARK, false);
		ty += 10;
		if (!c.userTags().isEmpty()) {
			g.text(font, TextUtil.ellipsize(font, "#" + String.join("  #", c.userTags()), w), x, ty, UiStyle.color("palette.ui.teal_text", 0xFF1E7472),
				false);
			ty += 10;
		}
		for (String line : desc.stream().limit(2).toList()) {
			g.text(font, line, x, ty, UiBits.ink(), false);
			ty += 10;
		}
		if (mats) {
			List<String> matNames = new ArrayList<>();
			for (String m : c.materials()) {
				matNames.add(m.replace("minecraft:", "").replace('_', ' '));
			}
			g.text(font, TextUtil.ellipsize(font, "uses " + String.join(", ", matNames), w), x, ty, UiBits.muted(), false);
			ty += 10;
		}
		if (critique.isPresent()) {
			var cr = critique.get();
			String head = (cr.mode() == dev.larattalabs.architect.api.CritiqueMode.REPORT ? "Critique (report): " : "Critique: ") + (cr.scored()
				? String.format(java.util.Locale.ROOT, "%.1f", cr.overall()) : "not scored") + (cr.ended() && (cr.mode() != dev.larattalabs.architect.api.CritiqueMode.REPORT
				|| !cr.scored()) ? " · " + cr.end().label() : "") + " · "
				+ cr.openIssues().size() + " open issue" + (cr.openIssues().size() == 1 ? "" : "s") + (cr.stale() ? " · stale: the design changed since"
					: "");
			g.text(font, TextUtil.ellipsize(font, head, w), x, ty, cr.stale() ? UiBits.muted() : UiStyle.CLAY_DARK, false);
			ty += 10;
			if (!cr.scores().isEmpty()) {
				g.text(font, TextUtil.ellipsize(font, dev.larattalabs.architect.design.CritiqueRules.scoresLine(cr.scores()), w), x, ty, cr.stale()
					? UiBits.muted() : UiBits.ink(), false);
				ty += 10;
			}
			List<String> issues = dev.larattalabs.architect.design.CritiqueRules.issueLines(cr.openIssues());
			for (String line : issues.stream().limit(2).toList()) {
				g.text(font, TextUtil.ellipsize(font, "· " + line, w), x, ty, UiBits.muted(), false);
				ty += 10;
			}
		}
		if (survival) {
			// survival: what the design needs (the template; the spot adds its foundation and approach), and the BOM on demand
			ty += 2;
			Bom bom = bom(c.id());
			String needs = bom == null ? "Needs: (the template isn't loaded)" : !bom.creativeOnly().isEmpty()
				? "Survival can't build it: uses " + String.join(", ", bom.creativeOnly().stream().map(m -> m.replace("minecraft:", "")).toList())
				: "Needs: " + bom.total() + " items";
			int cw = bom == null || !bom.creativeOnly().isEmpty() ? 0 : font.width(showBom ? "Preview" : "BOM ▸") + 12;
			g.text(font, TextUtil.ellipsize(font, needs, w - cw - 4), x, ty, bom != null && !bom.creativeOnly().isEmpty() ? UiBits.errorText()
				: UiStyle.CLAY_DARK, false);
			if (cw > 0) {
				s.chip(g, "bom", showBom ? "Preview" : "BOM ▸", x + w - cw, ty - 3, showBom, true, mx, my, () -> showBom = !showBom);
			}
		}
		// buttons: Place, Edit, ⋯
		String placeL = survival ? "Place construction site" : "Place";
		int pw = Math.max(40, Math.min(bw(placeL), w - bw("Edit") - bw("⋯") - 14));
		s.button(g, "place", placeL, x, buttonsTop, pw, true, inWorld, mx, my, () -> place(c.id()));
		int ex = x + pw + 4;
		// Edit: the design's variants editor (its Style, materials and parameters), else a remix (an import has no source)
		boolean variants = c.canVariant();
		s.button(g, "edit", "Edit", ex, buttonsTop, bw("Edit"), false, true, mx, my, () -> {
			if (variants) {
				openVariants(c.id());
			} else {
				s.remix(c.id());
			}
		});
		ex += bw("Edit") + 4;
		s.button(g, "more", "⋯", ex, buttonsTop, bw("⋯") + 6, false, true, mx, my, () -> menuOpen = !menuOpen);
		menuAnchor = new int[] {ex, buttonsTop};
		// every menu item stays a control for the DevBridge when the menu is closed (dev.ui.click rename, tags, variants, …)
		if (!menuOpen) {
			for (Btn it : items) {
				s.devControl(it.id(), it.label(), it.enabled(), false, it.action());
			}
			s.devControl("delete", "Delete…", !c.bundled(), false, () -> {
				menuOpen = true;
				deleteConfirm().press();
			});
		}
	}

	// ------------------------------------------------------------------ (U3) the ⋯ menu, with Delete behind a lab-ui Confirm

	private List<Btn> menuItems = List.of();
	private @Nullable LibraryCard menuFor;
	boolean menuOpen;
	private int[] menuAnchor = new int[2];
	private int[] menuRect = new int[4];
	private final dev.larattalabs.labui.ui.ConfirmArm deleteArm = new dev.larattalabs.labui.ui.ConfirmArm();
	private final java.util.Map<String, dev.larattalabs.labui.client.widget.Confirm> confirms = new java.util.HashMap<>();

	/** The selected design's Delete (two presses: the first arms it with a countdown, the second moves it to the trash). */
	dev.larattalabs.labui.client.widget.Confirm deleteConfirm() {
		LibraryCard c = menuFor;
		String id = c == null ? "" : c.id();
		return confirms.computeIfAbsent(id, k -> new dev.larattalabs.labui.client.widget.Confirm(deleteArm, "delete:" + k, "Delete…", "delete", () -> {
			menuOpen = false;
			LibraryFeature.delete(k);
		}));
	}

	/** Whether the selected design's Delete is armed (pressed once). */
	boolean deleteArmed() {
		return menuFor != null && deleteConfirm().armed();
	}

	private void drawMenu(GuiGraphicsExtractor g, int mx, int my) {
		LibraryCard c = menuFor;
		LibraryCard sel = LibraryFeature.selected();
		if (!menuOpen || c == null || sel == null || !c.id().equals(sel.id())) {
			menuOpen = false;
			return;
		}
		Font font = font();
		int w = 0;
		for (Btn b : menuItems) {
			w = Math.max(w, bw(b.label()));
		}
		dev.larattalabs.labui.client.widget.Confirm del = deleteConfirm();
		w = Math.max(w, del.width(font)) + 8;
		int rowH = dev.larattalabs.labui.client.widget.Button.H + 2;
		int h = (menuItems.size() + 1) * rowH + 13;
		int x = Math.max(4, Math.min(menuAnchor[0] + 20 - w, s.width - w - 4));
		int y = menuAnchor[1] - h - 2;
		if (y < 4) {
			y = Math.max(4, Math.min(s.height - h - 4, menuAnchor[1] + 22));
		}
		menuRect = new int[] {x, y, w, h};
		g.nextStratum();
		Panels.framed(g, x - 2, y - 2, w + 4, h + 4);
		g.fill(x, y, x + w, y + h, UiStyle.CREAM);
		int yy = y + 4;
		List<dev.larattalabs.labui.client.widget.Control> drawn = new ArrayList<>();
		for (Btn b : menuItems) {
			dev.larattalabs.labui.client.widget.Button bt = new dev.larattalabs.labui.client.widget.Button(b.label(), () -> {
				menuOpen = false;
				b.action().run();
			});
			bt.disabled(!b.enabled());
			bt.draw(g, font, x + 4, yy, w - 8, dev.larattalabs.labui.client.widget.Button.H, mx, my);
			s.control(b.id(), b.label(), bt, false);
			drawn.add(bt);
			yy += rowH;
		}
		g.fill(x + 4, yy + 2, x + w - 4, yy + 3, UiStyle.rule());
		yy += 7;
		del.disabled(c.bundled()).tooltip(c.bundled() ? "a bundled design can't be deleted" : "moves it to architect/library-trash");
		del.draw(g, font, x + 4, yy, w - 8, dev.larattalabs.labui.client.widget.Button.H, mx, my);
		s.control("delete", "Delete…", del, false);
		int[] r = menuRect;
		// clicks go to the menu first; a click outside closes it
		s.overlay((px, py, b) -> {
			if (px >= r[0] && px < r[0] + r[2] && py >= r[1] && py < r[1] + r[3]) {
				for (dev.larattalabs.labui.client.widget.Control ct : drawn) {
					if (ct.mouseClicked(px, py, b)) {
						return true;
					}
				}
				return true;
			}
			menuOpen = false;
			deleteArm.cancel();
			return true;
		});
	}

	boolean closeMenu() {
		if (menuOpen) {
			menuOpen = false;
			deleteArm.cancel();
			return true;
		}
		return false;
	}

	record Btn(String id, String label, boolean primary, boolean enabled, Runnable action) {
	}

	// ------------------------------------------------------------------ phase 5b: versions

	static final java.util.Set<String> POLISHING = java.util.concurrent.ConcurrentHashMap.newKeySet();

	/** " · v3 (polish: fixed the roof)" for an entry with versions, else "". */
	static String versionFacts(String id) {
		Blueprints.Entry e = Blueprints.entry(id);
		if (e == null) {
			return "";
		}
		var lineage = dev.larattalabs.architect.library.EntryVersions.lineage(e.json(), null);
		int head = Blueprints.headVersion(e);
		if (head <= 1 && lineage.size() <= 1) {
			return "";
		}
		var last = lineage.get(lineage.size() - 1);
		return " · v" + head + " of " + lineage.size() + " (" + last.by() + (last.summary().isBlank() ? "" : ": " + last.summary()) + ")";
	}

	/** Compare…: the two versions as a composite in front of the player (the older one red, the newer one green) and the part summary. */
	void compare(String id, int from, int to) {
		var mc = net.minecraft.client.Minecraft.getInstance();
		if (mc.player == null) {
			return;
		}
		var look = mc.player.blockPosition().relative(mc.player.getDirection(), 6);
		var layers = List.of(new dev.larattalabs.architect.api.PreviewLayer(id + "@" + from, look, net.minecraft.world.level.block.Rotation.NONE,
			dev.larattalabs.architect.api.PreviewStyle.REMOVED, null), new dev.larattalabs.architect.api.PreviewLayer(id + "@" + to, look,
				net.minecraft.world.level.block.Rotation.NONE, dev.larattalabs.architect.api.PreviewStyle.ADDED, null));
		try {
			dev.larattalabs.architect.client.placement.CompositePreview.show("architect:compare", layers);
		} catch (IllegalArgumentException e) {
			LibraryFeature.say("Compare: " + e.getMessage(), true);
			return;
		}
		dev.larattalabs.architect.apiimpl.ApiImpl.instance().library().delta(id, from, to).whenComplete((d, err) -> mc.execute(() -> {
			if (err != null) {
				LibraryFeature.say("Compare: " + err.getMessage(), true);
				return;
			}
			List<String> parts = new ArrayList<>();
			d.parts().forEach((n, p) -> {
				if (p.status() != dev.larattalabs.architect.api.PartStatus.UNCHANGED) {
					parts.add(n + " " + p.status().name().toLowerCase(java.util.Locale.ROOT));
				}
			});
			LibraryFeature.say("v" + from + " -> v" + to + ": +" + d.added() + " -" + d.removed() + " ~" + d.changed() + (parts.isEmpty() ? "" : " · " + String
				.join(", ", parts)), false);
		}));
	}

	void revertEntry(String id, int to) {
		dev.larattalabs.architect.apiimpl.ApiImpl.instance().library().revertEntry(id, to).whenComplete((e, err) -> net.minecraft.client.Minecraft
			.getInstance().execute(() -> LibraryFeature.say(err != null ? "Not reverted: " + err.getMessage() : id + " is v" + e.version() + " now (a copy of v"
				+ to + "); placed sites can update to it", err != null)));
	}

	void polish(String id) {
		POLISHING.add(id);
		dev.larattalabs.architect.apiimpl.ApiImpl.instance().designs().polish(new dev.larattalabs.architect.api.PolishRequest(id)).whenComplete((d,
			err) -> net.minecraft.client.Minecraft.getInstance().execute(() -> {
				if (err != null) {
					POLISHING.remove(id);
				}
				LibraryFeature.say(err != null ? "Not polished: " + err.getMessage() : "Polishing " + id + " (Designs tab: " + d + ")", err != null);
			}));
	}

	// ------------------------------------------------------------------ (5a) critique

	private record CritiqueCache(long stamp, java.util.Optional<dev.larattalabs.architect.api.Critique> critique) {
	}

	private final java.util.Map<String, CritiqueCache> critiques = new java.util.HashMap<>();
	private final java.util.Map<String, dev.larattalabs.architect.api.Estimate> reportEstimates = new java.util.HashMap<>();
	private final java.util.Set<String> reportAsked = new java.util.HashSet<>();

	/** An entry's critique ({@code critique.json}, else its blueprint JSON summary), re-read when the file changes. */
	java.util.Optional<dev.larattalabs.architect.api.Critique> critiqueOf(String id) {
		Blueprints.Entry e = Blueprints.entry(id);
		if (e == null) {
			return java.util.Optional.empty();
		}
		long stamp = e.json().hashCode();
		if (e.dir() != null) {
			try {
				java.nio.file.Path f = e.dir().resolve(dev.larattalabs.architect.apiimpl.Wire5a.CRITIQUE_FILE);
				java.nio.file.Path nbt = e.dir().resolve(id + ".nbt");
				stamp = stamp * 31 + (java.nio.file.Files.exists(f) ? java.nio.file.Files.getLastModifiedTime(f).toMillis() : 0);
				stamp = stamp * 31 + (java.nio.file.Files.exists(nbt) ? java.nio.file.Files.getLastModifiedTime(nbt).toMillis() : 0);
			} catch (java.io.IOException ignored) {
				// read again
			}
		}
		CritiqueCache cc = critiques.get(id);
		if (cc == null || cc.stamp() != stamp) {
			cc = new CritiqueCache(stamp, dev.larattalabs.architect.apiimpl.Wire5a.entry(e.dir(), id, e.json()));
			critiques.put(id, cc);
		}
		return cc.critique();
	}

	/** The report's estimate for an entry (asked once per entry; the critic seed until it answers). */
	dev.larattalabs.architect.api.@Nullable Estimate reportEstimate(LibraryCard c) {
		if (reportAsked.add(c.id()) && dev.larattalabs.architect.client.design.SetFeature.has("estimates") && Sidecar.connected()) {
			com.google.gson.JsonObject req = new com.google.gson.JsonObject();
			req.addProperty("type", dev.larattalabs.architect.placement.Blueprint.TYPES.contains(c.type()) || c.type().matches("[a-z][a-z0-9_]{0,39}")
				? c.type() : "custom");
			req.addProperty("style", "as built");
			req.add("features", new com.google.gson.JsonArray());
			com.google.gson.JsonObject size = new com.google.gson.JsonObject();
			size.addProperty("x", Math.max(7, Math.min(96, c.sizeX())));
			size.addProperty("y", Math.max(6, Math.min(64, c.sizeY())));
			size.addProperty("z", Math.max(7, Math.min(96, c.sizeZ())));
			req.add("maxSize", size);
			req.add("critique", dev.larattalabs.architect.design.CritiqueRules.reportSpec());
			com.google.gson.JsonObject m = new com.google.gson.JsonObject();
			m.addProperty("type", "design.estimate");
			m.add("request", req);
			String id = c.id();
			Sidecar.link().send(m).whenComplete((ack, err) -> {
				if (err == null && ack.ok() && ack.result() != null) {
					reportEstimates.put(id, dev.larattalabs.architect.apiimpl.Wire5a.estimate(ack.result()));
				}
			});
		}
		return reportEstimates.get(c.id());
	}

	/** "Critique": {@code design.critique {entryId, spec: {mode: report}}}; the Designs tab shows it, a toast says when it is in. */
	void requestReport(LibraryCard c) {
		com.google.gson.JsonObject m = new com.google.gson.JsonObject();
		m.addProperty("type", "design.critique");
		m.addProperty("entryId", c.id());
		m.add("spec", dev.larattalabs.architect.design.CritiqueRules.reportSpec());
		DesignFeature.REPORT_PENDING.add(c.id());
		Sidecar.link().send(m).whenComplete((ack, err) -> {
			if (err != null || !ack.ok()) {
				DesignFeature.REPORT_PENDING.remove(c.id());
				LibraryFeature.say("Critique not started: " + (err != null ? err.getMessage() : ack.error()), true);
			} else {
				String did = ack.result() != null && ack.result().has("designId") ? ack.result().get("designId").getAsString() : "?";
				LibraryFeature.say("Critiquing " + c.name() + " (" + did + "): one critic call; the Designs tab shows it", false);
			}
		});
	}

	/** A design's template bill of materials (survival "Needs"), cached per template fingerprint. */
	record Bom(String fingerprint, java.util.Map<String, Integer> items, List<String> creativeOnly) {
		int total() {
			return items.values().stream().mapToInt(Integer::intValue).sum();
		}
	}

	boolean showBom;
	int bomPage;
	private final java.util.Map<String, Bom> boms = new java.util.HashMap<>();

	Bom bom(String id) {
		dev.larattalabs.architect.placement.TemplateGrid grid = dev.larattalabs.architect.placement.TemplateGrid.of(id);
		Blueprint bp = Blueprints.get(id);
		if (grid == null || bp == null) {
			return null;
		}
		Bom b = boms.get(id);
		if (b == null || !b.fingerprint().equals(grid.fingerprint())) {
			b = new Bom(grid.fingerprint(), dev.larattalabs.architect.site.Builder.templateBom(grid),
				dev.larattalabs.architect.site.Builder.creativeOnly(grid, bp));
			boms.put(id, b);
		}
		return b;
	}

	/** The expanded BOM in the preview box: item icons with counts, largest first, in columns. */
	private void drawBom(GuiGraphicsExtractor g, String id, int x, int y, int w, int h, int mx, int my) {
		Font font = font();
		Bom b = bom(id);
		if (b == null) {
			return;
		}
		List<java.util.Map.Entry<String, Integer>> rows = new ArrayList<>(b.items().entrySet());
		rows.sort((p, q) -> !q.getValue().equals(p.getValue()) ? Integer.compare(q.getValue(), p.getValue()) : p.getKey().compareTo(q.getKey()));
		int cols = Math.max(1, (w - 4) / 112);
		int colW = (w - 4) / cols;
		int perCol = Math.max(1, (h - 16) / 17);
		g.text(font, TextUtil.ellipsize(font, "Bill of materials · " + b.total() + " items, plus the spot's foundation and path", w - 8), x + 4, y + 3,
			UiBits.muted(), false);
		int per = cols * perCol;
		int pages = Math.max(1, (rows.size() + per - 1) / per);
		bomPage = Math.floorMod(bomPage, pages);
		int from = bomPage * per;
		int shown = Math.min(rows.size() - from, per);
		for (int j = 0; j < shown; j++) {
			var e = rows.get(from + j);
			int cx = x + 4 + (j / perCol) * colW;
			int cy = y + 15 + (j % perCol) * 17;
			net.minecraft.world.item.Item it = net.minecraft.core.registries.BuiltInRegistries.ITEM.getOptional(
				net.minecraft.resources.Identifier.parse(e.getKey())).orElse(null);
			if (it != null) {
				g.item(new net.minecraft.world.item.ItemStack(it), cx, cy);
			}
			String label = e.getValue() + " " + dev.larattalabs.architect.site.Builder.itemNameClient(e.getKey());
			g.text(font, TextUtil.ellipsize(font, label, colW - 22), cx + 18, cy + 5, UiBits.ink(), false);
		}
		if (pages > 1) {
			// pages: the chip turns to the next one (the list is largest first)
			String more = "page " + (bomPage + 1) + "/" + pages + " \u25b8";
			int cw = font.width(more) + 12;
			s.chip(g, "bom:page", more, x + w - cw - 2, y + h - 14, false, true, mx, my, () -> bomPage++);
		}
	}

	private int bw(String label) {
		return font().width(label) + 14;
	}

	/** Lays the rows out in {@code w}, wrapping a row that does not fit. */
	private List<List<Btn>> flow(List<List<Btn>> rows, int w) {
		List<List<Btn>> out = new ArrayList<>();
		for (List<Btn> row : rows) {
			List<Btn> cur = new ArrayList<>();
			int used = 0;
			for (Btn b : row) {
				int bwid = bw(b.label()) + 3;
				if (!cur.isEmpty() && used + bwid - 3 > w) {
					out.add(cur);
					cur = new ArrayList<>();
					used = 0;
				}
				cur.add(b);
				used += bwid;
			}
			if (!cur.isEmpty()) {
				out.add(cur);
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ Variants dialog

	private static Palettes.Inputs originalInputs(@Nullable LibraryCard c) {
		return c == null || c.palette() == null ? Palettes.Inputs.NONE : Palettes.Inputs.of(c.palette());
	}

	static String summary(VariantForm f) {
		return f.summary(id -> dev.larattalabs.architect.client.design.SetFeature.bible(id).map(dev.larattalabs.architect.api.Bible::name).orElse(id));
	}

	// ------------------------------------------------------------------ Import dialog

	private void drawImport(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my) {
		Font font = font();
		int y = top - 3;
		g.text(font, "Import a structure (.nbt)", x, y + 1, UiStyle.CLAY_DARK, false);
		y += 12;
		for (String line : TextUtil.wrapPlain(font, "From architect/imports/ and this world's structure-block saves (generated/<namespace>/structure/). "
			+ "It becomes a custom entry, checked by the helper; imports have no source, so no variants.", w).stream().limit(2).toList()) {
			g.text(font, line, x, y, UiBits.muted(), false);
			y += 10;
		}
		y += 3;
		// (U3) a search over the files (name and path)
		List<Exchange.Candidate> all = LibraryFeature.importList();
		String q = importFilter.value().strip().toLowerCase(Locale.ROOT);
		List<Exchange.Candidate> list = q.isEmpty() ? all : all.stream().filter(c -> c.label().toLowerCase(Locale.ROOT).contains(q) || c.path().toString()
			.toLowerCase(Locale.ROOT).contains(q)).toList();
		if (!all.isEmpty()) {
			s.textField(g, Focus.IMPORT_FILTER, importFilterView, importFilter, x, y, w, new TextFieldView.Style(dev.larattalabs.labui.client.widget.ScrollList
				.SEARCH_GLYPH, UiBits.muted(), "Search " + all.size() + " files…", null, q.isEmpty() ? null : list.size() + "/" + all.size(), UiBits.muted(), 1));
			y += TextFieldView.BASE_H + 3;
		}
		if (importSel >= 0 && importSel < all.size() && !list.contains(all.get(importSel))) {
			importSel = list.isEmpty() ? -1 : all.indexOf(list.get(0));
		}
		int lh = footerY - 16 - y;
		int rowH = 22;
		Panels.inset(g, x, y, w, lh);
		s.setScrollArea(x, y, w - 6, lh, list.size() * rowH + 4, rowH);
		int scroll = s.scroll();
		g.enableScissor(x + 1, y + 1, x + w - 1, y + lh - 1);
		int ry = y + 3 - scroll;
		for (int i = 0; i < list.size(); i++) {
			Exchange.Candidate c = list.get(i);
			if (ry + rowH > y && ry < y + lh) {
				int index = all.indexOf(c);
				boolean sel = index == importSel;
				Hit h = new Hit("import:" + index, c.label(), x + 2, Math.max(ry, y), w - 10, Math.min(rowH - 2, y + lh - ry), true, sel, () -> importSel = index);
				s.addHit(h);
				if (sel) {
					g.fill(x + 2, ry, x + w - 8, ry + rowH - 2, 0x30D97757);
				} else if (h.contains(mx, my)) {
					g.fill(x + 2, ry, x + w - 8, ry + rowH - 2, 0x12000000);
				}
				int tagW = Panels.pill(g, font, c.where().equals("world") ? "this world" : "imports", x + 6, ry + 5, UiBits.ink());
				g.text(font, TextUtil.ellipsize(font, c.label(), w - tagW - 120), x + 12 + tagW, ry + 2, UiBits.ink(), false);
				String meta = (c.bytes() / 1024 + 1) + " KB · " + date(c.modified());
				g.text(font, meta, x + w - 12 - font.width(meta), ry + 2, UiBits.muted(), false);
				g.text(font, TextUtil.ellipsize(font, c.path().toString(), w - tagW - 30), x + 12 + tagW, ry + 11, UiStyle.color("ink_ui.ghost_on_paper",
					0xFF9A8E7C), false);
			}
			ry += rowH;
		}
		g.disableScissor();
		s.scrollbarAt(g, x + w - 7, y + 1, lh - 2);
		if (list.isEmpty() && !all.isEmpty()) {
			g.text(font, TextUtil.ellipsize(font, "Nothing matches “" + importFilter.value().strip() + "”: Esc clears the search.", w - 12), x + 6, y + 6,
				UiBits.muted(), false);
		} else if (list.isEmpty()) {
			for (String line : TextUtil.wrapPlain(font, "No .nbt or .schem files yet. Put structure files or Sponge schematics in " + Exchange.importsDir(Blueprints.gameDataDir())
				+ ", or save one with a structure block in this world, then Refresh.", w - 12)) {
				g.text(font, line, x + 6, y + 6, UiBits.muted(), false);
				y += 10;
			}
		}
		// footer
		String status = LibraryFeature.importSending() ? "Sending…" : LibraryFeature.importError() != null ? LibraryFeature.importError()
			: !Sidecar.connected() ? "The design helper is not running (Status tab)." : list.isEmpty() ? null
				: importSel >= 0 && importSel < all.size() ? "Will import " + all.get(importSel).label() + " as a custom entry" : "Pick a file";
		s.statusLineAt(g, status, LibraryFeature.importError() != null || !Sidecar.connected(), x, footerY - 13, w);
		int bx = x + w;
		String go = "Import";
		bx -= s.bw(go);
		s.button(g, "import:go", go, bx, footerY, s.bw(go), true, importSel >= 0 && importSel < all.size() && Sidecar.connected()
			&& !LibraryFeature.importSending(), mx, my, () -> importPick(importSel));
		String cancel = "Cancel";
		bx -= s.bw(cancel) + 6;
		s.button(g, "import:cancel", cancel, bx, footerY, s.bw(cancel), false, true, mx, my, this::closeDialog);
		String refresh = "Refresh";
		bx -= s.bw(refresh) + 6;
		s.button(g, "import:refresh", refresh, bx, footerY, s.bw(refresh), false, true, mx, my, () -> {
			LibraryFeature.refreshImports();
			importSel = LibraryFeature.importList().isEmpty() ? -1 : Math.min(Math.max(0, importSel), LibraryFeature.importList().size() - 1);
		});
		String folder = "Open folder";
		bx -= s.bw(folder) + 6;
		s.button(g, "import:folder", folder, bx, footerY, s.bw(folder), false, true, mx, my, () -> com.mojang.blaze3d.Blaze3D.openPath(Exchange.importsDir(
			Blueprints.gameDataDir())));
	}
}
