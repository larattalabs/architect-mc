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

	private static void save() {
		JsonObject o = new JsonObject();
		o.addProperty("critiqueByDefault", critiqueByDefault);
		o.addProperty("siteHud", siteHud.id());
		try {
			Files.createDirectories(file().getParent());
			Files.writeString(file(), new GsonBuilder().setPrettyPrinting().create().toJson(o), StandardCharsets.UTF_8);
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not write {}", file(), e);
		}
	}
}
