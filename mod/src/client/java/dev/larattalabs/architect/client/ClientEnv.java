package dev.larattalabs.architect.client;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;

/**
 * Environment switches for the client. All are read from environment variables (or the
 * equivalent -D system property, e.g. -Darchitect.mute=0) once at startup.
 *
 * <pre>
 * ARCHITECT_DEV_PORT   DevBridge port (default 7891), 127.0.0.1 only
 * ARCHITECT_DEV_TOKEN DevBridge shared secret (default: random per start, written owner-only to
 *                       &lt;gameDir&gt;/architect/devbridge.token; every connection must present it)
 * ARCHITECT_DEV        1 enables the DevBridge, 0 disables it
 * ARCHITECT_MUTE       1 forces master+music volume to 0 at startup; 0 keeps your volume
 * ARCHITECT_FOCUS      0 = the window opens WITHOUT taking focus; 1 = normal focus
 * ARCHITECT_AUTOWORLD  1 = create/load the "Architect Dev" world on startup; 0 = title screen
 * ARCHITECT_AUTOWORLD_NAME / _PRESET / _SEED  which world AutoWorld opens (see AutoWorldSpec)
 * ARCHITECT_SHOTS_DIR  where dev.screenshot writes PNGs (default &lt;repo&gt;/artifacts/shots)
 * </pre>
 *
 * Defaults depend on how the game runs. In a development run ({@code gradlew runClient}) the
 * DevBridge, mute, no-focus and AutoWorld are on, as the dev tools expect. A built jar installed
 * in a normal launcher (Prism, the vanilla launcher) is someone's everyday game: all four default
 * off (focus on), so the mod never opens a world, silences the game or exposes the DevBridge
 * unless asked to.
 */
public final class ClientEnv {
	private ClientEnv() {
	}

	/** True in {@code gradlew runClient}; false for a jar in a normal launcher. */
	public static final boolean DEV_RUN = FabricLoader.getInstance().isDevelopmentEnvironment();

	public static final int DEV_PORT = intValue("ARCHITECT_DEV_PORT", 7891);
	public static final boolean DEV_BRIDGE = flag("ARCHITECT_DEV", DEV_RUN);
	public static final boolean MUTE = flag("ARCHITECT_MUTE", DEV_RUN);
	public static final boolean TAKE_FOCUS = flag("ARCHITECT_FOCUS", !DEV_RUN);
	public static final boolean AUTO_WORLD = flag("ARCHITECT_AUTOWORLD", DEV_RUN);

	public static String raw(String envName) {
		String prop = System.getProperty(envName.toLowerCase(Locale.ROOT).replace('_', '.'));
		if (prop != null && !prop.isBlank()) {
			return prop.trim();
		}
		String env = System.getenv(envName);
		return env == null || env.isBlank() ? null : env.trim();
	}

	public static boolean flag(String envName, boolean def) {
		String v = raw(envName);
		if (v == null) {
			return def;
		}
		return switch (v.toLowerCase(Locale.ROOT)) {
			case "1", "true", "yes", "on" -> true;
			case "0", "false", "no", "off" -> false;
			default -> def;
		};
	}

	public static int intValue(String envName, int def) {
		String v = raw(envName);
		if (v == null) {
			return def;
		}
		try {
			return Integer.parseInt(v);
		} catch (NumberFormatException e) {
			return def;
		}
	}

	/**
	 * Directory screenshots are written to. In the dev layout the game dir is
	 * &lt;repo&gt;/mod/run, so the default is &lt;repo&gt;/artifacts/shots.
	 */
	public static Path shotsDir() {
		String override = raw("ARCHITECT_SHOTS_DIR");
		if (override != null) {
			return Path.of(override).toAbsolutePath().normalize();
		}
		Path gameDir = Minecraft.getInstance().gameDirectory.toPath().toAbsolutePath().normalize();
		Path repo = gameDir.getParent() != null ? gameDir.getParent().getParent() : null;
		if (repo != null && Files.isDirectory(repo.resolve("mod")) && Files.isDirectory(repo.resolve("docs"))) {
			return repo.resolve("artifacts").resolve("shots");
		}
		return gameDir.resolve("architect-shots");
	}
}
