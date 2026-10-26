package dev.larattalabs.architect.client.launcher;

import dev.larattalabs.architect.client.hud.HudInk;
import dev.larattalabs.architect.client.hud.ProgressStrip;
import dev.larattalabs.architect.launcher.LauncherPlan.State;
import dev.larattalabs.labui.client.ui.Kit;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.hud.HudZones;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;

/**
 * The helper's install and first start as one progress strip (UI-2b), top left, while no screen is open: "Installing the design
 * helper (about 200 MB, first run only)… 0:42" over a sweeping bar, and npm's latest output line under it when there is one
 * ({@code npm ci} prints no percentage when it is not writing to a terminal, so the progress is the elapsed time, the moving
 * bar and npm's own last line). Only until the helper first runs in this session: a later reconnect stays quiet.
 *
 * <p>UI-0.3: a lab-ui {@link HudZones} element in {@code TOP_LEFT} (below vanilla's "Now playing"), optional: hidden when the
 * zone has no room for it (the install's state is also on the Status tab and in the toasts).
 */
public final class HelperProgressHud implements HudZones.Element {
	private static volatile @org.jspecify.annotations.Nullable String previewLabel;
	private static volatile @org.jspecify.annotations.Nullable String previewNpm;
	private static volatile long previewSince;

	/** DevBridge {@code dev.ui2b.helperPreview}: draw the strip with this label (null = the real state only). */
	public static void preview(@org.jspecify.annotations.Nullable String label, @org.jspecify.annotations.Nullable String npm) {
		previewLabel = label;
		previewNpm = npm;
		previewSince = System.currentTimeMillis();
	}

	private String label = "";
	private @org.jspecify.annotations.Nullable String npm;
	private @org.jspecify.annotations.Nullable String clock;

	@Override
	public HudZones.@org.jspecify.annotations.Nullable Size measure(Font font, HudZones.Frame f, int maxW) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player == null) {
			return null;
		}
		State st = Launcher.state();
		boolean installing = st == State.INSTALLING;
		String pl = previewLabel;
		if (pl == null && !installing && !(st == State.STARTING && !Launcher.readyToasted())) {
			return null;
		}
		Kit.Padding p = Kit.padding("tooltip");
		npm = pl != null ? previewNpm : installing ? Launcher.installLine() : null;
		long since = pl != null ? previewSince : Launcher.installStartedAt();
		label = pl != null ? pl : Launcher.summary();
		clock = since > 0 ? ProgressStrip.elapsed(since) : null;
		// up to 320 wide, narrower beside the top-centre pieces (at least 160: then it moves below them)
		int w = Math.max(160, Math.min(Math.min(320, f.guiWidth() / 2 - 8), maxW));
		int h = p.top() + p.bottom() + ProgressStrip.H + (npm != null ? 10 : 0);
		return HudZones.Size.of(w, h).optional();
	}

	@Override
	public void draw(GuiGraphicsExtractor g, Font font, HudZones.Frame f, HudZones.Slot slot) {
		Kit.Padding p = Kit.padding("tooltip");
		int x = slot.x();
		int y = slot.y();
		int w = slot.w();
		int inner = w - p.left() - p.right();
		Panels.sprite(g, Kit.TOOLTIP, x, y, w, slot.h(), 0xF0FFFFFF);
		ProgressStrip.draw(g, font, x + p.left(), y + p.top(), inner, label, clock, -1, HudInk.text(), HudInk.bar(), HudInk.track());
		String n = npm;
		if (n != null) {
			g.text(font, TextUtil.ellipsize(font, "npm: " + n, inner), x + p.left(), y + p.top() + ProgressStrip.H + 1, HudInk.soft(), false);
		}
	}
}
