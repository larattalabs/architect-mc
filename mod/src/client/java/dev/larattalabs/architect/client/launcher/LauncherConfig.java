package dev.larattalabs.architect.client.launcher;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.placement.PlaceConfirm;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import net.fabricmc.loader.api.FabricLoader;
import org.jspecify.annotations.Nullable;

/**
 * {@code <gameDir>/config/architect_mc.json}: {@code autoStart} (start the helper with the game, default true),
 * {@code nodePath} (a node binary or its folder, tried first) and (SAFETY) {@code confirmBlocks} (a placement of at least this
 * many blocks asks for Enter twice; default {@value PlaceConfirm#DEFAULT_THRESHOLD}, at least 1). Written with the defaults when
 * missing. Never holds a key.
 */
public record LauncherConfig(boolean autoStart, @Nullable String nodePath, int confirmBlocks) {
	public static final LauncherConfig DEFAULT = new LauncherConfig(true, null, PlaceConfirm.DEFAULT_THRESHOLD);

	public LauncherConfig(boolean autoStart, @Nullable String nodePath) {
		this(autoStart, nodePath, PlaceConfirm.DEFAULT_THRESHOLD);
	}

	public LauncherConfig {
		confirmBlocks = PlaceConfirm.threshold(confirmBlocks);
	}

	/** This config with another {@code confirmBlocks}. */
	public LauncherConfig withConfirmBlocks(int blocks) {
		return new LauncherConfig(autoStart, nodePath, blocks);
	}

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
			int cb = PlaceConfirm.DEFAULT_THRESHOLD;
			try {
				cb = o.has("confirmBlocks") ? o.get("confirmBlocks").getAsInt() : cb;
			} catch (RuntimeException bad) {
				Architect.LOGGER.warn("{}: confirmBlocks must be a whole number; using {}", f, cb);
			}
			LauncherConfig c = new LauncherConfig(!o.has("autoStart") || o.get("autoStart").getAsBoolean(), np == null || np.isBlank() ? null : np, cb);
			if (!o.has("confirmBlocks")) {
				c.save(); // SAFETY: an older file gains the new key, so it can be found and edited
			}
			return c;
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not read {}; using the defaults", f, e);
			return DEFAULT;
		}
	}

	void save() {
		JsonObject o = new JsonObject();
		o.addProperty("autoStart", autoStart);
		o.addProperty("nodePath", nodePath == null ? "" : nodePath);
		o.addProperty("confirmBlocks", confirmBlocks);
		try {
			Files.createDirectories(file().getParent());
			Files.writeString(file(), new GsonBuilder().setPrettyPrinting().create().toJson(o), StandardCharsets.UTF_8);
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not write {}", file(), e);
		}
	}
}
