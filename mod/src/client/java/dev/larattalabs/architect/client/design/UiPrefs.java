package dev.larattalabs.architect.client.design;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.design.CritiqueRules;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import net.fabricmc.loader.api.FabricLoader;

/**
 * Player UI preferences in {@code <gameDir>/config/architect_mc_ui.json}:
 * <ul>
 * <li>(5a, decision N1) {@code critiqueByDefault}: the "Critique and revise" toggle of new design forms and sets starts on;
 * default off, {@link CritiqueRules#DEFAULT_ON}. Set from the Status tab.</li>
 * <li>(UI-2b) {@code siteHud}: the construction HUD at the top of the screen, {@code full} (the line and its progress bar, the
 * default), {@code line} (one short line) or {@code hidden}. Cycled by the Construction HUD key (J) and the Status tab.</li>
 * <li>(PR W1) {@code tips.hidden[]}: the "what's this" lines hidden with their × (by key, per install). Status: "Show tips again".</li>
 * <li>(PR F1) {@code guide {state: new|done|declined, step}}: the guided first build.</li>
 * </ul>
 */
public final class UiPrefs {
	public enum SiteHud {
		FULL,
		LINE,
		HIDDEN;

		public String id() {
			return name().toLowerCase(Locale.ROOT);
		}

		public SiteHud next() {
			return values()[(ordinal() + 1) % values().length];
		}

		static SiteHud of(String s) {
			for (SiteHud m : values()) {
				if (m.id().equalsIgnoreCase(s)) {
					return m;
				}
			}
			return FULL;
		}
	}

	private static Boolean critiqueByDefault;
	private static SiteHud siteHud;
	private static final java.util.LinkedHashSet<String> tipsHidden = new java.util.LinkedHashSet<>();
	private static String guideState = "new";
	private static int guideStep;

	private UiPrefs() {
	}

	static Path file() {
		return FabricLoader.getInstance().getConfigDir().resolve("architect_mc_ui.json");
	}

	private static synchronized void load() {
		if (critiqueByDefault != null) {
			return;
		}
		critiqueByDefault = CritiqueRules.DEFAULT_ON;
		siteHud = SiteHud.FULL;
		try {
			if (Files.exists(file())) {
				JsonObject o = JsonParser.parseString(Files.readString(file(), StandardCharsets.UTF_8)).getAsJsonObject();
				if (o.has("critiqueByDefault")) {
					critiqueByDefault = o.get("critiqueByDefault").getAsBoolean();
				}
				if (o.has("siteHud")) {
					siteHud = SiteHud.of(o.get("siteHud").getAsString());
				}
				if (o.has("tips") && o.getAsJsonObject("tips").has("hidden")) {
					o.getAsJsonObject("tips").getAsJsonArray("hidden").forEach(e -> tipsHidden.add(e.getAsString()));
				}
				if (o.has("guide")) {
					JsonObject gd = o.getAsJsonObject("guide");
					guideState = gd.has("state") ? gd.get("state").getAsString() : "new";
					guideStep = gd.has("step") ? gd.get("step").getAsInt() : 0;
				}
			}
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not read {}; the UI preferences stay at their defaults", file(), e);
		}
	}

	public static synchronized boolean critiqueByDefault() {
		load();
		return critiqueByDefault;
	}

	public static synchronized void setCritiqueByDefault(boolean on) {
		load();
		critiqueByDefault = on;
		save();
	}

	public static synchronized SiteHud siteHud() {
		load();
		return siteHud;
	}

	public static synchronized void setSiteHud(SiteHud m) {
		load();
		siteHud = m;
		save();
	}

	/** (PR W1) The "what's this" store over this file. */
	public static final dev.larattalabs.labui.client.help.WhatsThis.Store TIPS = new dev.larattalabs.labui.client.help.WhatsThis.Store() {
		@Override
		public boolean hidden(String key) {
			synchronized (UiPrefs.class) {
				load();
				return tipsHidden.contains(key);
			}
		}

		@Override
		public void hide(String key) {
			synchronized (UiPrefs.class) {
				load();
				if (tipsHidden.add(key)) {
					save();
				}
			}
		}

		@Override
		public void showAll() {
			synchronized (UiPrefs.class) {
				load();
				tipsHidden.clear();
				save();
			}
		}
	};

	public static synchronized int tipsHiddenCount() {
		load();
		return tipsHidden.size();
	}

	/** (PR F1) The guide's state: new, done or declined; and the step it was on. */
	public static synchronized String guideState() {
		load();
		return guideState;
	}

	public static synchronized int guideStep() {
		load();
		return guideStep;
	}

	public static synchronized void setGuide(String state, int step) {
		load();
		guideState = state;
		guideStep = step;
		save();
	}

	private static void save() {
		JsonObject o = new JsonObject();
		o.addProperty("critiqueByDefault", critiqueByDefault);
		o.addProperty("siteHud", siteHud.id());
		JsonObject tips = new JsonObject();
		com.google.gson.JsonArray hid = new com.google.gson.JsonArray();
		tipsHidden.forEach(hid::add);
		tips.add("hidden", hid);
		o.add("tips", tips);
		JsonObject gd = new JsonObject();
		gd.addProperty("state", guideState);
		gd.addProperty("step", guideStep);
		o.add("guide", gd);
		try {
			Files.createDirectories(file().getParent());
			Files.writeString(file(), new GsonBuilder().setPrettyPrinting().create().toJson(o), StandardCharsets.UTF_8);
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not write {}", file(), e);
		}
	}
}
