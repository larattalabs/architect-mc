package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.labui.client.text.TextFieldView;
import dev.larattalabs.labui.client.text.TextKeys;
import dev.larattalabs.labui.client.text.TextModel;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.labui.client.widget.Button;
import dev.larattalabs.labui.client.widget.Control;
import dev.larattalabs.labui.client.widget.Paint;
import dev.larattalabs.labui.client.widget.Tooltip;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) The frame of Architect's full-screen Style screens (the Style editor, "Describe a style"), in lab-ui's picker
 * look: a cream panel with a walnut frame, a title bar with ‹ Back and a key hint, text fields that take focus by click or Tab, and every
 * control registered by id each frame (DevBridge {@code dev.u3.click}, {@code dev.u3.state}). Esc goes back to the parent. Client thread.
 */
abstract class U3Screen extends Screen {
	protected static final int TITLE_H = 22;
	protected final @Nullable Screen parent;
	protected final Tooltip tooltip = new Tooltip();
	private final Button back = new Button("‹ Back", this::back);
	/** Controls drawn this frame, by id. */
	protected final Map<String, Control> controls = new LinkedHashMap<>();
	/** Widgets with their own mouse handling drawn this frame. */
	protected final List<ArchitectScreen.MouseTarget> targets = new ArrayList<>();
	private final List<Field> fields = new ArrayList<>();
	private final List<Field> drawnFields = new ArrayList<>();
	private @Nullable Field focus;

	/** A text field: its model, its view and how it looks. */
	protected static final class Field {
		final String id;
		final TextModel model;
		final TextFieldView view = new TextFieldView();
		TextFieldView.Style style;
		int x;
		int y;
		int w;
		Runnable onEnter = () -> {
		};

		Field(String id, TextModel model, TextFieldView.Style style) {
			this.id = id;
			this.model = model;
			this.style = style;
		}
	}

	protected U3Screen(String title, @Nullable Screen parent) {
		super(Component.literal(title));
		this.parent = parent;
	}

	protected Field field(String id, TextModel m, @Nullable String placeholder, int lines) {
		Field f = new Field(id, m, new TextFieldView.Style(null, 0, placeholder, null, null, 0, lines));
		fields.add(f);
		return f;
	}

	protected void focus(@Nullable Field f) {
		if ((f != null) != (focus != null) && minecraft != null) {
			minecraft.onTextInputFocusChange(this, f != null);
		}
		focus = f;
		if (f != null) {
			f.model.touch();
		}
	}

	protected @Nullable Field focused() {
		return focus;
	}

	/** Focuses a field by id (DevBridge), at its end. */
	boolean focusField(String id) {
		for (Field f : fields) {
			if (f.id.equals(id)) {
				focus(f);
				f.model.moveTo(f.model.length(), false);
				return true;
			}
		}
		return false;
	}

	protected int drawField(GuiGraphicsExtractor g, Field f, int x, int y, int w) {
		f.x = x;
		f.y = y;
		f.w = w;
		drawnFields.add(f);
		return f.view.draw(g, font, f.model, x, y, w, focus == f, f.style);
	}

	@Override
	public boolean isPauseScreen() {
		return parent != null && parent.isPauseScreen();
	}

	@Override
	public void onClose() {
		back();
	}

	public void back() {
		focus(null);
		minecraft.gui.setScreen(parent);
	}

	@Override
	public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		g.fillGradient(0, 0, width, height, UiStyle.withAlpha(UiStyle.INK, 110), UiStyle.withAlpha(UiStyle.INK, 160));
	}

	@Override
	public final void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float a) {
		if (U3Dev.park) {
			mx = -1000;
			my = -1000;
		}
		super.extractRenderState(g, mx, my, a);
		controls.clear();
		targets.clear();
		drawnFields.clear();
		int px = 6;
		int py = 6;
		int pw = width - 12;
		int ph = height - 12;
		g.fill(px, py, px + pw, py + ph, UiStyle.CREAM);
		Paint.border(g, px, py, pw, ph, UiStyle.WALNUT);
		Paint.border(g, px + 1, py + 1, pw - 2, ph - 2, UiStyle.WALNUT);
		Paint.border(g, px + 2, py + 2, pw - 4, ph - 4, UiStyle.PAPER);
		int ix = px + 2;
		int iw = pw - 4;
		g.fill(ix, py + 2, ix + iw, py + 2 + TITLE_H, UiStyle.titleBar());
		int bw = font.width(back.label()) + 14;
		back.draw(g, font, ix + 3, py + 4, bw, Button.MIN_H, mx, my);
		control("back", back);
		int tx = ix + 3 + bw + 8;
		String hint = hint();
		int hw = font.width(hint);
		int room = ix + iw - 8 - tx;
		boolean showHint = hw + 12 + Math.min(font.width(title()), 120) <= room;
		g.text(font, TextUtil.ellipsize(font, title(), showHint ? room - hw - 12 : room), tx, py + 9, UiStyle.titleText(), false);
		if (showHint) {
			g.text(font, hint, ix + iw - 8 - hw, py + 9, UiStyle.withAlpha(UiStyle.titleText(), 190), false);
		}
		body(g, ix, py + 2 + TITLE_H, iw, py + ph - 2, mx, my);
		g.nextStratum();
		for (Control c : controls.values()) {
			tooltip.offer(c, mx, my);
		}
		tooltip.draw(g, font, mx, my);
	}

	/** The title bar's title. */
	protected abstract String title();

	protected String hint() {
		return "Tab next field · Esc back";
	}

	/** Draws the body between the title bar and the bottom edge. */
	protected abstract void body(GuiGraphicsExtractor g, int x, int top, int w, int bottom, int mx, int my);

	/** Registers a control drawn this frame under {@code id}. */
	protected <C extends Control> C control(String id, C c) {
		if (c.shown()) {
			controls.put(id, c);
		}
		return c;
	}

	/** Presses a control by id (DevBridge); false when it isn't shown or is disabled. */
	boolean click(String id) {
		Control c = controls.get(id);
		if (c == null || c.isDisabled()) {
			return false;
		}
		c.press();
		return true;
	}

	/** The controls drawn last frame (DevBridge). */
	JsonArray controlsJson() {
		JsonArray a = new JsonArray();
		for (var e : controls.entrySet()) {
			JsonObject o = new JsonObject();
			o.addProperty("id", e.getKey());
			o.addProperty("enabled", !e.getValue().isDisabled());
			o.addProperty("x", e.getValue().x());
			o.addProperty("y", e.getValue().y());
			o.addProperty("w", e.getValue().width());
			o.addProperty("h", e.getValue().height());
			a.add(o);
		}
		return a;
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean doubleClick) {
		double mx = e.x();
		double my = e.y();
		for (ArchitectScreen.MouseTarget t : List.copyOf(targets)) {
			if (t.click(mx, my, e.button())) {
				focus(null);
				return true;
			}
		}
		for (Control c : List.copyOf(controls.values())) {
			if (c.mouseClicked(mx, my, e.button())) {
				return true;
			}
		}
		for (Field f : List.copyOf(drawnFields)) {
			int at = f.view.hit(font, f.model, f.x, f.y, f.w, f.style, mx, my);
			if (at >= 0) {
				focus(f);
				f.model.moveTo(at, false);
				return true;
			}
		}
		focus(null);
		return super.mouseClicked(e, doubleClick);
	}

	@Override
	public boolean mouseDragged(MouseButtonEvent e, double dx, double dy) {
		for (ArchitectScreen.MouseTarget t : List.copyOf(targets)) {
			if (t.drag(e.x(), e.y(), e.button())) {
				return true;
			}
		}
		return super.mouseDragged(e, dx, dy);
	}

	@Override
	public boolean mouseReleased(MouseButtonEvent e) {
		for (ArchitectScreen.MouseTarget t : List.copyOf(targets)) {
			if (t.release(e.x(), e.y(), e.button())) {
				return true;
			}
		}
		return super.mouseReleased(e);
	}

	@Override
	public boolean mouseScrolled(double mx, double my, double sx, double sy) {
		for (ArchitectScreen.MouseTarget t : List.copyOf(targets)) {
			if (t.wheel(mx, my, sy)) {
				return true;
			}
		}
		return super.mouseScrolled(mx, my, sx, sy);
	}

	@Override
	public boolean keyPressed(KeyEvent e) {
		if (e.isEscape()) {
			if (focus != null) {
				focus(null);
			} else {
				back();
			}
			return true;
		}
		if (dev.larattalabs.labui.client.widget.NavKeys.isTab(e) && !fields.isEmpty()) {
			int i = focus == null ? -1 : fields.indexOf(focus);
			focus(fields.get(Math.floorMod(i + (e.hasShiftDown() ? -1 : 1), fields.size())));
			focus.model.moveTo(focus.model.length(), false);
			return true;
		}
		if (TextKeys.isEnter(e) && e.hasControlDown()) {
			return ctrlEnter();
		}
		Field f = focus;
		if (f != null) {
			if (TextKeys.isEnter(e) && f.style.maxLines() <= 1) {
				f.onEnter.run();
				return true;
			}
			TextKeys.handle(e, f.model);
			edited(f);
			return true;
		}
		return super.keyPressed(e);
	}

	@Override
	public boolean charTyped(CharacterEvent e) {
		Field f = focus;
		if (f != null && e.codepoint() >= 32) {
			f.model.insert(e.codepointAsString());
			edited(f);
			return true;
		}
		return false;
	}

	/** After a keystroke in {@code f}. */
	protected void edited(Field f) {
	}

	/** Ctrl+Enter: the screen's main action; returns whether it was handled. */
	protected boolean ctrlEnter() {
		return false;
	}

	/** What the screen shows, for the DevBridge. */
	abstract JsonObject stateJson();
}
