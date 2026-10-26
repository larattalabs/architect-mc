package dev.larattalabs.architect.client.placement;

import dev.larattalabs.architect.client.hud.HudInk;
import dev.larattalabs.architect.client.hud.ProgressStrip;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.placement.VerdictSummary;
import dev.larattalabs.labui.client.hud.UiBits;
import dev.larattalabs.labui.client.ui.Kit;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import java.util.ArrayList;
import java.util.List;
import dev.larattalabs.labui.client.hud.HudZones;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * The placement HUD: an ink panel above the hotbar (UI-2b layout):
 * <ol>
 * <li>the design, and the state chips, always shown: rotation, locked / follows the look, and, when armed, force (Shift+Enter)
 * and place on top;</li>
 * <li>the verdict: one progress strip while placing or checking with the server (a moving bar, not static text), "Ready", or
 * the refusals grouped ("Would be refused: 3 issues", the detail on "?");</li>
 * <li>what placing does, each count with a swatch of its ghost colour and its word (colour is never the only signal);</li>
 * <li>notes and the last status line;</li>
 * <li>the keys: one "? keys" hint, the full legend after "?" (or H).</li>
 * </ol>
 * Colours are {@link HudInk}'s (lab-ui on-dark tokens). After a placement (or a cancel) the last status line stays for a few seconds.
 *
 * <p>UI-0.3: a lab-ui {@link HudZones} element in {@code BOTTOM_CENTER} (the zone's floor is this panel's old place: 64 px above
 * the bottom, dropping to just above the hotbar on a short screen, never over the crosshair). {@link #measure} builds the rows
 * and fits them to that height ({@code HudFit}); {@link #draw} paints them at the slot. A fixed size: never hidden.
 */
final class PlacementHud implements HudZones.Element {
	private static final long STATUS_MS = 8000;
	private static final int LINE = 10;
	private static final int CHIP_H = 11;

	/** The rows measured this frame, drawn at the slot. */
	private List<Row> measured = List.of();

	@Override
	public HudZones.@Nullable Size measure(Font font, HudZones.Frame f, int zoneW) {
		Minecraft mc = Minecraft.getInstance();
		lastRect = null;
		measured = List.of();
		if (mc.player == null) {
			lastRows = List.of();
			return null;
		}
		BuildPlacement.View v = BuildPlacement.view();
		String status = BuildPlacement.status();
		boolean fresh = status != null && Util.getMillis() - BuildPlacement.statusAt < STATUS_MS;
		if (v == null && !fresh) {
			lastRows = List.of();
			return null;
		}
		int maxW = Math.min(420, f.guiWidth() - 16);
		Kit.Padding p = Kit.padding("tooltip");
		int inner = maxW - p.left() - p.right();
		boolean legend = BuildPlacement.legend();

		List<Row> rows = new ArrayList<>();
		// each row's priority on a short screen (HudFit): the title, chips and verdict stay; the rest drops lowest first
		List<Integer> prio = new ArrayList<>();
		java.util.function.BiConsumer<Row, Integer> add = (r, pr) -> {
			rows.add(r);
			prio.add(pr);
		};
		if (v != null) {
			String mv = BuildPlacement.moving();
			String title = mv != null ? "Moving " + mv + " (" + v.bp().name() + ")" : (BuildPlacement.preview() ? "Preview: " : "Placing ") + v.bp().name();
			add.accept(Row.text(TextUtil.ellipsize(font, title, inner), HudInk.text()), dev.larattalabs.architect.placement.HudFit.KEEP);
			add.accept(Row.chips(chips(v)), dev.larattalabs.architect.placement.HudFit.KEEP);
			if (BuildPlacement.tooFar()) {
				add.accept(Row.text(TextUtil.ellipsize(font, "▲ " + BuildPlacement.TOO_FAR, inner), HudInk.warn()), 9);
			}
			List<Row> vr = new ArrayList<>();
			verdict(vr, font, v, inner, legend);
			for (int i = 0; i < vr.size(); i++) {
				add.accept(vr.get(i), i == 0 ? dev.larattalabs.architect.placement.HudFit.KEEP : 6); // the headline stays, the detail may go
			}
			add.accept(Row.segs(counts(v)), 7);
			if (v.approach().rows() > 0) {
				dev.larattalabs.architect.placement.Approach.Plan ap = v.approach();
				int[] feet = ap.feet();
				int rise = feet[feet.length - 1] - feet[0];
				add.accept(Row.segs(List.of(new Seg(GhostRenderer.PATH | 0xFF000000, "entrance path " + ap.rows() + " blocks" + (rise == 0 ? ", level"
					: rise > 0 ? ", up " + rise : ", down " + -rise) + (ap.fillCount() == 0 ? "" : " · " + ap.fillCount() + " filled") + (ap.clearCount() == 0
					? "" : " · " + ap.clearCount() + " cut"), HudInk.soft()))), 3);
			}
			List<String> notes = v.notes();
			int shownNotes = legend ? notes.size() : Math.min(2, notes.size());
			for (int i = 0; i < shownNotes; i++) {
				// the swatch is the ghost colour the note's cells are drawn in (water, hazards), beside the words
				int ink = i < v.noteInk().size() ? v.noteInk().get(i) : 0;
				add.accept(Row.segs(List.of(new Seg(ink == 0 ? 0 : ink | 0xFF000000, "Note: " + notes.get(i), HudInk.note()))), 4);
			}
			if (shownNotes < notes.size()) {
				add.accept(Row.text("+" + (notes.size() - shownNotes) + " more notes (?)", HudInk.note()), 2);
			}
		}
		if (fresh || v != null && v.forceArmed()) {
			String s = status == null ? "" : status;
			boolean err = BuildPlacement.statusError();
			List<String> wrapped = TextUtil.wrapPlain(font, (err ? "✖ " : "") + s, inner);
			if (v != null && err && !legend && wrapped.size() > 1) {
				// while placing, a refusal's status repeats the grouped verdict and the chips: one line; "?" shows all of it
				wrapped = List.of(TextUtil.ellipsize(font, (err ? "✖ " : "") + s, inner));
			}
			for (int i = 0; i < wrapped.size(); i++) {
				// while placing, a refusal's status repeats the verdict: it goes first on a short screen (alone it stays)
				add.accept(Row.text(wrapped.get(i), err ? HudInk.error() : HudInk.text()), v == null ? dev.larattalabs.architect.placement.HudFit.KEEP
					: i == 0 ? 4 : 1);
			}
		}
		String[][] keys = v == null || BuildPlacement.preview() ? new String[0][] : keyRows(v, legend, font, inner);
		for (int i = 0; i < keys.length; i++) {
			add.accept(Row.keys(keys[i]), i == keys.length - 1 ? 8 : 5); // the last key row holds "?" (hide) or "? keys"
		}
		// fit a short screen: never over the crosshair (the ghost is aimed with it); creative has no hearts above the hotbar (the
		// zone's own floor: HudLayout BOTTOM_CENTER)
		boolean bars = f.survivalBars();
		int fixed = p.top() + p.bottom() - 1;
		int[] hs = new int[rows.size()];
		int[] ps = new int[rows.size()];
		for (int i = 0; i < rows.size(); i++) {
			hs[i] = rows.get(i).height();
			ps[i] = prio.get(i);
		}
		boolean[] keep = dev.larattalabs.architect.placement.HudFit.keep(hs, ps, fixed, f.guiHeight() - (bars ? 50 : 26) - (f.guiHeight() / 2 + 8));
		List<Row> fit = new ArrayList<>();
		for (int i = 0; i < rows.size(); i++) {
			if (keep[i]) {
				fit.add(rows.get(i));
			}
		}
		rows.clear();
		rows.addAll(fit);
		int textW = 0;
		int h = fixed;
		for (Row r : rows) {
			textW = Math.max(textW, r.width(font));
			h += r.height();
		}
		measured = List.copyOf(rows);
		return HudZones.Size.of(Math.min(maxW, textW + p.left() + p.right()), h);
	}

	@Override
	public void draw(GuiGraphicsExtractor g, Font font, HudZones.Frame f, HudZones.Slot slot) {
		List<Row> rows = measured;
		if (rows.isEmpty()) {
			return;
		}
		Kit.Padding p = Kit.padding("tooltip");
		int x = slot.x();
		int y = slot.y();
		int w = slot.w();
		int h = slot.h();
		lastRect = new int[] {x, y, w, h};
		Panels.sprite(g, Kit.TOOLTIP, x, y, w, h, 0xF0FFFFFF);
		int ty = y + p.top();
		int iw = w - p.left() - p.right();
		List<String> drawn = new ArrayList<>();
		for (Row r : rows) {
			r.draw(g, font, x + p.left(), ty, iw);
			drawn.add(r.plain());
			ty += r.height();
		}
		lastRows = drawn;
	}

	/** The state chips: rotation and lock always; force and place-on-top when armed. */
	private static List<Chip> chips(BuildPlacement.View v) {
		List<Chip> c = new ArrayList<>();
		c.add(new Chip("rotation " + BlueprintTransform.rotationName(v.turns()).replace('_', ' ').toLowerCase(java.util.Locale.ROOT), HudInk.soft(), false));
		c.add(new Chip("entrance " + v.front(), HudInk.soft(), false));
		c.add(v.locked() ? new Chip("■ locked", HudInk.text(), true) : new Chip("□ follows your look", HudInk.soft(), false));
		if (v.forceArmed()) {
			c.add(new Chip("! force armed: Shift+Enter", HudInk.armed(), true));
		}
		if (BuildPlacement.layerArmed()) {
			c.add(new Chip("▲ place on top: Enter", HudInk.armed(), true));
		}
		return c;
	}

	/** The verdict row(s): a progress strip, Ready, or the grouped refusals (the detail when "?" is on). */
	private static void verdict(List<Row> rows, Font font, BuildPlacement.View v, int inner, boolean legend) {
		if (v.pending()) {
			String mv = BuildPlacement.moving();
			rows.add(Row.progress(mv != null ? "Moving " + mv + "…" : "Placing…"));
			return;
		}
		VerdictSummary sum = null;
		if (v.refusals().isEmpty()) {
			// S4: "Ready" only once the server checked the exact site; its reasons when it would refuse
			dev.larattalabs.architect.site.Sites.Verdict sv = BuildPlacement.serverVerdict();
			if (sv == null) {
				rows.add(Row.progress("Checking the site with the server…"));
				return;
			}
			if (sv.ok()) {
				String ready = BuildPlacement.preview() ? "Preview: the server would place it here" : BuildPlacement.moving() != null
					? "Ready: Enter moves it here (the old site comes back as it was)" : "Ready: Enter places it";
				rows.add(Row.text(TextUtil.ellipsize(font, "✔ " + ready, inner), HudInk.ok()));
				return;
			}
			sum = VerdictSummary.of("The server would refuse", sv.refusals());
		} else {
			sum = VerdictSummary.of("Would be refused", v.refusals());
		}
		rows.add(Row.text(TextUtil.ellipsize(font, "✖ " + sum.headline() + (sum.expandable() && !legend ? " (? details)" : ""), inner), HudInk.error()));
		if (legend) {
			for (String d : sum.detail()) {
				for (String l : TextUtil.wrapPlain(font, d, inner - 6)) {
					rows.add(Row.text("  " + l, HudInk.error()));
				}
			}
		}
	}

	/** The counts with a swatch of the ghost colour each and their words. */
	private static List<Seg> counts(BuildPlacement.View v) {
		List<Seg> s = new ArrayList<>();
		if (v.obstructedCount() == 0 && v.blockedCount() == 0) {
			s.add(new Seg(0, "nothing in the way", HudInk.soft()));
		}
		if (v.obstructedCount() > 0) {
			s.add(new Seg(GhostRenderer.OBSTRUCTED | 0xFF000000, v.obstructedCount() + " block" + (v.obstructedCount() == 1 ? "" : "s") + " replaced", HudInk.warn()));
		}
		if (v.blockedCount() > 0) {
			s.add(new Seg(GhostRenderer.BLOCKED | 0xFF000000, v.blockedCount() + " block entit" + (v.blockedCount() == 1 ? "y" : "ies") + " (chests, signs…)",
				HudInk.error()));
		}
		s.add(v.fillCount() == 0 ? new Seg(0, "no foundation needed", HudInk.soft()) : new Seg(GhostRenderer.FOUNDATION | 0xFF000000, v.fillCount()
			+ " foundation", HudInk.soft()));
		if (v.clearCount() > 0) {
			s.add(new Seg(GhostRenderer.CLEARED | 0xFF000000, v.clearCount() + " terrain cleared", HudInk.soft()));
		}
		if (v.lavaCount() > 0) {
			s.add(new Seg(GhostRenderer.LAVA | 0xFF000000, v.lavaCount() + " lava", HudInk.error()));
		}
		return s;
	}

	/** The key rows: collapsed, "? keys" (plus the armed choice); after "?", the whole legend wrapped to the panel. */
	private static String[][] keyRows(BuildPlacement.View v, boolean legend, Font font, int inner) {
		if (!legend) {
			List<String> k = new ArrayList<>(List.of("?", "keys"));
			if (v.forceArmed()) {
				k.addAll(List.of("Shift+Enter", "force"));
			}
			k.addAll(List.of("Enter", BuildPlacement.layerArmed() ? "on top" : "place", "Esc", "cancel"));
			String[] a = k.toArray(String[]::new);
			return UiBits.hintsWidth(font, a) <= inner ? new String[][] {a} : new String[][] {{"?", "keys", "Enter", "place"}};
		}
		List<String> all = new ArrayList<>(List.of("R", "rotate", "Shift+R", "back", "Arrows", "nudge", "PgUp/Dn", "raise", "L", v.locked() ? "unlock" : "lock",
			"Enter", BuildPlacement.layerArmed() ? "on top" : "place"));
		if (v.forceArmed()) {
			all.addAll(List.of("Shift+Enter", "force"));
		}
		all.addAll(List.of("Esc", "cancel", "?", "hide"));
		List<String[]> out = new ArrayList<>();
		List<String> row = new ArrayList<>();
		for (int i = 0; i < all.size(); i += 2) {
			List<String> next = new ArrayList<>(row);
			next.add(all.get(i));
			next.add(all.get(i + 1));
			if (!row.isEmpty() && UiBits.hintsWidth(font, next.toArray(String[]::new)) > inner) {
				out.add(row.toArray(String[]::new));
				row = new ArrayList<>(List.of(all.get(i), all.get(i + 1)));
			} else {
				row = next;
			}
		}
		if (!row.isEmpty()) {
			out.add(row.toArray(String[]::new));
		}
		return out.toArray(String[][]::new);
	}

	/** The panel drawn last frame (x, y, w, h), null when hidden: the goal bar and toasts keep clear of it. */
	static volatile int @Nullable [] lastRect;
	/** The rows drawn last frame as plain text (DevBridge {@code dev.build.state}'s {@code hud}). */
	static volatile List<String> lastRows = List.of();

	private record Chip(String text, int color, boolean on) {
	}

	private record Seg(int swatch, String text, int color) {
	}

	/** One HUD row: text, a chip row, swatch segments, a progress strip or a key row. */
	private record Row(int kind, @Nullable String text, int color, List<Chip> chips, List<Seg> segs, String @Nullable [] keys) {
		static final int TEXT = 0;
		static final int CHIPS = 1;
		static final int SEGS = 2;
		static final int PROGRESS = 3;
		static final int KEYS = 4;

		static Row text(String t, int c) {
			return new Row(TEXT, t, c, List.of(), List.of(), null);
		}

		static Row chips(List<Chip> c) {
			return new Row(CHIPS, null, 0, c, List.of(), null);
		}

		static Row segs(List<Seg> s) {
			return new Row(SEGS, null, 0, List.of(), s, null);
		}

		static Row progress(String label) {
			return new Row(PROGRESS, label, HudInk.soft(), List.of(), List.of(), null);
		}

		static Row keys(String[] k) {
			return new Row(KEYS, null, 0, List.of(), List.of(), k);
		}

		int height() {
			return switch (kind) {
				case CHIPS -> CHIP_H + 2;
				case PROGRESS -> ProgressStrip.H + 1;
				case KEYS -> 15;
				default -> LINE;
			};
		}

		int width(Font font) {
			return switch (kind) {
				case CHIPS -> {
					int w = 0;
					for (Chip c : chips) {
						w += font.width(c.text()) + 6 + 3;
					}
					yield w - 3;
				}
				case SEGS -> {
					int w = 0;
					for (Seg s : segs) {
						w += (s.swatch() != 0 ? 9 : 0) + font.width(s.text()) + 8;
					}
					yield w - 8;
				}
				case PROGRESS -> Math.max(font.width(text) + 8, 160);
				case KEYS -> UiBits.hintsWidth(font, keys);
				default -> font.width(text);
			};
		}

		void draw(GuiGraphicsExtractor g, Font font, int x, int y, int w) {
			switch (kind) {
				case CHIPS -> {
					int cx = x;
					for (Chip c : chips) {
						int cw = font.width(c.text()) + 6;
						if (cx + cw > x + w) {
							break;
						}
						g.fill(cx, y, cx + cw, y + CHIP_H, dev.larattalabs.labui.client.ui.UiStyle.withAlpha(c.on() ? c.color() : HudInk.chipEdge(), c.on() ? 0x30 : 0x80));
						g.fill(cx, y, cx + cw, y + 1, HudInk.chipEdge());
						g.fill(cx, y + CHIP_H - 1, cx + cw, y + CHIP_H, HudInk.chipEdge());
						g.fill(cx, y, cx + 1, y + CHIP_H, HudInk.chipEdge());
						g.fill(cx + cw - 1, y, cx + cw, y + CHIP_H, HudInk.chipEdge());
						g.text(font, c.text(), cx + 3, y + 2, c.color(), false);
						cx += cw + 3;
					}
				}
				case SEGS -> {
					int cx = x;
					for (Seg s : segs) {
						int need = (s.swatch() != 0 ? 9 : 0) + font.width(s.text());
						if (cx + need > x + w) {
							String t = TextUtil.ellipsize(font, s.text(), x + w - cx - (s.swatch() != 0 ? 9 : 0));
							if (s.swatch() != 0) {
								swatch(g, cx, y, s.swatch());
								cx += 9;
							}
							g.text(font, t, cx, y, s.color(), false);
							break;
						}
						if (s.swatch() != 0) {
							swatch(g, cx, y, s.swatch());
							cx += 9;
						}
						g.text(font, s.text(), cx, y, s.color(), false);
						cx += font.width(s.text()) + 8;
					}
				}
				case PROGRESS -> ProgressStrip.draw(g, font, x, y, w, text, -1, color, HudInk.bar(), HudInk.track());
				case KEYS -> UiBits.hints(g, font, x, y + 2, true, keys);
				default -> g.text(font, text, x, y, color, false);
			}
		}

		/** A 7 x 7 swatch with a light edge (the ghost colour of the count beside it). */
		private static void swatch(GuiGraphicsExtractor g, int x, int y, int argb) {
			g.fill(x, y, x + 7, y + 7, HudInk.soft());
			g.fill(x + 1, y + 1, x + 6, y + 6, argb);
		}

		String plain() {
			return switch (kind) {
				case CHIPS -> "[" + String.join("] [", chips.stream().map(Chip::text).toList()) + "]";
				case SEGS -> String.join(" · ", segs.stream().map(s -> (s.swatch() != 0 ? "■ " : "") + s.text()).toList());
				case PROGRESS -> "~ " + text;
				case KEYS -> "keys: " + String.join(" ", keys);
				default -> text;
			};
		}
	}
}
