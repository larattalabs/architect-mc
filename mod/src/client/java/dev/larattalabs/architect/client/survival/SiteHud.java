package dev.larattalabs.architect.client.survival;

import dev.larattalabs.labui.client.ui.Kit;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.architect.survival.SiteNet;
import dev.larattalabs.labui.client.hud.HudZones;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import dev.larattalabs.architect.client.design.UiPrefs;
import dev.larattalabs.architect.client.hud.HudInk;
import org.jspecify.annotations.Nullable;

/**
 * The construction HUD line (docs/CONTRACT.md phase 3 "UI"): while a site the player placed is building and they are within
 * 64 blocks, a small ink strip at the top centre: "Log Cabin 62% · needs 40 spruce planks" (or "paused", "crate missing",
 * "3 cells blocked").
 *
 * <p>UI-2b: the player sizes it ({@link UiPrefs#siteHud}, the J key or the Status tab): full (the line and its progress bar),
 * one line ("Log Cabin 62%", no bar), or hidden. While the placement HUD is up it shows one line at most, so the two and the
 * toasts don't stack. Colours are {@link HudInk}'s.
 *
 * <p>UI-0.3: a lab-ui {@link HudZones} element in {@code TOP_CENTER} (below vanilla's boss bars), which may shrink to its one-line
 * form ({@link HudZones.Slot#collapsed()}: the short line, no bar) when the zone is short.
 */
final class SiteHud implements HudZones.Element {
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
			tail = "paused" + (s.needs().isEmpty() ? "" : " · needs " + s.needs());
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

	/** The one-line form: the name and the percent, and "crate missing" / "paused" when so. */
	static @Nullable String shortLine(SiteGhosts.Ghost g) {
		SiteNet.SiteStatus s = g.status;
		if (s == null) {
			return null;
		}
		int pct = s.total() == 0 ? 100 : s.built() * 100 / s.total();
		return s.name() + " " + pct + "%" + (s.crateMissing() ? " · crate missing" : s.paused() ? " · paused" : "");
	}

	/** The mode drawn now: the player's, at most one line while placing. */
	static UiPrefs.SiteHud mode() {
		UiPrefs.SiteHud m = UiPrefs.siteHud();
		if (m == UiPrefs.SiteHud.FULL && (dev.larattalabs.architect.client.placement.BuildPlacement.active()
			|| dev.larattalabs.architect.client.placement.BuildPlacement.hudRect() != null)) {
			return UiPrefs.SiteHud.LINE;
		}
		return m;
	}

	private SiteGhosts.@Nullable Ghost ghost;
	private UiPrefs.SiteHud drawn = UiPrefs.SiteHud.HIDDEN;

	@Override
	public HudZones.@Nullable Size measure(Font font, HudZones.Frame f, int zoneW) {
		Minecraft mc = Minecraft.getInstance();
		ghost = null;
		UiPrefs.SiteHud mode = mode();
		if (mode == UiPrefs.SiteHud.HIDDEN) {
			return null;
		}
		SiteGhosts.Ghost g = shown(mc);
		String line = g == null ? null : mode == UiPrefs.SiteHud.LINE ? shortLine(g) : line(g);
		if (line == null) {
			return null;
		}
		ghost = g;
		drawn = mode;
		Kit.Padding p = Kit.padding("tooltip");
		int maxW = Math.min(360, f.guiWidth() - 16);
		String full = TextUtil.ellipsize(font, line, maxW - p.left() - p.right() - 4);
		int w = font.width(full) + p.left() + p.right() + 4; // the short line is a prefix of the full one: it fits too
		int lineH = font.lineHeight + p.top() + p.bottom() + 2;
		int h = mode == UiPrefs.SiteHud.FULL ? font.lineHeight + p.top() + p.bottom() + 8 : lineH;
		return HudZones.Size.of(w, h).shrinkTo(lineH);
	}

	@Override
	public void draw(GuiGraphicsExtractor g, Font font, HudZones.Frame f, HudZones.Slot slot) {
		SiteGhosts.Ghost gh = ghost;
		if (gh == null || gh.status == null) {
			return;
		}
		// collapsed (the zone is short) or the player's LINE mode: the short line, no bar
		boolean full = drawn == UiPrefs.SiteHud.FULL && !slot.collapsed();
		String line = full ? line(gh) : shortLine(gh);
		if (line == null) {
			return;
		}
		Kit.Padding p = Kit.padding("tooltip");
		String text = TextUtil.ellipsize(font, line, slot.w() - p.left() - p.right() - 4);
		int x = slot.x();
		int y = slot.y();
		int w = slot.w();
		Panels.sprite(g, Kit.TOOLTIP, x, y, w, slot.h());
		SiteNet.SiteStatus s = gh.status;
		double frac = s.total() == 0 ? 1 : (double) s.built() / s.total();
		Panels.text(g, font, text, x + p.left() + 2, y + p.top(), s.crateMissing() ? HudInk.error() : HudInk.text());
		if (!full) {
			return;
		}
		int bw = w - p.left() - p.right() - 4;
		int by = y + p.top() + font.lineHeight + 2;
		g.fill(x + p.left() + 2, by, x + p.left() + 2 + bw, by + 2, HudInk.track());
		g.fill(x + p.left() + 2, by, x + p.left() + 2 + (int) Math.round(bw * frac), by + 2, s.paused() ? HudInk.armed() : HudInk.ok());
	}
}
