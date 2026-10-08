package dev.larattalabs.architect.client.design;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.design.CritiqueRules;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import net.fabricmc.loader.api.FabricLoader;

/**
 * (5a, decision N1) Player UI preferences in {@code <gameDir>/config/architect_mc_ui.json}: {@code critiqueByDefault} (the
 * "Critique and revise" toggle of new design forms and sets starts on; default off, {@link CritiqueRules#DEFAULT_ON}). Set
 * from the Status tab.
 */
public final class UiPrefs {
	private static Boolean critiqueByDefault;

	private UiPrefs() {
	}

	static Path file() {
		return FabricLoader.getInstance().getConfigDir().resolve("architect_mc_ui.json");
	}

	public static synchronized boolean critiqueByDefault() {
		if (critiqueByDefault == null) {
			critiqueByDefault = CritiqueRules.DEFAULT_ON;
			try {
				if (Files.exists(file())) {
					JsonObject o = JsonParser.parseString(Files.readString(file(), StandardCharsets.UTF_8)).getAsJsonObject();
					if (o.has("critiqueByDefault")) {
						critiqueByDefault = o.get("critiqueByDefault").getAsBoolean();
					}
				}
			} catch (Exception e) {
				Architect.LOGGER.warn("Could not read {}; critique stays off by default", file(), e);
			}
		}
		return critiqueByDefault;
	}

	public static synchronized void setCritiqueByDefault(boolean on) {
		critiqueByDefault = on;
		JsonObject o = new JsonObject();
		o.addProperty("critiqueByDefault", on);
		try {
			Files.createDirectories(file().getParent());
			Files.writeString(file(), new GsonBuilder().setPrettyPrinting().create().toJson(o), StandardCharsets.UTF_8);
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not write {}", file(), e);
		}
	}
}
