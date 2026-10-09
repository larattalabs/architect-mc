package dev.larattalabs.architect.region;

import dev.larattalabs.architect.api.Design;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/** Region designs (phase 6b, template-first): the requests the mod sent, and the plans it ran for a fit. */
public final class RegionDesigns {
	private static final Map<String, String> PLAN_OF = new ConcurrentHashMap<>();

	private RegionDesigns() {
	}

	/** The plan the mod ran for design {@code designId}'s pick, or null. */
	public static @Nullable String planIdOf(String designId) {
		return PLAN_OF.get(designId);
	}

	/** A region design changed (server thread). */
	public static void changed(MinecraftServer server, Design d) {
	}
}
