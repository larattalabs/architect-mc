package dev.larattalabs.architect;

import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.SiteCommands;
import dev.larattalabs.architect.site.Sites;
import net.fabricmc.api.ModInitializer;
import net.minecraft.resources.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Common (both sides) entrypoint: the design library, the placed sites of the running world and the {@code /architect}
 * command. Client features are wired in {@code dev.larattalabs.architect.client.ArchitectClient}.
 */
public class Architect implements ModInitializer {
	public static final String MOD_ID = "architect_mc";
	public static final Logger LOGGER = LoggerFactory.getLogger("architect");

	@Override
	public void onInitialize() {
		Blueprints.init();
		// survival (phase 3): the crate and the payloads are registered first; the toggle loads before the sites when a world starts
		dev.larattalabs.architect.survival.CrateBlocks.init();
		dev.larattalabs.architect.survival.SiteNet.init();
		dev.larattalabs.architect.survival.SurvivalWorld.init();
		Sites.init();
		SiteCommands.init();
		LOGGER.info("Architect common init done");
	}

	public static Identifier id(String path) {
		return Identifier.fromNamespaceAndPath(MOD_ID, path);
	}
}
