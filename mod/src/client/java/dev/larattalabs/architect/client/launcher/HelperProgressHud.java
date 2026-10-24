package dev.larattalabs.architect.client.launcher;

import dev.larattalabs.architect.client.hud.HudInk;
import dev.larattalabs.architect.client.hud.ProgressStrip;
import dev.larattalabs.architect.launcher.LauncherPlan.State;
import dev.larattalabs.labui.client.ui.Kit;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElement;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;

/**
 * The helper's install and first start as one progress strip (UI-2b), top left, while no screen is open: "Installing the design
 * helper (about 200 MB, first run only)… 0:42" over a sweeping bar, and npm's latest output line under it when there is one
 * ({@code npm ci} prints no percentage when it is not writing to a terminal, so the progress is the elapsed time, the moving
 * bar and npm's own last line). Only until the helper first runs in this session: a later reconnect stays quiet.
 */
public final class HelperProgressHud implements HudElement {
	private static volatile @org.jspecify.annotations.Nullable String previewLabel;
	private static volatile @org.jspecify.annotations.Nullable String previewNpm;
	private static volatile long previewSince;

	/** DevBridge {@code dev.ui2b.helperPreview}: draw the strip with this label (null = the real state only). */
	public static void preview(@org.jspecify.annotations.Nullable String label, @org.jspecify.annotations.Nullable String npm) {
		previewLabel = label;
		previewNpm = npm;
		previewSince = System.currentTimeMillis();
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, DeltaTracker deltaTracker) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player == null || mc.gui.screen() != null) {
			return;
		}
		State st = Launcher.state();
		boolean installing = st == State.INSTALLING;
		String pl = previewLabel;
		if (pl == null && !installing && !(st == State.STARTING && !Launcher.readyToasted())) {
			return;
		}
		Font font = mc.font;
		Kit.Padding p = Kit.padding("tooltip");
		int w = Math.min(240, g.guiWidth() / 2 - 8);
		int inner = w - p.left() - p.right();
		String npm = pl != null ? previewNpm : installing ? Launcher.installLine() : null;
		long since = pl != null ? previewSince : Launcher.installStartedAt();
		String label = (pl != null ? pl : Launcher.summary()) + (since > 0 ? " " + ProgressStrip.elapsed(since) : "");
		int h = p.top() + p.bottom() + ProgressStrip.H + (npm != null ? 10 : 0);
		int x = 4;
		int y = 4;
		Panels.sprite(g, Kit.TOOLTIP, x, y, w, h, 0xF0FFFFFF);
		ProgressStrip.draw(g, font, x + p.left(), y + p.top(), inner, label, -1, HudInk.text(), HudInk.bar(), HudInk.track());
		if (npm != null) {
			g.text(font, TextUtil.ellipsize(font, "npm: " + npm, inner), x + p.left(), y + p.top() + ProgressStrip.H + 1, HudInk.soft(), false);
		}
	}
}
