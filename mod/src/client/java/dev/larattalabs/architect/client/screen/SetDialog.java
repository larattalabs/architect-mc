package dev.larattalabs.architect.client.screen;

import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BibleJob;
import dev.larattalabs.architect.apiimpl.Wire4b;
import dev.larattalabs.architect.client.design.SetFeature;
import dev.larattalabs.architect.client.screen.ArchitectScreen.Focus;
import dev.larattalabs.architect.client.screen.ArchitectScreen.Option;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.design.CritiqueRules;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.architect.design.SetSpec;
import dev.larattalabs.labui.client.hud.UiBits;
import dev.larattalabs.labui.client.picker.PickerStore;
import dev.larattalabs.labui.client.text.TextFieldView;
import dev.larattalabs.labui.client.text.TextModel;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.labui.client.widget.Button;
import dev.larattalabs.labui.client.widget.Chip;
import dev.larattalabs.labui.client.widget.CollapsibleSection;
import dev.larattalabs.labui.client.widget.Confirm;
import dev.larattalabs.labui.ui.ConfirmArm;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import org.jspecify.annotations.Nullable;

/**
 * The Design tab's "Design a set…" dialog (docs/CONTRACT.md phase 4b "Design groups"): a name, a style bible (pick one, or
 * "New from a prompt…", which drafts one with {@code bible.request}), up to 24 buildings (type, name, landmark or ordinary,
 * notes), the concurrency and, folded under Options, massing first and its redirects, critique and its revisions, a budget and the
 * context; the live estimate before Generate. Drawn by {@link ArchitectScreen} into its hit list; the model is {@link SetFeature}.
 * <p>
 * (Slice SD) Built on the lab-ui kit like the U3 design editor: a title row, one body that scrolls (wheel, a draggable bar) above a
 * rule, a pinned footer with the status line, Cancel and Generate. Every control is a kit Chip, Button or Confirm at 18 px; the row
 * "×" asks again when the row has a name or notes. Every control keeps its id for dev.ui.click; a control in the closed Options
 * section stays a control for the DevBridge (zero size). Client thread.
 */
final class SetDialog {
	/** One building row: a kit field or chip (18 px) and a gap. */
	static final int ROW_H = TextFieldView.BASE_H + 4;
	/** Text fields drawn per item row, in Tab order. */
	static final Focus[] ITEM_FIELDS = {Focus.SET_TYPE, Focus.SET_INAME, Focus.SET_NOTES};
	static final String OPTIONS_KEY = "architect_mc.set.options";
	private static final int LABEL_W = 52;
	private static final int ROW = Chip.H + 4;

	private final ArchitectScreen s;
	private final TextFieldView nameView = new TextFieldView();
	private final TextFieldView promptView = new TextFieldView();
	private final TextFieldView contextView = new TextFieldView();
	private final List<TextFieldView[]> rowViews = new ArrayList<>();
	private final CollapsibleSection options = new CollapsibleSection(OPTIONS_KEY, "Options", false);
	/** One arm for every row's "×" (a fresh arm per frame would never stay armed). */
	private final ConfirmArm removeArm = new ConfirmArm();
	private int contentH;
	/** The building rows' offset in the body's content (for "+ Add a building" to scroll to the new row). */
	private int rowsAt;
	/** The body's viewport this frame (x, y, w, h): the mouse outside it hovers nothing in it. */
	private int[] view = new int[4];
	/** A refused Style browser pick (a Style that is not a bible): said on the status line. */
	private @Nullable String styleNote;

	SetDialog(ArchitectScreen s) {
		this.s = s;
	}

	private Font font() {
		return s.font();
	}

	/** The Options section is open (the Tab order skips its context field when it is folded). */
	static boolean optionsOpen() {
		return CollapsibleSection.isOpen(OPTIONS_KEY, false);
	}

	/** The text model a set field focuses ({@code index}: the item row). */
	@Nullable TextModel model(Focus f, int index) {
		SetFeature.Form form = SetFeature.form();
		if (form == null) {
			return null;
		}
		return switch (f) {
			case SET_NAME -> form.name;
			case SET_PROMPT -> form.prompt;
			case SET_CONTEXT -> form.context;
			case SET_TYPE, SET_INAME, SET_NOTES -> index >= 0 && index < form.items.size() ? switch (f) {
				case SET_TYPE -> form.items.get(index).type;
				case SET_INAME -> form.items.get(index).name;
				default -> form.items.get(index).notes;
			} : null;
			default -> null;
		};
	}

	private TextFieldView[] views(int i) {
		while (rowViews.size() <= i) {
			rowViews.add(new TextFieldView[] {new TextFieldView(), new TextFieldView(), new TextFieldView()});
		}
		return rowViews.get(i);
	}

	// ------------------------------------------------------------------ kit pieces

	private int my(int my) {
		return my >= view[1] && my < view[1] + view[3] ? my : -1000;
	}

	private int chip(GuiGraphicsExtractor g, String id, Chip c, int x, int y, int mx, int my) {
		int w = c.draw(g, font(), x, y, mx, my(my));
		s.control(id, c.label(), c, c.isSelected());
		return w;
	}

	private int button(GuiGraphicsExtractor g, String id, Button b, int x, int y, int w, int mx, int my) {
		b.draw(g, font(), x, y, w, Button.MIN_H, mx, my(my));
		s.control(id, b.label(), b, false);
		return w;
	}

	private void label(GuiGraphicsExtractor g, String text, int x, int y) {
		g.text(font(), text, x, y + 5, UiStyle.clayText(), false);
	}

	private void muted(GuiGraphicsExtractor g, String text, int x, int y, int w) {
		if (w > 10) {
			g.text(font(), TextUtil.ellipsize(font(), text, w), x, y, UiStyle.mutedText(), false);
		}
	}

	/** A stepper: kit Buttons (18 px) around the value; returns the x after it. */
	private int stepper(GuiGraphicsExtractor g, String id, String value, int valueW, boolean minus, boolean plus, Runnable dec, Runnable inc, boolean on,
		int x, int y, int mx, int my) {
		int bw = Button.MIN_H + 2;
		Button m = new Button("−", dec);
		m.disabled(!minus);
		x += button(g, id + "-", m, x, y, bw, mx, my) + 3;
		g.text(font(), value, x + (valueW - font().width(value)) / 2, y + 5, on ? UiBits.ink() : UiStyle.mutedText(), false);
		x += valueW + 3;
		Button p = new Button("+", inc);
		p.disabled(!plus);
		return x + button(g, id + "+", p, x, y, bw, mx, my);
	}

	// ------------------------------------------------------------------ the dialog

	void draw(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my) {
		SetFeature.Form f = SetFeature.form();
		if (f == null) {
			return;
		}
		SetFeature.tick();
		Font font = font();
		Map<String, String> errors = f.errors();
		// the title row
		int ty = top - 2;
		String title = "Design a set";
		g.text(font, title, x, ty + 5, UiStyle.clayText(), false);
		muted(g, "One style bible for every building, several designed at once; landmarks first, the rest see their renders.", x + font.width(title)
			+ 10, ty + 5, w - font.width(title) - 10);
		// the body: it scrolls above a rule, the footer's status line below it
		int by = ty + Chip.H + 4;
		int bottom = footerY - 13 - 4;
		int bh = Math.max(ROW_H, bottom - by);
		view = new int[] {x, by, w - 8, bh};
		s.setScrollArea(x, by, w - 8, bh, contentH, 24);
		g.enableScissor(x, by, x + w - 8, by + bh);
		s.clipControls(view);
		int y0 = by - s.scroll();
		int iw = w - 12;
		int y = body(g, f, errors, x, y0, iw, mx, my);
		g.disableScissor();
		s.clipControls(null);
		contentH = y - y0 + 8;
		s.setScrollArea(x, by, w - 8, bh, contentH, 24);
		s.scrollbarAt(g, x + w - 6, by, bh);
		g.fill(x, bottom + 1, x + w, bottom + 2, UiStyle.rule());
		footer(g, f, errors, x, w, footerY, mx, my);
	}

	/** The body's rows from {@code y}; returns the y after. */
	private int body(GuiGraphicsExtractor g, SetFeature.Form f, Map<String, String> errors, int x, int y, int w, int mx, int my) {
		Font font = font();
		int y0 = y;
		int fx = x + LABEL_W;
		int fw = w - LABEL_W;
		// ---- Name
		label(g, "Name", x, y);
		int nameW = Math.min(240, fw);
		s.textField(g, Focus.SET_NAME, nameView, f.name, fx, y, nameW, new TextFieldView.Style(null, 0, "e.g. Ashfall hamlet", null, null, 0, 1));
		String ne = errors.get("name");
		if (ne != null) {
			g.text(font, TextUtil.ellipsize(font, ne, Math.max(10, fw - nameW - 8)), fx + nameW + 8, y + 5, UiBits.errorText(), false);
		}
		y += ROW;
		// ---- Style (the set's bible): the editor's Style row, bibles only, plus "New from a prompt…"
		label(g, "Style", x, y);
		y = styleRow(g, f, fx, y, fw, mx, my);
		Bible picked = f.bible == null ? null : SetFeature.bible(f.bible).orElse(null);
		String be = errors.get("bible");
		if (f.newBible) {
			String go = f.bibleJob == null ? "Draft bible" : "Drafting…";
			int gw = Button.width(font, go);
			s.textField(g, Focus.SET_PROMPT, promptView, f.prompt, fx, y, fw - gw - 6, new TextFieldView.Style(null, 0,
				"what the place is, e.g. hellish evil lair, mining facility", null, null, 0, 1));
			Button draft = new Button(go, SetFeature::draftBible);
			draft.disabled(!(f.bibleJob == null && !f.sending && SetFeature.has("bibles")));
			button(g, "set:draft_bible", draft, fx + fw - gw, y, gw, mx, my);
			y += ROW;
			String line = bibleJobLine(f.bibleJob);
			if (line != null) {
				muted(g, line, fx, y, fw);
				y += 12;
			}
		} else if (be != null) {
			g.text(font, TextUtil.ellipsize(font, be, fw), fx, y, UiBits.errorText(), false);
			y += 12;
		} else if (picked != null) {
			// RolesSwatch draws 16 px item icons, 17 px apart, and returns how many
			int sw = RolesSwatch.draw(g, picked, fx, y, Math.min(180, fw)) * 17;
			muted(g, "every building uses " + picked.name() + "'s roles and look", fx + sw + 6, y + 4, fw - sw - 6);
			y += 18;
		}
		y += 4;
		// ---- Buildings
		g.text(font, "Buildings", x, y + 5, UiStyle.clayText(), false);
		String count = f.items.size() + " of " + SetSpec.MAX_ITEMS;
		g.text(font, count, fx, y + 5, UiBits.ink(), false);
		int cx = fx + font.width(count) + 10;
		String ie = errors.get("items");
		if (ie != null) {
			g.text(font, TextUtil.ellipsize(font, ie, Math.max(10, x + w - cx)), cx, y + 5, UiBits.errorText(), false);
		} else {
			muted(g, "landmarks: Opus, designed first · ordinary: Sonnet", cx, y + 5, x + w - cx);
		}
		y += ROW - 4;
		// the columns
		int numW = 14;
		int tx = x + numW;
		int typeW = 84;
		int pickW = Chip.H;
		int nameX = tx + typeW + 2 + pickW + 6;
		int nameColW = Math.min(110, Math.max(60, (w - nameX + x) / 4));
		int roleX = nameX + nameColW + 6;
		Chip roleProbe = new Chip("landmark");
		int roleW = roleProbe.width(font);
		int delW = Button.MIN_H + 2;
		int notesX = roleX + roleW + 6;
		int notesW = x + w - delW - 6 - notesX;
		muted(g, "type", tx + 2, y, typeW);
		muted(g, "name", nameX + 2, y, nameColW);
		muted(g, "role", roleX + 2, y, roleW);
		muted(g, "notes", notesX + 2, y, notesW);
		y += 11;
		rowsAt = y - y0;
		for (int i = 0; i < f.items.size(); i++) {
			y = itemRow(g, f, errors, i, x, y, tx, typeW, pickW, nameX, nameColW, roleX, roleW, notesX, notesW, x + w - delW, delW, mx, my);
		}
		// "+ Add a building"
		Button add = new Button("+ Add a building", () -> {
			f.addItem();
			s.scrollTo(rowsAt + f.items.size() * ROW_H - view[3] / 2); // the new row in view
		});
		add.disabled(f.items.size() >= SetSpec.MAX_ITEMS);
		button(g, "set:add", add, tx, y, add.width(font), mx, my);
		y += ROW + 2;
		// ---- At once and the estimate
		label(g, "At once", x, y);
		int ax = stepper(g, "set:concurrency", Integer.toString(f.concurrency), font.width("0") + 4, f.concurrency > SetSpec.MIN_CONCURRENCY,
			f.concurrency < SetSpec.MAX_CONCURRENCY, () -> f.concurrency--, () -> f.concurrency++, true, fx, y, mx, my) + 12;
		String est = estimateLine(f);
		g.text(font, TextUtil.ellipsize(font, est, Math.max(10, x + w - ax)), ax, y + 5, f.estimateError != null ? UiBits.errorText() : UiBits.ink(), false);
		y += ROW + 2;
		// ---- Options: massing first, redirects, critique, revisions, budget, context
		y = optionsSection(g, f, errors, x, y, w, mx, my);
		return y;
	}

	/** One building row; returns the y after. */
	private int itemRow(GuiGraphicsExtractor g, SetFeature.Form f, Map<String, String> errors, int i, int x, int y, int tx, int typeW, int pickW, int nameX,
		int nameW, int roleX, int roleW, int notesX, int notesW, int delX, int delW, int mx, int my) {
		Font font = font();
		SetFeature.Item it = f.items.get(i);
		int idx = i;
		String rowErr = errors.get("item" + (i + 1));
		String n = Integer.toString(i + 1);
		g.text(font, n, x + (tx - x - 4 - font.width(n)), y + 5, rowErr != null ? UiBits.errorText() : UiStyle.mutedText(), false);
		TextFieldView[] v = views(i);
		s.textField(g, Focus.SET_TYPE, i, v[0], it.type, tx, y, typeW, new TextFieldView.Style(null, 0, "type", null, null, 0, 1));
		int py = y;
		Chip pick = new Chip("▾", () -> s.openPopup("set:type:" + idx, tx, py + Chip.H + 1, 280, typeOptions(it.type.value()), val -> it.type.set(val)));
		pick.draw(g, font, tx + typeW + 2, y, pickW, mx, my(my));
		s.control("set:type_pick:" + i, "type", pick, false);
		s.textField(g, Focus.SET_INAME, i, v[1], it.name, nameX, y, nameW, new TextFieldView.Style(null, 0, "name (optional)", null, null, 0, 1));
		Chip role = new Chip(it.landmark ? "landmark" : "ordinary", () -> it.landmark = !it.landmark).selected(it.landmark);
		role.draw(g, font, roleX, y, roleW, mx, my(my));
		s.control("set:role:" + i, role.label(), role, it.landmark);
		Runnable remove = () -> {
			s.setFocusPublic(Focus.NONE);
			f.removeItem(idx);
		};
		boolean filled = !it.name.value().isBlank() || !it.notes.value().isBlank();
		String key = "set:remove:" + i;
		boolean armed = filled && f.items.size() > 1 && removeArm.armed(key, net.minecraft.util.Util.getMillis());
		if (!armed) {
			s.textField(g, Focus.SET_NOTES, i, v[2], it.notes, notesX, y, notesW, new TextFieldView.Style(null, 0, rowErr != null ? rowErr
				: "notes for the designer", null, null, 0, 1));
		}
		if (filled && f.items.size() > 1) {
			// armed, it takes the notes' place so "Press again to remove (N)" reads whole
			Confirm c = new Confirm(removeArm, key, "×", "remove", remove);
			int cx = armed ? notesX : delX;
			c.draw(g, font, cx, y, delX + delW - cx, Button.MIN_H, mx, my(my));
			s.control(key, "×", c, false);
		} else {
			Button b = new Button("×", remove);
			b.disabled(f.items.size() <= 1);
			b.tooltip(f.items.size() <= 1 ? "a set has at least one building" : null);
			button(g, "set:remove:" + i, b, delX, y, delW, mx, my);
		}
		return y + ROW_H;
	}

	/**
	 * The Style row for a set: the picked bible, recents and a few built-ins as chips (as many as fit, at most 4), "New from a
	 * prompt…" and "browse N styles…" (the {@link StyleBrowserScreen}; a Style that is not a bible is refused, since a set needs one).
	 * Returns the y after.
	 */
	private int styleRow(GuiGraphicsExtractor g, SetFeature.Form f, int x, int y, int w, int mx, int my) {
		Font font = font();
		String current = f.newBible ? null : f.bible;
		List<Bible> all = SetFeature.bibles().stream().filter(b -> !b.archived() || b.id().equals(current)).toList();
		List<String> ids = dev.larattalabs.labui.ui.PickerModel.compact(current, PickerStore.memory().recents(StyleBrowserScreen.ID), List.of("rustic",
			"medieval", "modern", "oak"), 3, id -> all.stream().anyMatch(b -> b.id().equals(id)));
		Chip more = new Chip("browse " + all.size() + " styles…", () -> StyleBrowserScreen.open(current, b -> pickFromBrowser(f, b))).kind(Chip.Kind.MORE);
		Chip fresh = new Chip("New from a prompt…", () -> {
			f.newBible = true;
			f.bible = null;
		}).selected(f.newBible);
		int reserved = more.width(font) + 4 + fresh.width(font) + 4;
		int cx = x;
		for (String id : ids) {
			Bible b = all.stream().filter(k -> k.id().equals(id)).findFirst().orElseThrow();
			Chip c = new Chip(label(b), () -> pick(f, b.id())).selected(id.equals(current)).swatch(StylePaint.rgb(b.roles().get("wall")));
			int cw = c.width(font);
			if (cx > x && cx + cw > x + w - reserved) {
				break;
			}
			cw = Math.min(cw, x + w - reserved - cx);
			c.draw(g, font, cx, y, cw, mx, my(my));
			s.control("set:bible:" + id, c.label(), c, c.isSelected());
			cx += cw + 4;
		}
		cx += chip(g, "set:bible:new", fresh, cx, y, mx, my) + 4;
		chip(g, "set:browse", more, cx, y, mx, my);
		// the list of every bible (and "New from a prompt…") as before, for the DevBridge
		int py = y;
		s.devControl("set:bible", "the bible list", true, false, () -> s.openPopup("set:bible", x, py + Chip.H + 1, Math.max(260, w / 2), bibleOptions(f.bible,
			true), v -> {
				if ("new".equals(v)) {
					f.newBible = true;
					f.bible = null;
				} else {
					pick(f, v);
				}
			}));
		return y + ROW;
	}

	private static String label(Bible b) {
		return b.builtin() ? b.name() : b.name() + " v" + b.version();
	}

	private void pick(SetFeature.Form f, String id) {
		f.newBible = false;
		f.bible = id;
		styleNote = null;
		PickerStore.used(StyleBrowserScreen.ID, id);
	}

	private void pickFromBrowser(SetFeature.Form f, Bible b) {
		if (SetFeature.bible(b.id()).isPresent()) {
			pick(f, b.id());
		} else {
			styleNote = b.name() + " is a palette, not a style bible: a set needs a bible (pick one, or New from a prompt…)";
		}
	}

	/** The folded Options section; returns the y after. */
	private int optionsSection(GuiGraphicsExtractor g, SetFeature.Form f, Map<String, String> errors, int x, int y, int w, int mx, int my) {
		Font font = font();
		boolean m4c = SetFeature.has("massing");
		boolean m5a = SetFeature.has("critique");
		Runnable mToggle = () -> f.massingFirst = !f.massingFirst;
		Runnable cToggle = () -> f.critique = !f.critique;
		Runnable rDec = () -> f.maxRedirects--;
		Runnable rInc = () -> f.maxRedirects++;
		Runnable bDec = () -> f.budgetUsd = budgetStep(f.budgetUsd, -1);
		Runnable bInc = () -> f.budgetUsd = budgetStep(f.budgetUsd, 1);
		boolean rMinus = f.massingFirst && f.maxRedirects > 0;
		boolean rPlus = f.massingFirst && f.maxRedirects < SetSpec.MAX_REDIRECTS;
		boolean bPlus = f.budgetUsd == null || f.budgetUsd < 1000;
		String budget = f.budgetUsd == null ? "none" : String.format(Locale.ROOT, "$%.0f", f.budgetUsd);
		List<String> sum = new ArrayList<>();
		if (m4c) {
			sum.add(f.massingFirst ? "massing first, " + f.maxRedirects + " redirect" + (f.maxRedirects == 1 ? "" : "s") : "no massing");
		}
		if (m5a) {
			sum.add(f.critique ? "critique ×" + f.maxRevisions : "no critique");
		}
		sum.add(f.budgetUsd == null ? "no budget" : "at most " + budget);
		if (m4c) {
			sum.add(f.context.value().isBlank() ? "no context" : "context");
		}
		long bad = errors.keySet().stream().filter(k -> k.equals("budget") || k.equals("redirects") || k.equals("context")).count();
		options.summary((bad > 0 ? bad + " to fix · " : "") + String.join(" · ", sum));
		y += options.draw(g, font, x, y, w, mx, my(my));
		s.control("section:set_options", options.key(), options, options.open());
		if (!options.open()) {
			if (m4c) {
				s.devControl("set:massing_first", "Massing first", true, f.massingFirst, mToggle);
				s.devControl("set:redirects-", "−", rMinus, false, rDec);
				s.devControl("set:redirects+", "+", rPlus, false, rInc);
			}
			if (m5a) {
				s.devControl("set:critique", "Critique and revise", true, f.critique, cToggle);
				for (int n : CritiqueRules.REVISION_CHOICES) {
					s.devControl("set:revisions:" + n, Integer.toString(n), f.critique, f.critique && f.maxRevisions == n, () -> f.maxRevisions = n);
				}
			}
			s.devControl("set:budget-", "−", f.budgetUsd != null, false, bDec);
			s.devControl("set:budget+", "+", bPlus, false, bInc);
			return y;
		}
		int ox = x + CollapsibleSection.INDENT;
		int ow = w - CollapsibleSection.INDENT;
		y += 3;
		if (m4c) {
			Chip c = new Chip(f.massingFirst ? "Massing first: on" : "Massing first: off", mToggle).selected(f.massingFirst);
			int cx = ox + chip(g, "set:massing_first", c, ox, y, mx, my) + 10;
			g.text(font, "Redirects", cx, y + 5, f.massingFirst ? UiStyle.clayText() : UiStyle.mutedText(), false);
			cx += font.width("Redirects") + 4;
			cx = stepper(g, "set:redirects", Integer.toString(f.maxRedirects), font.width("10") + 2, rMinus, rPlus, rDec, rInc, f.massingFirst, cx, y, mx,
				my) + 10;
			muted(g, f.massingFirst ? "each shape waits for your approval in the Designs tab" : "the detail at once", cx, y + 5, ox + ow - cx);
			y += ROW;
		}
		if (m5a) {
			Chip c = new Chip(f.critique ? "Critique and revise: on" : "Critique and revise: off", cToggle).selected(f.critique);
			int cx = ox + chip(g, "set:critique", c, ox, y, mx, my) + 10;
			g.text(font, "Revisions", cx, y + 5, f.critique ? UiStyle.clayText() : UiStyle.mutedText(), false);
			cx += font.width("Revisions") + 4;
			for (int n : CritiqueRules.REVISION_CHOICES) {
				Chip r = new Chip(Integer.toString(n), () -> f.maxRevisions = n).selected(f.critique && f.maxRevisions == n);
				r.disabled(!f.critique);
				cx += chip(g, "set:revisions:" + n, r, cx, y, mx, my) + 3;
			}
			cx += 7;
			muted(g, f.critique ? "a critic scores each building; Claude revises until it ships (experimental)" : "off: each building as designed", cx, y
				+ 5, ox + ow - cx);
			y += ROW;
		}
		label(g, "Budget", ox, y);
		int bx = stepper(g, "set:budget", budget, Math.max(font.width("none"), font.width("$1000")) + 2, f.budgetUsd != null, bPlus, bDec, bInc, true, ox
			+ LABEL_W, y, mx, my) + 10;
		String be = errors.get("budget");
		if (be != null) {
			g.text(font, TextUtil.ellipsize(font, be, ox + ow - bx), bx, y + 5, UiBits.errorText(), false);
		} else {
			muted(g, f.budgetUsd == null ? "no cap: the set runs to the end" : "the set pauses at the cap; extend it from the Designs tab", bx, y + 5, ox
				+ ow - bx);
		}
		y += ROW;
		if (m4c) {
			label(g, "Context", ox, y);
			String ce = errors.get("context");
			TextFieldView.Style cs = new TextFieldView.Style(null, 0, ce != null ? ce : "the site, its purpose, the neighbours, the street side: it goes "
				+ "into every brief", null, f.context.length() > 200 ? f.context.length() + "/" + SetSpec.MAX_CONTEXT : null, UiStyle.mutedText(), 2);
			s.textField(g, Focus.SET_CONTEXT, contextView, f.context, ox + LABEL_W, y, ow - LABEL_W, cs);
			y += TextFieldView.BASE_H + TextFieldView.LINE + 4;
		}
		return y;
	}

	/** The status line, Cancel and Generate, pinned under the body's rule. */
	private void footer(GuiGraphicsExtractor g, SetFeature.Form f, Map<String, String> errors, int x, int w, int footerY, int mx, int my) {
		Font font = font();
		String status;
		boolean bad;
		String armed = removeArm.armedKey(net.minecraft.util.Util.getMillis());
		if (armed != null && armed.startsWith("set:remove:")) {
			status = "Press × again to remove building " + (Integer.parseInt(armed.substring("set:remove:".length())) + 1) + " (Esc keeps it).";
			bad = true;
		} else if (f.sending) {
			status = "Sending…";
			bad = false;
		} else if (f.sendError != null) {
			status = f.sendError;
			bad = true;
		} else if (styleNote != null) {
			status = styleNote;
			bad = true;
		} else if (!Sidecar.connected()) {
			status = "The design helper is not running (Status tab).";
			bad = true;
		} else if (!SetFeature.has("design.groups")) {
			status = "This helper does not design sets (it needs phase 4b).";
			bad = true;
		} else if (!errors.isEmpty()) {
			status = errors.size() == 1 ? "1 thing to fix: " + errors.values().iterator().next() : errors.size() + " things to fix: " + errors.values()
				.iterator().next();
			bad = true;
		} else {
			Bible picked = f.bible == null ? null : SetFeature.bible(f.bible).orElse(null);
			// short enough to read whole at GUI scale 4
			status = "Ready: " + f.items.size() + " buildings, " + (picked == null ? f.bible : picked.name()) + ", " + f.concurrency + " at once"
				+ (f.budgetUsd == null ? "" : String.format(Locale.ROOT, ", max $%.0f", f.budgetUsd)) + (f.draft().massingFirst()
					? "; you approve each massing" : "") + ".";
			bad = false;
		}
		s.statusLineAt(g, status, bad, x, footerY - 13, w);
		int fx = x + w;
		String go = "Generate";
		fx -= s.bw(go);
		s.button(g, "set:submit", go, fx, footerY, s.bw(go), true, errors.isEmpty() && !f.sending && SetFeature.has("design.groups"), mx, my,
			s::submitSet);
		String cancel = "Cancel";
		fx -= s.bw(cancel) + 6;
		s.button(g, "set:cancel", cancel, fx, footerY, s.bw(cancel), false, true, mx, my, s::closeSet);
		String[] hints = {"Tab", "next field", "Esc", "close"};
		if (UiBits.hintsWidth(font, hints) <= fx - x - 6) {
			UiBits.hints(g, font, x, footerY + 4, false, hints);
		}
	}

	/** $5 steps up to $20, then $10 steps; below $1 is none. */
	static @Nullable Double budgetStep(@Nullable Double cur, int dir) {
		double v = cur == null ? 0 : cur;
		double step = v + (dir > 0 ? 0 : -1) >= 20 ? 10 : 5;
		double n = dir > 0 ? (v == 0 ? 5 : v + step) : v - step;
		return n < 1 ? null : Math.min(1000, n);
	}

	static String estimateLine(SetFeature.Form f) {
		if (!SetFeature.has("estimates")) {
			return "no estimate (the helper has none)";
		}
		if (f.estimateError != null) {
			return "estimate: " + f.estimateError;
		}
		if (f.estimate == null) {
			return f.estimating ? "estimating…" : "estimate: fill in the buildings";
		}
		var e = f.estimate;
		String base = String.format(Locale.ROOT, "Estimate: $%.2f–%.2f · %.0f–%.0f min", e.usdLow(), e.usdHigh(), e.minutesLow(), e.minutesHigh());
		// (5a) with critique: the design figures plus the critique's
		String crit = e.critique() ? String.format(Locale.ROOT, " · with critique $%.2f–%.2f, %.0f–%.0f min", e.withCritiqueUsdLow(), e
			.withCritiqueUsdHigh(), e.withCritiqueMinutesLow(), e.withCritiqueMinutesHigh()) : "";
		return base + crit + (f.estimating ? " (updating)" : "");
	}

	/** The bible options: installed ones (newest version), the built-in ones, and (in the set dialog) "New from a prompt…". */
	static List<Option> bibleOptions(@Nullable String current, boolean withNew) {
		List<Option> out = new ArrayList<>();
		for (Bible b : SetFeature.bibles()) {
			// (5a) an archived bible is hidden from the pickers (unless it is the one picked)
			if (b.archived() && !b.id().equals(current)) {
				continue;
			}
			out.add(new Option(b.id(), b.builtin() ? b.name() : b.name() + " v" + b.version(), b.id().equals(current)));
		}
		if (withNew) {
			out.add(new Option("new", "New from a prompt…", false));
		}
		return out;
	}

	static List<Option> typeOptions(String current) {
		List<Option> out = new ArrayList<>();
		for (DesignSpec.Choice c : DesignSpec.TYPES) {
			out.add(new Option(c.id(), c.label(), c.id().equals(current)));
		}
		return out;
	}

	/** One line on the bible job drafting the new bible. */
	static @Nullable String bibleJobLine(@Nullable String jobId) {
		if (jobId == null) {
			return "Describe the place; the helper drafts a bible (roles, prose, components, a sample sheet), then it is picked here.";
		}
		var raw = Sidecar.state().bibleJob(jobId);
		if (raw == null) {
			return "Bible job " + jobId + ": queued";
		}
		BibleJob j = Wire4b.bibleJob(raw);
		return "Bible job " + j.id() + " (" + j.bibleId() + "): " + j.status().name().toLowerCase(Locale.ROOT) + (j.step().isEmpty() ? "" : " · "
			+ j.step()) + j.error().map(e -> " · " + e).orElse("");
	}
}
