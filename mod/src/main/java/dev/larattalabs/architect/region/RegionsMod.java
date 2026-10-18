package dev.larattalabs.architect.region;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;

/** Phase 6a wiring: the generation counters and the chunk-status cache, reset with the world. */
public final class RegionsMod {
	private RegionsMod() {
	}

	public static void init() {
		// ticket types register during mod init (before the registries freeze)
		dev.larattalabs.architect.Architect.LOGGER.debug("region tickets {} {}", RegionSurvey.TICKET, Prepare.TICKET);
		dev.larattalabs.architect.Architect.LOGGER.debug("region hash ticket {}", RegionHash.TICKET);
		dev.larattalabs.architect.Architect.LOGGER.debug("region fluids ticket {}", RegionFluids.TICKET); // 6c H
		GenCounter.init();
		RegionsImpl.init();
		RegionCommands.init(); // phase 6b: /architect region ... (N7: commands, no Terrain tab)
		BrushCommands.init(); // 6c B: /architect brush ...
		ServerLifecycleEvents.SERVER_STARTING.register(s -> {
			ChunkGen.reset();
			GenCounter.reset();
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			ChunkGen.reset();
			RegionDesigns.reset();
		});
	}
}
