package dev.larattalabs.architect.client.screen;

import dev.larattalabs.architect.library.StyleCatalog;
import dev.larattalabs.labui.client.hud.UiBits;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.labui.client.widget.Button;
import java.util.List;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;

/**
 * (PR P1) Preview on ghost's strip: the Style browser collapsed to a bottom strip (the Style's name, ◀ ▶ through the grid's current
 * filter, Use, Back) while the world shows the design wearing that Style ({@link StylePeek}). Back restores the browser exactly; Use picks
 * the Style as "Use this style" does. The world stays paused behind the strip as the browser was; the ghost still draws. ◀ ▶ settle for
 * {@link #DEBOUNCE_MS} before the model is built.
 */
public final class StylePeekScreen extends Screen {
	static final long DEBOUNCE_MS = 250;
	private final StyleBrowserScreen browser;
	private final List<String> ids;
	private final StylePeek.Target target;
	private int index;
	private long dueAt;
	private final Button prev = new Button("◀", () -> step(-1));
	private final Button next = new Button("▶", () -> step(1));
	private final Button use = new Button("Use this style", this::use).primary(true);
	private final Button back = new Button("Back", this::back);

	StylePeekScreen(StyleBrowserScreen browser, List<String> ids, int index, StylePeek.Target target) {
		super(Component.literal("Preview in world"));
		this.browser = browser;
		this.ids = List.copyOf(ids);
		this.index = Math.max(0, Math.min(index, ids.size() - 1));
		this.target = target;
		dueAt = System.currentTimeMillis();
	}

	StyleCatalog.Card card() {
		return browser.cardById(ids.get(index));
	}

	String styleId() {
		return ids.get(index);
	}

	void step(int d) {
		index = Math.floorMod(index + d, ids.size());
		browser.select(ids.get(index));
		dueAt = System.currentTimeMillis() + DEBOUNCE_MS; // settle before building
	}

	/** Rebuild now (DevBridge after forcing the outline). */
	void refresh() {
		dueAt = System.currentTimeMillis();
	}

	void use() {
		StylePeek.clear();
		browser.select(ids.get(index));
		minecraft.gui.setScreen(browser);
		browser.useSelected();
	}

	void back() {
		StylePeek.clear();
		browser.select(ids.get(index));
		minecraft.gui.setScreen(browser);
	}

	@Override
	public void tick() {
		if (dueAt > 0 && System.currentTimeMillis() >= dueAt) {
			dueAt = 0;
			StyleCatalog.Card c = card();
			if (c != null) {
				StylePeek.show(target, c.bible());
			}
		}
	}

	@Override
	public boolean isPauseScreen() {
		return dev.larattalabs.architect.client.ui.ScreenPause.pauses();
	}

	@Override
	public void extractBackground(GuiGraphicsExtractor g, int mx, int my, float a) {
		// no dim and no blur: the world (and the ghost) is what is shown
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float a) {
		if (StylePeek.frame()) {
			dueAt = System.currentTimeMillis(); // slow frames: rebuild as the outline
		}
		super.extractRenderState(g, mx, my, a);
		StyleCatalog.Card c = card();
		String name = c == null ? "?" : c.bible().name();
		int line = TextUtil.lh(10);
		int lines = StylePeek.thinned() ? 3 : 2;
		int h = 6 + Button.H + 4 + lines * line + 6;
		int w = Math.min(width - 16, 520);
		int x = (width - w) / 2;
		int y = height - h - 8;
		Panels.panel(g, x, y, w, h);
		int bx = x + 8;
		int by = y + 6;
		// ◀ ▶ stay put; the name follows them
		prev.draw(g, font, bx, by, 20, Button.H, mx, my);
		next.draw(g, font, bx + 24, by, 20, Button.H, mx, my);
		int bw = Button.width(font, "Back");
		int uw = Button.width(font, "Use this style");
		int nameRoom = w - 16 - 48 - uw - bw - 12;
		g.text(font, TextUtil.ellipsize(font, name, nameRoom), bx + 50, by + (Button.H - TextUtil.lh(8)) / 2, UiBits.ink(), false);
		back.draw(g, font, x + w - 8 - bw, by, bw, Button.H, mx, my);
		use.draw(g, font, x + w - 8 - bw - 4 - uw, by, uw, Button.H, mx, my);
		int ly = by + Button.H + 4;
		String what = (StylePeek.close() ? "Close to the design's own materials · " : "") + "Materials only: shapes and parts come when it's designed · "
			+ (target.sample() ? "on " : "") + target.name();
		g.text(font, TextUtil.ellipsize(font, what, w - 16), x + 8, ly, UiBits.muted(), false);
		ly += line;
		g.text(font, TextUtil.ellipsize(font, (index + 1) + " of " + ids.size() + " · Left/Right or ◀ ▶ · Enter uses it · Esc back", w - 16), x + 8, ly,
			UiBits.muted(), false);
		if (StylePeek.thinned()) {
			ly += line;
			g.text(font, TextUtil.ellipsize(font, "A large design: only its outline and roof are drawn", w - 16), x + 8, ly, UiStyle.error(), false);
		}
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean dbl) {
		double mx = e.x();
		double my = e.y();
		return prev.mouseClicked(mx, my, e.button()) || next.mouseClicked(mx, my, e.button()) || use.mouseClicked(mx, my, e.button()) || back
			.mouseClicked(mx, my, e.button()) || super.mouseClicked(e, dbl);
	}

	@Override
	public boolean keyPressed(KeyEvent e) {
		if (e.isEscape()) {
			back();
			return true;
		}
		if (e.key() == com.mojang.blaze3d.platform.InputConstants.KEY_LEFT) {
			step(-1);
			return true;
		}
		if (e.key() == com.mojang.blaze3d.platform.InputConstants.KEY_RIGHT) {
			step(1);
			return true;
		}
		if (dev.larattalabs.labui.client.text.TextKeys.isEnter(e)) {
			use();
			return true;
		}
		return super.keyPressed(e);
	}

	@Override
	public void onClose() {
		back();
	}

	/** DevBridge: the strip's state. */
	com.google.gson.JsonObject stateJson() {
		com.google.gson.JsonObject o = new com.google.gson.JsonObject();
		o.addProperty("style", styleId());
		o.addProperty("index", index);
		o.addProperty("count", ids.size());
		o.addProperty("entry", target.entry());
		o.addProperty("sample", target.sample());
		o.addProperty("thinned", StylePeek.thinned());
		return o;
	}
}
