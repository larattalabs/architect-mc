package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.client.design.SetFeature;
import dev.larattalabs.architect.client.library.LibraryFeature;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.architect.library.StyleDraft;
import dev.larattalabs.architect.library.StyleForm;
import dev.larattalabs.architect.library.StyleRoles;
import dev.larattalabs.labui.client.picker.CompactPicker;
import dev.larattalabs.labui.client.picker.PickerScreen;
import dev.larattalabs.labui.client.picker.PickerSpec;
import dev.larattalabs.labui.client.text.TextModel;
import dev.larattalabs.labui.client.ui.Kit;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.labui.client.widget.Button;
import dev.larattalabs.labui.client.widget.Chip;
import dev.larattalabs.labui.client.widget.CollapsibleSection;
import dev.larattalabs.labui.client.widget.Paint;
import dev.larattalabs.labui.ui.ScrollMath;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) The Style editor: a new version of the player's own Style (Edit, "Save v3") or a new hand-made one (Duplicate, a
 * start from a built-in: "Save style"). Left: the name, the tags, the four main rows (each saying what it drives), then folded: every
 * role ("More roles"), a settlement Style's roles, and the water / wall / pattern / tier slots (read-only: each names a role). Right: a
 * live preview sheet from the roles, the test-house check ({@code bible.check}: the kit's validation, nothing saved; Save is refused
 * while it fails), the suggested features (at most 6) and the shape hints. Save is {@code bible.save} (free): every save is a new
 * version, so designs and settlements pinned to the old one keep it. Client thread.
 */
final class StyleEditorScreen extends U3Screen {
	private static final long CHECK_DEBOUNCE_MS = 400;
	private final StyleDraft draft;
	private final TextModel name = new TextModel(StyleDraft.MAX_NAME);
	private final TextModel tagInput = new TextModel(60);
	private final Field nameField;
	private final Field tagField;
	private final Map<String, CompactPicker> rows = new HashMap<>();
	private final Map<String, String> rowKeys = new HashMap<>();
	private final CollapsibleSection moreRoles = new CollapsibleSection("architect_mc.style_editor.roles", "More roles", false);
	private final CollapsibleSection settlement = new CollapsibleSection("architect_mc.style_editor.settlement", "Settlement roles", false);
	private final CollapsibleSection slots = new CollapsibleSection("architect_mc.style_editor.slots", "Water & wall slots", false);
	private final Button save;
	private final Button cancel = new Button("Cancel", this::back);
	private final String basedOn;
	private int scroll;
	private int contentH;
	private int[] view = new int[4];
	private int barGrab = -1;
	// the test-house check
	private @Nullable String checkKey;
	private @Nullable String sentKey;
	private long changedAt;
	private boolean checking;
	private @Nullable JsonObject check;
	private @Nullable String status;
	private boolean statusError;
	private boolean saving;
	private @Nullable Bible saved;

	private StyleEditorScreen(StyleDraft draft, String basedOn, @Nullable Screen parent) {
		super(draft.mode() == StyleDraft.Mode.EDIT ? "Edit style" : "New style", parent);
		this.draft = draft;
		this.basedOn = basedOn;
		name.set(draft.name());
		nameField = field("name", name, "a name", 1);
		tagField = field("tag", tagInput, "+ tag", 1);
		tagField.onEnter = this::addTag;
		save = new Button(draft.saveLabel(), this::save).primary(true);
	}

	/** The editor on {@code b}: a new version of it ({@code edit}; the player's own only), else a copy (a new Style based on it). */
	static StyleEditorScreen open(Bible b, boolean edit, @Nullable Screen parent) {
		JsonObject full = fullJson(b);
		StyleDraft d = edit ? StyleDraft.edit(b, full, StyleRoles.fallback(), LibraryFeature.palettes()) : StyleDraft.copy(b, full, null, StyleRoles
			.fallback(), LibraryFeature.palettes());
		String based = edit ? b.basedOn().map(p -> "Based on " + SetFeature.bible(p.id()).map(Bible::name).orElse(p.id()) + " v" + p.version())
			.orElse(b.builtin() ? "Built-in" : "Made from scratch") : "Based on " + b.name() + (b.builtin() ? "" : " v" + b.version());
		return new StyleEditorScreen(d, based, parent);
	}

	/** Its {@code bible.json} as stored (the shape hints and slots ride along), from the helper's index {@code dir}; null for a built-in. */
	static @Nullable JsonObject fullJson(Bible b) {
		for (JsonObject o : Sidecar.state().bibleIndex()) {
			if (o.has("id") && o.get("id").getAsString().equals(b.id()) && o.has("dir")) {
				Path f = Path.of(o.get("dir").getAsString()).resolve("bible.json");
				try {
					return Files.isRegularFile(f) ? JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject() : null;
				} catch (Exception e) {
					Architect.LOGGER.warn("style editor: {} unreadable ({})", f, e.toString());
				}
			}
		}
		return null;
	}

	StyleDraft draft() {
		return draft;
	}

	@Override
	protected String title() {
		return (draft.mode() == StyleDraft.Mode.EDIT ? "Edit style · " + draft.name() + " (" + draft.saveLabel().replace("Save ", "saves ") + ")"
			: "New style · " + draft.name());
	}

	@Override
	protected String hint() {
		return "Ctrl+Enter save · Esc back";
	}

	@Override
	protected void edited(Field f) {
		if (f == nameField) {
			draft.setName(name.value());
		}
	}

	private void addTag() {
		if (draft.addTag(tagInput.value()) > 0) {
			tagInput.clear();
		}
	}

	// ------------------------------------------------------------------ drawing

	@Override
	protected void body(GuiGraphicsExtractor g, int x, int top, int w, int bottom, int mx, int my) {
		tickCheck();
		int footerTop = bottom - Button.H - 8;
		g.fill(x, footerTop - 3, x + w, footerTop - 2, UiStyle.rule());
		int lw = Math.max(200, (w - 18) * 58 / 100);
		if (lw > w - 140) {
			lw = w - 140;
		}
		int lx = x + 8;
		int rx = x + 8 + lw + 10;
		int rw = x + w - 8 - rx;
		// left: scrolls
		int vy = top + 4;
		int vh = footerTop - 6 - vy;
		view = new int[] {lx, vy, lw, vh};
		scroll = Math.max(0, Math.min(scroll, ScrollMath.maxOffset(contentH, vh)));
		g.enableScissor(lx, vy, lx + lw, vy + vh);
		int y0 = vy - scroll;
		int y = left(g, lx, y0, lw - 9, mx, my, vy, vy + vh);
		contentH = y - y0 + 4;
		g.disableScissor();
		if (contentH > vh) {
			int bx = lx + lw - 6;
			Panels.sprite(g, Kit.SCROLL_TRACK, bx, vy, 6, vh);
			ScrollMath.Thumb t = ScrollMath.thumb(vh, contentH, vh, scroll);
			Panels.sprite(g, barGrab >= 0 ? Kit.SCROLL_THUMB_HOVER : Kit.SCROLL_THUMB, bx, vy + t.y(), 6, t.h());
		}
		g.fill(rx - 6, vy, rx - 5, vy + vh, UiStyle.rule());
		right(g, rx, vy, rw, vy + vh, mx, my);
		// footer
		Map<String, String> errors = draft.errors();
		boolean checkFailed = check != null && check.has("ok") && !check.get("ok").getAsBoolean() && draft.bible().toString().equals(sentKey);
		String why = saving ? "Saving…" : !errors.isEmpty() ? errors.values().iterator().next() : checkFailed ? "The test house fails: fix the roles"
			: !SetFeature.has("bible.save") ? "This design helper can't save Styles (update it)" : null;
		save.label(draft.saveLabel()).disabled(why != null).tooltip(why);
		int sw = save.width(font);
		save.draw(g, font, x + w - 8 - sw, footerTop, sw, Button.H, mx, my);
		control("save", save);
		int cw = cancel.width(font);
		cancel.draw(g, font, x + w - 8 - sw - 6 - cw, footerTop, cw, Button.H, mx, my);
		control("cancel", cancel);
		String note = status != null ? status : draft.mode() == StyleDraft.Mode.EDIT
			? "Saves a new version: designs and settlements pinned to the old one keep it" : "Saves a new Style of yours: the one it copies is unchanged";
		g.text(font, TextUtil.ellipsize(font, note, w - 30 - sw - cw), x + 8, footerTop + 6, status != null && statusError ? UiStyle.error()
			: UiStyle.mutedText(), false);
	}

	private boolean visible(int y, int h, int top, int bottom) {
		return y + h > top && y < bottom;
	}

	private int left(GuiGraphicsExtractor g, int x, int y, int w, int mx, int my, int top, int bottom) {
		int labelW = 46;
		int mY = my >= top && my < bottom ? my : -1000;
		// name
		g.text(font, "Name", x, y + 5, UiStyle.CLAY_DARK, false);
		if (visible(y, 18, top, bottom)) {
			drawField(g, nameField, x + labelW, y, w - labelW);
		}
		y += 22;
		// tags: chips with ×, then the "+ tag" field
		g.text(font, "Tags", x, y + 5, UiStyle.CLAY_DARK, false);
		int tx = x + labelW;
		for (String t : draft.tags()) {
			Chip c = new Chip(t + " ×", () -> draft.removeTag(t)).selected(true);
			int cwid = c.width(font);
			if (tx + cwid > x + w - 70) {
				tx = x + labelW;
				y += Chip.H + 3;
			}
			c.draw(g, font, tx, y, mx, mY);
			register("tag:remove:" + t, c, top, bottom);
			tx += cwid + 4;
		}
		if (visible(y, 18, top, bottom)) {
			drawField(g, tagField, tx, y, Math.max(60, Math.min(110, x + w - tx)));
		}
		y += Chip.H + 6;
		// the four main rows
		g.text(font, "Main materials", x, y + 2, UiStyle.CLAY_DARK, false);
		y += 13;
		StyleForm m = draft.materials();
		for (String field : StyleRoles.MAIN_FIELDS) {
			String cur = m.main() == null ? null : m.main().get(field);
			g.text(font, Character.toUpperCase(field.charAt(0)) + field.substring(1), x, y + 5, UiBits.ink(), false);
			CompactPicker cp = picker(field, cur);
			int used = cp.draw(g, font, x + labelW, y, w - labelW, mx, mY);
			if (visible(y, Chip.H, top, bottom)) {
				targets.add(clip(cp, top, bottom));
			}
			for (String id : cp.choices()) {
				registerDev("material:" + field + "=" + id, () -> pickMain(field, id));
			}
			registerDev("palette:" + field, cp::openBrowser);
			y += Chip.H + 1;
			String drives = "drives " + StyleDraft.DRIVES.get(field);
			g.text(font, TextUtil.ellipsize(font, drives, w - labelW), x + labelW, y + 1, UiStyle.mutedText(), false);
			y += 12;
			if (used < 0) {
				break;
			}
		}
		y += 4;
		// more roles (every role: the core ones and the Style's own extras)
		long following = m.provenance().values().stream().filter(p -> p.startsWith("follows_")).count();
		moreRoles.summary(m.roles().size() + " · " + following + " follow a main row");
		y += moreRoles.draw(g, font, x, y, w, mx, mY);
		register("section:more_roles", moreRoles, top, bottom);
		if (moreRoles.open()) {
			List<String> order = new ArrayList<>(StyleDraft.CORE_ROLES);
			order.addAll(draft.extraRoles());
			y = roleRows(g, x + CollapsibleSection.INDENT, y + 2, w - CollapsibleSection.INDENT, order, mx, mY, top, bottom);
		}
		List<String> towns = draft.settlementRoles();
		if (!towns.isEmpty() || "settlement".equals(draft.scope())) {
			settlement.summary(towns.size() + (towns.isEmpty() ? " (a settlement Style)" : ": " + String.join(", ", towns)));
			y += settlement.draw(g, font, x, y, w, mx, mY);
			register("section:settlement", settlement, top, bottom);
			if (settlement.open()) {
				y = roleRows(g, x + CollapsibleSection.INDENT, y + 2, w - CollapsibleSection.INDENT, towns, mx, mY, top, bottom);
			}
		}
		List<StyleDraft.Slot> sl = draft.slots();
		slots.summary(sl.isEmpty() ? "none set" : sl.size() + " set (read-only: each names a role)");
		y += slots.draw(g, font, x, y, w, mx, mY);
		register("section:slots", slots, top, bottom);
		if (slots.open()) {
			int sx = x + CollapsibleSection.INDENT;
			if (sl.isEmpty()) {
				g.text(font, TextUtil.ellipsize(font, "This Style sets no water, wall, pattern or tier slots.", w - 12), sx, y + 3, UiStyle.mutedText(), false);
				y += 13;
			}
			for (StyleDraft.Slot s : sl) {
				String line = s.field() + "." + s.key() + ": " + s.text();
				g.text(font, "🔒", sx, y + 3, UiStyle.mutedText(), false);
				g.text(font, TextUtil.ellipsize(font, line, w - 26), sx + 12, y + 3, UiBits.ink(), false);
				y += 12;
			}
		}
		return y + 6;
	}

	private int roleRows(GuiGraphicsExtractor g, int x, int y, int w, List<String> roles, int mx, int my, int top, int bottom) {
		StyleForm m = draft.materials();
		for (String role : roles) {
			String block = m.roles().get(role);
			if (block == null) {
				continue;
			}
			g.text(font, TextUtil.ellipsize(font, role.replace('_', ' '), 62), x, y + 5, UiBits.ink(), false);
			Chip c = new Chip(dev.larattalabs.architect.library.Swatches.label(block), () -> openRole(role, block)).swatch(StylePaint.rgb(block));
			int cwid = Math.min(c.width(font), Math.max(60, w - 66 - 80));
			c.draw(g, font, x + 66, y, cwid, mx, my);
			register("role:" + role, c, top, bottom);
			String prov = DesignEditor.provenanceLabel(m.provenance().get(role), m.base());
			DesignEditor.marker(g, font, prov, x + 66 + cwid + 4, y + 4, w - 66 - cwid - 4);
			y += Chip.H + 2;
		}
		return y + 2;
	}

	private void right(GuiGraphicsExtractor g, int x, int y, int w, int bottom, int mx, int my) {
		int sh = Math.max(40, Math.min(96, w * 55 / 100));
		Panels.inset(g, x, y, w, sh);
		StylePaint.sheet(g, draft.roles(), x + 1, y + 1, w - 2, sh - 2);
		y += sh + 4;
		g.text(font, TextUtil.ellipsize(font, basedOn, w), x, y, UiStyle.mutedText(), false);
		y += 12;
		// the test-house check
		String line;
		int fill;
		int ink;
		if (!SetFeature.has("bible.check")) {
			line = "This helper can't check before saving (update it); Save checks the test house.";
			fill = UiStyle.withAlpha(UiStyle.PAPER, 255);
			ink = UiStyle.mutedText();
		} else if (checking || check == null || !draft.bible().toString().equals(sentKey)) {
			line = "Checking the test house…";
			fill = UiStyle.withAlpha(UiStyle.PAPER, 255);
			ink = UiStyle.mutedText();
		} else if (check.get("ok").getAsBoolean()) {
			line = "Test house builds and passes the checker" + (check.getAsJsonArray("warnings").isEmpty() ? "." : " (" + check.getAsJsonArray("warnings")
				.size() + " note" + (check.getAsJsonArray("warnings").size() == 1 ? "" : "s") + ").");
			fill = 0xFFDDEBD9;
			ink = UiStyle.color("palette.ui.ok_text", 0xFF2E6B3A);
		} else {
			JsonArray errs = check.getAsJsonArray("errors");
			line = "Test house fails: " + (errs.isEmpty() ? "?" : errs.get(0).getAsString());
			fill = 0xFFF3D9D2;
			ink = UiStyle.error();
		}
		List<String> lines = TextUtil.wrapPlain(font, line, w - 8);
		int bh = Math.min(4, lines.size()) * 10 + 6;
		Paint.box(g, x, y, w, bh, fill, UiStyle.withAlpha(ink, 120));
		int ly = y + 4;
		for (String l : lines.stream().limit(4).toList()) {
			g.text(font, l, x + 4, ly, ink, false);
			ly += 10;
		}
		y += bh + 6;
		// suggested features
		g.text(font, "Suggested features", x, y, UiStyle.CLAY_DARK, false);
		g.text(font, "(max " + StyleForm.MAX_FEATURES + ")", x + font.width("Suggested features") + 4, y, UiStyle.mutedText(), false);
		y += 11;
		int fx = x;
		for (DesignSpec.Choice c : DesignSpec.FEATURES) {
			boolean on = draft.features().contains(c.id());
			Chip ch = new Chip(c.label(), () -> {
				try {
					draft.toggleFeature(c.id());
				} catch (IllegalArgumentException e) {
					status = e.getMessage();
					statusError = true;
				}
			}).selected(on);
			ch.disabled(!on && draft.features().size() >= StyleForm.MAX_FEATURES);
			int cwid = ch.width(font);
			if (fx > x && fx + cwid > x + w) {
				fx = x;
				y += Chip.H + 2;
			}
			if (y + Chip.H > bottom) {
				break;
			}
			ch.draw(g, font, fx, y, mx, my);
			control("feature:" + c.id(), ch);
			fx += cwid + 3;
		}
		y += Chip.H + 6;
		// shape hints (read-only: they ride along unchanged)
		List<String> hints = draft.shapeHints();
		if (y + 10 < bottom) {
			g.text(font, "Shape hints", x, y, UiStyle.CLAY_DARK, false);
			y += 11;
		}
		if (hints.isEmpty() && y + 10 < bottom) {
			g.text(font, TextUtil.ellipsize(font, "none: the designer chooses the shape", w), x, y, UiStyle.mutedText(), false);
		}
		for (String h : hints) {
			for (String l : TextUtil.wrapPlain(font, h, w)) {
				if (y + 10 > bottom) {
					return;
				}
				g.text(font, l, x, y, UiBits.ink(), false);
				y += 10;
			}
		}
	}

	/** A main row's compact picker, made again when its value or the roles change. */
	private CompactPicker picker(String field, @Nullable String cur) {
		String key = cur + "|" + draft.roles().hashCode();
		CompactPicker cp = rows.get(field);
		if (cp == null || !key.equals(rowKeys.get(field))) {
			PickerSpec spec = StylePaint.material(field, cur, draft.roles(), v -> pickMain(field, v));
			cp = new CompactPicker(spec);
			rows.put(field, cp);
			rowKeys.put(field, key);
		}
		return cp;
	}

	private void pickMain(String field, String value) {
		try {
			draft.materials().editMain(field, value);
			status = null;
		} catch (RuntimeException e) {
			status = e.getMessage();
			statusError = true;
		}
	}

	private void openRole(String role, String block) {
		minecraft.gui.setScreen(new PickerScreen(StylePaint.role(role, block, b -> setRole(role, b)), this));
	}

	void setRole(String role, String block) {
		try {
			draft.materials().setRole(role, block);
			status = null;
		} catch (RuntimeException e) {
			status = e.getMessage();
			statusError = true;
		}
	}

	private ArchitectScreen.MouseTarget clip(CompactPicker cp, int top, int bottom) {
		return (mx, my, b) -> my >= top && my < bottom && cp.mouseClicked(mx, my, b);
	}

	private void register(String id, dev.larattalabs.labui.client.widget.Control c, int top, int bottom) {
		if (c.shown() && c.y() + c.height() > top && c.y() < bottom) {
			control(id, c);
		} else if (c.shown()) {
			devOnly.put(id, c::press);
		}
	}

	private final Map<String, Runnable> devOnly = new HashMap<>();

	private void registerDev(String id, Runnable r) {
		devOnly.put(id, r);
	}

	@Override
	boolean click(String id) {
		if (super.click(id)) {
			return true;
		}
		Runnable r = devOnly.get(id);
		if (r != null) {
			r.run();
			return true;
		}
		return false;
	}

	// ------------------------------------------------------------------ the check and the save

	private void tickCheck() {
		if (!SetFeature.has("bible.check") || !Sidecar.connected()) {
			return;
		}
		String key = draft.bible().toString();
		long now = Util.getMillis();
		if (!key.equals(checkKey)) {
			checkKey = key;
			changedAt = now;
		}
		if (!checking && !key.equals(sentKey) && now - changedAt >= CHECK_DEBOUNCE_MS) {
			JsonObject m = draft.checkRequest();
			m.addProperty("type", "bible.check");
			checking = true;
			String k = key;
			Sidecar.link().send(m).whenComplete((ack, err) -> minecraft.execute(() -> {
				checking = false;
				sentKey = k;
				if (err != null || !ack.ok() || ack.result() == null) {
					JsonObject o = new JsonObject();
					o.addProperty("ok", false);
					JsonArray e = new JsonArray();
					e.add("the check didn't run: " + (err != null ? err.getMessage() : ack.error()));
					o.add("errors", e);
					o.add("warnings", new JsonArray());
					check = o;
				} else {
					check = ack.result();
				}
			}));
		}
	}

	@Override
	protected boolean ctrlEnter() {
		if (!save.isDisabled()) {
			save();
		}
		return true;
	}

	void save() {
		if (saving || !draft.errors().isEmpty()) {
			return;
		}
		JsonObject req = draft.saveRequest();
		saving = true;
		status = "Saving…";
		statusError = false;
		dev.larattalabs.architect.apiimpl.ApiImpl.biblesImpl().save(req.has("bibleId") ? req.get("bibleId").getAsString() : null, req.getAsJsonObject(
			"bible"), null).whenComplete((b, err) -> minecraft.execute(() -> {
				saving = false;
				if (err != null) {
					Throwable c = err.getCause() != null ? err.getCause() : err;
					status = "Not saved: " + c.getMessage();
					statusError = true;
					return;
				}
				saved = b;
				LibraryFeature.say("Saved " + b.name() + " v" + b.version() + (draft.mode() == StyleDraft.Mode.EDIT ? " (designs pinned to older versions keep them)"
					: ""), false);
				// back to a fresh browser with the saved Style selected (the old one lists the Styles as they were)
				if (parent instanceof StyleBrowserScreen sb) {
					StyleBrowserScreen fresh = sb.reopen(b.id());
					minecraft.gui.setScreen(fresh);
				} else {
					back();
				}
			}));
	}

	/** DevBridge: name, tags to add, main rows, roles, features to toggle. */
	void fill(JsonObject f) {
		if (f.has("name")) {
			name.set(f.get("name").getAsString());
			draft.setName(name.value());
		}
		if (f.has("addTags")) {
			draft.addTag(f.get("addTags").getAsString());
		}
		if (f.has("removeTag")) {
			draft.removeTag(f.get("removeTag").getAsString());
		}
		if (f.has("main")) {
			for (var e : f.getAsJsonObject("main").entrySet()) {
				draft.materials().editMain(e.getKey(), e.getValue().getAsString());
			}
		}
		if (f.has("roles")) {
			for (var e : f.getAsJsonObject("roles").entrySet()) {
				draft.materials().setRole(e.getKey(), e.getValue().getAsString());
			}
		}
		if (f.has("features")) {
			for (var e : f.getAsJsonArray("features")) {
				draft.toggleFeature(e.getAsString());
			}
		}
	}

	@Override
	JsonObject stateJson() {
		JsonObject o = new JsonObject();
		o.addProperty("screen", "style_editor");
		o.addProperty("mode", draft.mode().name().toLowerCase(java.util.Locale.ROOT));
		o.addProperty("styleId", draft.id());
		o.addProperty("saveLabel", draft.saveLabel());
		o.addProperty("name", draft.name());
		JsonArray tags = new JsonArray();
		draft.tags().forEach(tags::add);
		o.add("tags", tags);
		o.add("view", draft.materials().view());
		JsonArray fe = new JsonArray();
		draft.features().forEach(fe::add);
		o.add("features", fe);
		JsonObject errs = new JsonObject();
		draft.errors().forEach(errs::addProperty);
		o.add("errors", errs);
		o.add("check", check == null ? com.google.gson.JsonNull.INSTANCE : check);
		o.addProperty("checkCurrent", check != null && draft.bible().toString().equals(sentKey));
		o.addProperty("checking", checking);
		o.addProperty("dirty", draft.dirty());
		o.addProperty("status", status);
		o.addProperty("saveEnabled", !save.isDisabled());
		o.add("request", draft.saveRequest());
		if (saved != null) {
			o.addProperty("saved", saved.id() + " v" + saved.version());
		}
		JsonArray hints = new JsonArray();
		draft.shapeHints().forEach(hints::add);
		o.add("shapeHints", hints);
		o.addProperty("slots", draft.slots().size());
		o.add("controls", controlsJson());
		JsonArray dev = new JsonArray();
		devOnly.keySet().forEach(dev::add);
		o.add("devControls", dev);
		return o;
	}

	// the left column scrolls (wheel, a drag on its bar)
	@Override
	public boolean mouseScrolled(double mx, double my, double sx, double sy) {
		if (mx >= view[0] && mx < view[0] + view[2] && my >= view[1] && my < view[1] + view[3]) {
			scroll = Math.max(0, Math.min(ScrollMath.maxOffset(contentH, view[3]), scroll - (int) Math.signum(sy) * 20));
			return true;
		}
		return super.mouseScrolled(mx, my, sx, sy);
	}

	@Override
	public boolean mouseClicked(net.minecraft.client.input.MouseButtonEvent e, boolean doubleClick) {
		int bx = view[0] + view[2] - 6;
		if (contentH > view[3] && e.x() >= bx && e.x() < bx + 6 && e.y() >= view[1] && e.y() < view[1] + view[3]) {
			ScrollMath.Thumb t = ScrollMath.thumb(view[3], contentH, view[3], scroll);
			if (t.contains(view[1], (int) e.y())) {
				barGrab = (int) e.y() - view[1] - t.y();
			} else {
				scroll = ScrollMath.pageTowards(view[3], contentH, view[3], scroll, (int) e.y() - view[1]);
			}
			return true;
		}
		return super.mouseClicked(e, doubleClick);
	}

	@Override
	public boolean mouseDragged(net.minecraft.client.input.MouseButtonEvent e, double dx, double dy) {
		if (barGrab >= 0) {
			scroll = ScrollMath.offsetForThumbTop(view[3], contentH, view[3], (int) e.y() - view[1] - barGrab);
			return true;
		}
		return super.mouseDragged(e, dx, dy);
	}

	@Override
	public boolean mouseReleased(net.minecraft.client.input.MouseButtonEvent e) {
		if (barGrab >= 0) {
			barGrab = -1;
			return true;
		}
		return super.mouseReleased(e);
	}

	private static final class UiBits {
		static int ink() {
			return dev.larattalabs.labui.client.hud.UiBits.ink();
		}
	}
}
