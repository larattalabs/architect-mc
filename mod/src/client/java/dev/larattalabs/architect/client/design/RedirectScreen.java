package dev.larattalabs.architect.client.design;

import dev.larattalabs.labui.client.hud.UiBits;
import dev.larattalabs.architect.client.text.TextFieldView;
import dev.larattalabs.architect.client.text.TextKeys;
import dev.larattalabs.architect.client.text.TextModel;
import dev.larattalabs.labui.client.ui.Kit;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import java.util.function.Consumer;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * "Redirect…" (docs/CONTRACT.md phase 4c "UI"): a small dialog with one notes field that says how the massing should change
 * ("make it L-shaped with a tower at the corner"). Enter sends, Shift+Enter is a new line, Esc goes back. It does not pause the
 * game (the massing ghost stays in view behind it). Client thread.
 */
public final class RedirectScreen extends Screen {
	public static final int MAX_NOTES = 2000;
	private final String what;
	private final Consumer<String> send;
	private final Runnable back;
	final TextModel notes = new TextModel(MAX_NOTES);
	private final TextFieldView view = new TextFieldView();
	private @Nullable String error;
	private int[] sendRect = new int[4];
	private int[] backRect = new int[4];
	private int[] fieldRect = new int[3];

	public RedirectScreen(String what, Consumer<String> send, Runnable back) {
		super(Component.literal("Redirect the massing"));
		this.what = what;
		this.send = send;
		this.back = back;
	}

	@Override
	protected void init() {
		if (minecraft != null) {
			minecraft.onTextInputFocusChange(this, true);
		}
	}

	@Override
	public void removed() {
		if (minecraft != null) {
			minecraft.onTextInputFocusChange(this, false);
		}
		super.removed();
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	/** Sends the notes (DevBridge too). Returns false (and says why) when they are empty. */
	public boolean submit() {
		String n = notes.value().strip();
		if (n.isEmpty()) {
			error = "Say what should change first";
			return false;
		}
		onClose();
		send.accept(n);
		return true;
	}

	public void typeNotes(String s) {
		notes.set(s);
	}

	@Override
	public void onClose() {
		if (minecraft != null) {
			minecraft.gui.setScreen(null);
		}
	}

	private void goBack() {
		onClose();
		back.run();
	}

	@Override
	public boolean keyPressed(KeyEvent e) {
		if (e.isEscape()) {
			goBack();
			return true;
		}
		if (TextKeys.isEnter(e) && !e.hasShiftDown()) {
			submit();
			return true;
		}
		if (TextKeys.isEnter(e)) {
			notes.insert("\n");
			return true;
		}
		TextKeys.handle(e, notes);
		error = null;
		return true;
	}

	@Override
	public boolean charTyped(CharacterEvent e) {
		if (e.codepoint() >= 32) {
			notes.insert(e.codepointAsString());
			error = null;
		}
		return true;
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean doubleClick) {
		if (in(sendRect, e.x(), e.y())) {
			submit();
			return true;
		}
		if (in(backRect, e.x(), e.y())) {
			goBack();
			return true;
		}
		int at = view.hit(font, notes, fieldRect[0], fieldRect[1], fieldRect[2], style(), e.x(), e.y());
		if (at >= 0) {
			notes.moveTo(at, false);
		}
		return true;
	}

	private static boolean in(int[] r, double x, double y) {
		return x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];
	}

	private TextFieldView.Style style() {
		return new TextFieldView.Style(null, 0, "what should change, e.g. make it L-shaped with a tower at the corner", null, notes.length() + "/"
			+ MAX_NOTES, UiBits.muted(), 4);
	}

	@Override
	public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		// no blur: the massing stays visible behind the dialog
		g.fillGradient(0, 0, width, height, UiStyle.withAlpha(UiStyle.INK, 0), UiStyle.withAlpha(UiStyle.INK, 60));
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		int w = Math.min(360, width - 16);
		Kit.Padding pad = Kit.padding("panel_paper");
		int inner = w - pad.left() - pad.right();
		int fieldH = view.height(font, notes, inner, style());
		int h = pad.top() + 14 + 22 + fieldH + 8 + 20 + pad.bottom() + (error != null ? 11 : 0);
		int x = (width - w) / 2;
		int y = height - h - 24;
		Panels.panel(g, x, y, w, h);
		int cx = x + pad.left();
		int cy = y + pad.top();
		Panels.header(g, font, "Redirect the massing", cx - 2, cy - 2, inner + 4);
		cy += 16;
		for (String line : TextUtil.wrapPlain(font, what, inner).stream().limit(2).toList()) {
			g.text(font, line, cx, cy, UiBits.muted(), false);
			cy += 10;
		}
		cy = y + pad.top() + 14 + 22;
		fieldRect = new int[] {cx, cy, inner};
		view.draw(g, font, notes, cx, cy, inner, true, style());
		cy += fieldH + 8;
		if (error != null) {
			g.text(font, TextUtil.ellipsize(font, error, inner), cx, cy - 4, UiBits.errorText(), false);
			cy += 11;
		}
		String go = "Redirect";
		int gw = UiBits.buttonWidth(font, go, 0);
		int bx = cx + inner - gw;
		sendRect = new int[] {bx, cy, gw, 20};
		UiBits.button(g, font, go, 0, bx, cy, gw, true, notes.value().isBlank() ? UiBits.ButtonState.DISABLED : in(sendRect, mouseX, mouseY)
			? UiBits.ButtonState.HOVER : UiBits.ButtonState.NORMAL, false);
		String bk = "Back";
		int kw = UiBits.buttonWidth(font, bk, 0);
		bx -= kw + 6;
		backRect = new int[] {bx, cy, kw, 20};
		UiBits.button(g, font, bk, 0, bx, cy, kw, false, in(backRect, mouseX, mouseY) ? UiBits.ButtonState.HOVER : UiBits.ButtonState.NORMAL, false);
		String[] hints = {"Enter", "redirect", "Shift+Enter", "new line", "Esc", "back"};
		if (UiBits.hintsWidth(font, hints) <= bx - cx - 6) {
			UiBits.hints(g, font, cx, cy + 4, false, hints);
		}
	}
}
