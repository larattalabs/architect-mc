package dev.larattalabs.architect.client.help;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.client.design.UiPrefs;
import dev.larattalabs.architect.client.hud.HudInk;
import dev.larattalabs.architect.client.hud.Keys;
import dev.larattalabs.architect.client.hud.PlacingKeys;
import dev.larattalabs.architect.client.help.GuideModel.Event;
import dev.larattalabs.architect.client.help.GuideModel.State;
import dev.larattalabs.architect.client.help.GuideModel.Step;
import dev.larattalabs.labui.client.hud.HudZones;
import dev.larattalabs.labui.client.ui.Kit;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.ui.GhostPalette;
import dev.larattalabs.labui.ui.Guard;
import dev.larattalabs.labui.ui.HudZone;
import java.util.List;
import java.util.Locale;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import org.jspecify.annotations.Nullable;

/**
 * (PR F1) The guided first build in the game: the {@link GuideModel} fed from the real actions (Library pick, placement start, rotate,
 * the verdict, the placement, the crate, the undo key), persisted in {@code architect_mc_ui.json} {@code guide}, its step card in a
 * top-centre HUD zone while playing and inside the Architect screen while it is open.
 */
public final class GuideFeature {
	private static GuideModel model;
	private static boolean installed;

	private GuideFeature() {
	}

	public static synchronized GuideModel model() {
		if (model == null) {
			String st = UiPrefs.guideState();
			State s = switch (st) {
				case "done" -> State.DONE;
				case "declined" -> State.DECLINED;
				case "paused" -> State.PAUSED;
				default -> State.NEW;
			};
			Step[] steps = Step.values();
			int i = Math.max(0, Math.min(steps.length - 1, UiPrefs.guideStep()));
			model = new GuideModel(s, steps[i], dev.larattalabs.architect.survival.SurvivalWorld.on());
		}
		return model;
	}

	public static void init() {
		if (installed) {
			return;
		}
		installed = true;
		HudZones.add(Architect.id("hud/guide"), HudZone.TOP_CENTER, new Card()).priority(80);
		ClientTickEvents.END_CLIENT_TICK.register(mc -> Guard.run("architect_mc:guide.tick", () -> tick(mc)));
	}

	/** DevBridge: reload from the prefs (after dev.pr.guide reset). */
	public static synchronized void resetForDev() {
		model = null;
	}

	/** Feeds an event from the game. */
	public static synchronized void on(Event e, @Nullable String arg) {
		GuideModel m = model();
		if (m.on(e, arg)) {
			persist(m);
		}
	}

	private static void persist(GuideModel m) {
		String st = switch (m.state()) {
			case DONE -> "done";
			case DECLINED -> "declined";
			case RUNNING, PAUSED, CLOSING -> "paused";
			default -> "new";
		};
		UiPrefs.setGuide(st, m.step().ordinal());
	}

	/** The Architect screen opened: offer the tour when this world has none of the player's own sites. */
	public static void screenOpened() {
		boolean none = dev.larattalabs.architect.site.Sites.all().stream().noneMatch(s -> s.owner() == null);
		model().survival(dev.larattalabs.architect.survival.SurvivalWorld.on());
		if (none) {
			on(Event.SCREEN_OPENED_NO_SITES, null);
		}
	}

	/** The card now (live key labels, the palette's outline words). */
	public static GuideModel.@Nullable Card card() {
		String ok = GhostPalette.current() == GhostPalette.Palette.OKABE_ITO ? "blue" : "green";
		return model().card(Keys.label(PlacingKeys.Action.ROTATE), Keys.label(PlacingKeys.Action.CONFIRM), Keys.label(Keys.undoLast), ok);
	}

	/** A card button was pressed (the screen's hit or DevBridge). */
	public static void press(String id) {
		switch (id) {
			case "guide:start" -> on(Event.START, null);
			case "guide:not_now" -> on(Event.NOT_NOW, null);
			case "guide:decline" -> on(Event.DECLINE, null);
			case "guide:resume" -> on(Event.RESUME, null);
			case "guide:keep" -> on(Event.KEEP, null);
			case "guide:close", "guide:design" -> on(Event.CLOSE, null);
			case "guide:okabe" -> dev.larattalabs.labui.client.prefs.LabUiPrefs.setGhostPalette(GhostPalette.current() == GhostPalette.Palette.STANDARD
				? GhostPalette.Palette.OKABE_ITO : GhostPalette.Palette.STANDARD);
			default -> {
			}
		}
	}

	/** True while the tour wants the world (its card is a HUD card then). */
	static boolean worldStep(GuideModel m) {
		return m.state() == State.RUNNING && switch (m.step()) {
			case MOVE_ROTATE, READ_OUTLINE, ENTER, OPEN_CRATE, UNDO_OR_KEEP -> true;
			default -> false;
		};
	}

	private static void tick(Minecraft mc) {
		GuideModel m = model();
		if (m.state() != State.RUNNING) {
			return;
		}
		// Esc in the world opens the pause menu: the tour pauses with it
		if (mc.gui.screen() instanceof net.minecraft.client.gui.screens.PauseScreen) {
			on(Event.ESC, null);
			return;
		}
		if (m.step() == Step.READ_OUTLINE) {
			Boolean fits = dev.larattalabs.architect.client.placement.BuildPlacement.fitsNow();
			if (fits != null) {
				on(fits ? Event.VERDICT_OK : Event.VERDICT_REFUSED, null);
			}
		}
	}

	/** The step card while playing (top centre, on ink). */
	static final class Card implements HudZones.Element {
		private List<String> lines = List.of();
		private String title = "";

		@Override
		public HudZones.@Nullable Size measure(Font font, HudZones.Frame f, int maxW) {
			GuideModel m = model();
			if (!worldStep(m) || Minecraft.getInstance().gui.screen() != null) {
				return null;
			}
			GuideModel.Card c = card();
			if (c == null) {
				return null;
			}
			Kit.Padding p = Kit.padding("tooltip");
			int w = Math.min(Math.min(320, maxW), f.guiWidth() - 16);
			int inner = w - p.left() - p.right() - 4;
			title = c.title().toUpperCase(Locale.ROOT) + " · FIRST BUILD";
			lines = TextUtil.wrapPlain(font, c.body(), inner).stream().limit(3).toList();
			return HudZones.Size.of(w, p.top() + 11 + lines.size() * 10 + p.bottom());
		}

		@Override
		public void draw(GuiGraphicsExtractor g, Font font, HudZones.Frame f, HudZones.Slot slot) {
			Kit.Padding p = Kit.padding("tooltip");
			Panels.sprite(g, Kit.TOOLTIP, slot.x(), slot.y(), slot.w(), slot.h());
			int x = slot.x() + p.left() + 2;
			int y = slot.y() + p.top();
			Panels.text(g, font, TextUtil.ellipsize(font, title, slot.w() - p.left() - p.right() - 4), x, y, HudInk.armed());
			y += 11;
			for (String l : lines) {
				Panels.text(g, font, l, x, y, HudInk.text());
				y += 10;
			}
		}
	}
}
