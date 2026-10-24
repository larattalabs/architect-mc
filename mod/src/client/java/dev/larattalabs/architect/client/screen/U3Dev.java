package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.client.design.DesignFeature;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.architect.client.dev.Fields;
import dev.larattalabs.architect.client.library.LibraryFeature;
import dev.larattalabs.architect.library.StyleForm;
import dev.larattalabs.labui.client.picker.PickerScreen;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;

/**
 * (Style unification U3) DevBridge hooks for the new screens (docs/DEVBRIDGE.md "U3"): what the open screen shows, the editor's folds,
 * the Style browser (open, select, menus), the Style editor and "Describe a style" (fill, click), a material / role picker (search,
 * pick), and Save as style… from either editor mode. The Architect screen's own controls stay on dev.ui.click. Client only.
 */
public final class U3Dev {
	private U3Dev() {
	}

	static ArchitectScreen arch(Minecraft mc) {
		if (mc.gui.screen() instanceof ArchitectScreen s) {
			return s;
		}
		throw new DevBridge.DevException("the Architect screen is not open (dev.ui.open)");
	}

	/** What the open screen is and shows. */
	static JsonObject state(Minecraft mc) {
		Screen sc = mc.gui.screen();
		JsonObject o;
		if (sc instanceof StyleBrowserScreen b) {
			o = b.stateJson();
		} else if (sc instanceof U3Screen u) {
			o = u.stateJson();
		} else if (sc instanceof PickerScreen p) {
			o = new JsonObject();
			o.addProperty("screen", "picker");
			o.addProperty("picker", p.spec().id());
			o.addProperty("title", p.spec().title());
			o.addProperty("debug", p.debugState());
			o.addProperty("entries", p.spec().entries().size());
			o.addProperty("current", p.spec().current());
		} else if (sc instanceof ArchitectScreen a) {
			o = new JsonObject();
			o.addProperty("screen", "architect");
			o.addProperty("tab", a.tab().id());
			o.add("sections", a.editor.sectionsJson());
		} else {
			o = new JsonObject();
			o.addProperty("screen", sc == null ? null : sc.getClass().getSimpleName());
		}
		return o;
	}

	/** The Style browser's use: the Design tab's form (NEW) or the open Variants dialog (VARIANT). */
	static Consumer<Bible> use(String forWhat) {
		if (forWhat.equals("variant")) {
			return b -> {
				var f = LibraryFeature.variantForm();
				if (f == null) {
					throw new IllegalStateException("no Variants dialog is open");
				}
				f.chooseStyle(StyleForm.Style.of(b));
			};
		}
		return b -> DesignFeature.form().pickBible(b);
	}

	/** Shots: the screens draw as if the mouse were away (no hover, no tooltip), so a shot doesn't depend on where the cursor rests. */
	static volatile boolean park;

	public static void init() {
		DevBridge.register("dev.u3.park", 10_000, "{on: bool} - (U3) the Architect and Style screens draw as if the mouse were away (no hover, no "
			+ "tooltips) for reproducible shots -> {park}", (req, mc) -> DevBridge.onClient(mc, () -> {
				park = Fields.of(req).bool("on");
				JsonObject o = new JsonObject();
				o.addProperty("park", park);
				return o;
			}));
		DevBridge.register("dev.u3.state", 10_000, "{} - (U3) the open screen: the Style browser / Style editor / Describe a style / a picker / the "
			+ "Architect screen's editor folds", (req, mc) -> DevBridge.onClient(mc, () -> state(mc)));
		DevBridge.register("dev.u3.sections", 10_000, "{set: {<key>: bool}} - (U3) fold or open the editor's sections (keys architect_mc.editor.* and "
			+ "architect_mc.variant.*), for reproducible shots -> the folds", (req, mc) -> DevBridge.onClient(mc, () -> {
				Fields f = Fields.of(req);
				ArchitectScreen a = mc.gui.screen() instanceof ArchitectScreen s ? s : null;
				DesignEditor e = a != null ? a.editor : new DesignEditor(null);
				if (f.has("set")) {
					e.setSections(f.json().getAsJsonObject("set"));
				}
				return e.sectionsJson();
			}));
		DevBridge.register("dev.u3.browser.open", 10_000, "{for?: design|variant, current?} - (U3) the Style browser over the open screen; using a "
			+ "Style picks it for the Design tab's form or the open Variants dialog", (req, mc) -> DevBridge.onClient(mc, () -> {
				Fields f = Fields.of(req);
				String forWhat = f.optStr("for", "design");
				String cur = f.optStr("current", null);
				if (cur == null) {
					StyleForm sf = forWhat.equals("variant") && LibraryFeature.variantForm() != null ? LibraryFeature.variantForm().style()
						: DesignFeature.form().styleForm;
					cur = sf.base() == null ? null : sf.base().id();
				}
				StyleBrowserScreen.open(cur, use(forWhat));
				return state(mc);
			}));
		DevBridge.register("dev.u3.browser", 10_000, "{select?: id, query?: text, rail?: group|null, menu?: new|builtin|tags|null, item?: copy|builtin|"
			+ "describe, builtin?: id, use?: true, favourite?: true} - (U3) drive the open Style browser", (req, mc) -> DevBridge.onClient(mc, () -> {
				if (!(mc.gui.screen() instanceof StyleBrowserScreen b)) {
					throw new DevBridge.DevException("the Style browser is not open (dev.u3.browser.open)");
				}
				Fields f = Fields.of(req);
				if (f.has("query")) {
					b.setQuery(f.str("query"));
				}
				if (f.has("rail")) {
					b.model().setGroup(f.isExplicitNull("rail") ? null : f.str("rail"));
				}
				if (f.has("select") && !b.select(f.str("select"))) {
					throw new DevBridge.DevException("no Style " + f.str("select"));
				}
				if (f.has("menu")) {
					b.menu(f.isExplicitNull("menu") ? null : f.str("menu"));
				}
				if (f.has("favourite") && f.bool("favourite") && b.selectedCard() != null) {
					dev.larattalabs.labui.client.picker.PickerStore.toggleFavourite(StyleBrowserScreen.ID, b.selectedCard().id());
					b.model().setFavourites(dev.larattalabs.labui.client.picker.PickerStore.memory().favourites(StyleBrowserScreen.ID));
				}
				if (f.has("builtin") && !b.fromBuiltin(f.str("builtin"))) {
					throw new DevBridge.DevException("no built-in Style " + f.str("builtin"));
				}
				if (f.has("item")) {
					b.menuItem(f.str("item"));
				}
				if (f.optBool("use", false)) {
					b.useSelected();
				}
				return state(mc);
			}));
		DevBridge.register("dev.u3.click", 10_000, "{control} - (U3) press a control of the open Style browser (use, duplicate, edit), Style editor "
			+ "(save, cancel, back, feature:<id>, tag:remove:<t>, role:<role>, material:<field>=<v>, palette:<field>, section:*) or Describe a style "
			+ "(draft, cancel) -> {clicked} + the state", (req, mc) -> DevBridge.onClient(mc, () -> {
				String id = Fields.of(req).nonBlank("control");
				Screen sc = mc.gui.screen();
				boolean ok;
				if (sc instanceof StyleBrowserScreen b) {
					ok = switch (id) {
						case "use" -> {
							b.useSelected();
							yield true;
						}
						case "duplicate" -> {
							b.duplicateSelected();
							yield true;
						}
						case "edit" -> {
							boolean can = b.selectedCard() != null && b.selectedCard().canEdit();
							b.editSelected();
							yield can;
						}
						default -> throw new DevBridge.DevException("the Style browser has use, duplicate, edit (got " + id + ")");
					};
				} else if (sc instanceof U3Screen u) {
					ok = u.click(id);
				} else {
					throw new DevBridge.DevException("no U3 screen is open");
				}
				JsonObject o = state(mc);
				o.addProperty("clicked", ok);
				return o;
			}));
		DevBridge.register("dev.u3.editor.fill", 10_000, "{name?, addTags?, removeTag?, main?: {field: value}, roles?: {role: block}, features?: [toggle]}"
			+ " - (U3) edit the open Style editor", (req, mc) -> DevBridge.onClient(mc, () -> {
				if (!(mc.gui.screen() instanceof StyleEditorScreen e)) {
					throw new DevBridge.DevException("the Style editor is not open");
				}
				try {
					e.fill(req);
				} catch (IllegalArgumentException | IllegalStateException ex) {
					throw new DevBridge.DevException(ex.getMessage());
				}
				return e.stateJson();
			}));
		DevBridge.register("dev.u3.describe.fill", 10_000, "{name?, prompt?} - (U3) type into Describe a style", (req, mc) -> DevBridge.onClient(mc, () -> {
			if (!(mc.gui.screen() instanceof DescribeStyleScreen d)) {
				throw new DevBridge.DevException("Describe a style is not open");
			}
			Fields f = Fields.of(req);
			d.fill(f.optStr("name", null), f.optStr("prompt", null));
			return d.stateJson();
		}));
		DevBridge.register("dev.u3.picker", 10_000, "{query?, pick?: id, back?: true} - (U3) the open material / role picker: search, pick (as a "
			+ "click), or go back", (req, mc) -> DevBridge.onClient(mc, () -> {
				if (!(mc.gui.screen() instanceof PickerScreen p) || p instanceof StyleBrowserScreen) {
					throw new DevBridge.DevException("no material or role picker is open");
				}
				Fields f = Fields.of(req);
				if (f.has("query")) {
					p.setQuery(f.str("query"));
				}
				if (f.has("pick")) {
					var e = p.spec().byId(f.str("pick"));
					if (e == null) {
						throw new DevBridge.DevException("no entry " + f.str("pick") + " in " + p.spec().id());
					}
					p.model().select(e.id());
					p.pickSelected();
				} else if (f.optBool("back", false)) {
					p.back();
				}
				return state(mc);
			}));
		DevBridge.register("dev.u3.back", 10_000, "{} - (U3) Esc on the open Style screen / picker", (req, mc) -> DevBridge.onClient(mc, () -> {
			Screen sc = mc.gui.screen();
			if (sc instanceof PickerScreen p) {
				p.back();
			} else if (sc instanceof U3Screen u) {
				u.back();
			}
			return state(mc);
		}));
		DevBridge.register("dev.u3.saveAs", 30_000, "{mode: design|variant, name?} - (U3) Save as style… of an editor's custom mix (through the "
			+ "editor's name field path)", (req, mc) -> DevBridge.onClient(mc, () -> {
				Fields f = Fields.of(req);
				ArchitectScreen a = arch(mc);
				a.editor.saveAs(f.optStr("mode", "design"), f.optStr("name", null));
				return state(mc);
			}));
	}
}
