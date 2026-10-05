package dev.larattalabs.architect.client.launcher;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import net.fabricmc.loader.api.FabricLoader;
import org.jspecify.annotations.Nullable;

/**
 * {@code <gameDir>/config/architect_mc.json}: {@code autoStart} (start the helper with the game, default true) and
 * {@code nodePath} (a node binary or its folder, tried first). Written with the defaults when missing. Never holds a key.
 */
public record LauncherConfig(boolean autoStart, @Nullable String nodePath) {
	public static final LauncherConfig DEFAULT = new LauncherConfig(true, null);

	static Path file() {
		return FabricLoader.getInstance().getConfigDir().resolve("architect_mc.json");
	}

	static LauncherConfig load() {
		Path f = file();
		try {
			if (!Files.exists(f)) {
				DEFAULT.save();
				return DEFAULT;
			}
			JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			String np = o.has("nodePath") && o.get("nodePath").isJsonPrimitive() ? o.get("nodePath").getAsString() : null;
			return new LauncherConfig(!o.has("autoStart") || o.get("autoStart").getAsBoolean(), np == null || np.isBlank() ? null : np);
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not read {}; using the defaults", f, e);
			return DEFAULT;
		}
	}

	void save() {
		JsonObject o = new JsonObject();
		o.addProperty("autoStart", autoStart);
		o.addProperty("nodePath", nodePath == null ? "" : nodePath);
		try {
			Files.createDirectories(file().getParent());
			Files.writeString(file(), new GsonBuilder().setPrettyPrinting().create().toJson(o), StandardCharsets.UTF_8);
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not write {}", file(), e);
		}
	}
}
