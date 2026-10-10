package dev.larattalabs.architect.client.hud;

import dev.larattalabs.labui.client.hud.UiBits;
import dev.larattalabs.labui.client.ui.Kit;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.architect.ui.ToastStack;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElement;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * In-game paper toasts (design done / failed, the sidecar's state): a title, two lines of text, an optional key hint;
 * "need you" toasts get a clay stripe. They slide in at the top right, stack (need-you first, newest on top, three at most,
 * {@link ToastStack}); what does not fit waits and is counted on one "+N more" line. Not drawn while a screen is open.
 */
public final class Toasts implements HudElement {
	public enum Level { INFO, WARN, NEED }

	private static final int W = 196;
	private static final long QUEUE_MS = 30_000;
	private static final long QUEUE_NEED_MS = 120_000;
	private static final int MORE_H = 13;
	private static final int SLIDE_MS = 180;
	private static final int FADE_MS = 350;
	private static final List<Toast> ACTIVE = new ArrayList<>();
	private static int shown;

	private static final class Toast {
		final Level level;
		final String title;
		final String body;
		final String icon;
		final long arrived;
		long start = -1;
		final long life;
		final @Nullable String hintKey;
		final String hintVerb;

		Toast(Level level, String title, String body, String icon, long arrived, long life, @Nullable String hintKey, String hintVerb) {
			this.level = level;
			this.title = title;
			this.body = body;
			this.icon = icon;
			this.arrived = arrived;
			this.life = life;
			this.hintKey = hintKey;
			this.hintVerb = hintVerb;
		}

		boolean need() {
			return level == Level.NEED;
		}

		boolean over(long now) {
			return start >= 0 ? now - start > life : now - arrived > (need() ? QUEUE_NEED_MS : QUEUE_MS);
		}
	}

	private static ToastStack.Layout lastLayout = new ToastStack.Layout(List.of(), List.of(), 0, 0, -1);
	private static List<Toast> lastOrder = List.of();

	/** QA: the newest toast's title and body. */
	public static @Nullable String lastText() {
		return ACTIVE.isEmpty() ? null : ACTIVE.get(0).title + ": " + ACTIVE.get(0).body;
	}

	public static int shown() {
		return shown;
	}

	public static void push(Level level, String title, String body) {
		push(level, title, body, null, null);
	}

	/** Add a toast (client thread) with an optional key hint ("B" "open"). */
	public static void push(Level level, String title, String body, @Nullable String hintKey, @Nullable String hintVerb) {
		long life = switch (level) {
			case NEED -> 9000;
			case WARN -> 8000;
			default -> 5500;
		};
		String icon = level == Level.NEED ? "decision" : level == Level.WARN ? "test" : "message";
		ACTIVE.add(0, new Toast(level, title, body, icon, Util.getMillis(), life, hintKey, hintVerb == null ? "" : hintVerb));
		for (int drop = ToastStack.evict(needs(ACTIVE), ToastStack.MAX_KEPT); drop >= 0; drop = ToastStack.evict(needs(ACTIVE), ToastStack.MAX_KEPT)) {
			ACTIVE.remove(drop);
		}
		shown++;
	}

	private static List<Boolean> needs(List<Toast> ts) {
		List<Boolean> out = new ArrayList<>(ts.size());
		for (Toast t : ts) {
			out.add(t.need());
		}
		return out;
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, DeltaTracker deltaTracker) {
		Minecraft mc = Minecraft.getInstance();
		long now = Util.getMillis();
		ACTIVE.removeIf(t -> t.over(now));
		if (mc.player == null || ACTIVE.isEmpty() || mc.gui.screen() != null) {
			return;
		}
		Font font = mc.font;
		int y = 8;
		int[] placing = dev.larattalabs.architect.client.placement.BuildPlacement.hudRect();
		boolean bars = mc.gameMode != null && mc.gameMode.getPlayerMode().isSurvival();
		int limit = placing != null ? placing[1] - 4 : g.guiHeight() - (bars ? 50 : 26);
		List<Toast> order = new ArrayList<>();
		List<ToastStack.Item> items = new ArrayList<>();
		for (int i : ToastStack.order(needs(ACTIVE))) {
			Toast t = ACTIVE.get(i);
			order.add(t);
			items.add(new ToastStack.Item(t.need(), height(font, t)));
		}
		ToastStack.Layout l = ToastStack.layout(items, y, limit, 4, ToastStack.MAX_SHOWN, MORE_H);
		lastLayout = l;
		lastOrder = order;
		for (int k = 0; k < l.shown().size(); k++) {
			Toast t = order.get(l.shown().get(k));
			if (t.start < 0) {
				t.start = now;
			}
			draw(g, font, t, now, l.ys().get(k));
		}
		if (l.moreY() >= 0) {
			String text = ToastStack.moreText(l.hidden(), l.hiddenNeed());
			int w = Math.min(W, font.width(text) + 12);
			int x = g.guiWidth() - 6 - w;
			Panels.sprite(g, Kit.PANEL_PAPER, x, l.moreY(), w, MORE_H, 0xFFFFFFFF);
			g.text(font, TextUtil.ellipsize(font, text, w - 12), x + 6, l.moreY() + 3, l.hiddenNeed() > 0 ? UiStyle.CLAY_DARK : UiBits.muted(), false);
		}
	}

	private static List<FormattedCharSequence> lines(Font font, Toast t) {
		Kit.Padding p = Kit.padding("panel_paper");
		int textW = W - (p.left() + 20) - p.right();
		List<FormattedCharSequence> lines = TextUtil.wrap(font, UiBits.oneLine(t.body), textW);
		if (lines.size() > 2) {
			String second = TextUtil.wrapPlain(font, UiBits.oneLine(t.body), textW).get(1);
			lines = List.of(lines.get(0), net.minecraft.network.chat.Component.literal(TextUtil.ellipsize(font, second + " …", textW))
				.getVisualOrderText());
		}
		return lines;
	}

	private static int height(Font font, Toast t) {
		Kit.Padding p = Kit.padding("panel_paper");
		return Math.max(p.top() + 20 + p.bottom() - 2, p.top() + 10 + lines(font, t).size() * 10 + (t.hintKey != null ? 12 : 0) + p.bottom() - 2);
	}

	/** QA: the stack as last drawn. */
	public static com.google.gson.JsonObject json() {
		com.google.gson.JsonObject o = new com.google.gson.JsonObject();
		com.google.gson.JsonArray shownArr = new com.google.gson.JsonArray();
		ToastStack.Layout l = lastLayout;
		for (int k = 0; k < l.shown().size() && l.shown().get(k) < lastOrder.size(); k++) {
			Toast t = lastOrder.get(l.shown().get(k));
			com.google.gson.JsonObject j = new com.google.gson.JsonObject();
			j.addProperty("level", t.level.name().toLowerCase(Locale.ROOT));
			j.addProperty("title", t.title);
			j.addProperty("body", t.body);
			shownArr.add(j);
		}
		o.add("shown", shownArr);
		o.addProperty("queued", ACTIVE.size());
		o.addProperty("last", lastText());
		return o;
	}

	private static void draw(GuiGraphicsExtractor g, Font font, Toast t, long now, int y) {
		Kit.Padding p = Kit.padding("panel_paper");
		boolean need = t.need();
		int textX = p.left() + 20;
		int textW = W - textX - p.right();
		List<FormattedCharSequence> lines = lines(font, t);
		int h = height(font, t);
		long age = now - t.start;
		float slide = Math.min(1f, age / (float) SLIDE_MS);
		slide = 1f - (1f - slide) * (1f - slide);
		long left = t.life - age;
		float fade = left < FADE_MS ? Math.max(0f, left / (float) FADE_MS) : 1f;
		int x = g.guiWidth() - 6 - W + (int) ((1f - slide) * (W + 10));
		int a = (int) (255 * fade);
		if (a < 8) {
			return;
		}
		int tint = (a << 24) | 0xFFFFFF;
		Panels.sprite(g, Kit.PANEL_PAPER, x, y, W, h, tint);
		if (need) {
			g.fill(x + 3, y + 4, x + 5, y + h - 6, UiStyle.withAlpha(UiStyle.CLAY, a));
		}
		int px = x + p.left();
		int py = y + p.top() - 1;
		Panels.sprite(g, Kit.icon(t.icon), px + 2, py + 1, 12, 12, tint);
		int tx = x + textX;
		g.text(font, TextUtil.ellipsize(font, t.title, textW), tx, py + 1, UiStyle.withAlpha(need ? UiStyle.CLAY_DARK
			: t.level == Level.WARN ? UiBits.errorText() : UiBits.ink(), a), false);
		int ly = py + 12;
		for (FormattedCharSequence line : lines) {
			g.text(font, line, tx, ly, UiStyle.withAlpha(UiBits.ink(), a), false);
			ly += 10;
		}
		if (t.hintKey != null && a > 200) {
			int hw = UiBits.hintsWidth(font, t.hintKey, t.hintVerb);
			UiBits.hints(g, font, x + W - p.right() - hw, ly, false, t.hintKey, t.hintVerb);
		}
	}
}
