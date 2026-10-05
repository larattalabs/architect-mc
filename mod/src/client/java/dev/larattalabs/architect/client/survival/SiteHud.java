package dev.larattalabs.architect.client.survival;

import dev.larattalabs.architect.client.hud.UiBits;
import dev.larattalabs.architect.client.ui.Kit;
import dev.larattalabs.architect.client.ui.Panels;
import dev.larattalabs.architect.client.ui.TextUtil;
import dev.larattalabs.architect.client.ui.UiStyle;
import dev.larattalabs.architect.survival.SiteNet;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElement;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import org.jspecify.annotations.Nullable;

/**
 * The construction HUD line (docs/CONTRACT.md phase 3 "UI"): while a site the player placed is building and they are within
 * 64 blocks, a small ink strip at the top centre: "Log Cabin 62% · needs 40 spruce planks" (or "paused", "crate missing",
 * "3 cells blocked").
 */
final class SiteHud implements HudElement {
	static final int RANGE = 64;

	/** The line for a ghost, or null when its status hasn't come yet. */
	static @Nullable String line(SiteGhosts.Ghost g) {
		SiteNet.SiteStatus s = g.status;
		if (s == null) {
			return null;
		}
		int pct = s.total() == 0 ? 100 : s.built() * 100 / s.total();
		String tail;
		if (s.crateMissing()) {
			tail = "crate missing";
		} else if (s.paused()) {
			tail = "paused";
		} else if (!s.needs().isEmpty()) {
			tail = "needs " + s.needs();
		} else {
			tail = "building";
		}
		return s.name() + " " + pct + "% · " + tail + (s.blocked() > 0 ? " · " + s.blocked() + " blocked" : "");
	}

	/** The ghost the HUD shows: the player's own building site nearest to them within {@link #RANGE}. */
	static SiteGhosts.@Nullable Ghost shown(Minecraft mc) {
		if (mc.player == null) {
			return null;
		}
		String me = mc.player.getUUID().toString();
		SiteGhosts.Ghost best = null;
		double bestD = (double) RANGE * RANGE;
		for (SiteGhosts.Ghost g : SiteGhosts.all().values()) {
			if (g.status == null || !me.equals(g.status.owner()) || g.remaining() == 0) {
				continue;
			}
			double cx = g.ox + g.dx / 2.0;
			double cz = g.oz + g.dz / 2.0;
			double d = Math.max(0, Math.abs(mc.player.getX() - cx) - g.dx / 2.0);
			double e = Math.max(0, Math.abs(mc.player.getZ() - cz) - g.dz / 2.0);
			double dd = d * d + e * e;
			if (dd <= bestD) {
				bestD = dd;
				best = g;
			}
		}
		return best;
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, DeltaTracker deltaTracker) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.gui.screen() != null) {
			return;
		}
		SiteGhosts.Ghost ghost = shown(mc);
		String line = ghost == null ? null : line(ghost);
		if (line == null) {
			return;
		}
		Font font = mc.font;
		Kit.Padding p = Kit.padding("tooltip");
		int maxW = Math.min(360, g.guiWidth() - 16);
		String text = TextUtil.ellipsize(font, line, maxW - p.left() - p.right() - 4);
		int w = font.width(text) + p.left() + p.right() + 4;
		int h = font.lineHeight + p.top() + p.bottom() + 8;
		int x = (g.guiWidth() - w) / 2;
		int y = 4;
		Panels.sprite(g, Kit.TOOLTIP, x, y, w, h);
		SiteNet.SiteStatus s = ghost.status;
		double frac = s.total() == 0 ? 1 : (double) s.built() / s.total();
		Panels.text(g, font, text, x + p.left() + 2, y + p.top(), s.crateMissing() ? 0xFFF07060 : UiStyle.CREAM);
		int bw = w - p.left() - p.right() - 4;
		int by = y + p.top() + font.lineHeight + 2;
		g.fill(x + p.left() + 2, by, x + p.left() + 2 + bw, by + 2, UiStyle.withAlpha(UiBits.activityOnInk(), 0x60));
		g.fill(x + p.left() + 2, by, x + p.left() + 2 + (int) Math.round(bw * frac), by + 2, s.paused() ? UiStyle.BRASS : UiStyle.SAGE);
	}
}
