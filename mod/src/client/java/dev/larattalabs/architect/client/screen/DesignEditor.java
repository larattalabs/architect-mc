package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.client.design.DesignFeature;
import dev.larattalabs.architect.client.design.DesignForm;
import dev.larattalabs.architect.client.design.Drafts;
import dev.larattalabs.architect.client.design.SetFeature;
import dev.larattalabs.architect.client.library.LibraryFeature;
import dev.larattalabs.architect.client.screen.ArchitectScreen.Focus;
import dev.larattalabs.architect.client.screen.ArchitectScreen.Option;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.architect.library.LibraryCard;
import dev.larattalabs.architect.library.StyleCatalog;
import dev.larattalabs.architect.library.StyleDraft;
import dev.larattalabs.architect.library.StyleForm;
import dev.larattalabs.architect.library.StyleRoles;
import dev.larattalabs.architect.library.Swatches;
import dev.larattalabs.architect.library.VariantForm;
import dev.larattalabs.labui.client.hud.UiBits;
import dev.larattalabs.labui.client.picker.CompactPicker;
import dev.larattalabs.labui.client.picker.PickerScreen;
import dev.larattalabs.labui.client.picker.PickerSpec;
import dev.larattalabs.labui.client.picker.PickerStore;
import dev.larattalabs.labui.client.text.TextFieldView;
import dev.larattalabs.labui.client.text.TextModel;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.labui.client.widget.Button;
import dev.larattalabs.labui.client.widget.Chip;
import dev.larattalabs.labui.client.widget.CollapsibleSection;
import dev.larattalabs.labui.client.widget.Paint;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) The unified design editor (docs/STYLE-UNIFY.md; the approved mock), bound to {@link StyleForm#view()}: the
 * Design tab is its NEW mode, the Library's Variants dialog its VARIANT mode. A title row with the mode switch; a body that scrolls
 * (wheel, a draggable bar) in folding sections, What / Style / Materials / Features / Rules / Parameters (What, Style and Materials open
 * by default, the rest closed with counts; lab-ui remembers each fold); a pinned footer with the main action and Save draft.
 * <ul>
 * <li>Style: current + recents + built-ins as chips, "Own words", and "browse N styles…" (the {@link StyleBrowserScreen}); words with a
 * Style go along with it ({@link dev.larattalabs.architect.design.StyleNote}); own words alone mean no Style (U2).</li>
 * <li>Materials: Wood / Stone / Roof / Accent as lab-ui compact pickers (at most 4 chips, then "more… N": a full-screen picker of
 * swatches by family), each marked "from &lt;Style&gt;" or "custom" and saying what it drives; "More roles" folded (each role: its block,
 * "follows Wood" / "from X" / "custom"); a custom mix shows Revert and Save as style… (with a name, default "&lt;Style&gt; mix").</li>
 * <li>VARIANT: What, Features and Rules are in the design's code: locked (a lock bar with Remix…); Style, Materials and Parameters live.</li>
 * </ul>
 * Every control keeps an id for dev.ui.click; a control in a closed section stays clickable for the DevBridge (zero size). Client thread.
 */
final class DesignEditor {
	static final int LABEL_W = 44;
	private static final int ROW = Chip.H + 3;
	private final ArchitectScreen s;
	private final CollapsibleSection what = new CollapsibleSection("architect_mc.editor.what", "What", true);
	private final CollapsibleSection style = new CollapsibleSection("architect_mc.editor.style", "Style", true);
	private final CollapsibleSection materials = new CollapsibleSection("architect_mc.editor.materials", "Materials", true);
	private final CollapsibleSection moreRoles = new CollapsibleSection("architect_mc.editor.more_roles", "More roles", false);
	private final CollapsibleSection features = new CollapsibleSection("architect_mc.editor.features", "Features", false);
	private final CollapsibleSection rules = new CollapsibleSection("architect_mc.editor.rules", "Rules", false);
	private final CollapsibleSection params = new CollapsibleSection("architect_mc.editor.parameters", "Parameters", false);
	private final CollapsibleSection vWhat = new CollapsibleSection("architect_mc.variant.what", "What", false);
	private final CollapsibleSection vStyle = new CollapsibleSection("architect_mc.variant.style", "Style", true);
	private final CollapsibleSection vMaterials = new CollapsibleSection("architect_mc.variant.materials", "Materials", true);
	private final CollapsibleSection vMoreRoles = new CollapsibleSection("architect_mc.variant.more_roles", "More roles", false);
	private final CollapsibleSection vFeatures = new CollapsibleSection("architect_mc.variant.features", "Features", false);
	private final CollapsibleSection vRules = new CollapsibleSection("architect_mc.variant.rules", "Rules", false);
	private final CollapsibleSection vParams = new CollapsibleSection("architect_mc.variant.parameters", "Parameters", true);
	private final Map<String, CompactPicker> pickers = new HashMap<>();
	private final Map<String, String> pickerKeys = new HashMap<>();
	/** "Save as style…": its name field (open while non-null) and the editor it saves. */
	final TextModel saveName = new TextModel(StyleDraft.MAX_NAME);
	final TextFieldView saveNameView = new TextFieldView();
	private boolean saving;
	private @Nullable String saveMode;
	/** The mix bar was just opened for its name: scroll it into view once. */
	private boolean revealSave;
	private final TextFieldView noteView = new TextFieldView();
	private final TextFieldView styleTextView = new TextFieldView();
	private final TextFieldView materialsView = new TextFieldView();
	private final TextFieldView nameView = new TextFieldView();
	private final TextFieldView notesView = new TextFieldView();
	private final TextFieldView openTypeView = new TextFieldView();
	private int contentH;
	private @Nullable String draftNote;
	private long draftNoteAt;
	/** The viewport of the body this frame (x, y, w, h): the mouse outside it hovers nothing in it. */
	private int[] view = new int[4];

	DesignEditor(ArchitectScreen s) {
		this.s = s;
	}

	private Font font() {
		return s.font();
	}

	/** Esc: closes the Save-as-style name field first. */
	boolean escape() {
		if (saveMode != null) {
			saveMode = null;
			s.setFocusPublic(Focus.NONE);
			return true;
		}
		return false;
	}

	@Nullable TextModel model(Focus f) {
		return f == Focus.SAVE_NAME ? saveName : null;
	}

	/** Enter in the Save-as-style field saves. */
	boolean enter(Focus f) {
		if (f == Focus.SAVE_NAME) {
			confirmSave();
			return true;
		}
		return false;
	}

	// ------------------------------------------------------------------ shared pieces

	/** A Style's display name: an entry's Style may carry only its id ("medieval"): the installed one's name, else the id capitalised. */
	static String nameOf(StyleForm.@Nullable Style b) {
		if (b == null) {
			return "";
		}
		if (b.id() != null && b.name().equals(b.id())) {
			String n = SetFeature.bible(b.id()).map(Bible::name).orElse(null);
			if (n != null) {
				return n;
			}
			return b.id().isEmpty() ? b.id() : Character.toUpperCase(b.id().charAt(0)) + b.id().substring(1).replace('_', ' ');
		}
		return b.name();
	}

	/** "from Medieval", "follows Wood", "custom" for a role's provenance. */
	static String provenanceLabel(@Nullable String prov, StyleForm.@Nullable Style base) {
		if (prov == null) {
			return "";
		}
		return switch (prov) {
			case StyleRoles.FOLLOWS_WOOD -> "follows Wood";
			case StyleRoles.FOLLOWS_STONE -> "follows Stone";
			case StyleRoles.HAND -> "custom";
			default -> base == null || base.kind().equals(StyleForm.INPUTS) ? "from its palette" : "from " + nameOf(base);
		};
	}

	/** A provenance tag: a small paper box ("from Medieval") or a clay one ("custom"). Returns its width (0: nothing drawn). */
	static int marker(GuiGraphicsExtractor g, Font font, String text, int x, int y, int maxW) {
		if (text.isEmpty() || maxW < 24) {
			return 0;
		}
		String t = TextUtil.ellipsize(font, text, maxW - 6);
		int w = font.width(t) + 6;
		boolean custom = text.equals("custom");
		Paint.box(g, x, y, w, 11, custom ? UiStyle.withAlpha(UiStyle.CLAY, 60) : 0xFFF1E3B6, custom ? UiStyle.withAlpha(UiStyle.CLAY_DARK, 140)
			: 0xFFD9C27A);
		g.text(font, t, x + 3, y + 2, custom ? UiStyle.CLAY_DARK : 0xFF6B5420, false);
		return w;
	}

	private int my(int my) {
		return my >= view[1] && my < view[1] + view[3] ? my : -1000;
	}

	/** A section header as a control; returns its height. */
	private int header(GuiGraphicsExtractor g, CollapsibleSection sec, String id, String summary, int x, int y, int w, int mx, int my) {
		sec.summary(summary);
		int h = sec.draw(g, font(), x, y, w, mx, my(my));
		s.control("section:" + id, sec.key(), sec, sec.open());
		return h;
	}

	/** A chip as a control; returns its width. */
	/** (U5b) Where a Style's parts came from: "7 parts · drafted with the Style by Claude · v3" / "added with Add parts… (Medieval v1)". */
	static String partsProvenance(StyleForm.@org.jspecify.annotations.Nullable Style st) {
		if (st == null || st.parts() <= 0) {
			return "";
		}
		Bible b = st.id() == null ? null : SetFeature.bible(st.id()).filter(x -> x.version() == st.version()).orElse(null);
		String from = b == null ? "" : b.builtin() ? " · shipped with the kit" : "claude".equals(b.origin()) ? " · drafted with the Style by Claude"
			: " · added with Add parts…" + b.basedOn().map(p -> " (based on " + p.id() + " v" + p.version() + ")").orElse("");
		return st.parts() + " part" + (st.parts() == 1 ? "" : "s") + from + " · v" + st.version();
	}

	private int chip(GuiGraphicsExtractor g, String id, Chip c, int x, int y, int mx, int my) {
		int w = c.draw(g, font(), x, y, mx, my(my));
		s.control(id, c.label(), c, c.isSelected());
		return w;
	}

	private int label(GuiGraphicsExtractor g, String text, int x, int y) {
		g.text(font(), text, x, y + 5, UiStyle.CLAY_DARK, false);
		return LABEL_W;
	}

	private int muted(GuiGraphicsExtractor g, String text, int x, int y, int w) {
		for (String l : TextUtil.wrapPlain(font(), text, Math.max(20, w)).stream().limit(3).toList()) {
			g.text(font(), l, x, y, UiStyle.mutedText(), false);
			y += 10;
		}
		return y;
	}

	/**
	 * The Style row: the current Style, recents and a few built-ins as chips (as many as fit, at most 4), "Own words" (NEW only) and
	 * "browse N styles…". {@code current}: the picked Style's id; {@code use}: what picking one does.
	 */
	private int styleRow(GuiGraphicsExtractor g, String prefix, @Nullable String current, boolean ownWords, @Nullable Runnable onOwnWords,
		Consumer<Bible> use, int x, int y, int w, int mx, int my) {
		List<Bible> all = StyleCatalog.withBuiltins(SetFeature.bibles(), LibraryFeature.palettes()).stream().filter(b -> !b.archived() || b.id()
			.equals(current)).toList();
		List<String> ids = dev.larattalabs.labui.ui.PickerModel.compact(ownWords ? null : current, PickerStore.memory().recents(StyleBrowserScreen.ID),
			List.of("rustic", "medieval", "modern", "nordic"), 3, id -> all.stream().anyMatch(b -> b.id().equals(id)));
		Chip more = new Chip("browse " + all.size() + " styles…", () -> StyleBrowserScreen.open(current, b -> {
			PickerStore.used(StyleBrowserScreen.ID, b.id());
			use.accept(b);
		})).kind(Chip.Kind.MORE);
		Chip own = onOwnWords == null ? null : new Chip("Own words", onOwnWords).selected(ownWords);
		int reserved = more.width(font()) + 4 + (own == null ? 0 : own.width(font()) + 4);
		int cx = x;
		for (String id : ids) {
			Bible b = all.stream().filter(k -> k.id().equals(id)).findFirst().orElseThrow();
			Chip c = new Chip(b.name(), () -> {
				PickerStore.used(StyleBrowserScreen.ID, b.id());
				use.accept(b);
			}).selected(!ownWords && id.equals(current)).swatch(StylePaint.rgb(b.roles().get("wall")));
			int cw = c.width(font());
			if (cx > x && cx + cw > x + w - reserved) {
				break;
			}
			cw = Math.min(cw, x + w - reserved - cx);
			c.draw(g, font(), cx, y, cw, mx, my(my));
			s.control(prefix + id, b.name(), c, c.isSelected());
			cx += cw + 4;
		}
		// every Style stays a control for the DevBridge, drawn or not
		for (Bible b : all) {
			if (!ids.contains(b.id())) {
				s.devControl(prefix + b.id(), b.name(), true, false, () -> use.accept(b));
			}
		}
		if (own != null) {
			cx += chip(g, "style:own_words", own, cx, y, mx, my) + 4;
		}
		chip(g, "style:browse", more, cx, y, mx, my);
		return y + ROW;
	}

	/** A main row's compact picker (made again when its value or the roles change). */
	private CompactPicker picker(String mode, String field, @Nullable String cur, Map<String, String> roles, Consumer<String> pick) {
		String key = cur + "|" + roles.hashCode();
		String k = mode + ":" + field;
		CompactPicker cp = pickers.get(k);
		if (cp == null || !key.equals(pickerKeys.get(k))) {
			cp = new CompactPicker(StylePaint.material(field, cur, roles, pick));
			pickers.put(k, cp);
			pickerKeys.put(k, key);
		}
		return cp;
	}

	/**
	 * The four main rows of {@code sf}, More roles, and the custom-mix bar. {@code editMain}: what a row's pick does (NEW: the form's
	 * StyleForm; VARIANT: the dialog's setField). Returns the y after.
	 */
	private int materialRows(GuiGraphicsExtractor g, String mode, StyleForm sf, java.util.function.BiConsumer<String, String> editMain,
		CollapsibleSection roles, int x, int y, int w, int mx, int my, Consumer<String> err) {
		JsonObject v = sf.view();
		Map<String, String> main = sf.main();
		StyleForm.Style base = sf.base();
		JsonObject mp = v.get("mainProvenance").isJsonObject() ? v.getAsJsonObject("mainProvenance") : new JsonObject();
		for (String field : StyleRoles.MAIN_FIELDS) {
			String cur = main == null ? null : main.get(field);
			g.text(font(), Character.toUpperCase(field.charAt(0)) + field.substring(1), x, y + 5, UiBits.ink(), false);
			int avail = w - LABEL_W;
			// the chips take what the marker and the "drives" line leave (the marker, at least, stays on the row)
			String prov = mp.has(field) ? "hand".equals(mp.get(field).getAsString()) ? "custom" : provenanceLabel("style", base) : "";
			int markW = prov.isEmpty() ? 0 : Math.min(font().width(prov) + 6, 110);
			CompactPicker cp = picker(mode, field, cur, sf.roles(), val -> {
				try {
					editMain.accept(field, val);
				} catch (IllegalArgumentException | IllegalStateException e) {
					err.accept(e.getMessage());
				}
			});
			int used = cp.draw(g, font(), x + LABEL_W, y, Math.max(90, avail - markW - 6), mx, my(my));
			int[] vw = view;
			s.mouseTarget((px, py, b) -> py >= vw[1] && py < vw[1] + vw[3] && cp.mouseClicked(px, py, b));
			s.devControl("palette:" + field, "more… " + field, true, false, cp::openBrowser);
			for (String id : cp.choices()) {
				s.devControl("material:" + field + "=" + id, id, true, id.equals(cur), () -> {
					try {
						editMain.accept(field, id);
					} catch (IllegalArgumentException | IllegalStateException e) {
						err.accept(e.getMessage());
					}
				});
			}
			int mxp = x + LABEL_W + used + 6;
			int mw = marker(g, font(), prov, mxp, y + 4, x + w - mxp);
			int dx = mxp + mw + 6;
			String drives = StyleDraft.DRIVES.get(field);
			if (x + w - dx > 50) {
				g.text(font(), TextUtil.ellipsize(font(), drives, x + w - dx), dx, y + 6, UiStyle.mutedText(), false);
			}
			y += ROW;
		}
		// More roles (folded): every role, its block, where it comes from
		Map<String, String> r = sf.roles();
		long following = sf.provenance().values().stream().filter(p -> p.startsWith("follows_")).count();
		int ix = x + 6;
		y += header(g, roles, mode + "_more_roles", r.size() + " · " + following + " follow a main row", ix, y, w - 6, mx, my);
		List<String> order = new ArrayList<>(RolesSwatch.ORDER);
		r.keySet().stream().filter(k -> !order.contains(k)).forEach(order::add);
		for (String role : order) {
			String block = r.get(role);
			if (block == null) {
				continue;
			}
			Runnable open = () -> Minecraft.getInstance().gui.setScreen(new PickerScreen(StylePaint.role(role, block, b -> {
				try {
					sf.setRole(role, b);
				} catch (IllegalArgumentException | IllegalStateException e) {
					err.accept(e.getMessage());
				}
			}), Minecraft.getInstance().gui.screen()));
			if (!roles.open()) {
				s.devControl("role:" + role, role, true, false, open);
				continue;
			}
			int rx = ix + CollapsibleSection.INDENT;
			g.text(font(), TextUtil.ellipsize(font(), role.replace('_', ' '), 58), rx, y + 5, UiBits.ink(), false);
			Chip c = new Chip(Swatches.label(block), open).swatch(StylePaint.rgb(block));
			int cw = Math.min(c.width(font()), Math.max(60, x + w - rx - 62 - 84));
			c.draw(g, font(), rx + 62, y, cw, mx, my(my));
			s.control("role:" + role, role, c, false);
			marker(g, font(), provenanceLabel(sf.provenance().get(role), base), rx + 62 + cw + 4, y + 4, x + w - (rx + 62 + cw + 4));
			y += ROW;
		}
		y += 2;
		// the custom mix: Revert, Save as style… (a name, default "<Style> mix")
		if (sf.mix() && base != null) {
			y = mixBar(g, mode, sf, base, x, y, w, mx, my, err);
		}
		return y;
	}

	private int mixBar(GuiGraphicsExtractor g, String mode, StyleForm sf, StyleForm.Style base, int x, int y, int w, int mx, int my, Consumer<String> err) {
		int h = Button.H + 6;
		// while its name field is open, the bar stays in view (a GUI-scale change re-lays the body out)
		if (mode.equals(saveMode)) {
			revealSave = false;
			int below = y + h + 4 - (view[1] + view[3]);
			if (below > 0) {
				s.scrollTo(s.scroll() + below);
			}
		}
		Paint.box(g, x, y, w, h, UiStyle.withAlpha(UiStyle.CLAY, 30), UiStyle.withAlpha(UiStyle.CLAY_DARK, 90));
		int by = y + 3;
		if (mode.equals(saveMode)) {
			String sv = "Save";
			String cn = "Cancel";
			int sw = Button.width(font(), sv);
			int cnw = Button.width(font(), cn);
			int fx = x + 4 + font().width("Name") + 6;
			g.text(font(), "Name", x + 4, by + 6, UiStyle.CLAY_DARK, false);
			int fw = Math.max(60, x + w - 4 - sw - 4 - cnw - 6 - fx);
			s.textField(g, Focus.SAVE_NAME, saveNameView, saveName, fx, by + 1, fw, new TextFieldView.Style(null, 0, nameOf(base) + " mix", null, null, 0, 1));
			Button save = new Button(saving ? "Saving…" : sv, this::confirmSave).primary(true);
			save.disabled(saving || !SetFeature.has("bible.save")).tooltip(SetFeature.has("bible.save") ? null : "this design helper can't save Styles");
			save.draw(g, font(), x + w - 4 - sw - 4 - cnw, by, sw, Button.H, mx, my(my));
			s.control("style:save_confirm", sv, save, false);
			Button cancel = new Button(cn, () -> {
				saveMode = null;
				s.setFocusPublic(Focus.NONE);
			});
			cancel.draw(g, font(), x + w - 4 - cnw, by, cnw, Button.H, mx, my(my));
			s.control("style:save_cancel", cn, cancel, false);
		} else {
			String rv = "Revert";
			String sv = "Save as style…";
			int rw = Button.width(font(), rv);
			int sw = Button.width(font(), sv);
			g.text(font(), TextUtil.ellipsize(font(), "custom mix · based on " + nameOf(base), w - rw - sw - 20), x + 5, by + 6, UiStyle.CLAY_DARK, false);
			Button revert = new Button(rv, sf::revert);
			revert.draw(g, font(), x + w - 4 - sw - 4 - rw, by, rw, Button.H, mx, my(my));
			s.control("style:revert", rv, revert, false);
			Button save = new Button(sv, () -> {
				saveMode = mode;
				revealSave = true;
				saveName.set(nameOf(base) + " mix");
				saveName.selectAll();
				s.setFocusPublic(Focus.SAVE_NAME);
			});
			save.disabled(!SetFeature.has("bible.save")).tooltip(SetFeature.has("bible.save") ? null : "this design helper can't save Styles: update it");
			save.draw(g, font(), x + w - 4 - sw, by, sw, Button.H, mx, my(my));
			s.control("style:save", sv, save, false);
		}
		return y + h + 4;
	}

	/** Saves the custom mix of the open name field's editor as a new Style (bible.save); the editor then picks it. */
	void confirmSave() {
		String mode = saveMode;
		if (mode == null || saving) {
			return;
		}
		StyleForm sf = mode.equals("variant") && LibraryFeature.variantForm() != null ? LibraryFeature.variantForm().style() : DesignFeature.form().styleForm;
		saving = true;
		String n = saveName.value().strip();
		var f = mode.equals("variant") ? DesignFeature.saveStyle(sf, n, () -> {
		}) : DesignFeature.saveStyle(n.isEmpty() ? null : n);
		f.whenComplete((b, err) -> Minecraft.getInstance().execute(() -> {
			saving = false;
			if (err != null) {
				Throwable c = err.getCause() != null ? err.getCause() : err;
				LibraryFeature.say("Not saved: " + c.getMessage(), true);
				DesignFeature.form().sendError = "Not saved: " + c.getMessage();
				return;
			}
			saveMode = null;
			s.setFocusPublic(Focus.NONE);
			PickerStore.used(StyleBrowserScreen.ID, b.id());
			LibraryFeature.say("Saved " + b.name() + " (yours): it is picked now", false);
		}));
	}

	/** "Save as style…" with a name, for the DevBridge (the same path as the button and the field). */
	void saveAs(String mode, @Nullable String name) {
		saveMode = mode;
		StyleForm sf = mode.equals("variant") && LibraryFeature.variantForm() != null ? LibraryFeature.variantForm().style() : DesignFeature.form().styleForm;
		saveName.set(name != null ? name : sf.base() == null ? "" : nameOf(sf.base()) + " mix");
		confirmSave();
	}

	// ------------------------------------------------------------------ the body frame

	/** Begins the scrolling body: viewport, scroll, scissor and clip; returns the content's first y. */
	private int begin(GuiGraphicsExtractor g, int x, int y, int w, int h) {
		view = new int[] {x, y, w - 8, h};
		s.setScrollArea(x, y, w - 8, h, contentH, 24);
		g.enableScissor(x, y, x + w - 8, y + h);
		s.clipControls(view);
		return y - s.scroll();
	}

	private void end(GuiGraphicsExtractor g, int x, int y, int w, int h, int y0, int yEnd) {
		g.disableScissor();
		s.clipControls(null);
		contentH = yEnd - y0 + 6;
		s.setScrollArea(x, y, w - 8, h, contentH, 24);
		s.scrollbarAt(g, x + w - 6, y, h);
	}

	/** The title row: what this is, and the mode switch (New | Variant of "X") when both are open. */
	private void titleRow(GuiGraphicsExtractor g, String title, boolean variant, int x, int y, int w, int mx, int my) {
		VariantForm vf = LibraryFeature.variantForm();
		int cx = x + w;
		if (vf != null) {
			LibraryCard c = LibraryFeature.card(vf.from());
			Chip v = new Chip("Variant of “" + (c == null ? vf.from() : c.name()) + "”", () -> {
				if (!variant) {
					LibraryTab.dialog = LibraryTab.Dialog.VARIANTS;
					s.setTab(ArchitectScreen.Tab.LIBRARY);
					s.showDesigns();
				}
			}).selected(variant);
			int vw = Math.min(v.width(font()), w / 2);
			cx -= vw;
			v.draw(g, font(), cx, y, vw, mx, my);
			s.control("editor:mode:variant", v.label(), v, variant);
			Chip n = new Chip("New", () -> {
				if (variant) {
					s.setTab(ArchitectScreen.Tab.DESIGN);
				}
			}).selected(!variant);
			cx -= n.width(font()) + 3;
			n.draw(g, font(), cx, y, mx, my);
			s.control("editor:mode:new", "New", n, !variant);
		}
		g.text(font(), TextUtil.ellipsize(font(), title, cx - x - 8), x, y + 5, UiStyle.CLAY_DARK, false);
	}

	/** A "saved draft" bar: Restore / Discard. Returns the y after (unchanged without a draft). */
	private int draftBar(GuiGraphicsExtractor g, long savedAt, Runnable restore, Runnable discard, String idPrefix, int x, int y, int w, int mx, int my) {
		if (savedAt <= 0) {
			return y;
		}
		int h = Button.H + 4;
		Paint.box(g, x, y, w, h, 0xFFF1E3B6, 0xFFD9C27A);
		String rs = "Restore draft";
		String ds = "Discard";
		int rw = Button.width(font(), rs);
		int dw = Button.width(font(), ds);
		long mins = Math.max(0, (System.currentTimeMillis() - savedAt) / 60_000);
		String when = mins < 1 ? "just now" : mins < 60 ? mins + " min ago" : mins < 1440 ? mins / 60 + " h ago" : LibraryTab.date(savedAt);
		g.text(font(), TextUtil.ellipsize(font(), "A saved draft (" + when + ")", w - rw - dw - 16), x + 5, y + 7, 0xFF6B5420, false);
		Button r = new Button(rs, restore);
		r.draw(g, font(), x + w - 2 - dw - 4 - rw, y + 2, rw, Button.H, mx, my);
		s.control(idPrefix + "restore_draft", rs, r, false);
		Button d = new Button(ds, discard);
		d.draw(g, font(), x + w - 2 - dw, y + 2, dw, Button.H, mx, my);
		s.control(idPrefix + "discard_draft", ds, d, false);
		return y + h + 4;
	}

	private void noteDraft(String text) {
		draftNote = text;
		draftNoteAt = net.minecraft.util.Util.getMillis();
	}

	@Nullable String draftNote() {
		return draftNote != null && net.minecraft.util.Util.getMillis() - draftNoteAt < 6000 ? draftNote : null;
	}

	// ------------------------------------------------------------------ NEW: the Design tab

	private static final List<DesignSpec.Choice> TYPE_CHOICES;

	static {
		List<DesignSpec.Choice> l = new ArrayList<>(DesignSpec.TYPES);
		l.add(new DesignSpec.Choice(DesignForm.OTHER, "Other…", "your own type, checked by the rules you pick"));
		TYPE_CHOICES = List.copyOf(l);
	}

	void drawNew(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my) {
		DesignForm f = DesignFeature.form();
		Map<String, String> errors = f.errors();
		// the title row (and the New | Variant switch) only when there is a remix or an open Variants dialog to switch to
		boolean titled = f.remix != null || LibraryFeature.variantForm() != null;
		if (titled) {
			titleRow(g, f.remix != null ? "Remix of " + LibraryFeature.nameOf(f.remix) : "New design", false, x, top - 2, w, mx, my);
		}
		int by = titled ? top + Chip.H + 2 : top - 2;
		int bh = footerY - 16 - by;
		int y0 = begin(g, x, by, w, bh);
		int iw = w - 10;
		int y = y0;
		y = draftBar(g, f.remix == null ? Drafts.designSavedAt() : 0, () -> {
			if (Drafts.restoreDesign(DesignFeature.form())) {
				noteDraft("Draft restored");
			}
		}, () -> {
			Drafts.dropDesign();
			noteDraft("Draft discarded");
		}, "design:", x, y, iw, mx, my);
		// ---- What
		DesignSpec.Choice tc = DesignSpec.find(TYPE_CHOICES, f.type);
		int[] m = f.maxSize();
		String sizeText = DesignForm.CUSTOM.equals(f.size) ? m[0] + "×" + m[1] + "×" + m[2] : DesignForm.PLOT.equals(f.size) ? "plot" : f.size;
		y += header(g, what, "what", (DesignForm.OTHER.equals(f.type) ? f.typeSent().isEmpty() ? "your own type" : f.typeSent() : tc == null ? f.type
			: tc.label()) + " · " + sizeText + (f.name.value().isBlank() ? "" : " · " + f.name.value()), x, y, iw, mx, my);
		if (what.open()) {
			y = whatRows(g, f, errors, x + 4, y + 2, iw - 4, mx, my);
		} else {
			whatDev(f);
		}
		// ---- Style
		String styleSummary = f.ownWords() ? (f.styleText.value().isBlank() ? "your own words" : "“" + f.styleText.value() + "”")
			: f.styleForm.base() == null ? "none" : nameOf(f.styleForm.base()) + (f.bible() != null ? " · its parts" : "") + (f.noteSent().isEmpty() ? ""
				: " · “" + f.noteSent() + "”");
		y += header(g, style, "style", styleSummary, x, y, iw, mx, my);
		String cur = f.styleForm.base() == null ? null : f.styleForm.base().id();
		Runnable partsToggle = () -> f.setUseParts(!f.styleForm.usePartsChosen());
		if (style.open()) {
			int sx = x + 4;
			label(g, "Style", sx, y + 2);
			y = styleRow(g, "style:", cur, f.ownWords(), f::useOwnWords, f::pickBible, sx + LABEL_W, y + 2, iw - 4 - LABEL_W, mx, my);
			label(g, "Words", sx, y);
			if (f.ownWords()) {
				s.textField(g, Focus.STYLE, styleTextView, f.styleText, sx + LABEL_W, y, iw - 4 - LABEL_W, new TextFieldView.Style(null, 0,
					"your own words instead of a Style, e.g. art deco seaside", null, f.styleText.length() + "/" + DesignSpec.MAX_STYLE, UiStyle.mutedText(), 1));
			} else {
				String with = cur == null ? "a Style" : nameOf(f.styleForm.base());
				s.textField(g, Focus.STYLE_NOTE, noteView, f.styleNote, sx + LABEL_W, y, iw - 4 - LABEL_W, new TextFieldView.Style(null, 0,
					"optional words with " + with + ", e.g. mossy, lived-in", null, null, 0, 1));
			}
			y += TextFieldView.BASE_H + 2;
			String explain = f.ownWords() ? "Sent as the request's style; no Style, so no materials: the designer picks them." : "Sent as the style: "
				+ (f.style().isEmpty() ? "?" : f.style()) + (f.noteSent().isEmpty() ? "" : ", with your words in the notes") + ".";
			if (errors.containsKey("style")) {
				g.text(font(), TextUtil.ellipsize(font(), errors.get("style"), iw - 4 - LABEL_W), sx + LABEL_W, y, UiBits.errorText(), false);
				y += 11;
			} else {
				y = muted(g, explain, sx + LABEL_W, y, iw - 4 - LABEL_W) + 2;
			}
			// (U5b) a Style with its own parts: "Use this style's parts" (set mode), with where the parts came from
			if (!f.ownWords() && f.styleForm.partsOffered()) {
				label(g, "Parts", sx, y);
				boolean chosen = f.styleForm.usePartsChosen();
				Chip c = new Chip(chosen ? "Use this style's parts: on" : "Use this style's parts: off", partsToggle).selected(chosen);
				int cw = chip(g, "style:parts", c, sx + LABEL_W, y - 4, mx, my);
				String note = f.styleForm.mix() && chosen ? "a custom mix sends the materials only: Revert to use the parts" : chosen
					? "set mode: its components and restraint" : "off: its look as guidance (the default)";
				g.text(font(), TextUtil.ellipsize(font(), note, iw - 4 - LABEL_W - cw - 6), sx + LABEL_W + cw + 6, y + 1, UiStyle.mutedText(), false);
				y += ROW - 4;
				y = muted(g, partsProvenance(f.styleForm.base()), sx + LABEL_W, y, iw - 4 - LABEL_W) + 2;
			}
		} else {
			if (!f.ownWords() && f.styleForm.partsOffered()) {
				s.devControl("style:parts", "Use this style's parts", true, f.styleForm.usePartsChosen(), partsToggle);
			}
			for (Bible b : StyleCatalog.withBuiltins(SetFeature.bibles(), LibraryFeature.palettes())) {
				s.devControl("style:" + b.id(), b.name(), true, b.id().equals(cur), () -> f.pickBible(b));
			}
			s.devControl("style:browse", "browse", true, false, () -> StyleBrowserScreen.open(cur, f::pickBible));
			s.devControl("style:own_words", "Own words", true, f.ownWords(), f::useOwnWords);
		}
		s.devControl("design:bible", "the Style browser", true, false, () -> StyleBrowserScreen.open(cur, f::pickBible));
		// ---- Materials
		String matSummary = f.ownWords() ? "the designer picks them (your own words)" : f.styleForm.base() == null ? "none" : f.styleForm.mix()
			? "custom mix · based on " + nameOf(f.styleForm.base()) : "from " + f.styleForm.base().name() + (f.bible() != null ? " (with its parts)" : "");
		y += header(g, materials, "materials", matSummary, x, y, iw, mx, my);
		if (materials.open()) {
			int sx = x + 4;
			if (f.ownWords() || f.styleForm.base() == null) {
				y = muted(g, "Your own words: no Style, so the designer picks the materials.", sx, y + 2, iw - 4);
				Button pick = new Button("Pick a style…", () -> StyleBrowserScreen.open(cur, f::pickBible));
				pick.draw(g, font(), sx, y + 2, pick.width(font()), Button.H, mx, my(my));
				s.control("materials:pick_style", pick.label(), pick, false);
				y += Button.H + 6;
			} else {
				y = materialRows(g, "design", f.styleForm, f.styleForm::editMain, moreRoles, sx, y + 2, iw - 4, mx, my, e -> f.sendError = e);
			}
			label(g, "Also", sx, y);
			s.textField(g, Focus.MATERIALS, materialsView, f.materials, sx + LABEL_W, y, iw - 4 - LABEL_W, new TextFieldView.Style(null, 0,
				"other materials in words (optional), e.g. mossy stone", null, null, 0, 1));
			y += TextFieldView.BASE_H + 4;
		} else if (f.styleForm.base() != null && !f.ownWords() && f.styleForm.mix()) {
			s.devControl("style:revert", "Revert", true, false, f.styleForm::revert);
		}
		// ---- Features
		List<String> on = f.features();
		List<String> labels = new ArrayList<>();
		for (String id : on) {
			DesignSpec.Choice c = DesignSpec.find(DesignSpec.FEATURES, id);
			labels.add((c == null ? id : c.label()) + (f.styleForm.fromStyle(id) ? " ✦" : ""));
		}
		y += header(g, features, "features", on.size() + " on" + (labels.isEmpty() ? "" : ": " + String.join(", ", labels)) + " · max "
			+ DesignSpec.MAX_FEATURES, x, y, iw, mx, my);
		y = featureChips(g, f, features.open(), x + 4, y + 2, iw - 4, mx, my);
		// ---- Rules
		boolean other = DesignForm.OTHER.equals(f.type);
		String ruleSummary = other ? f.profile.size() + " rule" + (f.profile.size() == 1 ? "" : "s") + " (your type)" : "set by the type ("
			+ (tc == null ? f.type : tc.label()) + ")";
		int rulesY = y;
		y += header(g, rules, "rules", ruleSummary, x, y, iw, mx, my);
		Runnable profile = () -> {
			List<Option> opts = new ArrayList<>();
			for (DesignSpec.Choice c : DesignSpec.PROFILE_RULES) {
				opts.add(new Option(c.id(), c.label(), f.profile.contains(c.id())));
			}
			// under the Rules header (in view), else under the body's top
			int ay = rulesY >= view[1] && rulesY < view[1] + view[3] - 20 ? rulesY + 18 : view[1] + 4;
			s.openPopup("design:profile", x + 4 + LABEL_W, ay, Math.max(220, iw / 2), opts, f::toggleProfile);
		};
		if (rules.open()) {
			int sx = x + 4;
			if (other) {
				String pl = f.profile.isEmpty() ? "door, lit, no floating (the default)" : String.join(", ", f.profile);
				label(g, "Checks", sx, y + 2);
				y = muted(g, pl, sx + LABEL_W, y + 7, iw - 4 - LABEL_W - 90) - 9;
				Button b = new Button("Edit rules…", profile);
				int bw2 = b.width(font());
				b.draw(g, font(), x + iw - bw2, y + 2, bw2, Button.H, mx, my(my));
				s.control("design:profile", b.label(), b, false);
				y += Button.H + 6;
			} else {
				y = muted(g, "The checker's rules come with the type: a door, light inside, nothing floating. Pick “Other…” as the type to choose "
					+ "your own.", sx, y + 3, iw - 4) + 3;
				s.devControl("design:profile", "rules", other, false, profile);
			}
		} else {
			s.devControl("design:profile", "rules", other, false, profile);
		}
		// ---- Parameters
		List<String> ps = new ArrayList<>();
		if (DesignForm.CUSTOM.equals(f.size)) {
			ps.add(m[0] + "×" + m[1] + "×" + m[2]);
		}
		if (SetFeature.has("massing") && f.massingFirst()) {
			ps.add("massing first");
		}
		if (f.critiqueSpec() != null) {
			ps.add("critique ×" + f.maxRevisions);
		}
		y += header(g, params, "parameters", ps.isEmpty() ? "defaults" : String.join(" · ", ps), x, y, iw, mx, my);
		y = paramRows(g, f, errors, params.open(), x + 4, y + 2, iw - 4, mx, my);
		end(g, x, by, w, bh, y0, y);
		footerNew(g, f, errors, x, w, footerY, mx, my);
	}

	private int whatRows(GuiGraphicsExtractor g, DesignForm f, Map<String, String> errors, int x, int y, int w, int mx, int my) {
		boolean openTypes = SetFeature.has("open.types");
		List<DesignSpec.Choice> types = openTypes || DesignForm.OTHER.equals(f.type) ? TYPE_CHOICES : DesignSpec.TYPES;
		label(g, "Type", x, y);
		// the current type, two more (the common ones), and "more… N" (a searchable list)
		List<String> ids = new ArrayList<>();
		ids.add(f.type);
		for (String c : List.of("house", "cabin", "tower", "tavern")) {
			if (ids.size() < 3 && !ids.contains(c) && DesignSpec.find(types, c) != null) {
				ids.add(c);
			}
		}
		int cx = x + LABEL_W;
		Chip more = new Chip("more… " + types.size(), null).kind(Chip.Kind.MORE);
		int cy = y;
		more.onPress(() -> {
			List<Option> opts = new ArrayList<>();
			for (DesignSpec.Choice c : types) {
				opts.add(new Option(c.id(), c.label() + " · " + c.description(), c.id().equals(f.type)));
			}
			s.openPopup("design:type", x + LABEL_W, cy + Chip.H + 2, Math.max(240, w - LABEL_W), opts, id -> pickType(f, id));
		});
		int reserved = more.width(font()) + 4;
		for (String id : ids) {
			DesignSpec.Choice c = DesignSpec.find(types, id);
			if (c == null) {
				continue;
			}
			Chip ch = new Chip(c.label(), () -> pickType(f, id)).selected(id.equals(f.type));
			int cw = ch.width(font());
			if (cx > x + LABEL_W && cx + cw > x + w - reserved) {
				break;
			}
			cx += chip(g, "type:" + id, ch, cx, y, mx, my) + 4;
		}
		for (DesignSpec.Choice c : types) {
			if (!ids.contains(c.id())) {
				s.devControl("type:" + c.id(), c.label(), true, false, () -> pickType(f, c.id()));
			}
		}
		chip(g, "design:type", more, cx, y, mx, my);
		y += ROW;
		if (DesignForm.OTHER.equals(f.type)) {
			label(g, "Called", x, y);
			s.textField(g, Focus.OTYPE, openTypeView, f.openType, x + LABEL_W, y, w - LABEL_W, new TextFieldView.Style(null, 0,
				"your type, e.g. hellish_lair (the Rules section picks its checks)", null, null, 0, 1));
			y += TextFieldView.BASE_H + 2;
		} else {
			DesignSpec.Choice tc = DesignSpec.find(DesignSpec.TYPES, f.type);
			if (tc != null) {
				g.text(font(), TextUtil.ellipsize(font(), tc.description(), w - LABEL_W), x + LABEL_W, y, UiStyle.mutedText(), false);
				y += 11;
			}
		}
		if (errors.containsKey("type")) {
			g.text(font(), TextUtil.ellipsize(font(), errors.get("type"), w - LABEL_W), x + LABEL_W, y, UiBits.errorText(), false);
			y += 11;
		}
		// size
		label(g, "Size", x, y);
		cx = x + LABEL_W;
		for (String sz : List.of("S", "M", "L")) {
			cx += chip(g, "size:" + sz, new Chip(sz, () -> f.size = sz).selected(sz.equals(f.size)), cx, y, mx, my) + 3;
		}
		cx += chip(g, "size:custom", new Chip("Custom", () -> {
			int[] mm = f.maxSize();
			f.customX = mm[0];
			f.customY = mm[1];
			f.customZ = mm[2];
			f.size = DesignForm.CUSTOM;
			params.open(true);
		}).selected(DesignForm.CUSTOM.equals(f.size)), cx, y, mx, my) + 3;
		if (f.plot != null) {
			cx += chip(g, "size:plot", new Chip("Plot", () -> f.size = DesignForm.PLOT).selected(DesignForm.PLOT.equals(f.size)), cx, y, mx, my) + 3;
		}
		Chip mark = new Chip(f.plot != null ? "Re-mark…" : "Mark a plot…", () -> {
			s.setFocusPublic(Focus.NONE);
			DesignFeature.startPlot();
		});
		mark.disabled(!s.inWorld()).tooltip(s.inWorld() ? null : "in a world only");
		if (cx + mark.width(font()) <= x + w) {
			chip(g, "mark_plot", mark, cx, y, mx, my);
		} else {
			s.devControl("mark_plot", mark.label(), s.inWorld(), false, mark::press);
		}
		y += ROW;
		int[] m = f.maxSize();
		DesignSpec.Plot p = f.plot;
		String at = "at most " + m[0] + " wide × " + m[1] + " high × " + m[2] + " deep" + (p != null && DesignForm.PLOT.equals(f.size) ? " · plot " + p.dx()
			+ "×" + p.dz() + " at " + p.minX() + ", " + p.y() + ", " + p.minZ() + ", entrance " + p.front() : "");
		g.text(font(), TextUtil.ellipsize(font(), at, w - LABEL_W), x + LABEL_W, y, errors.containsKey("maxSize") ? UiBits.errorText() : UiStyle.mutedText(),
			false);
		y += 12;
		if (errors.containsKey("maxSize")) {
			g.text(font(), TextUtil.ellipsize(font(), errors.get("maxSize"), w - LABEL_W), x + LABEL_W, y, UiBits.errorText(), false);
			y += 11;
		}
		// name and notes
		label(g, "Name", x, y);
		s.textField(g, Focus.NAME, nameView, f.name, x + LABEL_W, y, w - LABEL_W, new TextFieldView.Style(null, 0, "optional, e.g. Lakeside cabin", null,
			f.name.length() + "/" + DesignSpec.MAX_NAME, UiBits.muted(), 1));
		y += TextFieldView.BASE_H + 3;
		label(g, "Notes", x, y);
		s.textField(g, Focus.NOTES, notesView, f.notes, x + LABEL_W, y, w - LABEL_W, new TextFieldView.Style(null, 0, f.remix != null
			? "what to change, e.g. add a second floor and a bigger porch" : "rooms, mood, anything the designer should know", null, null, 0, 3));
		y += notesView.height(font(), f.notes, w - LABEL_W, new TextFieldView.Style(null, 0, "", null, null, 0, 3)) + 4;
		return y;
	}

	/** The controls of a closed What section, for the DevBridge. */
	private void whatDev(DesignForm f) {
		for (DesignSpec.Choice c : TYPE_CHOICES) {
			s.devControl("type:" + c.id(), c.label(), true, c.id().equals(f.type), () -> pickType(f, c.id()));
		}
		for (String sz : List.of("S", "M", "L")) {
			s.devControl("size:" + sz, sz, true, sz.equals(f.size), () -> f.size = sz);
		}
		s.devControl("mark_plot", "Mark a plot…", s.inWorld(), false, DesignFeature::startPlot);
	}

	private void pickType(DesignForm f, String id) {
		f.type = id;
		if (DesignForm.OTHER.equals(id)) {
			what.open(true);
			s.setFocusPublic(Focus.OTYPE);
		}
	}

	private int featureChips(GuiGraphicsExtractor g, DesignForm f, boolean open, int x, int y, int w, int mx, int my) {
		int cx = x;
		boolean any = false;
		for (DesignSpec.Choice c : DesignSpec.FEATURES) {
			boolean on = f.features().contains(c.id());
			boolean can = on || f.features().size() < DesignSpec.MAX_FEATURES;
			Runnable toggle = () -> {
				try {
					f.toggleFeature(c.id());
				} catch (IllegalArgumentException | IllegalStateException e) {
					f.sendError = e.getMessage();
				}
			};
			if (!open) {
				s.devControl("feature:" + c.id(), c.label(), can, on, toggle);
				continue;
			}
			Chip ch = new Chip(c.label() + (on && f.styleForm.fromStyle(c.id()) ? " ✦" : ""), toggle).selected(on);
			ch.disabled(!can).tooltip(can ? c.description() : "at most " + DesignSpec.MAX_FEATURES + " features");
			int cw = ch.width(font());
			if (cx > x && cx + cw > x + w) {
				cx = x;
				y += ROW;
			}
			cx += chip(g, "feature:" + c.id(), ch, cx, y, mx, my) + 4;
			any = true;
		}
		if (!any) {
			return y;
		}
		y += ROW;
		StyleForm.Style b = f.styleForm.base();
		if (b != null && f.features().stream().anyMatch(f.styleForm::fromStyle)) {
			g.text(font(), TextUtil.ellipsize(font(), "✦ suggested by " + b.name() + "; untouched ones change with the Style", w), x, y, UiStyle.mutedText(),
				false);
			y += 12;
		}
		return y + 2;
	}

	private int paramRows(GuiGraphicsExtractor g, DesignForm f, Map<String, String> errors, boolean open, int x, int y, int w, int mx, int my) {
		boolean massing = SetFeature.has("massing");
		boolean critique = SetFeature.has("critique");
		Runnable mToggle = () -> f.massingFirst = !f.massingFirst();
		Runnable cToggle = () -> f.critique = !f.critique;
		if (!open) {
			if (massing) {
				s.devControl("design:massing_first", "Massing first", f.remix == null, f.massingFirst(), mToggle);
			}
			if (critique) {
				s.devControl("design:critique", "Critique and revise", true, f.critique, cToggle);
				for (int n : dev.larattalabs.architect.design.CritiqueRules.REVISION_CHOICES) {
					s.devControl("design:revisions:" + n, Integer.toString(n), f.critique, f.maxRevisions == n, () -> f.maxRevisions = n);
				}
			}
			for (String d : List.of("w", "h", "d")) {
				s.devControl("custom:" + d + "-", "−", true, false, () -> step(f, d, -1));
				s.devControl("custom:" + d + "+", "+", true, false, () -> step(f, d, 1));
			}
			return y;
		}
		if (DesignForm.CUSTOM.equals(f.size)) {
			label(g, "Size", x, y);
			int cx = x + LABEL_W;
			cx = stepper(g, f, "w", "W", f.customX, cx, y, mx, my);
			cx = stepper(g, f, "h", "H", f.customY, cx + 8, y, mx, my);
			stepper(g, f, "d", "D", f.customZ, cx + 8, y, mx, my);
			y += ROW;
		} else {
			y = muted(g, "Size " + f.size + ": the type's preset. Pick Custom (What) to set width, height and depth.", x, y + 2, w) + 3;
		}
		if (massing) {
			Chip c = new Chip(f.massingFirst() ? "Massing first: on" : "Massing first: off", mToggle).selected(f.massingFirst());
			c.disabled(f.remix != null).tooltip(f.remix != null ? "not for a remix" : null);
			int cw = chip(g, "design:massing_first", c, x, y, mx, my);
			String why = f.remix != null ? "not for a remix" : f.massingFirst() ? f.massingFirst == null ? "a cheap shape to approve first (the default for "
				+ (DesignForm.PLOT.equals(f.size) ? "a plot)" : "size L)") : "a cheap shape to approve first" : "the detail at once";
			g.text(font(), TextUtil.ellipsize(font(), why, w - cw - 6), x + cw + 6, y + 5, UiStyle.mutedText(), false);
			y += ROW;
		}
		if (critique) {
			Chip c = new Chip(f.critique ? "Critique and revise: on" : "Critique and revise: off", cToggle).selected(f.critique);
			int cx = x + chip(g, "design:critique", c, x, y, mx, my) + 6;
			g.text(font(), "Revisions", cx, y + 5, f.critique ? UiStyle.CLAY_DARK : UiStyle.mutedText(), false);
			cx += font().width("Revisions") + 4;
			for (int n : dev.larattalabs.architect.design.CritiqueRules.REVISION_CHOICES) {
				Chip r = new Chip(Integer.toString(n), () -> f.maxRevisions = n).selected(f.critique && f.maxRevisions == n);
				r.disabled(!f.critique);
				cx += chip(g, "design:revisions:" + n, r, cx, y, mx, my) + 3;
			}
			y += ROW;
		}
		if (SetFeature.has("estimates")) {
			DesignFeature.tickEstimate();
			String est = f.estimateError != null ? "estimate: " + f.estimateError : f.estimate != null ? dev.larattalabs.architect.design.CritiqueRules
				.estimateLine(f.estimate) : errors.isEmpty() ? "estimating…" : "estimate: fix the marked fields";
			int ec = f.estimateError != null ? UiBits.errorText() : UiStyle.color("palette.ui.teal_text", 0xFF1E7472);
			for (String l : TextUtil.wrapPlain(font(), est, w).stream().limit(2).toList()) {
				g.text(font(), l, x, y, ec, false);
				y += 10;
			}
			y += 2;
		}
		return y;
	}

	private void step(DesignForm f, String d, int delta) {
		switch (d) {
			case "w" -> f.customX = Math.max(DesignSpec.MIN_XZ, Math.min(DesignSpec.MAX_XZ, f.customX + delta));
			case "h" -> f.customY = Math.max(DesignSpec.MIN_Y, Math.min(DesignSpec.MAX_Y, f.customY + delta));
			default -> f.customZ = Math.max(DesignSpec.MIN_XZ, Math.min(DesignSpec.MAX_XZ, f.customZ + delta));
		}
		f.size = DesignForm.CUSTOM;
	}

	private int stepper(GuiGraphicsExtractor g, DesignForm f, String id, String name, int value, int x, int y, int mx, int my) {
		x += chip(g, "custom:" + id + "-", new Chip("−", () -> step(f, id, -1)), x, y, mx, my) + 2;
		String v = name + " " + value;
		g.text(font(), v, x, y + 5, UiBits.ink(), false);
		x += font().width(v) + 2;
		x += chip(g, "custom:" + id + "+", new Chip("+", () -> step(f, id, 1)), x, y, mx, my);
		return x;
	}

	private void footerNew(GuiGraphicsExtractor g, DesignForm f, Map<String, String> errors, int x, int w, int footerY, int mx, int my) {
		String status;
		boolean err;
		if (DesignFeature.sending()) {
			status = "Sending…";
			err = false;
		} else if (f.sendError != null) {
			status = f.sendError;
			err = true;
		} else if (draftNote() != null) {
			status = draftNote();
			err = false;
		} else if (!errors.isEmpty()) {
			status = errors.size() == 1 ? "1 field needs a fix: " + errors.values().iterator().next() : errors.size() + " fields need a fix (in red)";
			err = true;
		} else if (!Sidecar.connected()) {
			status = "The design helper is not running yet (Status tab).";
			err = true;
		} else if (f.remix != null) {
			status = "Remix: Claude edits " + LibraryFeature.nameOf(f.remix) + "; the notes say what to change.";
			err = false;
		} else if (f.massingFirst() && SetFeature.has("massing")) {
			status = "Ready: a massing first (cents, a minute or two); approve its shape, then Claude adds the detail.";
			err = false;
		} else {
			status = "Ready: Claude designs it in the background; the Library shows its progress.";
			err = false;
		}
		s.statusLineAt(g, status, err, x, footerY - 13, w);
		int bx = x + w;
		String go = "Generate";
		bx -= s.bw(go);
		s.button(g, "submit", go, bx, footerY, s.bw(go), true, !DesignFeature.sending() && errors.isEmpty(), mx, my, s::submitDesign);
		String sd = "Save draft";
		bx -= s.bw(sd) + 6;
		s.button(g, "design:save_draft", sd, bx, footerY, s.bw(sd), false, true, mx, my, () -> {
			try {
				Drafts.saveDesign(DesignFeature.form());
				noteDraft("Draft saved: it is offered here next time");
			} catch (java.io.IOException e) {
				DesignFeature.form().sendError = "Draft not saved: " + e.getMessage();
			}
		});
		String reset = "Clear";
		bx -= s.bw(reset) + 6;
		s.button(g, "reset", reset, bx, footerY, s.bw(reset), false, true, mx, my, DesignFeature::resetForm);
		String setL = "Design a set…";
		boolean setFits = bx - s.bw(setL) - 6 >= x + 90;
		if (setFits) {
			bx -= s.bw(setL) + 6;
			s.button(g, "design_set", setL, bx, footerY, s.bw(setL), false, SetFeature.has("design.groups"), mx, my, s::openSet);
		} else {
			s.devControl("design_set", setL, SetFeature.has("design.groups"), false, s::openSet);
		}
		if (f.remix != null) {
			String rl = "Remix of " + LibraryFeature.nameOf(f.remix) + "  ×";
			int rw = Math.min(font().width(rl) + 12, bx - x - 8);
			if (rw > 30) {
				ArchitectScreen.Hit h = new ArchitectScreen.Hit("remix:clear", "Not a remix", x, footerY + 3, rw, ArchitectScreen.CHIP_H, true, true, () -> f.remix = null);
				s.addHit(h);
				Paint.box(g, x, footerY + 1, rw, Chip.H, UiStyle.selected(), UiStyle.selectedEdge());
				g.text(font(), TextUtil.ellipsize(font(), rl, rw - 12), x + 6, footerY + 6, h.contains(mx, my) ? UiBits.errorText() : UiBits.ink(), false);
			}
		} else {
			String[] hints = {"Tab", "next field", "Ctrl+Enter", "generate"};
			if (UiBits.hintsWidth(font(), hints) <= bx - x - 6) {
				UiBits.hints(g, font(), x, footerY + 4, false, hints);
			}
		}
	}

	// ------------------------------------------------------------------ VARIANT: the Variants dialog

	void drawVariant(GuiGraphicsExtractor g, int x, int top, int w, int footerY, int mx, int my, LibraryTab lib) {
		VariantForm f = LibraryFeature.variantForm();
		if (f == null) {
			return;
		}
		LibraryCard c = LibraryFeature.card(f.from());
		String name = c == null ? f.from() : c.name();
		int y = top - 3;
		titleRow(g, "Variant of " + name, true, x, y, w, mx, my);
		y += Chip.H + 2;
		// the lock bar: what is baked into the design's code
		int lh = Button.H + 4;
		Paint.box(g, x, y, w, lh, 0xFFEDE6D8, UiStyle.rule());
		String rm = "Remix…";
		int rw = Button.width(font(), rm);
		g.text(font(), TextUtil.ellipsize(font(), "Locked: What, Features and Rules are in this design's code. A Style re-skins it; Remix… "
			+ "changes the rest (Claude).", w - rw - 14), x + 5, y + 7, UiStyle.mutedText(), false);
		Button remix = new Button(rm, () -> {
			lib.closeDialog();
			s.remix(f.from());
		});
		remix.draw(g, font(), x + w - 2 - rw, y + 2, rw, Button.H, mx, my);
		s.control("variant:remix", rm, remix, false);
		y += lh + 3;
		int bh = footerY - 16 - y;
		int by = y;
		int y0 = begin(g, x, by, w, bh);
		int iw = w - 10;
		y = y0;
		y = draftBar(g, Drafts.variantSavedAt(f.from()), () -> {
			if (Drafts.restoreVariant(f)) {
				lib.variantName.set(f.name());
				noteDraft("Draft restored");
			}
		}, () -> {
			Drafts.dropVariant(f.from());
			noteDraft("Draft discarded");
		}, "variant:", x, y, iw, mx, my);
		// What (locked)
		String sizeText = c == null ? "?" : c.sizeX() + "×" + c.sizeY() + "×" + c.sizeZ();
		y += header(g, vWhat, "variant_what", (c == null ? "?" : c.type()) + " · " + sizeText + " · locked", x, y, iw, mx, my);
		if (vWhat.open()) {
			y = muted(g, "Type " + (c == null ? "?" : c.type()) + ", " + sizeText + " (its parameters below can change the size).", x + 4, y + 3, iw - 4) + 3;
		}
		// Style (live)
		StyleForm sf = f.style();
		StyleForm.Style base = sf.base();
		String cur = base == null ? null : base.id();
		y += header(g, vStyle, "variant_style", base == null ? "its own palette" : nameOf(base) + (sf.mix() ? " (custom mix)" : ""), x, y, iw, mx, my);
		Consumer<Bible> use = b -> f.chooseStyle(StyleForm.Style.of(b));
		if (vStyle.open()) {
			label(g, "Style", x + 4, y + 2);
			y = styleRow(g, "variant:style:", cur, false, null, use, x + 4 + LABEL_W, y + 2, iw - 4 - LABEL_W, mx, my);
			y = muted(g, "A Style re-skins it: its materials only (the design keeps its own parts).", x + 4 + LABEL_W, y, iw - 4 - LABEL_W) + 2;
		}
		// the old ids: preset chips and bible chips (dev)
		for (String p : LibraryFeature.palettes().presets().keySet()) {
			s.devControl("preset:" + p, p, true, p.equals(f.preset()), () -> f.choosePreset(p));
		}
		for (Bible b : SetFeature.bibles()) {
			if (!b.builtin()) {
				s.devControl("bible:" + b.id(), b.name(), true, b.id().equals(f.bible()), () -> use.accept(b));
			}
		}
		s.devControl("variant:browse", "browse", true, false, () -> StyleBrowserScreen.open(cur, use));
		// Materials (live)
		y += header(g, vMaterials, "variant_materials", base == null ? "its own" : sf.mix() ? "custom mix · based on " + nameOf(base) : "from " + nameOf(base), x, y, iw, mx, my);
		if (vMaterials.open()) {
			if (base == null) {
				y = muted(g, "This design has no Style: pick one to re-skin it.", x + 4, y + 2, iw - 4) + 2;
			} else {
				y = materialRows(g, "variant", sf, f::setField, vMoreRoles, x + 4, y + 2, iw - 4, mx, my, e -> LibraryFeature.say(e, true));
			}
		}
		// Features (locked)
		List<String> feats = new ArrayList<>();
		if (c != null && c.request() != null && c.request().has("features") && c.request().get("features").isJsonArray()) {
			for (JsonElement e : c.request().getAsJsonArray("features")) {
				DesignSpec.Choice ch = DesignSpec.find(DesignSpec.FEATURES, e.getAsString());
				feats.add(ch == null ? e.getAsString() : ch.label());
			}
		}
		y += header(g, vFeatures, "variant_features", (feats.isEmpty() ? "none" : String.join(", ", feats)) + " · locked", x, y, iw, mx, my);
		if (vFeatures.open()) {
			y = muted(g, feats.isEmpty() ? "Designed without extra features." : "Designed with " + String.join(", ", feats) + ". Remix… to change them.",
				x + 4, y + 3, iw - 4) + 3;
		}
		// Rules (locked)
		y += header(g, vRules, "variant_rules", "as designed · locked", x, y, iw, mx, my);
		if (vRules.open()) {
			y = muted(g, "Checked against its type's rules when it was designed; a variant is checked again when it is built.", x + 4, y + 3, iw - 4) + 3;
		}
		// Parameters (live)
		int changed = f.changedValues().size();
		y += header(g, vParams, "variant_parameters", f.params().isEmpty() ? "none declared" : f.params().size() + " · " + changed + " changed", x, y, iw,
			mx, my);
		y = variantParams(g, f, lib, vParams.open(), x + 4, y + 2, iw - 4, mx, my);
		end(g, x, by, w, bh, y0, y);
		footerVariant(g, f, lib, x, w, footerY, mx, my);
	}

	private int variantParams(GuiGraphicsExtractor g, VariantForm f, LibraryTab lib, boolean open, int x, int y, int w, int mx, int my) {
		if (!open) {
			for (VariantForm.Param p : f.params()) {
				switch (p) {
					case VariantForm.IntParam ip -> {
						s.devControl("param:" + p.name() + ":-", "−", true, false, () -> f.step(p.name(), -1));
						s.devControl("param:" + p.name() + ":+", "+", true, false, () -> f.step(p.name(), 1));
					}
					case VariantForm.BoolParam bp -> s.devControl("param:" + p.name(), p.label(), true, false, () -> f.toggle(p.name()));
					case VariantForm.EnumParam ep -> {
						for (String o : ep.options()) {
							s.devControl("param:" + p.name() + "=" + o, o, true, false, () -> f.set(p.name(), new JsonPrimitive(o)));
						}
					}
				}
			}
			return y;
		}
		if (f.params().isEmpty()) {
			y = muted(g, "This design declares no parameters: only its Style and materials can change.", x, y + 2, w) + 2;
		}
		int pl = 0;
		for (VariantForm.Param p : f.params()) {
			pl = Math.max(pl, font().width(p.label()));
		}
		pl = Math.min(pl + 8, w / 2);
		for (VariantForm.Param p : f.params()) {
			g.text(font(), TextUtil.ellipsize(font(), p.label(), pl - 4), x, y + 5, UiBits.ink(), false);
			int cx = x + pl;
			JsonPrimitive v = f.value(p.name());
			switch (p) {
				case VariantForm.IntParam ip -> {
					Chip minus = new Chip("−", () -> f.step(p.name(), -1));
					minus.disabled(v.getAsInt() <= ip.min());
					cx += chip(g, "param:" + p.name() + ":-", minus, cx, y, mx, my) + 3;
					String val = Integer.toString(v.getAsInt());
					int vw = Math.max(font().width(Integer.toString(ip.max())), font().width(val)) + 6;
					g.text(font(), val, cx + (vw - font().width(val)) / 2, y + 5, UiBits.ink(), false);
					cx += vw + 3;
					Chip plus = new Chip("+", () -> f.step(p.name(), 1));
					plus.disabled(v.getAsInt() >= ip.max());
					cx += chip(g, "param:" + p.name() + ":+", plus, cx, y, mx, my) + 6;
					g.text(font(), ip.min() + "–" + ip.max(), cx, y + 5, UiStyle.mutedText(), false);
					y += ROW;
				}
				case VariantForm.BoolParam bp -> {
					boolean on = v.getAsBoolean();
					chip(g, "param:" + p.name(), new Chip(on ? "on" : "off", () -> f.toggle(p.name())).selected(on), cx, y, mx, my);
					y += ROW;
				}
				case VariantForm.EnumParam ep -> {
					int ex = cx;
					for (String o : ep.options()) {
						Chip oc = new Chip(o, () -> f.set(p.name(), new JsonPrimitive(o))).selected(o.equals(v.getAsString()));
						int ow = oc.width(font());
						if (ex > cx && ex + ow > x + w) {
							ex = cx;
							y += ROW;
						}
						ex += chip(g, "param:" + p.name() + "=" + o, oc, ex, y, mx, my) + 3;
					}
					y += ROW;
				}
			}
		}
		if (!f.skipped().isEmpty()) {
			g.text(font(), TextUtil.ellipsize(font(), "ignored: " + String.join("; ", f.skipped()), w), x, y, UiBits.errorText(), false);
			y += 11;
		}
		label(g, "Name", x, y);
		s.textField(g, Focus.VNAME, lib.variantNameView, lib.variantName, x + LABEL_W, y, w - LABEL_W, new TextFieldView.Style(null, 0,
			"optional; default: its name + what changed", null, null, 0, 1));
		return y + TextFieldView.BASE_H + 4;
	}

	private void footerVariant(GuiGraphicsExtractor g, VariantForm f, LibraryTab lib, int x, int w, int footerY, int mx, int my) {
		String status;
		boolean err;
		if (LibraryFeature.variantSending()) {
			status = "Sending…";
			err = false;
		} else if (LibraryFeature.variantError() != null) {
			status = LibraryFeature.variantError();
			err = true;
		} else if (draftNote() != null) {
			status = draftNote();
			err = false;
		} else if (!f.changed()) {
			status = "Pick another Style, change a material or a parameter. No Claude call: the design's own code runs again.";
			err = false;
		} else if (!Sidecar.connected()) {
			status = "The design helper is not running (Status tab).";
			err = true;
		} else {
			status = "Will make: " + LibraryTab.summary(f);
			err = false;
		}
		s.statusLineAt(g, status, err, x, footerY - 13, w);
		int bx = x + w;
		String go = "Make variant";
		bx -= s.bw(go);
		s.button(g, "variant:make", go, bx, footerY, s.bw(go), true, f.changed() && !LibraryFeature.variantSending() && Sidecar.connected(), mx, my,
			lib::submitVariant);
		String sd = "Save draft";
		bx -= s.bw(sd) + 6;
		s.button(g, "variant:save_draft", sd, bx, footerY, s.bw(sd), false, true, mx, my, () -> {
			try {
				Drafts.saveVariant(f);
				noteDraft("Draft saved: it is offered when you open this design's variants again");
			} catch (java.io.IOException e) {
				LibraryFeature.say("Draft not saved: " + e.getMessage(), true);
			}
		});
		String cancel = "Cancel";
		bx -= s.bw(cancel) + 6;
		s.button(g, "variant:cancel", cancel, bx, footerY, s.bw(cancel), false, true, mx, my, lib::closeDialog);
	}

	/** The open sections (DevBridge: which are open, to make shots reproducible). */
	JsonObject sectionsJson() {
		JsonObject o = new JsonObject();
		for (CollapsibleSection sec : List.of(what, style, materials, moreRoles, features, rules, params, vWhat, vStyle, vMaterials, vMoreRoles, vFeatures,
			vRules, vParams)) {
			o.addProperty(sec.key(), sec.open());
		}
		o.addProperty("saveAsOpen", saveMode);
		o.addProperty("contentH", contentH);
		return o;
	}

	/** Sets sections open or closed by key (DevBridge), e.g. {@code architect_mc.editor.features: true}. */
	void setSections(JsonObject o) {
		for (var e : o.entrySet()) {
			CollapsibleSection.setOpen(e.getKey(), e.getValue().getAsBoolean());
		}
	}

	static String lower(String s) {
		return s.toLowerCase(Locale.ROOT);
	}
}
