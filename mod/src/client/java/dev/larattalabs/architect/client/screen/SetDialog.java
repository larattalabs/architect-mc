package dev.larattalabs.architect.client.screen;

import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BibleJob;
import dev.larattalabs.architect.apiimpl.Wire4b;
import dev.larattalabs.architect.client.design.SetFeature;
import dev.larattalabs.architect.client.hud.UiBits;
import dev.larattalabs.architect.client.screen.ArchitectScreen.Focus;
import dev.larattalabs.architect.client.screen.ArchitectScreen.Option;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.text.TextFieldView;
import dev.larattalabs.architect.client.text.TextModel;
import dev.larattalabs.architect.client.ui.Panels;
import dev.larattalabs.architect.client.ui.TextUtil;
import dev.larattalabs.architect.client.ui.UiStyle;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.architect.design.SetSpec;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import org.jspecify.annotations.Nullable;

/**
 * The Design tab's "Design a set…" dialog (docs/CONTRACT.md phase 4b "Design groups"): a name, a style bible (pick one, or
 * "New from prompt…", which drafts one with {@code bible.request}), up to 24 buildings (type, name, landmark or ordinary,
 * notes), the concurrency and a budget, and the live estimate before "Design the set". Drawn by {@link ArchitectScreen} into
 * its hit list; the model is {@link SetFeature}. Client thread.
 */
final class SetDialog {
	static final int ROW_H = 20;
	/** Text fields drawn per item row, in Tab order. */
	static final Focus[] ITEM_FIELDS = {Focus.SET_TYPE, Focus.SET_INAME, Focus.SET_NOTES};

	private final ArchitectScreen s;
	private final TextFieldView nameView = new TextFieldView();
	private final TextFieldView promptView = new TextFieldView();
	private final List<TextFieldView[]> rowViews = new ArrayList<>();

	SetDialog(ArchitectScreen s) {
		this.s = s;
	}

	private Font font() {
		return s.font();
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

	void draw(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my) {
		SetFeature.Form f = SetFeature.form();
		if (f == null) {
			return;
		}
		SetFeature.tick();
		Font font = font();
		Map<String, String> errors = f.errors();
		int y = top - 3;
		g.text(font, "Design a set", x, y + 1, UiStyle.CLAY_DARK, false);
		String sub = "One style bible for every building, several designed at once; landmarks first, the rest see their renders.";
		g.text(font, TextUtil.ellipsize(font, sub, w - font.width("Design a set") - 10), x + font.width("Design a set") + 10, y + 1, UiBits.muted(), false);
		y += 13;
		// name + bible
		int nameW = Math.min(200, (w - 12) / 2);
		label(g, "Name", errors.get("name"), x, y, nameW);
		int bx = x + nameW + 12;
		int bw = w - nameW - 12;
		label(g, "Style bible", errors.get("bible"), bx, y, bw);
		y += 11;
		s.textField(g, Focus.SET_NAME, nameView, f.name, x, y, nameW, new TextFieldView.Style(null, 0, "e.g. Ashfall hamlet", null, null, 0, 1));
		String bl = f.newBible ? "New from a prompt… ▾" : f.bible == null ? "pick one ▾" : SetFeature.bible(f.bible).map(b -> b.name()
			+ (b.builtin() ? " (built in)" : " v" + b.version())).orElse(f.bible) + " ▾";
		int ddW = Math.min(180, bw);
		int ddY = y + 2;
		s.dropdown(g, "set:bible", bl, bx, ddY, ddW, mx, my, () -> s.openPopup("set:bible", bx, ddY + ArchitectScreen.CHIP_H + 1, Math.max(260, ddW),
			bibleOptions(f.bible, true), v -> {
				if ("new".equals(v)) {
					f.newBible = true;
					f.bible = null;
				} else {
					f.newBible = false;
					f.bible = v;
				}
			}));
		Bible picked = f.bible == null ? null : SetFeature.bible(f.bible).orElse(null);
		if (picked != null && bw - ddW > 40) {
			RolesSwatch.draw(g, picked, bx + ddW + 6, y + 1, bw - ddW - 6);
		}
		y += TextFieldView.BASE_H + 4;
		// the new bible's prompt, or what the picked one is
		if (f.newBible) {
			String go = f.bibleJob == null ? "Draft bible" : "Drafting…";
			int gw = s.bw(go);
			s.textField(g, Focus.SET_PROMPT, promptView, f.prompt, x, y, w - gw - 6, new TextFieldView.Style("Prompt ", UiStyle.CLAY_DARK,
				"what the place is, e.g. hellish evil lair, mining facility", null, null, 0, 1));
			s.button(g, "set:draft_bible", go, x + w - gw, y - 1, gw, false, f.bibleJob == null && !f.sending && SetFeature.has("bibles"), mx, my,
				SetFeature::draftBible);
			y += TextFieldView.BASE_H + 2;
			String line = bibleJobLine(f.bibleJob);
			if (line != null) {
				g.text(font, TextUtil.ellipsize(font, line, w), x, y, UiBits.muted(), false);
			}
			y += 11;
		}
		// the buildings
		g.text(font, "Buildings (" + f.items.size() + "/" + SetSpec.MAX_ITEMS + ")", x, y, UiStyle.CLAY_DARK, false);
		String err = errors.get("items");
		if (err != null) {
			g.text(font, TextUtil.ellipsize(font, err, w / 2), x + 110, y, UiBits.errorText(), false);
		}
		int typeW = 92;
		int nameColW = 110;
		int roleW = 62;
		int delW = 12;
		int notesX = x + 16 + typeW + 14 + nameColW + 4 + roleW + 4;
		int notesW = x + w - 10 - delW - 4 - notesX;
		g.text(font, "type", x + 16, y + 12, UiBits.muted(), false);
		g.text(font, "name", x + 16 + typeW + 14, y + 12, UiBits.muted(), false);
		g.text(font, "role", x + 16 + typeW + 14 + nameColW + 4, y + 12, UiBits.muted(), false);
		g.text(font, "notes", notesX, y + 12, UiBits.muted(), false);
		y += 22;
		int bottomBlock = 34; // add row + concurrency/budget/estimate
		int listH = Math.max(ROW_H, footerY - 16 - bottomBlock - y);
		int fit = Math.max(1, listH / ROW_H);
		s.setScrollArea(x, y, w - 6, fit * ROW_H, f.items.size() * ROW_H, ROW_H);
		int first = Math.min(s.scroll() / ROW_H, Math.max(0, f.items.size() - fit));
		for (int i = first; i < Math.min(f.items.size(), first + fit); i++) {
			SetFeature.Item it = f.items.get(i);
			int ry = y + (i - first) * ROW_H;
			int idx = i;
			String rowErr = errors.get("item" + (i + 1));
			g.text(font, Integer.toString(i + 1), x + 2, ry + 5, rowErr != null ? UiBits.errorText() : UiBits.muted(), false);
			TextFieldView[] v = views(i);
			int tx = x + 16;
			s.textField(g, Focus.SET_TYPE, i, v[0], it.type, tx, ry, typeW, new TextFieldView.Style(null, 0, "type", null, null, 0, 1));
			s.chip(g, "set:type_pick:" + i, "▾", tx + typeW + 1, ry + 2, false, true, mx, my, () -> s.openPopup("set:type:" + idx, tx, ry + 19, 280,
				typeOptions(it.type.value()), val -> it.type.set(val)));
			s.textField(g, Focus.SET_INAME, i, v[1], it.name, tx + typeW + 14, ry, nameColW, new TextFieldView.Style(null, 0, "name (optional)", null,
				null, 0, 1));
			int rx = tx + typeW + 14 + nameColW + 4;
			s.chip(g, "set:role:" + i, it.landmark ? "landmark" : "ordinary", rx, ry + 2, it.landmark, true, mx, my, () -> it.landmark = !it.landmark);
			s.textField(g, Focus.SET_NOTES, i, v[2], it.notes, notesX, ry, notesW, new TextFieldView.Style(null, 0, rowErr != null ? rowErr
				: "anything the designer should know", null, null, 0, 1));
			s.chip(g, "set:remove:" + i, "×", x + w - 10 - delW, ry + 2, false, f.items.size() > 1, mx, my, () -> {
				s.setFocusPublic(Focus.NONE);
				f.removeItem(idx);
			});
		}
		s.scrollbarAt(g, x + w - 7, y, fit * ROW_H);
		y += fit * ROW_H + 2;
		int ax = x;
		ax += s.chip(g, "set:add", "+ Add a building", ax, y, false, f.items.size() < SetSpec.MAX_ITEMS, mx, my, () -> {
			f.addItem();
			s.scrollTo(f.items.size() * ROW_H); // the new row in view
		}) + 8;
		g.text(font, TextUtil.ellipsize(font, "landmarks: Opus, designed first · ordinary: Sonnet", Math.max(10, x + w - ax)), ax, y + 3, UiBits.muted(),
			false);
		y += ArchitectScreen.CHIP_H + 4;
		// concurrency, budget, estimate
		int cx = x;
		g.text(font, "At once", cx, y + 3, UiStyle.CLAY_DARK, false);
		cx += font.width("At once") + 4;
		cx += s.chip(g, "set:concurrency-", "−", cx, y, false, f.concurrency > SetSpec.MIN_CONCURRENCY, mx, my, () -> f.concurrency--) + 2;
		String cv = Integer.toString(f.concurrency);
		g.text(font, cv, cx + 2, y + 3, UiBits.ink(), false);
		cx += font.width("0") + 6;
		cx += s.chip(g, "set:concurrency+", "+", cx, y, false, f.concurrency < SetSpec.MAX_CONCURRENCY, mx, my, () -> f.concurrency++) + 12;
		g.text(font, "Budget", cx, y + 3, UiStyle.CLAY_DARK, false);
		cx += font.width("Budget") + 4;
		cx += s.chip(g, "set:budget-", "−", cx, y, false, f.budgetUsd != null, mx, my, () -> f.budgetUsd = budgetStep(f.budgetUsd, -1)) + 2;
		String bv = f.budgetUsd == null ? "none" : String.format(Locale.ROOT, "$%.0f", f.budgetUsd);
		g.text(font, bv, cx + 2, y + 3, UiBits.ink(), false);
		cx += Math.max(font.width("none"), font.width("$100")) + 6;
		cx += s.chip(g, "set:budget+", "+", cx, y, false, f.budgetUsd == null || f.budgetUsd < 1000, mx, my, () -> f.budgetUsd = budgetStep(f.budgetUsd,
			1)) + 12;
		String est = estimateLine(f);
		g.text(font, TextUtil.ellipsize(font, est, Math.max(10, x + w - cx)), cx, y + 3, f.estimateError != null ? UiBits.errorText() : UiStyle.color("palette.ui.teal_text", 0xFF1E7472),
			false);
		// footer
		String status;
		boolean bad;
		if (f.sending) {
			status = "Sending…";
			bad = false;
		} else if (f.sendError != null) {
			status = f.sendError;
			bad = true;
		} else if (!Sidecar.connected()) {
			status = "The design helper is not running (Status tab).";
			bad = true;
		} else if (!SetFeature.has("design.groups")) {
			status = "This helper does not design sets (it needs phase 4b).";
			bad = true;
		} else if (!errors.isEmpty()) {
			status = errors.size() == 1 ? errors.values().iterator().next() : errors.size() + " things to fix: " + errors.values().iterator().next();
			bad = true;
		} else {
			status = "Ready: " + f.items.size() + " buildings with " + (picked == null ? f.bible : picked.name()) + ", " + f.concurrency + " at a time"
				+ (f.budgetUsd == null ? "" : String.format(Locale.ROOT, ", at most $%.0f", f.budgetUsd)) + ".";
			bad = false;
		}
		s.statusLineAt(g, status, bad, x, footerY - 13, w);
		int fx = x + w;
		String go = "Design the set";
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

	private void label(GuiGraphicsExtractor g, String text, @Nullable String err, int x, int y, int w) {
		Font font = font();
		g.text(font, text, x, y, UiStyle.CLAY_DARK, false);
		if (err != null) {
			int ex = x + font.width(text) + 6;
			g.text(font, TextUtil.ellipsize(font, err, Math.max(10, x + w - ex)), ex, y, UiBits.errorText(), false);
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
		return String.format(Locale.ROOT, "Estimate: $%.2f–%.2f · %.0f–%.0f min%s", e.usdLow(), e.usdHigh(), e.minutesLow(), e.minutesHigh(),
			f.estimating ? " (updating)" : "");
	}

	/** The bible options: installed ones (newest version), the built-in ones, and (in the set dialog) "New from a prompt…". */
	static List<Option> bibleOptions(@Nullable String current, boolean withNew) {
		List<Option> out = new ArrayList<>();
		for (Bible b : SetFeature.bibles()) {
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
